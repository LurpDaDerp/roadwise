/**
 * The insight aggregations (§7.E E1-E3), as pure functions over trip rows.
 *
 * Nothing here touches React, SQLite, a clock or a random source: `buildInsights` is given the
 * trips and the instant, and the same inputs always produce the same numbers. That is what makes
 * the arithmetic testable by hand — every formula below is stated in its doc comment and pinned
 * by a fixture whose expected value was computed on paper, not captured from a run.
 *
 * Exposure normalisation follows §9.2: a driver who drives twice as far is not twice as bad, so
 * a category is reported as points lost per 100 miles and per hour of driving, never as a raw
 * total alone.
 */
import { CATEGORY, CONSTANTS, longTermScore } from '@scoring';
import type { EventCategory, LongTermScore, TripForLongTerm } from '@scoring';

import { PERIOD_DAYS, type InsightsPeriod } from '@/data/queries/keys';
import { CATEGORIES, type TripSummary } from '@/data/queries/rows';
import { dayKey } from '@/lib/time';
import { METERS_PER_MILE } from '@/lib/units';

const DAY_MS = 86_400_000;
const HOUR_S = 3600;

/** The "you vs. you" comparison window (§7.E E1): the driver's current four weeks. */
export const YOU_VS_YOU_CURRENT_D = 28;
/**
 * The baseline behind it: the eight weeks *before* the current window, which is what §7.E E1
 * asks for ("current 4 weeks vs. previous 8-week baseline").
 *
 * Note this is **not** the server's window: `baselines()` in the edge function takes the *last*
 * 56 days, which overlaps the current four weeks and therefore shrinks every delta. The median
 * arithmetic is identical; only the window differs. Whoever wires `insights.baseline` from the
 * server must either move the server to `[now-84 d, now-28 d)` or caption the card differently
 * when `baselineSource === 'stored'`.
 */
export const BASELINE_WINDOW_D = 56;
/**
 * Ten years of weekly points. `all` over a long history would otherwise grow the trend without
 * bound; the cap keeps the newest weeks, which are the ones a chart can actually draw.
 */
export const MAX_TREND_WEEKS = 520;

/** Round half-up to `places`, and never hand back `-0` for a display value. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * The hour of `ts` on the clock in `tz`, 0-23 — the same `Intl` recipe `dayKey` uses, so a trip's
 * hour and its local day always come from one calendar. The device's own hour when `Intl` does
 * not know the zone.
 */
export function localHour(ts: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(ts));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    return Number.isFinite(hour) ? hour : new Date(ts).getHours();
  } catch {
    return new Date(ts).getHours();
  }
}

/** A scored trip, reduced to what every aggregation below needs. */
export interface InsightTrip {
  clientTripId: string;
  startedAt: number;
  endedAt: number;
  /** The trip's own local calendar date. */
  day: string;
  /** The trip's own zone, as `trips.tz` stored it. */
  tz: string;
  /** The hour the drive started, on the clock in `tz`, 0-23. Buckets the time-of-day split. */
  startHour: number;
  distanceM: number;
  durationS: number;
  score: number;
  exposure: number;
  categoryDeductions: Record<EventCategory, number>;
  night: boolean;
  precipitation: boolean;
}

/**
 * A scored trip becomes an `InsightTrip`; anything else (recording, unscored, discarded, or a
 * scored status with no number) becomes null and is left out of every aggregation.
 *
 * A trip that never recorded an end time is dated from its own duration, so a row recovered from
 * a checkpoint still lands in the right week instead of at the epoch.
 */
export function toInsightTrip(summary: TripSummary): InsightTrip | null {
  if (!summary.scored || summary.score === null) return null;
  return {
    clientTripId: summary.clientTripId,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt ?? summary.startedAt + summary.durationS * 1000,
    day: summary.day,
    tz: summary.tz,
    startHour: localHour(summary.startedAt, summary.tz),
    distanceM: summary.distanceM,
    durationS: summary.durationS,
    score: summary.score,
    // The exposure floor is 0.75 (§9.4); a row written before the column existed weights as 1.
    exposure: summary.exposure ?? 1,
    categoryDeductions: summary.categoryDeductions,
    night: summary.conditions.night,
    precipitation: summary.conditions.precipitation,
  };
}

/**
 * The exposure-weighted mean score, `Σ(Eₖ × Sₖ) / Σ Eₖ`, rounded to one decimal.
 *
 * Weighting by exposure is what stops a two-minute trip round the block from moving a week's
 * line as much as an hour on the highway. With no usable exposure at all it degrades to the
 * plain mean rather than reporting nothing.
 */
