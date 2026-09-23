/**
 * Which weekly goal is this week's — the one rule every screen uses (final review m5, m9). Pure.
 *
 * The week is the SERVER's: `weekStart` is `useCurrentWeekStart()` / `currentServerWeekStart()`
 * (Task 7), the Monday the account's zone is in, which around Monday midnight can differ from the
 * phone's. A goal is this week's when its `week_start` equals it.
 * - `null`: nothing says which week the server is in; the device's ISO week (`today`) is used.
 * - `undefined`: still loading; no goal is claimed as this week's (never a guess).
 *
 * Offline, before `open_my_week` has run, the newest goal can be last week's; it is never shown as
 * this week's unless the server's week says so.
 */
import type { RewardsSnapshot, WeeklyGoal } from '../api';
import { isoWeekStart } from '../viewModel';

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** The Monday that is "this week": the server's when known, the device's when not, none while loading. */
export function thisWeekStart(today: string, weekStart: string | null | undefined): string | null {
  if (weekStart === undefined) return null;
  return weekStart ?? isoWeekStart(today);
}

/** This week's goal and last week's, from the snapshot's two newest goals. */
export function goalWeeks(
  snapshot: Pick<RewardsSnapshot, 'currentGoal' | 'lastGoal'>,
  today: string,
  weekStart: string | null | undefined
): { thisWeek: WeeklyGoal | null; lastWeek: WeeklyGoal | null } {
  const week = thisWeekStart(today, weekStart);
  if (week === null) return { thisWeek: null, lastWeek: null };
  const previous = shiftDay(week, -7);
  const goals = [snapshot.currentGoal, snapshot.lastGoal].filter((g): g is WeeklyGoal => g !== null);
  return {
    thisWeek: goals.find((g) => g.week_start === week) ?? null,
    lastWeek: goals.find((g) => g.week_start === previous) ?? null,
  };
}

/** This week's goal, or null. */
export function currentWeekGoal(
  snapshot: Pick<RewardsSnapshot, 'currentGoal' | 'lastGoal'>,
  today: string,
  weekStart: string | null | undefined
): WeeklyGoal | null {
  return goalWeeks(snapshot, today, weekStart).thisWeek;
}
