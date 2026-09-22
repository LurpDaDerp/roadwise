import { CONSTANTS, type EventCategory } from '@scoring';

import { deductions, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  categoryRates,
  conditionsSplit,
  timeOfDaySplit,
  toDayEntry,
  toInsightTrip,
  toTripSummary,
  youVsYou,
  type CategoryRate,
  type InsightTrip,
  type TrendPoint,
  type TripSummary,
} from '@/data/queries';
import { insightsCopy } from '@/features/insights/copy';
import {
  apportionPercents,
  bestWeek,
  capRows,
  categoryFigures,
  categoryLabel,
  conditionRows,
  describeRows,
  exampleTripsFor,
  formatMiles,
  formatRate,
  highlightsFor,
  longestSafeStreak,
  MAX_EXAMPLES,
  MAX_HIGHLIGHTS,
  MAX_SPOKEN_ROWS,
  MAX_WEEK_COLUMNS,
  MIN_HIGHLIGHT_RUN,
  MIN_SCORED_TRIPS,
  notMeasuredReason,
  parseCategory,
  shareRows,
  shareSummary,
  timeOfDayRows,
  timeOfDaySummary,
  tipsFor,
  toChartTrend,
  totalsFor,
  trendSummary,
  weekLabel,
  weekLongLabel,
  weeklyRateColumns,
  weeklyRateSummary,
  windowOf,
  youVsYouCaption,
  youVsYouRows,
  type BarRow,
} from '@/features/insights/format';
import { periodPhrase } from '@/features/insights/period';

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const DAY = 86_400_000;

function point(weekStart: string, score: number | null, over: Partial<TrendPoint> = {}): TrendPoint {
  return {
    weekStart,
    trips: score === null ? 0 : 1,
    score,
    categoryDeductions: deductions(),
    distanceM: 0,
    durationS: 0,
    ...over,
  };
}

function summary(over: Parameters<typeof tripRow>[0] = {}): TripSummary {
  return toTripSummary(tripRow(over));
}

function insight(over: Parameters<typeof tripRow>[0] = {}): InsightTrip {
  const trip = toInsightTrip(summary(over));
  if (trip === null) throw new Error('fixture is not a scored trip');
  return trip;
}

describe('week labels', () => {
  test('a week is named by its Monday, short on the axis and long in the table', () => {
    expect(weekLabel('2026-01-05')).toBe('Jan 5');
    expect(weekLongLabel('2026-01-05')).toBe('Week of Jan 5');
    expect(weekLabel('2026-12-28')).toBe('Dec 28');
  });

  test('a string that is not a date is printed as it is rather than as Invalid Date', () => {
    expect(weekLabel('not-a-week')).toBe('not-a-week');
  });
});

describe('toChartTrend — the adapter between the two TrendPoint shapes', () => {
  test('maps every aggregate point to a chart point, keeping null scores as gaps', () => {
    const chart = toChartTrend([point('2026-01-05', 71.4), point('2026-01-12', null), point('2026-01-19', 84)]);
    expect(chart).toEqual([
      { label: 'Jan 5', longLabel: 'Week of Jan 5', value: 71.4 },
      { label: 'Jan 12', longLabel: 'Week of Jan 12', value: null },
      { label: 'Jan 19', longLabel: 'Week of Jan 19', value: 84 },
    ]);
  });

  test('keeps a point that falls outside the period window: the axis is the union, not the range', () => {
    const chart = toChartTrend([point('2025-12-29', 90), point('2026-01-05', 80)]);
    expect(chart.map((p) => p.label)).toEqual(['Dec 29', 'Jan 5']);
  });
});

