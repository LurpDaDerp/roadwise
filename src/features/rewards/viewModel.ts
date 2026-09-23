/**
 * Pure view models over the rewards rows. Nothing here computes a reward: every value is the
 * server's settled one, only arranged for a screen.
 */
import { levelFor, REWARDS, type LevelNumber, type LevelName } from '@scoring';

import type {
  BadgeDef,
  BadgeMetric,
  ChallengeDef,
  EarnedBadge,
  Enrolment,
  EnrolmentSummary,
  GoalCategory,
  PredicateKey,
  Progress,
  RewardDay,
  WeeklyGoalSummary,
} from './api';
import { GOAL_PROGRESS } from './copy/common';

export interface ClassView {
  level: LevelNumber;
  name: LevelName;
  nextName: LevelName | null;
  nextXp: number | null;
  /** Points still to the next class; null at the top. */
  toNext: number | null;
  /** Progress towards the next class, in [0, 1]; 1 at the top. */
  fraction: number;
  xp: number;
}

/** The class (level) for the settled XP; a user with no progress row yet is a Learner at 0. */
export function classView(progress: Progress | null): ClassView {
  const xp = progress?.xp ?? 0;
  const l = levelFor(xp);
  return { ...l, toNext: l.nextXp === null ? null : Math.max(0, l.nextXp - xp), xp };
}

export interface StreakView {
  days: number;
  best: number;
  shields: number;
  /** The streak restarted at some point: 0 now, a best above 0 ("Best 30" is worth showing). */
  restarted: boolean;
}

export function streakView(progress: Progress | null): StreakView {
  const days = progress?.streak_days ?? 0;
  const best = progress?.best_streak ?? 0;
  return { days, best, shields: progress?.shields ?? 0, restarted: days === 0 && best > 0 };
}

export interface GoalView {
  category: GoalCategory;
  target: number;
  pass: number;
  fail: number;
  /** Days that counted, either way (pass + fail). */
  drivingDays: number;
  state: WeeklyGoalSummary['state'];
  prorated: boolean;
  /** Credited once when achieved (§R5). */
  points: number;
  /** The progress line for the state (`GOAL_PROGRESS`). */
  remainingText: string;
}

/** The weekly goal for a screen. `rules` defaults to the shared rules (`REWARDS`). */
export function goalView(
  goal: WeeklyGoalSummary,
  rules: { POINTS: { weeklyGoal: number } } = REWARDS
): GoalView {
  const pass = goal.pass_days;
  const fail = goal.fail_days;
  let remainingText: string;
  switch (goal.state) {
    case 'active':
      remainingText = GOAL_PROGRESS.toGo(Math.max(1, goal.target_days - pass));
      break;
    case 'achieved':
      remainingText = goal.prorated ? GOAL_PROGRESS.achievedProrated : GOAL_PROGRESS.achieved;
      break;
    case 'no_drives':
      remainingText = GOAL_PROGRESS.noDrives;
      break;
    case 'ended':
      remainingText = GOAL_PROGRESS.ended;
      break;
  }
  return {
    category: goal.category,
    target: goal.target_days,
    pass,
    fail,
    drivingDays: pass + fail,
    state: goal.state,
    prorated: goal.prorated,
    points: rules.POINTS.weeklyGoal,
    remainingText,
  };
}

export interface ChallengeView {
  id: string;
  defId: string;
  predicate: PredicateKey;
  target: number;
  /** Driving days (pass + fail) after which it ends without completing. */
  window: number;
  pass: number;
  fail: number;
  drivingDays: number;
  /** Passing days still needed; 0 once complete. */
  toTarget: number;
  state: Enrolment['state'];
  points: number;
  startDay: string;
}

export function challengeView(enrolment: Enrolment | EnrolmentSummary, def: ChallengeDef): ChallengeView {
  return {
    id: enrolment.id,
    defId: def.id,
    predicate: def.predicate,
    target: def.target_days,
    window: def.window_days,
    pass: enrolment.pass_days,
    fail: enrolment.fail_days,
    drivingDays: enrolment.pass_days + enrolment.fail_days,
    toTarget: Math.max(0, def.target_days - enrolment.pass_days),
    state: enrolment.state,
    points: def.points,
    startDay: enrolment.start_day,
  };
}

/** Which `progress` counter each badge metric counts (§R7). */
export const BADGE_METRIC_COUNTER: Readonly<Record<BadgeMetric, keyof Progress>> = {
  safe_days: 'safe_days',
  phone_free_days: 'phone_free_days',
  smooth_days: 'smooth_days',
  weekly_goals: 'goals_achieved',
  challenges: 'challenges_completed',
  referrals: 'referrals_rewarded',
};

/** A badge's counter now, from the settled progress (0 with no progress yet). */
export function badgeCurrent(progress: Progress | null, metric: BadgeMetric): number {
  const value = progress?.[BADGE_METRIC_COUNTER[metric]];
  return typeof value === 'number' ? value : 0;
}

export interface NextBadge {
  def: BadgeDef;
  current: number;
  threshold: number;
  fraction: number;
}

/**
 * The unearned badge closest to being earned: the highest `current / threshold` below 1, ties to
 * the first in display order. A counter already at its threshold is left out — the badge lands at
 * the next settlement and is not "next" to work towards. Null when every badge is earned.
 */
export function nextBadge(progress: Progress | null, defs: readonly BadgeDef[], earned: readonly EarnedBadge[]): NextBadge | null {
  const have = new Set(earned.map((b) => b.badge_id));
  let best: NextBadge | null = null;
  for (const def of [...defs].sort((a, b) => a.sort - b.sort)) {
    if (have.has(def.id)) continue;
    const current = badgeCurrent(progress, def.metric);
    const fraction = current / def.threshold;
    if (fraction >= 1) continue;
    if (best === null || fraction > best.fraction) best = { def, current, threshold: def.threshold, fraction };
  }
  return best;
}

export type DayAward =
  | { settled: false }
  | {
      settled: true;
      tier: RewardDay['tier'];
      phoneFree: boolean;
      camera: boolean;
      points: number;
      streakAfter: number | null;
    };

/** A day's reward: `settled: false` unless its `reward_days` row exists (then final). */
export function dayAward(day: RewardDay | null): DayAward {
  if (day === null) return { settled: false };
  return {
    settled: true,
    tier: day.tier,
    phoneFree: day.phone_free,
    camera: day.camera,
    points: day.points,
    streakAfter: day.streak_after,
  };
}

/** The Monday of `day`'s ISO week (`YYYY-MM-DD` in, `YYYY-MM-DD` out). */
export function isoWeekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}
