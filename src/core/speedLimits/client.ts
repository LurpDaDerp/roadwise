// The device speed-limit client: tile cache, prefetch along the route, and the once-a-second
// lookup the drive host makes (plan task S2; rev1: I6, I7, I8; R7).
//
// DEVICE ONLY. Not mirrored to the edge function (`scripts/sync-scoring.js` copies `wire`, `tiles`,
// `geometry` and `match` by explicit list; this file must never join it).
//
// The rules this file exists to keep:
//
// - **Battery (§3.5, R7).** A lookup never touches the network. The network is used by exactly
//   two calls: `startTrip` (one batch) and `prefetch` (one batch per call — the engine calls it once
//   per `PREFETCH_EVERY_M` = 1000 m). A batch asks only for the prefetch tiles that are neither in
//   memory nor fresh in SQLite, so a commute already cached costs nothing. On top of that, at most
//   one point lookup per prefetch window, and only when the server has said a fallback exists
//   (`fallback: 'aws'`) — without the AWS key it could only ever answer "unknown". Offline: no
//   requests at all. Nothing here runs a timer.
// - **Memory (rev1: I7).** At most `MEMORY_TILES` decoded tiles (`store.ts`), each decoded once
//   whether it came from the network or SQLite; recovery's `lookupStored` shares the same LRU and
//   reads each tile from SQLite once, not once per row.
// - **Honesty (§13.2, rev1: I8).** No limit is ever guessed or carried past its road. A row
//   without a valid fix is null; a lookup whose tile is not in memory is null (and loads it from
//   SQLite for the next row); a loaded tile with no established road is `unknown`. The one
//   carry-over: stopped (valid fix, no course, under 2 m/s) within 30 m of the last match.
// - **Confidence.** `matchConfidence` is the matcher's, unaltered. The HUD shows a limit only at
//   ≥ 0.8; ramp and parallel-road matches come back at 0.6–0.65 and show "—".

import type { LimitSample } from '@/core/engine/types';
import type { Db } from '@/data/db/driver';
import { createTilesRepo } from '@/data/db/tiles';
import { mphToMps } from '@/lib/units';

import type { SpeedLimitApi } from './api';
import { angleDiffDeg, bboxOf, type BBox, nearBBox, nearestOnPolyline, normalizeDeg } from './geometry';
import { MATCH, matchLimit, type MatchResult } from './match';
import { candidatesNear, createTileLru, decodeTile, type DecodedTile } from './store';
import { prefetchSet, tileFor, tileKey } from './tiles';
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
   * `pointLookupsThisTrip` the point lookups among them; `sqliteLoads` the tile reads from SQLite.
   */
  stats(): { memoryTiles: number; requestsThisTrip: number; pointLookupsThisTrip: number; sqliteLoads: number };
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
      // A trip reset while SQLite was checked: the request would serve nobody.
      if (need.length === 0 || gen !== generation || !isOnline()) return;

      trip.requests += 1;
      const res = await api.getTiles(need);
      fallback = res.fallback;
      const t = now();
      for (const tile of res.tiles) {
        if (!need.includes(tile.tile)) continue; // not asked for: not trusted
        const expiresAt = Math.min(tile.expiresAt, t + MAX_TILE_TTL_MS);
        try {
          await repo.putTile(tile.tile, expiresAt, tile.segments);
        } catch (e) {
          report(e); // still usable from memory for this trip
        }
        const decoded = decodeTile(tile.tile, expiresAt, tile.segments, true);
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

  function batch(lat: number, lng: number, course: number): void {
    pointAllowed = true;
    if (!finite(lat, lng) || !isOnline()) return;
    const keys = prefetchSet(lat, lng, course).map(tileKey);
    void track(runBatch(keys, generation, counters));
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

  /** Match against every tile in memory near the point, then any point answer. */
  function evaluate(lat: number, lng: number, course: number): LimitSample {
    const result = matchLimit(course, candidatesNear(freshTiles(), { lat, lng }, MATCH.RADIUS_M));
    if (result.source === 'unknown' && course >= 0) {
      const fromPoint = pointAnswerAt(lat, lng, normalizeDeg(course));
      if (fromPoint) return fromPoint;
    }
    return toSample(result);
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
        return null;
      }

      const key = tileKey(tileFor(lat, lng));
      const loaded = memoryTile(key) !== undefined;
      if (!loaded) void loadFromSqlite(key); // never charged to the network budget
      const sample = evaluate(lat, lng, course);

      if (!loaded) {
        // The car's own tile is not here yet. A neighbour's buffered segment may still establish
        // the road; short of that, nothing can be said — null, not a (possibly false) unknown.
        unknownRun = 0;
        if (sample.limitMps === null) return null;
        last = { lat, lng, sample };
        return sample;
      }

      last = { lat, lng, sample };
      if (sample.source === 'unknown' && moving) {
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

    async lookupStored(lat, lng, course) {
      if (!finite(lat, lng)) return null;
      const tile = await loadFromSqlite(tileKey(tileFor(lat, lng)));
      if (!tile) return null;
      return evaluate(lat, lng, course);
    },

    startTrip(lat, lng, course) {
      batch(lat, lng, course);
    },

    resetTrip() {
      generation += 1;
      counters = { requests: 0, points: 0, sqliteLoads: 0 };
      lru.clear();
      pending.clear();
      absent.clear();
      pointAllowed = false;
      unknownRun = 0;
      last = null;
    },

    purgeExpired() {
      return repo.purgeExpired(now());
    },

    stats() {
      return {
        memoryTiles: lru.size,
        requestsThisTrip: counters.requests,
        pointLookupsThisTrip: counters.points,
        sqliteLoads: counters.sqliteLoads,
      };
    },

    async settled() {
      while (work.size > 0) await Promise.allSettled([...work]);
    },
  };
}
