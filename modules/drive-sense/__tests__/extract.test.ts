/** @jest-environment node */
// The feature-extraction reference (R1): hand-computed values on hand-built seconds, and the
// physical assertions of the brief on the simulated drives the golden vectors are made from.
import {
  ALIGN_MIN_UPDATES,
  G_MPS2,
  GNSS_MAX_AGE_S,
  GNSS_MAX_HACC_M,
  NO_FIX_HACC_M,
} from '../src/extract/constants';
import { extractSecond, initialExtractState } from '../src/extract/extract';
import type { ExtractState, FixSample, ImuSample } from '../src/extract/types';
import { runExtractInputs, type ExtractVector } from '../src/extract/vectors';
import type { Vec3 } from '../src/extract/vec';
import { FIRST_ALIGNED_ROW, T0, VECTOR_BUILDERS, turnInputs } from '../scripts/scenarios';
import type { FeatureRow } from '../src/types';

const PHONE = { locked: true, screenOn: false, appForeground: true };
const FLAT_G: Vec3 = [0, 0, -1];

const FRAME_FIELDS = ['aLonMax', 'aLonMin', 'aLatMax', 'aLatMin', 'jerkMax'] as const;
const FREE_FIELDS = ['yawRateMax', 'gravityStability', 'orientationDelta', 'handlingScore'] as const;
const IMU_FIELDS = [...FRAME_FIELDS, ...FREE_FIELDS] as const;

/** 25 samples closing at T0 + s·1000, from a per-sample function of k (0..24). */
function samples(s: number, at: (k: number) => Partial<ImuSample>): ImuSample[] {
  return Array.from({ length: 25 }, (_, k) => ({
    t: T0 + (s - 1) * 1000 + (k + 1) * 40,
    ua: [0, 0, 0] as Vec3,
    g: FLAT_G,
    w: [0, 0, 0] as Vec3,
    ...at(k),
  }));
}

const fix = (s: number, speed: number, over: Partial<FixSample> = {}): FixSample => ({
  t: T0 + s * 1000 - 200,
  lat: 47.6,
  lng: -122.3,
  hAcc: 5,
  speed,
  speedAcc: 0.5,
  course: 0,
  alt: 10,
  ...over,
});

/**
 * A phone lying flat, the car accelerating along device +y at `aG`, each fix `aG` faster than the
 * last. `sign` −1 is CoreMotion's convention (ua = −kinematic), +1 the opposite.
 */
function accelerate(seconds: number, aG: number, sign: 1 | -1 = -1, state = initialExtractState()) {
  const rows: FeatureRow[] = [];
  let st = state;
  for (let s = 1; s <= seconds; s++) {
    const out = extractSecond(
      samples(s, () => ({ ua: [0, sign * aG, 0] })),
      fix(s, 5 + s * aG * G_MPS2),
      PHONE,
      T0 + s * 1000,
      st
    );
    rows.push(out.row);
    st = out.state;
  }
  return { rows, state: st };
}

const byName = (name: keyof typeof VECTOR_BUILDERS) => {
  const v = VECTOR_BUILDERS[name]() as ExtractVector;
  return runExtractInputs(v.inputs);
};