export function weightedScore(trips: readonly InsightTrip[]): number | null {
  if (trips.length === 0) return null;
  let weighted = 0;
  let weight = 0;
  for (const trip of trips) {
    const w = trip.exposure > 0 ? trip.exposure : 0;
    weighted += w * trip.score;
    weight += w;
  }
  if (weight === 0) {
    return round(trips.reduce((sum, t) => sum + t.score, 0) / trips.length, 1);
  }
  return round(weighted / weight, 1);
}

/** Points lost in one category over a window, normalised by distance and by driving time. */
export interface CategoryRate {
  category: EventCategory;
  /** Points this category cost across the window. */
  deduction: number;
  /** This category's share of every point lost, 0..1. Zero when nothing was lost. */
  share: number;
  /** `deduction × 100 / miles` — points lost per 100 miles. Null with no distance. */
  per100Mi: number | null;
  /** `deduction / hours` — points lost per hour of driving. Null with no driving time. */
  perHour: number | null;
  /** Trips in the window where this category cost something. */
  trips: number;
  /** The per-trip cap from §9.3, so a bar can be drawn against what the category can cost. */
  cap: number;
}

/**
 * Per-category rates over the given trips, costliest first (ties broken by the larger cap, then
 * alphabetically, so the order never depends on object-key order).
 */
export function categoryRates(trips: readonly InsightTrip[]): CategoryRate[] {
  const miles = trips.reduce((sum, t) => sum + t.distanceM, 0) / METERS_PER_MILE;
  const hours = trips.reduce((sum, t) => sum + t.durationS, 0) / HOUR_S;
  const totals = CATEGORIES.map((category) => ({
    category,
    raw: trips.reduce((sum, t) => sum + t.categoryDeductions[category], 0),
    trips: trips.filter((t) => t.categoryDeductions[category] > 0).length,
  }));
  const lost = totals.reduce((sum, t) => sum + t.raw, 0);

  return totals
    .map(({ category, raw, trips: hitTrips }) => ({
      category,
      deduction: round(raw, 2),
      share: lost > 0 ? round(raw / lost, 4) : 0,
      per100Mi: miles > 0 ? round((raw * 100) / miles, 2) : null,
      perHour: hours > 0 ? round(raw / hours, 2) : null,
      trips: hitTrips,
      cap: CATEGORY[category].cap,
    }))
    .sort(
      (a, b) =>
        b.deduction - a.deduction ||
        b.cap - a.cap ||
        (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
    );
}

/** The Monday of the ISO week `day` (a `YYYY-MM-DD` date) falls in, as `YYYY-MM-DD`. */
export function weekStartOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  // getUTCDay is 0 for Sunday; (dow + 6) % 7 is days since Monday.
  const back = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - back * DAY_MS).toISOString().slice(0, 10);
}

/** One point on the E1 trend line. A week with no driving still gets a point, with a null score. */
export interface TrendPoint {
  /** Monday of the week, `YYYY-MM-DD`. */
  weekStart: string;
  trips: number;
  /** The week's exposure-weighted mean score, or null when nothing was scored that week. */
  score: number | null;
  /**
   * Points the week lost per category — E2's per-category trend. With `distanceM` beside it a
   * screen can draw the same rate per 100 miles the overview reports, week by week.
   */
  categoryDeductions: Record<EventCategory, number>;
  distanceM: number;
  durationS: number;
}

/** Points lost per category across a set of trips, every category present, each rounded to 2 dp. */
export function sumCategoryDeductions(
  trips: readonly InsightTrip[]
): Record<EventCategory, number> {
  const out = {} as Record<EventCategory, number>;
  for (const category of CATEGORIES) {
    out[category] = round(
      trips.reduce((sum, trip) => sum + trip.categoryDeductions[category], 0),
      2
    );
  }
  return out;
}

/**
 * Weekly trend points from `fromDay` through `toDay`, inclusive of both weeks and with every
 * week in between present — "sparse periods show dots not lines" (§7.E E1) is then the chart's
 * decision, made from the null scores, rather than a gap it has to infer.
 *
 * A trip is bucketed by *its own* local day, so a drive taken in another time zone stays on the
 * date the driver remembers; the axis itself is enumerated in whatever zone `fromDay`/`toDay`
 * were computed in. Those two zones can disagree across a Monday at the edge of the window, so
 * the axis is the *union* of the enumerated weeks and the weeks that actually hold trips: a
 * drive is never silently dropped from its own trend, at the price of an occasional extra point
 * just outside the range.
 */
