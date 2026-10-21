// The road-layer fill (migration 0013): which 0.1° cells a request touches, who fills them, and the
// background fill itself.
//
//   * A cell is the fixed grid square of migration 0013: `cell_y = floor(lat / 0.1)`,
//     `cell_x = floor(lng / 0.1)`, about 11 km × 7.5 km at 47° N. A z15 tile (0.8 km) lies in one
//     cell, or straddles two or four at a cell edge; `cellsCovering` names them all.
//   * `ensure` is the per-request hook: for every requested tile it claims each cell the tile lies
//     in, plus the adjacent cells within `LOOKAHEAD_M` (1.5 km) of the tile's edge — the brief's
//     "fetch the next zone before the driver reaches it" — and reports, per tile, whether its own
//     cells are all loaded. A cell claimed here is filled in the background (`deps.background`,
//     the runtime's `EdgeRuntime.waitUntil`), one cell at a time per isolate so one request never
//     opens several Overpass connections at once; across isolates the app-wide budget bounds the
//     rate.
//   * What one request can start is bounded (security review): only cells the request's own
//     tiles or point touch, or their immediate neighbours, ever get claimed; at most
//     `MAX_CLAIMS_PER_REQUEST` claims per request and `MAX_LOOKAHEAD_CELLS` look-ahead cells; a box
//     beyond `MAX_LAT` (Web Mercator's edge, where longitude maths explodes) is refused outright;
//     and each cell a user's request wins the claim for is charged to that user's own budget
//     (`CLAIM_BUDGET`, `take_rate_limit`) before any Overpass work — spent, the claim is released
//     at once, so no one user can drain the shared Overpass budget for everyone.
//   * Memo: a cell known `done` is not asked about again for `DONE_MEMO_MS` in this isolate, and one
//     known `filling` not for `FILLING_MEMO_MS`, so steady-state tile requests cost no claim RPC.
//   * The fill streams the cell's ways from Overpass (overpass.ts) and upserts them in batches of
//     `UPSERT_BATCH`, so memory stays at one batch; it then marks the cell done with the count,
//     failed on any error (mirrors down, a partial or oversized reply) so it is retried later, or
//     released when the app-wide budget was spent before anything was tried, so a busy minute
//     never leaves a cell marked failed.
//   * Logs carry outcomes and counts only, never a cell, a tile, a coordinate or a user (the
//     function's logging rule).
import type { SupabaseClient } from '@supabase/supabase-js';
import { asPgError } from '../_shared/pg.ts';
import type { BBox } from '../_shared/speedLimits/geometry';
import { FILL_CELL_DEG } from '../_shared/speedLimits/tiles';
import type { SpeedLogger } from './handler.ts';
import { fetchWays, OVERPASS_DE, OverpassHeldBack, type Fetch, type MirrorGate, type WayRow } from './overpass.ts';

export const CELL_DEG = FILL_CELL_DEG;
/** A tile within this distance of its cell's edge also claims the cell(s) over that edge. */
export const LOOKAHEAD_M = 1500;
/** Ways per `osm_upsert_ways` call (the function takes up to 1000). */
export const UPSERT_BATCH = 500;
export const DONE_MEMO_MS = 10 * 60_000;
export const FILLING_MEMO_MS = 15_000;
/** Web Mercator's edge: no tile exists beyond it, and no fill is attempted there. */
export const MAX_LAT = 85.05112878;
/** Claims one request may make (its own cells first), and look-ahead cells it may name. */
export const MAX_CLAIMS_PER_REQUEST = 6;
export const MAX_LOOKAHEAD_CELLS = 8;
/**
 * Overpass queries across every isolate and user: the public mirrors allow a couple of concurrent
 * slots per address, and one cell's query can run for tens of seconds.
 */
export const OVERPASS_BUDGET = { key: 'overpass_fill', window: '1 minute', max: 4 } as const;
/**
 * Cells one user may cause to be fetched per hour. A car at highway speed crosses a new 10 km cell
 * every six minutes or so; with the edge look-ahead beside it and the device warming the cells 3
 * and 6 km ahead (a straight line, so sometimes off the route), 40 covers an honest drive through
 * unloaded country and still leaves the shared budget to everyone else.
 */
export const CLAIM_BUDGET = { key: 'overpass_claim', window: '1 hour', max: 40 } as const;
/**
 * overpass-api.de's usage policy (wiki.openstreetmap.org/wiki/Overpass_API) asks an app in regular
 * use for about 1/100 of its 10,000 queries and 1 GB a day, and no two queries at once. As the last
 * fallback it gets at most 100 queries and 10 MiB a day app-wide, and one start per 2 minutes
 * (longer than the 100 s abort, so never two at once).
 */
