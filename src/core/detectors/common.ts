// Small pure helpers every detector shares. Nothing here touches the platform.
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, DetectorContext, FeatureRow, LimitSample } from '../engine/types';

/** Standard gravity, m/s²: turns a GNSS Δspeed over a second into g for the IMU comparison. */
export const G_MPS2 = 9.80665;

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
 * Null is "unknown", which proves neither motion nor stillness — the detectors, the session
 * accumulators and the engine's own clocks all leave their state alone on such a row.
 */
export function knownSpeed(row: FeatureRow): number | null {
  return row.gnssValid && row.speed >= 0 ? row.speed : null;
}

/** Below `Q_UNSCORED_BELOW` an event is only "possible": logged for the summary, never scored (§9.4). */
export function statusFor(q: number): DetectedEvent['status'] {
  return q < CONSTANTS.Q_UNSCORED_BELOW ? 'possible' : 'scored';
}

/** Only events we would score in full are worth an in-drive alert (§9.5, `Q_FULL_AT`). */
export function alertableFor(status: DetectedEvent['status'], q: number): boolean {
  return status === 'scored' && q >= CONSTANTS.Q_FULL_AT;
}

export function contextOf(ctx: DetectorContext): DetectedEvent['context'] {
  return { night: ctx.night, precipitation: ctx.precipitation };
}

// --- speeding confidence (§9.5) --------------------------------------------------------------
// Shared by the speeding detector and the engine's arbiter feed, so an alert is only ever
// considered for an episode the detector would score in full.

/** Speed-limit source confidence. */
export const LIMIT_Q = { posted: 0.9, cached: 0.8, statutory: 0.7 } as const;
/** Parallel roads or a weak map match: the limit may belong to the road next door. */
export const LIMIT_Q_AMBIGUOUS = 0.6;
export const MATCH_CONFIDENCE_MIN = 0.7;
/** A fix looser than either bound caps the whole speeding episode at `GNSS_CAP_Q` — unscored. */
export const H_ACC_MAX_M = 20;
export const SPEED_ACC_MAX_MPS = 2;
export const GNSS_CAP_Q = 0.4;

/** Confidence in the limit itself, or null when there is no usable limit. */
export function limitConfidence(limit: LimitSample): number | null {
  if (limit.source === 'unknown' || limit.limitMps === null) return null;
  const base = LIMIT_Q[limit.source];
  const ambiguous = limit.parallelRoads || limit.matchConfidence < MATCH_CONFIDENCE_MIN;
  return ambiguous ? Math.min(base, LIMIT_Q_AMBIGUOUS) : base;
}

/**
 * THE line between a limit the app acts on and one it does not: the limit's own confidence
 * reaches `Q_FULL_AT`. The speeding detector alerts (via `alertableFor`) and the machine's
 * `rowQuality` feeds the arbiter at full weight exactly on this side of it, and the HUD's limit
 * sign shows a limit exactly when this holds (with a current fix) — so the sign never hides a
 * limit the app alerts or scores against, nor shows one it ignores (Ruling U1-I1). Change the
 * line here, not in a caller. A good GNSS fix is a separate condition the callers add.
 */
export function limitActionable(limit: LimitSample): boolean {
  return (limitConfidence(limit) ?? 0) >= CONSTANTS.Q_FULL_AT;
}

/** The fix is too loose to accuse anyone of a precise speed. */
export function gnssPoor(row: FeatureRow): boolean {
  return row.hAcc > H_ACC_MAX_M || row.speedAcc > SPEED_ACC_MAX_MPS;
}
