import { CONSTANTS } from '@scoring';

import type { AlertDecision, AlertKind, AlertLevel, AlertVoiceKey } from '@/core/alerts/types';
import { limitConfidence } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import { t } from '@/i18n';

/**
 * The one place the HUD decides what it may display (§13.2: unknown is "—", never a stale or
 * guessed value). Components take the raw snapshot fields — `speedMps`, `speedKnown`, `limit` —
 * and call these, so no caller can put a number on the HUD that the data does not support.
 */

/**
 * Controller ruling (S1 review): the limit sign shows a limit only at the confidence that gates
 * alerts and scoring. Ramp and parallel-road matches come back at 0.6–0.65; without the gate a
 * motorway exit would flash the ramp's 35 at a driver doing 60.
 */
export const HUD_LIMIT_CONFIDENCE_MIN = CONSTANTS.Q_FULL_AT;

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
 * - the source is real (not `unknown`) with a positive finite limit;
 * - the map match is at least `HUD_LIMIT_CONFIDENCE_MIN`; and
 * - the limit's own confidence (§9.5: source, parallel roads) reaches it too — so a statutory
 *   default or a road-next-door ambiguity never shows, exactly as it never alerts.
 */
export function hudLimitMph(limit: LimitSample | null, speedKnown: boolean): number | null {
  if (!speedKnown || !limit) return null;
  const { limitMps } = limit;
  if (limit.source === 'unknown' || limitMps === null) return null;
  if (!Number.isFinite(limitMps) || limitMps <= 0) return null;
  if (!(limit.matchConfidence >= HUD_LIMIT_CONFIDENCE_MIN)) return null;
  const q = limitConfidence(limit);
  if (q === null || q < HUD_LIMIT_CONFIDENCE_MIN) return null;
  return Math.round(limitMps / MPS_PER_MPH);
}

/**
 * Past the tolerance over a limit the sign itself would show, on a speed the readout itself would
 * show. Instantaneous: this is the readout's state (C3), not the arbiter's alert (§13.4).
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
