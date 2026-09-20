import { deductions, eventRow, MILE_M, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { toDayEntry, toTripEventView, toTripSummary, unscoredReasonOf } from '@/data/queries';
import type { TripRow } from '@/data/db';

import {
  conditionsLabel,
  dateLine,
  describeEvent,
  earnedFor,
  formatTimeSpan,
  formatTripDate,
  highlightsFor,
  isPerfect,
  LIMIT_KNOWN_PCT,
  routeLine,
  unscoredCopy,
} from '@/features/trips/format';

const summary = (over: Partial<TripRow> = {}) => toTripSummary(tripRow(over));

describe('the header', () => {
  test('dates and times are printed in the trip zone, not the device zone', () => {
    // T0 is noon UTC on Monday 5 January; in Tokyo that is 21:00 the same day.
    expect(formatTripDate(T0, 'Asia/Tokyo')).toBe('Mon, Jan 5');
    expect(formatTimeSpan(T0, T0 + 30 * 60_000, 'Asia/Tokyo')).toBe('9:00 – 9:30 PM');
  });

  test('a span across noon keeps both periods', () => {
    expect(formatTimeSpan(T0 - 30 * 60_000, T0 + 5 * 60_000, 'UTC')).toBe('11:30 AM – 12:05 PM');
  });

  test('a trip still without an end prints its start alone', () => {
    expect(formatTimeSpan(T0, null, 'UTC')).toBe('12:00 PM');
  });

  test('a zone Intl does not know falls back to the device zone rather than throwing', () => {
    expect(() => formatTripDate(T0, 'Mars/Olympus')).not.toThrow();
  });

  test('the route line uses the stored labels, and "Start → End" until geocoding exists', () => {
    expect(routeLine(summary())).toBe('Near Home → Near Lincoln HS');
    expect(routeLine(summary({ start_label: null, end_label: null }))).toBe('Start → End');
    expect(dateLine(summary())).toBe('Mon, Jan 5 · 12:00 – 12:30 PM');
  });

  test('conditions are words', () => {
    const at = (night: boolean, precipitation: boolean) =>
      conditionsLabel(
        summary({
          conditions_json: JSON.stringify({ night, precipitation, hadSevereEvent: false }),
        })
      );
    expect(at(false, false)).toBe('Day');
    expect(at(true, false)).toBe('Night');
    expect(at(false, true)).toBe('Rain');
    expect(at(true, true)).toBe('Night, rain');
  });
});

describe('highlights', () => {
  const speedingEvent = (id: string, status = 'scored', deduction = 3) =>
    toTripEventView(eventRow({ id, category: 'speeding', status, deduction }));

  test('positives come first, in cap order, then the costliest category with its episodes', () => {
    const trip = summary({
      score: 85,
      category_deductions_json: JSON.stringify(deductions({ speeding: 9, braking: 2 })),
    });
    const rows = highlightsFor(trip, [
      speedingEvent('s1'),
      speedingEvent('s2'),
      speedingEvent('maybe', 'possible', 0),
    ]);
    // Cap order: phone 30, speeding 25, focus 15 (camera only), braking 12, cornering 10, accel 8.
    expect(rows.map((r) => r.text)).toEqual([
      'No phone use',
      'Steady cornering',
      'Speeding: 2 episodes',
    ]);
    expect(rows[2]).toMatchObject({ kind: 'cost', points: 9, episodes: 2 });
  });

  test('a clean drive earns three positives and no cost row', () => {
    const rows = highlightsFor(summary({ score: 100 }), []);
    expect(rows.map((r) => r.kind)).toEqual(['positive', 'positive', 'positive']);
    expect(rows.map((r) => r.text)).toEqual(['No phone use', 'Kept to the limit', 'Smooth braking']);
  });

  test('eyes on the road is only claimed on a camera drive', () => {
    const without = highlightsFor(summary({ camera_session: 0 }), []).map((r) => r.category);
    const withCamera = highlightsFor(summary({ camera_session: 1 }), []).map((r) => r.category);
    expect(without).not.toContain('focus');
    expect(withCamera).toContain('focus');
  });

  test('kept to the limit is only claimed where the limit was known', () => {
    const blind = summary({ limit_coverage_pct: LIMIT_KNOWN_PCT - 1 });
    expect(highlightsFor(blind, []).map((r) => r.category)).not.toContain('speeding');
    expect(highlightsFor(summary({ limit_coverage_pct: null }), []).map((r) => r.category)).not.toContain(
      'speeding'
    );
  });

  test('a costly category with no stored events is named without a count', () => {
    const trip = summary({
      score: 90,
      category_deductions_json: JSON.stringify(deductions({ phone: 10 })),
    });
    const cost = highlightsFor(trip, []).find((r) => r.kind === 'cost');
    expect(cost?.text).toBe('Phone use');
  });

  test('an unscored trip has no highlights', () => {
    expect(highlightsFor(summary({ score: null, status: 'unscored' }), [])).toEqual([]);
  });

  test('a perfect drive is one with a score and nothing lost', () => {
    expect(isPerfect(summary({ score: 100 }))).toBe(true);
    expect(isPerfect(summary({ score: 97, category_deductions_json: JSON.stringify(deductions({ accel: 3 })) }))).toBe(false);
    expect(isPerfect(summary({ score: null, status: 'unscored' }))).toBe(false);
  });
});

describe('the unscored field', () => {
  const unscored = (over: Partial<TripRow>) => {
    const trip = summary({ score: null, status: 'unscored', ...over });
    return unscoredCopy(trip, unscoredReasonOf(trip));
  };

  test('an unclassified trip asks its question before any reason', () => {
    expect(unscored({ role: 'unknown' })).toEqual({
      title: 'Not scored yet',
      body: 'Tell us who was driving and this drive gets scored.',
      stamp: null,
    });
  });

  test('a passenger trip carries the stamp', () => {
    expect(unscored({ role: 'passenger' })).toMatchObject({ title: 'Not scored', stamp: 'passenger' });
    expect(unscored({ role: 'other' })).toMatchObject({ stamp: 'passenger' });
  });

  test('too short and weak GPS explain themselves in the spec words', () => {
    expect(unscored({ distance_m: 100, duration_s: 30 }).body).toMatch(/Too short/);
    expect(unscored({ data_quality: 'C' }).body).toBe(
      'GPS signal was too weak to score this trip fairly.'
    );
  });

  test('a driver trip the row cannot explain is calculating until it syncs, then not scored', () => {
    expect(unscored({ data_quality: 'A', sync_state: 'queued' }).title).toBe('Calculating…');
    expect(unscored({ data_quality: 'A', sync_state: 'synced' })).toMatchObject({
      title: 'Not scored',
      body: "This drive couldn't be scored.",
    });
  });
});

describe('the earned field', () => {
  const day = (flags: Partial<{ safeDay: boolean; goodDay: boolean }>) =>
    toDayEntry({ day: '2026-01-05', payload: flags, updated_at: T0 });

  test('reads where the score puts the day while nothing is confirmed', () => {
    expect(earnedFor(summary({ score: 90 }), null)).toBe('safeOnTrack');
    expect(earnedFor(summary({ score: 75 }), null)).toBe('goodOnTrack');
    expect(earnedFor(summary({ score: 60 }), null)).toBe('counts');
    expect(earnedFor(summary({ score: null, status: 'unscored' }), null)).toBe('counts');
  });

  test('trusts the cached day only once this drive has synced', () => {
    const synced = summary({ score: 60, sync_state: 'synced', status: 'final' });
    expect(earnedFor(synced, day({ safeDay: true }))).toBe('safeDay');
    expect(earnedFor(synced, day({ goodDay: true }))).toBe('goodDay');
    expect(earnedFor(summary({ score: 60 }), day({ safeDay: true }))).toBe('counts');
  });
});

describe('events in plain language', () => {
  const view = (over: Parameters<typeof eventRow>[0]) => toTripEventView(eventRow(over));

  test('each category reads as what was measured', () => {
    expect(describeEvent(view({}))).toBe('12 mph over for 38 s');
    expect(describeEvent(view({ category: 'phone', duration_s: 6 }))).toBe('Phone handled for 6 s');
    expect(describeEvent(view({ category: 'braking', measured_json: JSON.stringify({ peakG: -0.42 }) }))).toBe(
      '0.42 g brake'
    );
    expect(describeEvent(view({ category: 'cornering', measured_json: JSON.stringify({ lateralG: 0.4 }) }))).toBe(
      '0.40 g turn'
    );
    expect(
      describeEvent(view({ category: 'focus', measured_json: JSON.stringify({ focusKind: 'drowsiness' }) }))
    ).toBe('Signs of drowsiness');
  });

  test('a measurement the row lacks degrades to the category, never to NaN', () => {
    expect(describeEvent(view({ measured_json: null }))).toBe('Over the limit for 38 s');
    expect(describeEvent(view({ category: 'braking', measured_json: null }))).toBe('Hard brake');
    expect(describeEvent(view({ category: 'unheard-of' }))).toBe('unheard-of');
  });
});

// `MILE_M` keeps the fixture import honest: the summaries above are 10-mile drives.
test('the fixture drive is ten miles', () => {
  expect(summary().distanceM).toBe(10 * MILE_M);
});
