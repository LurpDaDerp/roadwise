/**
 * Every expected number below was computed by hand from the fixtures, not captured from a run.
 *
 * The three trips share one shape so the arithmetic stays checkable:
 *   A  Mon 2026-01-05  10 mi  0.5 h  score 90  speeding 6, braking 4
 *   B  Wed 2026-01-07  20 mi  1.0 h  score 80  speeding 10, phone 10
 *   C  Mon 2026-01-12   5 mi  0.25 h score 100 clean
 * which is 35 miles and 1.75 hours of driving, 30 points lost, and "now" is 2026-01-20T12:00Z.
 */
import { deductions, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  baselineMedians,
  buildInsights,
  categoryRates,
  conditionsSplit,
  localHour,
  MAX_TREND_WEEKS,
  median,
  parseStoredBaseline,
  timeOfDayBucket,
  timeOfDaySplit,
  toInsightTrip,
  weeklyTrend,
  weekStartOf,
  weightedScore,
  youVsYou,
  type InsightTrip,
} from '@/data/queries/insights';
import { toTripSummary } from '@/data/queries/rows';

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);

const summary = (over: Parameters<typeof tripRow>[0]) => toTripSummary(tripRow(over));

const A = summary({
  client_trip_id: 'a',
  started_at: Date.UTC(2026, 0, 5, 12, 0, 0),
  duration_s: 1800,
  distance_m: 10 * MILE_M,
  score: 90,
  category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 4 })),
});
const B = summary({
  client_trip_id: 'b',
  started_at: Date.UTC(2026, 0, 7, 12, 0, 0),
  duration_s: 3600,
  distance_m: 20 * MILE_M,
  score: 80,
  category_deductions_json: JSON.stringify(deductions({ speeding: 10, phone: 10 })),
});
const C = summary({
  client_trip_id: 'c',
  started_at: Date.UTC(2026, 0, 12, 12, 0, 0),
  duration_s: 900,
  distance_m: 5 * MILE_M,
  score: 100,
});
/** Inside the previous eight weeks: the local baseline window, not the current one. */
const OLD = summary({
  client_trip_id: 'old',
  started_at: Date.UTC(2025, 11, 1, 12, 0, 0),
  duration_s: 3600,
  distance_m: 20 * MILE_M,
  score: 70,
  category_deductions_json: JSON.stringify(deductions({ speeding: 12 })),
});

const trips = [A, B, C].map((s) => toInsightTrip(s) as InsightTrip);

describe('toInsightTrip', () => {
  test('keeps scored trips and drops everything else', () => {
    expect(toInsightTrip(A)).toMatchObject({ clientTripId: 'a', score: 90, exposure: 1 });
    expect(toInsightTrip(summary({ status: 'unscored', score: null }))).toBeNull();
    expect(toInsightTrip(summary({ status: 'discarded', score: null }))).toBeNull();
  });

  test('a trip with no end time is dated from its own duration', () => {
    const trip = toInsightTrip(summary({ ended_at: null, duration_s: 1800 }));
    expect(trip?.endedAt).toBe(Date.UTC(2026, 0, 5, 12, 30, 0));
  });
});

describe('weightedScore', () => {
  test('weights by exposure, so a long trip counts for more than a short one', () => {
    const long = toInsightTrip(summary({ client_trip_id: 'l', score: 90, exposure: 2 }));
    const short = toInsightTrip(summary({ client_trip_id: 's', score: 60, exposure: 1 }));
    // (2 x 90 + 1 x 60) / 3 = 80
    expect(weightedScore([long as InsightTrip, short as InsightTrip])).toBe(80);
  });

  test('no trips means no score, and no exposure falls back to the plain mean', () => {
    expect(weightedScore([])).toBeNull();
    const a = toInsightTrip(summary({ client_trip_id: 'a', score: 90, exposure: 0 }));
    const b = toInsightTrip(summary({ client_trip_id: 'b', score: 70, exposure: 0 }));
    expect(weightedScore([a as InsightTrip, b as InsightTrip])).toBe(80);
  });
});

