/** @jest-environment node */
import { fullRoute, MAX_ROUTE_FULL_BYTES, placeOnTrack } from '@/core/engine/fullRoute';
import type { TrackPoint } from '@/core/engine/engine.types';
import { decodeRuns, splitRuns } from '@/lib/polyline';

const T0 = 1_700_000_000_000;
const point = (i: number, lat: number, lng: number): TrackPoint => ({ lat, lng, ts: T0 + i * 1000, hAcc: 5 });

/** A zig-zag east from Seattle: every point 40 m off the line through its neighbours, so none simplifies away at 10 m. */
const zigzag = (n: number): TrackPoint[] => Array.from({ length: n }, (_, i) => point(i, 47.6 + (i % 2) * 0.00036, -122.33 + i * 0.0002));

test('the whole route is one run of the whole track, simplified, with both ends', () => {
  const track = [point(0, 47.6, -122.33), point(1, 47.6, -122.329), point(2, 47.6, -122.328), point(3, 47.601, -122.327)];
  const runs = decodeRuns(fullRoute(track));
  expect(runs).toHaveLength(1);
  // The straight stretch simplifies to its ends; the bend stays.
  expect(runs[0]).toEqual([
    { lat: 47.6, lng: -122.33 },
    { lat: 47.6, lng: -122.328 },
    { lat: 47.601, lng: -122.327 },
  ]);
});

test('fewer than two fixes is no route', () => {
  expect(fullRoute([])).toBe('');
  expect(fullRoute([point(0, 47.6, -122.33)])).toBe('');
});

test('a route over the cap is simplified harder until it fits, never split or cut short', () => {
  const track = zigzag(2000);
  const loose = fullRoute(track);
  expect(loose.length).toBeLessThanOrEqual(MAX_ROUTE_FULL_BYTES);
  expect(decodeRuns(loose)[0]).toHaveLength(2000);
  const tight = fullRoute(track, 2000);
  expect(tight.length).toBeLessThanOrEqual(2000);
  expect(splitRuns(tight)).toHaveLength(1);
  const runs = decodeRuns(tight)[0]!;
  expect(runs.length).toBeLessThan(2000);
  expect(runs[0]).toEqual({ lat: 47.6, lng: -122.33 });
  expect(runs[runs.length - 1]).toEqual({ lat: track[1999]!.lat, lng: Math.round(track[1999]!.lng * 1e5) / 1e5 });
});

test('an event is placed at the last fix at or before it (the first before the track starts), to 5 dp', () => {
  const track = [point(0, 47.600001, -122.330004), point(1, 47.61, -122.32), point(5, 47.62, -122.31)];
  expect(placeOnTrack(track, T0 + 3000)).toEqual({ lat: 47.61, lng: -122.32 });
  expect(placeOnTrack(track, T0 - 5000)).toEqual({ lat: 47.6, lng: -122.33 });
  expect(placeOnTrack(track, T0 + 9000)).toEqual({ lat: 47.62, lng: -122.31 });
  expect(placeOnTrack([], T0)).toBeNull();
});
