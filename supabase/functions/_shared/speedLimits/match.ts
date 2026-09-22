// The speed-limit matcher: which road is the car on, and what is its limit (plan R5).
//
// ONE implementation, run on the device (against decoded tile segments) and in the
// `speed-limits` edge function (against `speed_limit_candidates` rows) — mirrored byte for byte by
// `scripts/sync-scoring.js` — so the two can never disagree on a match. SQL only returns
// candidates. Imports only its siblings, so it runs unchanged under Jest and Deno.
//
// Honesty rule: when a limit cannot be established the answer is `unknown`, never a guess.
// `statutory` is never produced (R17: a statutory default can be wrong — Seattle's residential
// default is 20 mph against the state's 25 — and a confident wrong limit is worse than "—").
//
// Precedence follows design §4.4 — open data first, then the cache:
//   1. The road is the nearest heading-passing OSM way within 25 m. If it carries a limit, that
//      limit, `posted`.
//   2. If it is untagged, an HPMS section that joins it (within 15 m of it) supplies the limit,
//      `posted`, 0.1 less confident (R5: HPMS only fills a way that has none).
//   3. Else an AWS cache segment that joins it the same way, `cached` (the cache is only ever
//      written for a road the open data could not answer, so it fills the same gap HPMS does).
//   4. With no OSM way at all, the nearest heading-passing cache segment, `cached`.
//   5. Otherwise `unknown`.

import { angleDiffDeg, normalizeDeg } from './geometry';
import type { Provider } from './wire';

export interface Candidate {
  provider: Provider;
  /** Unique per segment (`osm:<id>`, `hpms:<id>`, `aws:<key>`); ties on distance break on it. */
  key: string;
  limitMph: number | null;
  highway: string;
  /** 1: travel along the digitised direction only; -1: against it only; 0: both. */
  oneway: -1 | 0 | 1;
  /** Metres from the car to the nearest point of the segment. */
  distanceM: number;
  /** Bearing of the segment at that point, in its digitised direction (0..<360; NaN = none). */
  bearingDeg: number;
}

/**
 * The matcher's answer. A union on `source`, so an unknown answer with a limit (or a known one
 * without) is a compile-time error, not only a runtime one. `matchConfidence` is 0 when unknown.
 */
export type MatchResult =
  | {
      limitMph: null;
      source: 'unknown';
      matchConfidence: 0;
      parallelRoads: boolean;
      provider: null;
      key: null;
    }
  | {
      limitMph: number;
      source: 'posted';
      matchConfidence: number;
      parallelRoads: boolean;
      provider: 'osm' | 'hpms';
      key: string;
    }
  | {
      limitMph: number;
      source: 'cached';
      matchConfidence: number;
      parallelRoads: boolean;
      provider: 'aws';
      key: string;
    };

export const MATCH = {
  RADIUS_M: 25,
  HEADING_TOL_DEG: 45,
  PARALLEL_MARGIN_M: 10,
  HPMS_JOIN_M: 15,
  CONF_SINGLE_NEAR: 0.95,
  CONF_SINGLE: 0.85,
  CONF_PARALLEL: 0.6,
  CONF_RAMP: 0.65,
  CONF_HPMS_PENALTY: 0.1,
  CONF_AWS: 0.7,
} as const;

/** Distance at or under which a lone road earns `CONF_SINGLE_NEAR`. */
const NEAR_M = 10;

/** A limit the contract allows (whole mph, 5..85); anything else counts as no limit. */
const validLimit = (v: number | null): number | null =>
  v !== null && Number.isInteger(v) && v >= 5 && v <= 85 ? v : null;

function headingPasses(course: number, c: Candidate): boolean {
  if (!Number.isFinite(c.bearingDeg)) return false;
  const along = angleDiffDeg(course, c.bearingDeg) <= MATCH.HEADING_TOL_DEG;
  const against = angleDiffDeg(course, c.bearingDeg + 180) <= MATCH.HEADING_TOL_DEG;
  return c.oneway === 1 ? along : c.oneway === -1 ? against : along || against;
}

/** Nearest first; an exact tie breaks on key so the answer never depends on input order. */
const byDistance = (a: Candidate, b: Candidate): number =>
  a.distanceM - b.distanceM || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const round2 = (x: number): number => Math.min(1, Math.max(0, Math.round(x * 100) / 100));

const unknown = (parallelRoads: boolean): MatchResult => ({
  limitMph: null,
  source: 'unknown',
  matchConfidence: 0,
  parallelRoads,
  provider: null,
  key: null,
});

