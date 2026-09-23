/**
 * The weekly goal screen's words (F2's goal half, D6). Shared rewards words — the goal sentence,
 * the category labels, `FOCUS_APPLIED`, points and the offline and busy lines — come from
 * `./common` by reference and are not repeated here.
 *
 * Rules every string keeps (plan Global Constraints, honesty a–f; §10.11): a day is only counted
 * once it is confirmed ("Today counts when the day closes."); no deadline, countdown or pressure
 * words, no "!", no money words; not driving is never a failure ("No drives last week — that's
 * fine"); nothing asks the driver to drive more.
 */
import type { RewardsRpcCode } from '../api';
import { BUSY_LINE, pointsText } from './common';

const drivingDays = (n: number): string => `${n} driving ${n === 1 ? 'day' : 'days'}`;

export const goalCopy = {
  title: "This week's goal",
  loading: 'Loading your goal',
  focusLabel: 'Focus',
  progressLabel: 'Progress',
  /** "2 of 4 driving days": the printed line and the bar's value. */
  progress: (pass: number, target: number) => `${pass} of ${drivingDays(target)}`,
  /** What the progress bar says to a screen reader. */
  progressSpoken: (pass: number, target: number) => `${pass} of ${drivingDays(target)} counted`,
  /** The open day is never counted before it settles (rev1: R-A). */
  today: 'Today counts when the day closes.',
  /** D6 proration, verbatim at the target of 4. */
  prorate: (target: number) =>
    `Drive fewer than ${target} ${target === 1 ? 'day' : 'days'}? Keep it up on every day you drive and it still counts.`,
  pointsLabel: 'Points',
  /** Before it is reached: what reaching it adds — never shown as earned. */
  pointsWhenReached: (n: number) => `${pointsText(n)} when the goal is reached`,
  /** Once reached (a settled state). */
  pointsAdded: (n: number) => `${pointsText(n)} added`,
  lastWeekLabel: 'Last week',
  lastWeek: {
    achieved: (sentence: string) => `Reached: ${sentence}.`,
    achievedProrated: (sentence: string) => `Reached on every day you drove: ${sentence}.`,
    ended: (sentence: string) => `Not reached: ${sentence}.`,
    noDrives: "No drives last week — that's fine",
    /** Its Sunday has not settled yet, so the result is not known. */
    confirming: "Last week's result appears once its last days are confirmed.",
  },
  noGoal: {
    title: "This week's goal isn't set yet",
    body: 'It appears here the next time RoadWise is online.',
  },
  error: {
    message: "Couldn't load your goal.",
    retry: 'Try again',
  },
  changeFocus: 'Change focus',
  changeFocusHint: 'Choose what your weekly goal practises',
  picker: {
    title: 'Choose a focus',
    instruction:
      "Pick one thing to practise. If a day this week has already counted, it becomes next week's focus.",
    save: 'Save',
    done: 'Done',
    cancel: 'Cancel',
    errors: {
      offline: "You're offline. Choose a focus when you're back online.",
      busy: BUSY_LINE,
      limit: "You've changed your focus a lot today. Try again tomorrow.",
      invalid: "That focus isn't available. Choose another.",
      not_available: "Weekly goals aren't available on this account.",
      two_active: "Couldn't save your focus. Try again.",
      already_active: "Couldn't save your focus. Try again.",
      unknown: "Couldn't save your focus. Try again.",
    } satisfies Record<RewardsRpcCode, string>,
  },
} as const;
