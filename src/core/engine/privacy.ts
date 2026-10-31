// Privacy trimming on the device (plan §1 decision 6, §5): the first and last 0.25 mi of every
// route and everything inside a privacy zone never leave the phone — not in the polyline, not as
// an event's coordinates.
//
// The cuts are jittered per drive (security audit, Important 2): a fixed 402 m trim would put the
// visible start of every route on a circle of known radius around home, and a zone cut exactly at
// its radius would do the same — a few routes fit the circle. Each drive trims its ends by
// 402 + U(0, 400) m and cuts each zone at radius × U(1.0, 1.5), from a generator seeded by the
// device's trim seed for the drive (`HMAC-SHA256(deviceSecret, clientTripId)`,
// `src/data/devices/deviceSecret.ts`): the same drive on the same phone always trims the same way,
// and nobody who sees the upload can recompute the cuts. The plan is never uploaded or logged. The
// route never draws across a hidden gap: every visible run is encoded on its own and the wire
// carries them space-joined (`encodeRuns` in `src/lib/polyline.ts`), so the server sees the whole
// visible distance (its miles-vs-route check) and the maps draw each run apart.
import { TRIM_ENDS_M } from '@scoring';

import { MAX_POLYLINE_RUNS } from '@/data/sync/payload';
import { haversineMeters, type LatLng } from '@/lib/geo';
import { encodePolyline, simplify } from '@/lib/polyline';

import type { TrackPoint } from './engine.types';

export interface PrivacyZone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

/** Settings key the privacy zones live under (WP9 edits them; this reads them). */
export const PRIVACY_ZONES_KEY = 'privacy.zones';
export const MAX_ZONES = 6;
export const ZONE_RADIUS_M = { min: 200, max: 800 } as const;

/** The first and last 0.25 mi of every route are trimmed at least (`TRIM_ENDS_M`, 402 m, from the scoring package)… */
export { TRIM_ENDS_M };
/** …plus up to this much more, per drive. */
export const TRIM_JITTER_M = 400;
/** A zone is cut at its radius × a factor in [1, ZONE_JITTER_MAX), per drive. */
export const ZONE_JITTER_MAX = 1.5;
/** Douglas–Peucker tolerance for the stored polyline; doubled until the polyline fits the cap. */
export const POLYLINE_EPSILON_M = 10;
/**
 * A visible run shorter than this along the track is left off: a zone edge or an end trim could
 * otherwise leave a two-point stub whose position pins the cut.
 */
export const MIN_RUN_M = 50;
/** Douglas–Peucker runs per chunk of this many points. */
export const SIMPLIFY_CHUNK = 1000;

/** The stored zones, read leniently: anything malformed is dropped rather than trusted. */
export function parseZones(raw: unknown): PrivacyZone[] {
  if (!Array.isArray(raw)) return [];
  const out: PrivacyZone[] = [];
  for (const z of raw) {
    if (typeof z !== 'object' || z === null) continue;
    const r = z as Record<string, unknown>;
    const lat = r.lat;
    const lng = r.lng;
    const radiusM = r.radiusM;
    if (typeof lat !== 'number' || typeof lng !== 'number' || typeof radiusM !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusM)) continue;
    out.push({
      id: typeof r.id === 'string' ? r.id : String(out.length),
      name: typeof r.name === 'string' ? r.name.slice(0, 20) : 'Zone',
      lat,
      lng,
      radiusM: Math.min(ZONE_RADIUS_M.max, Math.max(ZONE_RADIUS_M.min, radiusM)),
    });
    if (out.length >= MAX_ZONES) break;
  }
  return out;
}

/** The zone containing `p` (at its own radius), or null. */
export function zoneAt(p: LatLng, zones: readonly PrivacyZone[]): PrivacyZone | null {
  for (const z of zones) if (haversineMeters(p, z) <= z.radiusM) return z;
  return null;
}

/** A small deterministic generator (mulberry32) seeded from a string; U(0,1) per call. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The per-drive cuts: how far each end is trimmed and how wide each zone is hidden. */
export interface TrimPlan {
  startM: number;
  endM: number;
  /** Parallel to the zones given. */
  zoneRadiiM: number[];
}

export function trimPlan(seed: string, zones: readonly PrivacyZone[]): TrimPlan {
  if (seed.length < 32) throw new Error('privacy trim needs the device trim seed');
  const rnd = seededRandom(seed);
  return {
    startM: TRIM_ENDS_M + rnd() * TRIM_JITTER_M,
    endM: TRIM_ENDS_M + rnd() * TRIM_JITTER_M,
    zoneRadiiM: zones.map((z) => z.radiusM * (1 + rnd() * (ZONE_JITTER_MAX - 1))),
  };
}

/**
 * Which track points may be shown under `plan`: beyond the trims along the route from both ends
 * and outside every (widened) zone. Parallel to `track`.
 */
export function keptPoints(track: readonly TrackPoint[], zones: readonly PrivacyZone[], plan: TrimPlan = { startM: TRIM_ENDS_M, endM: TRIM_ENDS_M, zoneRadiiM: zones.map((z) => z.radiusM) }): boolean[] {
  const cum: number[] = new Array<number>(track.length);
  let total = 0;
  for (let i = 0; i < track.length; i += 1) {
    if (i > 0) total += haversineMeters(track[i - 1] as TrackPoint, track[i] as TrackPoint);
    cum[i] = total;
  }
  const hidden = (p: TrackPoint): boolean => zones.some((z, i) => haversineMeters(p, z) <= (plan.zoneRadiiM[i] ?? z.radiusM));
  return track.map((p, i) => {
    const d = cum[i] as number;
    return d >= plan.startM && total - d >= plan.endM && !hidden(p);
  });
}

