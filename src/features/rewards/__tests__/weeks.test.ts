import { currentWeekGoal, goalWeeks } from '../goal/weeks';
import { goalRow } from '../__fixtures__/rows';

// Wednesday 2026-09-23: this week starts Monday 2026-09-21.
const TODAY = '2026-09-23';

describe('the one "this week\'s goal" rule (final review m5)', () => {
  test('the newest goal is this week\'s only when its week is this ISO week', () => {
    expect(currentWeekGoal({ currentGoal: goalRow('2026-09-21'), lastGoal: goalRow('2026-09-14') }, TODAY)?.week_start).toBe(
      '2026-09-21'
    );
    // Offline before the week is opened: the newest is last week's, never claimed as this week's.
    expect(currentWeekGoal({ currentGoal: goalRow('2026-09-14'), lastGoal: null }, TODAY)).toBeNull();
    expect(currentWeekGoal({ currentGoal: null, lastGoal: null }, TODAY)).toBeNull();
  });

  test('goalWeeks pairs this week and last week, and a Monday or a Sunday is still the same week', () => {
    const snap = { currentGoal: goalRow('2026-09-21'), lastGoal: goalRow('2026-09-14') };
    expect(goalWeeks(snap, '2026-09-21').lastWeek?.week_start).toBe('2026-09-14');
    expect(goalWeeks(snap, '2026-09-27').thisWeek?.week_start).toBe('2026-09-21');
    expect(goalWeeks(snap, '2026-09-28').thisWeek).toBeNull();
    expect(goalWeeks(snap, '2026-09-28').lastWeek?.week_start).toBe('2026-09-21');
  });
});