export const OVERPASS_DE_QUERIES = { key: 'overpass_de_queries', window: '1 day', max: 100 } as const;
export const OVERPASS_DE_MIB = { key: 'overpass_de_mib', window: '1 day', max: 10 } as const;
export const OVERPASS_DE_START = { key: 'overpass_de_start', window: '2 minutes', max: 1 } as const;
/** A mirror that refused (429, 406, 504, …) is not asked again from this isolate for this long (policy: 30 s or more). */
export const REFUSED_COOLDOWN_MS = 60_000;
/**
 * The road layer this code loads (migration 0021): a cell filled by an older one is filled again
 * the next time a driver needs it, so a change to the classes or to how a limit is read reaches
 * every loaded area, not only new ones. Raised with `TILE_DATA_VERSION` on the device, which then
 * fetches its stored tiles again. 2: living streets, `road`s and service roads with a limit;
 * limits per direction; implicit (zone) limits.
 */
export const FILL_VERSION = 2;

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;
const CELL_Y = { min: -900, max: 899 } as const;
const CELL_X = { min: -1800, max: 1799 } as const;

export interface Cell {
  y: number;
  x: number;
}

export type ClaimStatus = 'claimed' | 'filling' | 'done';
export type FillOutcome = 'done' | 'failed' | 'released';

