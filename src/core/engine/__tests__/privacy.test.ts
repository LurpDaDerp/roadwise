import type { TrackPoint } from '@/core/engine/engine.types';
import { labelFor } from '@/core/engine/labels';
import { keptPoints, longestRun, parseZones, seededRandom, trimPlan, trimRoute, TRIM_ENDS_M, TRIM_JITTER_M, ZONE_JITTER_MAX, zoneAt } from '@/core/engine/privacy';
import { haversineMeters, type LatLng } from '@/lib/geo';
import { decodePolyline } from '@/lib/polyline';

const T0 = 1_700_000_000_000;
const HOME = { lat: 47.6062, lng: -122.3321 };
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180);
const SEED = 'a'.repeat(64);

/** `n` points 10 m apart from `from` along `bearingDeg`, one per second. */
const track = (n: number, bearingDeg = 90, from: LatLng = HOME): TrackPoint[] => {
  const b = (bearingDeg * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => ({
    lat: from.lat + (i * 10 * Math.cos(b)) / M_PER_DEG_LAT,
    lng: from.lng + (i * 10 * Math.sin(b)) / M_PER_DEG_LNG,
    ts: T0 + i * 1000,
    hAcc: 5,
  }));
};

test('parseZones keeps at most 3 well-formed zones, clamping the radius and clipping the name', () => {
  const zones = parseZones([
    { id: 'a', name: 'Home', lat: 47.6, lng: -122.3, radiusM: 100 },
    { id: 'b', name: 'A very long zone name indeed', lat: 47.7, lng: -122.3, radiusM: 5000 },
    { lat: 'x' },
    { id: 'c', name: 'School', lat: 47.8, lng: -122.3, radiusM: 300 },
    { id: 'd', name: 'Fourth', lat: 47.9, lng: -122.3, radiusM: 300 },
  ]);
  expect(zones.map((z) => z.radiusM)).toEqual([200, 800, 300]);
  expect(zones[1]!.name).toHaveLength(20);
  expect(parseZones(null)).toEqual([]);
});

test('the trim plan is seeded: ends 402 + U(0,400) m, zones radius × U(1,1.5); the same seed gives the same plan, another seed another; no seed throws', () => {
  const zones = [{ id: 'h', name: 'Home', ...HOME, radiusM: 300 }];
  const a = trimPlan(SEED, zones);
  const b = trimPlan(SEED, zones);
  const c = trimPlan('b'.repeat(64), zones);
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
  for (const p of [a, c]) {
    expect(p.startM).toBeGreaterThanOrEqual(TRIM_ENDS_M);
    expect(p.startM).toBeLessThan(TRIM_ENDS_M + TRIM_JITTER_M);
    expect(p.endM).toBeGreaterThanOrEqual(TRIM_ENDS_M);
    expect(p.zoneRadiiM[0]).toBeGreaterThanOrEqual(300);
    expect(p.zoneRadiiM[0]).toBeLessThan(300 * ZONE_JITTER_MAX);
  }
  expect(() => trimPlan('', zones)).toThrow(/trim seed/);
  expect(() => trimPlan('short', zones)).toThrow(/trim seed/);
  const rnd = seededRandom('x');
  const values = [rnd(), rnd(), rnd()];
  expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  expect(new Set(values).size).toBe(3);
});

test('the ends are trimmed along the route by the plan; the middle is kept; a short route disappears', () => {
  const t = track(200); // 1990 m
  const plan = trimPlan(SEED, []);
  const kept = keptPoints(t, [], plan);
  const firstKept = kept.indexOf(true);
  const lastKept = kept.lastIndexOf(true);
  expect(firstKept * 10).toBeGreaterThanOrEqual(plan.startM);
  expect((firstKept - 1) * 10).toBeLessThan(plan.startM);
  expect(1990 - lastKept * 10).toBeGreaterThanOrEqual(plan.endM);
  expect(kept.slice(firstKept, lastKept + 1).every(Boolean)).toBe(true);
  expect(keptPoints(track(80), [], plan).some(Boolean)).toBe(false);
  expect(longestRun([false, true, true, false, true, true, true, false])).toEqual([4, 7]);
  expect(longestRun([false])).toEqual([0, 0]);
});

