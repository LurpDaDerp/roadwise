import type { TrackPoint } from '@/core/engine/engine.types';
import { labelFor } from '@/core/engine/labels';
import { keptPoints, keptRuns, MIN_RUN_M, parseZones, seededRandom, selectRuns, trimPlan, trimRoute, TRIM_ENDS_M, TRIM_JITTER_M, ZONE_JITTER_MAX, zoneAt } from '@/core/engine/privacy';
import { haversineMeters, type LatLng } from '@/lib/geo';
import { decodePolyline, decodeRuns, RUN_SEPARATOR } from '@/lib/polyline';

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

test('parseZones keeps at most 6 well-formed zones, clamping the radius and clipping the name', () => {
  const zones = parseZones([
    { id: 'a', name: 'Home', lat: 47.6, lng: -122.3, radiusM: 100 },
    { id: 'b', name: 'A very long zone name indeed', lat: 47.7, lng: -122.3, radiusM: 5000 },
    { lat: 'x' },
    { id: 'c', name: 'School', lat: 47.8, lng: -122.3, radiusM: 300 },
    { id: 'd', name: 'Work', lat: 47.9, lng: -122.3, radiusM: 400 },
    { id: 'e', name: 'Gym', lat: 48.0, lng: -122.3, radiusM: 500 },
    { id: 'f', name: 'Park', lat: 48.1, lng: -122.3, radiusM: 600, placeId: 'place-1' },
    { id: 'g', name: 'Seventh', lat: 48.2, lng: -122.3, radiusM: 300 },
  ]);
  expect(zones.map((z) => z.radiusM)).toEqual([200, 800, 300, 400, 500, 600]);
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
  expect(keptRuns([false, true, true, false, true, true, true, false])).toEqual([[1, 3], [4, 7]]);
  expect(keptRuns([true, true])).toEqual([[0, 2]]);
  expect(keptRuns([false])).toEqual([]);
  expect(keptRuns([])).toEqual([]);
});

test('a route through a zone keeps both visible runs, each encoded on its own, and is never drawn across the zone; events inside are unlocated', () => {
  const t = track(400); // ~4 km east, the zone at 1.5 km
  const zone = { id: 'z', name: 'School', lat: t[150]!.lat, lng: t[150]!.lng, radiusM: 200 };
  const route = trimRoute(t, [zone], 16_384, SEED);
  expect(route.runs).toHaveLength(2);
  const runs = route.runs.map(decodePolyline);
  expect(decodeRuns(route.runs.join(RUN_SEPARATOR))).toEqual(runs);
  // Both sides of the zone are on the wire: the western run ends before it, the eastern starts after it...
  const [west, east] = runs as [LatLng[], LatLng[]];
  expect(west.length).toBeGreaterThanOrEqual(2);
  expect(east.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...west.map((p) => p.lng))).toBeLessThan(zone.lng);
  expect(Math.min(...east.map((p) => p.lng))).toBeGreaterThan(zone.lng);
  // ...no encoded point is inside the (jittered) zone, and no segment of either run crosses it: the chord is never drawn.
  for (const run of runs) {
    for (const p of run) expect(haversineMeters(p, zone)).toBeGreaterThan(route.plan.zoneRadiiM[0]!);
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1]!;
      const b = run[i]!;
      expect(Math.sign(a.lng - zone.lng)).toBe(Math.sign(b.lng - zone.lng));
    }
  }
  // The visible distance is the whole route minus the trims and the zone, not half of it.
  const visibleM = runs.reduce((m, run) => m + run.slice(1).reduce((s, p, i) => s + haversineMeters(run[i]!, p), 0), 0);
  expect(visibleM).toBeGreaterThan(3990 - route.plan.startM - route.plan.endM - 2 * route.plan.zoneRadiiM[0]! - 40);
  // The event at the zone centre, and one inside the jittered radius just outside the zone proper, have no coordinates.
  expect(route.locate(T0 + 150_000)).toBeNull();
  const edge = Math.floor(route.plan.zoneRadiiM[0]! / 10) - 1;
  expect(route.locate(T0 + (150 + edge) * 1000)).toBeNull();
  // Located events lie on an encoded run: one on each side.
  const onARun = (p: LatLng) => runs.some((run) => run.some((q) => Math.abs(q.lat - p.lat) < 2e-5 && Math.abs(q.lng - p.lng) < 2e-5));
  const before = route.locate(T0 + 100_000)!;
  const after = route.locate(T0 + 300_000)!;
  expect(before).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
  expect(after).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
  expect(before.lng).toBeLessThan(zone.lng);
  expect(after.lng).toBeGreaterThan(zone.lng);
  expect(onARun(west[0]!) && onARun(east[east.length - 1]!)).toBe(true);
  expect(route.locate(T0 + 10_000)).toBeNull(); // the trimmed start
  // Deterministic: the same seed gives the same runs; another seed, another cut.
  expect(trimRoute(t, [zone], 16_384, SEED).runs).toEqual(route.runs);
  expect(trimRoute(t, [zone], 16_384, 'c'.repeat(64)).runs).not.toEqual(route.runs);
});

