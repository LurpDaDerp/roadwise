/**
 * F3 · Badges copy (M5 Task 8): every badge's name and criterion, keyed by `BadgeId` so a badge
 * added to `packages/scoring` without words here fails to compile. Thresholds are passed in from
 * the server's `badge_defs` row, never written twice.
 *
 * Criteria are always visible (§R7) and none mentions distance or a count of drives (§10.1).
 */
import { REWARDS, type BadgeId, type BadgeMetric } from '@scoring';

const n = (value: number) => new Intl.NumberFormat('en-US').format(value);
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** What a metric counts, as a unit after a number: "12 of 30 safe days". */
export const METRIC_UNIT: Readonly<Record<BadgeMetric, (count: number) => string>> = {
  safe_days: (c) => plural(c, 'safe day', 'safe days'),
  phone_free_days: (c) => plural(c, 'day with no phone use', 'days with no phone use'),
  smooth_days: (c) => plural(c, 'smooth day', 'smooth days'),
  weekly_goals: (c) => plural(c, 'weekly goal', 'weekly goals'),
  challenges: (c) => plural(c, 'challenge', 'challenges'),
  referrals: (c) => plural(c, 'friend counted', 'friends counted'),
};

/** A badge family's heading on the grid. */
export const FAMILY_TITLE: Readonly<Record<BadgeMetric, string>> = {
  safe_days: 'Safe days',
  phone_free_days: 'No phone use',
  smooth_days: 'Smooth driving',
  weekly_goals: 'Weekly goals',
  challenges: 'Challenges',
  referrals: 'Friends',
};

const reach = (metric: BadgeMetric) => (threshold: number) => `Reach ${n(threshold)} ${METRIC_UNIT[metric](threshold)}`;

/** `criterion(threshold)` is the rule, e.g. "Reach 30 safe days". */
export const BADGE_COPY: Readonly<Record<BadgeId, { name: string; criterion: (threshold: number) => string }>> = {
  safe_days_7: { name: 'Safe Start', criterion: reach('safe_days') },
  safe_days_30: { name: 'Safe Regular', criterion: reach('safe_days') },
  safe_days_100: { name: 'Safe Hundred', criterion: reach('safe_days') },
  phone_free_days_10: { name: 'Phone Down', criterion: reach('phone_free_days') },
  phone_free_days_50: { name: 'Phone Away', criterion: reach('phone_free_days') },
  phone_free_days_200: { name: 'Phone-Free Habit', criterion: reach('phone_free_days') },
  smooth_days_7: { name: 'Smooth Start', criterion: reach('smooth_days') },
  smooth_days_30: { name: 'Steady Rhythm', criterion: reach('smooth_days') },
  smooth_days_100: { name: 'Glass of Water', criterion: reach('smooth_days') },
  weekly_goals_1: {
    name: 'First Goal',
    criterion: (t) => (t === 1 ? 'Reach a weekly goal' : `Reach ${n(t)} weekly goals`),
  },
  weekly_goals_5: { name: 'Goal Keeper', criterion: (t) => `Reach ${n(t)} weekly goals` },
  weekly_goals_20: { name: 'Goal Setter', criterion: (t) => `Reach ${n(t)} weekly goals` },
  challenges_1: {
    name: 'First Challenge',
    criterion: (t) => (t === 1 ? 'Complete a challenge' : `Complete ${n(t)} challenges`),
  },
  challenges_3: { name: 'Hat Trick', criterion: (t) => `Complete ${n(t)} challenges` },
  challenges_10: { name: 'Challenge Veteran', criterion: (t) => `Complete ${n(t)} challenges` },
  referrals_1: {
    name: 'Good Company',
    criterion: () =>
      `A friend joins with your code and their first ${REWARDS.REFERRAL.QUALIFYING_DRIVES} scored drives are confirmed within ${REWARDS.REFERRAL.QUALIFY_WITHIN_D} days`,
  },
};

export const badgesCopy = {
  title: 'Badges',
  /** "Earned Sep 21" */
  earned: (date: string) => `Earned ${date}`,
  locked: 'Locked',
  /** "Reach 30 safe days · 12 so far" */
  lockedLine: (criterion: string, current: number) => `${criterion} · ${n(current)} so far`,
  /** "12 of 30 safe days" */
  progress: (current: number, threshold: number, metric: BadgeMetric) =>
    `${n(current)} of ${n(threshold)} ${METRIC_UNIT[metric](threshold)}`,
  empty: (safeDays: number) => `Your first badge comes with ${n(safeDays)} safe days.`,
  countEarned: (earned: number, total: number) => `${earned} of ${total} earned`,
  seal: {
    /** The seal's one spoken label: tier by name, never by colour. */
    earned: (name: string, tier: string, date: string) => `${name}, ${tier} badge, earned ${date}`,
    locked: (name: string, tier: string) => `${name}, ${tier} badge, locked`,
  },
  share: 'Share',
  shareHint: 'Opens a card you can share',
  unknown: "This badge isn't in RoadWise.",
  back: 'Back',
  error: "Couldn't load your badges.",
  offlineEmpty: "You're offline, and no badges are saved on this phone yet.",
  retry: 'Try again',
} as const;
