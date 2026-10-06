// Privacy trimming on the device (plan §1 decision 6, §5): the first and last 0.25 mi of every
// route and everything inside a privacy zone never leave the phone — not in the polyline, not as
// an event's coordinates.
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

/** The first and last 0.25 mi of every route are trimmed (0.25 mi = 402 m, the merge radius). */
export const TRIM_ENDS_M = MERGE_DIST_M;
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

/** The zone containing `p`, or null. */
export function zoneAt(p: LatLng, zones: readonly PrivacyZone[]): PrivacyZone | null {
  for (const z of zones) if (haversineMeters(p, z) <= z.radiusM) return z;
  return null;
}

/**
 * Which track points may be shown: beyond `TRIM_ENDS_M` along the route from both ends and
 * outside every zone. Parallel to `track`.
 */
export function keptPoints(track: readonly TrackPoint[], zones: readonly PrivacyZone[]): boolean[] {
  const cum: number[] = new Array<number>(track.length);
  let total = 0;
  for (let i = 0; i < track.length; i += 1) {
    if (i > 0) total += haversineMeters(track[i - 1] as TrackPoint, track[i] as TrackPoint);
    cum[i] = total;
  }
  return track.map((p, i) => {
    const d = cum[i] as number;
    return d >= TRIM_ENDS_M && total - d >= TRIM_ENDS_M && zoneAt(p, zones) === null;
  });
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
  /** The encoded, simplified, trimmed polyline; '' when nothing is left. */
  polyline: string;
  /** Where an event at `ts` happened, or null inside a zone / the trimmed ends / without a fix. */
  locate(ts: number): LatLng | null;
}

export const roundCoord5 = (v: number): number => Math.round(v * 1e5) / 1e5;

export function trimRoute(track: readonly TrackPoint[], zones: readonly PrivacyZone[], maxBytes: number): TrimmedRoute {
  const kept = keptPoints(track, zones);
  const shown = track.filter((_, i) => kept[i] === true).map((p) => ({ lat: p.lat, lng: p.lng }));
  return {
    polyline: fitPolyline(shown, POLYLINE_EPSILON_M, maxBytes),
    locate(ts) {
      const i = trackIndexAt(track, ts);
      if (i < 0 || kept[i] !== true) return null;
      const p = track[i] as TrackPoint;
      return { lat: roundCoord5(p.lat), lng: roundCoord5(p.lng) };
    },
  };
}
