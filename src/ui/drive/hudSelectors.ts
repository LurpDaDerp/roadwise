import { CONSTANTS } from '@scoring';

import type { AlertLevel } from '@/core/alerts/types';
import { limitActionable } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';

import type { HaloLevel } from './hudTokens';

/**
 * The one place the HUD decides what it may display (§13.2: unknown is "—", never a stale or
 * guessed value). Components take the raw snapshot fields — `speedMps`, `speedKnown`, `limit` —
 * and call these, so no caller can put a number on the HUD that the data does not support.
 */

const MPS_PER_MPH = CONSTANTS.MPH;

/** Whole mph, or null ("—") unless the CURRENT row has a known speed. Never 0 for unknown. */
export function hudSpeedMph(speedMps: number, speedKnown: boolean): number | null {
  if (!speedKnown || !Number.isFinite(speedMps) || speedMps < 0) return null;
  return Math.round(speedMps / MPS_PER_MPH);
}

/**
 * The limit to print on the sign in whole mph, or null ("—"). Shown only when:
 * - there is a current fix (`speedKnown`) — without one there is no current road, and the snapshot's
 *   limit belongs to wherever the fix was lost;
 * - the limit is a positive finite number; and
 * - `limitActionable(limit)` holds — the one predicate that also decides whether the app alerts and
 *   scores in full against this limit (common.ts, Ruling U1-I1). So the sign shows exactly the
 *   limits the app acts on: a cached (AWS) or HPMS-filled limit that can trigger "Slow down" is on
 *   the sign, while ramp, parallel-road and truncated-tile matches (under the matcher's 0.7) and a
 *   statutory default are "—", exactly as they never alert. Never add a second threshold here —
 *   the cross-seam test (`limitGateSeam.test.ts`) fails if this gate and the alert gate drift.
 */
export function hudLimitMph(limit: LimitSample | null, speedKnown: boolean): number | null {
  if (!speedKnown || !limit) return null;
  const { limitMps } = limit;
  if (limitMps === null || !Number.isFinite(limitMps) || limitMps <= 0) return null;
  if (!limitActionable(limit)) return null;
  return Math.round(limitMps / MPS_PER_MPH);
}

/**
 * m/s over a limit the sign itself would show, on a speed the readout itself would show — negative
 * under it; null when either is "—". Judged on the RAW m/s values, not the rounded numerals,
 * deliberately: it is the same comparison the speeding detector and arbiter make, so the halo
 * shifts colour exactly when the app would count the second as speeding.
 */
export function overLimitMps(
  speedMps: number,
  speedKnown: boolean,
  limit: LimitSample | null
): number | null {
  if (hudSpeedMph(speedMps, speedKnown) === null) return null;
  if (hudLimitMph(limit, speedKnown) === null) return null;
  return speedMps - (limit!.limitMps as number);
}

/**
 * Past the tolerance over a limit the sign would show. Instantaneous: this is the readout's state
 * (C3), not the arbiter's alert (§13.4). The numerals can read, say, "40" against "35" while
 * amber (40.4 mph); do not "fix" this to rounded values: the HUD would then disagree with the alert.
 */
export function hudSpeeding(
  speedMps: number,
  speedKnown: boolean,
  limit: LimitSample | null
): boolean {
  const over = overLimitMps(speedMps, speedKnown, limit);
  return over !== null && over > CONSTANTS.SPEEDING_TOLERANCE_MPS;
}

// --- the status halo -----------------------------------------------------------------------------

/** Well over: the tolerance plus 10 mph (16 km/h) makes the halo critical without waiting for L3. */
export const HALO_CRITICAL_OVER_MPS = CONSTANTS.SPEEDING_TOLERANCE_MPS + 10 * MPS_PER_MPH;
/** A harsh event (braking, acceleration, cornering) keeps the halo on attention this long. */
export const HARSH_RECENT_MS = 10_000;

export interface HaloInput {
  /** `overLimitMps`: m/s over the shown limit, or null when there is no speed or limit to judge. */
  overMps: number | null;
  /** The level of the alert now showing, or null. */
  alertLevel: AlertLevel | null;
  /** Milliseconds since the last harsh event, or null when there was none this trip. */
  harshAgeMs: number | null;
}

/**
 * The status halo (and the numerals' colour), from the three things that can unsettle a drive.
 * Critical: an urgent (L3) alert, or speeding well over. Attention: any other alert, a harsh event
 * in the last `HARSH_RECENT_MS`, or over the tolerance. Calm otherwise.
 */
export function haloLevel(i: HaloInput): HaloLevel {
  if (i.alertLevel === 3) return 'critical';
  if (i.overMps !== null && i.overMps >= HALO_CRITICAL_OVER_MPS) return 'critical';
  if (i.alertLevel === 1 || i.alertLevel === 2) return 'attention';
  if (i.harshAgeMs !== null && i.harshAgeMs >= 0 && i.harshAgeMs < HARSH_RECENT_MS) {
    return 'attention';
  }
  if (i.overMps !== null && i.overMps > CONSTANTS.SPEEDING_TOLERANCE_MPS) return 'attention';
  return 'calm';
}

// --- words (SR3: no text longer than 3 words on the HUD while moving) ------------------------------

export const HUD_MAX_WORDS = 3;

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