test('a stub shorter than MIN_RUN_M left by a zone edge is dropped (it would pin the cut), and an event on it is unlocated', () => {
  const t = track(400);
  const plan = trimPlan(SEED, []);
  // A zone whose far edge lands ~30 m before the end trim: the points between are a stub too short to show.
  const stubM = 30;
  const zoneEdgeAlong = 3990 - plan.endM - stubM;
  const radiusM = 200;
  const centreIdx = Math.round((zoneEdgeAlong - radiusM) / 10);
  const zone = { id: 'z', name: 'Z', lat: t[centreIdx]!.lat, lng: t[centreIdx]!.lng, radiusM };
  const route = trimRoute(t, [zone], 16_384, SEED);
  expect(route.runs).toHaveLength(1);
  const run = decodePolyline(route.runs[0]!);
  expect(Math.max(...run.map((p) => p.lng))).toBeLessThan(zone.lng);
  // Whatever is kept past the zone is under MIN_RUN_M, so it is not on the wire and not a location.
  const pastZone = t.map((_, i) => i).filter((i) => i * 10 > zoneEdgeAlong - 60 && 3990 - i * 10 >= plan.endM);
  for (const i of pastZone) expect(route.locate(T0 + i * 1000)).toBeNull();
  expect(selectRuns([[t[0]!, t[1]!], t.slice(0, 20)], 20)).toEqual([1]); // 10 m is under MIN_RUN_M
  expect(MIN_RUN_M).toBeGreaterThanOrEqual(50);
});

test('no more than the run cap goes on the wire: the shortest runs are dropped first, the rest keep their order', () => {
  const t = track(400);
  // Zones at 1.0 km and 2.5 km cut the route into three runs: 0.6-0.9 km, 1.2-2.3 km, 2.7-3.4 km.
  const zones = [
    { id: 'a', name: 'A', lat: t[100]!.lat, lng: t[100]!.lng, radiusM: 200 },
    { id: 'b', name: 'B', lat: t[250]!.lat, lng: t[250]!.lng, radiusM: 200 },
  ];
  const all = trimRoute(t, zones, 16_384, SEED);
  expect(all.runs).toHaveLength(3);
  const capped = trimRoute(t, zones, 16_384, SEED, 2);
  expect(capped.runs).toHaveLength(2);
  const lengths = all.runs.map((r) => decodePolyline(r)).map((run) => run.slice(1).reduce((s, p, i) => s + haversineMeters(run[i]!, p), 0));
  const shortest = lengths.indexOf(Math.min(...lengths));
  expect(capped.runs).toEqual(all.runs.filter((_, i) => i !== shortest));
  // An event on the dropped run (at its middle) is unlocated under the cap; without the cap it is located.
  const dropped = decodePolyline(all.runs[shortest]!);
  const midLng = (dropped[0]!.lng + dropped[dropped.length - 1]!.lng) / 2;
  const droppedIdx = t.reduce((best, p, i) => (Math.abs(p.lng - midLng) < Math.abs(t[best]!.lng - midLng) ? i : best), 0);
  expect(capped.locate(T0 + droppedIdx * 1000)).toBeNull();
  expect(all.locate(T0 + droppedIdx * 1000)).not.toBeNull();
});

test('the hidden point cannot be recovered by fitting a circle to many routes (jittered trims)', () => {
  // 50 drives leaving HOME in different directions, each with its own seed; take each route's first
  // visible point and fit a circle (Kasa fit). With a fixed 402 m trim the fit would be exact.
  const firsts: LatLng[] = [];
  for (let k = 0; k < 50; k += 1) {
    const t = track(250, (k * 360) / 50);
    const route = trimRoute(t, [], 16_384, `seed-${k}`.padEnd(64, '0'));
    const first = decodeRuns(route.runs.join(RUN_SEPARATOR))[0]?.[0];
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

test('the route fits the byte cap by coarsening, separators included; past that the shortest runs go', () => {
  const t = track(5000);
  const route = trimRoute(t, [], 200, SEED);
  const wire = route.runs.join(RUN_SEPARATOR);
  expect(wire.length).toBeLessThanOrEqual(200);
  expect(wire.length).toBeGreaterThan(0);
  expect(trimRoute([], [], 1000, SEED).runs).toEqual([]);
  // Two runs that cannot both fit even as two points each: the longer one stays.
  const zone = { id: 'z', name: 'Z', lat: t[1000]!.lat, lng: t[1000]!.lng, radiusM: 200 };
  const two = trimRoute(t, [zone], 16_384, SEED);
  expect(two.runs).toHaveLength(2);
  const squeezed = trimRoute(t, [zone], 30, SEED);
  expect(squeezed.runs).toHaveLength(1);
  expect(squeezed.runs.join(RUN_SEPARATOR).length).toBeLessThanOrEqual(30);
  expect(decodePolyline(squeezed.runs[0]!)[0]!.lng).toBeGreaterThan(zone.lng); // the long eastern run
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
