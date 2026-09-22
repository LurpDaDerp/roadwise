// Polyline decoding and point-to-line geometry for the speed-limit matcher.
//
// Shared with the `speed-limits` edge function (mirrored to `supabase/functions/_shared/` by
// `scripts/sync-scoring.js`), so this file must stay dependency-free: no `@/` alias, no React
// Native, no Node built-ins — it runs unchanged under Jest and Deno.
//
// Lines are flat `Float64Array`s `[lat0, lng0, lat1, lng1, …]` rather than arrays of objects: a
// tile holds up to 2000 segments and the device keeps a dozen tiles decoded (rev1: I7).

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Metres per degree of latitude (and of longitude at the equator), mean-Earth sphere. */
const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

/**
 * Decodes a Google encoded polyline at precision 5 — what `ST_AsEncodedPolyline(geom, 5)` emits.
 * Throws on malformed input (a character outside the alphabet, a value cut off mid-chunk, an
 * odd number of values, a coordinate off the globe, or no points at all): a line that cannot be
 * decoded must never turn into a silently wrong road.
 */
export function decodeLine(encoded: string): Float64Array {
  const values: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (i >= encoded.length) throw new Error('decodeLine: value cut off mid-chunk');
      chunk = encoded.charCodeAt(i++) - 63;
      if (chunk < 0 || chunk > 63) throw new Error('decodeLine: character outside the polyline alphabet');
      if (shift > 30) throw new Error('decodeLine: value too long');
      result += (chunk & 0x1f) * 2 ** shift;
      shift += 5;
    } while (chunk >= 0x20);
    values.push(result % 2 === 1 ? -(result + 1) / 2 : result / 2);
  }
  if (values.length === 0) throw new Error('decodeLine: no points');
  if (values.length % 2 !== 0) throw new Error('decodeLine: odd number of values');

  const out = new Float64Array(values.length);
  let lat = 0;
  let lng = 0;
  for (let k = 0; k < values.length; k += 2) {
    lat += values[k] as number;
    lng += values[k + 1] as number;
    const la = lat / 1e5;
    const ln = lng / 1e5;
    if (la < -90 || la > 90 || ln < -180 || ln > 180) throw new Error('decodeLine: coordinate off the globe');
    out[k] = la;
    out[k + 1] = ln;
  }
  return out;
}

/**
 * The distance from `p` to the nearest point of `line`, and the bearing (degrees clockwise from
 * north, 0..<360) of the segment holding that point, **in the direction the line is digitised**.
 * The matcher compares that bearing with the car's course (and its reverse unless one-way).
 *
 * Uses a flat projection centred on `p` — sub-centimetre error at the 25 m matching radius.
 * `bearingDeg` is `NaN` when the line has no extent (one point, or every vertex rounded onto the
 * same spot, which a short clipped piece can do at 5 dp): a line with no direction cannot pass a
 * heading test, and the matcher drops non-finite bearings rather than guessing one.
 * Throws on an empty line.
 */
export function nearestOnPolyline(p: LatLng, line: Float64Array): { distanceM: number; bearingDeg: number } {
  const n = line.length >> 1;
  if (n === 0) throw new Error('nearestOnPolyline: empty line');
  const kx = Math.cos(p.lat * DEG) * M_PER_DEG;
  const x = (k: number): number => ((line[2 * k + 1] as number) - p.lng) * kx;
  const y = (k: number): number => ((line[2 * k] as number) - p.lat) * M_PER_DEG;

  if (n === 1) return { distanceM: Math.hypot(x(0), y(0)), bearingDeg: NaN };

  let best = Infinity;
  let bearingDeg = NaN;
  let pointOnly = Infinity; // nearest vertex, for a line whose segments all have zero length
  for (let k = 0; k < n - 1; k += 1) {
    const ax = x(k);
    const ay = y(k);
    const dx = x(k + 1) - ax;
    const dy = y(k + 1) - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      pointOnly = Math.min(pointOnly, Math.hypot(ax, ay));
      continue;
    }
    // The origin is `p`; project it onto a→b and clamp to the segment.
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bearingDeg = normalizeDeg(Math.atan2(dx, dy) / DEG);
    }
  }
  if (best === Infinity) return { distanceM: pointOnly, bearingDeg: NaN };
  return { distanceM: best, bearingDeg };
}

export function bboxOf(line: Float64Array): BBox {
  if (line.length < 2) throw new Error('bboxOf: empty line');
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (let k = 0; k < line.length; k += 2) {
    const la = line[k] as number;
    const ln = line[k + 1] as number;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln;
    if (ln > maxLng) maxLng = ln;
  }
  return { minLat, minLng, maxLat, maxLng };
}

/** True when `p` lies inside `b` grown by `marginM` metres on every side — the lookup prefilter. */
export function nearBBox(p: LatLng, b: BBox, marginM: number): boolean {
  const dLat = marginM / M_PER_DEG;
  const dLng = marginM / (Math.max(Math.cos(p.lat * DEG), 1e-6) * M_PER_DEG);
  return (
    p.lat >= b.minLat - dLat && p.lat <= b.maxLat + dLat && p.lng >= b.minLng - dLng && p.lng <= b.maxLng + dLng
  );
}

/** Any angle to 0..<360. */
export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  const r = d < 0 ? d + 360 : d;
  // A tiny negative remainder plus 360 rounds to exactly 360 in floating point; -0 becomes 0.
  return r >= 360 || r === 0 ? 0 : r;
}

/** The smallest absolute difference between two angles, 0..180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return d > 180 ? 360 - d : d;
}