const known = (c: Candidate, limitMph: number, confidence: number, parallelRoads: boolean): MatchResult => {
  const common = { limitMph, matchConfidence: round2(confidence), parallelRoads, key: c.key };
  // The AWS cache is `cached`; open data is `posted` (`sourceOf`, spelled out so the union narrows).
  return c.provider === 'aws'
    ? { ...common, source: 'cached', provider: 'aws' }
    : { ...common, source: 'posted', provider: c.provider };
};

/**
 * The fill-in (HPMS section or cache segment) that joins `road`: within `HPMS_JOIN_M` of the
 * road's distance, and nearer in distance to `road` than to any other passing OSM way — so an
 * untagged lane never borrows the limit of the arterial beside it. `'conflict'` when joining
 * fill-ins disagree on the limit.
 */
function joinFill(
  road: Candidate,
  fills: readonly Candidate[],
  roads: readonly Candidate[]
): { fill: Candidate; limitMph: number } | 'conflict' | null {
  const gap = (a: Candidate, b: Candidate): number => Math.abs(a.distanceM - b.distanceM);
  const joining = fills
    .filter((f) => gap(f, road) <= MATCH.HPMS_JOIN_M && roads.every((o) => gap(f, o) >= gap(f, road)))
    .sort((a, b) => gap(a, road) - gap(b, road) || byDistance(a, b));
  const first = joining[0];
  if (!first) return null;
  const limitMph = validLimit(first.limitMph) as number;
  if (joining.some((f) => validLimit(f.limitMph) !== limitMph)) return 'conflict';
  return { fill: first, limitMph };
}

export function matchLimit(courseDeg: number | null, candidates: readonly Candidate[]): MatchResult {
  // An unknown course (null, the platforms' negative "invalid", or garbage) cannot pass a heading
  // test, so no road can be chosen.
  if (courseDeg === null || !Number.isFinite(courseDeg) || courseDeg < 0) return unknown(false);
  const course = normalizeDeg(courseDeg);

  const passing = candidates
    .filter(
      (c) => Number.isFinite(c.distanceM) && c.distanceM >= 0 && c.distanceM <= MATCH.RADIUS_M && headingPasses(course, c)
    )
    .sort(byDistance);
  const roads = passing.filter((c) => c.provider === 'osm');
  const hpms = passing.filter((c) => c.provider === 'hpms' && validLimit(c.limitMph) !== null);
  const cache = passing.filter((c) => c.provider === 'aws' && validLimit(c.limitMph) !== null);

  const distanceConf = (d: number): number => (d <= NEAR_M ? MATCH.CONF_SINGLE_NEAR : MATCH.CONF_SINGLE);

  const road = roads[0];
  if (!road) {
    // No open-data road here: a cache segment is the only road we know of.
    const seg = cache[0];
    if (!seg) return unknown(false);
    const limitMph = validLimit(seg.limitMph) as number;
    const parallel = cache.some(
      (o) => o.key !== seg.key && o.distanceM <= seg.distanceM + MATCH.PARALLEL_MARGIN_M && validLimit(o.limitMph) !== limitMph
    );
    const conf = Math.min(distanceConf(seg.distanceM), parallel ? MATCH.CONF_PARALLEL : 1, MATCH.CONF_AWS);
    return known(seg, limitMph, conf, parallel);
  }

  const ownLimit = validLimit(road.limitMph);
  const parallel = roads.some(
    (o) =>
      o.key !== road.key &&
      o.distanceM <= road.distanceM + MATCH.PARALLEL_MARGIN_M &&
      (validLimit(o.limitMph) !== ownLimit || o.highway !== road.highway)
  );
  const base = Math.min(
    distanceConf(road.distanceM),
    parallel ? MATCH.CONF_PARALLEL : 1,
    road.highway.endsWith('_link') ? MATCH.CONF_RAMP : 1
  );

  if (ownLimit !== null) return known(road, ownLimit, base, parallel);

  const fromHpms = joinFill(road, hpms, roads);
  if (fromHpms && fromHpms !== 'conflict') {
    return known(fromHpms.fill, fromHpms.limitMph, base - MATCH.CONF_HPMS_PENALTY, parallel);
  }
  const fromCache = joinFill(road, cache, roads);
  if (fromCache && fromCache !== 'conflict') {
    return known(fromCache.fill, fromCache.limitMph, Math.min(base, MATCH.CONF_AWS), parallel);
  }
  return unknown(parallel);
}