/** Every contiguous run of kept indices, as `[from, to)`, in route order; none when nothing is kept. */
export function keptRuns(kept: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= kept.length; i += 1) {
    const on = i < kept.length && kept[i] === true;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

/** Metres along `points`. */
export function pathLengthM(points: readonly LatLng[]): number {
  let m = 0;
  for (let i = 1; i < points.length; i += 1) m += haversineMeters(points[i - 1] as LatLng, points[i] as LatLng);
  return m;
}

/**
 * The runs that go on the wire: at least two points and `MIN_RUN_M` long, and no more than
 * `maxRuns` of them (the shortest go first). Returns the surviving indices into `runs`, in order.
 */
export function selectRuns(runs: readonly (readonly LatLng[])[], maxRuns: number): number[] {
  const long = runs.map((r, i) => ({ i, m: pathLengthM(r) })).filter(({ i, m }) => (runs[i] as readonly LatLng[]).length >= 2 && m >= MIN_RUN_M);
  long.sort((a, b) => b.m - a.m || a.i - b.i);
  return long
    .slice(0, Math.max(0, maxRuns))
    .map(({ i }) => i)
    .sort((a, b) => a - b);
}

/** Douglas–Peucker over chunks sharing their boundary points, so a long track stays cheap. */
export function simplifyTrack(points: readonly LatLng[], epsilonM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let start = 0; start < points.length; start += SIMPLIFY_CHUNK - 1) {
    const chunk = simplify(points.slice(start, start + SIMPLIFY_CHUNK), epsilonM);
    out.push(...(start === 0 ? chunk : chunk.slice(1)));
    if (start + SIMPLIFY_CHUNK >= points.length) break;
  }
  return out;
}

/**
 * Simplify every run at `epsilonM`, doubling the tolerance until the space-joined encoding fits in
 * `maxBytes`; once every run is down to its two ends, the shortest runs are dropped instead.
 * Returns the encoded runs, parallel to `runs` ('' for a dropped one).
 */
export function fitRuns(runs: readonly (readonly LatLng[])[], epsilonM: number, maxBytes: number): string[] {
  let live = runs.map((r) => r.length >= 2);
  const encodedAt = (eps: number): string[] => runs.map((r, i) => (live[i] ? encodePolyline(simplifyTrack(r, eps)) : ''));
  const fits = (enc: string[]): boolean => enc.filter((e) => e !== '').join(' ').length <= maxBytes;
  for (let eps = epsilonM; eps <= 1e8; eps *= 2) {
    const enc = encodedAt(eps);
    if (fits(enc)) return enc;
  }
  // Every run is two points now; shed the shortest until what is left fits.
  const byLength = runs.map((r, i) => ({ i, m: pathLengthM(r) })).sort((a, b) => a.m - b.m || a.i - b.i);
  for (const { i } of byLength) {
    live = live.map((on, k) => (k === i ? false : on));
    const enc = encodedAt(2e8);
    if (fits(enc)) return enc;
  }
  return runs.map(() => '');
}

/** Index of the last track point at or before `ts`, else the first; -1 on an empty track. */
export function trackIndexAt(track: readonly TrackPoint[], ts: number): number {
  let lo = 0;
  let hi = track.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((track[mid] as TrackPoint).ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0) return found;
  return track.length > 0 ? 0 : -1;
}

export interface TrimmedRoute {
  /**
   * The encoded, simplified visible runs in route order, each a polyline of its own; none when
   * nothing is left. The wire carries them space-joined (`encodeRuns`/`RUN_SEPARATOR`).
   */
  runs: string[];
  /** Where an event at `ts` happened, or null inside a hidden region, on a dropped run, or without a fix. */
  locate(ts: number): LatLng | null;
  plan: TrimPlan;
}

export const roundCoord5 = (v: number): number => Math.round(v * 1e5) / 1e5;

/**
 * Trim `track` for upload. `seed` is the device's trim seed for this drive (`deviceTrimSeed`): it
 * fixes the jitter, so the same drive always trims the same way on the phone that recorded it.
 * Every visible run goes on the wire separately (never a chord across a hidden gap); runs under
 * `MIN_RUN_M`, beyond `maxRuns` or past `maxBytes` are dropped, shortest first, and an event on a
 * dropped run is unlocated like one inside a zone.
 */
export function trimRoute(track: readonly TrackPoint[], zones: readonly PrivacyZone[], maxBytes: number, seed: string, maxRuns: number = MAX_POLYLINE_RUNS): TrimmedRoute {
  const plan = trimPlan(seed, zones);
  const kept = keptPoints(track, zones, plan);
  const spans = keptRuns(kept);
  const points = spans.map(([from, to]) => track.slice(from, to).map((p) => ({ lat: p.lat, lng: p.lng })));
  const chosen = selectRuns(points, maxRuns);
  const encoded = fitRuns(
    chosen.map((i) => points[i] as LatLng[]),
    POLYLINE_EPSILON_M,
    maxBytes
  );
  const shown = new Array<boolean>(track.length).fill(false);
  chosen.forEach((runIndex, k) => {
    if (encoded[k] === '') return;
    const [from, to] = spans[runIndex] as [number, number];
    for (let i = from; i < to; i += 1) shown[i] = true;
  });
  return {
    runs: encoded.filter((e) => e !== ''),
    locate(ts) {
      const i = trackIndexAt(track, ts);
      if (i < 0 || shown[i] !== true) return null;
      const p = track[i] as TrackPoint;
      return { lat: roundCoord5(p.lat), lng: roundCoord5(p.lng) };
    },
    plan,
  };
}
