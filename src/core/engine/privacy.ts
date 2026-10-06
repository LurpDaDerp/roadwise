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
// polyline never draws across a hidden gap: only the longest visible run is encoded (the wire
// carries one polyline).
import { MERGE_DIST_M } from '@scoring';

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
export const MAX_ZONES = 3;
export const ZONE_RADIUS_M = { min: 200, max: 800 } as const;

/** The first and last 0.25 mi of every route are trimmed at least (0.25 mi = 402 m, the merge radius)… */
export const TRIM_ENDS_M = MERGE_DIST_M;
/** …plus up to this much more, per drive. */
export const TRIM_JITTER_M = 400;
/** A zone is cut at its radius × a factor in [1, ZONE_JITTER_MAX), per drive. */
export const ZONE_JITTER_MAX = 1.5;
/** Douglas–Peucker tolerance for the stored polyline; doubled until the polyline fits the cap. */
export const POLYLINE_EPSILON_M = 10;
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

/** The longest contiguous run of kept indices, as `[from, to)`; `[0, 0)` when nothing is kept. */
export function longestRun(kept: readonly boolean[]): [number, number] {
  let best: [number, number] = [0, 0];
  let start = -1;
  for (let i = 0; i <= kept.length; i += 1) {
    const on = i < kept.length && kept[i] === true;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = -1;
    }
  }
  return best;
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

/** Simplify at `epsilonM`, doubling the tolerance until the encoding fits in `maxBytes`. */
export function fitPolyline(points: readonly LatLng[], epsilonM: number, maxBytes: number): string {
  if (points.length < 2) return '';
  for (let eps = epsilonM; ; eps *= 2) {
    const encoded = encodePolyline(simplifyTrack(points, eps));
    if (encoded.length <= maxBytes) return encoded;
    if (eps > 1e8) return '';
  }
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
  /** The encoded, simplified polyline of the longest visible run; '' when nothing is left. */
  polyline: string;
  /** Where an event at `ts` happened, or null inside a hidden region / without a fix. */
  locate(ts: number): LatLng | null;
  plan: TrimPlan;
}

export const roundCoord5 = (v: number): number => Math.round(v * 1e5) / 1e5;

/**
 * Trim `track` for upload. `seed` is the device's trim seed for this drive (`deviceTrimSeed`): it
 * fixes the jitter, so the same drive always trims the same way on the phone that recorded it.
 */
export function trimRoute(track: readonly TrackPoint[], zones: readonly PrivacyZone[], maxBytes: number, seed: string): TrimmedRoute {
  const plan = trimPlan(seed, zones);
  const kept = keptPoints(track, zones, plan);
  const [from, to] = longestRun(kept);
  const shown = track.slice(from, to).map((p) => ({ lat: p.lat, lng: p.lng }));
  return {
    polyline: fitPolyline(shown, POLYLINE_EPSILON_M, maxBytes),
    locate(ts) {
      const i = trackIndexAt(track, ts);
      if (i < 0 || kept[i] !== true) return null;
      const p = track[i] as TrackPoint;
      return { lat: roundCoord5(p.lat), lng: roundCoord5(p.lng) };
    },
    plan,
  };
}
