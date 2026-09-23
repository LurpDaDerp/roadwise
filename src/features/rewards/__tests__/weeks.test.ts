import { currentWeekGoal, goalWeeks, thisWeekStart } from '../goal/weeks';
import { currentServerWeekStart } from '../useEnsureWeek';
import { goalRow } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

// Wednesday 2026-09-23: this device week starts Monday 2026-09-21.
const TODAY = '2026-09-23';

describe('the one "this week\'s goal" rule (final review m5, m9)', () => {
  test('with the server week unknown (null), the device\'s ISO week decides', () => {
    expect(currentWeekGoal({ currentGoal: goalRow('2026-09-21'), lastGoal: goalRow('2026-09-14') }, TODAY, null)?.week_start).toBe(
      '2026-09-21'
    );
    // Offline before the week is opened: the newest is last week's, never claimed as this week's.
    expect(currentWeekGoal({ currentGoal: goalRow('2026-09-14'), lastGoal: null }, TODAY, null)).toBeNull();
    expect(currentWeekGoal({ currentGoal: null, lastGoal: null }, TODAY, null)).toBeNull();
  });

  test('still loading (undefined): no goal is claimed, not a guess', () => {
    expect(thisWeekStart(TODAY, undefined)).toBeNull();
    expect(currentWeekGoal({ currentGoal: goalRow('2026-09-21'), lastGoal: null }, TODAY, undefined)).toBeNull();
    expect(goalWeeks({ currentGoal: goalRow('2026-09-21'), lastGoal: goalRow('2026-09-14') }, TODAY, undefined)).toEqual({
      thisWeek: null,
      lastWeek: null,
    });
  });

  test('the server week wins over the device week, and last week is the week before it', () => {
    const snap = { currentGoal: goalRow('2026-09-21'), lastGoal: goalRow('2026-09-14') };
    // The server is still in the week of the 14th: that goal is this week's, and the 7th's last.
    expect(goalWeeks(snap, TODAY, '2026-09-14')).toEqual({ thisWeek: snap.lastGoal, lastWeek: null });
    expect(goalWeeks(snap, TODAY, '2026-09-21')).toEqual({ thisWeek: snap.currentGoal, lastWeek: snap.lastGoal });
  });
});

describe('a phone and an account in different zones at Monday midnight (composed with Task 7)', () => {
  test('phone AHEAD (Kiritimati, UTC+14), account in UTC: at the phone\'s Monday 00:30 last week\'s goal is still this week\'s', () => {
    // Monday 2026-09-28 00:30 in Kiritimati = Sunday 2026-09-27 10:30 UTC: the server is in the week of the 21st.
    const now = Date.parse('2026-09-27T10:30:00Z');
    const snap = { currentGoal: goalRow('2026-09-21', { state: 'active', pass_days: 2 }), lastGoal: goalRow('2026-09-14') };
    const serverWeek = currentServerWeekStart(snap, { now, zone: 'Pacific/Kiritimati' });
    expect(serverWeek).toBe('2026-09-21');
    const phoneToday = '2026-09-28';
    expect(currentWeekGoal(snap, phoneToday, serverWeek)?.week_start).toBe('2026-09-21');
    // Control: judged in the phone's week alone, the account's live goal would vanish.
    expect(currentWeekGoal(snap, phoneToday, null)).toBeNull();
  });

  test('phone BEHIND (Pago Pago, UTC-11), account in UTC: the server\'s Monday goal shows on the phone\'s Sunday', () => {
    // Sunday 2026-09-27 14:00 in Pago Pago = Monday 2026-09-28 01:00 UTC: the server opened the 28th's goal.
    const now = Date.parse('2026-09-28T01:00:00Z');
    const snap = { currentGoal: goalRow('2026-09-28', { pass_days: 0 }), lastGoal: goalRow('2026-09-21') };
    const serverWeek = currentServerWeekStart(snap, { now, zone: 'Pacific/Pago_Pago' });
    expect(serverWeek).toBe('2026-09-28');
    const phoneToday = '2026-09-27';
    expect(currentWeekGoal(snap, phoneToday, serverWeek)?.week_start).toBe('2026-09-28');
    expect(goalWeeks(snap, phoneToday, serverWeek).lastWeek?.week_start).toBe('2026-09-21');
    // Control: the phone's own week would show last week's goal as this week's.
    expect(currentWeekGoal(snap, phoneToday, null)?.week_start).toBe('2026-09-21');
  });
});
