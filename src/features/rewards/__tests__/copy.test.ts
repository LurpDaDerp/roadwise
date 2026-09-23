import { BANNED_COPY } from '@/notifications/catalog';

import * as common from '../copy/common';

const {
  BADGE_TIER_LABEL,
  BUSY_LINE,
  CATEGORY_LABEL,
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
      "A day with an unsafe drive restarts your streak unless a shield covers it. Days you don't drive, very short days and your first days never do."
    );
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
  for (const [name, value] of Object.entries(common)) {
    if (typeof value === 'function') continue;
    if (name === 'NOT_MONEY') continue; // judged on its own below
    walk(value);
  }
  for (const c of ['phone', 'speeding', 'braking', 'accel', 'cornering'] as const) out.push(goalSentence(c, 4));
  out.push(pointsText(1250), pointsText(1));
  return out;
}

describe('BANNED_COPY (no money words, no pressure, no "!")', () => {
  test('every common string passes', () => {
    const strings = allStrings();
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) for (const re of BANNED_COPY) expect([s, re.test(s)]).toEqual([s, false]);
  });

  test('NOT_MONEY names money only to deny it: with that one denial removed, it passes', () => {
    // BANNED_COPY forbids "money" anywhere; the plan's required sentence is the one place the word
    // may appear, and only as "They aren't money." (honesty b). Anything else in it must pass.
    expect(NOT_MONEY.match(/money/gi)).toHaveLength(1);
    const rest = NOT_MONEY.replace("They aren't money.", '');
    for (const re of BANNED_COPY) expect(re.test(rest)).toBe(false);
  });

  test('the streak is never "days in a row" and nothing says a confirmed day changes', () => {
    for (const s of [...allStrings(), NOT_MONEY]) {
      expect(s).not.toMatch(/in a row/i);
      expect(s).not.toMatch(/will (change|update|raise)/i);
    }
  });

  test('the offline and busy lines', () => {
    expect(OFFLINE_LINE).toBe("You're offline. This is what was saved on this phone.");
    expect(BUSY_LINE).toBe('Busy right now. Try again.');
  });
});