describe('trendSummary', () => {
  test('names the movement between the first and last scored weeks', () => {
    expect(trendSummary([point('2026-01-05', 71), point('2026-01-12', 84)], '4w')).toBe(
      'Up 13 points over 4 weeks.'
    );
    expect(trendSummary([point('2026-01-05', 90), point('2026-01-12', 86)], '3mo')).toBe(
      'Down 4 points over 3 months.'
    );
    expect(trendSummary([point('2026-01-05', 84), point('2026-01-12', 84)], '12mo')).toBe(
      'Steady at 84 over 12 months.'
    );
  });

  test('one scored week is stated, and none says so', () => {
    expect(trendSummary([point('2026-01-05', null), point('2026-01-12', 77)], '4w')).toBe(
      'One scored week so far, at 77.'
    );
    expect(trendSummary([point('2026-01-05', null)], 'all')).toBe('No scored weeks since your first drive.');
  });

  test('a gap between scored weeks says what the model actually does between drives', () => {
    const sparse = trendSummary(
      [point('2026-01-05', 70), point('2026-01-12', null), point('2026-01-19', 80)],
      '4w'
    );
    // Not "driving less never lowers your score": the long-term score is a recency-weighted mean
    // pulled toward `LONG_TERM_MU0`, so a long gap moves it toward 80 from either side. The note
    // keeps the half that is true (a quiet week costs no points) and names where the drift goes.
    expect(sparse).toBe(
      'Up 10 points over 4 weeks. Weeks without a drive leave a gap. A quiet week costs no points; over a long break the score drifts back toward 80, where every score starts.'
    );
    // The number is the engine's prior, not a typed constant.
    expect(sparse).toContain(String(CONSTANTS.LONG_TERM_MU0));
    expect(sparse).not.toContain('never lowers');
  });

  test('an empty current week is not a gap: the note is for gaps between scored weeks', () => {
    expect(
      trendSummary([point('2026-01-05', 70), point('2026-01-12', 80), point('2026-01-19', null)], '4w')
    ).toBe('Up 10 points over 4 weeks.');
  });
});

describe('share of points lost', () => {
  const rates: CategoryRate[] = categoryRates([
    insight({ client_trip_id: 'a', category_deductions_json: JSON.stringify(deductions({ phone: 15, speeding: 5 })) }),
    insight({ client_trip_id: 'b', category_deductions_json: JSON.stringify(deductions({ speeding: 5 })) }),
  ]);

  test('rows are costliest first, print a whole percent, and keep a clean category as an empty box', () => {
    const rows = shareRows(rates);
    expect(rows.map((r) => r.key)).toEqual(['phone', 'speeding', 'focus', 'braking', 'cornering', 'accel']);
    expect(rows[0]).toMatchObject({ label: 'Phone use', value: 0.6, max: 1, printed: '60%' });
    expect(rows[0]?.spoken).toBe('Phone use, 60% of points lost, 15 points');
    expect(rows[2]).toMatchObject({ label: 'Focus and alertness', value: 0, printed: '0%' });
  });

  test('the summary names the costliest category, or says nothing was lost', () => {
    expect(shareSummary(rates, '4w')).toBe('Phone use was 60% of the points you lost over 4 weeks.');
    expect(shareSummary(categoryRates([insight()]), '4w')).toBe('No points lost over 4 weeks.');
  });
});

describe('you vs. you rows', () => {
  const current = [
    insight({ client_trip_id: 'a', score: 88, category_deductions_json: JSON.stringify(deductions({ speeding: 4 })) }),
  ];
  const baseline = { speeding: 6, phone: 0, braking: 2, accel: 0, cornering: 0, focus: 0, score: 80 };
  const card = youVsYou(current, baseline);

  test('fewer points lost than the baseline reads as better; more reads as more lost', () => {
    if (card === null) throw new Error('no card');
    const rows = youVsYouRows(card);
    expect(rows[0]).toMatchObject({ key: 'score', label: 'Score', text: 'Up 8', direction: 'better' });
    expect(rows[0]?.spoken).toBe('Score 88, Up 8 from your baseline, better');
    const speeding = rows.find((r) => r.key === 'speeding');
    expect(speeding).toMatchObject({ text: '2 fewer', direction: 'better' });
    expect(speeding?.spoken).toBe('Speeding, 2 fewer points a drive than your baseline, better');
    const braking = rows.find((r) => r.key === 'braking');
    expect(braking).toMatchObject({ text: '2 fewer', direction: 'better' });
    const phone = rows.find((r) => r.key === 'phone');
    expect(phone).toMatchObject({ text: 'Same', direction: 'same' });
    expect(phone?.spoken).toBe('Phone use, same as your baseline');
  });

  test('a category that cost more than the baseline is stated plainly, never as a failure', () => {
    const worse = youVsYou(
      [insight({ score: 70, category_deductions_json: JSON.stringify(deductions({ phone: 10 })) })],
      { ...baseline, phone: 4 }
    );
    if (worse === null) throw new Error('no card');
    const phone = youVsYouRows(worse).find((r) => r.key === 'phone');
    expect(phone).toMatchObject({ text: '6 more', direction: 'worse' });
    expect(phone?.spoken).toBe('Phone use, 6 more points a drive than your baseline, more lost');
  });

  test('the caption says which baseline was used, and never claims a server one for a local one', () => {
    expect(youVsYouCaption('local')).toBe('Compared with your own drives from the 8 weeks before these 4.');
    expect(youVsYouCaption('stored')).toBe('Compared with your 8-week baseline.');
  });
});

