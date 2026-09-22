/** @jest-environment node */
import { encodePolyline } from '@/lib/polyline';
import {
  angleDiffDeg,
  bboxOf,
  decodeLine,
  nearBBox,
  nearestOnPolyline,
  normalizeDeg,
} from '@/core/speedLimits/geometry';

/** The fixture corridor (B1 seed): east-west on lat 47.6062. */
const CORRIDOR = [
  { lat: 47.6062, lng: -122.333 },
  { lat: 47.6062, lng: -122.316 },
  { lat: 47.6062, lng: -122.299 },
];
const M_PER_DEG = 111_320;

const flat = (pts: { lat: number; lng: number }[]): Float64Array =>
  Float64Array.from(pts.flatMap((p) => [p.lat, p.lng]));

describe('decodeLine', () => {
  it("decodes Google's reference polyline", () => {
    const line = decodeLine('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(Array.from(line)).toEqual([38.5, -120.2, 40.7, -120.95, 43.252, -126.453]);
  });

  it('round-trips an encoded corridor into a flat [lat, lng, …] array', () => {
    const line = decodeLine(encodePolyline(CORRIDOR));
    expect(line).toBeInstanceOf(Float64Array);
    expect(Array.from(line)).toEqual([47.6062, -122.333, 47.6062, -122.316, 47.6062, -122.299]);
  });

  it('throws on an empty string rather than returning a line with no points', () => {
    expect(() => decodeLine('')).toThrow(/no points/);
  });

  it('throws on a value cut off mid-chunk', () => {
    const good = encodePolyline(CORRIDOR);
    // The last character of a value is < 0x20 + 63; dropping it leaves a continuation chunk dangling.
    expect(() => decodeLine(good.slice(0, 3))).toThrow();
  });

  it('throws on a character outside the polyline alphabet', () => {
    expect(() => decodeLine('_p~iF ps|U')).toThrow(/alphabet/);
  });

  it('throws on an odd number of values (a latitude with no longitude)', () => {
    expect(() => decodeLine('_p~iF')).toThrow(/odd/);
  });

  it('throws on a coordinate off the globe', () => {
    expect(() => decodeLine(encodePolyline([{ lat: 95, lng: 0 }]))).toThrow(/globe/);
  });
});

describe('nearestOnPolyline', () => {
  const line = flat(CORRIDOR);

  it('measures the perpendicular distance and the digitised bearing (east = 90)', () => {
    const p = { lat: 47.6062 + 20 / M_PER_DEG, lng: -122.32 };
    const r = nearestOnPolyline(p, line);
    expect(r.distanceM).toBeCloseTo(20, 1);
    expect(r.bearingDeg).toBeCloseTo(90, 3);
  });

  it('reports the reverse bearing for a line digitised the other way', () => {
    const reversed = flat([...CORRIDOR].reverse());
    const r = nearestOnPolyline({ lat: 47.6061, lng: -122.32 }, reversed);
    expect(r.bearingDeg).toBeCloseTo(270, 3);
    expect(r.distanceM).toBeCloseTo(0.0001 * M_PER_DEG, 1);
  });

  it('measures to the end vertex past the end of the line', () => {
    const cos = Math.cos((47.6062 * Math.PI) / 180);
    const p = { lat: 47.6062, lng: -122.299 + 30 / (M_PER_DEG * cos) };
    expect(nearestOnPolyline(p, line).distanceM).toBeCloseTo(30, 1);
  });

  it('picks the segment actually nearest on a bent line, with that segment’s bearing', () => {
    // East for ~150 m, then north for ~220 m.
    const bent = flat([
      { lat: 47.6, lng: -122.3 },
      { lat: 47.6, lng: -122.298 },
      { lat: 47.602, lng: -122.298 },
    ]);
    const nearNorthLeg = { lat: 47.601, lng: -122.2981 };
    const r = nearestOnPolyline(nearNorthLeg, bent);
    expect(r.bearingDeg).toBeCloseTo(0, 3);
    expect(r.distanceM).toBeLessThan(10);
  });

  it('gives a NaN bearing for a line with no extent, so it can never pass a heading test', () => {
    const one = flat([{ lat: 47.6, lng: -122.3 }]);
    const stuck = flat([
      { lat: 47.6, lng: -122.3 },
      { lat: 47.6, lng: -122.3 },
    ]);
    const p = { lat: 47.6001, lng: -122.3 };
    expect(Number.isNaN(nearestOnPolyline(p, one).bearingDeg)).toBe(true);
    expect(Number.isNaN(nearestOnPolyline(p, stuck).bearingDeg)).toBe(true);
    expect(nearestOnPolyline(p, stuck).distanceM).toBeCloseTo(0.0001 * M_PER_DEG, 1);
  });

  it('ignores a zero-length segment inside a real line', () => {
    const withDup = flat([CORRIDOR[0]!, CORRIDOR[0]!, CORRIDOR[2]!]);
    expect(nearestOnPolyline({ lat: 47.6063, lng: -122.33 }, withDup).bearingDeg).toBeCloseTo(90, 3);
  });

  it('throws on an empty line', () => {
    expect(() => nearestOnPolyline({ lat: 0, lng: 0 }, new Float64Array(0))).toThrow();
  });
});

describe('bboxOf / nearBBox', () => {
  it('bounds a line', () => {
    const b = bboxOf(flat([{ lat: 47.6, lng: -122.3 }, { lat: 47.61, lng: -122.31 }, { lat: 47.605, lng: -122.29 }]));
    expect(b).toEqual({ minLat: 47.6, minLng: -122.31, maxLat: 47.61, maxLng: -122.29 });
  });

  it('prefilters by a margin in metres', () => {
    const b = bboxOf(flat(CORRIDOR));
    expect(nearBBox({ lat: 47.6062 + 20 / M_PER_DEG, lng: -122.32 }, b, 25)).toBe(true);
    expect(nearBBox({ lat: 47.6062 + 30 / M_PER_DEG, lng: -122.32 }, b, 25)).toBe(false);
    const cos = Math.cos((47.6062 * Math.PI) / 180);
    expect(nearBBox({ lat: 47.6062, lng: -122.299 + 20 / (M_PER_DEG * cos) }, b, 25)).toBe(true);
    expect(nearBBox({ lat: 47.6062, lng: -122.299 + 30 / (M_PER_DEG * cos) }, b, 25)).toBe(false);
  });
});

describe('angles', () => {
  it('normalises into 0..<360', () => {
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(-1e-15)).toBe(0);
    expect(normalizeDeg(725)).toBe(5);
  });

  it('takes the short way round', () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(20);
    expect(angleDiffDeg(90, 270)).toBe(180);
  });
});
