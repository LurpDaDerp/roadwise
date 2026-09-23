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

/**
 * True of every day (final review m7): only a day CONFIRMED as unsafe restarts the streak — a drive
 * that reaches RoadWise after its day was confirmed (a late day) never does, and neither does any
 * day that is not confirmed. Days with no drive and the first (learning) days are never unsafe. No
 * claim about very short days: a short day with a severe event is unsafe.
 */
export const STREAK_RULE =
  "A day confirmed as unsafe restarts your streak unless a shield covers it. Days you don't drive and your first days never do.";

/** rev1: R-A; rev2 ("phones": true with a second signed-in phone). */
export const CONFIRM_RULE =
  "A day is confirmed after 2 am, once your phones have uploaded that day's drives — usually the next time you open RoadWise or drive, and never more than 3 days later. After that it doesn't change.";

/** The same words as M2's `earned.provisional`. */
export const SETTLE_RULE = 'Confirmed when the day closes.';

/** Shown over cached rewards while offline (the inbox's words). */
export const OFFLINE_LINE = "You're offline. This is what was saved on this phone.";

/** A lock timeout (`55P03`, rev1: R-G): the RPC can simply be tried again. */
export const BUSY_LINE = 'Busy right now. Try again.';

/**
 * The weekly goal's line while it is active (M5 T7 round 1, corrected by Task 9's review I1). The
 * proration sentence is true only while no day has failed: 0009's `settle_goals` achieves a short
 * week only with `fail_days = 0`, so after a failed day the line says the count and nothing more.
 * Never "N more days": nothing nudges more driving. Used by Task 9 (the goal screen) and Task 10
 * (Home), and by `goalView`'s `remainingText`.
 */
export function goalActiveLine(args: { pass: number; target: number; failDays: number; withCount?: true }): string;
export function goalActiveLine(args: {
  pass: number;
  target: number;
  failDays: number;
  withCount: boolean;
}): string | null;
/**
 * `withCount: false` (round 2) leaves "{pass} of {target} days so far." out, for a surface that shows
 * the count itself; after a failed day there is then nothing to say (null: no line).
 */
export function goalActiveLine({
  pass,
  target,
  failDays,
  withCount = true,
}: {
  pass: number;
  target: number;
  failDays: number;
  withCount?: boolean;
}): string | null {
  const proration = 'Drive fewer days this week? Keeping it up on each day you drive still counts.';
  if (pass === 0 && failDays === 0) return 'Counts from the days you drive this week.';
  const count = `${pass} of ${target} days so far.`;
  if (failDays === 0) return withCount ? `${count} ${proration}` : proration;
  return withCount ? count : null;
}

/** `goalView`'s line for a goal that is no longer active (M5 T7 ruling 1, verbatim). */
export const GOAL_PROGRESS = {
  achieved: 'Goal reached.',
  achievedProrated: 'Goal reached on every day you drove this week.',
  noDrives: "No drives this week — that's fine. A new goal starts with the new week.",
  ended: 'Not reached this week. A new goal starts with the new week.',
} as const;

/**
 * A day with drives that is not part of the rewards (`dayAward` → `not_counted`), and why. Never
 * "not settled yet": these days never will be.
 */
export const NOT_COUNTED = {
  title: "This day isn't part of your rewards.",
  /** `rewardsStart` is a `YYYY-MM-DD` day key. */
  beforeRewards: (rewardsStart: string) => `Rewards count from ${dayLabel(rewardsStart)}.`,
  afterConfirmed: 'A drive on this day reached RoadWise after the day was confirmed, so the day stays as it was.',
} as const;

/** "September 21, 2026" for a `YYYY-MM-DD` day key (a calendar date, not an instant). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  );
}

/** The one goal progress formatter the screens share: "2 of 4 driving days". */
export function goalProgressText(pass: number, target: number): string {
  return `${pass} of ${target} driving ${target === 1 ? 'day' : 'days'}`;
}