describe('highlights', () => {
  const clean = (id: string, daysAgo: number, over: Parameters<typeof tripRow>[0] = {}) =>
    summary({ client_trip_id: id, started_at: T0 - daysAgo * DAY, ...over });

  test('counts the run of clean drives from the newest back, and hides runs under three', () => {
    const trips = [
      clean('1', 0),
      clean('2', 1),
      clean('3', 2, { category_deductions_json: JSON.stringify(deductions({ braking: 3 })) }),
      clean('4', 3),
    ];
    const highlights = highlightsFor(trips);
    expect(highlights.map((h) => h.text)).toEqual([
      'Phone-free for 4 drives',
      'Within the limit for 4 drives',
      'Smooth acceleration for 4 drives',
    ]);
    expect(highlights).toHaveLength(MAX_HIGHLIGHTS);
    expect(highlights.find((h) => h.category === 'braking')).toBeUndefined();
    expect(MIN_HIGHLIGHT_RUN).toBe(3);
  });

  // Each case asks for one category, so the three-highlight cap cannot make the assertion pass
  // for the wrong reason: an empty result here is `measured()` ending the run, nothing else.
  test('a drive that could not measure the category ends its run rather than counting as clean', () => {
    const unknownLimit = [
      clean('1', 0, { limit_coverage_pct: 20 }),
      clean('2', 1),
      clean('3', 2),
      clean('4', 3),
    ];
    expect(highlightsFor(unknownLimit, ['speeding'])).toEqual([]);
    expect(highlightsFor(unknownLimit, ['phone'])[0]?.run).toBe(4);

    const noCamera = [clean('1', 0), clean('2', 1), clean('3', 2)];
    expect(highlightsFor(noCamera, ['focus'])).toEqual([]);

    const camera = noCamera.map((trip) => ({ ...trip, cameraSession: true }));
    expect(highlightsFor(camera, ['focus'])[0]?.text).toBe('Eyes on the road for 3 drives');
  });

  test('an unscored drive is skipped, not counted and not a break', () => {
    const trips = [
      clean('1', 0),
      clean('2', 1, { score: null, status: 'unscored' }),
      clean('3', 2),
      clean('4', 3),
    ];
    expect(highlightsFor(trips).find((h) => h.category === 'phone')?.run).toBe(3);
  });
});

describe('conditions', () => {
  test('each slice prints its score and size, and an empty slice says no drives', () => {
    const split = conditionsSplit([
      insight({ client_trip_id: 'a', score: 90, distance_m: 10 * MILE_M }),
      insight({
        client_trip_id: 'b',
        score: 80,
        distance_m: 20 * MILE_M,
        conditions_json: JSON.stringify({ night: true, precipitation: false, hadSevereEvent: false }),
      }),
    ]);
    const rows = conditionRows(split);
    expect(rows.map((r) => r.label)).toEqual(['Day', 'Night', 'Dry', 'Wet']);
    expect(rows[0]).toMatchObject({ score: '90', detail: '1 drive · 10 mi' });
    expect(rows[0]?.spoken).toBe('Day, score 90, 1 drive · 10 mi');
    expect(rows[1]).toMatchObject({ score: '80', detail: '1 drive · 20 mi' });
    expect(rows[3]).toMatchObject({ score: '—', detail: 'No drives', spoken: 'Wet, no drives' });
  });
});

