// What each v3 event sounds like (product spec v3 "Driving screen"): a distinct tone per category,
// an optional short voice line, and a haptic. Speeding gets the soft chime once per episode (the
// edge glow carries the tier); harsh driving the warning tone; a phone pickup the urgent one.
// The two DashPal types are never raised by the phone's engine (the dashcam alerts on its own and
// through `src/dashcam`); their entries keep the maps exhaustive and name their level and words.
import type { EventType, Tier } from '@scoring';

import type { AlertEvent } from '@/core/engine/engine.types';

import type { AlertDecision, AlertLevel, HapticIntensity } from './types';

export const ALERT_LEVEL: Readonly<Record<EventType, AlertLevel>> = {
  speeding: 1,
  hard_brake: 2,
  hard_accel: 2,
  hard_corner: 2,
  phone_pickup: 3,
  phone_handling: 2,
  eyes_off: 2,
  drowsy: 3,
};

/** The voice line, ≤ 3 words; none for the speeding chime (the glow says it). */
export const ALERT_VOICE: Readonly<Record<EventType, string | null>> = {
  speeding: null,
  hard_brake: 'Hard brake',
  hard_accel: 'Hard acceleration',
  hard_corner: 'Hard corner',
  phone_pickup: 'Phone down',
  phone_handling: 'Phone down',
  eyes_off: 'Eyes up',
  drowsy: 'Take a break',
};

/** The voice line of a phone alert raised while the driver is away from RoadWise (a screen switch). */
export const SWITCH_VOICE = 'Back to RoadWise';

export const ALERT_INTENSITY: Readonly<Record<AlertLevel, HapticIntensity>> = { 1: 1, 2: 2, 3: 4 };

/** The HUD's edge glow after an alert, ms. */
export const ALERT_GLOW_MS = 1500;

export function decisionFor(alert: AlertEvent, opts: { voiceEnabled: boolean }): AlertDecision {
  const level = ALERT_LEVEL[alert.type];
  const voice = opts.voiceEnabled ? (alert.words === 'switch' ? SWITCH_VOICE : ALERT_VOICE[alert.type]) : null;
  const decision: AlertDecision = {
    id: alert.id,
    level,
    kind: alert.type,
    ts: alert.at,
    intensity: severeBoost(level, alert.tier),
  };
  if (voice !== null) decision.voice = voice;
  return decision;
}

/** A severe instant event vibrates one step harder than its level's default. */
function severeBoost(level: AlertLevel, tier: Tier): HapticIntensity {
  const base = ALERT_INTENSITY[level];
  return tier === 'severe' && base < 4 ? ((base + 1) as HapticIntensity) : base;
}
