import { CONSTANTS } from '@scoring';

import type { AlertDecision, AlertKind, AlertLevel, AlertVoiceKey } from '@/core/alerts/types';
import { limitActionable } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import { t } from '@/i18n';

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
 * Past the tolerance over a limit the sign itself would show, on a speed the readout itself would
 * show. Instantaneous: this is the readout's state (C3), not the arbiter's alert (§13.4).
 *
 * Judged on the RAW m/s values, not the rounded numerals — deliberately. It is the same comparison
 * the speeding detector and arbiter make (`speed − limit > SPEEDING_TOLERANCE_MPS`), so the readout
 * turns red exactly when the app would count the second as speeding. The cost is that the numerals
 * can read, say, "40" against "35" while red (40.4 mph). Do not "fix" this to rounded values: the HUD
 * would then disagree with the alert.
 */
export function hudSpeeding(
  speedMps: number,
  speedKnown: boolean,
  limit: LimitSample | null
): boolean {
  if (hudSpeedMph(speedMps, speedKnown) === null) return false;
  if (hudLimitMph(limit, speedKnown) === null) return false;
  return speedMps - (limit!.limitMps as number) > CONSTANTS.SPEEDING_TOLERANCE_MPS;
}

// --- overlay words (SR3: no text longer than 3 words on the HUD while moving) -------------------

export const HUD_MAX_WORDS = 3;

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Each kind's own short phrase, used when a decision's phrase is absent, not an alert or too long. */
const KIND_WORDS: Record<AlertKind, Record<AlertLevel, AlertVoiceKey>> = {
  speeding: { 1: 'alert.easeOff', 2: 'alert.easeOff', 3: 'alert.slowDown' },
  phone: { 1: 'alert.phoneDown', 2: 'alert.phoneDown', 3: 'alert.phoneDown' },
  eyes_off: { 1: 'alert.eyesUp', 2: 'alert.eyesUp', 3: 'alert.eyesUp' },
  drowsy: { 1: 'alert.drowsy', 2: 'alert.drowsy', 3: 'alert.drowsy' },
  break: { 1: 'alert.drowsy', 2: 'alert.drowsy', 3: 'alert.drowsy' },
};

/** Not alert phrases: the drive-start confirmation is spoken, never an overlay label. */
const NOT_ALERT_WORDS: ReadonlySet<AlertVoiceKey> = new Set(['alert.recording']);

/** The words an L2/L3 overlay prints: the decision's own phrase when it fits in three words. */
export function overlayWords(decision: Pick<AlertDecision, 'kind' | 'level' | 'voice'>): string {
  const own = decision.voice;
  if (own && !NOT_ALERT_WORDS.has(own)) {
    const words = t(own);
    if (countWords(words) <= HUD_MAX_WORDS) return words;
  }
  return t(KIND_WORDS[decision.kind][decision.level]);
}
