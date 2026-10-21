// The in-drive alert contract (product spec "Driving screen": audio first, a distinct tone per
// category, an optional short voice line, a haptic; no full-screen overlays).
import type { EventType } from '@scoring';

/** The three tones: 1 the soft chime, 2 the warning, 3 the urgent one. */
export type AlertLevel = 1 | 2 | 3;

/** A phone-engine event, or an alert the DashPal dashcam routed to the phone. */
export type AlertKind = EventType | 'dashpal';

/**
 * A tone other than the three levels (scripts/make-tones.js): the DashPal sounds, glance (eyes on
 * the road), drowsy (take a break), wake (urgent, loud) and phone (phone down). Absent: the level's tone.
 */
export type AlertTone = 'dp_glance' | 'dp_drowsy' | 'dp_wake' | 'dp_phone';

/** How hard an alert vibrates: 1 is one short pulse, 4 the longest, heaviest pattern. */
export type HapticIntensity = 1 | 2 | 3 | 4;

/**
 * The driver's alert style (Alerts and sounds): `both` is the default; `vibration` plays no tone
 * and no voice and never touches the audio session; `sound` never vibrates.
 */
export type AlertStyle = 'both' | 'vibration' | 'sound';

/** The words a voice line speaks (≤ 3 words). */
export type AlertVoiceKey = string;

export interface AlertDecision {
  id: string;
  level: AlertLevel;
  kind: AlertKind;
  /** epoch ms — the `ts` of the row that produced it, never wall-clock. */
  ts: number;
  /** Spoken when the voice setting is on and no call is active. */
  voice?: AlertVoiceKey;
  /** How hard this alert vibrates; absent, the player maps it from the level. */
  intensity?: HapticIntensity;
  /** Decided but not to be delivered. The player ignores such a decision outright. */
  suppressed?: boolean;
  /** Plays this tone instead of the level's (the level still sets gain and the voice rule). */
  tone?: AlertTone;
  /**
   * Re-read as the item starts, next to `deliverable()`: false drops it without touching a port
   * (a DashPal repeat whose alert the dashcam has since stopped).
   */
  stillWanted?: () => boolean;
  /** Speak the voice line even with the voice setting off (never on a call or vibration-only). */
  voiceAlways?: true;
  /**
   * Keep the audio session active after this item: a continuous DashPal alert keeps music ducked
   * between its repeats. The next item without it, or `stopCurrent()`, releases the session.
   */
  holdSession?: true;
  /** Haptic only: no tone, no voice, the audio session untouched (the visual is the HUD's). */
  silent?: true;
  /**
   * The tone must have loaded or started playing this long (ms) after it was asked to play, or the
   * play fails (a DashPal critical alert: the dashcam's buzzer then takes it within about a second
   * instead of after the tone length plus its finish margin). Absent: only that longer bound.
   */
  startWithinMs?: number;
}