describe('categoryRates', () => {
  const rates = categoryRates(trips);
  const of = (category: string) => rates.find((r) => r.category === category);

  test('costliest category first, then by cap, then alphabetically', () => {
    expect(rates.map((r) => r.category)).toEqual([
      'speeding',
      'phone',
      'braking',
      // Nothing was lost in these three, so the larger cap leads: focus 15, cornering 10, accel 8.
      'focus',
      'cornering',
      'accel',
    ]);
  });

  test('points per 100 miles and per driving hour over 35 miles and 1.75 hours', () => {
    // speeding: 16 points. 16 x 100 / 35 = 45.714... ; 16 / 1.75 = 9.142...
    expect(of('speeding')).toMatchObject({
      deduction: 16,
      per100Mi: 45.71,
      perHour: 9.14,
      trips: 2,
      cap: 25,
    });
    // phone: 10 points on one trip. 1000 / 35 = 28.571... ; 10 / 1.75 = 5.714...
    expect(of('phone')).toMatchObject({ deduction: 10, per100Mi: 28.57, perHour: 5.71, trips: 1 });
    // braking: 4 points. 400 / 35 = 11.428... ; 4 / 1.75 = 2.285...
    expect(of('braking')).toMatchObject({ deduction: 4, per100Mi: 11.43, perHour: 2.29, trips: 1 });
  });

  test('share of the 30 points lost', () => {
    expect(of('speeding')?.share).toBe(0.5333);
    expect(of('phone')?.share).toBe(0.3333);
    expect(of('braking')?.share).toBe(0.1333);
    expect(of('focus')?.share).toBe(0);
  });

  test('with no trips there is no rate to report, and no division by zero', () => {
    const empty = categoryRates([]);
    expect(empty).toHaveLength(6);
    expect(empty.every((r) => r.deduction === 0 && r.per100Mi === null && r.perHour === null)).toBe(
      true
    );
  });
});

describe('weekStartOf', () => {
  test('a Monday is its own week start', () => {
    expect(weekStartOf('2026-01-05')).toBe('2026-01-05');
  });

  test('every other day walks back to its Monday, Sunday included', () => {
    expect(weekStartOf('2026-01-07')).toBe('2026-01-05');
    expect(weekStartOf('2026-01-11')).toBe('2026-01-05');
    expect(weekStartOf('2026-01-04')).toBe('2025-12-29');
  });

  test('a string that is not a date is handed back unchanged', () => {
    expect(weekStartOf('not-a-day')).toBe('not-a-day');
  });
});

