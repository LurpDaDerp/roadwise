// The in-drive alert contract (product spec v3 "Driving screen": audio first, a distinct tone per
// category, an optional short voice line, a haptic; no full-screen overlays).
import type { EventType } from '@scoring';

/** The three tones: 1 the soft chime, 2 the warning, 3 the urgent one. */
export type AlertLevel = 1 | 2 | 3;

export type AlertKind = EventType;

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
}
