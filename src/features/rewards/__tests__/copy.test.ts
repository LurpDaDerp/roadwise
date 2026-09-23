import { BANNED_COPY } from '@/notifications/catalog';

import * as common from '../copy/common';

const {
  BADGE_TIER_LABEL,
  BUSY_LINE,
  CATEGORY_LABEL,
  GOAL_PROGRESS,
  goalActiveLine,
  CONFIRM_RULE,
  DAY_TIER_LABEL,
  FOCUS_APPLIED,
  goalSentence,
  NOT_MONEY,
  OFFLINE_LINE,
  pointsText,
  SETTLE_RULE,
  STREAK_RULE,
} = common;

describe('the briefed strings, verbatim', () => {
  test('category labels', () => {
    expect(CATEGORY_LABEL).toEqual({
      phone: 'No phone use',
      speeding: 'Within the limit',
      braking: 'Smooth braking',
      accel: 'Smooth acceleration',
      cornering: 'Steady cornering',
      smooth: 'Smooth driving',
      safe: 'Safe days',
    });
  });

  test.each([
    ['phone', 'Keep your phone down on 4 driving days'],
    ['speeding', 'Stay within the limit on 4 driving days'],
    ['braking', 'Brake smoothly on 4 driving days'],
    ['accel', 'Accelerate smoothly on 4 driving days'],
    ['cornering', 'Corner steadily on 4 driving days'],
  ] as const)('goalSentence %s', (category, sentence) => {
    expect(goalSentence(category, 4)).toBe(sentence);
  });

  test('goalSentence with one day says "day"', () => {
    expect(goalSentence('phone', 1)).toBe('Keep your phone down on 1 driving day');
  });

  test('FOCUS_APPLIED', () => {
    expect(FOCUS_APPLIED).toEqual({
      this_week: 'This is your focus this week.',
      next_week: 'This will be your focus next week — this week already has days counted.',
    });
  });

  test('pointsText', () => {
    expect(pointsText(1250)).toBe('1,250 points');
    expect(pointsText(1)).toBe('1 point');
    expect(pointsText(0)).toBe('0 points');
  });

  test('the rules', () => {
    expect(NOT_MONEY).toBe("Points track your progress in RoadWise. They aren't money.");
    expect(STREAK_RULE).toBe(
      "A day confirmed as unsafe restarts your streak unless a shield covers it. Days you don't drive and your first days never do."
    );
    // final review m7: scoped to confirmed days, and no claim about short days (a short day with a
    // severe event is unsafe)
    expect(STREAK_RULE).toMatch(/confirmed as unsafe/);
    expect(STREAK_RULE).not.toMatch(/short/i);
    expect(CONFIRM_RULE).toBe(
      "A day is confirmed after 2 am, once your phones have uploaded that day's drives — usually the next time you open RoadWise or drive, and never more than 3 days later. After that it doesn't change."
    );
    expect(SETTLE_RULE).toBe('Confirmed when the day closes.');
  });

  test("SETTLE_RULE is M2's earned.provisional, word for word", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tripCopy } = require('@/features/trips/copy') as typeof import('@/features/trips/copy');
    expect(tripCopy.earned.provisional).toBe(SETTLE_RULE);
  });

  test('tier labels', () => {
    expect(DAY_TIER_LABEL).toEqual({ safe: 'Safe day', good: 'Good day', none: 'No points' });
    expect(BADGE_TIER_LABEL).toEqual({ bronze: 'Bronze', silver: 'Silver', gold: 'Gold' });
  });
});

/** Every string the module exports, functions sampled. */
function allStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const value of Object.values(common)) {
    if (typeof value === 'function') continue;
    walk(value);
  }
  for (const c of ['phone', 'speeding', 'braking', 'accel', 'cornering'] as const) out.push(goalSentence(c, 4));
  out.push(
    pointsText(1250),
    pointsText(1),
    goalActiveLine({ pass: 0, target: 4, failDays: 0 }),
    goalActiveLine({ pass: 2, target: 4, failDays: 0 }),
    goalActiveLine({ pass: 1, target: 4, failDays: 1 })
  );
  return out;
}

