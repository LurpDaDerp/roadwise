/**
 * Geometry along a route's visible runs (each a list of points in travel order): distance along a
 * run, the point at a distance, a stretch between two distances, where a point falls on the route,
 * and the direction of travel at a distance. Shared by the summary map's event marks
 * (`src/features/drives/route.ts`) and problem spots (`src/core/spots/detect.ts`). Pure.
 */
import { bearingDeg, type LatLng } from '@/lib/geo';

// Local bindings: these loops run hundreds of thousands of times per spots recompute, and a
// global `Math` lookup per call is slow in some engines (Jest's VM context most of all).
const { asin, atan2, cos, max, min, PI, sin, sqrt } = Math;
const toRad = (d: number) => (d * PI) / 180;
/** The mean Earth radius `haversineMeters` uses (`@/lib/geo`), in metres. */
const R = 6371008.8;
/** Metres per degree of latitude on that sphere. */
const M_PER_DEG = (PI / 180) * R;

/** `haversineMeters` step for step, with the math bound locally: the same result, faster. */
function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = sin(dLat / 2) ** 2 + cos(toRad(a.lat)) * cos(toRad(b.lat)) * sin(dLng / 2) ** 2;
  return 2 * R * asin(sqrt(s));
}

/** The direction of travel is read over this much road before a point. */
export const HEADING_BASE_M = 30;
/** Less road than this before a point: the heading is read over the road after it instead. */
export const HEADING_MIN_M = 10;
/** A turn's exit direction is read over this much road after a point. */
export const EXIT_BASE_M = 40;
/** Less road than this after a point: no exit direction. */
export const EXIT_MIN_M = 15;

/** Cumulative distance along a run, metres, one entry per point. */
export function cumulative(points: readonly LatLng[]): number[] {
  const c: number[] = [0];
  for (let i = 1; i < points.length; i++) c.push(c[i - 1]! + haversine(points[i - 1]!, points[i]!));
  return c;
}

/** The point `d` metres along a run (clamped to the run). */
export function pointAt(points: readonly LatLng[], cum: readonly number[], d: number): LatLng {
  if (points.length === 1) return points[0]!;
  // The first point past `d` (or the last segment): a binary search over the non-decreasing `cum`.
  let lo = 1;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const a = points[i - 1]!;
  const b = points[i]!;
  const seg = cum[i]! - cum[i - 1]!;
  const t = seg > 0 ? min(1, max(0, (d - cum[i - 1]!) / seg)) : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** The part of a run from `d0` to `d1` metres along it: the two cut points and every point between. */
export function slice(points: readonly LatLng[], cum: readonly number[], d0: number, d1: number): LatLng[] {
  const out = [pointAt(points, cum, d0)];
  points.forEach((p, i) => {
    if (cum[i]! > d0 && cum[i]! < d1) out.push(p);
  });
  out.push(pointAt(points, cum, d1));
  return out;
}

/** Where a point falls on a route: the run, how far along it, and how far off it (metres). */
export interface Projection {
  run: number;
  d: number;
  distM: number;
}

/**
 * Where `p` falls on the route: the run and how far along it, from the nearest point on any
 * segment, and its distance from that point in a flat local frame (plenty at road scale). An empty
 * route gives run 0, 0 m along, infinitely far off.
 */
export function project(runs: readonly (readonly LatLng[])[], cums: readonly (readonly number[])[], p: LatLng): Projection {
  const k = cos(toRad(p.lat));
  let best = { run: 0, d: 0 };
  let bestD = Infinity;
  runs.forEach((points, r) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const bx = (b.lng - a.lng) * k;
      const by = b.lat - a.lat;
      const px = (p.lng - a.lng) * k;
      const py = p.lat - a.lat;
      const len2 = bx * bx + by * by;
      const t = len2 > 0 ? min(1, max(0, (px * bx + py * by) / len2)) : 0;
      const dist = (px - t * bx) ** 2 + (py - t * by) ** 2;
      if (dist < bestD) {
        bestD = dist;
        best = { run: r, d: cums[r]![i - 1]! + t * (cums[r]![i]! - cums[r]![i - 1]!) };
      }
    }
  });
  return { ...best, distM: sqrt(bestD) * M_PER_DEG };
}

/**
 * The direction of travel `d` metres along a run, degrees clockwise from true north: the bearing
 * over the 30 m of road before it, or over the 30 m after it when less than 10 m lie before (the
 * whole run when that is short too). Null on a run under 10 m.
 */
export function headingAt(points: readonly LatLng[], cum: readonly number[], d: number): number | null {
  const total = cum[cum.length - 1] ?? 0;
  if (points.length < 2 || !(total >= HEADING_MIN_M)) return null;
  const at = min(total, max(0, d));
  if (at >= HEADING_MIN_M) return bearingDeg(pointAt(points, cum, max(0, at - HEADING_BASE_M)), pointAt(points, cum, at));
  const end = min(total, at + HEADING_BASE_M);
  if (end - at >= HEADING_MIN_M) return bearingDeg(pointAt(points, cum, at), pointAt(points, cum, end));
  return bearingDeg(points[0]!, points[points.length - 1]!);
}

/**
 * The direction a turn leaves in, `d` metres along a run: the bearing over the 40 m after it (to
 * the end of the run when nearer). Null when under 15 m of road follow.
 */
export function exitAt(points: readonly LatLng[], cum: readonly number[], d: number): number | null {
  const total = cum[cum.length - 1] ?? 0;
  if (points.length < 2) return null;
  const at = min(total, max(0, d));
  const end = min(total, at + EXIT_BASE_M);
  if (end - at < EXIT_MIN_M) return null;
  return bearingDeg(pointAt(points, cum, at), pointAt(points, cum, end));
}

/** The mean of some directions, degrees in [0, 360): 350° and 10° average to 0°, not 180°. Empty gives 0. */
export function circularMeanDeg(degs: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const deg of degs) {
    s += sin(toRad(deg));
    c += cos(toRad(deg));
  }
  if (s === 0 && c === 0) return 0;
  return ((atan2(s, c) * 180) / PI + 360) % 360;
}
