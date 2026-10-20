// The device speed-limit client: tile cache, prefetch along the route, and the once-a-second
// lookup the drive host makes (plan task S2; rev1: I6, I7, I8; R7).
//
// DEVICE ONLY. Not mirrored to the edge function (`scripts/sync-scoring.js` copies `wire`, `tiles`,
// `geometry` and `match` by explicit list; this file must never join it).
//
// The rules this file exists to keep:
//
// - **Battery (§3.5, R7).** A lookup never touches the network, with one bounded exception below.
//   The network is used by exactly two calls: `startTrip` (one batch) and `prefetch` (one batch per
//   call — the engine calls it once per `PREFETCH_EVERY_M` = 1000 m). A batch asks only for the
//   prefetch tiles that are neither in memory nor fresh in SQLite, so a commute already cached costs
//   nothing. On top of that, at most one point lookup per prefetch window, and only when the server
//   has said a fallback exists (`fallback: 'aws'`) — without the AWS key it could only ever answer
//   "unknown". Offline: no requests at all. Nothing here runs a timer.
//   The exception: a tile the server sent `filling` (its area is being loaded from OpenStreetMap
//   right now) expires `FILLING_RETRY_MS` after it arrived, and the first lookup on it after that
//   asks for that one tile again, at most `FILLING_RETRIES_MAX` times per tile per trip — so the
//   sign fills in within a minute of the first drive through a new area instead of a kilometre
//   later. A filled tile answers with its full expiry and the retries stop.
//   And the warm-up: with each batch, the tile `WARM_AHEAD_M` (3 and 6 km) ahead along the course
//   is asked for too, in its own small request, when it lies in a different fill cell than the car
//   and that cell was not warmed in the last `WARM_REPEAT_MS`. The request makes the server start
//   loading that area from OpenStreetMap minutes before the car gets there, so the tiles the
//   prefetch later asks for there come back filled. A cell already cached here costs nothing.
//   A trip that starts with no course (standing still, or from the phone's cached position before
//   the first fix) asks for the 2x2 block of tiles around the car and warms the fill cells
//   `WARM_AROUND_M` away in eight directions instead, and the first lookup with a course then makes
//   the batch along it (once, not per row) rather than waiting for the next kilometre's prefetch.
// - **Memory (rev1: I7).** At most `MEMORY_TILES` decoded tiles (`store.ts`), each decoded once
//   whether it came from the network or SQLite; recovery's `lookupStored` shares the same LRU and
//   reads each tile from SQLite once, not once per row.
// - **Honesty (§13.2, rev1: I8).** No posted limit is ever guessed or carried past its road. A row
//   without a valid fix is null; a lookup whose tile is not in memory is null (and loads it from
//   SQLite for the next row); a loaded tile with no established road is `unknown`; an established
//   road with no posted limit is its class default, `statutory` (the matcher's table), which the
//   sign shows and nothing scores. The one carry-over: stopped (valid fix, no course, under 2 m/s)
//   within 30 m of the last match. Standing with no course and nothing carried (the drive's first
//   seconds), the nearest road within 25 m is matched as if heading along it, by the matcher's own
//   rules; no road near, or none with a limit, is null. A server point answer (posted or cached) beats a default.
// - **Confidence.** `matchConfidence` is the matcher's, unaltered — with one exception: a match
//   near a tile the server truncated is capped at `TRUNCATED_CONFIDENCE_CAP` (0.6). The server cuts
//   a dense tile by road class (minor classes first), not by place, so the car's own road can be
//   the one dropped while a more important parallel road survives, and the matcher would name the
//   neighbour's limit at 0.85. The HUD, the alerts and full-weight scoring act on a limit exactly
//   when `limitActionable` holds, and any match below `MATCH_CONFIDENCE_MIN` (0.7) fails it, so
//   ramp, parallel-road and truncated-tile matches (0.6–0.65) show "—" and never alert; §9.5 may
//   still score them at reduced weight.
// - **Simulation (`persist: false`).** Nothing is written to SQLite: no tile is stored and
//   `purgeExpired` does nothing. Reading tiles already there is harmless and stays allowed.

