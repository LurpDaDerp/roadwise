/** @jest-environment node */
// The Android complementary gravity filter (R1): gyro propagation + an accelerometer low-pass with
// time constant GRAVITY_TAU_S, in the reference sign convention.
import { CONSTANTS } from '@scoring';
import {
  G_MPS2,
  GRAVITY_GATE_G,
  GRAVITY_GATE_SAMPLES,
  GRAVITY_TAU_S,
} from '../src/extract/constants';
import { extractSecond, initialExtractState } from '../src/extract/extract';
import {
  androidAccelToReference,
  gravityFilter,
  initialGravityState,
} from '../src/extract/gravityFilter';
import type { RawImuSample } from '../src/extract/types';
import { angle, norm, sub, type Vec3 } from '../src/extract/vec';
import {
  gravityRawBatches,
  MOUNT_GRAVITY,
  profile,
  rawDriveSeconds,
  T0,
} from '../scripts/scenarios';

const at = (k: number, a: Vec3, w: Vec3 = [0, 0, 0], dtMs = 40): RawImuSample => ({ t: T0 + k * dtMs, a, w });

test('Android accelerometer values convert to the reference sign', () => {
  expect(androidAccelToReference([0, 0, G_MPS2])).toEqual([0, 0, -1]);
  const r = androidAccelToReference([1, -2, 3]);
  expect(r[0]).toBeCloseTo(-1 / G_MPS2, 15);
  expect(r[1]).toBeCloseTo(2 / G_MPS2, 15);
});

test('the first sample seeds gravity: g = a, ua = 0', () => {
  const { imu, state } = gravityFilter([at(0, [0.1, -0.9, -0.4], [0.2, 0, 0])], initialGravityState());
  expect(imu[0]).toEqual({ t: T0, ua: [0, 0, 0], g: [0.1, -0.9, -0.4], w: [0.2, 0, 0] });
  expect(state).toEqual({ g: [0.1, -0.9, -0.4], t: T0, mags: [norm([0.1, -0.9, -0.4])] });
});

test('at rest with a steady accelerometer, gravity stays put and ua is 0', () => {
  const a: Vec3 = [0, -0.94, -0.34];
  const { imu } = gravityFilter(Array.from({ length: 50 }, (_, k) => at(k, a)), initialGravityState());
  for (const s of imu) {
    expect(norm(sub(s.g, a))).toBeLessThan(1e-12);
    expect(norm(s.ua)).toBeLessThan(1e-12);
  }
});

test(`a wrong seed decays with time constant GRAVITY_TAU_S (${GRAVITY_TAU_S} s)`, () => {
  const truth: Vec3 = [0, 0, -1];
  const n = 25 * 3 * GRAVITY_TAU_S; // three time constants
  const input = [at(0, [0.3, 0, -0.95]), ...Array.from({ length: n }, (_, k) => at(k + 1, truth))];
  const { imu } = gravityFilter(input, initialGravityState());
  const err0 = norm(sub(imu[0]!.g, truth));
  const err1s = norm(sub(imu[25]!.g, truth));
  const alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + 0.04);
  expect(err1s / err0).toBeCloseTo(alpha ** 25, 9);
  expect(norm(sub(imu[n]!.g, truth))).toBeLessThan(0.06 * err0);
});

test('the gate trips, in horizontal acceleration, below the harsh-acceleration threshold', () => {
  // A SUSTAINED horizontal acceleration h makes every |a| — and so their 5-sample mean — equal
  // √(1 + h²), so the gate closes once h > √((1 + GATE)² − 1). Above HARSH_ACCEL_G that would
  // leave harsh accelerations between the two ungated, and absorbed into gravity.
  const tripG = Math.sqrt((1 + GRAVITY_GATE_G) ** 2 - 1);
  expect(tripG).toBeLessThan(CONSTANTS.HARSH_ACCEL_G);
  expect(tripG).toBeLessThan(CONSTANTS.HARSH_BRAKE_G);
});

