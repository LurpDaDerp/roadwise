// The rewards rules (M5 plan, "Rewards model" §R1–§R10): points, classes, streak, weekly goal,
// badges, challenges and referral.
//
// This file is the single TypeScript source of these numbers. The server's copy is the JSON
// literal inside SQL `public.reward_rules()` (migration 0009), and
// `scripts/__tests__/rewards-parity.test.ts` deep-compares that literal with `rewardRulesJson()`.
// Change a value here and the parity test fails until the SQL is changed with it.
//
// Settlement itself runs in SQL on the server; nothing here grants value. The client uses these
// tables to explain the rules (criteria are always visible) and to render progress it has read.
//
// Dependency-free like the rest of the package: it runs in Metro, Node and Deno.

import { CONSTANTS } from './constants';

/** The five event categories a weekly goal or a challenge can be about (focus is not one). */
export type GoalCategory = 'phone' | 'speeding' | 'braking' | 'accel' | 'cornering';

/**
 * Goal categories in tie order: when two categories cost the driver the same over the previous
 * 28 days, the earlier one here becomes the weekly goal (§R5).
 */
export const GOAL_CATEGORIES: readonly GoalCategory[] = ['phone', 'speeding', 'braking', 'cornering', 'accel'];

/**
 * A day predicate a challenge counts (§R2): a category, `smooth` (braking, accel and cornering
 * together) or `safe` (the day's streak outcome).
 */
export type ChallengePredicate = GoalCategory | 'smooth' | 'safe';

export type LevelName = 'Learner' | 'Steady' | 'Smooth' | 'Focused' | 'Road-wise' | 'Mentor';
export type LevelNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** Classes by lifetime XP (§R1). `progress.level` is the `level` here; classes unlock nothing in P0. */
export const LEVELS: readonly { level: LevelNumber; name: LevelName; xp: number }[] = [
  { level: 1, name: 'Learner', xp: 0 },
  { level: 2, name: 'Steady', xp: 1500 },
  { level: 3, name: 'Smooth', xp: 4000 },
  { level: 4, name: 'Focused', xp: 8000 },
  { level: 5, name: 'Road-wise', xp: 15000 },
  { level: 6, name: 'Mentor', xp: 25000 },
];

/** What a badge counts; each is a `progress` counter that settlement maintains (§R7). */
export type BadgeMetric = 'safe_days' | 'phone_free_days' | 'smooth_days' | 'weekly_goals' | 'challenges' | 'referrals';
export type BadgeTier = 'bronze' | 'silver' | 'gold';
/** A badge family is named by its metric; only the highest tier per family is announced (§R9). */
export type BadgeFamily = BadgeMetric;
export type BadgeId =
  | 'safe_days_7'
  | 'safe_days_30'
  | 'safe_days_100'
  | 'phone_free_days_10'
  | 'phone_free_days_50'
  | 'phone_free_days_200'
  | 'smooth_days_7'
  | 'smooth_days_30'
  | 'smooth_days_100'
  | 'weekly_goals_1'
  | 'weekly_goals_5'
  | 'weekly_goals_20'
  | 'challenges_1'
  | 'challenges_3'
  | 'challenges_10'
  | 'referrals_1';

export interface BadgeDef {
  id: BadgeId;
  family: BadgeFamily;
  tier: BadgeTier;
  metric: BadgeMetric;
  /** Earned when the metric's counter reaches this value; earned once, never removed. */
  threshold: number;
  /** Display order, 1-based. */
  sort: number;
}

/**
 * The 16 badges (§R7). None is based on distance or trip count (§10.1, E3); night-safe, rain-safe,
 * improvement and hours badges are deliberately absent.
 */