describe('weeklyTrend', () => {
  const points = weeklyTrend(trips, { fromDay: '2026-01-05', toDay: '2026-01-19' });

  test('one point per week across the range, empty weeks included', () => {
    expect(points.map((p) => p.weekStart)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });

  test('the week score is the exposure-weighted mean of its trips', () => {
    // A and B share the first week: (90 + 80) / 2 = 85.
    expect(points[0]).toMatchObject({ trips: 2, score: 85, durationS: 5400 });
    expect(points[0]?.distanceM).toBeCloseTo(30 * MILE_M, 2);
    expect(points[1]).toMatchObject({ trips: 1, score: 100, durationS: 900 });
  });

  test('a week with no driving is a point with no score, not a gap', () => {
    expect(points[2]).toEqual({
      weekStart: '2026-01-19',
      trips: 0,
      score: null,
      categoryDeductions: deductions(),
      distanceM: 0,
      durationS: 0,
    });
  });

  test('each point carries what every category cost that week', () => {
    // Week of 2026-01-05 holds A (speeding 6, braking 4) and B (speeding 10, phone 10).
    expect(points[0]?.categoryDeductions).toEqual(
      deductions({ phone: 10, speeding: 16, braking: 4 })
    );
    // C was clean, so its week reports zeros rather than nothing.
    expect(points[1]?.categoryDeductions).toEqual(deductions());
  });

  test('a trip whose own week falls outside the axis still gets its point', () => {
    // The axis is one week long; the trip's own local day is in the week before it.
    const early = toInsightTrip(
      summary({ client_trip_id: 'early', started_at: Date.UTC(2025, 11, 30, 12, 0, 0), score: 90 })
    ) as InsightTrip;
    const edge = weeklyTrend([early], { fromDay: '2026-01-05', toDay: '2026-01-05' });
    expect(edge.map((p) => p.weekStart)).toEqual(['2025-12-29', '2026-01-05']);
    expect(edge[0]).toMatchObject({ trips: 1, score: 90 });
  });

  test('a very long history keeps the newest weeks rather than growing without bound', () => {
    const long = weeklyTrend(trips, { fromDay: '2005-01-03', toDay: '2026-01-19' });
    expect(long).toHaveLength(MAX_TREND_WEEKS);
    expect(long[long.length - 1]?.weekStart).toBe('2026-01-19');
  });
});

describe('median and baselines', () => {
  test('median of an odd and an even list', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(median([])).toBe(0);
  });

  test('the baseline is the per-trip median of each category, plus the median score', () => {
    // speeding [6, 10, 0] -> 6; braking [4, 0, 0] -> 0; phone [0, 10, 0] -> 0; scores -> 90.
    expect(baselineMedians(trips)).toEqual({
      phone: 0,
      speeding: 6,
      braking: 0,
      accel: 0,
      cornering: 0,
      focus: 0,
      score: 90,
    });
  });

  test('no trips means no baseline', () => {
    expect(baselineMedians([])).toBeNull();
  });
});

describe('parseStoredBaseline', () => {
  test('reads the server envelope and a bare record alike', () => {
    expect(parseStoredBaseline({ medians: { phone: 2, score: 84 }, computedAt: 'x' })).toEqual({
      phone: 2,
      score: 84,
    });
    expect(parseStoredBaseline({ phone: 2 })).toEqual({ phone: 2 });
  });

  test('anything without a finite number in it is no baseline at all', () => {
    expect(parseStoredBaseline(null)).toBeNull();
    expect(parseStoredBaseline('{}')).toBeNull();
    expect(parseStoredBaseline([1, 2])).toBeNull();
    expect(parseStoredBaseline({})).toBeNull();
    expect(parseStoredBaseline({ phone: 'lots' })).toBeNull();
    // A numeric `computedAt` is not a baseline: letting it through would report six confident
    // deltas against nothing.
    expect(parseStoredBaseline({ computedAt: 1_700_000_000 })).toBeNull();
    expect(parseStoredBaseline({ medians: { speeding: 4, nonsense: 9 } })).toEqual({ speeding: 4 });
  });
});

describe('youVsYou', () => {
  const baseline = {
    phone: 0,
    speeding: 4,
    braking: 0,
    accel: 0,
    cornering: 0,
    focus: 0,
    score: 85,
  };

  test('deltas are current minus baseline, and fewer points lost is better', () => {
    const result = youVsYou(trips, baseline);
    // Current speeding median is 6 against a baseline of 4: two points worse.
    expect(result?.categories[0]).toEqual({
      key: 'speeding',
      current: 6,
      baseline: 4,
      delta: 2,
      direction: 'worse',
    });
    // A higher score is better, so +5 points is an improvement.
    expect(result?.score).toEqual({
      key: 'score',
      current: 90,
      baseline: 85,
      delta: 5,
      direction: 'better',
    });
  });

  test('a category that improved points the other way', () => {
    const result = youVsYou(trips, { ...baseline, speeding: 10 });
    expect(result?.categories[0]).toMatchObject({ delta: -4, direction: 'better' });
  });

  test('largest movement first, then the catalogue order for the categories that did not move', () => {
    const result = youVsYou(trips, baseline);
    expect(result?.categories.map((d) => d.key)).toEqual([
      'speeding',
      'phone',
      'braking',
      'accel',
      'cornering',
      'focus',
    ]);
    expect(result?.categories.slice(1).every((d) => d.direction === 'same')).toBe(true);
  });

  test('no baseline and no current trips each mean no card', () => {
    expect(youVsYou(trips, null)).toBeNull();
    expect(youVsYou([], baseline)).toBeNull();
  });
});