test(`the gate reads the mean |a| of the last ${GRAVITY_GATE_SAMPLES} samples, not each sample`, () => {
  const g0: Vec3 = [0, 0, -1];
  const { state } = gravityFilter([at(0, g0)], initialGravityState());
  // one 1.08 g sample among 1 g samples: the 5-sample mean (1.016) is inside the gate, so it is
  // still corrected — a per-sample gate would have closed; two of them (mean 1.032) close it
  const spike: Vec3 = [0, 0.4079, -1]; // |a| ≈ 1.08
  const one = gravityFilter([at(1, g0), at(2, g0), at(3, g0), at(4, spike)], state);
  expect(one.state.mags).toHaveLength(GRAVITY_GATE_SAMPLES - 1);
  expect(one.imu[3]!.g).not.toEqual(g0); // corrected toward the spike
  const two = gravityFilter([at(1, g0), at(2, g0), at(3, spike), at(4, spike)], state);
  expect(two.imu[3]!.g).toEqual(two.imu[2]!.g); // gated: the gyro alone (w = 0) carries g
});

test(`the accelerometer is ignored while |‖a‖ − 1| > GRAVITY_GATE_G (${GRAVITY_GATE_G} g)`, () => {
  const g0: Vec3 = [0, 0, -1];
  const { state } = gravityFilter([at(0, g0)], initialGravityState());
  // 0.45 g along y: ‖a‖ = 1.097, gated — gravity does not move at all, ua carries the whole brake
  const { imu } = gravityFilter(Array.from({ length: 100 }, (_, k) => at(k + 1, [0, 0.45, -1])), state);
  for (const s of imu) {
    expect(s.g).toEqual(g0);
    expect(s.ua[1]).toBeCloseTo(0.45, 12);
  }
});

test('the gyro carries gravity through a rotation the low-pass alone would lag', () => {
  // the phone rotates about its x axis at 1 rad/s; true gravity turns the other way in the device frame
  const rate = 1;
  const input: RawImuSample[] = Array.from({ length: 50 }, (_, k) => {
    const th = rate * k * 0.04;
    return at(k, [0, -Math.sin(th), -Math.cos(th)], [rate, 0, 0]);
  });
  const { imu } = gravityFilter(input, initialGravityState());
  const last = imu[49]!;
  const th = rate * 49 * 0.04;
  expect(angle(last.g, [0, -Math.sin(th), -Math.cos(th)])).toBeLessThan(0.02);
});

test('batching does not change the output', () => {
  const batches = gravityRawBatches();
  const whole = gravityFilter(batches.flat(), initialGravityState()).imu;
  let state = initialGravityState();
  const pieces = batches.flatMap((b) => {
    const out = gravityFilter(b, state);
    state = out.state;
    return out.imu;
  });
  expect(pieces).toEqual(whole);
});

test('a gap longer than GRAVITY_RESET_GAP_S re-seeds from the accelerometer', () => {
  const { state } = gravityFilter([at(0, [0, 0, -1])], initialGravityState());
  const { imu } = gravityFilter([{ t: T0 + 1500, a: [0, -1, 0], w: [0, 0, 0] }], state);
  expect(imu[0]!.g).toEqual([0, -1, 0]);
  expect(imu[0]!.ua).toEqual([0, 0, 0]);
});

test('a non-increasing timestamp re-seeds too', () => {
  const { state } = gravityFilter([at(5, [0, 0, -1])], initialGravityState());
  const { imu } = gravityFilter([at(5, [0, -1, 0])], state);
  expect(imu[0]!.g).toEqual([0, -1, 0]);
});

test('the input is not mutated', () => {
  const input = [at(0, [0, 0, -1]), at(1, [0.1, 0, -1], [0.3, 0, 0])];
  const copy = JSON.parse(JSON.stringify(input));
  gravityFilter(input, initialGravityState());
  expect(input).toEqual(copy);
});

