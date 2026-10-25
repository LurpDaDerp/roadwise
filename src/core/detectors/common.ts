// Small pure helpers every detector shares. Nothing here touches the platform.
import { MAX_H_ACC_M, PHONE_PICKUP_MIN_MPH } from '@scoring';

import type { DetectorContext, FeatureRow, LimitSample } from '../engine/types';

/** Standard gravity, m/s²: turns a GNSS Δspeed over a second into g for the IMU comparison. */
export const G_MPS2 = 9.80665;
export const MPS_PER_MPH = 0.44704;
export const mph = (mps: number): number => mps / MPS_PER_MPH;

/**
 * Row spacing at 1 Hz. A row covers the second starting at its `ts`, so an episode — or a trip —
 * ends one row-length after its last row.
 */
export const ROW_MS = 1000;

/** Nothing known about the limit: what a row is judged against when no lookup answered. */
export const UNKNOWN_LIMIT: LimitSample = Object.freeze({
  limitMps: null,
  source: 'unknown',
  matchConfidence: 0,
  parallelRoads: false,
});

/**
 * A GNSS speed anyone may reason about: the fix is valid and the speed is not the -1 sentinel.
 * Null is "unknown", which proves neither motion nor stillness.
 */
export function knownSpeed(row: FeatureRow): number | null {
  return row.gnssValid && row.speed >= 0 ? row.speed : null;
}

/** A GPS speed accuracy (m/s) worse than this does not let a speed decide anything that needs trust. */
export const SPEED_ACC_MAX_MPS = 2;

/**
 * The speed's own accuracy is good enough to trust it: 2 m/s or better, or not reported at all
 * (`-1`, a phone that gives no speed accuracy).
 */
export function speedTrusted(row: FeatureRow): boolean {
  return row.speedAcc === -1 || (row.speedAcc >= 0 && row.speedAcc <= SPEED_ACC_MAX_MPS);
}

/**
 * Driving speed, for phone use (phone plan P1): a known, trusted GPS speed of `PHONE_PICKUP_MIN_MPH`
 * (10 mph) or more, the same line as the drive's own driving speed (`session.drivingRow`).
 */
export function atDrivingSpeed(row: FeatureRow): boolean {
  const s = knownSpeed(row);
  return s !== null && speedTrusted(row) && s >= PHONE_PICKUP_MIN_MPH * MPS_PER_MPH;
}

/**
 * A second a phone pickup could have been seen in (phone plan P1, P2): the motion sensors reported
 * (not `imuAbsent`), and on iPhone no call was on (iOS cannot tell hands-free from handheld, so a
 * call row is never phone use). Android motion is never suppressed by a call.
 */
export function phoneWatchable(row: FeatureRow, platform: 'ios' | 'android'): boolean {
  return !imuAbsent(row) && !(platform === 'ios' && row.call !== undefined);
}

/** The IMU-absent encoding (drive-sense README §4): all nine IMU fields 0. Evidence of nothing. */
export function imuAbsent(row: FeatureRow): boolean {
  return (
    row.aLonMax === 0 &&
    row.aLonMin === 0 &&
    row.aLatMax === 0 &&
    row.aLatMin === 0 &&
    row.yawRateMax === 0 &&
    row.jerkMax === 0 &&
    row.gravityStability === 0 &&
    row.orientationDelta === 0 &&
    row.handlingScore === 0
  );
}

/** The row's speed in mph, or null when unknown. */
export function knownSpeedMph(row: FeatureRow): number | null {
  const s = knownSpeed(row);
  return s === null ? null : mph(s);
}

/** A map match this weak (or beside a parallel road) may belong to the road next door. */
export const MATCH_CONFIDENCE_MIN = 0.7;

/** A known limit on a confident, unambiguous match, whatever its source. */
function limitConfident(limit: LimitSample): boolean {
  if (limit.source === 'unknown' || limit.limitMps === null) return false;
  return !limit.parallelRoads && limit.matchConfidence >= MATCH_CONFIDENCE_MIN;
}

/**
 * THE line between a limit the app acts on and one it does not: a posted limit (open data or the
 * cache, never a road class's `statutory` default) with a confident, unambiguous match. The speeding
 * detector records events against exactly these limits. The sign shows them too, and also a
 * confident default (`limitShown`): a default can be wrong, so it is shown, never scored.
 */
export function limitActionable(limit: LimitSample): boolean {
  return limit.source !== 'statutory' && limitConfident(limit);
}

/** The limits the sign prints: every actionable limit, plus a confident road-class default. */
export function limitShown(limit: LimitSample): boolean {
  return limitConfident(limit);
}

/** GPS accuracy worse than `MAX_H_ACC_M` (spec): the limit shows "—" and no event is recorded. */
export function gnssPoor(row: FeatureRow): boolean {
  return !row.gnssValid || !(row.hAcc <= MAX_H_ACC_M);
}

const wholeMph = (limit: LimitSample): number | null => {
  if (limit.limitMps === null) return null;
  const v = Math.round(mph(limit.limitMps));
  return v > 0 ? v : null;
};

/**
 * The posted limit in whole mph the row may be judged against, or null: unknown, a class default,
 * low-confidence, or a poor fix (spec "Speed limit data").
 */
export function limitMphFor(row: FeatureRow, limit: LimitSample): number | null {
  if (gnssPoor(row) || !limitActionable(limit)) return null;
  return wholeMph(limit);
}

/**
 * The sign's own GPS gate (m), display only: a valid fix this accurate or better prints the lookup's
 * limit. Looser than `MAX_H_ACC_M` (20 m), which still gates every detector and score, because
 * downtown fixes often sit at 20 to 30 m and the sign went blank there.
 */
export const SIGN_MAX_H_ACC_M = 30;

/**
 * The limit in whole mph the sign prints for the row, or null for "—": every limit `limitMphFor`
 * judges by, plus confident defaults, on a valid fix within `SIGN_MAX_H_ACC_M` (display only).
 */
export function limitShownMph(row: FeatureRow, limit: LimitSample): number | null {
  if (!row.gnssValid || !(row.hAcc <= SIGN_MAX_H_ACC_M) || !limitShown(limit)) return null;
  return wholeMph(limit);
}

/** No events before the drive's warm-up ends (spec "Rules against false positives"; `session.noteWarmup`). */
export function inWarmup(row: FeatureRow, ctx: DetectorContext): boolean {
  return row.ts < ctx.warmupEndsAt;
}

/** Whether a row may start or extend an event at all: past the warm-up and on a usable fix. */
export function rowEligible(row: FeatureRow, ctx: DetectorContext): boolean {
  return !inWarmup(row, ctx) && !gnssPoor(row);
}

/** A phone that is mounted and still: a steady gravity vector and no orientation change. */
export const MOUNT_GRAVITY_MIN = 0.9;
export const MOUNT_ORIENTATION_MAX_RAD = 0.1;
export function mountedStable(row: FeatureRow): boolean {
  return row.gravityStability >= MOUNT_GRAVITY_MIN && row.orientationDelta <= MOUNT_ORIENTATION_MAX_RAD;
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round2 = (v: number): number => Math.round(v * 100) / 100;
