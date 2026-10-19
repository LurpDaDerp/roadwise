// The speed the driving screen shows (product spec v3 "Driving screen"). Display only: nothing
// scores, stops or ends a drive on it; `stopped`, the lockout and every detector read the raw fix.
//
// One estimate per row, from the row's GPS speed and the forward acceleration around it:
// - The acceleration is the mean of this second's forward extremes (`aLonMax`/`aLonMin`, once the
//   phone has learned the car's forward axis) and the change since the last fix, whichever are
//   known; under `ACCEL_DEADBAND_MPS2` it is cruising (0), so the number never wanders at a steady
//   speed.
// - S1: a fix is about `FIX_LEAD_S` old when its row lands, so the shown speed leads it by that much
//   along the acceleration. The screen then carries it on along the same acceleration between rows.
// - S2: under 1 mph it is 0. Under 3 mph it is 0 while the speed is below its own accuracy rating,
//   while the car is still (aligned and the forward acceleration within `STILL_LON_G` all second),
//   or while it already shows 0 and the IMU does not say the car is pulling away (`LEAVE_ZERO_MPS2`;
//   GPS drift jumps, so its change alone never leaves 0). A lead that
//   lands under 1 mph is 0 too, so a car slowing to a stop reads 0.
// - S3: a row that lost its fix keeps the last shown speed, flat, while that is `SPEED_HOLD_MS` old
//   or less; then there is none ("—").
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
/** S1: a fix's age when its row lands, roughly (the row's window and the settle wait). */
export const FIX_LEAD_S = 0.5;
/** Under this the car is cruising: no lead, no carry. */
export const ACCEL_DEADBAND_MPS2 = 0.3;
/** Never trust more than this (a hard stop is about 8 m/s²). */
export const ACCEL_MAX_MPS2 = 8;
/** The change since the last fix counts only when that fix is this recent. */
const GPS_ACCEL_MAX_GAP_MS = 2_500;
/** S3: a row that lost its fix holds the last shown speed while that is this recent (row clock). */
export const SPEED_HOLD_MS = 3_000;

export type DisplaySpeed = {
  /** The speed to show, m/s, as of the row. */
  mps: number;
  /** The acceleration to carry it on with until the next row, m/s² (0 while held or shown as 0). */
  accel: number;
  /** It shows 0 for S2 (the hysteresis reads it). */
  zero: boolean;
  /** The last row with a fix, and its raw speed. */
  fixTs: number;
  fixMps: number;
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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
 * The next estimate from `prev` and a row whose known speed is `known` (m/s; null when the row lost
 * its fix). Null when there is nothing to show.
 */
export function nextDisplaySpeed(prev: DisplaySpeed | null, row: FeatureRow, known: number | null): DisplaySpeed | null {
  if (known === null) {
    if (prev === null || row.ts - prev.fixTs > SPEED_HOLD_MS) return null;
    return { ...prev, accel: 0 };
  }
  const v = Math.max(0, known);
  const gap = prev === null ? Infinity : row.ts - prev.fixTs;
  const gps = prev !== null && gap > 0 && gap <= GPS_ACCEL_MAX_GAP_MS ? (v - prev.fixMps) / (gap / 1000) : null;
  const imu = imuAccel(row);
  const raw = imu !== null && gps !== null ? (imu + gps) / 2 : (imu ?? gps ?? 0);
  const a = Math.abs(raw) < ACCEL_DEADBAND_MPS2 ? 0 : clamp(raw, -ACCEL_MAX_MPS2, ACCEL_MAX_MPS2);
  const wasZero = prev === null || prev.zero;
  const rated = row.speedAcc >= 0 && v < row.speedAcc;
  const pullingAway = imu !== null && imu >= LEAVE_ZERO_MPS2;
  const zeroed = v < ZERO_MPS || (v < STOP_DISPLAY_MAX_MPS && (rated || still(row) || (wasZero && !pullingAway)));
  const lead = zeroed ? 0 : Math.max(0, v + a * FIX_LEAD_S);
  const zero = zeroed || lead < ZERO_MPS;
  return { mps: zero ? 0 : lead, accel: zero ? 0 : a, zero, fixTs: row.ts, fixMps: v };
}

/**
 * The speed carried on `elapsedMs` after its row (m/s), for the screen between rows: along the
 * row's acceleration for at most `maxMs`, never below 0, and 0 once a slowing car drops under 1 mph.
 */
export function carriedSpeed(mps: number, accel: number, elapsedMs: number, maxMs: number): number {
  if (mps <= 0 || accel === 0) return mps;
  const v = mps + (accel * Math.min(Math.max(0, elapsedMs), maxMs)) / 1000;
  return accel < 0 && v < ZERO_MPS ? 0 : Math.max(0, v);
}
