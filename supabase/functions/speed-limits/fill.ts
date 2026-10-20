// The road-layer fill (migration 0013): which 0.1° cells a request touches, who fills them, and the
// background fill itself.
//
//   * A cell is the fixed grid square of migration 0013: `cell_y = floor(lat / 0.1)`,
//     `cell_x = floor(lng / 0.1)`, about 11 km × 7.5 km at 47° N. A z15 tile (0.8 km) lies in one
//     cell, or straddles two or four at a cell edge; `cellsCovering` names them all.
//   * `ensure` is the per-request hook: for every requested tile it claims each cell the tile lies
//     in, plus every cell within `LOOKAHEAD_M` (1.5 km) of the tile's edge — the brief's "fetch the
//     next zone before the driver reaches it" — and reports, per tile, whether its own cells are
//     all loaded. A cell claimed here is filled in the background (`deps.background`, the runtime's
//     `EdgeRuntime.waitUntil`), one cell at a time per isolate so one request never opens several
//     Overpass connections at once; across isolates the app-wide budget bounds the rate.
//   * Memo: a cell known `done` is not asked about again for `DONE_MEMO_MS` in this isolate, and one
//     known `filling` not for `FILLING_MEMO_MS`, so steady-state tile requests cost no claim RPC.
//   * The fill streams the cell's ways from Overpass (overpass.ts) and upserts them in batches of
//     `UPSERT_BATCH`, so memory stays at one batch; it then marks the cell done with the count, or
//     failed on any error (budget spent, mirrors down, a partial reply) so it is retried later.
//   * Logs carry outcomes and counts only, never a cell, a tile or a coordinate (the function's
//     logging rule).
import type { SupabaseClient } from '@supabase/supabase-js';
import { asPgError } from '../_shared/pg.ts';
import type { BBox } from '../_shared/speedLimits/geometry';
import type { SpeedLogger } from './handler.ts';
import { fetchWays, type Fetch, type WayRow } from './overpass.ts';

export const CELL_DEG = 0.1;
/** A tile within this distance of its cell's edge also claims the cell(s) over that edge. */
export const LOOKAHEAD_M = 1500;
/** Ways per `osm_upsert_ways` call (the function takes up to 1000). */
export const UPSERT_BATCH = 500;
export const DONE_MEMO_MS = 10 * 60_000;
export const FILLING_MEMO_MS = 15_000;
/**
 * Overpass queries across every isolate and user: the public mirrors allow a couple of concurrent
 * slots per address, and one cell's query can run for tens of seconds.
 */
export const OVERPASS_BUDGET = { key: 'overpass_fill', window: '1 minute', max: 4 } as const;

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;
const CELL_Y = { min: -900, max: 899 } as const;
const CELL_X = { min: -1800, max: 1799 } as const;

export interface Cell {
  y: number;
  x: number;
}

export type ClaimStatus = 'claimed' | 'filling' | 'done';

