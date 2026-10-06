import type { TrackPoint } from '@/core/engine/engine.types';
import { labelFor } from '@/core/engine/labels';
import { keptPoints, parseZones, trimRoute, TRIM_ENDS_M, zoneAt } from '@/core/engine/privacy';
import { decodePolyline } from '@/lib/polyline';

const T0 = 1_700_000_000_000;
const M_PER_DEG_LNG = 111_194.93 * Math.cos((47.6062 * Math.PI) / 180);

/** `n` points 10 m apart heading east, one per second. */
const track = (n: number, lat = 47.6062, lng0 = -122.3321): TrackPoint[] =>
  Array.from({ length: n }, (_, i) => ({ lat, lng: lng0 + (i * 10) / M_PER_DEG_LNG, ts: T0 + i * 1000, hAcc: 5 }));

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

test('the first and last 0.25 mi are trimmed along the route; the middle is kept', () => {
  const t = track(120); // 1190 m
  const kept = keptPoints(t, []);
  const firstKept = kept.indexOf(true);
  const lastKept = kept.lastIndexOf(true);
  expect(TRIM_ENDS_M).toBe(402);
  expect(firstKept).toBe(41); // 410 m along
  expect(lastKept).toBe(78); // 1190 − 780 = 410 m from the end
  expect(kept.slice(firstKept, lastKept + 1).every(Boolean)).toBe(true);
  // A short route is trimmed away entirely.
  expect(keptPoints(track(50), []).some(Boolean)).toBe(false);
});

test('points inside a zone are dropped from the polyline and events there have no coordinates', () => {
  const t = track(200); // ~2 km
  const zone = { id: 'z', name: 'School', lat: t[100]!.lat, lng: t[100]!.lng, radiusM: 200 };
  const route = trimRoute(t, [zone], 16_384);
  const points = decodePolyline(route.polyline);
  // The kept points are collinear, so the simplifier leaves the endpoints; none lies in the zone.
  expect(points.length).toBeGreaterThanOrEqual(2);
  for (const p of points) expect(zoneAt(p, [zone])).toBeNull();
  expect(route.locate(T0 + 100_000)).toBeNull();
  expect(route.locate(T0 + 10_000)).toBeNull(); // the trimmed start
  const mid = route.locate(T0 + 60_000);
  expect(mid).toEqual({ lat: 47.6062, lng: expect.any(Number) });
  // An event between two fixes takes the fix before it.
  expect(route.locate(T0 + 60_500)).toEqual(mid);
});

test('the polyline fits the byte cap by coarsening', () => {
  const t = track(5000);
  const route = trimRoute(t, [], 200);
  expect(route.polyline.length).toBeLessThanOrEqual(200);
  expect(route.polyline.length).toBeGreaterThan(0);
  expect(trimRoute([], [], 1000).polyline).toBe('');
});

test('labels: the zone name first, else the geocoder, else null; a slow geocoder is not waited for', async () => {
  const zone = { id: 'h', name: 'Home', lat: 47.6062, lng: -122.3321, radiusM: 300 };
  expect(await labelFor({ lat: 47.6063, lng: -122.3321 }, [zone], async () => 'Street')).toBe('Home');
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], async () => 'Capitol Hill')).toBe('Capitol Hill');
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], null)).toBeNull();
  expect(await labelFor(null, [zone], async () => 'x')).toBeNull();
  expect(await labelFor({ lat: 47.7, lng: -122.3321 }, [zone], async () => Promise.reject(new Error('offline')))).toBeNull();
});