test('a route through a zone is never drawn across it: only the longest visible run is encoded, events inside are unlocated', () => {
  const t = track(400); // ~4 km east, the zone at 1.5 km
  const zone = { id: 'z', name: 'School', lat: t[150]!.lat, lng: t[150]!.lng, radiusM: 200 };
  const route = trimRoute(t, [zone], 16_384, SEED);
  const points = decodePolyline(route.polyline);
  expect(points.length).toBeGreaterThanOrEqual(2);
  // Every encoded point is on one side of the zone (the longer, eastern run), none inside it.
  for (const p of points) expect(haversineMeters(p, zone)).toBeGreaterThan(route.plan.zoneRadiiM[0]!);
  const lngs = points.map((p) => p.lng);
  expect(Math.min(...lngs)).toBeGreaterThan(zone.lng);
  // The event at the zone centre, and one inside the jittered radius just outside the zone proper, have no coordinates.
  expect(route.locate(T0 + 150_000)).toBeNull();
  const edge = Math.floor(route.plan.zoneRadiiM[0]! / 10) - 1;
  expect(route.locate(T0 + (150 + edge) * 1000)).toBeNull();
  expect(route.locate(T0 + 300_000)).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
  expect(route.locate(T0 + 10_000)).toBeNull(); // the trimmed start
  // Deterministic: the same seed gives the same polyline; another seed, another cut.
  expect(trimRoute(t, [zone], 16_384, SEED).polyline).toBe(route.polyline);
  expect(trimRoute(t, [zone], 16_384, 'c'.repeat(64)).polyline).not.toBe(route.polyline);
});

test('the hidden point cannot be recovered by fitting a circle to many routes (jittered trims)', () => {
  // 50 drives leaving HOME in different directions, each with its own seed; take each route's first
  // visible point and fit a circle (Kasa fit). With a fixed 402 m trim the fit would be exact.
  const firsts: LatLng[] = [];
  for (let k = 0; k < 50; k += 1) {
    const t = track(250, (k * 360) / 50);
    const route = trimRoute(t, [], 16_384, `seed-${k}`.padEnd(64, '0'));
    const first = decodePolyline(route.polyline)[0];
    if (first) firsts.push(first);
  }
  expect(firsts.length).toBe(50);
  const xy = firsts.map((p) => ({ x: (p.lng - HOME.lng) * M_PER_DEG_LNG, y: (p.lat - HOME.lat) * M_PER_DEG_LAT }));
  // Kasa: minimise Σ (x² + y² + D x + E y + F)² — solve the 3×3 normal equations.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const { x, y } of xy) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = xy.length;
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const bv = [-sxz, -syz, -sz];
  const det = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const d0 = det(A);
  const col = (i: number) => A.map((row, r) => row.map((v, c) => (c === i ? bv[r]! : v)));
  const D = det(col(0)) / d0;
  const E = det(col(1)) / d0;
  const F = det(col(2)) / d0;
  const cx = -D / 2;
  const cy = -E / 2;
  const r = Math.sqrt(cx * cx + cy * cy - F);
  const residuals = xy.map(({ x, y }) => Math.abs(Math.hypot(x - cx, y - cy) - r));
  const rms = Math.sqrt(residuals.reduce((a, v) => a + v * v, 0) / n);
  // The first visible points are spread over 400 m of radius, not on one circle.
  const radii = xy.map(({ x, y }) => Math.hypot(x, y));
  expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(250);
  expect(rms).toBeGreaterThan(80);
});

test('the polyline fits the byte cap by coarsening', () => {
  const t = track(5000);
  const route = trimRoute(t, [], 200, SEED);
  expect(route.polyline.length).toBeLessThanOrEqual(200);
  expect(route.polyline.length).toBeGreaterThan(0);
  expect(trimRoute([], [], 1000, SEED).polyline).toBe('');
});

test('labels: the zone name first, else the geocoder, else null; a slow geocoder is not waited for', async () => {
  const zone = { id: 'h', name: 'Home', lat: 47.6062, lng: -122.3321, radiusM: 300 };
  expect(await labelFor({ lat: 47.6063, lng: -122.3321 }, [zone], async () => 'Street')).toBe('Home');
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], async () => 'Capitol Hill')).toBe('Capitol Hill');
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], null)).toBeNull();
  expect(await labelFor(null, [zone], async () => 'x')).toBeNull();
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], async () => Promise.reject(new Error('offline')))).toBeNull();
  expect(zoneAt({ lat: 47.6063, lng: -122.3321 }, [zone])?.name).toBe('Home');
});
