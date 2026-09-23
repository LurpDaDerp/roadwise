// The 1 Hz row seam (plan Task 14, rev2 R1-m1, R-8): the drive engine's own FeatureRow → the engine's
// row and extras, and the capture policy's row. IMU motion is the drive engine's ¬stillWithoutFix: one
// definition, never a copy.
import type { FeatureRow } from '@/core/engine/types';
import type { FeatureRowLike } from '../../engine/context';
import { policyRow, rowExtras } from '../rowContext';

const ROW: FeatureRow = {
  ts: 1_760_000_000_000,
  lat: 51.5,
  lng: -0.1,
  hAcc: 5,
  speed: 20,
  speedAcc: 0.5,
  course: 90,
  alt: 10,
  gnssValid: true,
  aLonMax: 0.1,
  aLonMin: -0.1,
  aLatMax: 0.05,
  aLatMin: -0.05,
  yawRateMax: 0.02,
  jerkMax: 0.1,
  gravityStability: 0.97,
  orientationDelta: 0.01,
  handlingScore: 0,
  locked: true,
  screenOn: true,
  appForeground: true,
};

test('FeatureRowLike is assignable from FeatureRow (a type test: the engine reads a subset of the real row)', () => {
  const like: FeatureRowLike = ROW;
  expect(like.speed).toBe(20);
});

describe('imuMoving is the drive engine’s own ¬stillWithoutFix (rev2 R1-m1)', () => {
  const still: FeatureRow = { ...ROW, gnssValid: false, speed: -1, gravityStability: 0.99, aLonMax: 0.01, aLonMin: -0.01, aLatMax: 0.01, aLatMin: -0.01, yawRateMax: 0.01, jerkMax: 0.01 };
  test('a still phone with no fix → not moving', () => {
    expect(rowExtras(still, { localMinutes: 600 }, 30).imuMoving).toBe(false);
  });
  test('a vibrating phone with no fix → moving', () => {
    expect(rowExtras({ ...still, aLonMax: 0.2, jerkMax: 0.3 }, { localMinutes: 600 }, 30).imuMoving).toBe(true);
  });
  test('an IMU-absent row (every IMU field 0) → moving, as the drive engine treats it', () => {
    const absent: FeatureRow = { ...still, aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };
    expect(rowExtras(absent, { localMinutes: 600 }, 30).imuMoving).toBe(true);
  });
  test('a fix → moving (the predicate is about rows without one)', () => {
    expect(rowExtras({ ...still, gnssValid: true, speed: 0 }, { localMinutes: 600 }, 30).imuMoving).toBe(true);
  });
});

describe('the extras and the policy row', () => {
  test('rowExtras carries the local time (null when unknown, never 0) and the trip time', () => {
    expect(rowExtras(ROW, { localMinutes: null }, 42)).toEqual({ imuMoving: true, localMinutes: null, tripElapsedS: 42 });
    expect(rowExtras(ROW, { localMinutes: 75 }, 42).localMinutes).toBe(75);
  });
  test('policyRow: a known km/h; unknown (null) with no fix or a negative speed; handling at 0.6', () => {
    expect(policyRow(ROW)).toEqual({ tMs: ROW.ts, speedKmh: 72, imuMoving: true, handling: false });
    expect(policyRow({ ...ROW, gnssValid: false }).speedKmh).toBeNull();
    expect(policyRow({ ...ROW, speed: -1 }).speedKmh).toBeNull();
    expect(policyRow({ ...ROW, handlingScore: 0.6 }).handling).toBe(true);
    expect(policyRow({ ...ROW, handlingScore: 0.59 }).handling).toBe(false);
  });
});
