// Small pure helpers every detector shares. Nothing here touches the platform.
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, DetectorContext, FeatureRow } from '../engine/types';

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
