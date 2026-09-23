import { goalRow, progressRow } from '@/features/rewards/__fixtures__/rows';
import { BANNED_COPY } from '@/notifications/catalog';

import {
  buildCardModel,
  captionFor,
  CARD_KINDS,
  DEFAULT_TOGGLES,
  dateLabel,
  type CardInput,
  type CardToggles,
} from '../cardModel';
import { shareCopy } from '../copy';
import { finalTrip, INPUTS, LEAKS, NAME } from '../__fixtures__/cards';

const ALL_TOGGLES: CardToggles = { distance: true, code: true };

describe('buildCardModel: what a card may carry', () => {
  test('the defaults are off, for everyone (R-E, D10)', () => {
    expect(DEFAULT_TOGGLES).toEqual({ distance: false, code: false });
  });

  test.each(CARD_KINDS)('%s: never a name, place, route, coordinate, time, speed or birth date, even with every toggle on', (kind) => {
    const model = buildCardModel({ ...INPUTS[kind], inviteCode: 'ABCD2345' }, ALL_TOGGLES);
    expect(model).not.toBeNull();
    const json = JSON.stringify(model);
    for (const banned of LEAKS) expect(json).not.toContain(banned);
    expect(json).not.toMatch(/\blat\b|\blng\b|polyline|geohash|mph|km\/h/i);
    expect(json).not.toMatch(/\d{1,2}:\d{2}/);
    expect(model?.wordmark).toBe('RoadWise');
    const caption = captionFor(model!);
    expect(caption).not.toMatch(/\d{1,2}:\d{2}/);
    expect(caption).not.toContain(NAME);
    // What the SVG actually draws is checked in ShareCardSvg.test.tsx (final review m10).
    for (const line of [caption]) {
      expect(line).not.toMatch(/<<|MRZ/);
      expect(line).not.toMatch(/licen[cs]e|\bID\b|DOB|date of birth/i);
      for (const re of BANNED_COPY) expect(line).not.toMatch(re);
      expect(line).not.toMatch(/points?\b/i);
    }
  });

  test('trip: the score, its band and the day as "Sep 21" in the trip\'s own zone — no time', () => {
    const model = buildCardModel(INPUTS.trip, DEFAULT_TOGGLES);
    expect(model).toMatchObject({ kind: 'trip', heading: 'Drive score', primary: '92', unit: 'Excellent', details: ['Sep 21'] });
  });

  test('trip: distance only when turned on', () => {
    expect(JSON.stringify(buildCardModel(INPUTS.trip, DEFAULT_TOGGLES))).not.toMatch(/\bmi\b/);
    expect(buildCardModel(INPUTS.trip, { distance: true, code: false })?.details).toEqual(['Sep 21', '10.0 mi']);
  });

  test.each([
    ['provisional', { status: 'provisional' as const }],
    ['not synced', { sync_state: 'queued' as const }],
    ['unscored', { status: 'unscored' as const, score: null }],
  ])('trip: %s → no card', (_name, over) => {
    expect(buildCardModel({ kind: 'trip', trip: finalTrip(over) }, DEFAULT_TOGGLES)).toBeNull();
  });

  test('trip: none → no card', () => {
    expect(buildCardModel({ kind: 'trip', trip: null }, DEFAULT_TOGGLES)).toBeNull();
  });

  test('streak: current and best', () => {
    expect(buildCardModel(INPUTS.streak, DEFAULT_TOGGLES)).toMatchObject({
      heading: 'Safe-day streak',
      primary: '12',
      unit: 'days',
      details: ['Best 30 days'],
    });
    expect(buildCardModel({ kind: 'streak', progress: progressRow({ streak_days: 0, best_streak: 4 }) }, DEFAULT_TOGGLES)).toBeNull();
  });

  test('badge: only an earned one — its name, tier and the day it was earned', () => {
    expect(buildCardModel(INPUTS.badge, DEFAULT_TOGGLES)).toMatchObject({
      heading: 'Badge',
      primary: 'Safe Start',
      unit: 'Bronze',
      details: ['Earned Sep 21'],
    });
    expect(buildCardModel({ ...INPUTS.badge, badgeId: 'safe_days_30' } as CardInput, DEFAULT_TOGGLES)).toBeNull();
    expect(buildCardModel({ ...INPUTS.badge, badgeId: 'no_such_badge' } as CardInput, DEFAULT_TOGGLES)).toBeNull();
  });

  test('level: the class name and the settled safe days', () => {
    expect(buildCardModel(INPUTS.level, DEFAULT_TOGGLES)).toMatchObject({
      heading: 'Class',
      primary: 'Smooth',
      details: ['42 safe days'],
    });
    // The server's level is the authority, not the XP table (T13 r1 n3).
    expect(
      buildCardModel({ kind: 'level', progress: progressRow({ xp: 99_999, level: 2, safe_days: 5 }) }, DEFAULT_TOGGLES)?.primary
    ).toBe('Steady');
    expect(buildCardModel({ kind: 'level', progress: null }, DEFAULT_TOGGLES)).toBeNull();
    expect(buildCardModel({ kind: 'level', progress: progressRow({ safe_days: 0 }) }, DEFAULT_TOGGLES)).toBeNull();
  });

  test('goal: the latest reached weekly goal — its sentence and "Week of"', () => {
    expect(buildCardModel(INPUTS.goal, DEFAULT_TOGGLES)).toMatchObject({
      heading: 'Weekly goal reached',
      primary: 'Brake smoothly on 4 driving days',
      details: ['Week of Sep 14'],
    });
    expect(buildCardModel({ kind: 'goal', goals: [goalRow('2026-09-21'), null] }, DEFAULT_TOGGLES)).toBeNull();
  });

  test('goal, prorated: claims only the days that passed, "Every day driven that week" (T13 r1 m1)', () => {
    const model = buildCardModel(
      { kind: 'goal', goals: [goalRow('2026-09-14', { state: 'achieved', prorated: true, pass_days: 2, category: 'phone' })] },
      DEFAULT_TOGGLES
    );
    expect(model).toMatchObject({
      primary: 'Keep your phone down on 2 driving days',
      details: ['Every day driven that week', 'Week of Sep 14'],
    });
    expect(JSON.stringify(model)).not.toContain('4 driving days');
  });

  test('the invite code: only when turned on AND there is one', () => {
    const on = { distance: false, code: true };
    expect(buildCardModel({ ...INPUTS.streak, inviteCode: 'ABCD2345' }, DEFAULT_TOGGLES)?.code).toBeNull();
    expect(buildCardModel({ ...INPUTS.streak, inviteCode: null }, on)?.code).toBeNull();
    expect(buildCardModel({ ...INPUTS.streak, inviteCode: 'IIII1111' }, on)?.code).toBeNull();
    const model = buildCardModel({ ...INPUTS.streak, inviteCode: 'ABCD2345' }, on);
    expect(model?.code).toBe('ABCD2345');
    expect(captionFor(model!)).toContain('Join me on RoadWise with my code ABCD2345.');
  });

  test('the caption is the card in words', () => {
    const model = buildCardModel(INPUTS.trip, { distance: true, code: false })!;
    expect(captionFor(model)).toBe('RoadWise\nDrive score: 92, Excellent\nSep 21\n10.0 mi');
  });

  test('dateLabel: a month and a day, never a time', () => {
    expect(dateLabel('2026-09-21')).toBe('Sep 21');
    expect(dateLabel('2026-01-05')).toBe('Jan 5');
  });
});

describe('copy', () => {
  test('BANNED_COPY over every string', () => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'function') out.push(String((v as (x: unknown) => unknown)(3)), String((v as (x: unknown) => unknown)('Sep 21')));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(shareCopy);
    expect(out.length).toBeGreaterThan(20);
    for (const s of out) {
      for (const re of BANNED_COPY) expect(s).not.toMatch(re);
      expect(s).not.toMatch(/licen[cs]e|\bID\b|DOB/);
    }
  });
});
