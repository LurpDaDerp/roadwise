// Small pure helpers every detector shares. Nothing here touches the platform.
import { MAX_H_ACC_M, NO_EVENTS_FIRST_S } from '@scoring';

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

/** The row's speed in mph, or null when unknown. */
export function knownSpeedMph(row: FeatureRow): number | null {
  const s = knownSpeed(row);
  return s === null ? null : mph(s);
}

/** A map match this weak (or beside a parallel road) may belong to the road next door. */
export const MATCH_CONFIDENCE_MIN = 0.7;

/**
 * THE line between a limit the app acts on and one it does not: a known limit from a real source
 * with a confident, unambiguous match. The HUD's limit sign shows a limit exactly when this holds
 * (with a current fix), and the speeding detector records events against exactly these limits.
 */
export function limitActionable(limit: LimitSample): boolean {
  if (limit.source === 'unknown' || limit.limitMps === null) return false;
  return !limit.parallelRoads && limit.matchConfidence >= MATCH_CONFIDENCE_MIN;
}

/** GPS accuracy worse than `MAX_H_ACC_M` (spec): the limit shows "—" and no event is recorded. */
export function gnssPoor(row: FeatureRow): boolean {
  return !row.gnssValid || !(row.hAcc <= MAX_H_ACC_M);
}

/**
 * The posted limit in whole mph the row may be judged against, or null: unknown, low-confidence,
 * or a poor fix (spec "Speed limit data").
 */
export function limitMphFor(row: FeatureRow, limit: LimitSample): number | null {
  if (gnssPoor(row) || !limitActionable(limit) || limit.limitMps === null) return null;
  const v = Math.round(mph(limit.limitMps));
  return v > 0 ? v : null;
}

/** No events in the first `NO_EVENTS_FIRST_S` of a drive (spec "Rules against false positives"). */
export function inWarmup(row: FeatureRow, ctx: DetectorContext): boolean {
  return row.ts - ctx.tripStartedAt < NO_EVENTS_FIRST_S * 1000;
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