/** The fill's database port: the three fill functions (0013, versioned in 0021) and the two budgets, service-role only. */
export interface OsmFillDb {
  claimFillCell(cell: Cell): Promise<ClaimStatus>;
  finishFillCell(cell: Cell, outcome: FillOutcome, wayCount: number): Promise<boolean>;
  /** Rows written. */
  upsertWays(ways: readonly WayRow[]): Promise<number>;
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
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

/**
 * The box grown by `metres` on every side. Longitude is scaled at the box's poleward edge, held
 * to `MAX_LAT`: past it the scale would run away, and no fill happens there anyway.
 */
export function expand(b: BBox, metres: number): BBox {
  const dLat = metres / M_PER_DEG;
  const lat = Math.min(MAX_LAT, Math.max(Math.abs(b.minLat), Math.abs(b.maxLat)));
  const dLng = metres / (M_PER_DEG * Math.cos(lat * DEG));
  return {
    minLat: Math.max(-90, b.minLat - dLat),
    maxLat: Math.min(90, b.maxLat + dLat),
    minLng: Math.max(-180, b.minLng - dLng),
    maxLng: Math.min(180, b.maxLng + dLng),
  };
}

/** True when `c` is one of the eight cells around some cell of `own` (never one of `own`). */
const adjacent = (c: Cell, own: readonly Cell[]): boolean =>
  own.some((o) => Math.abs(o.y - c.y) <= 1 && Math.abs(o.x - c.x) <= 1) && !own.some((o) => o.y === c.y && o.x === c.x);

/**
 * The cells within `LOOKAHEAD_M` of the box that it does not itself overlap: only the box's
 * immediate neighbours, at most `MAX_LOOKAHEAD_CELLS`.
 */
export function lookaheadCells(b: BBox): Cell[] {
  const own = cellsCovering(b);
  return cellsCovering(expand(b, LOOKAHEAD_M))
    .filter((c) => adjacent(c, own))
    .slice(0, MAX_LOOKAHEAD_CELLS);
}

/** A box the fill will work on: on the globe and inside Web Mercator's latitude range. */
export const fillable = (b: BBox): boolean =>
  [b.minLat, b.maxLat, b.minLng, b.maxLng].every(Number.isFinite) &&
  b.minLat <= b.maxLat &&
  b.minLng <= b.maxLng &&
  b.minLat >= -MAX_LAT &&
  b.maxLat <= MAX_LAT &&
  b.minLng >= -180 &&
  b.maxLng <= 180;

const toStatus = (v: unknown): ClaimStatus => (v === 'claimed' || v === 'done' ? v : 'filling');

export function createOsmFillDb(client: SupabaseClient): OsmFillDb {
  return {
    async claimFillCell(cell) {
      const { data, error } = await client.rpc('osm_claim_fill_cell', { p_y: cell.y, p_x: cell.x, p_version: FILL_VERSION });
      if (error) throw asPgError(error);
      return toStatus(data);
    },
    async finishFillCell(cell, outcome, wayCount) {
      const { data, error } = await client.rpc('osm_finish_fill_cell', {
        p_y: cell.y,
        p_x: cell.x,
        p_outcome: outcome,
        p_way_count: wayCount,
        p_version: FILL_VERSION,
      });
      if (error) throw asPgError(error);
      return data === true;
    },
    async upsertWays(ways) {
      const { data, error } = await client.rpc('osm_upsert_ways', { p_ways: ways });
      if (error) throw asPgError(error);
      return typeof data === 'number' ? data : 0;
    },
    async takeRateLimit(userId, key, window, max) {
      const { data, error } = await client.rpc('take_rate_limit', { p_user: userId, p_key: key, p_window: window, p_max: max });
      if (error) throw asPgError(error);
      return data === true;
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
  /** The operator's contact for the User-Agent (`OVERPASS_CONTACT`), as private.coffee's terms ask. */
  contact?: string | null;
  /** The mirrors in the order tried (`overpassEndpoints`); the public ones alone by default. */
  endpoints?: readonly string[];
}

export interface OsmFill {
  /**
   * Per box (a requested tile, or a point's surroundings), true while any cell it overlaps is not
   * loaded: the box's data is partial and the device should ask again soon. Claims what needs
   * filling, in this order: the boxes' own cells, then their adjacent look-ahead cells, at most
   * `MAX_CLAIMS_PER_REQUEST` claims, each won claim charged to `userId`'s budget; starts the fills
   * in the background. A box the fill will not work on reads false. Never throws: a claim that
   * fails reads as filling.
   */
  ensure(boxes: readonly BBox[], userId: string): Promise<boolean[]>;
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
  /** Mirrors that refused, by when they may be asked again. */
  const cooling = new Map<string, number>();

  const take = (b: { key: string; window: string; max: number }): Promise<boolean> =>
    db.takeGlobalRateLimit(b.key, b.window, b.max).catch((err: unknown) => {
      log.error('speed-limits osm fill budget check failed', { error: errorText(err) });
      return false;
    });

  /** The mirrors' usage policies (overpass.ts): the main instance's daily budgets, a cool-off for any mirror after a refusal. */
  const gate: MirrorGate = {
    async allow(url) {
      const until = cooling.get(url);
      if (until !== undefined && until > now()) return false;
      if (url !== OVERPASS_DE) return true;
      return (await take(OVERPASS_DE_START)) && (await take(OVERPASS_DE_QUERIES));
    },
    megabyte(url) {
      return url === OVERPASS_DE ? take(OVERPASS_DE_MIB) : Promise.resolve(true);
    },
    refused(url) {
      cooling.set(url, now() + REFUSED_COOLDOWN_MS);
    },
  };

  async function finish(cell: Cell, outcome: FillOutcome, ways: number): Promise<void> {
    try {
      await db.finishFillCell(cell, outcome, ways);
    } catch (err) {
      log.error('speed-limits osm fill could not record its outcome', { error: errorText(err) });
    }
    const key = cellKey(cell);
    if (outcome === 'done') {
      filling.delete(key);
      done.set(key, now() + DONE_MEMO_MS);
    } else {
      // Failed: the database holds the cell back for a while. Released: claimable again, but not
      // worth asking about from this isolate at once.
      filling.set(key, now() + FILLING_MEMO_MS);
    }
  }

  async function fill(cell: Cell): Promise<void> {
    const started = now();
    let outcome: FillOutcome = 'failed';
    let ways = 0;
    try {
      const { key, window, max } = OVERPASS_BUDGET;
      if (!(await db.takeGlobalRateLimit(key, window, max))) {
        outcome = 'released';
      } else {
        let batch: WayRow[] = [];
        let streamError: unknown = null;
        try {
          for await (const way of fetchWays(cellBounds(cell), { fetch: deps.fetch, gate, contact: deps.contact, endpoints: deps.endpoints })) {
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
        outcome = 'done';
      }
    } catch (err) {
      // Every mirror held back by its policy before anything arrived: nothing went wrong with the
      // cell, so it is released (claimable again) rather than failed.
      if (err instanceof OverpassHeldBack && ways === 0) outcome = 'released';
      else log.error('speed-limits osm fill failed', { error: errorText(err), ways });
    }
    await finish(cell, outcome, ways);
    log.info('speed-limits osm fill', { outcome: outcome === 'done' ? 'filled' : outcome === 'released' ? 'budget_spent' : 'failed', ways, ms: now() - started });
  }

  /** The cell's status, from the memo or a claim; a claim this user may afford queues the fill. */
  async function status(cell: Cell, userId: string): Promise<ClaimStatus> {
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
    if (s !== 'claimed') return s;
    // The claim is this user's to pay for: refused, it goes straight back.
    let afford = false;
    try {
      const { key: bk, window, max } = CLAIM_BUDGET;
      afford = await db.takeRateLimit(userId, bk, window, max);
    } catch (err) {
      log.error('speed-limits osm fill budget check failed', { error: errorText(err) });
    }
    if (!afford) {
      await finish(cell, 'released', 0);
      return 'filling';
    }
    queue = queue.then(() => fill(cell));
    deps.background(queue);
    return s;
  }

  return {
    async ensure(boxes, userId) {
      const own = boxes.map((b) => (fillable(b) ? cellsCovering(b) : []));
      const ahead = boxes.filter(fillable).flatMap(lookaheadCells);
      const statuses = new Map<string, ClaimStatus>();
      let claims = 0;
      // Own cells first (they decide the answer and should fill first), then the look-ahead; a
      // request names at most MAX_CLAIMS_PER_REQUEST cells.
      for (const cell of [...own.flat(), ...ahead]) {
        const key = cellKey(cell);
        if (statuses.has(key)) continue;
        if (claims >= MAX_CLAIMS_PER_REQUEST) break;
        claims += 1;
        statuses.set(key, await status(cell, userId));
      }
      return own.map((cells) => cells.some((c) => statuses.get(cellKey(c)) !== 'done'));
    },
    settled() {
      return queue;
    },
  };
}
