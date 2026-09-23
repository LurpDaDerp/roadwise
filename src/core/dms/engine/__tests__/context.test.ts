// Vehicle context (plan §M1 units, §M3 straight flag, C-19, rev1 I5 and I6): native-units rows in,
// km/h, °/s, the signed course rate and turn sign out; the straight flag with the gyro veto; IMU
// presence; staleness; and the tunnel rules for unknown speed.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { contextFromRow, createContextTracker, imuPresent, type FeatureRowLike } from '../context';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const RAD = Math.PI / 180;

/** A raw drive-sense row: speed m/s, yawRateMax rad/s, course degrees. */
function row(over: Partial<FeatureRowLike> & { ts: number }): FeatureRowLike {
  return {
    speed: 22.2,
    course: 90,
    gnssValid: true,
    aLonMax: 0.02,
    aLonMin: -0.02,
    aLatMax: 0.03,
    aLatMin: -0.03,
    yawRateMax: 2 * RAD,
    jerkMax: 0.05,
    gravityStability: 0.99,
    orientationDelta: 0.01,
    handlingScore: 0,
    ...over,
  };
}
const EX = { imuMoving: true, localMinutes: 720, tripElapsedS: 100 };

describe('units (the native-units row vector, rev1 I5)', () => {
  test('speed m/s → km/h; yawRateMax rad/s → °/s (2 rad/s reads 114.6°/s)', () => {
    const c = contextFromRow(row({ ts: 1000, speed: 16.6667, yawRateMax: 2 }), null, 5000, EX, C);
    expect(c.speedKmh).toBeCloseTo(60, 3);
    expect(c.yawRateDegS).toBeCloseTo(114.59, 2);
    expect(c.tMs).toBe(5000);
  });
  test('unknown speed: −1, or no GNSS fix', () => {
    expect(contextFromRow(row({ ts: 0, speed: -1 }), null, 0, EX, C).speedKmh).toBeNull();
    const noFix = contextFromRow(row({ ts: 0, gnssValid: false }), null, 0, EX, C);
    expect(noFix.speedKmh).toBeNull();
    expect(noFix.straight).toBeNull();
  });
  test('the course rate between valid rows: 359° → 3° is +4°/s (a right turn), 3° → 359° is −4°/s', () => {
    const a = row({ ts: 1000, course: 359 });
    const right = contextFromRow(row({ ts: 2000, course: 3 }), a, 0, EX, C);
    expect(right.courseRateDegS).toBeCloseTo(4, 9);
    expect(right.turnSign).toBe(1);
    const left = contextFromRow(row({ ts: 2000, course: 359 }), row({ ts: 1000, course: 3 }), 0, EX, C);
    expect(left.turnSign).toBe(-1);
    // A rate at or below 2°/s gives no sign.
    expect(contextFromRow(row({ ts: 2000, course: 1 }), a, 0, EX, C).turnSign).toBe(0);
  });
  test('no course rate across an invalid row or below 2 m/s', () => {
    expect(contextFromRow(row({ ts: 2000, course: 10 }), row({ ts: 1000, course: 0, gnssValid: false }), 0, EX, C).courseRateDegS).toBeNull();
    expect(contextFromRow(row({ ts: 2000, course: 10, speed: 1.9 }), row({ ts: 1000, course: 0 }), 0, EX, C).courseRateDegS).toBeNull();
  });
  test('C-19: all nine IMU fields 0 means no IMU (no yaw rate)', () => {
    const zero = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };
    expect(imuPresent(row({ ts: 0, ...zero }))).toBe(false);
    expect(imuPresent(row({ ts: 0, ...zero, gravityStability: 0.5 }))).toBe(true);
    const c = contextFromRow(row({ ts: 0, ...zero }), null, 0, EX, C);
    expect(c.imuPresent).toBe(false);
    expect(c.yawRateDegS).toBeNull();
  });
  test('handling: handlingScore ≥ 0.6', () => {
    expect(contextFromRow(row({ ts: 0, handlingScore: 0.6 }), null, 0, EX, C).handling).toBe(true);
    expect(contextFromRow(row({ ts: 0, handlingScore: 0.59 }), null, 0, EX, C).handling).toBe(false);
  });
});