export const BADGES: readonly BadgeDef[] = [
  { id: 'safe_days_7', family: 'safe_days', tier: 'bronze', metric: 'safe_days', threshold: 7, sort: 1 },
  { id: 'safe_days_30', family: 'safe_days', tier: 'silver', metric: 'safe_days', threshold: 30, sort: 2 },
  { id: 'safe_days_100', family: 'safe_days', tier: 'gold', metric: 'safe_days', threshold: 100, sort: 3 },
  { id: 'phone_free_days_10', family: 'phone_free_days', tier: 'bronze', metric: 'phone_free_days', threshold: 10, sort: 4 },
  { id: 'phone_free_days_50', family: 'phone_free_days', tier: 'silver', metric: 'phone_free_days', threshold: 50, sort: 5 },
  { id: 'phone_free_days_200', family: 'phone_free_days', tier: 'gold', metric: 'phone_free_days', threshold: 200, sort: 6 },
  { id: 'smooth_days_7', family: 'smooth_days', tier: 'bronze', metric: 'smooth_days', threshold: 7, sort: 7 },
  { id: 'smooth_days_30', family: 'smooth_days', tier: 'silver', metric: 'smooth_days', threshold: 30, sort: 8 },
  { id: 'smooth_days_100', family: 'smooth_days', tier: 'gold', metric: 'smooth_days', threshold: 100, sort: 9 },
  { id: 'weekly_goals_1', family: 'weekly_goals', tier: 'bronze', metric: 'weekly_goals', threshold: 1, sort: 10 },
  { id: 'weekly_goals_5', family: 'weekly_goals', tier: 'silver', metric: 'weekly_goals', threshold: 5, sort: 11 },
  { id: 'weekly_goals_20', family: 'weekly_goals', tier: 'gold', metric: 'weekly_goals', threshold: 20, sort: 12 },
  { id: 'challenges_1', family: 'challenges', tier: 'bronze', metric: 'challenges', threshold: 1, sort: 13 },
  { id: 'challenges_3', family: 'challenges', tier: 'silver', metric: 'challenges', threshold: 3, sort: 14 },
  { id: 'challenges_10', family: 'challenges', tier: 'gold', metric: 'challenges', threshold: 10, sort: 15 },
  { id: 'referrals_1', family: 'referrals', tier: 'bronze', metric: 'referrals', threshold: 1, sort: 16 },
];

export type ChallengeId = 'phone_down' | 'within_limit' | 'smooth_ride' | 'safe_run';

export interface ChallengeDef {
  id: ChallengeId;
  predicate: ChallengePredicate;
  /** Complete when this many counted driving days pass. */
  targetDays: number;
  /** Ended (without completing) once this many driving days (pass + fail) have counted. */
  windowDays: number;
  /** Credited once on completion (`challenge:<user_challenge id>`). */
  points: number;
  /** Display order, 1-based. */
  sort: number;
}

/**
 * The four personal challenges (§R6), measured in driving days (days whose predicate is pass or
 * fail), so not driving pauses them. Counting starts the day after joining.
 */
export const CHALLENGES: readonly ChallengeDef[] = [
  { id: 'phone_down', predicate: 'phone', targetDays: 10, windowDays: 14, points: 200, sort: 1 },
  { id: 'within_limit', predicate: 'speeding', targetDays: 10, windowDays: 14, points: 200, sort: 2 },
  { id: 'smooth_ride', predicate: 'smooth', targetDays: 10, windowDays: 14, points: 150, sort: 3 },
  { id: 'safe_run', predicate: 'safe', targetDays: 7, windowDays: 10, points: 300, sort: 4 },
];

/**
 * The rewards constants (§R1–§R10). `POINTS`, the safe-day floor and the shield rules are taken
 * from `CONSTANTS` so the per-day evaluation (`day.ts`) and the rewards rules share one value.
 */
