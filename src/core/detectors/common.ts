// Small pure helpers every detector shares. Nothing here touches the platform.
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, DetectorContext, FeatureRow, LimitSample } from '../engine/types';

/** Standard gravity, m/s²: turns a GNSS Δspeed over a second into g for the IMU comparison. */
export const G_MPS2 = 9.80665;

/** Row spacing at 1 Hz; an episode ends one row after its last row. */
export const ROW_MS = 1000;

/** A GNSS speed the detectors may reason about: the fix is valid and the speed is not the -1 sentinel. */
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

/** The fix is too loose to accuse anyone of a precise speed. */
export function gnssPoor(row: FeatureRow): boolean {
  return row.hAcc > H_ACC_MAX_M || row.speedAcc > SPEED_ACC_MAX_MPS;
}