import type { LimitSample } from '@/core/engine/types';
import type { Db } from '@/data/db/driver';
import { createTilesRepo } from '@/data/db/tiles';
import { mphToMps } from '@/lib/units';

import type { SpeedLimitApi } from './api';
import { angleDiffDeg, bboxOf, type BBox, nearBBox, nearestOnPolyline, normalizeDeg } from './geometry';
import { MATCH, matchLimit, type MatchResult } from './match';
import {
  candidatesNear,
  createTileLru,
  decodeTile,
  type DecodedTile,
  type StoredTilePayload,
  truncatedNear,
} from './store';
import { fillCellKey, prefetchSet, tileFor, tileKey } from './tiles';
import { MAX_TILE_TTL_MS, type PointResponse } from './wire';

/** Under this speed the car counts as stopped, for stickiness and for the point-lookup trigger. */
export const MIN_MOVING_MPS = 2;
/** A stopped car keeps its last match only within this distance of where it was made (I8). */
export const STICKY_RADIUS_M = 30;
/** Consecutive unknown answers, moving, on a loaded tile, before a point lookup is worth it. */
export const UNKNOWN_ROWS_BEFORE_POINT_LOOKUP = 5;
/**
 * A point answer covers the road from this far behind the point it was asked at to this far
 * ahead, in the direction of travel. The server answers AWS from a route 150 m ahead (B2).
 */
export const POINT_ANSWER_BEHIND_M = 30;
export const POINT_ANSWER_AHEAD_M = 150;
/** Point answers held in memory (a few dozen bytes each). */
export const MAX_POINT_ANSWERS = 16;
/** The most confidence a match near a truncated tile may carry — below `MATCH_CONFIDENCE_MIN`, so never actionable. */
export const TRUNCATED_CONFIDENCE_CAP = 0.6;
/**
 * A truncated tile is kept this long at most. Truncation is deterministic, so re-requesting it
 * every kilometre would re-download the same cut tile; a day lets a server-side fix arrive.
 */
export const TRUNCATED_TILE_TTL_MS = 24 * 3600 * 1000;
/** A tile the server is still filling is kept this long, then asked for again on the next lookup on it. */
export const FILLING_RETRY_MS = 25_000;
/** How many times one filling tile is asked for again in a trip before the regular prefetch takes over. */
export const FILLING_RETRIES_MAX = 6;
/** How far ahead along the course the next fill cells are warmed (see the header). */
export const WARM_AHEAD_M: readonly number[] = [3000, 6000];
/** With no course at the trip's start, the fill cells this far away in any of eight directions are warmed. */
export const WARM_AROUND_M = 3000;
/** A warmed cell is asked about again no sooner than this: a fill the server put off, or one still loading. */
export const WARM_REPEAT_MS = 60_000;

export interface SpeedLimitClient {
  /**
   * The limit for this row, from memory only — synchronous, no I/O, called once a second.
   *
   * - `null`: no limit can be stated (invalid fix, no course while moving, or the tile is not in
   *   memory yet). The engine treats it as unknown; the HUD shows "—".
   * - `{ source: 'unknown', limitMps: null, matchConfidence: 0 }`: the tile is loaded and no road
   *   with a limit was established.
   * - otherwise a known limit with the matcher's own `matchConfidence`.
   */
  lookup(
    lat: number,
    lng: number,
    course: number,
    opts: { gnssValid: boolean; speedMps: number | null }
  ): LimitSample | null;
  /** `EngineDeps.limits.prefetch` — at most one batch request per call; returns at once. */
  prefetch(lat: number, lng: number, course: number): void;
  /** Recovery / adopt: the limit from SQLite, decoded once per tile through the same LRU. */
  lookupStored(lat: number, lng: number, course: number): Promise<LimitSample | null>;
  /** The one extra batch at trip start (rev1: I6). */
  startTrip(lat: number, lng: number, course: number): void;
  /** End of trip: drop the trip's memory and counters. Work still in flight is stored, not held. */
  resetTrip(): void;
  /** Delete stale tiles from SQLite; the number deleted. Called by H2 on foreground. */
  purgeExpired(): Promise<number>;
  /**
   * `requestsThisTrip` counts every network request (batches and point lookups);
   * `pointLookupsThisTrip` the point lookups among them; `sqliteLoads` the tile reads from SQLite;
   * `truncatedTiles` how many of the tiles in memory the server truncated (for diagnostics).
   */
  stats(): {
    memoryTiles: number;
    requestsThisTrip: number;
    pointLookupsThisTrip: number;
    sqliteLoads: number;
    truncatedTiles: number;
  };
  /** Resolves once no load or request is in flight. For tests and orderly shutdown; never needed per row. */
  settled(): Promise<void>;
}

