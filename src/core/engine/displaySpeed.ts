// The speed the driving screen shows (product spec v3 "Driving screen"). Display only: nothing
// scores, stops or ends a drive on it; `stopped`, the lockout and every detector read the raw fix.
//
// One value per row, so the number moves on once a second:
// - S1: the row's GPS speed as it is.
// - S2: under 1 mph it is 0. Under 3 mph it is 0 while the speed is below its own accuracy rating,
//   while the car is still (aligned and the forward acceleration within `STILL_LON_G` all second),
//   or while it already shows 0 and the IMU does not say the car is pulling away (`LEAVE_ZERO_MPS2`;
//   GPS drift jumps, so its change alone never leaves 0).
// - S3: a row that lost its fix keeps the last shown speed while that is `SPEED_HOLD_MS` old or
//   less. Past that it shows 0 when the car is still or already showed 0 (a parked phone often
//   stops reporting a speed at all), and otherwise keeps holding the last speed. Before the first
//   fix it is 0. The screen never shows "—" for the speed.
import type { FeatureRow } from './types';

import { MPS_PER_MPH } from '@/core/detectors/common';

const G_MPS2 = 9.80665;

/** S2: always 0 under this. */
export const ZERO_MPS = 1 * MPS_PER_MPH;
/** S2: never zeroed for accuracy, stillness or hysteresis at or above this. */
export const STOP_DISPLAY_MAX_MPS = 3 * MPS_PER_MPH;
/** S2: a car showing 0 under 3 mph shows its speed only while the IMU reads it accelerating at least this hard. */
export const LEAVE_ZERO_MPS2 = 0.3;
/** S2: still when the aligned forward acceleration stays within ± this all second (g). */
export const STILL_LON_G = 0.02;
/** S3: a row that lost its fix holds the last shown speed unconditionally while that is this recent (row clock). */
export const SPEED_HOLD_MS = 3_000;

export type DisplaySpeed = {
  /** The speed to show, m/s, as of the row. */
  mps: number;
  /** It shows 0 for S2 (the hysteresis reads it). */
  zero: boolean;
  /** The last row with a fix. */
  fixTs: number;
};

/** This second's mean forward acceleration from the IMU (m/s²), or null before the axis is learned. */
function imuAccel(row: FeatureRow): number | null {
  if (row.aLonMax === 0 && row.aLonMin === 0) return null;
  return ((row.aLonMax + row.aLonMin) / 2) * G_MPS2;
}

/** Still: the axis is learned and the forward acceleration stayed near 0 all second. */
function still(row: FeatureRow): boolean {
  if (row.aLonMax === 0 && row.aLonMin === 0) return false;
  return Math.max(Math.abs(row.aLonMax), Math.abs(row.aLonMin)) < STILL_LON_G;
}

/**
 * The next value from `prev` (null before the first row) and a row whose known speed is `known`
 * (m/s; null when the row lost its fix). There is always a value: no fix yet is 0.
 */
export function nextDisplaySpeed(prev: DisplaySpeed | null, row: FeatureRow, known: number | null): DisplaySpeed {
  if (known === null) {
    if (prev === null) return { mps: 0, zero: true, fixTs: row.ts };
    if (row.ts - prev.fixTs <= SPEED_HOLD_MS || (!prev.zero && !still(row))) return prev;
    return prev.zero ? prev : { mps: 0, zero: true, fixTs: prev.fixTs };
  }
  const v = Math.max(0, known);
  const wasZero = prev === null || prev.zero;
  const rated = row.speedAcc >= 0 && v < row.speedAcc;
  const imu = imuAccel(row);
  const pullingAway = imu !== null && imu >= LEAVE_ZERO_MPS2;
  const zero = v < ZERO_MPS || (v < STOP_DISPLAY_MAX_MPS && (rated || still(row) || (wasZero && !pullingAway)));
  return { mps: zero ? 0 : v, zero, fixTs: row.ts };
}