export function weeklyTrend(
  trips: readonly InsightTrip[],
  range: { fromDay: string; toDay: string }
): TrendPoint[] {
  const buckets = new Map<string, InsightTrip[]>();
  for (const trip of trips) {
    const week = weekStartOf(trip.day);
    const bucket = buckets.get(week);
    if (bucket) bucket.push(trip);
    else buckets.set(week, [trip]);
  }

  const first = weekStartOf(range.fromDay);
  const last = weekStartOf(range.toDay);
  const weeks: string[] = [];
  for (
    let at = Date.parse(`${first}T00:00:00Z`);
    at <= Date.parse(`${last}T00:00:00Z`);
    at += 7 * DAY_MS
  ) {
    weeks.push(new Date(at).toISOString().slice(0, 10));
  }
  const axis = new Set(weeks);
  for (const week of buckets.keys()) axis.add(week);
  const ordered = [...axis].sort();
  // Keep the newest weeks when a very long history would overflow the chart.
  const kept = ordered.length > MAX_TREND_WEEKS ? ordered.slice(-MAX_TREND_WEEKS) : ordered;

  return kept.map((weekStart) => {
    const own = buckets.get(weekStart) ?? [];
    return {
      weekStart,
      trips: own.length,
      score: weightedScore(own),
      categoryDeductions: sumCategoryDeductions(own),
      distanceM: own.reduce((sum, t) => sum + t.distanceM, 0),
      durationS: own.reduce((sum, t) => sum + t.durationS, 0),
    };
  });
}

/** The middle value, averaging the two middles of an even-length list. Empty is 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * The baseline (§9.6): per category, the median of the points that category cost *per trip*, and
 * `score`, the median trip score. The same definition the server stores under `baselines`, so a
 * locally computed baseline and a downloaded one are the same number.
 */
export function baselineMedians(trips: readonly InsightTrip[]): Record<string, number> | null {
  if (trips.length === 0) return null;
  const medians: Record<string, number> = {};
  for (const category of CATEGORIES) {
    medians[category] = round(median(trips.map((t) => t.categoryDeductions[category])), 2);
  }
  medians.score = round(median(trips.map((t) => t.score)), 2);
  return medians;
}

/** The keys a baseline may carry: the six scoring categories, plus the median trip score. */
export const BASELINE_KEYS: readonly string[] = [...CATEGORIES, 'score'];

/**
 * Read a stored baseline. Accepts the server's `{ medians, computedAt }` envelope and a bare
 * `{ phone: 2, … }` record alike, and answers null for anything else — a setting written by an
 * older build must not take a screen down.
 *
 * Only the six categories and `score` are kept: a bare envelope whose only number is a numeric
 * `computedAt` is not a baseline, and letting it through would compare every category against
 * `?? 0` and report six confident deltas from nothing.
 */
export function parseStoredBaseline(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inner = record.medians;
  const source =
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : record;
  const medians: Record<string, number> = {};
  for (const key of BASELINE_KEYS) {
    const entry = source[key];
    if (typeof entry === 'number' && Number.isFinite(entry)) medians[key] = entry;
  }
  return Object.keys(medians).length === 0 ? null : medians;
}

export type DeltaDirection = 'better' | 'worse' | 'same';

/** One "you vs. you" arrow. `delta` is always `current - baseline`. */
export interface Delta {
  key: EventCategory | 'score';
  current: number;
  baseline: number;
  delta: number;
  /** Which way the arrow points: fewer points lost is better; a higher score is better. */
  direction: DeltaDirection;
}

export interface YouVsYou {
  score: Delta;
  /** One per category, largest movement first. */
  categories: Delta[];
}

function deltaOf(
  key: Delta['key'],
  current: number,
  baseline: number,
  lowerIsBetter: boolean
): Delta {
  const delta = round(current - baseline, 2);
  const direction: DeltaDirection =
    delta === 0 ? 'same' : delta < 0 === lowerIsBetter ? 'better' : 'worse';
  return { key, current: round(current, 2), baseline: round(baseline, 2), delta, direction };
}

/**
 * The E1 "you vs. you" card: the current window's medians against the baseline's.
 *
 * Null when there is no baseline to compare with, or no trip in the current window — an arrow
 * drawn against nothing would be a judgement the data does not support.
 */