describe('time of day', () => {
  const split = timeOfDaySplit([
    insight({ client_trip_id: 'm', started_at: Date.UTC(2026, 0, 5, 8), distance_m: 10 * MILE_M, category_deductions_json: JSON.stringify(deductions({ speeding: 2 })) }),
    insight({ client_trip_id: 'e', started_at: Date.UTC(2026, 0, 5, 18), distance_m: 10 * MILE_M, category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) }),
  ]);

  test('rates each bucket per 100 miles, in reading order, and marks an empty bucket', () => {
    const rows = timeOfDayRows(split, 'speeding');
    expect(rows.map((r) => r.label)).toEqual(['Morning', 'Afternoon', 'Evening', 'Night']);
    expect(rows[0]).toMatchObject({ value: 20, max: 60, printed: '20', spoken: 'Morning, 20 points per 100 miles, 1 drive' });
    expect(rows[1]).toMatchObject({ value: null, printed: '—', spoken: 'Afternoon, no drives' });
    expect(rows[2]).toMatchObject({ value: 60, printed: '60' });
  });

  test('the summary names the bucket that loses the most, or says the category is clean', () => {
    expect(timeOfDaySummary(timeOfDayRows(split, 'speeding'), 'speeding', '4w')).toBe(
      'Evening drives lose the most to speeding: 60 points per 100 miles.'
    );
    expect(timeOfDaySummary(timeOfDayRows(split, 'phone'), 'phone', '4w')).toBe(
      'No points lost to phone use at any time of day over 4 weeks.'
    );
    expect(timeOfDaySummary(timeOfDayRows(timeOfDaySplit([]), 'phone'), 'phone', 'all')).toBe(
      'No drives since your first drive.'
    );
  });
});

describe('weekly rate columns', () => {
  const trend: TrendPoint[] = [
    point('2026-01-05', 80, { distanceM: 10 * MILE_M, categoryDeductions: deductions({ speeding: 3 }) }),
    point('2026-01-12', null),
    point('2026-01-19', 90, { distanceM: 20 * MILE_M, categoryDeductions: deductions({ speeding: 2 }) }),
  ];

  test('rates the category per 100 miles week by week, with no rate for a week without miles', () => {
    const columns = weeklyRateColumns(trend, 'speeding');
    expect(columns.map((c) => c.value)).toEqual([30, null, 10]);
    expect(columns[0]).toMatchObject({ label: 'Jan 5', longLabel: 'Week of Jan 5', printed: '30', spoken: 'Week of Jan 5, 30 points per 100 miles' });
    expect(columns[1]).toMatchObject({ printed: '—', spoken: 'Week of Jan 12, no drives' });
    expect(columns.every((c) => c.max === 30)).toBe(true);
  });

  test('the summary reads from the first scored week to the last', () => {
    expect(weeklyRateSummary(weeklyRateColumns(trend, 'speeding'), '4w')).toBe(
      'From 30 to 10 points per 100 miles over 4 weeks.'
    );
    expect(weeklyRateSummary(weeklyRateColumns(trend.slice(2), 'speeding'), '4w')).toBe(
      '10 points per 100 miles in the week of Jan 19.'
    );
    expect(weeklyRateSummary(weeklyRateColumns([point('2026-01-05', null)], 'speeding'), '4w')).toBe(
      'No scored weeks over 4 weeks.'
    );
  });

  test('a long history keeps the newest weeks so the columns stay readable', () => {
    const long = Array.from({ length: MAX_WEEK_COLUMNS + 10 }, (_, i) =>
      point(new Date(Date.UTC(2020, 0, 6) + i * 7 * DAY).toISOString().slice(0, 10), 80, { distanceM: MILE_M })
    );
    const columns = weeklyRateColumns(long, 'phone');
    expect(columns).toHaveLength(MAX_WEEK_COLUMNS);
    expect(columns[columns.length - 1]?.key).toBe(long[long.length - 1]?.weekStart);
  });
});