describe('through the extractor (N1 fix round: GRAVITY_TAU_S 0.5 → 5 s plus the gate)', () => {
  const PHONE = { locked: true, screenOn: false, appForeground: true };

  /** Raw Android input → gravityFilter → extractSecond, one row per second. */
  function pipeline(seconds: ReturnType<typeof rawDriveSeconds>) {
    let gs = initialGravityState();
    let st = initialExtractState();
    return seconds.map((s) => {
      const f = gravityFilter(s.raw, gs);
      gs = f.state;
      const out = extractSecond(f.imu, s.fix, PHONE, s.tsMs, st);
      st = out.state;
      return { row: out.row, alignment: st.alignment, g: f.imu[f.imu.length - 1]!.g };
    });
  }

  test('a 0.45 g brake held 4 s reads close to 0.45 g throughout, gravity stays steady and the frame holds', () => {
    // align at 0.25 g, cruise 10 s, then brake at 0.45 g from 18.8 s to 22.5 s
    const rows = pipeline(
      rawDriveSeconds({
        seconds: 24,
        seed: 11,
        v0: 5,
        aLon: profile([
          [0, 0],
          [0.3, 0.25],
          [7.5, 0.25],
          [7.8, 0],
          [18.5, 0],
          [18.8, -0.45],
          [22.5, -0.45],
          [22.8, 0],
        ]),
        aLat: () => 0,
      })
    );
    expect(rows[17]!.alignment.aligned).toBe(true);
    // seconds 20–22 lie wholly inside the brake: at 0.5 s the old filter read 0.06 g by the 2nd second
    for (const { row } of rows.slice(19, 22)) {
      expect(row.aLonMin).toBeGreaterThanOrEqual(-0.49);
      expect(row.aLonMin).toBeLessThanOrEqual(-0.41);
      expect(row.aLonMax).toBeGreaterThanOrEqual(-0.49);
      expect(row.aLonMax).toBeLessThanOrEqual(-0.41);
      expect(row.gravityStability).toBeGreaterThan(0.9);
    }
    for (const { alignment } of rows.slice(18, 23)) {
      expect(alignment.aligned).toBe(true);
      expect(alignment.gravityDevS).toBe(0);
    }
  });

  test(`a 0.30 g acceleration held 3 s reads ≥ HARSH_ACCEL_G throughout, and nothing false follows`, () => {
    // align at 0.25 g, cruise 10 s, then 0.30 g from 18.8 s to 21.8 s
    const rows = pipeline(
      rawDriveSeconds({
        seconds: 26,
        seed: 12,
        v0: 5,
        aLon: profile([
          [0, 0],
          [0.3, 0.25],
          [7.5, 0.25],
          [7.8, 0],
          [18.5, 0],
          [18.8, 0.3],
          [21.8, 0.3],
          [22.1, 0],
        ]),
        aLat: () => 0,
      })
    ).map((r) => r.row);
    // The harsh-acceleration detector reads each row's aLonMax against HARSH_ACCEL_G
    // (src/core/detectors/harsh.ts). Every row of the hold (seconds 20–22; the hold ends at 21.8 s)
    // must reach it — with the gate at 0.05 these rows read 0.27, 0.23, 0.20 as gravity absorbed
    // the acceleration. The row minima show there is no decay either: within 0.03 g of 0.30.
    for (const row of rows.slice(19, 22)) expect(row.aLonMax).toBeGreaterThanOrEqual(CONSTANTS.HARSH_ACCEL_G);
    for (const row of rows.slice(19, 21)) expect(row.aLonMin).toBeGreaterThanOrEqual(0.27);
    // after the release (from second 23): no false brake beyond 0.05 g
    for (const row of rows.slice(22)) expect(row.aLonMin).toBeGreaterThanOrEqual(-0.05);
  });

  // N1-r4 M1: over noise seeds 21–28 the 5-sample mean keeps the tilt at 0.007–0.024 rad (a
  // per-sample gate: 0.038–0.059), so < 0.03 rad separates the two on every seed.
  test.each([21, 22, 23, 24, 25, 26, 27, 28])(
    'noise cannot leak a held 0.25 g acceleration into gravity; the brake after it reads true (seed %i)',
    (seed) => {
    // cruise 1 s (true seed), 0.25 g for 7.5 s with 0.01 g accelerometer noise, cruise, then 0.45 g
    // from 10.8 s to 13.5 s. With a per-sample gate about 15 % of the samples opened it and the
    // brake read up to −0.50.
    const out = rawDriveSeconds({
      seconds: 14,
      seed,
      v0: 5,
      accelNoise: 0.01,
      aLon: profile([
        [1, 0],
        [1.3, 0.25],
        [8.5, 0.25],
        [8.8, 0],
        [10.5, 0],
        [10.8, -0.45],
        [13.5, -0.45],
      ]),
      aLat: () => 0,
    });
    const rows = pipeline(out);
    // gravity after 7.5 s of acceleration: within 0.03 rad of the true gravity
    expect(angle(rows[8]!.g, MOUNT_GRAVITY)).toBeLessThan(0.03);
    expect(rows[8]!.alignment.aligned).toBe(true);
    // seconds 12 and 13 lie wholly inside the brake: within 0.03 g of −0.45
    for (const { row } of rows.slice(11, 13)) {
      expect(row.aLonMin).toBeGreaterThanOrEqual(-0.48);
      expect(row.aLonMin).toBeLessThanOrEqual(-0.42);
      expect(row.aLonMax).toBeGreaterThanOrEqual(-0.48);
      expect(row.aLonMax).toBeLessThanOrEqual(-0.42);
    }
    }
  );

  test('a capture that seeds inside a 0.3 g acceleration never reads a harsh brake in the next 30 s (N1-r4 M2)', () => {
    // The automatic start as a car pulls away: the filter seeds on a tilted gravity and the gate
    // then holds that tilt through the cruise. The false brake it produces never trains the frame
    // (alignment needs GNSS Δv ≥ ALIGN_MIN_G on five agreeing updates), so those rows are unaligned
    // — unmeasured — rather than wrong. This pins that safety claim.
    const rows = pipeline(
      rawDriveSeconds({
        seconds: 34,
        seed: 31,
        v0: 3,
        accelNoise: 0.01,
        aLon: profile([
          [0, 0.3],
          [4, 0.3],
          [4.3, 0],
          [10, 0],
          [10.3, -0.2],
          [13, -0.2],
          [13.3, 0],
          [18, 0],
          [18.3, 0.15],
          [22, 0.15],
          [22.3, 0],
          [26, 0],
          [26.3, -0.2],
          [29, -0.2],
          [29.3, 0],
        ]),
        aLat: () => 0,
      })
    ).map((r) => r.row);
    for (const row of rows.slice(0, 30)) expect(row.aLonMin).toBeGreaterThan(-CONSTANTS.HARSH_BRAKE_G);
  });

  test('a real reorientation is still absorbed: the gyro carries it at once', () => {
    const tilt = 0.6;
    const out = rawDriveSeconds({
      seconds: 6,
      seed: 13,
      v0: 10,
      aLon: () => 0,
      aLat: () => 0,
      phone: { axis: [0, 0, 1], theta: profile([[2, 0], [2.5, tilt]]) },
      accelNoise: 0,
      gyroNoise: 0,
    });
    const rows = pipeline(out);
    const before = rows[1]!.g;
    const after = rows[5]!.g;
    // turning 0.6 rad about device z (not perpendicular to gravity in this mount) moves gravity ~0.54 rad
    expect(angle(before, after)).toBeGreaterThan(0.5);
    // the estimate matches the accelerometer (the true gravity at rest) once the phone has settled
    const last = out[5]!.raw[24]!.a;
    expect(angle(after, last)).toBeLessThan(0.02);
  });

  test('…and one the gyro missed is pulled in by the accelerometer within 3·GRAVITY_TAU_S', () => {
    // the estimate is 0.3 rad off the (static, 1 g) accelerometer and nothing rotates
    const truth: Vec3 = [0, -Math.sin(0.3), -Math.cos(0.3)];
    const { state } = gravityFilter([at(0, [0, 0, -1])], initialGravityState());
    const n = 25 * 3 * GRAVITY_TAU_S;
    const { imu } = gravityFilter(Array.from({ length: n }, (_, k) => at(k + 1, truth)), state);
    expect(angle(imu[n - 1]!.g, truth)).toBeLessThan(0.3 * 0.06);
  });
});
