import { row } from '@/core/detectors/__fixtures__/rows';
import {
  BEARING_COURSE_MIN_MPS,
  BEARING_MAX_HACC_M,
  BEARING_MAX_M,
  BEARING_MAX_MPS,
  BEARING_MIN_M,
  BEARING_MOVING_MPS,
  BEARING_WINDOW_MS,
  COURSE_DISAGREE_DEG,
  type DisplayBearing,
  nextBearing,
  NO_BEARING,
} from '@/core/engine/displayBearing';
import type { FeatureRow } from '@/core/engine/types';

const T = 1_700_000_000_000;
const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG = (6_371_008.8 * Math.PI) / 180;
const MPH = 0.44704;

/** A point `east`, `north` metres from the origin. */
const at = (east: number, north: number) => ({ lat: LAT + north / M_PER_DEG, lng: LNG + east / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)) });

/** One row at second `s`, `east`/`north` metres from the origin, no GPS course unless given. */
const r = (s: number, east: number, north: number, over: Partial<FeatureRow> = {}): FeatureRow =>
  row({ ts: T + s * 1000, ...at(east, north), speed: 10, hAcc: 5, course: -1, ...over });

/** Every bearing as the rows go in, from `start`. */
function run(rows: FeatureRow[], start: DisplayBearing = NO_BEARING): DisplayBearing[] {
  let b = start;
  return rows.map((x) => (b = nextBearing(b, x)));
}
const degs = (rows: FeatureRow[], start?: DisplayBearing) => run(rows, start).map((b) => b.deg);
const last = <X>(xs: X[]): X => xs[xs.length - 1]!;
/** The angle between two bearings, the short way round. */
const off = (a: number | null, b: number) => {
  if (a === null) return Infinity;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('the thresholds', () => {
  expect(BEARING_WINDOW_MS).toBe(15_000);
  expect(BEARING_MAX_HACC_M).toBe(30);
  expect([BEARING_MIN_M, BEARING_MAX_M]).toEqual([15, 40]);
  expect(BEARING_MAX_MPS).toBe(70);
  expect(BEARING_MOVING_MPS).toBeCloseTo(3 * MPH, 9);
  expect(BEARING_COURSE_MIN_MPS).toBeCloseTo(5 * MPH, 9);
  expect(COURSE_DISAGREE_DEG).toBe(45);
  expect(NO_BEARING).toEqual({ deg: null, at: null, fixes: [] });
});

describe('B1: from where the car went', () => {
  test('a straight line north at 10 m/s: nothing on the first fix, about 0° once 15 m are covered', () => {
    const out = degs([r(0, 0, 0), r(1, 0, 10), r(2, 0, 20), r(3, 0, 30)]);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull(); // 10 m: not yet far enough to say
    expect(off(out[2]!, 0)).toBeLessThan(0.01);
    expect(off(out[3]!, 0)).toBeLessThan(0.01);
  });

  test('east at 15 m/s reads 90° by the second row; south-west reads 225°', () => {
    expect(off(last(degs([r(0, 0, 0, { speed: 15 }), r(1, 15, 0, { speed: 15 })])), 90)).toBeLessThan(0.01);
    expect(off(last(degs([r(0, 0, 0), r(1, -10, -10), r(2, -20, -20)])), 225)).toBeLessThan(0.01);
  });

  test('a crawl in heavy traffic (2 m/s) gets its first bearing once 15 m are covered, about 8 s in', () => {
    const rows = Array.from({ length: 12 }, (_, i) => r(i, 2 * i, 0, { speed: 2 }));
    const out = degs(rows);
    const first = out.findIndex((d) => d !== null);
    expect(first).toBe(8); // 16 m from the first fix
    expect(off(out[first]!, 90)).toBeLessThan(0.01);
  });

  test('the phone pointing anywhere changes nothing: only positions count (a row’s IMU and orientation are ignored)', () => {
    const twisted = { orientationDelta: 1.2, gravityStability: 0.3, handlingScore: 0.9, yawRateMax: 2 };
    expect(degs([r(0, 0, 0, twisted), r(1, 10, 0, twisted), r(2, 20, 0, twisted)])).toEqual(degs([r(0, 0, 0), r(1, 10, 0), r(2, 20, 0)]));
  });

  test('the pair is the most recent fix far enough back, so a turn shows within a pair’s length', () => {
    // North 60 m, then east: once 15 m east of the corner the bearing is east, not the average.
    const rows = [...Array.from({ length: 7 }, (_, i) => r(i, 0, 10 * i)), ...Array.from({ length: 3 }, (_, i) => r(7 + i, 10 * (i + 1), 60))];
    const out = degs(rows);
    expect(off(out[6]!, 0)).toBeLessThan(0.01);
    // 10 m east of the corner: the pair reaches back to a fix north of it (between north and east).
    expect(off(out[7]!, 0)).toBeGreaterThan(10);
    expect(off(out[7]!, 90)).toBeGreaterThan(10);
    // 20 m east: the corner itself is far enough back.
    expect(off(out[8]!, 90)).toBeLessThan(0.01);
  });

  test('the distance needed grows with the fixes’ accuracy, up to 40 m', () => {
    // 12 m accuracy each: 24 m are needed, so 20 m says nothing and 30 m does.
    const poor = { hAcc: 12 };
    expect(degs([r(0, 0, 0, poor), r(1, 0, 20, poor)])[1]).toBeNull();
    expect(off(degs([r(0, 0, 0, poor), r(2, 0, 30, poor)])[1]!, 0)).toBeLessThan(0.01);
    // 30 m each would need 60: capped at 40.
    const worst = { hAcc: 30 };
    expect(off(degs([r(0, 0, 0, worst), r(3, 0, 40, worst)])[1]!, 0)).toBeLessThan(0.01);
    expect(degs([r(0, 0, 0, worst), r(3, 0, 39, worst)])[1]).toBeNull();
  });

  test('crossing north: 359 and 1 are neighbours, and the value stays in [0, 360)', () => {
    // Heading a little west of north, then a little east of it.
    const west = last(degs([r(0, 0, 0), r(1, -0.35, 10), r(2, -0.7, 20)]));
    expect(west).toBeGreaterThan(357);
    expect(west).toBeLessThan(360);
    const east = last(degs([r(3, -0.35, 30), r(4, 0, 40)], run([r(0, 0, 0), r(1, -0.35, 10), r(2, -0.7, 20)]).at(-1)));
    expect(east).toBeGreaterThan(0);
    expect(east).toBeLessThan(3);
    // Due north is 0, never 360.
    expect(last(degs([r(0, 0, 0), r(1, 0, 20)]))).toBe(0);
  });

  test('a latitude far north scales the east-west metres (60°N)', () => {
    const north60 = (s: number, east: number) =>
      row({ ts: T + s * 1000, lat: 60, lng: 10 + east / (M_PER_DEG * Math.cos((60 * Math.PI) / 180)), speed: 10, hAcc: 5, course: -1 });
    // 20 m east and 20 m north at 60°N is 45°.
    const b = nextBearing(nextBearing(NO_BEARING, north60(0, 0)), { ...north60(2, 20), lat: 60 + 20 / M_PER_DEG });
    expect(off(b.deg, 45)).toBeLessThan(0.1);
  });
});

describe('B3: held', () => {
  const moving = () => run([r(0, 0, 0), r(1, 10, 0), r(2, 20, 0), r(3, 30, 0)]);

  test('stopped: the bearing holds, and GPS jitter at a light (fixes 20 to 30 m apart, 0 mph) never turns it', () => {
    const b = last(moving());
    expect(off(b.deg, 90)).toBeLessThan(0.01);
    const jitter = [r(4, 30, 25, { speed: 0 }), r(5, 5, 0, { speed: 0 }), r(6, 30, -25, { speed: 0 }), r(7, 0, 30, { speed: 0.5 })];
    const out = run(jitter, b);
    for (const x of out) expect(x.deg).toBe(b.deg);
    expect(last(out).at).toBe(b.at);
  });

  test('crawling under 3 mph or with the speed unknown holds too', () => {
    const b = last(moving());
    expect(nextBearing(b, r(4, 30, 30, { speed: 1.3 })).deg).toBe(b.deg);
    expect(nextBearing(b, r(4, 30, 30, { speed: -1 })).deg).toBe(b.deg);
  });

  test('a lost fix holds, and changes nothing at all', () => {
    const b = last(moving());
    expect(nextBearing(b, r(4, 0, 300, { gnssValid: false }))).toBe(b);
    expect(nextBearing(b, { ...r(4, 0, 300), lat: Number.NaN })).toBe(b);
  });

  test('a fix worse than 30 m is never paired: a wild one off to the side holds, and the next good one pairs past it', () => {
    const b = last(moving());
    const wild = nextBearing(b, r(4, 30, 200, { hAcc: 31 }));
    expect(wild.deg).toBe(b.deg);
    expect(wild.fixes).toHaveLength(b.fixes.length);
    expect(off(nextBearing(wild, r(5, 50, 0)).deg, 90)).toBeLessThan(0.01);
  });

  test('a position jump faster than 70 m/s is passed over (the next good pair is used)', () => {
    const b = last(moving());
    // 300 m in a second: no pair with it. Then a fix back on the road pairs with the fixes before the jump.
    const jumped = nextBearing(b, r(4, 30, 300));
    expect(jumped.deg).toBe(b.deg);
    expect(off(nextBearing(jumped, r(5, 50, 0)).deg, 90)).toBeLessThan(1);
  });

  test('fixes older than 15 s are dropped: after a long stop the first bearing needs fresh movement', () => {
    const b = last(moving());
    // 20 s stopped at the same spot, then 10 m north: only the stop's own fixes are left to pair with, under 15 m away.
    const stop = Array.from({ length: 20 }, (_, i) => r(4 + i, 30, 0, { speed: 0 }));
    const after = run(stop, b);
    expect(last(after).fixes.every((f) => f.ts >= T + 23_000 - BEARING_WINDOW_MS)).toBe(true);
    const go = nextBearing(last(after), r(24, 30, 10));
    expect(go.deg).toBe(b.deg); // 10 m: held
    expect(off(nextBearing(go, r(25, 30, 20)).deg, 0)).toBeLessThan(0.01);
  });

  test('a row no newer than the last fix changes nothing; the window keeps at most 32 fixes', () => {
    const b = last(moving());
    expect(nextBearing(b, r(3, 99, 99))).toBe(b);
    const many = run(Array.from({ length: 60 }, (_, i) => ({ ...r(0, 0, 0), ts: T + i * 100, ...at(0, i) })));
    expect(last(many).fixes.length).toBeLessThanOrEqual(32);
  });

  test('pure: the previous value is never changed', () => {
    const b = last(moving());
    const copy = JSON.parse(JSON.stringify(b)) as DisplayBearing;
    nextBearing(b, r(4, 40, 0));
    expect(b).toEqual(copy);
    expect(Object.isFrozen(b)).toBe(true);
  });
});

describe('B2: the GPS course', () => {
  test('with no pair yet (the drive’s first row), a course at 5 mph or more stands in', () => {
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { speed: 10, course: 135 })).deg).toBe(135);
    // Under 5 mph the course is noise.
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { speed: 2, course: 135 })).deg).toBeNull();
    // -1 (iOS: none) and garbage are no course.
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { speed: 10, course: -1 })).deg).toBeNull();
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { speed: 10, course: 400 })).deg).toBeNull();
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { speed: 10, course: 360 })).deg).toBe(0);
  });

  test('a course within 45° of the track: the track is shown; further off (a turn the track lags): the course', () => {
    const base = run([r(0, 0, 0), r(1, 0, 10)]);
    expect(off(nextBearing(last(base), r(2, 0, 20, { course: 30 })).deg, 0)).toBeLessThan(0.01);
    expect(nextBearing(last(base), r(2, 0, 20, { course: 90 })).deg).toBe(90);
  });

  test('a poor fix (over 30 m) still takes a course at speed, but never a pair', () => {
    expect(nextBearing(NO_BEARING, r(0, 0, 0, { hAcc: 45, course: 200 })).deg).toBe(200);
  });

  test('stopped, a stale course from the phone never turns it', () => {
    const b = last(run([r(0, 0, 0), r(1, 0, 10), r(2, 0, 20)]));
    expect(nextBearing(b, r(3, 0, 20, { speed: 0, course: 270 })).deg).toBe(b.deg);
  });
});