export function youVsYou(
  current: readonly InsightTrip[],
  baseline: Record<string, number> | null
): YouVsYou | null {
  if (baseline === null || current.length === 0) return null;
  const now = baselineMedians(current);
  if (now === null) return null;

  const categories = CATEGORIES.map((category) =>
    deltaOf(category, now[category] ?? 0, baseline[category] ?? 0, true)
  ).sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      CATEGORIES.indexOf(a.key as EventCategory) - CATEGORIES.indexOf(b.key as EventCategory)
  );

  return {
    score: deltaOf('score', now.score ?? 0, baseline.score ?? 0, false),
    categories,
  };
}

export interface ConditionSlice {
  trips: number;
  distanceM: number;
  durationS: number;
  /** Exposure-weighted mean score for the slice, or null when it holds no trips. */
  score: number | null;
}

/** Day/night and dry/wet, informational only (§7.E E1) — never an input to any score. */
export interface ConditionsSplit {
  night: ConditionSlice;
  day: ConditionSlice;
  wet: ConditionSlice;
  dry: ConditionSlice;
}

function slice(trips: readonly InsightTrip[]): ConditionSlice {
  return {
    trips: trips.length,
    distanceM: trips.reduce((sum, t) => sum + t.distanceM, 0),
    durationS: trips.reduce((sum, t) => sum + t.durationS, 0),
    score: weightedScore(trips),
  };
}

export function conditionsSplit(trips: readonly InsightTrip[]): ConditionsSplit {
  return {
    night: slice(trips.filter((t) => t.night)),
    day: slice(trips.filter((t) => !t.night)),
    wet: slice(trips.filter((t) => t.precipitation)),
    dry: slice(trips.filter((t) => !t.precipitation)),
  };
}

/**
 * The four time-of-day buckets E2 shows, by the hour the drive *started* on the clock where it
 * happened: night 22:00-04:59, morning 05:00-10:59, afternoon 11:00-16:59, evening 17:00-21:59.
 *
 * These are reading buckets, not the scoring night context: §9.4's `night` multiplier runs
 * 23:00-04:59 (`CONSTANTS.NIGHT_START_H`/`NIGHT_END_H`) and lives on `conditions.night`, which is
 * the flag the engine stored per trip. A drive at 22:30 is in the `night` bar here and was not
 * scored as a night drive, which is correct for both: the bar answers "when do I drive", the
 * multiplier answers "how dark was it".
 */
export type TimeOfDayBucket = 'night' | 'morning' | 'afternoon' | 'evening';
export const TIME_OF_DAY_BUCKETS: readonly TimeOfDayBucket[] = [
  'morning',
  'afternoon',
  'evening',
  'night',
];
/** The first hour of each daylight bucket, and the hour night begins. */
export const TIME_OF_DAY_BOUNDS = { morning: 5, afternoon: 11, evening: 17, night: 22 } as const;

export function timeOfDayBucket(hour: number): TimeOfDayBucket {
  if (hour >= TIME_OF_DAY_BOUNDS.night || hour < TIME_OF_DAY_BOUNDS.morning) return 'night';
  if (hour < TIME_OF_DAY_BOUNDS.afternoon) return 'morning';
  if (hour < TIME_OF_DAY_BOUNDS.evening) return 'afternoon';
  return 'evening';
}

/** A time-of-day bar: the slice, plus what each category cost inside it. */
export interface TimeOfDaySlice extends ConditionSlice {
  categoryDeductions: Record<EventCategory, number>;
}

export type TimeOfDaySplit = Record<TimeOfDayBucket, TimeOfDaySlice>;

/** Trips bucketed by their own local start hour — E2's "time-of-day pattern". */
export function timeOfDaySplit(trips: readonly InsightTrip[]): TimeOfDaySplit {
  const out = {} as TimeOfDaySplit;
  for (const bucket of TIME_OF_DAY_BUCKETS) {
    const own = trips.filter((trip) => timeOfDayBucket(trip.startHour) === bucket);
    out[bucket] = { ...slice(own), categoryDeductions: sumCategoryDeductions(own) };
  }
  return out;
}

export interface InsightTotals {
  /** Every visible trip in the window, scored or not. */
  trips: number;
  scoredTrips: number;
  /** Metres and seconds of *scored* driving — what the rates are normalised by. */
  distanceM: number;
  durationS: number;
}