describe('category figures and tips', () => {
  test('the rates card reads the category out of the aggregate with the drive counts', () => {
    const rates = categoryRates([
      insight({ client_trip_id: 'a', distance_m: 10 * MILE_M, duration_s: 1800, category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) }),
      insight({ client_trip_id: 'b', distance_m: 10 * MILE_M, duration_s: 1800 }),
    ]);
    const figures = categoryFigures(rates, 'speeding', 2);
    expect(figures).toMatchObject({ deduction: 6, per100Mi: '30', perHour: '6', drives: '1 of 2', clean: false });
    expect(categoryFigures(rates, 'phone', 2)).toMatchObject({ deduction: 0, per100Mi: '0', clean: true });
    expect(categoryFigures([], 'phone', 0)).toMatchObject({ per100Mi: '—', perHour: '—', drives: '0 of 0', clean: true });
  });

  test('two tips per category for the stage, the everyday one first', () => {
    const forNew = tipsFor('speeding', 'new');
    expect(forNew.map((t) => t.id)).toEqual(['speeding-low-new', 'speeding-high-new']);
    expect(tipsFor('speeding', 'experienced').map((t) => t.id)).toEqual([
      'speeding-low-experienced',
      'speeding-high-experienced',
    ]);
  });

  test('category labels come from the scoring explainer, and a bad route param is null', () => {
    expect(categoryLabel('phone')).toBe('Phone use');
    expect(parseCategory('speeding')).toBe('speeding');
    expect(parseCategory('driving')).toBeNull();
    expect(parseCategory(undefined)).toBeNull();
    expect(parseCategory(['focus'])).toBe('focus');
  });
});

describe('totals', () => {
  const day = (d: string, safeDay: boolean) =>
    toDayEntry({ day: d, payload: { day: d, safeDay }, updated_at: T0 });
  const trips = [
    summary({ client_trip_id: 'a', started_at: T0, distance_m: 10 * MILE_M, duration_s: 1800 }),
    summary({
      client_trip_id: 'b',
      started_at: T0 + DAY,
      distance_m: 20 * MILE_M,
      duration_s: 3600,
      category_deductions_json: JSON.stringify(deductions({ phone: 8 })),
      conditions_json: JSON.stringify({ night: true, precipitation: false, hadSevereEvent: false }),
    }),
    summary({ client_trip_id: 'p', started_at: T0 + 2 * DAY, distance_m: 50 * MILE_M, role: 'passenger', score: null, status: 'unscored' }),
    summary({ client_trip_id: 'u', started_at: T0 + 3 * DAY, distance_m: 2 * MILE_M, duration_s: 600, score: null, status: 'unscored' }),
    summary({ client_trip_id: 'old', started_at: T0 - 40 * DAY, distance_m: 100 * MILE_M }),
  ];

  test('counts drives as the driver in the window, phone-free and night miles, and the day records', () => {
    const totals = totalsFor({
      trips,
      days: [day('2026-01-05', true), day('2026-01-06', true), day('2026-01-07', false), day('2026-01-09', true)],
      trend: [point('2026-01-05', 88), point('2026-01-12', 91), point('2026-01-19', 91)],
      from: T0 - DAY,
      to: T0 + 10 * DAY,
    });
    expect(totals).toMatchObject({
      drives: 3,
      scoredDrives: 2,
      milesM: 32 * MILE_M,
      seconds: 6000,
      safeDays: 3,
      longestSafeStreak: 2,
      phoneFreeMilesM: 10 * MILE_M,
      nightMilesM: 20 * MILE_M,
    });
    expect(totals.bestWeek).toEqual({ weekStart: '2026-01-19', score: 91 });
  });

  test('the longest streak is consecutive driving days that were safe; days without driving neither add nor break', () => {
    expect(longestSafeStreak([day('2026-01-05', true), day('2026-01-09', true), day('2026-01-20', true)])).toBe(3);
    expect(longestSafeStreak([day('2026-01-05', true), day('2026-01-06', false), day('2026-01-07', true)])).toBe(1);
    expect(longestSafeStreak([])).toBe(0);
  });

  // Round 2 (the review's ruling): a day is classified by `tripsAll`, the final drives including
  // deleted ones. 0 is no counted drive (neither adds nor breaks); a day whose only drives were
  // deleted has tripsAll > 0 and is not safe, so it breaks the run: deleting never saves it (D2).
  const row = (d: string, payload: Record<string, unknown>) =>
    toDayEntry({ day: d, payload: { day: d, goodDay: false, ...payload }, updated_at: T0 });

  test('a day whose only drive was deleted breaks the run of safe days', () => {
    const deletedOnly = row('2026-01-06', { safeDay: false, tripsScored: 0, tripsAll: 1 });
    expect(longestSafeStreak([day('2026-01-05', true), deletedOnly, day('2026-01-07', true)])).toBe(1);
  });

  test('a day with no counted drive at all neither adds to nor breaks the run', () => {
    const empty = row('2026-01-06', { safeDay: false, tripsScored: 0, tripsAll: 0 });
    expect(longestSafeStreak([day('2026-01-05', true), empty, day('2026-01-07', true)])).toBe(2);
    // negative control: it never adds either
    expect(longestSafeStreak([empty])).toBe(0);
  });

  test('an older row without tripsAll falls back to tripsScored', () => {
    const olderEmpty = row('2026-01-06', { safeDay: false, tripsScored: 0 });
    expect(longestSafeStreak([day('2026-01-05', true), olderEmpty, day('2026-01-07', true)])).toBe(2);
    // negative controls: a counted unsafe day breaks, and a row with no count at all is not safe
    const olderUnsafe = row('2026-01-06', { safeDay: false, tripsScored: 1 });
    expect(longestSafeStreak([day('2026-01-05', true), olderUnsafe, day('2026-01-07', true)])).toBe(1);
    expect(longestSafeStreak([day('2026-01-05', true), day('2026-01-06', false), day('2026-01-07', true)])).toBe(1);
  });

  test('a safe day extends the run whatever its counts say', () => {
    const safe = row('2026-01-06', { safeDay: true, tripsScored: 1, tripsAll: 2 });
    expect(longestSafeStreak([day('2026-01-05', true), safe, day('2026-01-07', true)])).toBe(3);
  });

  test('the best week is the highest scored week, the later one on a tie, and none without scores', () => {
    expect(bestWeek([point('2026-01-05', 91), point('2026-01-12', 91), point('2026-01-19', 80)])).toEqual({
      weekStart: '2026-01-12',
      score: 91,
    });
    expect(bestWeek([point('2026-01-05', null)])).toBeNull();
  });

  test('miles group their thousands and keep a decimal only under ten', () => {
    expect(formatMiles(1234.5 * MILE_M)).toBe('1,235 mi');
    expect(formatMiles(5.25 * MILE_M)).toBe('5.3 mi');
    expect(formatMiles(0)).toBe('0 mi');
    expect(formatRate(3.14)).toBe('3.1');
    expect(formatRate(null)).toBe('—');
  });
});