/** The fill's database port: the three 0013 functions and the app-wide budget, service-role only. */
export interface OsmFillDb {
  claimFillCell(cell: Cell): Promise<ClaimStatus>;
  finishFillCell(cell: Cell, ok: boolean, wayCount: number): Promise<boolean>;
  /** Rows written. */
  upsertWays(ways: readonly WayRow[]): Promise<number>;
  takeGlobalRateLimit(key: string, window: string, max: number): Promise<boolean>;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The cell a point lies in. The epsilon absorbs `lat / 0.1` landing a hair under an integer. */
export function cellOf(lat: number, lng: number): Cell {
  return {
    y: clamp(Math.floor(lat / CELL_DEG + 1e-9), CELL_Y.min, CELL_Y.max),
    x: clamp(Math.floor(lng / CELL_DEG + 1e-9), CELL_X.min, CELL_X.max),
  };
}

export function cellBounds(c: Cell): BBox {
  return { minLat: c.y * CELL_DEG, maxLat: (c.y + 1) * CELL_DEG, minLng: c.x * CELL_DEG, maxLng: (c.x + 1) * CELL_DEG };
}

export const cellKey = (c: Cell): string => `${c.y}/${c.x}`;

/** Every cell a box overlaps, row-major from its south-west corner. */
export function cellsCovering(b: BBox): Cell[] {
  const sw = cellOf(b.minLat, b.minLng);
  const ne = cellOf(b.maxLat, b.maxLng);
  const out: Cell[] = [];
  for (let y = sw.y; y <= ne.y; y += 1) for (let x = sw.x; x <= ne.x; x += 1) out.push({ y, x });
  return out;
}

/** The box grown by `metres` on every side (longitude scaled at the box's poleward edge). */
export function expand(b: BBox, metres: number): BBox {
  const dLat = metres / M_PER_DEG;
  const lat = Math.max(Math.abs(b.minLat), Math.abs(b.maxLat));
  const dLng = metres / (M_PER_DEG * Math.max(Math.cos(Math.min(89.9, lat) * DEG), 1e-3));
  return {
    minLat: Math.max(-90, b.minLat - dLat),
    maxLat: Math.min(90, b.maxLat + dLat),
    minLng: Math.max(-180, b.minLng - dLng),
    maxLng: Math.min(180, b.maxLng + dLng),
  };
}

/** The cells within `LOOKAHEAD_M` of the box that it does not itself overlap. */
export function lookaheadCells(b: BBox): Cell[] {
  const own = new Set(cellsCovering(b).map(cellKey));
  return cellsCovering(expand(b, LOOKAHEAD_M)).filter((c) => !own.has(cellKey(c)));
}

const toStatus = (v: unknown): ClaimStatus => (v === 'claimed' || v === 'done' ? v : 'filling');

export function createOsmFillDb(client: SupabaseClient): OsmFillDb {
  return {
    async claimFillCell(cell) {
      const { data, error } = await client.rpc('osm_claim_fill_cell', { p_y: cell.y, p_x: cell.x });
      if (error) throw asPgError(error);
      return toStatus(data);
    },
    async finishFillCell(cell, ok, wayCount) {
      const { data, error } = await client.rpc('osm_finish_fill_cell', { p_y: cell.y, p_x: cell.x, p_ok: ok, p_way_count: wayCount });
      if (error) throw asPgError(error);
      return data === true;
    },
    async upsertWays(ways) {
      const { data, error } = await client.rpc('osm_upsert_ways', { p_ways: ways });
      if (error) throw asPgError(error);
      return typeof data === 'number' ? data : 0;
    },
    async takeGlobalRateLimit(key, window, max) {
      const { data, error } = await client.rpc('take_global_rate_limit', { p_key: key, p_window: window, p_max: max });
      if (error) throw asPgError(error);
      return data === true;
    },
  };
}

export interface OsmFillDeps {
  db: OsmFillDb;
  /** Runs a promise past the response (`EdgeRuntime.waitUntil`); tests collect it. */
  background: (work: Promise<void>) => void;
  log?: SpeedLogger;
  fetch?: Fetch;
  now?: () => number;
}

export interface OsmFill {
  /**
   * Per box (a requested tile, or a point's surroundings), true while any cell it overlaps is not
   * loaded: the box's data is partial and the device should ask again soon. Claims what needs
   * filling, in this order: the boxes' own cells, then the look-ahead cells; starts the fills in
   * the background. Never throws: a claim that fails reads as filling.
   */
  ensure(boxes: readonly BBox[]): Promise<boolean[]>;
  /** Resolves once every fill started so far has finished (tests and orderly shutdown). */
  settled(): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export function createOsmFill(deps: OsmFillDeps): OsmFill {
  const { db } = deps;
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  /** Cells known loaded, by the instant that knowledge expires; and cells known in progress. */
  const done = new Map<string, number>();
  const filling = new Map<string, number>();
  /** One fill at a time in this isolate. */
  let queue: Promise<void> = Promise.resolve();

  async function fill(cell: Cell): Promise<void> {
    const started = now();
    let ok = false;
    let ways = 0;
    let outcome = 'filled';
    try {
      const { key, window, max } = OVERPASS_BUDGET;
      if (!(await db.takeGlobalRateLimit(key, window, max))) {
        outcome = 'budget_spent';
      } else {
        let batch: WayRow[] = [];
        let streamError: unknown = null;
        try {
          for await (const way of fetchWays(cellBounds(cell), { fetch: deps.fetch })) {
            batch.push(way);
            if (batch.length >= UPSERT_BATCH) {
              ways += await db.upsertWays(batch);
              batch = [];
            }
          }
        } catch (err) {
          streamError = err;
        }
        // What did arrive is kept, whole reply or not: a partial cell is fetched again later.
        if (batch.length > 0) ways += await db.upsertWays(batch);
        if (streamError !== null) throw streamError;
        ok = true;
      }
    } catch (err) {
      outcome = 'failed';
      log.error('speed-limits osm fill failed', { error: errorText(err), ways });
    }
    try {
      await db.finishFillCell(cell, ok, ways);
    } catch (err) {
      log.error('speed-limits osm fill could not record its outcome', { error: errorText(err) });
    }
    const key = cellKey(cell);
    if (ok) {
      filling.delete(key);
      done.set(key, now() + DONE_MEMO_MS);
    } else {
      // The database holds the failure back for a while; no point asking again at once.
      filling.set(key, now() + FILLING_MEMO_MS);
    }
    log.info('speed-limits osm fill', { outcome, ways, ms: now() - started });
  }

  /** The cell's status, from the memo or a claim; a claimed cell's fill is queued here. */
  async function status(cell: Cell): Promise<ClaimStatus> {
    const key = cellKey(cell);
    const t = now();
    const d = done.get(key);
    if (d !== undefined && d > t) return 'done';
    const f = filling.get(key);
    if (f !== undefined && f > t) return 'filling';
    let s: ClaimStatus;
    try {
      s = await db.claimFillCell(cell);
    } catch (err) {
      log.error('speed-limits osm fill claim failed', { error: errorText(err) });
      return 'filling';
    }
    if (s === 'done') {
      done.set(key, t + DONE_MEMO_MS);
      return s;
    }
    filling.set(key, t + FILLING_MEMO_MS);
    if (s === 'claimed') {
      queue = queue.then(() => fill(cell));
      deps.background(queue);
    }
    return s;
  }

  return {
    async ensure(boxes) {
      const own = boxes.map((b) => cellsCovering(b));
      const ahead = boxes.flatMap(lookaheadCells);
      const statuses = new Map<string, ClaimStatus>();
      // Own cells first (they decide the answer and should fill first), then the look-ahead.
      for (const cell of [...own.flat(), ...ahead]) {
        const key = cellKey(cell);
        if (statuses.has(key)) continue;
        statuses.set(key, await status(cell));
      }
      return own.map((cells) => cells.some((c) => statuses.get(cellKey(c)) !== 'done'));
    },
    settled() {
      return queue;
    },
  };
}