export interface BuildInsightsInput {
  /** Every visible local trip; hidden rows (recording, discarded) are dropped by the caller. */
  trips: readonly TripSummary[];
  period: InsightsPeriod;
  now: number;
  /** The stored 8-week medians (§9.6), when the app has them. */
  baseline?: Record<string, number> | null;
  /**
   * The zone the trend's week axis is enumerated in. The device's own zone by default — the
   * driver reads the chart where they are standing — but a test (or a fixed-zone screenshot)
   * pins it so the axis does not move with the machine.
   */
  tz?: string;
}

export interface Insights {
  period: InsightsPeriod;
  /** The window, epoch ms. `from` is the first trip's end for `all`. */
  from: number;
  to: number;
  totals: InsightTotals;
  /** Scored trips the driver has ever made — what "Building your score: 1 of 3" counts. */
  scoredTripsAllTime: number;
  /** At least `LONG_TERM_MIN_TRIPS` scored trips exist, so E1 shows charts and not a progress state. */
  enoughData: boolean;
  /** §9.6 over the driver's whole history, not the selected period: the ring on B1 and E1. */
  longTerm: LongTermScore;
  categories: CategoryRate[];
  trend: TrendPoint[];
  youVsYou: YouVsYou | null;
  /** Where the baseline behind `youVsYou` came from, or null when there was none. */
  baselineSource: 'stored' | 'local' | null;
  conditions: ConditionsSplit;
  /** E2's time-of-day pattern over the window, by the trip's own local start hour. */
  timeOfDay: TimeOfDaySplit;
}

const forLongTerm = (trip: InsightTrip): TripForLongTerm => ({
  endedAt: trip.endedAt,
  score: trip.score,
  exposure: trip.exposure,
  durationS: trip.durationS,
});

/**
 * Everything E1 draws, from the trip rows and one instant.
 *
 * The period selector moves the rates, the trend and the totals. It deliberately does *not* move
 * the "you vs. you" card or the long-term ring: §7.E E1 defines the card as the current four
 * weeks against the previous eight, and §9.6 gives the ring its own 60-day window, so both would
 * be wrong if the selector rewrote them.
 */
export function buildInsights(input: BuildInsightsInput): Insights {
  const { period, now } = input;
  const all: InsightTrip[] = [];
  for (const summary of input.trips) {
    const trip = toInsightTrip(summary);
    if (trip !== null) all.push(trip);
  }

  const days = period === 'all' ? null : PERIOD_DAYS[period];
  const windowFrom = days === null ? null : now - days * DAY_MS;
  const inWindow =
    windowFrom === null ? all : all.filter((trip) => trip.endedAt >= windowFrom);
  const visibleInWindow = input.trips.filter(
    (summary) =>
      windowFrom === null || (summary.endedAt ?? summary.startedAt) >= windowFrom
  );

  const earliest = inWindow.reduce(
    (min, trip) => Math.min(min, trip.endedAt),
    Number.POSITIVE_INFINITY
  );
  const from = windowFrom ?? (Number.isFinite(earliest) ? earliest : now);

  const currentFrom = now - YOU_VS_YOU_CURRENT_D * DAY_MS;
  const baselineFrom = currentFrom - BASELINE_WINDOW_D * DAY_MS;
  const current = all.filter((trip) => trip.endedAt >= currentFrom);
  const previous = all.filter(
    (trip) => trip.endedAt >= baselineFrom && trip.endedAt < currentFrom
  );
  const stored = input.baseline ?? null;
  const localBaseline = stored === null ? baselineMedians(previous) : null;
  const baseline = stored ?? localBaseline;

  return {
    period,
    from,
    to: now,
    totals: {
      trips: visibleInWindow.length,
      scoredTrips: inWindow.length,
      distanceM: inWindow.reduce((sum, t) => sum + t.distanceM, 0),
      durationS: inWindow.reduce((sum, t) => sum + t.durationS, 0),
    },
    scoredTripsAllTime: all.length,
    enoughData: all.length >= CONSTANTS.LONG_TERM_MIN_TRIPS,
    longTerm: longTermScore(all.map(forLongTerm), now),
    categories: categoryRates(inWindow),
    trend: weeklyTrend(inWindow, {
      fromDay: dayKey(new Date(from), input.tz),
      toDay: dayKey(new Date(now), input.tz),
    }),
    youVsYou: youVsYou(current, baseline),
    baselineSource: stored !== null ? 'stored' : localBaseline !== null ? 'local' : null,
    conditions: conditionsSplit(inWindow),
    timeOfDay: timeOfDaySplit(inWindow),
  };
}
