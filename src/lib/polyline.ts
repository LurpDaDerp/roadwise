// Google's encoded polyline format (5 dp, deltas, 5-bit chunks) and Douglas–Peucker in metres.
import type { LatLng } from './geo';
const M_PER_DEG_LAT = 111_320;

export function encodePolyline(points: readonly LatLng[]): string {
  const out: string[] = [];
  const push = (value: number): void => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    for (; v >= 0x20; v >>= 5) out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    out.push(String.fromCharCode(v + 63));
  };
  let lat = 0, lng = 0;
  for (const p of points) {
    const la = Math.round(p.lat * 1e5), ln = Math.round(p.lng * 1e5);
    push(la - lat); push(ln - lng);
    [lat, lng] = [la, ln];
  }
  return out.join('');
}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let i = 0, lat = 0, lng = 0;
  const next = (): number => {
    let result = 0, shift = 0, b = 0x20;
    for (; b >= 0x20; shift += 5) result |= ((b = encoded.charCodeAt(i++) - 63) & 0x1f) << shift;
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next(); lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/**
 * A route is one or more *runs* — the visible stretches left after privacy trimming — carried on
 * the wire as encoded polylines joined by a single space (0x20 is outside the polyline alphabet
 * 0x3F–0x7E). Each run decodes on its own, so nothing is ever drawn from the end of one run to the
 * start of the next: that chord would cross the hidden gap.
 */
export const RUN_SEPARATOR = ' ';

/** The encoded runs of a route string; '' gives none. Empty runs (a stray space) are skipped. */
export function splitRuns(encoded: string | null | undefined): string[] {
  if (!encoded) return [];
  return encoded.split(RUN_SEPARATOR).filter((r) => r !== '');
}

/** Runs with fewer than two points are left off (there is nothing to draw). */
export function encodeRuns(runs: readonly (readonly LatLng[])[]): string {
  return runs.filter((r) => r.length >= 2).map(encodePolyline).join(RUN_SEPARATOR);
}

/** Every run of a route string, decoded separately. */
export function decodeRuns(encoded: string | null | undefined): LatLng[][] {
  return splitRuns(encoded).map(decodePolyline);
}

/** Metres from `p` to the segment `a`–`b`, on a flat projection around `a` (plenty at ε ≈ 10 m). */
function segmentDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos((a.lat * Math.PI) / 180) * M_PER_DEG_LAT;
  const px = (p.lng - a.lng) * k, py = (p.lat - a.lat) * M_PER_DEG_LAT;
  const bx = (b.lng - a.lng) * k, by = (b.lat - a.lat) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by, t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Douglas–Peucker: keep both ends and every point more than `epsilonM` off the chord under it. */
export function simplify(points: readonly LatLng[], epsilonM: number): LatLng[] {
  if (points.length < 3) return [...points];
  const keep = points.map((_, i) => i === 0 || i === points.length - 1);
  const stack: [number, number][] = [[0, points.length - 1]];
  for (let span = stack.pop(); span; span = stack.pop()) {
    const [from, to] = span;
    let worst = 0, at = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = segmentDistanceM(points[i] as LatLng, points[from] as LatLng, points[to] as LatLng);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > epsilonM) { keep[at] = true; stack.push([from, at], [at, to]); }
  }
  return points.filter((_, i) => keep[i]);
}
