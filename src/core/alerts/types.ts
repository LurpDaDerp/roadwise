// The in-drive alert contract (spec §13.4 alert policy, §8.8 receiving a warning).
//
// Nothing here knows how an alert is played. The arbiter decides *whether* to speak, at what
// urgency, and with which phrase; the audio and HUD layers consume `AlertDecision`.
import type { StringKey } from '@/i18n';

/** L1 nudge, L2 warning, L3 urgent. Each level maps to its own tone and audio session (§13.4). */
export type AlertLevel = 1 | 2 | 3;

export type AlertKind = 'speeding' | 'phone' | 'eyes_off' | 'drowsy' | 'break';

/** The `alert.*` keys in `src/i18n/en.ts`; voice phrases are ≤ 3 words (§8.8 step 4). */
export type AlertVoiceKey = Extract<StringKey, `alert.${string}`>;

export interface AlertDecision {
  id: string;
  level: AlertLevel;
  kind: AlertKind;
  /** The detector episode this alert is about, where the caller supplies one. */
  eventId?: string;
  /** epoch ms — always the `ts` of the row that produced the decision, never wall-clock. */
  ts: number;
  voice?: AlertVoiceKey;
  /**
   * Decided but not delivered: the L1 budget was spent (§13.4 "log silently and summarize after
   * the trip"). Only ever set on entries in `log()`; `consider` returns null for these.
   */
  suppressed?: boolean;
}

export interface PhoneEpisode {
  id: string;
  durationS: number;
}

/** One 1 Hz row's worth of everything the alert policy reasons about. */
export interface ArbiterInput {
  /** epoch ms */
  ts: number;
  speedMps: number;
  /** null when the limit is unknown — shown as unknown, never guessed (§13.2). */
  limitMps: number | null;
  /** m/s beyond limit + tolerance; 0 when not speeding. */
  overMps: number;
  /** seconds `overMps` has been continuously > 0. */
  overForS: number;
  /** data quality 0..1 (§9.5). */
  q: number;
  phoneEpisode?: PhoneEpisode;
  /** seconds of the current continuous glance away from the forward zone. */
  eyesOffS?: number;
  drowsy?: boolean;
  /** seconds of continuous driving, for the break suggestion. */
  drivingS: number;
}

/**
 * Everything an arbiter needs to be rebuilt mid-drive. `createArbiter(previous.state())` resumes
 * with the driver's mute intact; the per-episode bookkeeping deliberately does not survive, since
 * the detectors it mirrors do not either.
 */
export interface ArbiterState {
  /** 0-based count of prior trips; below `LEARNING_PERIOD_TRIPS` the drive is L1-only. */
  tripIndex: number;
  /** epoch ms — a time-boxed mute carried into this arbiter (e.g. a paused drive). */
  mutedUntilTs?: number;
  /**
   * The speeding band a long-press silenced. Repeats at or below it stay quiet until the episode
   * ends; an escalation is a different alert and speaks, repeats included.
   */
  mutedBand?: AlertLevel;
}

export interface Arbiter {
  /** Feed one row. At most one decision per call. */
  consider(input: ArbiterInput): AlertDecision | null;
  /** Long-press: mutes repeats of the alert now speaking, until its episode ends. */
  mute(ts: number): void;
  /**
   * L1 alerts still available in the rolling `ALERT_BUDGET_WINDOW_S` ending at `ts`. A read only:
   * polling it — with any `ts`, including one ahead of the row clock — never changes a decision.
   */
  budgetRemaining(ts: number): number;
  /** A snapshot that `createArbiter` can resume from. */
  state(): ArbiterState;
  /** Every decision made this trip, delivered and suppressed alike, in order. Copies. */
  log(): AlertDecision[];
}