export interface SpeedLimitClientDeps {
  db: Db;
  api: SpeedLimitApi;
  now: () => number;
  /** False when the device is known to be offline: no request is made. Defaults to online. */
  online?: () => boolean;
  /** Told about a failed request, a rejected reply, or a storage error. Never thrown. */
  onError?: (e: unknown) => void;
  /**
   * False for a simulated drive: nothing is written to SQLite (no tile stored, `purgeExpired` a
   * no-op). Tiles already stored may still be read. Defaults to true.
   */
  persist?: boolean;
  /** The distances ahead to warm (default `WARM_AHEAD_M`); [] turns the warm-up off. */
  warmAheadM?: readonly number[];
}

interface PointAnswer {
  line: Float64Array;
  box: BBox;
  /** The course the answer was asked for: it applies in this direction only. */
  heading: number;
  sample: LimitSample;
}

interface TripCounters {
  requests: number;
  points: number;
  sqliteLoads: number;
}

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const x = (bLng - aLng) * Math.cos(((aLat + bLat) / 2) * DEG) * M_PER_DEG;
  const y = (bLat - aLat) * M_PER_DEG;
  return Math.hypot(x, y);
}

function offset(lat: number, lng: number, bearingDeg: number, m: number): [number, number] {
  const dLat = (m * Math.cos(bearingDeg * DEG)) / M_PER_DEG;
  const dLng = (m * Math.sin(bearingDeg * DEG)) / (Math.max(Math.cos(lat * DEG), 1e-6) * M_PER_DEG);
  return [lat + dLat, lng + dLng];
}

function toSample(r: MatchResult): LimitSample {
  return {
    limitMps: r.limitMph === null ? null : mphToMps(r.limitMph),
    source: r.source,
    matchConfidence: r.matchConfidence,
    parallelRoads: r.parallelRoads,
  };
}

const finite = (...xs: number[]): boolean => xs.every(Number.isFinite);

