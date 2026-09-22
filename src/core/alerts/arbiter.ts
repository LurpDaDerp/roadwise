// The alert arbiter: every in-drive alert passes through here (spec §13.4, §8.8).
//
// Pure and deterministic — it never reads the clock, so a timeline of `ts` values replays exactly.
import { CONSTANTS } from '@scoring';
import { alertableFor, statusFor } from '@/core/detectors/common';
import type {
  AlertDecision,
  AlertKind,
  AlertLevel,
  AlertVoiceKey,
  Arbiter,
  ArbiterInput,
  ArbiterState,
} from './types';

const {
  ALERT_BREAK_AFTER_S,
  ALERT_BUDGET_L1_PER_10MIN,
  ALERT_BUDGET_WINDOW_S,
  ALERT_DROWSY_MAX_PER_S,
  ALERT_EYES_OFF_REARM_S,
  ALERT_L1_SPEEDING_MIN_S,
  ALERT_L2_OVER_MPS,
  ALERT_L2_PERSIST_S,
  ALERT_L3_OVER_MPS,
  ALERT_L3_MIN_S,
  ALERT_PHONE_COOLDOWN_S,
  ALERT_REALERT_S,
  ALERT_SPEEDING_RESET_S,
  EYES_OFF_MIN_SPEED_MPS,
  EYES_OFF_S,
  LEARNING_PERIOD_TRIPS,
  PHONE_HANDLING_MIN_S,
  PHONE_MIN_SPEED_MPS,
  SPEEDING_TOLERANCE_MPS,
} = CONSTANTS;

/** How urgent the speeding *state* is right now; 0 means "nothing to say". */
type SpeedingBand = 0 | 1 | 2 | 3;

/**
 * A rule that would fire on this row. Rules are evaluated in priority order but only the winner is
 * committed, so a phone alert that lost to a drowsiness alert is still pending on the next row.
 */
interface Candidate {
  kind: AlertKind;
  level: AlertLevel;
  voice: AlertVoiceKey;
  eventId?: string;
  /** Record that this candidate was the decision (delivered or budget-suppressed). */
  commit(): void;
}

