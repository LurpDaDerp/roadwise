// The speed-limit matcher: which road is the car on, and what is its limit (plan R5).
//
// ONE implementation, run on the device (against decoded tile segments) and in the
// `speed-limits` edge function (against `speed_limit_candidates` rows) — mirrored byte for byte by
// `scripts/sync-scoring.js` — so the two can never disagree on a match. SQL only returns
// candidates. Imports only its siblings, so it runs unchanged under Jest and Deno.
//
// Honesty rule: a posted limit is never guessed. When the road is established but carries no
// posted limit, the answer is the road class's default (`DEFAULT_LIMIT_MPH`), marked `statutory`
// so the sign can show it while nothing is scored against it (a statutory default can be wrong —
// Seattle's residential default is 20 mph against the state's 25 — so a speeding penalty on one
// would be a false positive; `limitActionable` in src/core/detectors/common.ts refuses it). When no
// road is established at all the answer is `unknown`.
//
// Precedence follows design §4.4 — open data first, then the cache, then the class default:
//   1. The road is the nearest heading-passing OSM way within 25 m. If it carries a limit, that
//      limit, `posted`.
//   2. If it is untagged, an HPMS section that joins it (within 15 m of it) supplies the limit,
//      `posted`, 0.1 less confident (R5: HPMS only fills a way that has none).
//   3. Else an AWS cache segment that joins it the same way, `cached` (the cache is only ever
//      written for a road the open data could not answer, so it fills the same gap HPMS does).
//   4. Else the untagged road's class default, `statutory`, at the road match's own confidence.
//   5. With no OSM way at all, the nearest heading-passing cache segment, `cached`.
//   6. Otherwise `unknown`.

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
    }
  | {
      /** The road's class default (`DEFAULT_LIMIT_MPH`), not a posted limit: shown, never scored. */
      limitMph: number;
      source: 'statutory';
      matchConfidence: number;
      parallelRoads: boolean;
      provider: 'osm';
      key: string;
    };

/**
 * The limit assumed for an OSM road of each class when neither OSM, HPMS nor the cache posts one
 * (mph; typical US statutory defaults). `public.get_current_speed_limit` (migration 0013) carries
 * the same table. A class not listed here has no default: a living street, a `road` (not yet
 * classified) or a service road (the tiles carry one only where it posts a limit) shows no number
 * untagged.
 */
export const DEFAULT_LIMIT_MPH: Readonly<Record<string, number>> = {
  motorway: 65,
  motorway_link: 45,
  trunk: 55,
  trunk_link: 40,
  primary: 45,
  primary_link: 35,
  secondary: 40,
  secondary_link: 30,
  tertiary: 35,
  tertiary_link: 30,
  unclassified: 30,
  residential: 25,
};

/** The class default for `highway`, or null for a class without one. */
export const defaultLimitMph = (highway: string): number | null =>
  Object.prototype.hasOwnProperty.call(DEFAULT_LIMIT_MPH, highway) ? (DEFAULT_LIMIT_MPH[highway] as number) : null;

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
  /**
   * Only the nearest this-many candidates within `RADIUS_M` are considered (nearest first, exact ties
   * by key), before the heading test. When more exist, a road left out might be the car's, so the
   * answer is marked ambiguous: `parallelRoads: true`, confidence at most `CONF_PARALLEL` (ruling B2
   * r5 I1). `speed_limit_candidates` returns 21 rows in the same order, one past this cap, so the
   * server sees the cut whenever the device does. The device and the server apply the same rule;
   * which roads fall either side of the cut can differ by the tiles' 5-decimal snap, and the
   * ambiguity mark makes that harmless.
   */
  MAX_CANDIDATES: 20,
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

/** A cut answer: another road here may be the car's, so it reads as a parallel-road situation. */
const ambiguous = (r: MatchResult): MatchResult =>
  r.source === 'unknown'
    ? { ...r, parallelRoads: true }
    : { ...r, matchConfidence: Math.min(r.matchConfidence, MATCH.CONF_PARALLEL), parallelRoads: true };

export function matchLimit(courseDeg: number | null, candidates: readonly Candidate[]): MatchResult {
  return matchWith(courseDeg, candidates, { rampCap: true, stayOn: null });
}

/**
 * The road the sign may name where `matchLimit` is too unsure to act on (DEVICE ONLY: the client
 * shows its limit and nothing is scored against it). It reads the candidates as `matchLimit` does,
 * with two differences:
 *   - a ramp is not held below the action gate for being a ramp: the parallel-road rule already
 *     catches the stretch where it runs beside its road, so a ramp alone is as certain as any road;
 *   - with `stayOn` (the road the car was last matched to) among the roads within
 *     `PARALLEL_MARGIN_M` of the nearest one, the car is taken to be still on it, and the roads
 *     beside it no longer make the match ambiguous (a motorway past its ramps, a street through a
 *     shallow fork). Its own way, or the next way of the same class and limit (OpenStreetMap splits
 *     a road into ways at many nodes), stands for it. Once the car is nearer another road by more
 *     than the margin, that road wins.
 */
