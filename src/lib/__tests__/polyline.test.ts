import type { LatLng } from '@/lib/geo';
import { decodePolyline, encodePolyline, simplify } from '@/lib/polyline';

// Google's documented example for the encoded polyline algorithm format.
const GOOGLE_POINTS: LatLng[] = [
  { lat: 38.5, lng: -120.2 },
  { lat: 40.7, lng: -120.95 },
  { lat: 43.252, lng: -126.453 },
];
const GOOGLE_ENCODED = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

/** Metres per degree of latitude on the haversine sphere. */
const M_PER_DEG_LAT = 111_194.93;
/** `n` points every `stepM` metres due north from the origin. */
const meridian = (n: number, stepM = 11): LatLng[] =>
  Array.from({ length: n }, (_, i) => ({ lat: (i * stepM) / M_PER_DEG_LAT, lng: 0 }));

describe('encodePolyline / decodePolyline', () => {
  test("encodes Google's example exactly", () => {
    expect(encodePolyline(GOOGLE_POINTS)).toBe(GOOGLE_ENCODED);
  });

  test("decodes Google's example exactly", () => {
    expect(decodePolyline(GOOGLE_ENCODED)).toEqual(GOOGLE_POINTS);
  });

  test('round-trips to 5 decimal places, including negative and sub-degree values', () => {
    const points: LatLng[] = [
      { lat: 47.60621, lng: -122.33207 },
      { lat: 47.60618, lng: -122.33211 },
      { lat: -0.00001, lng: 0.00001 },
      { lat: 0, lng: 0 },
    ];
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
  });

  test('rounds to 5 dp on the way in', () => {
    expect(decodePolyline(encodePolyline([{ lat: 47.606214999, lng: -122.332075001 }]))).toEqual([
      { lat: 47.60621, lng: -122.33208 },
    ]);
  });

  test('an empty list encodes to the empty string and back', () => {
    expect(encodePolyline([])).toBe('');
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('simplify (Douglas–Peucker, metres)', () => {
  test('a straight line collapses to its two ends', () => {
    const line = meridian(100);
    expect(simplify(line, 10)).toEqual([line[0], line[99]]);
  });

  test('a point further than epsilon from the chord is kept, one within it is dropped', () => {
    const line = meridian(21);
    const withDetour = line.map((p, i) => (i === 10 ? { ...p, lng: 30 / M_PER_DEG_LAT } : p));
    const kept = simplify(withDetour, 10);
    expect(kept).toContainEqual(withDetour[10]);
    expect(kept.length).toBeLessThan(withDetour.length);
    // Kept points are a subsequence of the input, ends included.
    expect(kept[0]).toEqual(withDetour[0]);
    expect(kept[kept.length - 1]).toEqual(withDetour[20]);
    expect(kept.map((k) => withDetour.indexOf(k))).toEqual(
      kept.map((k) => withDetour.indexOf(k)).sort((a, b) => a - b)
    );

    const withWobble = line.map((p, i) => (i === 10 ? { ...p, lng: 5 / M_PER_DEG_LAT } : p));
    expect(simplify(withWobble, 10)).toEqual([line[0], line[20]]);
  });

  test('every original point lies within epsilon of the simplified path', () => {
    // A gentle arc at the equator (so degrees are metres on both axes): 200 points along a
    // quarter circle of 500 m radius.
    const arc: LatLng[] = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 199) * (Math.PI / 2);
      return { lat: (500 * Math.sin(a)) / M_PER_DEG_LAT, lng: (500 * Math.cos(a)) / M_PER_DEG_LAT };
    });
    const kept = simplify(arc, 10);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(arc.length / 4);
    expect(kept[0]).toEqual(arc[0]);
    expect(kept[kept.length - 1]).toEqual(arc[199]);

    const toSegmentM = (p: LatLng, a: LatLng, b: LatLng): number => {
      const [px, py] = [(p.lng - a.lng) * M_PER_DEG_LAT, (p.lat - a.lat) * M_PER_DEG_LAT];
      const [bx, by] = [(b.lng - a.lng) * M_PER_DEG_LAT, (b.lat - a.lat) * M_PER_DEG_LAT];
      const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
      return Math.hypot(px - t * bx, py - t * by);
    };
    for (const p of arc) {
      const nearest = Math.min(
        ...kept.slice(1).map((b, i) => toSegmentM(p, kept[i] as LatLng, b))
      );
      expect(nearest).toBeLessThanOrEqual(10.01);
    }
    // And the simplification did real work: some point is close to the limit.
    const sags = arc.map((p) => Math.min(...kept.slice(1).map((b, i) => toSegmentM(p, kept[i] as LatLng, b))));
    expect(Math.max(...sags)).toBeGreaterThan(5);
  });

  test('fewer than three points are returned as they are, as a copy', () => {
    const two = meridian(2);
    const out = simplify(two, 10);
    expect(out).toEqual(two);
    expect(out).not.toBe(two);
    expect(simplify([], 10)).toEqual([]);
  });

  test('does not mutate its input', () => {
    const line = meridian(50);
    const snapshot = JSON.stringify(line);
    simplify(line, 10);
    expect(JSON.stringify(line)).toBe(snapshot);
  });
});
