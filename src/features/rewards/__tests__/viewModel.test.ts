import { BANNED_COPY } from '@/notifications/catalog';

import {
  challengeView,
  classView,
  dayAward,
  goalView,
  isoWeekStart,
  nextBadge,
  streakView,
} from '../viewModel';
import { badgeDefRows, badgeRow, challengeDefRows, enrolmentRow, goalRow, progressRow, rewardDayRow } from '../__fixtures__/rows';

describe('classView: the class boundaries (levelFor)', () => {
  test.each([
    [0, 1, 'Learner', 'Steady', 1500],
    [1499, 1, 'Learner', 'Steady', 1],
    [1500, 2, 'Steady', 'Smooth', 2500],
    [3999, 2, 'Steady', 'Smooth', 1],
    [4000, 3, 'Smooth', 'Focused', 4000],
    [8000, 4, 'Focused', 'Road-wise', 7000],
    [15000, 5, 'Road-wise', 'Mentor', 10000],
    [25000, 6, 'Mentor', null, null],
    [99999, 6, 'Mentor', null, null],
  ] as const)('xp %i → level %i %s', (xp, level, name, nextName, toNext) => {
    const v = classView(progressRow({ xp, points: xp }));
    expect(v).toMatchObject({ level, name, nextName, toNext, xp });
  });

  test('no progress yet: Learner, 0', () => {
    expect(classView(null)).toMatchObject({ level: 1, name: 'Learner', xp: 0, toNext: 1500, fraction: 0 });
  });
});

describe('streakView', () => {
  test('days, best, shields', () => {
    expect(streakView(progressRow({ streak_days: 12, best_streak: 30, shields: 2 }))).toEqual({
      days: 12,
      best: 30,
      shields: 2,
      restarted: false,
    });
  });

  test('restarted = days 0 with a best above 0', () => {
    expect(streakView(progressRow({ streak_days: 0, best_streak: 9 })).restarted).toBe(true);
    expect(streakView(progressRow({ streak_days: 0, best_streak: 0 })).restarted).toBe(false);
    expect(streakView(null)).toEqual({ days: 0, best: 0, shields: 0, restarted: false });
  });
});

describe('goalView', () => {
  test('active, part way', () => {
    const v = goalView(goalRow('2026-09-21', { category: 'braking', pass_days: 1, fail_days: 1 }));
    expect(v).toMatchObject({
      category: 'braking',
      target: 4,
      pass: 1,
      fail: 1,
      drivingDays: 2,
      state: 'active',
      prorated: false,
      points: 150,
    });
    expect(v.remainingText).toBe('3 more driving days to reach it.');
  });

  test('one more day says "day"', () => {
    expect(goalView(goalRow('2026-09-21', { pass_days: 3 })).remainingText).toBe('1 more driving day to reach it.');
  });

  test('achieved in full, and prorated ("every day you drove")', () => {
    expect(goalView(goalRow('2026-09-21', { state: 'achieved', pass_days: 4 })).remainingText).toBe('Goal reached.');
    expect(
      goalView(goalRow('2026-09-21', { state: 'achieved', pass_days: 2, prorated: true })).remainingText
    ).toBe('Goal reached on every day you drove this week.');
  });

  test('no drives and ended: no penalty wording, no guilt', () => {
    expect(goalView(goalRow('2026-09-21', { state: 'no_drives', pass_days: 0 })).remainingText).toBe(
      "You didn't drive this week, so this goal didn't count."
    );
    expect(goalView(goalRow('2026-09-21', { state: 'ended', pass_days: 2, fail_days: 3 })).remainingText).toBe(
      'This week has closed. A new goal starts with the new week.'
    );
  });

  test('every remaining text passes BANNED_COPY and names no deadline', () => {
    const texts = [
      goalView(goalRow('w', { pass_days: 0 })).remainingText,
      goalView(goalRow('w', { pass_days: 3 })).remainingText,
      goalView(goalRow('w', { state: 'achieved', pass_days: 4 })).remainingText,
      goalView(goalRow('w', { state: 'achieved', prorated: true })).remainingText,
      goalView(goalRow('w', { state: 'no_drives' })).remainingText,
      goalView(goalRow('w', { state: 'ended' })).remainingText,
    ];
    for (const t of texts) {
      for (const re of BANNED_COPY) expect(re.test(t)).toBe(false);
      expect(t).not.toMatch(/left to|hurry|expires|days? left/i);
    }
  });
});

