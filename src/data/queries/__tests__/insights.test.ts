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
  MAX_TREND_WEEKS,
  median,
  parseStoredBaseline,
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
      distanceM: 0,
      durationS: 0,
    });
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

  test('three scored trips are enough data, and the long-term score is no longer provisional', () => {
    expect(insights.enoughData).toBe(true);
    expect(insights.scoredTripsAllTime).toBe(3);
    expect(insights.longTerm).toMatchObject({ provisional: false, tripsUsed: 3 });
    expect(typeof insights.longTerm.score).toBe('number');
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