describe('BANNED_COPY (no money words, no pressure, no "!")', () => {
  test('every common string passes', () => {
    const strings = allStrings();
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) for (const re of BANNED_COPY) expect([s, re.test(s)]).toEqual([s, false]);
  });

  test('NOT_MONEY passes through its one exact allowance; any other "money" still fails (ruling 2)', () => {
    const money = (text: string) => BANNED_COPY.some((re) => re.test(text));
    expect(money(NOT_MONEY)).toBe(false);
    for (const other of [
      'Points are like money.',
      "They aren't money.",
      "Points track your progress in RoadWise. They aren't money, they're better.",
      'Earn money with RoadWise.',
      "Points track your progress in RoadWise. They aren't moneyish.",
      "Points track your progress. They aren't money.",
      `${NOT_MONEY} Save money on insurance.`,
    ]) {
      expect([other, money(other)]).toEqual([other, true]);
    }
  });

  test('no goal line nudges more driving (ruling 1)', () => {
    const lines = [
      goalActiveLine({ pass: 0, target: 4, failDays: 0 }),
      goalActiveLine({ pass: 3, target: 4, failDays: 0 }),
      goalActiveLine({ pass: 1, target: 4, failDays: 2 }),
      ...Object.values(GOAL_PROGRESS),
    ];
    for (const s of lines) expect(s).not.toMatch(/more (driving )?days?\b/i);
    expect(GOAL_PROGRESS).not.toHaveProperty('toGo');
  });

  describe('goalActiveLine withCount: false (round 2)', () => {
    test('pass 0, fail 0: the counts-from line', () => {
      expect(goalActiveLine({ pass: 0, target: 4, failDays: 0, withCount: false })).toBe(
        'Counts from the days you drive this week.'
      );
    });
    test('fail 0: the proration sentence alone, no count', () => {
      const line = goalActiveLine({ pass: 2, target: 4, failDays: 0, withCount: false });
      expect(line).toBe('Drive fewer days this week? Keeping it up on each day you drive still counts.');
      expect(line).not.toMatch(/of 4/);
    });
    test('fail > 0: no line at all', () => {
      expect(goalActiveLine({ pass: 1, target: 4, failDays: 1, withCount: false })).toBeNull();
      expect(goalActiveLine({ pass: 0, target: 4, failDays: 2, withCount: false })).toBeNull();
      // negative control: with the count (the default, or explicit), the count stays
      expect(goalActiveLine({ pass: 1, target: 4, failDays: 1 })).toBe('1 of 4 days so far.');
      expect(goalActiveLine({ pass: 1, target: 4, failDays: 1, withCount: true })).toBe('1 of 4 days so far.');
    });
  });

  describe('goalActiveLine (Task 9 review I1: proration only while no day has failed)', () => {
    const PRORATION = /Drive fewer days this week\? Keeping it up on each day you drive still counts\./;

    test('nothing counted yet', () => {
      expect(goalActiveLine({ pass: 0, target: 4, failDays: 0 })).toBe('Counts from the days you drive this week.');
    });

    test('pass 2, fail 0: the proration sentence is there', () => {
      const line = goalActiveLine({ pass: 2, target: 4, failDays: 0 });
      expect(line).toBe('2 of 4 days so far. Drive fewer days this week? Keeping it up on each day you drive still counts.');
      expect(line).toMatch(PRORATION);
    });

    test('pass 1, fail 1: the count only, no proration sentence', () => {
      const line = goalActiveLine({ pass: 1, target: 4, failDays: 1 });
      expect(line).toBe('1 of 4 days so far.');
      expect(line).not.toMatch(PRORATION);
      expect(line).not.toMatch(/fewer|still counts/i);
    });

    test('pass 0, fail 1: the count, not "counts from" and not the proration sentence', () => {
      const line = goalActiveLine({ pass: 0, target: 4, failDays: 1 });
      expect(line).toBe('0 of 4 days so far.');
      expect(line).not.toMatch(PRORATION);
    });
  });

  test('the streak is never "days in a row" and nothing says a confirmed day changes', () => {
    for (const s of [...allStrings(), NOT_MONEY]) {
      expect(s).not.toMatch(/in a row/i);
      expect(s).not.toMatch(/will (change|update|raise)/i);
    }
  });

  test('the not-counted lines: honest, never "not settled yet"', () => {
    expect(common.NOT_COUNTED.title).toBe("This day isn't part of your rewards.");
    expect(common.NOT_COUNTED.beforeRewards('2026-09-10')).toBe('Rewards count from September 10, 2026.');
    expect(common.NOT_COUNTED.afterConfirmed).toBe(
      'A drive on this day reached RoadWise after the day was confirmed, so the day stays as it was.'
    );
    const lines = [common.NOT_COUNTED.title, common.NOT_COUNTED.beforeRewards('2026-01-01'), common.NOT_COUNTED.afterConfirmed];
    for (const line of lines) {
      for (const re of BANNED_COPY) expect(re.test(line)).toBe(false);
      expect(line).not.toMatch(/not (yet )?settled|confirmed when/i);
    }
  });

  test('goalProgressText: the one progress formatter', () => {
    expect(common.goalProgressText(2, 4)).toBe('2 of 4 driving days');
    expect(common.goalProgressText(0, 1)).toBe('0 of 1 driving day');
    expect(common.goalProgressText(4, 4)).toMatch(/^\d+ of \d+ driving days$/);
  });

  test('the offline and busy lines', () => {
    expect(OFFLINE_LINE).toBe("You're offline. This is what was saved on this phone.");
    expect(BUSY_LINE).toBe('Busy right now. Try again.');
  });
});