describe('challengeView', () => {
  const defs = challengeDefRows();
  test('an active enrolment against its def', () => {
    const def = defs.find((d) => d.id === 'phone_down')!;
    expect(challengeView(enrolmentRow('phone_down', { pass_days: 6, fail_days: 2 }), def)).toMatchObject({
      defId: 'phone_down',
      predicate: 'phone',
      target: 10,
      window: 14,
      pass: 6,
      fail: 2,
      drivingDays: 8,
      toTarget: 4,
      state: 'active',
      points: 200,
    });
  });

  test('completed: nothing to go', () => {
    const def = defs.find((d) => d.id === 'safe_run')!;
    expect(challengeView(enrolmentRow('safe_run', { state: 'completed', pass_days: 7 }), def).toTarget).toBe(0);
  });
});

describe('nextBadge: the unearned badge with the highest metric/threshold below 1', () => {
  const defs = badgeDefRows();

  test('picks the closest', () => {
    // safe 12/30 = .4 (safe_days_7 earned), phone-free 8/10 = .8, smooth 5/7 = .71
    const next = nextBadge(progressRow({ safe_days: 12, phone_free_days: 8, smooth_days: 5 }), defs, [badgeRow('safe_days_7')]);
    expect(next).toMatchObject({ def: { id: 'phone_free_days_10' }, current: 8, threshold: 10 });
    expect(next?.fraction).toBeCloseTo(0.8);
  });

  test('earned badges are skipped, and a counter already past the threshold (not yet settled) is not "next"', () => {
    const next = nextBadge(
      progressRow({ safe_days: 30, phone_free_days: 0, smooth_days: 0, goals_achieved: 0, challenges_completed: 0, referrals_rewarded: 0 }),
      defs,
      [badgeRow('safe_days_7')]
    );
    // safe_days_30 reads 30/30 = 1 (earned at the next settlement): not below 1, so safe_days_100 (.3)
    expect(next?.def.id).toBe('safe_days_100');
  });

  test('a tie goes to the first in display order', () => {
    const next = nextBadge(
      progressRow({ safe_days: 0, phone_free_days: 0, smooth_days: 0, goals_achieved: 0, challenges_completed: 0, referrals_rewarded: 0 }),
      defs,
      []
    );
    expect(next?.def.id).toBe('safe_days_7');
  });

  test('every badge earned: null; no progress: counters read 0', () => {
    expect(nextBadge(progressRow(), defs, defs.map((d) => badgeRow(d.id)))).toBeNull();
    expect(nextBadge(null, defs, [])?.def.id).toBe('safe_days_7');
  });

  test('the metric maps to its progress counter', () => {
    const only = defs.filter((d) => d.metric === 'weekly_goals');
    expect(nextBadge(progressRow({ goals_achieved: 3 }), only, [badgeRow('weekly_goals_1')])).toMatchObject({
      def: { id: 'weekly_goals_5' },
      current: 3,
    });
  });
});

describe('dayAward', () => {
  test('a day not settled → settled: false', () => {
    expect(dayAward(null)).toEqual({ settled: false });
  });

  test('a settled day carries its tier, bonuses, points and streak', () => {
    expect(dayAward(rewardDayRow('2026-09-22', { tier: 'good', phone_free: false, camera: true, points: 30, streak_after: 4 }))).toEqual({
      settled: true,
      tier: 'good',
      phoneFree: false,
      camera: true,
      points: 30,
      streakAfter: 4,
    });
  });

  test('settled with nothing earned is still settled', () => {
    expect(dayAward(rewardDayRow('2026-09-22', { tier: 'none', phone_free: false, points: 0 }))).toMatchObject({
      settled: true,
      tier: 'none',
      points: 0,
    });
  });
});

describe('isoWeekStart', () => {
  test.each([
    ['2026-09-21', '2026-09-21'], // Monday
    ['2026-09-23', '2026-09-21'], // Wednesday
    ['2026-09-27', '2026-09-21'], // Sunday
    ['2026-09-28', '2026-09-28'],
    ['2027-01-01', '2026-12-28'], // across a year
  ])('%s → %s', (day, start) => {
    expect(isoWeekStart(day)).toBe(start);
  });
});
