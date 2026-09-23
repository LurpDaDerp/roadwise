/**
 * F1 · Rewards hub copy (M5 Task 8). Shared rules (`NOT_MONEY`, `STREAK_RULE`, `CONFIRM_RULE`,
 * `SETTLE_RULE`, `OFFLINE_LINE`) come from `copy/common.ts`; this file holds only the hub's own
 * words.
 *
 * Every string keeps the plan's honesty rules: nothing is earned before a day is confirmed, points
 * are never money or anything redeemable, no pressure and no "!", the streak is never "days in a
 * row", no nudge to drive, and nothing promises a store, leaderboard or crew.
 */
import { LEVELS, REWARDS } from '@scoring';

import { CONFIRM_RULE, NOT_MONEY, SETTLE_RULE, STREAK_RULE } from './common';

const n = (value: number) => new Intl.NumberFormat('en-US').format(value);
const P = REWARDS.POINTS;

/** "Learner, then Steady, Smooth, Focused, Road-wise and Mentor", from the shared `LEVELS`. */
const [firstClass, ...laterClasses] = LEVELS.map((l) => l.name);
const classList =
  laterClasses.length === 0
    ? `${firstClass}`
    : `${firstClass}, then ${laterClasses.slice(0, -1).join(', ')}${laterClasses.length > 1 ? ' and ' : ''}${laterClasses[laterClasses.length - 1]}`;

export const hubCopy = {
  title: 'Rewards',

  fields: {
    points: 'Points',
    class: 'Class',
    streak: 'Streak',
  },

  points: {
    spoken: (value: number) => `${n(value)} ${value === 1 ? 'point' : 'points'}`,
  },

  class: {
    /** "1,100 to Smooth" */
    toNext: (toNext: number, next: string) => `${n(toNext)} to ${next}`,
    top: 'Top class',
    spoken: (name: string, toNext: number | null, next: string | null) =>
      toNext === null || next === null
        ? `Class ${name}, the top class`
        : `Class ${name}, ${n(toNext)} ${toNext === 1 ? 'point' : 'points'} to ${next}`,
  },

  streak: {
    unit: (days: number) => (days === 1 ? 'day' : 'days'),
    shields: (count: number) => `${count} ${count === 1 ? 'shield' : 'shields'}`,
    best: (best: number) => `Best ${n(best)}`,
    spoken: (days: number, shields: number, best: number | null) =>
      [
        `Streak ${n(days)} ${days === 1 ? 'day' : 'days'}`,
        shields > 0 ? `${shields} ${shields === 1 ? 'shield' : 'shields'}` : null,
        best === null ? null : `best ${n(best)}`,
      ]
        .filter(Boolean)
        .join(', '),
  },

  /** Today, from the day row so far. Never an instruction: it describes, it never asks for a drive. */
  today: {
    safe: `Today looks like a safe day so far. ${SETTLE_RULE}`,
    good: `Today looks like a good day so far. ${SETTLE_RULE}`,
    notSafe: `Today isn't a safe day so far. ${SETTLE_RULE}`,
    /** A day whose only drives were deleted: they still count against it (D2), so never "no drive". */
    deleted: `Today isn't a safe day so far: its drives were deleted. ${SETTLE_RULE}`,
  },

  newUser: 'Earn your first points with a scored drive. Safe days count once the day closes.',

  goal: {
    title: "This week's goal",
    offline: "Your weekly goal appears when you're online.",
    opening: "This week's goal isn't set yet.",
  },

  challenges: {
    title: 'Challenges',
    /** Task 9's words for the same numbers ("driving days" would read as the window). */
    progress: (pass: number, target: number) => `${pass} of ${target} days counted`,
  },

  nextBadge: (text: string) => `Next badge: ${text}`,

  links: {
    badges: 'Badges',
    challenges: 'Challenges',
    invite: 'Invite friends',
  },

  findChallenge: 'Find a challenge',

  error: "Couldn't load your rewards.",
  offlineEmpty: "You're offline, and no rewards are saved on this phone yet.",
  retry: 'Try again',

  how: {
    title: 'How rewards work',
    hintOpen: 'Shows how points, streaks and goals work',
    hintClose: 'Hides the explanation',
    /** §R1–§R5 in plain words, then the rules every screen shares. */
    paragraphs: [
      `Each confirmed day earns points for how you drove that day: ${P.safeDay} for a safe day or ${P.goodDay} for a good day. On days you drive at least ${REWARDS.MIN_DRIVING_S / 60} minutes, no phone use adds ${P.phoneFreeDay} and the camera on adds ${P.cameraDay}. A weekly goal adds ${P.weeklyGoal}, and a finished challenge adds its own points. Daily points never count miles or the number of drives.`,
      NOT_MONEY,
      `Your class follows your points: ${classList}. Points you've earned are never taken back.`,
      `${STREAK_RULE} Every ${REWARDS.SHIELD_EVERY_SAFE_DAYS}th safe day adds a shield, and you can hold ${REWARDS.SHIELD_MAX}.`,
      `Each week has one goal in one area, for ${REWARDS.WEEKLY_GOAL_TARGET_DAYS} driving days. If you drive on fewer days, it still counts when every day you drove met it.`,
      CONFIRM_RULE,
      'Nothing is earned while you drive; everything shows up after the day is confirmed.',
    ],
  },
} as const;