describe('GNSS fields (R2)', () => {
  test('no fix before any: 0/0, hAcc 9999, −1 speed/speedAcc/course, invalid', () => {
    const { row } = extractSecond([], null, PHONE, T0 + 1000, initialExtractState());
    expect(row).toMatchObject({
      ts: T0 + 1000,
      lat: 0,
      lng: 0,
      alt: 0,
      hAcc: NO_FIX_HACC_M,
      speed: -1,
      speedAcc: -1,
      course: -1,
      gnssValid: false,
    });
  });

  test('a missing fix carries the last position forward', () => {
    let st = extractSecond([], fix(1, 10, { lat: 1.5, lng: 2.5, alt: 30 }), PHONE, T0 + 1000, initialExtractState()).state;
    const { row } = extractSecond([], null, PHONE, T0 + 2000, st);
    expect(row).toMatchObject({ lat: 1.5, lng: 2.5, alt: 30, hAcc: 9999, speed: -1, gnssValid: false });
    st = initialExtractState();
    void st;
  });

  test('validity boundaries: hAcc ≤ 50 m and age ≤ 1.5 s', () => {
    const at = (f: FixSample) => extractSecond([], f, PHONE, T0 + 1000, initialExtractState()).row.gnssValid;
    expect(at(fix(1, 10, { hAcc: GNSS_MAX_HACC_M }))).toBe(true);
    expect(at(fix(1, 10, { hAcc: GNSS_MAX_HACC_M + 0.1 }))).toBe(false);
    expect(at(fix(1, 10, { t: T0 + 1000 - GNSS_MAX_AGE_S * 1000 }))).toBe(true);
    expect(at(fix(1, 10, { t: T0 + 1000 - GNSS_MAX_AGE_S * 1000 - 1 }))).toBe(false);
  });

  test('unknown values from the platform are normalised: hAcc < 0 → 9999, others → −1', () => {
    const { row } = extractSecond(
      [],
      fix(1, -3, { hAcc: -1, speedAcc: -0.5, course: -2 }),
      PHONE,
      T0 + 1000,
      initialExtractState()
    );
    expect(row).toMatchObject({ hAcc: 9999, speed: -1, speedAcc: -1, course: -1, gnssValid: false });
  });

  test('ts is the integer epoch ms of the closing second; phone flags are copied', () => {
    const phone = { locked: false, screenOn: true, appForeground: false };
    const { row } = extractSecond([], null, phone, T0 + 999.6, initialExtractState());
    expect(row.ts).toBe(T0 + 1000);
    expect(Number.isInteger(row.ts)).toBe(true);
    expect(row).toMatchObject(phone);
  });
});

describe('IMU-absent encoding (R2)', () => {
  test('fewer than 10 samples → all nine IMU fields 0', () => {
    const nine = samples(1, () => ({ ua: [0.3, 0.2, 0.1], w: [1, 1, 1] })).slice(0, 9);
    const { row } = extractSecond(nine, fix(1, 10), PHONE, T0 + 1000, initialExtractState());
    for (const f of IMU_FIELDS) expect(row[f]).toBe(0);
  });

  test('ten samples are enough', () => {
    const ten = samples(1, () => ({ w: [0, 0, 0.2] })).slice(0, 10);
    const { row } = extractSecond(ten, null, PHONE, T0 + 1000, initialExtractState());
    expect(row.yawRateMax).toBeCloseTo(0.2, 12);
    expect(row.gravityStability).toBe(1);
  });

  test('absent seconds keep the alignment', () => {
    let { state } = accelerate(8, 0.2);
    for (let s = 9; s <= 11; s++) state = extractSecond([], fix(s, 20), PHONE, T0 + s * 1000, state).state;
    const { row } = extractSecond(samples(12, () => ({ ua: [0, 0.3, 0] })), fix(12, 17), PHONE, T0 + 12000, state);
    expect(row.aLonMin).toBeCloseTo(-0.3, 9);
  });
});