export function signMatch(courseDeg: number | null, candidates: readonly Candidate[], stayOn: StayOn | null): MatchResult {
  return matchWith(courseDeg, candidates, { rampCap: false, stayOn });
}

/** The road `signMatch` keeps the car on: its key, and the class and limit its next ways share. */
export interface StayOn {
  key: string;
  highway: string;
  limitMph: number | null;
}

interface MatchOptions {
  rampCap: boolean;
  stayOn: StayOn | null;
}

/** The candidate is the road stayed on, or its next way: the same class and limit. */
const sameRoad = (c: Candidate, s: StayOn): boolean =>
  c.key === s.key || (c.highway === s.highway && validLimit(c.limitMph) === validLimit(s.limitMph));

function matchWith(courseDeg: number | null, candidates: readonly Candidate[], opts: MatchOptions): MatchResult {
  // An unknown course (null, the platforms' negative "invalid", or garbage) cannot pass a heading
  // test, so no road can be chosen.
  if (courseDeg === null || !Number.isFinite(courseDeg) || courseDeg < 0) return unknown(false);
  const course = normalizeDeg(courseDeg);

  // The nearest MAX_CANDIDATES within the radius, whatever their heading, as the server returns them
  // (a 31-road interchange is real: I-205 at Vancouver, WA). A cut marks the answer ambiguous.
  const inRadius = candidates
    .filter((c) => Number.isFinite(c.distanceM) && c.distanceM >= 0 && c.distanceM <= MATCH.RADIUS_M)
    .sort(byDistance);
  const result = matchNearest(course, inRadius.slice(0, MATCH.MAX_CANDIDATES), opts);
  return inRadius.length > MATCH.MAX_CANDIDATES ? ambiguous(result) : result;
}

/** The match over the (already capped, nearest-first) candidates, for a valid course. */
function matchNearest(course: number, nearest: readonly Candidate[], opts: MatchOptions): MatchResult {
  const passing = nearest.filter((c) => headingPasses(course, c));
  const allRoads = passing.filter((c) => c.provider === 'osm');
  const hpms = passing.filter((c) => c.provider === 'hpms' && validLimit(c.limitMph) !== null);
  const cache = passing.filter((c) => c.provider === 'aws' && validLimit(c.limitMph) !== null);

  const distanceConf = (d: number): number => (d <= NEAR_M ? MATCH.CONF_SINGLE_NEAR : MATCH.CONF_SINGLE);

  // Staying on the last road (`signMatch`): it stands for every road within the margin of the
  // nearest, which are set aside; the rest lie beyond the margin, where no road is the car's.
  const nearestRoad = allRoads[0];
  const stayOn = opts.stayOn;
  const stay =
    stayOn === null || !nearestRoad
      ? undefined
      : allRoads.find((c) => sameRoad(c, stayOn) && c.distanceM <= nearestRoad.distanceM + MATCH.PARALLEL_MARGIN_M);
  const roads = stay
    ? [stay, ...allRoads.filter((c) => c.key !== stay.key && c.distanceM > nearestRoad!.distanceM + MATCH.PARALLEL_MARGIN_M)]
    : allRoads;

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
  // A road within the margin makes the match ambiguous when the car on it could face another
  // limit: a different posted one, or, with both untagged, another class (whose default may
  // differ). The same posted limit on both leaves nothing to tell apart (a trunk and its 45 mph
  // ramp at the gore), whichever road the car is on.
  const parallel =
    stay === undefined &&
    roads.some(
      (o) =>
        o.key !== road.key &&
        o.distanceM <= road.distanceM + MATCH.PARALLEL_MARGIN_M &&
        (validLimit(o.limitMph) !== ownLimit || (ownLimit === null && o.highway !== road.highway))
    );
  const base = Math.min(
    distanceConf(road.distanceM),
    parallel ? MATCH.CONF_PARALLEL : 1,
    opts.rampCap && road.highway.endsWith('_link') ? MATCH.CONF_RAMP : 1
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
  // Nothing posts a limit for this road: its class default, at the confidence of the road match
  // itself (the road is as certain as any; only the number is assumed, which `statutory` says).
  const fallback = defaultLimitMph(road.highway);
  if (fallback !== null) {
    return { limitMph: fallback, source: 'statutory', matchConfidence: round2(base), parallelRoads: parallel, provider: 'osm', key: road.key };
  }
  return unknown(parallel);
}