describe('conditionsSplit', () => {
  test('splits day from night and dry from wet, informational only', () => {
    const night = toInsightTrip(
      summary({
        client_trip_id: 'n',
        score: 70,
        conditions_json: JSON.stringify({ night: true, precipitation: true }),
      })
    ) as InsightTrip;
    const split = conditionsSplit([...trips, night]);
    expect(split.night).toMatchObject({ trips: 1, score: 70 });
    expect(split.day).toMatchObject({ trips: 3, score: 90 });
    expect(split.wet).toMatchObject({ trips: 1, score: 70 });
    expect(split.dry).toMatchObject({ trips: 3, score: 90 });
  });

  test('an empty slice reports no score rather than a zero', () => {
    expect(conditionsSplit(trips).night).toEqual({
      trips: 0,
      distanceM: 0,
      durationS: 0,
      score: null,
    });
  });
});

describe('buildInsights', () => {
  const insights = buildInsights({ trips: [A, B, C], period: '4w', now: NOW, tz: 'UTC' });

  test('the window is the period, counted back from now', () => {
    expect(insights.to).toBe(NOW);
    expect(insights.from).toBe(NOW - 28 * 86_400_000);
    expect(insights.period).toBe('4w');
  });

  test('totals cover the window, and the rates are the ones computed over it', () => {
    expect(insights.totals).toMatchObject({ trips: 3, scoredTrips: 3, durationS: 6300 });
    expect(insights.totals.distanceM).toBeCloseTo(35 * MILE_M, 2);
    expect(insights.categories[0]).toMatchObject({ category: 'speeding', per100Mi: 45.71 });
  });

  test('three scored trips are enough data, and the long-term score is the §9.6 number', () => {
    expect(insights.enoughData).toBe(true);
    expect(insights.scoredTripsAllTime).toBe(3);
    // w = min(E,3) x 0.5^(age/21) at NOW: A 14.979 d -> 0.60992, B 12.958 d -> 0.65200,
    // C 7.990 d -> 0.76820. Sw = 2.03012, SwS = 183.8728.
    // (183.8728 + 2 x 80) / (2.03012 + 2) = 343.8728 / 4.03012 = 85.326 -> 85, band good.
    expect(insights.longTerm).toEqual({
      score: 85,
      band: 'good',
      provisional: false,
      tripsUsed: 3,
    });
  });

  test('exposure reaches the long-term score: A at exposure 3 moves it to 86', () => {
    const heavy = summary({
      client_trip_id: 'a',
      started_at: Date.UTC(2026, 0, 5, 12, 0, 0),
      duration_s: 1800,
      distance_m: 10 * MILE_M,
      score: 90,
      exposure: 3,
      category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 4 })),
    });
    // w_A becomes 3 x 0.60992 = 1.82976: (293.6584 + 160) / (3.24996 + 2) = 86.412 -> 86.
    const weighted = buildInsights({ trips: [heavy, B, C], period: '4w', now: NOW, tz: 'UTC' });
    expect(weighted.longTerm).toMatchObject({ score: 86, band: 'good', tripsUsed: 3 });
  });

  test('an unscored trip counts towards the window total but towards nothing else', () => {
    const unscored = summary({
      client_trip_id: 'u',
      started_at: Date.UTC(2026, 0, 13, 12, 0, 0),
      status: 'unscored',
      score: null,
    });
    const mixed = buildInsights({ trips: [A, B, C, unscored], period: '4w', now: NOW, tz: 'UTC' });
    expect(mixed.totals).toMatchObject({ trips: 4, scoredTrips: 3, durationS: 6300 });
    expect(mixed.scoredTripsAllTime).toBe(3);
    expect(mixed.longTerm.tripsUsed).toBe(3);
  });

  test('the trend spans every week of the window, in the zone it was given', () => {
    expect(insights.trend.map((p) => p.weekStart)).toEqual([
      '2025-12-22',
      '2025-12-29',
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
    ]);
    expect(insights.trend[2]).toMatchObject({ trips: 2, score: 85 });
  });

  test('with nothing behind the current four weeks there is no you-vs-you card', () => {
    expect(insights.youVsYou).toBeNull();
    expect(insights.baselineSource).toBeNull();
  });

  test('two scored trips are not enough data, and the score is withheld', () => {
    const thin = buildInsights({ trips: [A, B], period: '4w', now: NOW, tz: 'UTC' });
    expect(thin.enoughData).toBe(false);
    expect(thin.longTerm).toMatchObject({ score: null, band: null, provisional: true });
  });

  test('the stored baseline wins when the app has one', () => {
    const withStored = buildInsights({
      trips: [A, B, C],
      period: '4w',
      now: NOW,
      tz: 'UTC',
      baseline: { speeding: 2, score: 95 },
    });
    expect(withStored.baselineSource).toBe('stored');
    expect(withStored.youVsYou?.categories[0]).toMatchObject({
      key: 'speeding',
      baseline: 2,
      delta: 4,
      direction: 'worse',
    });
    expect(withStored.youVsYou?.score).toMatchObject({ baseline: 95, delta: -5, direction: 'worse' });
  });

  test('without a stored baseline the previous eight weeks of local trips stand in', () => {
    const local = buildInsights({ trips: [A, B, C, OLD], period: '4w', now: NOW, tz: 'UTC' });
    expect(local.baselineSource).toBe('local');
    // OLD is the only trip in the baseline window: speeding 12, score 70.
    expect(local.youVsYou?.categories[0]).toMatchObject({
      key: 'speeding',
      current: 6,
      baseline: 12,
      delta: -6,
      direction: 'better',
    });
    expect(local.youVsYou?.score).toMatchObject({ current: 90, baseline: 70, delta: 20 });
  });

  test('a trip outside the period is left out of the rates but still counted as a scored trip', () => {
    const local = buildInsights({ trips: [A, B, C, OLD], period: '4w', now: NOW, tz: 'UTC' });
    expect(local.totals.scoredTrips).toBe(3);
    expect(local.scoredTripsAllTime).toBe(4);
    expect(local.categories[0]).toMatchObject({ category: 'speeding', deduction: 16 });
  });

  test('all starts at the first trip and takes everything in', () => {
    const all = buildInsights({ trips: [A, B, C, OLD], period: 'all', now: NOW, tz: 'UTC' });
    expect(all.from).toBe(Date.UTC(2025, 11, 1, 13, 0, 0));
    expect(all.totals.scoredTrips).toBe(4);
    // speeding 6 + 10 + 12 = 28 across the whole history.
    expect(all.categories[0]).toMatchObject({ category: 'speeding', deduction: 28 });
  });

  test('a driver with no trips gets an empty window rather than a NaN', () => {
    const none = buildInsights({ trips: [], period: 'all', now: NOW, tz: 'UTC' });
    expect(none).toMatchObject({
      from: NOW,
      to: NOW,
      scoredTripsAllTime: 0,
      enoughData: false,
      youVsYou: null,
      baselineSource: null,
    });
    expect(none.totals).toEqual({ trips: 0, scoredTrips: 0, distanceM: 0, durationS: 0 });
    expect(none.categories.every((r) => r.per100Mi === null)).toBe(true);
  });
});

