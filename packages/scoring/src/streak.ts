// v3 streaks: counted in drives, protected by freezes (product spec v3 "Streaks", plan §2).
import { MAX_FREEZES } from './thresholds';

export interface StreakState {
  streak: number;
  /** A net-negative drive with no freeze: the next drive must be event-free to restore it. */
  atRisk: boolean;
  freezes: number;
  /** Consecutive clean scored drives toward the next freeze (every 5th earns one). */
  cleanRun: number;
}

export type StreakOutcome = 'none' | 'grew' | 'freeze_used' | 'at_risk' | 'restored' | 'reset';

export interface StreakResult {
  state: StreakState;
  outcome: StreakOutcome;
  /** A freeze was actually added by the clean run (false when already holding the maximum). */
  freezeEarned: boolean;
}

/** Clean scored drives in a row that earn a freeze. */
export const CLEAN_RUN_FOR_FREEZE = 5;

/** Apply one drive to the streak. Pure; returns a new state. */
export function applyStreak(
  state: StreakState,
  d: { scored: boolean; net: number; activeEventCount: number }
): StreakResult {
  if (!d.scored) return { state, outcome: 'none', freezeEarned: false };

  const next: StreakState = { ...state };
  const clean = d.activeEventCount === 0;
  let outcome: StreakOutcome;

  if (state.atRisk) {
    next.atRisk = false;
    if (clean) {
      next.streak = state.streak + 1;
      outcome = 'restored';
    } else {
      next.streak = 0;
      outcome = 'reset';
    }
  } else if (d.net > 0) {
    next.streak = state.streak + 1;
    outcome = 'grew';
  } else if (d.net < 0) {
    if (state.freezes > 0) {
      next.freezes = state.freezes - 1;
      outcome = 'freeze_used';
    } else {
      next.atRisk = true;
      outcome = 'at_risk';
    }
  } else {
    outcome = 'none';
  }

  let freezeEarned = false;
  if (clean) {
    next.cleanRun = state.cleanRun + 1;
    if (next.cleanRun >= CLEAN_RUN_FOR_FREEZE) {
      next.cleanRun = 0;
      const freezes = Math.min(MAX_FREEZES, next.freezes + 1);
      freezeEarned = freezes > next.freezes;
      next.freezes = freezes;
    }
  } else {
    next.cleanRun = 0;
  }

  return { state: next, outcome, freezeEarned };
}