test('every scoring category has a highlight line', () => {
  const categories: EventCategory[] = ['phone', 'speeding', 'braking', 'accel', 'cornering', 'focus'];
  for (const category of categories) {
    const trips = [0, 1, 2].map((i) =>
      summary({
        client_trip_id: String(i),
        started_at: T0 - i * DAY,
        camera_session: 1,
      })
    );
    expect(highlightsFor(trips, [category]).map((h) => h.category)).toEqual([category]);
  }
});

describe('example drives (E2)', () => {
  const costing = (id: string, daysAgo: number, speeding: number, over: Parameters<typeof tripRow>[0] = {}) =>
    summary({
      client_trip_id: id,
      started_at: T0 - daysAgo * DAY,
      category_deductions_json: JSON.stringify(deductions({ speeding })),
      ...over,
    });

  test('offers the drives the category actually cost the most, costliest first, at most three', () => {
    const examples = exampleTripsFor(
      [costing('a', 0, 2), costing('b', 1, 9), costing('c', 2, 5), costing('d', 3, 4), costing('e', 4, 0)],
      'speeding'
    );
    expect(examples.map((e) => e.clientTripId)).toEqual(['b', 'c', 'd']);
    expect(examples).toHaveLength(MAX_EXAMPLES);
    expect(examples[0]).toMatchObject({
      title: 'Near Home → Near Lincoln HS',
      cost: '9 points to speeding',
      detail: 'Score 90 · Sun, Jan 4',
    });
    expect(examples[0]?.spoken).toBe('Near Home → Near Lincoln HS, 9 points to speeding, Score 90 · Sun, Jan 4');
  });

  test('a drive with no route labels is named by its day, and an unscored drive is never an example', () => {
    const plain = exampleTripsFor([costing('a', 0, 3, { start_label: null, end_label: null })], 'speeding');
    expect(plain[0]?.title).toBe('Mon, Jan 5');
    expect(exampleTripsFor([costing('u', 0, 3, { score: null, status: 'unscored' })], 'speeding')).toEqual([]);
    expect(exampleTripsFor([costing('a', 0, 3)], 'phone')).toEqual([]);
  });
});