describe('forward-axis alignment', () => {
  test(`aligned after 1 + ${ALIGN_MIN_UPDATES} agreeing updates, i.e. in the 7th second of steady acceleration`, () => {
    const { rows, state } = accelerate(8, 0.2);
    for (const r of rows.slice(0, 6)) for (const f of FRAME_FIELDS) expect(r[f]).toBe(0);
    expect(rows[6]!.aLonMax).toBeCloseTo(0.2, 9);
    expect(rows[6]!.aLonMin).toBeCloseTo(0.2, 9);
    expect(state.alignment.aligned).toBe(true);
  });

  test('positive aLon means speeding up whichever sign convention ua uses', () => {
    const a = accelerate(8, 0.2, -1).rows[7]!;
    const b = accelerate(8, 0.2, 1).rows[7]!;
    expect(a.aLonMax).toBeCloseTo(0.2, 9);
    expect(b.aLonMax).toBeCloseTo(0.2, 9);
  });

  test.each([-1, 1] as const)('lateral is left-positive (ua sign %i)', (sign) => {
    const { state } = accelerate(8, 0.2, sign);
    // flat phone, forward = device +y, so left = device −x: kinematic left acceleration 0.3 g
    const kin: Vec3 = [-0.3, 0, 0];
    const ua: Vec3 = [sign * kin[0], 0, 0];
    const first = extractSecond(samples(9, () => ({ ua })), fix(9, 20), PHONE, T0 + 9000, state);
    // the 5-sample average carries the last 4 forward samples in: 0.06, 0.12, … 0.3
    expect(first.row.aLatMax).toBeCloseTo(0.3, 9);
    expect(first.row.aLatMin).toBeCloseTo(0.06, 9);
    const { row } = extractSecond(samples(10, () => ({ ua })), fix(10, 20), PHONE, T0 + 10000, first.state);
    expect(row.aLatMax).toBeCloseTo(0.3, 9);
    expect(row.aLatMin).toBeCloseTo(0.3, 9);
    expect(row.aLonMax).toBeCloseTo(0, 9);
    expect(row.aLonMin).toBeCloseTo(0, 9);
  });

  test('no update below ALIGN_MIN_G of ΔvGNSS', () => {
    const rows: FeatureRow[] = [];
    let st = initialExtractState();
    for (let s = 1; s <= 10; s++) {
      const out = extractSecond(
        samples(s, () => ({ ua: [0, -0.2, 0] })),
        fix(s, 5 + s * 0.09 * G_MPS2),
        PHONE,
        T0 + s * 1000,
        st
      );
      rows.push(out.row);
      st = out.state;
    }
    expect(st.alignment.f).toBeNull();
    expect(rows.every((r) => r.aLonMax === 0)).toBe(true);
  });

  test('a disagreeing update restarts the agreement count', () => {
    let { state } = accelerate(4, 0.2); // 3 updates: f + 2 agreeing
    expect(state.alignment.agree).toBe(2);
    // horizontal acceleration along device x while GNSS says +0.2 g: 90° off
    state = extractSecond(samples(5, () => ({ ua: [-0.2, 0, 0] })), fix(5, 5 + 5 * 0.2 * G_MPS2), PHONE, T0 + 5000, state).state;
    expect(state.alignment.agree).toBe(0);
    expect(state.alignment.aligned).toBe(false);
  });

  test('the GNSS course is never read', () => {
    const a = runExtractInputs(turnInputs(0));
    const b = runExtractInputs(turnInputs(1));
    expect(a.map((r) => r.course)).not.toEqual(b.map((r) => r.course));
    for (let i = 0; i < a.length; i++) for (const f of IMU_FIELDS) expect(b[i]![f]).toBe(a[i]![f]);
  });

  test('extractSecond does not mutate the state it is given', () => {
    const { state } = accelerate(7, 0.2);
    const snapshot = JSON.stringify(state);
    extractSecond(samples(8, () => ({ ua: [0, -0.2, 0], w: [3, 0, 0] })), fix(8, 22), PHONE, T0 + 8000, state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('alignment reset', () => {
  test('orientationDelta above 0.35 rad in a second resets at once', () => {
    const { state } = accelerate(8, 0.2);
    const { row, state: after } = extractSecond(
      samples(9, () => ({ ua: [0, -0.2, 0], w: [0.5, 0, 0] })),
      fix(9, 5 + 9 * 0.2 * G_MPS2),
      PHONE,
      T0 + 9000,
      state
    );
    expect(row.orientationDelta).toBeCloseTo(0.5, 9); // 25 intervals of 40 ms × 0.5 rad/s
    for (const f of FRAME_FIELDS) expect(row[f]).toBe(0);
    expect(after.alignment).toMatchObject({ f: null, aligned: false, agree: 0 });
  });

  test('a gravity direction off its 10 s mean by > 0.2 rad resets only on the 2nd second', () => {
    let { state } = accelerate(8, 0.2);
    const tilt = 0.3;
    const g: Vec3 = [0, -Math.sin(tilt), -Math.cos(tilt)];
    const second = (s: number, st: ExtractState) =>
      extractSecond(samples(s, () => ({ g, ua: [0, -0.2 * Math.cos(tilt), 0.2 * Math.sin(tilt)] })), fix(s, 5 + s * 0.2 * G_MPS2), PHONE, T0 + s * 1000, st);
    const first = second(9, state);
    expect(first.row.aLonMax).not.toBe(0);
    expect(first.state.alignment.gravityDevS).toBe(1);
    state = first.state;
    const secondOut = second(10, state);
    for (const f of FRAME_FIELDS) expect(secondOut.row[f]).toBe(0);
    expect(secondOut.state.alignment.aligned).toBe(false);
  });
});

describe('frame-free features', () => {
  test('yaw about gravity is yawRateMax and counts toward neither orientationDelta nor handling', () => {
    const { row } = extractSecond(samples(1, () => ({ w: [0, 0, -0.3] })), null, PHONE, T0 + 1000, initialExtractState());
    expect(row.yawRateMax).toBeCloseTo(0.3, 12);
    expect(row.orientationDelta).toBe(0);
    expect(row.handlingScore).toBe(0);
  });

  test('handlingScore = clamp((rms − 0.15)/0.6) × 0.5 when gravity is steady', () => {
    const at = (wx: number) =>
      extractSecond(samples(1, () => ({ w: [wx, 0, 0] })), null, PHONE, T0 + 1000, initialExtractState()).row;
    expect(at(0.45).handlingScore).toBeCloseTo(0.25, 12);
    expect(at(0.75).handlingScore).toBeCloseTo(0.5, 12);
    expect(at(0.1).handlingScore).toBe(0);
  });

  test('…and × 1 when gravityStability < 0.95', () => {
    const tilt = (k: number): Vec3 => {
      const a = k < 12 ? 0.05 : k === 12 ? 0 : -0.05;
      return [0, Math.sin(a), -Math.cos(a)];
    };
    const { row } = extractSecond(samples(1, (k) => ({ w: [0.45, 0, 0], g: tilt(k) })), null, PHONE, T0 + 1000, initialExtractState());
    expect(row.gravityStability).toBeCloseTo(0.75, 9);
    expect(row.handlingScore).toBeCloseTo(0.5, 9);
  });

  test('orientationDelta integrates off-axis rate over the sample intervals (first interval from the previous second)', () => {
    const first = extractSecond(samples(1, () => ({ w: [0.2, 0, 0] })), null, PHONE, T0 + 1000, initialExtractState());
    expect(first.row.orientationDelta).toBeCloseTo(0.2 * 0.96, 12); // 24 intervals, no previous sample
    const next = extractSecond(samples(2, () => ({ w: [0.2, 0, 0] })), null, PHONE, T0 + 2000, first.state);
    expect(next.row.orientationDelta).toBeCloseTo(0.2, 12);
  });

  test('jerkMax is the steepest change of smoothed aLon, in g/s', () => {
    const { state } = accelerate(8, 0.2);
    const { row } = extractSecond(
      samples(9, (k) => ({ ua: [0, -(0.2 + (0.4 * k) / 24), 0] })),
      fix(9, 25),
      PHONE,
      T0 + 9000,
      state
    );
    expect(row.jerkMax).toBeCloseTo(0.4 / 0.96, 9);
    expect(row.aLonMax).toBeCloseTo(0.6 - (0.4 / 24) * 2, 9); // 5-sample average ends 2 samples behind
  });
});

describe('the simulated drives (brief assertions)', () => {
  test('cruise: aligned extremes within ±0.05 g, handling 0', () => {
    const rows = byName('cruise');
    expect(rows[FIRST_ALIGNED_ROW]!.aLonMax).toBeGreaterThan(0.15);
    for (const r of rows.slice(0, FIRST_ALIGNED_ROW)) for (const f of FRAME_FIELDS) expect(r[f]).toBe(0);
    // the acceleration ramps off from 7.0 to 7.3 s, so seconds 9 and 10 are pure cruise
    for (const r of rows.slice(8)) {
      for (const f of ['aLonMax', 'aLonMin', 'aLatMax', 'aLatMin'] as const) expect(Math.abs(r[f])).toBeLessThanOrEqual(0.05);
      expect(r.handlingScore).toBe(0);
    }
    for (const r of rows) expect(r.gravityStability).toBeGreaterThan(0.9);
  });

  test('hard brake: aLonMin ≈ −0.45 ± 0.03', () => {
    const rows = byName('hard-brake');
    expect(rows[8]!.aLonMin).toBeGreaterThanOrEqual(-0.48);
    expect(rows[8]!.aLonMin).toBeLessThanOrEqual(-0.42);
    expect(Math.min(...rows.map((r) => r.aLonMin))).toBeCloseTo(-0.45, 1);
    for (const r of rows.slice(7)) expect(Math.abs(r.aLatMax)).toBeLessThanOrEqual(0.05);
    expect(rows[7]!.jerkMax).toBeGreaterThan(1);
  });

  test('left corner: aLatMax ≈ +0.40 ± 0.03 with aLon near 0', () => {
    const rows = byName('corner-left');
    expect(rows[8]!.aLatMax).toBeGreaterThanOrEqual(0.37);
    expect(rows[8]!.aLatMax).toBeLessThanOrEqual(0.43);
    for (const r of rows.slice(8)) {
      expect(Math.abs(r.aLonMax)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.aLonMin)).toBeLessThanOrEqual(0.05);
      expect(r.aLatMin).toBeGreaterThan(-0.05);
    }
    expect(rows[8]!.yawRateMax).toBeGreaterThan(0.15);
  });

  test('lagged-course turn: aLatMin ≈ −0.30 ± 0.03', () => {
    const rows = byName('turn-lagged-course');
    expect(rows[8]!.aLatMin).toBeGreaterThanOrEqual(-0.33);
    expect(rows[8]!.aLatMin).toBeLessThanOrEqual(-0.27);
  });

  test('phone pickup: handlingScore ≥ 0.6, alignment resets', () => {
    const rows = byName('phone-pickup');
    expect(rows[FIRST_ALIGNED_ROW]!.aLonMax).toBeGreaterThan(0.15);
    expect(rows[7]!.handlingScore).toBeGreaterThanOrEqual(0.6);
    expect(rows[7]!.orientationDelta).toBeGreaterThan(0.35);
    for (const r of rows.slice(7)) for (const f of FRAME_FIELDS) expect(r[f]).toBe(0);
  });

  test('mount shift: the slow sag resets through the gravity path in second 10', () => {
    const rows = byName('mount-shift');
    expect(rows[FIRST_ALIGNED_ROW]!.aLonMax).toBeGreaterThan(0.15);
    expect(rows[8]!.aLonMax).not.toBe(0);
    for (const r of rows) expect(r.orientationDelta).toBeLessThan(0.35);
    for (const f of FRAME_FIELDS) expect(rows[9]![f]).toBe(0);
  });

  test('no IMU: every IMU field 0, every GNSS encoding as R2', () => {
    const rows = byName('no-imu');
    for (const r of rows) for (const f of IMU_FIELDS) expect(r[f]).toBe(0);
    expect(rows.map((r) => r.gnssValid)).toEqual([false, true, true, false, false, false, false, true]);
    expect(rows[0]).toMatchObject({ lat: 0, lng: 0, hAcc: 9999, speed: -1 });
    expect(rows[3]!.lat).toBe(rows[2]!.lat);
    expect(rows[5]).toMatchObject({ hAcc: 9999, speed: -1, speedAcc: -1, course: -1 });
  });

  test('unaligned start: frame-free fields populated, extremes zero', () => {
    const rows = byName('unaligned-start');
    for (const r of rows) {
      for (const f of FRAME_FIELDS) expect(r[f]).toBe(0);
      expect(r.gravityStability).toBeGreaterThan(0.9);
      expect(r.orientationDelta).toBeGreaterThan(0);
      expect(r.handlingScore).toBe(0);
    }
    expect(rows[2]!.yawRateMax).toBeGreaterThan(0.05);
  });
});
