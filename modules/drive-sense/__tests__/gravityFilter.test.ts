/** @jest-environment node */
// The Android complementary gravity filter (R1): gyro propagation + an accelerometer low-pass with
// time constant GRAVITY_TAU_S, in the reference sign convention.
import { G_MPS2, GRAVITY_TAU_S } from '../src/extract/constants';
import {
  androidAccelToReference,
  gravityFilter,
  initialGravityState,
} from '../src/extract/gravityFilter';
import type { RawImuSample } from '../src/extract/types';
import { angle, norm, sub, type Vec3 } from '../src/extract/vec';
import { gravityRawBatches, T0 } from '../scripts/scenarios';

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
  expect(state).toEqual({ g: [0.1, -0.9, -0.4], t: T0 });
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
  const input = [at(0, [0.3, 0, -0.95]), ...Array.from({ length: 50 }, (_, k) => at(k + 1, truth))];
  const { imu } = gravityFilter(input, initialGravityState());
  const err0 = norm(sub(imu[0]!.g, truth));
  const err1s = norm(sub(imu[25]!.g, truth));
  const alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + 0.04);
  expect(err1s / err0).toBeCloseTo(alpha ** 25, 9);
  expect(norm(sub(imu[50]!.g, truth))).toBeLessThan(0.03 * err0);
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