describe('the caps chart (E4)', () => {
  test('one box per category, as long as the most that category can take from one drive', () => {
    const rows = capRows();
    expect(rows.map((r) => r.key)).toEqual(['phone', 'speeding', 'focus', 'braking', 'cornering', 'accel']);
    expect(rows[0]).toMatchObject({ label: 'Phone use', value: 30, max: 30, printed: '30' });
    expect(rows[0]?.spoken).toBe('Phone use, at most 30 points a drive');
    expect(rows.reduce((total, r) => total + (r.value ?? 0), 0)).toBe(100);
  });
});

test('the window carries both the instants and the calendar days the day cache is keyed by', () => {
  expect(windowOf({ from: Date.UTC(2026, 0, 5, 12), to: Date.UTC(2026, 1, 2, 12) })).toMatchObject({
    from: Date.UTC(2026, 0, 5, 12),
    to: Date.UTC(2026, 1, 2, 12),
  });
  expect(MIN_SCORED_TRIPS).toBe(3);
});

describe('what a window could actually measure', () => {
  const scored = (id: string, over: Parameters<typeof tripRow>[0] = {}) =>
    summary({ client_trip_id: id, ...over });
  const seen = (trips: readonly TripSummary[], scoredTrips = trips.filter((t) => t.scored).length) => ({
    scoredTrips,
    trips,
  });

  test('a window with no scored drives has nothing to report for any category', () => {
    expect(notMeasuredReason('speeding', seen([]))).toBe('noDrives');
    expect(notMeasuredReason('phone', seen([summary({ score: null, status: 'unscored' })]))).toBe(
      'noDrives'
    );
  });

  test('the count of drives comes from the aggregate, so a failed list read claims nothing', () => {
    // `trips` empty because the read failed, not because the window is: the aggregate knows
    // better, and announcing "no scored drives" over it would be a false claim.
    expect(notMeasuredReason('speeding', { scoredTrips: 3, trips: [] })).toBeNull();
    expect(notMeasuredReason('focus', { scoredTrips: 3, trips: [] })).toBeNull();
  });

  test('speeding is not measured where no drive had a known limit', () => {
    const unknown = [scored('a', { limit_coverage_pct: 20 }), scored('b', { limit_coverage_pct: null })];
    expect(notMeasuredReason('speeding', seen(unknown))).toBe('noLimit');
    // One drive with enough coverage is enough for the window to have looked.
    expect(notMeasuredReason('speeding', seen([...unknown, scored('c')]))).toBeNull();
    // The same drives measured every other category perfectly well.
    expect(notMeasuredReason('phone', seen(unknown))).toBeNull();
  });

  test('focus is not measured without a camera drive, and is with one', () => {
    expect(notMeasuredReason('focus', seen([scored('a')]))).toBe('noCamera');
    expect(notMeasuredReason('focus', seen([scored('a', { camera_session: 1 })]))).toBeNull();
  });

  test('a category that was measured and cost nothing is not a "nothing measured" case', () => {
    expect(notMeasuredReason('braking', seen([scored('a')]))).toBeNull();
  });

  test('the sentence is chosen by the same table that decides whether a drive measured it', () => {
    // The two gated categories get their own wording, and an ungated one is measured by every
    // scored drive, so it never reaches a reason at all. A second camera-gated category added to
    // the table brings its own sentence with it rather than inheriting speeding's.
    expect(notMeasuredReason('focus', seen([scored('a', { limit_coverage_pct: 10 })]))).toBe('noCamera');
    expect(notMeasuredReason('speeding', seen([scored('a', { limit_coverage_pct: 10 })]))).toBe('noLimit');
    const ungated: EventCategory[] = ['phone', 'braking', 'accel', 'cornering'];
    for (const category of ungated) {
      expect(notMeasuredReason(category, seen([scored('a', { limit_coverage_pct: 10 })]))).toBeNull();
    }
  });
});