export function createArbiter(state: ArbiterState): Arbiter {
  const decisions: AlertDecision[] = [];
  let seq = 0;

  // --- speeding episode ------------------------------------------------------------------------
  /** Highest band already alerted in the open episode; 0 between episodes. */
  let alertedBand: SpeedingBand = 0;
  let lastSpeedingAlertTs = 0;
  /** When `overMps` last fell back inside the tolerance, for the episode reset. */
  let withinToleranceSinceTs: number | null = null;
  /** When `overMps` last reached the L3 threshold, for the "≥ 20 over for ≥ 10 s" clock. */
  let overL3SinceTs: number | null = null;

  // --- the other rules -------------------------------------------------------------------------
  const alertedPhoneEpisodes = new Set<string>();
  let lastPhoneAlertTs: number | null = null;
  /** False between an eyes-off alert and the eyes coming back to the road. */
  let eyesOffArmed = true;
  let lastDrowsyAlertTs: number | null = null;
  let breakSuggested = false;

  /**
   * `ts` of every *delivered* L1, for the rolling budget. Suppressed ones cost nothing. A resumed
   * arbiter starts from the window it was saved with, so a relaunch does not refill the budget.
   */
  const deliveredL1Ts: number[] = (state.l1Window ?? [])
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  /** The rest of the drive is muted (C6); carried across a resume. */
  let mutedAll = state.mutedAll === true;
  /** The decision currently speaking — what a long-press mutes. */
  let speaking: AlertDecision | null = null;
  /** The speeding band a long-press silenced; cleared when the episode ends. */
  let mutedBand: AlertLevel | undefined = state.mutedBand;
  /** A time-boxed mute carried in from a paused drive. */
  const carriedMutedUntilTs = state.mutedUntilTs;

  function resetSpeedingEpisode(): void {
    alertedBand = 0;
    lastSpeedingAlertTs = 0;
    mutedBand = undefined;
    // Nothing is speaking any more, so a late long-press must not mute the next episode.
    if (speaking !== null && speaking.kind === 'speeding') speaking = null;
  }

  function track(input: ArbiterInput): void {
    const { ts, overMps } = input;
    // Every threshold compares the plain over-limit: L1 starts past the tolerance, L2 and L3 at
    // 15 and 20 over as §13.4 states them.
    if (overMps > SPEEDING_TOLERANCE_MPS) {
      withinToleranceSinceTs = null;
      if (overMps >= ALERT_L3_OVER_MPS) {
        if (overL3SinceTs === null) overL3SinceTs = ts;
      } else {
        overL3SinceTs = null;
      }
    } else {
      overL3SinceTs = null;
      if (withinToleranceSinceTs === null) withinToleranceSinceTs = ts;
      if (ts - withinToleranceSinceTs >= ALERT_SPEEDING_RESET_S * 1000) resetSpeedingEpisode();
    }
    // Eyes back on the road long enough: the next glance is a new one.
    if ((input.eyesOffS ?? 0) < ALERT_EYES_OFF_REARM_S) eyesOffArmed = true;
  }

  function speedingBand(input: ArbiterInput): SpeedingBand {
    const { ts, overMps, overForS, q } = input;
    // The detectors' own alert gate (§9.5): only an episode we would score in full is worth
    // speaking about. L2 and L3 are escalations of the L1 state, so they inherit it — below
    // `Q_FULL_AT` the fix is not good enough to accuse anyone of 20 over (§8.8 step 2).
    if (!(overMps > SPEEDING_TOLERANCE_MPS && overForS >= ALERT_L1_SPEEDING_MIN_S)) return 0;
    if (!alertableFor(statusFor(q), q)) return 0;
    if (overL3SinceTs !== null && ts - overL3SinceTs >= ALERT_L3_MIN_S * 1000) return 3;
    const persisted = overForS >= ALERT_L1_SPEEDING_MIN_S + ALERT_L2_PERSIST_S;
    if (overMps >= ALERT_L2_OVER_MPS || persisted) return 2;
    return 1;
  }

  function speedingCandidate(input: ArbiterInput): Candidate | null {
    const band = speedingBand(input);
    if (band === 0) return null;
    const increased = band > alertedBand;
    // Speeding is the only alert that repeats inside one episode, so it is the only one a mute
    // has anything to silence. A materially worse state still speaks (§8.8 step 6) — and so do
    // *its* repeats, because the driver silenced the band below, not this one.
    const carriedMute = carriedMutedUntilTs !== undefined && input.ts < carriedMutedUntilTs;
    const muted = (mutedBand !== undefined && band <= mutedBand) || carriedMute;
    const dueAgain = !muted && input.ts - lastSpeedingAlertTs >= ALERT_REALERT_S * 1000;
    if (!increased && !dueAgain) return null;
    return {
      kind: 'speeding',
      level: band,
      voice: band === 3 ? 'alert.slowDown' : 'alert.easeOff',
      commit: () => {
        alertedBand = band;
        lastSpeedingAlertTs = input.ts;
      },
    };
  }

  function phoneCandidate(input: ArbiterInput): Candidate | null {
    const episode = input.phoneEpisode;
    if (episode === undefined) return null;
    if (episode.durationS < PHONE_HANDLING_MIN_S) return null;
    if (input.speedMps < PHONE_MIN_SPEED_MPS) return null;
    if (alertedPhoneEpisodes.has(episode.id)) return null;
    if (lastPhoneAlertTs !== null && input.ts - lastPhoneAlertTs < ALERT_PHONE_COOLDOWN_S * 1000) {
      return null;
    }
    return {
      kind: 'phone',
      level: 2,
      voice: 'alert.phoneDown',
      eventId: episode.id,
      commit: () => {
        alertedPhoneEpisodes.add(episode.id);
        lastPhoneAlertTs = input.ts;
      },
    };
  }

  function eyesOffCandidate(input: ArbiterInput): Candidate | null {
    if (!eyesOffArmed) return null;
    if ((input.eyesOffS ?? 0) < EYES_OFF_S) return null;
    if (input.speedMps < EYES_OFF_MIN_SPEED_MPS) return null;
    return {
      kind: 'eyes_off',
      level: 2,
      voice: 'alert.eyesUp',
      commit: () => {
        eyesOffArmed = false;
      },
    };
  }

  function drowsyCandidate(input: ArbiterInput): Candidate | null {
    if (input.drowsy !== true) return null;
    if (lastDrowsyAlertTs !== null && input.ts - lastDrowsyAlertTs < ALERT_DROWSY_MAX_PER_S * 1000) {
      return null;
    }
    return {
      kind: 'drowsy',
      level: 3,
      voice: 'alert.drowsy',
      commit: () => {
        lastDrowsyAlertTs = input.ts;
      },
    };
  }

  function breakCandidate(input: ArbiterInput): Candidate | null {
    if (breakSuggested || input.drivingS < ALERT_BREAK_AFTER_S) return null;
    return {
      kind: 'break',
      level: 1,
      voice: 'alert.takeABreak',
      commit: () => {
        breakSuggested = true;
      },
    };
  }

  /**
   * At most one decision per row, in the order a driver needs them:
   * drowsy L3 > speeding L3 > phone L2 > eyes-off L2 > speeding L2 > speeding L1 > break L1.
   */
  function pick(input: ArbiterInput): Candidate | null {
    const drowsy = drowsyCandidate(input);
    if (drowsy !== null) return drowsy;
    const speeding = speedingCandidate(input);
    if (speeding !== null && speeding.level === 3) return speeding;
    const phone = phoneCandidate(input);
    if (phone !== null) return phone;
    const eyesOff = eyesOffCandidate(input);
    if (eyesOff !== null) return eyesOff;
    if (speeding !== null) return speeding;
    return breakCandidate(input);
  }

  // --- decision plumbing -----------------------------------------------------------------------

  /**
   * First trips are L1-only, so the app's first impression is never harsh (§13.4). Drowsiness is
   * the exception: a safety alert is not softened for a new driver.
   */
  function levelFor(candidate: Candidate): AlertLevel {
    const learning = state.tripIndex < LEARNING_PERIOD_TRIPS;
    return learning && candidate.kind !== 'drowsy' ? 1 : candidate.level;
  }

  /**
   * A pure read: `budgetRemaining` is a UI poll that may run with any `ts`, so it must never
   * change what the next row decides.
   */
  function remaining(ts: number): number {
    const cutoff = ts - ALERT_BUDGET_WINDOW_S * 1000;
    const spent = deliveredL1Ts.filter((t) => t > cutoff).length;
    return Math.max(0, ALERT_BUDGET_L1_PER_10MIN - spent);
  }

  /** Drops what the rolling window has left behind. Only ever called with a row's own `ts`. */
  function pruneBudget(ts: number): void {
    const cutoff = ts - ALERT_BUDGET_WINDOW_S * 1000;
    while (deliveredL1Ts.length > 0 && (deliveredL1Ts[0] ?? Infinity) <= cutoff) {
      deliveredL1Ts.shift();
    }
  }

  /**
   * Turns the winning candidate into a decision. The candidate is committed either way: a
   * budget-suppressed alert was still *decided*, so it lands in the log once and does not come
   * back a second later (§13.4 "log silently and summarize after the trip").
   */
  function emit(candidate: Candidate, ts: number, silent: boolean): AlertDecision | null {
    candidate.commit();
    seq += 1;
    const level = levelFor(candidate);
    const decision: AlertDecision = {
      id: `${candidate.kind}-${ts}-${seq}`,
      level,
      kind: candidate.kind,
      ts,
      voice: candidate.voice,
    };
    if (candidate.eventId !== undefined) decision.eventId = candidate.eventId;
    // A muted drive or a passenger trip: decided, on record, never played — and never counted
    // against the budget, since nobody heard it.
    // Only L1 is rationed; a warning or an urgent alert always plays.
    if (silent || mutedAll || (level === 1 && remaining(ts) === 0)) {
      decisions.push({ ...decision, suppressed: true });
      return null;
    }
    if (level === 1) deliveredL1Ts.push(ts);
    decisions.push(decision);
    speaking = decision;
    // The caller gets a copy: the arbiter's own record, and the mute that reads `speaking.kind`,
    // stay out of reach.
    return { ...decision };
  }

  return {
    consider(input) {
      pruneBudget(input.ts);
      track(input);
      const candidate = pick(input);
      return candidate === null ? null : emit(candidate, input.ts, input.silent === true);
    },

    mute(ts) {
      // A mute can only apply to an alert that has already spoken.
      if (speaking === null || ts < speaking.ts) return;
      if (speaking.kind === 'speeding' && alertedBand !== 0) mutedBand = alertedBand;
    },

    muteAll() {
      mutedAll = true;
      // Whatever was speaking is the player's to cut off; there is nothing left for a long-press.
      speaking = null;
    },

    budgetRemaining(ts) {
      return remaining(ts);
    },

    state() {
      const snapshot: ArbiterState = { tripIndex: state.tripIndex };
      if (carriedMutedUntilTs !== undefined) snapshot.mutedUntilTs = carriedMutedUntilTs;
      if (mutedBand !== undefined) snapshot.mutedBand = mutedBand;
      if (deliveredL1Ts.length > 0) snapshot.l1Window = deliveredL1Ts.slice();
      if (mutedAll) snapshot.mutedAll = true;
      return snapshot;
    },

    log() {
      return decisions.map((decision) => ({ ...decision }));
    },
  };
}