describe('the straight flag (§M3, rev1 I5)', () => {
  const run = (rows: Partial<FeatureRowLike>[]) => {
    const t = createContextTracker(C);
    return rows.map((r, i) => t.onRow(row({ ts: 1000 * (i + 1), ...r }), 1000 * (i + 1), EX).straight);
  };
  test('a flat course on 3 consecutive valid rows at ≥ 30 km/h, highway gyro noise (3–5°/s) → straight', () => {
    expect(run([{ yawRateMax: 3 * RAD }, { yawRateMax: 5 * RAD }, { yawRateMax: 4 * RAD }, { yawRateMax: 3 * RAD }])).toEqual([false, false, false, true]);
  });
  test('a gyro peak above 6°/s on any of those rows vetoes it', () => {
    expect(run([{}, {}, { yawRateMax: 6.5 * RAD }, {}])).toEqual([false, false, false, false]);
  });
  test('a course rate of 2°/s or more, or a speed below 30 km/h, breaks it; no fix → unknown', () => {
    expect(run([{ course: 90 }, { course: 92.5 }, { course: 95 }, { course: 97.5 }])).toEqual([false, false, false, false]);
    expect(run([{ speed: 8 }, { speed: 8 }, { speed: 8 }, { speed: 8 }])).toEqual([false, false, false, false]);
    expect(run([{}, {}, {}, { gnssValid: false }])).toEqual([false, false, false, null]);
  });
  test('without an IMU the course rate alone decides (no veto possible)', () => {
    const zero = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };
    expect(run([zero, zero, zero, zero])).toEqual([false, false, false, true]);
  });
});

describe('staleness and the tunnel rules (§M1, rev1 I6)', () => {
  test('a row older than 3 s is stale: speed unknown', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 1000 }), 10_000, EX);
    expect(t.at(12_999).ctx!.speedKmh).not.toBeNull();
    expect(t.at(13_001).ctx!.speedKmh).toBeNull();
  });
  test('unknown speed while the IMU shows motion keeps the last known speed for the rules (10 min)', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20 }), 0, EX); // 72 km/h
    for (let s = 1; s <= 601; s++) t.onRow(row({ ts: s * 1000, speed: -1, gnssValid: false }), s * 1000, EX); // a tunnel: rows keep coming
    const st = t.at(60_000);
    expect(st.speedKnown).toBe(false);
    expect(st.ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(st.speedHeld).toBe(true);
    expect(st.imuAbsentHold).toBe(false);
    expect(t.at(600_000).ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(t.at(600_001).ruleSpeedKmh).toBeNull();
  });
  test('T8 review I1: one still row 60 s into a moving tunnel never leaves the held speed', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20 }), 0, EX);
    const seen: (number | null)[] = [];
    for (let s = 1; s <= 90; s++) {
      t.onRow(row({ ts: s * 1000, speed: -1, gnssValid: false }), s * 1000, { ...EX, imuMoving: s !== 60 });
      for (let k = 0; k < 1000; k += 250) seen.push(t.at(s * 1000 + k).ruleSpeedKmh);
    }
    expect(new Set(seen.map((v) => (v === null ? null : Math.round(v))))).toEqual(new Set([72]));
  });
  test('T8 review I1: 60 s moving, then still rows: held until 10 s after the FIRST still row, then 0', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20 }), 0, EX);
    for (let s = 1; s <= 60; s++) t.onRow(row({ ts: s * 1000, speed: -1, gnssValid: false }), s * 1000, EX);
    for (let s = 61; s <= 72; s++) t.onRow(row({ ts: s * 1000, speed: -1, gnssValid: false }), s * 1000, { ...EX, imuMoving: false });
    expect(t.at(71_000).ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(t.at(71_001).ruleSpeedKmh).toBe(0);
  });
  test('T8 review m3: when rows stop arriving, motion is unknown: 10 s from the last row, then 0', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20 }), 0, EX);
    t.onRow(row({ ts: 1000, speed: -1, gnssValid: false }), 1000, EX); // moving, then silence
    expect(t.at(11_000).ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(t.at(11_001).ruleSpeedKmh).toBe(0);
  });
  test('T8 review m4: speedKnown separates a known speed from a held or inferred one', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 0 }), 0, EX);
    expect(t.at(0)).toMatchObject({ speedKnown: true, ruleSpeedKmh: 0 });
    t.onRow(row({ ts: 1000, speed: -1, gnssValid: false }), 1000, { ...EX, imuMoving: false });
    expect(t.at(20_000)).toMatchObject({ speedKnown: false, ruleSpeedKmh: 0 });
  });
  test('unknown speed with the IMU still: the last speed for 10 s, then below 10 km/h', () => {
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20 }), 0, EX);
    for (let s = 1; s <= 60; s++) t.onRow(row({ ts: s * 1000, speed: -1, gnssValid: false }), s * 1000, { ...EX, imuMoving: false });
    expect(t.at(10_000).ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(t.at(11_001).ruleSpeedKmh).toBe(0);
  });
  test('unknown speed with the IMU ABSENT: held for the fast rules, but flagged so D1–D3 stay off (T1r1 R1-m1)', () => {
    const zero = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };
    const t = createContextTracker(C);
    t.onRow(row({ ts: 0, speed: 20, ...zero }), 0, EX);
    t.onRow(row({ ts: 1000, speed: -1, gnssValid: false, ...zero }), 1000, EX); // the host passes imuMoving = true (not "still")
    const st = t.at(1000);
    expect(st.ruleSpeedKmh).toBeCloseTo(72, 6);
    expect(st.imuAbsentHold).toBe(true);
  });
});
