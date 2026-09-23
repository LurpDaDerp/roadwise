/**
 * F2 Challenges' words (D7: personal challenges counted in driving days, from the day after
 * joining, at most two at once). Shared words — category labels, points, the offline and busy
 * lines — come from `./common`.
 *
 * Rules every string keeps (plan Global Constraints, honesty a–f; §10.1, §10.4, §10.11): a
 * challenge is counted in driving days, so there is no countdown, deadline or "hurry"; not
 * driving never counts against it; a day counts only once it is confirmed, and then it is final
 * (rev1: R-A); no "!", no money words; speed is framed as time within the limit.
 */
import type { PredicateKey, RewardsRpcCode } from '../api';
import { BUSY_LINE, pointsText } from './common';

const drivingDays = (n: number): string => `${n} driving ${n === 1 ? 'day' : 'days'}`;

/** What a challenge asks, by the day predicate it counts. */
const ASK: Readonly<Record<PredicateKey, string>> = {
  phone: 'Keep your phone down',
  speeding: 'Stay within the limit',
  braking: 'Brake smoothly',
  accel: 'Accelerate smoothly',
  cornering: 'Corner steadily',
  smooth: 'Drive smoothly',
  safe: 'Have a safe day',
};

export const challengesCopy = {
  title: 'Challenges',
  loading: 'Loading challenges',
  tabsLabel: 'Challenge lists',
  tabs: { active: 'Active', discover: 'Discover', done: 'Done' },
  /** A def's name (the four seeded in 0010); an unknown id falls back to its predicate's label. */
  names: {
    phone_down: 'Phone down',
    within_limit: 'Within the limit',
    smooth_ride: 'Smooth ride',
    safe_run: 'Safe run',
  } as Readonly<Record<string, string>>,
  /** "Keep your phone down on 10 of 14 driving days". */
  sentence: (predicate: PredicateKey, target: number, window: number) =>
    `${ASK[predicate]} on ${target} of ${drivingDays(window)}`,
  suggested: 'Suggested for you',
  running: 'Running',
  completed: 'Completed',
  ended: 'Ended',
  /** "6 of 10 · 4 driving days left" (days to drive in the window, not time). */
  progress: (pass: number, target: number, remaining: number) => `${pass} of ${target} · ${drivingDays(remaining)} left`,
  progressSpoken: (pass: number, target: number, remaining: number) =>
    `${pass} of ${target} days counted, ${drivingDays(remaining)} left`,
  progressLabel: 'Progress',
  rulesLabel: 'How it counts',
  /** rev1: R-A. Shown before joining: counting starts the day after. */
  rules:
    "Counts the days you drive, starting tomorrow. Days you don't drive, very short days and your first days are skipped: they don't use up the challenge. A day counts once it's confirmed, and then it's final.",
  /** The same rule for a challenge already joined, from its first counted day. */
  rulesFrom: (date: string) =>
    `Counts the days you drive, from ${date}. Days you don't drive, very short days and your first days are skipped: they don't use up the challenge. A day counts once it's confirmed, and then it's final.`,
  fairness: 'No extra driving needed: every driver gets the same number of days.',
  pointsLabel: 'Points',
  pointsOnComplete: (n: number) => `${pointsText(n)} when it's complete`,
  pointsAdded: (n: number) => `${pointsText(n)} added`,
  startsTomorrow: 'Counting starts tomorrow.',
  completedOn: (date: string) => `Completed on ${date}.`,
  /** "Ended after 14 driving days with 8 that met it." */
  endedAfter: (drivingDaysCounted: number, pass: number) =>
    `Ended after ${drivingDays(drivingDaysCounted)} with ${pass} that met it.`,
  leftNote: 'You left this challenge.',
  join: 'Join',
  joinAgain: 'Join again',
  leave: 'Leave',
  joined: "You're in.",
  twoActive: 'You can run two challenges at a time',
  joinOffline: "You're offline. You can join when you're back online.",
  leaveOffline: "You're offline. You can leave when you're back online.",
  leaveConfirm: {
    title: 'Leave this challenge?',
    body: "Days counted so far won't carry over.",
    stay: 'Stay',
    leave: 'Leave',
  },
  notFound: "This challenge isn't available.",
  error: {
    message: "Couldn't load challenges.",
    retry: 'Try again',
  },
  empty: {
    active: {
      title: 'No challenges running',
      body: 'Pick one to practise alongside your weekly goal.',
      action: 'Discover challenges',
    },
    done: {
      title: 'Nothing finished yet',
      body: 'Completed and ended challenges are kept here.',
      action: 'Discover challenges',
    },
  },
  joinErrors: {
    offline: "You're offline. You can join when you're back online.",
    busy: BUSY_LINE,
    limit: "You've joined a lot of challenges today. Try again tomorrow.",
    invalid: "This challenge isn't available right now.",
    not_available: "Challenges aren't available on this account.",
    two_active: 'You can run two challenges at a time',
    already_active: "You're already running this challenge.",
    unknown: "Couldn't join. Try again.",
  } satisfies Record<RewardsRpcCode, string>,
  leaveErrors: {
    offline: "You're offline. You can leave when you're back online.",
    busy: BUSY_LINE,
    limit: "Couldn't leave. Try again.",
    invalid: "Couldn't leave. Try again.",
    not_available: "This challenge isn't running any more.",
    two_active: "Couldn't leave. Try again.",
    already_active: "Couldn't leave. Try again.",
    unknown: "Couldn't leave. Try again.",
  } satisfies Record<RewardsRpcCode, string>,
} as const;

/** A def's display name. */
export function challengeName(defId: string, predicate: PredicateKey, labels: Readonly<Record<PredicateKey, string>>): string {
  return challengesCopy.names[defId] ?? labels[predicate];
}