export function createSpeedLimitClient(deps: SpeedLimitClientDeps): SpeedLimitClient {
  const { db, api, now } = deps;
  const repo = createTilesRepo(db);
  const isOnline = (): boolean => deps.online?.() ?? true;
  const persist = deps.persist ?? true;
  const warmAheadM = deps.warmAheadM ?? WARM_AHEAD_M;
  const report = (e: unknown): void => {
    try {
      deps.onError?.(e);
    } catch {
      // A broken reporter must not break the drive.
    }
  };

  const lru = createTileLru();
  /** SQLite reads in progress, so concurrent callers share one read per tile. */
  const pending = new Map<string, Promise<DecodedTile | null>>();
  /** Tiles known to be absent (or stale, or unreadable) in SQLite this trip: not re-read per row. */
  const absent = new Set<string>();
  /** Tiles requested from the network and not yet answered. */
  const inFlight = new Set<string>();
  /** Tiles that arrived `filling`, by the instant they expire; and how often each was asked again this trip. */
  const filling = new Map<string, number>();
  const fillingRetries = new Map<string, number>();
  /** Fill cells warmed this trip, by when. */
  const warmed = new Map<string, number>();
  /** All outstanding async work, for `settled`. */
  const work = new Set<Promise<unknown>>();
  const pointAnswers: PointAnswer[] = [];

  /** Bumped by `resetTrip`; work begun under an older generation stores but does not hold. */
  let generation = 0;
  let counters: TripCounters = { requests: 0, points: 0, sqliteLoads: 0 };
  /** The server's word on point lookups, from the last batch. Survives trips: it is server config. */
  let fallback: 'aws' | null = null;
  /** One point lookup per prefetch window (R7); granted by `startTrip` and each `prefetch`. */
  let pointAllowed = false;
  let pointInFlight = false;
  let unknownRun = 0;
  let last: { lat: number; lng: number; sample: LimitSample } | null = null;
  /** The last batch was made with no course: the first row with one asks for the tiles ahead. */
  let courselessBatch = false;

  function track<T>(p: Promise<T>): Promise<T> {
    work.add(p);
    void p.finally(() => work.delete(p)).catch(() => undefined);
    return p;
  }

  /** A fresh tile from memory (counts as a use); a stale one is dropped. */
  function memoryTile(key: string): DecodedTile | undefined {
    const t = lru.get(key);
    if (t && t.expiresAt <= now()) {
      lru.delete(key);
      return undefined;
    }
    return t;
  }

  /** Every fresh tile in memory; stale ones are dropped, never matched against. */
  function freshTiles(): DecodedTile[] {
    const t = now();
    const out: DecodedTile[] = [];
    for (const tile of [...lru.values()]) {
      if (tile.expiresAt > t) out.push(tile);
      else lru.delete(tile.key);
    }
    return out;
  }

  function hold(tile: DecodedTile, gen: number): void {
    if (gen === generation) lru.set(tile);
  }

  /** Read one tile from SQLite into memory, once, sharing the read with concurrent callers. */
  function loadFromSqlite(key: string): Promise<DecodedTile | null> {
    const held = memoryTile(key);
    if (held) return Promise.resolve(held);
    const inProgress = pending.get(key);
    if (inProgress) return inProgress;
    if (absent.has(key)) return Promise.resolve(null);

    const gen = generation;
    const trip = counters;
    trip.sqliteLoads += 1;
    const p = (async () => {
      try {
        const row = await repo.getTile<unknown>(key, now());
        const tile = row ? decodeTile(key, row.expires_at, row.segments) : null;
        if (!tile) {
          if (gen === generation) absent.add(key);
          return null;
        }
        hold(tile, gen);
        return tile;
      } catch (e) {
        report(e);
        if (gen === generation) absent.add(key);
        return null;
      }
    })();
    pending.set(key, p);
    // `p` never rejects (errors are reported above), so this chain cannot either.
    void p.then(() => {
      if (pending.get(key) === p) pending.delete(key);
    });
    return track(p);
  }

  /** One batch for whichever of `keys` are neither in memory, in flight, nor fresh in SQLite. */
  async function runBatch(keys: string[], gen: number, trip: TripCounters): Promise<void> {
    const candidates = keys.filter((k) => !memoryTile(k) && !inFlight.has(k));
    if (candidates.length === 0) return;
    for (const k of candidates) inFlight.add(k);
    try {
      const need: string[] = [];
      for (const k of candidates) {
        if (gen !== generation) return;
        if (!(await loadFromSqlite(k))) need.push(k);
      }
      // Offline, the SQLite preload above still ran (the tiles ahead serve an offline drive); only
      // the request is skipped. And a trip reset meanwhile: the request would serve nobody.
      if (need.length === 0 || gen !== generation || !isOnline()) return;

      trip.requests += 1;
      const res = await api.getTiles(need);
      fallback = res.fallback;
      const t = now();
      for (const tile of res.tiles) {
        if (!need.includes(tile.tile)) continue; // not asked for: not trusted
        const expiresAt = Math.min(
          tile.expiresAt,
          t + (tile.filling ? FILLING_RETRY_MS : tile.truncated ? TRUNCATED_TILE_TTL_MS : MAX_TILE_TTL_MS)
        );
        if (tile.filling) filling.set(tile.tile, expiresAt);
        else filling.delete(tile.tile);
        const payload: StoredTilePayload = { truncated: tile.truncated, segments: tile.segments };
        if (persist) {
          try {
            await repo.putTile(tile.tile, expiresAt, payload);
          } catch (e) {
            report(e); // still usable from memory for this trip
          }
        }
        const decoded = decodeTile(tile.tile, expiresAt, payload, true);
        if (!decoded) continue;
        absent.delete(tile.tile);
        hold(decoded, gen);
      }
    } catch (e) {
      report(e);
    } finally {
      for (const k of candidates) inFlight.delete(k);
    }
  }

  function batch(lat: number, lng: number, course: number, start = false): void {
    pointAllowed = true;
    // Not gated on being online: `runBatch` preloads the tiles ahead from SQLite either way.
    if (!finite(lat, lng)) return;
    courselessBatch = !(course >= 0) || !Number.isFinite(course);
    const keys = prefetchSet(lat, lng, course).map(tileKey);
    void track(runBatch(keys, generation, counters));
    if (courselessBatch) {
      if (start) warmAround(lat, lng);
    } else warm(lat, lng, [normalizeDeg(course)], warmAheadM);
  }

  /** With no course, the fill cells within `WARM_AROUND_M` in any direction (see the header). */
  function warmAround(lat: number, lng: number): void {
    if (warmAheadM.length === 0) return;
    warm(lat, lng, [0, 45, 90, 135, 180, 225, 270, 315], [WARM_AROUND_M]);
  }

  /** The warm-up (see the header): one request for the tiles at `distances` along `bearings` that lie in other fill cells. */
  function warm(lat: number, lng: number, bearings: readonly number[], distances: readonly number[]): void {
    if (!isOnline()) return;
    const here = fillCellKey(lat, lng);
    const t = now();
    const keys: string[] = [];
    for (const [b, m] of bearings.flatMap((b) => distances.map((m) => [b, m] as const))) {
      const [wLat, wLng] = offset(lat, lng, b, m);
      if (!finite(wLat, wLng) || Math.abs(wLat) > 85 || Math.abs(wLng) > 180) continue;
      const cell = fillCellKey(wLat, wLng);
      const at = warmed.get(cell);
      if (cell === here || (at !== undefined && t - at < WARM_REPEAT_MS)) continue;
      warmed.set(cell, t);
      keys.push(tileKey(tileFor(wLat, wLng)));
    }
    if (keys.length > 0) void track(runBatch(keys, generation, counters));
  }

  /**
   * The one network call a lookup may make: the car's own tile arrived `filling` and has now
   * expired, so ask for it alone again (bounded per tile per trip). Nothing else — the prefetch
   * every kilometre re-requests every expired tile anyway.
   */
  function retryFilling(key: string): void {
    const until = filling.get(key);
    if (until === undefined || now() < until || inFlight.has(key) || !isOnline()) return;
    filling.delete(key);
    const n = (fillingRetries.get(key) ?? 0) + 1;
    if (n > FILLING_RETRIES_MAX) return;
    fillingRetries.set(key, n);
    void track(runBatch([key], generation, counters));
  }

  /** Point answers that cover this position in this direction; the nearest one's sample. */
  function pointAnswerAt(lat: number, lng: number, course: number): LimitSample | null {
    const p = { lat, lng };
    let best: { d: number; sample: LimitSample } | null = null;
    for (const a of pointAnswers) {
      if (!nearBBox(p, a.box, MATCH.RADIUS_M)) continue;
      if (angleDiffDeg(course, a.heading) > MATCH.HEADING_TOL_DEG) continue;
      const { distanceM } = nearestOnPolyline(p, a.line);
      if (distanceM <= MATCH.RADIUS_M && (!best || distanceM < best.d)) best = { d: distanceM, sample: a.sample };
    }
    return best?.sample ?? null;
  }

  function keepPointAnswer(lat: number, lng: number, heading: number, res: PointResponse): void {
    // Only an established limit is kept. `unknown` is not, and neither is `statutory`, which M3
    // never shows (R17) and which the matcher's sources could not carry honestly.
    if (res.source !== 'posted' && res.source !== 'cached') return;
    const [aLat, aLng] = offset(lat, lng, heading, -POINT_ANSWER_BEHIND_M);
    const [bLat, bLng] = offset(lat, lng, heading, POINT_ANSWER_AHEAD_M);
    const line = new Float64Array([aLat, aLng, bLat, bLng]);
    pointAnswers.push({
      line,
      box: bboxOf(line),
      heading,
      sample: {
        limitMps: mphToMps(res.limitMph),
        source: res.source,
        matchConfidence: res.matchConfidence,
        parallelRoads: res.parallelRoads,
      },
    });
    if (pointAnswers.length > MAX_POINT_ANSWERS) pointAnswers.shift();
  }

  function maybePointLookup(lat: number, lng: number, course: number): void {
    if (fallback !== 'aws' || !pointAllowed || pointInFlight || !isOnline()) return;
    pointAllowed = false;
    pointInFlight = true;
    unknownRun = 0;
    const trip = counters;
    trip.requests += 1;
    trip.points += 1;
    const heading = normalizeDeg(course);
    void track(
      (async () => {
        try {
          const res = await api.lookupPoint({ lat, lng, heading, radiusM: MATCH.RADIUS_M });
          keepPointAnswer(lat, lng, heading, res);
        } catch (e) {
          report(e);
        } finally {
          pointInFlight = false;
        }
      })()
    );
  }

  /**
   * Match against every fresh tile in memory near the point (plus `own`, when given, even if it
   * has since been evicted). A point answer covering the position is used when the match is
   * unknown, or when it is capped. `capped` is true when a truncated tile nearby held the match to
   * `TRUNCATED_CONFIDENCE_CAP` and no point answer replaced it — the point-lookup trigger counts
   * that row as unknown.
   */
  function evaluate(
    lat: number,
    lng: number,
    course: number,
    own?: DecodedTile
  ): { sample: LimitSample; capped: boolean } {
    const tiles = freshTiles();
    if (own && own.expiresAt > now() && !tiles.includes(own)) tiles.push(own);
    const p = { lat, lng };
    const result = matchLimit(course, candidatesNear(tiles, p, MATCH.RADIUS_M));
    if (result.source === 'unknown' || result.source === 'statutory') {
      // A server point answer is posted or cached: it beats no answer and beats a class default.
      if (course >= 0) {
        const fromPoint = pointAnswerAt(lat, lng, normalizeDeg(course));
        if (fromPoint) return { sample: fromPoint, capped: false };
      }
      return { sample: toSample(result), capped: false };
    }
    const sample = toSample(result);
    if (truncatedNear(tiles, p, MATCH.RADIUS_M)) {
      // The server's point answer beats a capped match: its candidate query is not truncated, so
      // it sees the road the tile may have dropped. This is what the capped row's lookup was for.
      if (course >= 0) {
        const fromPoint = pointAnswerAt(lat, lng, normalizeDeg(course));
        if (fromPoint) return { sample: fromPoint, capped: false };
      }
      return {
        sample: { ...sample, matchConfidence: Math.min(sample.matchConfidence, TRUNCATED_CONFIDENCE_CAP) },
        capped: true,
      };
    }
    return { sample, capped: false };
  }

  /**
   * A standing car with no course: the limit of the nearest road in memory, matched as if heading
   * along it (against its digitised direction for a reverse one-way). The matcher's own rules then
   * apply: a cross street fails the heading test, a close parallel road lowers the confidence.
   * Null when no road is near or none establishes a limit.
   */
  function standingSample(lat: number, lng: number): LimitSample | null {
    let road: { distanceM: number; bearingDeg: number; oneway: number } | null = null;
    for (const c of candidatesNear(freshTiles(), { lat, lng }, MATCH.RADIUS_M)) {
      if (c.provider !== 'osm' || !Number.isFinite(c.bearingDeg) || c.distanceM > MATCH.RADIUS_M) continue;
      if (road === null || c.distanceM < road.distanceM) road = c;
    }
    if (road === null) return null;
    const along = road.oneway === -1 ? road.bearingDeg + 180 : road.bearingDeg;
    const { sample } = evaluate(lat, lng, normalizeDeg(along));
    return sample.limitMps === null ? null : sample;
  }

  return {
    lookup(lat, lng, course, { gnssValid, speedMps }) {
      // No valid fix: the position is the last fix's and the course is -1. Nothing is known, and
      // the previous match must not come back when the fix does (I8: the tunnel).
      if (!gnssValid || !finite(lat, lng)) {
        last = null;
        unknownRun = 0;
        return null;
      }
      const moving = speedMps !== null && speedMps >= MIN_MOVING_MPS;

      if (!(course >= 0) || !Number.isFinite(course)) {
        unknownRun = 0;
        const stopped = speedMps !== null && speedMps < MIN_MOVING_MPS;
        if (stopped && last && metresBetween(last.lat, last.lng, lat, lng) <= STICKY_RADIUS_M) return last.sample;
        // Standing with nothing carried (a drive's first seconds): the nearest road's own limit.
        if (speedMps !== null && !stopped) return null;
        const own = tileKey(tileFor(lat, lng));
        if (memoryTile(own) === undefined) {
          void loadFromSqlite(own);
          retryFilling(own);
          return null;
        }
        const standing = standingSample(lat, lng);
        if (standing !== null) last = { lat, lng, sample: standing };
        return standing;
      }

      // The trip's last batch had no course (a start standing still): the tiles ahead now that there is one.
      if (courselessBatch) batch(lat, lng, course);

      const key = tileKey(tileFor(lat, lng));
      const loaded = memoryTile(key) !== undefined;
      if (!loaded) {
        void loadFromSqlite(key); // never charged to the network budget
        retryFilling(key); // the one exception: a filling tile that has just expired
      }
      const { sample, capped } = evaluate(lat, lng, course);

      if (!loaded) {
        // The car's own tile is not here yet. A neighbour's buffered segment may still establish
        // the road; short of that, nothing can be said — null, not a (possibly false) unknown.
        unknownRun = 0;
        if (sample.limitMps === null) return null;
        last = { lat, lng, sample };
        return sample;
      }

      last = { lat, lng, sample };
      // A default is a gap the server's point answer may fill with a posted limit, like unknown.
      if ((sample.source === 'unknown' || sample.source === 'statutory' || capped) && moving) {
        unknownRun += 1;
        if (unknownRun >= UNKNOWN_ROWS_BEFORE_POINT_LOOKUP) maybePointLookup(lat, lng, course);
      } else {
        unknownRun = 0;
      }
      return sample;
    },

    prefetch(lat, lng, course) {
      batch(lat, lng, course);
    },

    // Evaluates against the LRU as it stands when the read resumes, plus the row's own tile
    // explicitly. The own tile is therefore always matched, but its neighbours are whatever is
    // held at that moment: with more than 12 tiles' rows in flight at once, a neighbour's buffered
    // segment can have been evicted. Recovery awaits rows sequentially, which is exact; a future
    // parallel caller must keep to that, or batch rows by tile.
    async lookupStored(lat, lng, course) {
      if (!finite(lat, lng)) return null;
      const tile = await loadFromSqlite(tileKey(tileFor(lat, lng)));
      if (!tile) return null;
      return evaluate(lat, lng, course, tile).sample;
    },

    startTrip(lat, lng, course) {
      batch(lat, lng, course, true);
    },

    resetTrip() {
      generation += 1;
      counters = { requests: 0, points: 0, sqliteLoads: 0 };
      lru.clear();
      pending.clear();
      absent.clear();
      filling.clear();
      fillingRetries.clear();
      warmed.clear();
      courselessBatch = false;
      pointAllowed = false;
      unknownRun = 0;
      last = null;
    },

    purgeExpired() {
      return persist ? repo.purgeExpired(now()) : Promise.resolve(0);
    },

    // Diagnostics only: `truncatedTiles` copies the LRU. Nothing on the per-row path calls this.
    stats() {
      return {
        memoryTiles: lru.size,
        requestsThisTrip: counters.requests,
        pointLookupsThisTrip: counters.points,
        sqliteLoads: counters.sqliteLoads,
        truncatedTiles: [...lru.values()].filter((t) => t.truncated).length,
      };
    },

    async settled() {
      while (work.size > 0) await Promise.allSettled([...work]);
    },
  };
}
