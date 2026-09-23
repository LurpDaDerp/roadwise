/**
 * Which weekly goal is this week's — the one rule every screen uses (final review m5). Pure.
 *
 * The snapshot's newest goal is this week's only when its `week_start` is this week's Monday
 * (T7 concern 4): offline, before `open_my_week` has run, it is still last week's and must never
 * be shown as this week's. `today` is the caller's day key.
 */
import type { RewardsSnapshot, WeeklyGoal } from '../api';
import { isoWeekStart } from '../viewModel';

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** This week's goal and last week's, by ISO week, from the snapshot's two newest goals. */
export function goalWeeks(
  snapshot: Pick<RewardsSnapshot, 'currentGoal' | 'lastGoal'>,
  today: string
): { thisWeek: WeeklyGoal | null; lastWeek: WeeklyGoal | null } {
  const week = isoWeekStart(today);
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
  today: string
): WeeklyGoal | null {
  return goalWeeks(snapshot, today).thisWeek;
}