test('no insight sentence promises the score cannot move between drives', () => {
  // §9.6 says "the score never decays from not driving" and `longTermScore` does not implement
  // it: the recency weights decay against a fixed prior, so a long gap slides the score toward
  // `LONG_TERM_MU0` — down from above it, up from below. Until the *model* changes, no string
  // here may claim otherwise, and this is the guard that keeps the claim from coming back.
  const said = [
    insightsCopy.trend.sparse(String(CONSTANTS.LONG_TERM_MU0)),
    insightsCopy.quietPeriod(periodPhrase('4w')),
    insightsCopy.youVsYou.quiet,
    insightsCopy.notEnough.body(MIN_SCORED_TRIPS),
  ];
  for (const sentence of said) {
    expect(sentence).not.toMatch(/never lowers|nothing is lost|can(not|'t) go down|never decays/i);
  }
});

describe('percentages that add up', () => {
  test('two shares that each round up still sum to a hundred', () => {
    expect(apportionPercents([0.625, 0.375])).toEqual(['63%', '37%']);
    expect(apportionPercents([1 / 3, 1 / 3, 1 / 3])).toEqual(['34%', '33%', '33%']);
    expect(apportionPercents([0.6, 0.4])).toEqual(['60%', '40%']);
  });

  test('nothing lost apportions to nothing, not to a hundred', () => {
    expect(apportionPercents([0, 0, 0])).toEqual(['0%', '0%', '0%']);
    expect(apportionPercents([])).toEqual([]);
  });

  test('the bars and the sentence above them print the same percent', () => {
    const rates = categoryRates([
      insight({ client_trip_id: 'a', category_deductions_json: JSON.stringify(deductions({ speeding: 20, phone: 12 })) }),
    ]);
    const rows = shareRows(rates);
    expect(rows[0]).toMatchObject({ key: 'speeding', printed: '63%' });
    expect(rows[1]).toMatchObject({ key: 'phone', printed: '37%' });
    expect(rows.reduce((total, r) => total + Number.parseInt(r.printed, 10), 0)).toBe(100);
    expect(shareSummary(rates, '3mo')).toBe('Speeding was 63% of the points you lost over 3 months.');
  });
});

describe('the spoken label of a chart', () => {
  const row = (key: string): BarRow => ({
    key,
    label: key,
    value: 1,
    max: 1,
    printed: '1',
    cells: [key, '1'],
    spoken: `${key}, 1 point`,
  });

  test('a short chart is read out row by row', () => {
    const rows = Array.from({ length: MAX_SPOKEN_ROWS }, (_, i) => row(`w${i}`));
    expect(describeRows('Caption', rows)).toBe(`Caption. ${rows.map((r) => r.spoken).join(', ')}`);
    expect(describeRows('Caption', [])).toBe('Caption');
  });

  test('a year of weeks is named and counted, not recited', () => {
    const rows = Array.from({ length: 52 }, (_, i) => row(`w${i}`));
    expect(describeRows('Speeding per 100 miles by week', rows)).toBe(
      'Speeding per 100 miles by week. 52 rows — open the table to read them.'
    );
  });
});

test('the you vs. you score row reproduces its own arithmetic', () => {
  const card = youVsYou([insight({ score: 83.5 })], { ...deductions(), score: 81 });
  if (card === null) throw new Error('no card');
  const row = youVsYouRows(card)[0];
  // "84 vs 81" beside "Up 2.5" would be a row that argues with itself.
  expect(row).toMatchObject({ detail: '84 vs 81', text: 'Up 3', direction: 'better' });

  // A movement that rounds away is Same, whatever the unrounded delta says.
  const tiny = youVsYou([insight({ score: 80.4 })], { ...deductions(), score: 80.1 });
  if (tiny === null) throw new Error('no card');
  expect(youVsYouRows(tiny)[0]).toMatchObject({ detail: '80 vs 80', text: 'Same', direction: 'same' });
});

test('the rates card prints the points it is named after', () => {
  const rates = categoryRates([
    insight({ distance_m: 10 * MILE_M, duration_s: 1800, category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) }),
  ]);
  expect(categoryFigures(rates, 'speeding', 1)).toMatchObject({ total: '6', deduction: 6 });
  expect(categoryFigures(rates, 'phone', 1)).toMatchObject({ total: '0' });
});
