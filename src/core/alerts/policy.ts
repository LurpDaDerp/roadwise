// What each v3 event sounds like (product spec "Driving screen"): a distinct tone per category, an
// optional short voice line, and a haptic. Speeding gets the soft chime as the car passes the points
// line and again while it stays over (`machine.ts`; the halo carries how far); harsh driving the
// warning tone; a phone pickup the urgent one. An alert that cost points adds the points-lost cue
// after its tone; a speeding repeat past the grace is that cue alone. A speeding sound keeps the
// audio session (and the ducking) while the car stays over: the host releases it once it is not.
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

/** The voice line, ≤ 3 words; none for the speeding chime (the halo says it). */
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

/** How long the HUD shows an alert's banner (and holds its halo burst colour), ms. */
export const ALERT_GLOW_MS = 1500;

/** The speeding repeat interval's bounds, seconds. */
export const SPEEDING_REPEAT_MAX_S = 8;
export const SPEEDING_REPEAT_MIN_S = 2;

/**
 * Seconds from one speeding sound to the next while the car stays over the points line:
 * `clamp(8 / (1 + over / 5) × 0.85^(elapsed / 10), 2, 8)`, `over` the mph past the line now and
 * `elapsed` the seconds since the episode's first alert. 8 s just over the line, faster the further
 * over and the longer it lasts, never under 2 s. A reading that is not a finite number counts as 0.
 */
export function speedingRepeatS(overMph: number, elapsedS: number): number {
  const over = Number.isFinite(overMph) ? Math.max(0, overMph) : 0;
  const elapsed = Number.isFinite(elapsedS) ? Math.max(0, elapsedS) : 0;
  const s = (SPEEDING_REPEAT_MAX_S / (1 + over / 5)) * 0.85 ** (elapsed / 10);
  return Math.min(SPEEDING_REPEAT_MAX_S, Math.max(SPEEDING_REPEAT_MIN_S, s));
}

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
  const lost = alert.points !== undefined && alert.points > 0;
  if (alert.type === 'speeding') {
    decision.holdSession = true;
    if (alert.repeat === true && lost) decision.tone = 'points_lost';
    else if (alert.repeat !== true && lost) decision.cue = 'points_lost';
  } else if (lost) {
    decision.cue = 'points_lost';
  }
  return decision;
}

/** A severe instant event vibrates one step harder than its level's default. */
function severeBoost(level: AlertLevel, tier: Tier): HapticIntensity {
  const base = ALERT_INTENSITY[level];
  return tier === 'severe' && base < 4 ? ((base + 1) as HapticIntensity) : base;
}
