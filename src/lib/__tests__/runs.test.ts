import { haversineMeters, type LatLng } from '@/lib/geo';
import { circularMeanDeg, cumulative, exitAt, headingAt, pointAt, project, slice } from '@/lib/runs';

const M_LAT = 1 / 111_195; // degrees of latitude per metre
const BASE = { lat: 47.6, lng: -122.3 };
const K = Math.cos((BASE.lat * Math.PI) / 180);

/** A point `north` metres north and `east` metres east of BASE. */
const at = (north: number, east: number): LatLng => ({ lat: BASE.lat + north * M_LAT, lng: BASE.lng + (east * M_LAT) / K });

/** A straight line north, 10 m a step. */
const NORTH = Array.from({ length: 21 }, (_, i) => at(i * 10, 0)); // 200 m
/** North for 100 m, then east for 100 m (a right turn at 100 m). */
const L_TURN = [...Array.from({ length: 11 }, (_, i) => at(i * 10, 0)), ...Array.from({ length: 10 }, (_, i) => at(100, (i + 1) * 10))];

const near = (a: number, b: number, tol = 1) => {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  expect(d).toBeLessThanOrEqual(tol);
};

describe('cumulative, pointAt, slice', () => {
  test('distance along a run and the point at a distance, clamped to the run', () => {
    const cum = cumulative(NORTH);
    expect(cum[0]).toBe(0);
    expect(cum[cum.length - 1]).toBeCloseTo(200, 0);
    expect(haversineMeters(pointAt(NORTH, cum, 55), NORTH[0]!)).toBeCloseTo(55, 0);
    expect(pointAt(NORTH, cum, -10)).toEqual(NORTH[0]);
    expect(pointAt(NORTH, cum, 1000)).toEqual(NORTH[NORTH.length - 1]);
    expect(pointAt([BASE], [0], 5)).toEqual(BASE);
  });

  test('a stretch has its two cut points and every point between', () => {
    const cum = cumulative(NORTH);
    const s = slice(NORTH, cum, 25, 65);
    expect(s).toHaveLength(2 + 4); // 30, 40, 50, 60 between
    expect(haversineMeters(s[0]!, NORTH[0]!)).toBeCloseTo(25, 0);
    expect(haversineMeters(s[s.length - 1]!, NORTH[0]!)).toBeCloseTo(65, 0);
  });
});

describe('project', () => {
  test('the run, how far along, and how far off in metres', () => {
    const runs = [NORTH, L_TURN.map((p) => ({ lat: p.lat + 0.01, lng: p.lng }))];
    const cums = runs.map(cumulative);
    const p = project(runs, cums, at(42, 12));
    expect(p.run).toBe(0);
    expect(p.d).toBeCloseTo(42, 0);
    expect(p.distM).toBeCloseTo(12, 0);
    const on = project(runs, cums, NORTH[5]!);
    expect(on.distM).toBeCloseTo(0, 3);
  });

  test('an empty route is infinitely far', () => {
    expect(project([], [], BASE).distM).toBe(Infinity);
  });
});

describe('headingAt', () => {
  test('on a straight line north it reads north everywhere, the start included', () => {
    const cum = cumulative(NORTH);
    for (const d of [0, 5, 10, 50, 200]) near(headingAt(NORTH, cum, d)!, 0);
  });

  test('on an L-turn it reads the road before the point', () => {
    const cum = cumulative(L_TURN);
    near(headingAt(L_TURN, cum, 90)!, 0);
    near(headingAt(L_TURN, cum, 150)!, 90);
    // 15 m past the corner: the 30 m before it bend from north to east.
    const h = headingAt(L_TURN, cum, 115)!;
    expect(h).toBeGreaterThan(20);
    expect(h).toBeLessThan(70);
  });

  test('null on a run under 10 m', () => {
    const short = [at(0, 0), at(8, 0)];
    expect(headingAt(short, cumulative(short), 4)).toBeNull();
  });
});

describe('exitAt', () => {
  test('the direction over the 40 m after the point', () => {
    const cum = cumulative(L_TURN);
    near(exitAt(L_TURN, cum, 100)!, 90);
    near(exitAt(L_TURN, cum, 20)!, 0);
  });

  test('null with under 15 m of road after it', () => {
    const cum = cumulative(NORTH);
    expect(exitAt(NORTH, cum, 190)).toBeNull();
    expect(exitAt(NORTH, cum, 180)).not.toBeNull();
  });
});

test('circularMeanDeg averages across north', () => {
  near(circularMeanDeg([350, 10]), 0, 1e-9);
  near(circularMeanDeg([80, 100]), 90, 1e-9);
  expect(circularMeanDeg([])).toBe(0);
  const m = circularMeanDeg([359, 358]);
  expect(m).toBeGreaterThanOrEqual(0);
  expect(m).toBeLessThan(360);
});