describe('time of day (E2)', () => {
  const at = (id: string, iso: string, over: Parameters<typeof tripRow>[0] = {}) =>
    toInsightTrip(summary({ client_trip_id: id, started_at: Date.parse(iso), ...over })) as InsightTrip;

  test('the boundaries are night 22-05, morning 05-11, afternoon 11-17, evening 17-22', () => {
    expect([0, 4, 22, 23].map(timeOfDayBucket)).toEqual(['night', 'night', 'night', 'night']);
    expect([5, 10].map(timeOfDayBucket)).toEqual(['morning', 'morning']);
    expect([11, 16].map(timeOfDayBucket)).toEqual(['afternoon', 'afternoon']);
    expect([17, 21].map(timeOfDayBucket)).toEqual(['evening', 'evening']);
  });

  test('the hour is the one on the clock where the drive started', () => {
    // 2026-01-13T02:00Z is 18:00 the previous evening in Los Angeles.
    expect(localHour(Date.UTC(2026, 0, 13, 2, 0, 0), 'America/Los_Angeles')).toBe(18);
    expect(localHour(Date.UTC(2026, 0, 13, 2, 0, 0), 'UTC')).toBe(2);
    const abroad = at('abroad', '2026-01-13T02:00:00Z', { tz: 'America/Los_Angeles' });
    expect(abroad.startHour).toBe(18);
    expect(timeOfDayBucket(abroad.startHour)).toBe('evening');
  });

  test('buckets the window by start hour, with what each category cost inside it', () => {
    const morning = at('m', '2026-01-13T07:00:00Z', {
      score: 90,
      category_deductions_json: JSON.stringify(deductions({ phone: 5 })),
    });
    const evening = at('e', '2026-01-13T19:00:00Z', {
      score: 70,
      category_deductions_json: JSON.stringify(deductions({ speeding: 8 })),
    });
    const night = at('n', '2026-01-14T23:00:00Z', {
      score: 60,
      category_deductions_json: JSON.stringify(deductions({ braking: 3 })),
    });

    const split = timeOfDaySplit([...trips, morning, evening, night]);
    // A, B and C all start at 12:00Z.
    expect(split.afternoon).toMatchObject({ trips: 3, score: 90 });
    expect(split.afternoon.categoryDeductions).toEqual(
      deductions({ phone: 10, speeding: 16, braking: 4 })
    );
    expect(split.morning).toMatchObject({ trips: 1, score: 90 });
    expect(split.morning.categoryDeductions).toEqual(deductions({ phone: 5 }));
    expect(split.evening).toMatchObject({ trips: 1, score: 70 });
    expect(split.night).toMatchObject({ trips: 1, score: 60 });
    expect(split.night.categoryDeductions).toEqual(deductions({ braking: 3 }));
  });

  test('an empty bucket reports no score rather than a zero', () => {
    const split = timeOfDaySplit(trips);
    expect(split.night).toEqual({
      trips: 0,
      distanceM: 0,
      durationS: 0,
      score: null,
      categoryDeductions: deductions(),
    });
  });

  test('a 22:30 drive is a night bar but was never scored as a night drive', () => {
    // The bar runs from 22:00; §9.4's night multiplier starts at 23:00 and lives on `conditions`.
    const late = at('late', '2026-01-13T22:30:00Z', { score: 80 });
    expect(timeOfDayBucket(late.startHour)).toBe('night');
    expect(late.night).toBe(false);
    expect(conditionsSplit([late]).night.trips).toBe(0);
  });

  test('buildInsights reports the split over the window', () => {
    const insights = buildInsights({ trips: [A, B, C], period: '4w', now: NOW, tz: 'UTC' });
    expect(insights.timeOfDay.afternoon.trips).toBe(3);
    expect(insights.timeOfDay.morning.trips).toBe(0);
  });
});
