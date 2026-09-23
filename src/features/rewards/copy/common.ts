/**
 * Rewards copy shared by several screens (Tasks 8–13 import it by path). Screen-specific strings
 * live in each screen's own copy module.
 *
 * Rules every string here keeps (plan Global Constraints, honesty a–f): nothing is called earned
 * before it is settled ("Confirmed when the day closes."); points are never money, worth or
 * anything redeemable — the one sentence that names money does so to deny it (`NOT_MONEY`); no
 * pressure, no "!"; the streak is never "days in a row"; nothing says a confirmed day will change.
 */
import type { PredicateKey } from '../api';

/** The goal categories and challenge predicates, as labels. */
export const CATEGORY_LABEL: Readonly<Record<PredicateKey, string>> = {
  phone: 'No phone use',
  speeding: 'Within the limit',
  braking: 'Smooth braking',
  accel: 'Smooth acceleration',
  cornering: 'Steady cornering',
  smooth: 'Smooth driving',
  safe: 'Safe days',
};

const days = (n: number): string => `${n} driving ${n === 1 ? 'day' : 'days'}`;

/** The weekly goal as one sentence (speed framed as time within the limit, §10.4). */
export function goalSentence(category: 'phone' | 'speeding' | 'braking' | 'accel' | 'cornering', target: number): string {
  switch (category) {
    case 'phone':
      return `Keep your phone down on ${days(target)}`;
    case 'speeding':
      return `Stay within the limit on ${days(target)}`;
    case 'braking':
      return `Brake smoothly on ${days(target)}`;
    case 'accel':
      return `Accelerate smoothly on ${days(target)}`;
    case 'cornering':
      return `Corner steadily on ${days(target)}`;
  }
}

/** Where a chosen focus applied (`set_weekly_focus`'s `applied`). */
export const FOCUS_APPLIED = {
  this_week: 'This is your focus this week.',
  next_week: 'This will be your focus next week — this week already has days counted.',
} as const;

/** A settled day's tier (`reward_days.tier`). */
export const DAY_TIER_LABEL = { safe: 'Safe day', good: 'Good day', none: 'No points' } as const;

/** A badge's tier (`badge_defs.tier`); never shown by colour alone. */
export const BADGE_TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' } as const;

/** "1,250 points", "1 point". */
export function pointsText(n: number): string {
  return `${new Intl.NumberFormat('en-US').format(n)} ${n === 1 ? 'point' : 'points'}`;
}

/** Honesty b (the plan's own sentence; a counsel-list item). */
export const NOT_MONEY = "Points track your progress in RoadWise. They aren't money.";

/** rev1: R-I m7 — true of every case: short and learning days neither count nor restart it. */
export const STREAK_RULE =
  "A day with an unsafe drive restarts your streak unless a shield covers it. Days you don't drive, very short days and your first days never do.";

/** rev1: R-A; rev2 ("phones": true with a second signed-in phone). */
export const CONFIRM_RULE =
  "A day is confirmed after 2 am, once your phones have uploaded that day's drives — usually the next time you open RoadWise or drive, and never more than 3 days later. After that it doesn't change.";

/** The same words as M2's `earned.provisional`. */
export const SETTLE_RULE = 'Confirmed when the day closes.';

/** Shown over cached rewards while offline (the inbox's words). */
export const OFFLINE_LINE = "You're offline. This is what was saved on this phone.";

/** A lock timeout (`55P03`, rev1: R-G): the RPC can simply be tried again. */
export const BUSY_LINE = 'Busy right now. Try again.';

/** `goalView`'s progress line, by state. */
export const GOAL_PROGRESS = {
  toGo: (n: number) => `${n} more ${n === 1 ? 'driving day' : 'driving days'} to reach it.`,
  achieved: 'Goal reached.',
  achievedProrated: 'Goal reached on every day you drove this week.',
  noDrives: "You didn't drive this week, so this goal didn't count.",
  ended: 'This week has closed. A new goal starts with the new week.',
} as const;