export const REWARDS = {
  /** Per-day and per-week credits (§R1). Challenge points live on each `CHALLENGES` def. */
  POINTS: CONSTANTS.POINTS,
  /** Seconds of scored driving a day needs to earn a bonus or pass a predicate (§R2). */
  MIN_DRIVING_S: CONSTANTS.SAFE_DAY_MIN_DRIVING_S,
  /** Average score at or above which a short day is `neutral` (`short`) rather than `unsafe` (§R2). */
  SAFE_AVG: CONSTANTS.SAFE_DAY_AVG,
  /** Every Nth lifetime safe day grants a shield (§R4). */
  SHIELD_EVERY_SAFE_DAYS: CONSTANTS.SHIELD_EVERY_SAFE_DAYS,
  /** Most shields held at once (§R4). */
  SHIELD_MAX: CONSTANTS.SHIELD_MAX,
  /** Streak lengths that produce one `streak_milestone` per run (§R4). */
  STREAK_MILESTONES: [7, 14, 30, 50, 100, 150, 200, 250, 300, 365],
  /** Passing driving days that achieve the weekly goal (§R5). */
  WEEKLY_GOAL_TARGET_DAYS: 4,
  /** A day's wall close is 02:00 local on the next day, in the latest of its zones (§R2). */
  SETTLE_WALL_CLOCK_H: 2,
  /** A day settles at the latest this many hours after its wall close, whatever the watermarks (§R2). */
  SETTLE_CAP_H: 72,
  /** A device is a watermark device if seen or synced within this many days (§R2). */
  WATERMARK_ACTIVE_D: 14,
  /** Two settled days whose wall closes are less than this many hours apart cannot both earn (§R2). */
  ZONE_HOP_MIN_H: 20,
  /** At most this many active challenge enrolments per user (§R6). */
  MAX_ACTIVE_CHALLENGES: 2,
  /** Referral (§R10). */
  REFERRAL: {
    /** Final, not deleted driver drives on settled days the invitee needs. */
    QUALIFYING_DRIVES: 3,
    /** A code can be redeemed only within this many days of the invitee's account creation. */
    REDEEM_WITHIN_D: 14,
    /** The qualifying drives must fall within this many days of redemption. */
    QUALIFY_WITHIN_D: 90,
    /** Rewarded referrals per referrer per rolling 365 days. */
    YEARLY_CAP: 20,
    CODE_LENGTH: 8,
    /** M4's invite alphabet: no I, L, O, 0 or 1. */
    CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
    /** Redemption attempts per user per rolling 24 h. */
    REDEEM_ATTEMPTS_PER_DAY: 10,
    /** Well-formed redemptions per rolling hour across all users. */
    GLOBAL_REDEEM_PER_HOUR: 500,
  },
} as const;

/** A referral code after `normaliseReferralCode`: 8 characters of `REWARDS.REFERRAL.CODE_ALPHABET`. */
export const REFERRAL_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Normalises what a person typed or pasted: upper-cases and removes whitespace and hyphens
 * (`' abcd-2345 '` → `'ABCD2345'`). The server's `redeem_referral_code` applies the same rule
 * before matching `REFERRAL_CODE_PATTERN`.
 */
export function normaliseReferralCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export interface LevelProgress {
  level: LevelNumber;
  name: LevelName;
  nextName: LevelName | null;
  nextXp: number | null;
  /** Progress from this class's threshold toward the next, in [0, 1]; 1 at Mentor. */
  fraction: number;
}

/** The class for a lifetime XP (§R1). Negative or non-finite XP reads as Learner with fraction 0. */
export function levelFor(xp: number): LevelProgress {
  const valid = Number.isFinite(xp) && xp >= 0;
  let index = 0;
  if (valid) {
    for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i]!.xp) index = i;
  }
  const current = LEVELS[index]!;
  const next = LEVELS[index + 1];
  if (!next) return { level: current.level, name: current.name, nextName: null, nextXp: null, fraction: 1 };
  const fraction = valid ? Math.min(1, Math.max(0, (xp - current.xp) / (next.xp - current.xp))) : 0;
  return { level: current.level, name: current.name, nextName: next.name, nextXp: next.xp, fraction };
}

/**
 * Exactly the JSON that SQL `public.reward_rules()` returns: every `REWARDS` value plus the goal
 * tie order and the class table. Badges and challenges are not in it — migration 0010 seeds them
 * as `badge_defs` / `challenge_defs` rows, which have their own parity with `BADGES` / `CHALLENGES`.
 * Returns a fresh plain object each call.
 */
export function rewardRulesJson(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      ...REWARDS,
      GOAL_CATEGORIES,
      LEVELS,
    }),
  ) as Record<string, unknown>;
}
