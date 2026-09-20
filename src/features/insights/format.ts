/**
 * What the insight screens derive from the aggregates before anything is drawn. Pure: no React,
 * no theme, no database — every sentence and every bar length is testable on its own.
 *
 * Two `TrendPoint` types exist and they are not the same shape: `@/data/queries` exports the
 * aggregate (a week: `weekStart`, `score`, `categoryDeductions`, …) and `@/ui/charts` exports the
 * chart's input (`label`, `value`, `longLabel`). `toChartTrend` is the one adapter between them.
 */
import { CONSTANTS } from '@scoring';
import type { EventCategory } from '@scoring';

import { categoryCaps } from '@/content/scoring-explainer';
import { tips, type Tip, type TipStage } from '@/content/tips';
import {
  CATEGORIES,
  TIME_OF_DAY_BUCKETS,
  type CategoryRate,
  type ConditionSlice,
  type ConditionsSplit,
  type DayEntry,
  type DayRange,
  type Delta,
  type Insights,
  type TimeOfDayBucket,
  type TimeOfDaySplit,
  type TrendPoint as InsightTrendPoint,
  type TripSummary,
  type YouVsYou,
} from '@/data/queries';
import { formatDuration } from '@/lib/format';
import { dayKey } from '@/lib/time';
import { METERS_PER_MILE } from '@/lib/units';
import {
  formatPoints,
  formatScore,
  type ChartTableRow,
  type TrendPoint as ChartTrendPoint,
} from '@/ui/charts';

import { insightsCopy as copy } from './copy';
import { periodPhrase, type InsightsPeriod } from './period';

/**
 * §7.E E1: under this many scored drives ever, the overview shows the progress state rather than
 * charts drawn from one or two drives. Taken from the engine so the screen and §9.6 agree.
 */
export const MIN_SCORED_TRIPS: number = CONSTANTS.LONG_TERM_MIN_TRIPS;

// --- Categories ----------------------------------------------------------------------------------

const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = Object.fromEntries(
  categoryCaps.map((entry) => [entry.category, entry.label])
) as Record<EventCategory, string>;

/** The category's name as the scoring explainer prints it: "Phone use", "Speeding", … */
export function categoryLabel(category: EventCategory): string {
  return CATEGORY_LABEL[category];
}

/** The same name where it sits inside a sentence: "nothing lost to phone use". */
export function categoryPhrase(category: EventCategory): string {
  return CATEGORY_LABEL[category].toLowerCase();
}

/** The `[category]` route segment is untyped; anything that is not one of the six is null. */
export function parseCategory(raw: string | readonly string[] | undefined): EventCategory | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (CATEGORIES as readonly string[]).includes(value as string)
    ? (value as EventCategory)
    : null;
}

// --- Numbers -------------------------------------------------------------------------------------

const MILES = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MILES_FINE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "1,235 mi" — grouped, and with a decimal only under ten miles. */
export function formatMiles(meters: number): string {
  const mi = meters / METERS_PER_MILE;
  return `${(mi < 10 ? MILES_FINE : MILES).format(mi)} mi`;
}

/** A rate (points per 100 miles, per hour) prints like points; a missing one prints as a dash. */
export function formatRate(rate: number | null): string {
  return rate === null ? copy.category.rates.noRate : formatPoints(rate);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A printed label dropped into the middle of a sentence: only its first letter is lowered. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// --- Weeks ---------------------------------------------------------------------------------------

const WEEK = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Jan 5" for the Monday `2026-01-05`. Week starts are UTC date strings, so they are read as UTC. */
export function weekLabel(weekStart: string): string {
  const at = Date.parse(`${weekStart}T00:00:00Z`);
  return Number.isNaN(at) ? weekStart : WEEK.format(new Date(at));
}

/** "Week of Jan 5" — the row's name in a table and to a screen reader. */
export function weekLongLabel(weekStart: string): string {
  return `Week of ${weekLabel(weekStart)}`;
}

/**
 * The aggregate's weekly points as the chart takes them. The axis is whatever the aggregate
 * enumerated — the union of the period's weeks and the weeks that hold trips — so a point may sit
 * just outside the period window and the first point is not assumed to be the window's first week.
 */
export function toChartTrend(trend: readonly InsightTrendPoint[]): ChartTrendPoint[] {
  return trend.map((p) => ({
    label: weekLabel(p.weekStart),
    longLabel: weekLongLabel(p.weekStart),
    value: p.score,
  }));
}

/**
 * The visible line under the E1 trend: the movement between the first and last scored weeks in
 * the period's words, plus the spec's note whenever a week *between* two scored weeks has no
 * drive. A quiet current week is not a gap and does not earn the note.
 */
export function trendSummary(trend: readonly InsightTrendPoint[], period: InsightsPeriod): string {
  const over = periodPhrase(period);
  const scoredIdx = trend.map((p, i) => (p.score === null ? -1 : i)).filter((i) => i >= 0);
  const first = scoredIdx[0];
  const last = scoredIdx[scoredIdx.length - 1];
  if (first === undefined || last === undefined) return copy.trend.none(over);

  const firstScore = trend[first]?.score ?? 0;
  const lastScore = trend[last]?.score ?? 0;
  let sentence: string;
  if (scoredIdx.length === 1) {
    sentence = copy.trend.one(formatScore(lastScore));
  } else {
    const diff = Math.round(lastScore) - Math.round(firstScore);
    sentence =
      diff > 0
        ? copy.trend.up(String(diff), over)
        : diff < 0
          ? copy.trend.down(String(-diff), over)
          : copy.trend.steady(formatScore(lastScore), over);
  }
  const sparse = trend.slice(first, last + 1).some((p) => p.score === null);
  return sparse ? `${sentence} ${copy.trend.sparse}` : sentence;
}

// --- Bars ----------------------------------------------------------------------------------------

/** One printed field box: the fill is `value / max`; `null` is a box with nothing to fill. */
export interface BarRow {
  key: string;
  label: string;
  value: number | null;
  max: number;
  /** The value as printed beside the box. */
  printed: string;
  /** The same row in the "Show as table" view; the builder knows its own columns. */
  cells: readonly string[];
  /** The whole row as one sentence for a screen reader. */
  spoken: string;
}

/**
 * Beyond this many rows the label stops enumerating. A year of weeks read out in one utterance is
 * two thousand characters a reader cannot pause, rewind or skim; the table is the place for that.
 */
export const MAX_SPOKEN_ROWS = 8;

/**
 * The whole set of bars in one sentence: what a reader gets instead of the drawing. A short set is
 * read out row by row; a long one is named and counted, and "Show as table" carries the detail.
 */
export function describeRows(caption: string, rows: readonly BarRow[]): string {
  if (rows.length === 0) return caption;
  if (rows.length > MAX_SPOKEN_ROWS) return copy.chart.manyRows(caption, rows.length);
  return `${caption}. ${rows.map((row) => row.spoken).join(', ')}`;
}

/** The same rows as the ruled table `ChartTable` prints. */
export function tableRows(rows: readonly BarRow[]): ChartTableRow[] {
  return rows.map((row) => ({ key: row.key, cells: row.cells, label: row.spoken }));
}

/**
 * Whole percents that still add up to the total they are a breakdown of.
 *
 * Rounding each share on its own prints 63 % and 38 % for shares of 0.625 and 0.375 — a hundred
 * points of loss presented as 101. Largest remainder gives every share its floor and hands the
 * leftover percent to whichever share was cut by the most, so the column sums to 100 (or to
 * nothing at all, when nothing was lost).
 */
export function apportionPercents(shares: readonly number[]): string[] {
  const raw = shares.map((share) => share * 100);
  const floors = raw.map(Math.floor);
  const whole = Math.round(raw.reduce((sum, value) => sum + value, 0));
  let left = whole - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = raw
    .map((value, index) => index)
    .sort((a, b) => raw[b]! - floors[b]! - (raw[a]! - floors[a]!));
  const out = [...floors];
  for (const index of byRemainder) {
    if (left <= 0) break;
    out[index] = out[index]! + 1;
    left -= 1;
  }
  return out.map((value) => `${value}%`);
}

/** E1's category breakdown: each category's share of every point lost, costliest first. */
export function shareRows(categories: readonly CategoryRate[]): BarRow[] {
  const printed = apportionPercents(categories.map((c) => c.share));
  return categories.map((c, i) => ({
    key: c.category,
    label: categoryLabel(c.category),
    value: c.share,
    max: 1,
    printed: printed[i]!,
    cells: [categoryLabel(c.category), printed[i]!, formatPoints(c.deduction)],
    spoken: copy.breakdown.spoken(
      categoryLabel(c.category),
      printed[i]!,
      formatPoints(c.deduction)
    ),
  }));
}

export function shareSummary(categories: readonly CategoryRate[], period: InsightsPeriod): string {
  const over = periodPhrase(period);
  const top = categories[0];
  if (top === undefined || top.deduction <= 0) return copy.breakdown.none(over);
  // Through the same apportionment as the bars: the sentence and the row it names must agree.
  const printed = apportionPercents(categories.map((c) => c.share))[0]!;
  return copy.breakdown.summary(categoryLabel(top.category), printed, over);
}

// --- You vs. you ---------------------------------------------------------------------------------

export interface YouVsYouRow {
  key: Delta['key'];
  label: string;
  /** "Up 3" / "2 fewer" / "Same" — the movement as printed. */
  text: string;
  /** Printed under the movement: "84 vs 81" for the score, "a drive" for a category. */
  detail: string;
  direction: Delta['direction'];
  spoken: string;
}

const directionWord = (direction: Delta['direction']) =>
  direction === 'better' ? copy.youVsYou.better : copy.youVsYou.worse;

/** The card's rows: the score first, then every category in the aggregate's order (largest move first). */
export function youVsYouRows(card: YouVsYou): YouVsYouRow[] {
  const score = card.score;
  // The row prints both numbers, so its movement is the difference between them *as printed*:
  // an unrounded delta puts "Up 2.5" beside "84 vs 81". A move that rounds away reads as Same.
  const moved = Math.round(score.current) - Math.round(score.baseline);
  const scoreWay: Delta['direction'] = moved === 0 ? 'same' : moved > 0 ? 'better' : 'worse';
  const scoreText =
    scoreWay === 'same'
      ? copy.youVsYou.same
      : moved > 0
        ? copy.youVsYou.up(String(moved))
        : copy.youVsYou.down(String(-moved));
  const scoreRow: YouVsYouRow = {
    key: 'score',
    label: copy.youVsYou.scoreLabel,
    text: scoreText,
    detail: `${formatScore(score.current)} vs ${formatScore(score.baseline)}`,
    direction: scoreWay,
    spoken:
      scoreWay === 'same'
        ? copy.youVsYou.spokenSame(copy.youVsYou.scoreLabel)
        : copy.youVsYou.spokenScore(formatScore(score.current), scoreText, directionWord(scoreWay)),
  };

  const categories = card.categories.map((d): YouVsYouRow => {
    const label = categoryLabel(d.key as EventCategory);
    const n = formatPoints(Math.abs(d.delta));
    const text =
      d.direction === 'same'
        ? copy.youVsYou.same
        : d.delta < 0
          ? copy.youVsYou.fewer(n)
          : copy.youVsYou.more(n);
    return {
      key: d.key,
      label,
      text,
      detail: d.direction === 'same' ? '' : copy.youVsYou.aDrive,
      direction: d.direction,
      spoken:
        d.direction === 'same'
          ? copy.youVsYou.spokenSame(label)
          : copy.youVsYou.spokenCategory(label, text, directionWord(d.direction)),
    };
  });

  return [scoreRow, ...categories];
}

/** Says what the baseline is. A local one is the driver's own earlier drives — nothing more is claimed. */
export function youVsYouCaption(source: 'stored' | 'local'): string {
  return copy.youVsYou.caption[source];
}

// --- Highlights ----------------------------------------------------------------------------------

export interface Highlight {
  category: EventCategory;
  /** Consecutive scored drives, newest first, in which the category cost nothing. */
  run: number;
  text: string;
}

export const MIN_HIGHLIGHT_RUN = 3;
export const MAX_HIGHLIGHTS = 3;

/**
 * Below this share of a drive with a known limit, "within the limit" would be a claim about roads
 * the app could not see; speeding is not scored where the limit is unknown (§9.3).
 */
export const LIMIT_KNOWN_PCT = 50;

/** A clean category the drive actually measured. */
function measured(trip: TripSummary, category: EventCategory): boolean {
  if (category === 'focus') return trip.cameraSession;
  if (category === 'speeding') return (trip.limitCoveragePct ?? 0) >= LIMIT_KNOWN_PCT;
  return true;
}

/**
 * E1's highlights ("Phone-free for 12 drives"): for each category, the run of scored drives from
 * the newest back in which it cost nothing. A drive that could not measure the category ends the
 * run — an unknown limit is not a kept limit — and an unscored drive is skipped rather than
 * counted or broken on. Runs under three drives are noise, not highlights.
 *
 * Longest run first; the sort is stable, so equal runs keep `CATEGORIES` order — the engine's own
 * order, which is the order the categories are listed in everywhere else.
 */
export function highlightsFor(
  trips: readonly TripSummary[],
  categories: readonly EventCategory[] = CATEGORIES
): Highlight[] {
  const newestFirst = [...trips].sort((a, b) => b.startedAt - a.startedAt);
  const highlights: Highlight[] = [];
  for (const category of categories) {
    let run = 0;
    for (const trip of newestFirst) {
      if (!trip.scored) continue;
      if (!measured(trip, category) || trip.categoryDeductions[category] > 0) break;
      run += 1;
    }
    if (run >= MIN_HIGHLIGHT_RUN) {
      highlights.push({ category, run, text: copy.highlights.run[category](run) });
    }
  }
  return highlights.sort((a, b) => b.run - a.run).slice(0, MAX_HIGHLIGHTS);
}

/**
 * Why a category has nothing to report for a window, or null when it genuinely has something to
 * say — including "it was measured and it cost nothing", which is the celebration.
 *
 * The rule `measured()` applies to a highlight applies here too, and for the same reason: a
 * category the app could not observe has not been kept clean, it has not been looked at. Without
 * this, "Nothing lost to speeding over 4 weeks" prints over a month with no drives in it at all
 * (a celebration of not driving, which §10.1 is at pains to avoid) and over drives whose posted
 * limit was never known (which §9.3 does not score).
 */
export type NotMeasured = 'noDrives' | 'noCamera' | 'noLimit';

/**
 * `scoredTrips` comes from the aggregate — the same source as every figure the screen prints —
 * rather than from `trips.length`, so a *failed* drive-list read cannot announce "no scored
 * drives" over a window the aggregate knows holds them. With a count but no list, the camera and
 * limit arms have nothing to judge by and this says so by saying nothing.
 */
export function notMeasuredReason(
  category: EventCategory,
  seen: { scoredTrips: number; trips: readonly TripSummary[] }
): NotMeasured | null {
  if (seen.scoredTrips === 0) return 'noDrives';
  const scored = seen.trips.filter((trip) => trip.scored);
  if (scored.length === 0) return null;
  if (scored.some((trip) => measured(trip, category))) return null;
  return category === 'focus' ? 'noCamera' : 'noLimit';
}

// --- Conditions ----------------------------------------------------------------------------------

export interface ConditionRow {
  key: keyof ConditionsSplit;
  label: string;
  score: string;
  detail: string;
  spoken: string;
}

function conditionRow(key: keyof ConditionsSplit, label: string, slice: ConditionSlice): ConditionRow {
  if (slice.trips === 0 || slice.score === null) {
    return { key, label, score: copy.score.notYet, detail: copy.conditions.none, spoken: copy.conditions.spokenNone(label) };
  }
  const score = formatScore(slice.score);
  const detail = `${copy.conditions.drives(slice.trips)} · ${formatMiles(slice.distanceM)}`;
  return { key, label, score, detail, spoken: copy.conditions.spoken(label, score, detail) };
}

/** Day / Night / Dry / Wet, informational only (§7.E E1). */
export function conditionRows(split: ConditionsSplit): ConditionRow[] {
  return [
    conditionRow('day', copy.conditions.day, split.day),
    conditionRow('night', copy.conditions.night, split.night),
    conditionRow('dry', copy.conditions.dry, split.dry),
    conditionRow('wet', copy.conditions.wet, split.wet),
  ];
}

// --- Time of day (E2) ----------------------------------------------------------------------------

const ratePer100Mi = (deduction: number, distanceM: number): number | null =>
  distanceM > 0 ? round1((deduction * 100) / (distanceM / METERS_PER_MILE)) : null;

/** The four buckets in reading order, each rated per 100 miles driven inside it. */
export function timeOfDayRows(split: TimeOfDaySplit, category: EventCategory): BarRow[] {
  const rates = TIME_OF_DAY_BUCKETS.map((bucket) => ({
    bucket,
    slice: split[bucket],
    rate: ratePer100Mi(split[bucket].categoryDeductions[category], split[bucket].distanceM),
  }));
  const max = Math.max(1, ...rates.map((r) => r.rate ?? 0));
  return rates.map(({ bucket, slice, rate }) => {
    const label = copy.category.timeOfDay.buckets[bucket];
    return {
      key: bucket,
      label,
      value: rate,
      max,
      printed: formatRate(rate),
      cells: [label, formatRate(rate), String(slice.trips)],
      spoken:
        rate === null
          ? copy.category.timeOfDay.spokenNone(label)
          : copy.category.timeOfDay.spoken(label, formatRate(rate), slice.trips),
    };
  });
}

export function timeOfDaySummary(
  rows: readonly BarRow[],
  category: EventCategory,
  period: InsightsPeriod
): string {
  const over = periodPhrase(period);
  const rated = rows.filter((r) => r.value !== null);
  if (rated.length === 0) return copy.category.timeOfDay.none(over);
  const top = rated.reduce((best, r) => ((r.value ?? 0) > (best.value ?? 0) ? r : best));
  if ((top.value ?? 0) <= 0) return copy.category.timeOfDay.clean(categoryPhrase(category), over);
  return copy.category.timeOfDay.most(top.label, categoryPhrase(category), top.printed);
}

export const TIME_OF_DAY_ORDER: readonly TimeOfDayBucket[] = TIME_OF_DAY_BUCKETS;

// --- Weekly rate (E2) ----------------------------------------------------------------------------

export interface WeekColumn extends BarRow {
  /** "Week of Jan 5" — the row's name in the table and to a screen reader. */
  longLabel: string;
  /** Points lost outright that week, beside the rate. */
  points: string;
}

/** Fifty-two columns is a year; beyond that the bars are thinner than a hairline. */
export const MAX_WEEK_COLUMNS = 52;

/** The category's rate per 100 miles week by week, newest weeks kept when the history is long. */
export function weeklyRateColumns(
  trend: readonly InsightTrendPoint[],
  category: EventCategory
): WeekColumn[] {
  const kept = trend.length > MAX_WEEK_COLUMNS ? trend.slice(-MAX_WEEK_COLUMNS) : trend;
  const rated = kept.map((p) => ({
    point: p,
    rate: p.trips === 0 ? null : ratePer100Mi(p.categoryDeductions[category], p.distanceM),
  }));
  const max = Math.max(1, ...rated.map((r) => r.rate ?? 0));
  return rated.map(({ point, rate }) => {
    const longLabel = weekLongLabel(point.weekStart);
    const points =
      rate === null ? copy.category.trend.noDrives : formatPoints(point.categoryDeductions[category]);
    return {
      key: point.weekStart,
      label: weekLabel(point.weekStart),
      longLabel,
      value: rate,
      max,
      printed: formatRate(rate),
      points,
      cells: [longLabel, formatRate(rate), points],
      spoken:
        rate === null
          ? copy.category.trend.spokenNone(longLabel)
          : copy.category.trend.spoken(longLabel, formatRate(rate)),
    };
  });
}

export function weeklyRateSummary(columns: readonly WeekColumn[], period: InsightsPeriod): string {
  const over = periodPhrase(period);
  const rated = columns.filter((c) => c.value !== null);
  const first = rated[0];
  const last = rated[rated.length - 1];
  if (first === undefined || last === undefined) return copy.category.trend.none(over);
  // "in the week of Jan 19" — only the leading W is lowered; a whole-string lowercase would
  // print the month as "jan".
  if (rated.length === 1) return copy.category.trend.one(first.printed, lowerFirst(first.longLabel));
  return copy.category.trend.from(first.printed, last.printed, over);
}

// --- Category figures (E2) -----------------------------------------------------------------------

export interface CategoryFigures {
  deduction: number;
  /** The points themselves, printed — the field is called "Points lost", so it prints them. */
  total: string;
  per100Mi: string;
  perHour: string;
  drives: string;
  /** Nothing lost to this category in the window — the celebration state (§7.E E2). */
  clean: boolean;
}

export function categoryFigures(
  categories: readonly CategoryRate[],
  category: EventCategory,
  scoredTrips: number
): CategoryFigures {
  const rate = categories.find((c) => c.category === category);
  return {
    deduction: rate?.deduction ?? 0,
    total: formatPoints(rate?.deduction ?? 0),
    per100Mi: formatRate(rate?.per100Mi ?? null),
    perHour: formatRate(rate?.perHour ?? null),
    drives: copy.category.rates.drivesValue(rate?.trips ?? 0, scoredTrips),
    clean: (rate?.deduction ?? 0) <= 0,
  };
}

/** The category's two tips for the driver's stage (§7.E E2): the everyday one, then the top-band one. */
export function tipsFor(category: EventCategory, stage: TipStage): Tip[] {
  return tips
    .filter((tip) => tip.category === category && tip.stages.includes(stage))
    .sort((a, b) => a.minSeverity - b.minSeverity)
    .slice(0, 2);
}

// --- Totals (E3) ---------------------------------------------------------------------------------

/**
 * The drives that fall inside an insight window.
 *
 * A drive belongs to the window its *end* lands in, which is how `buildInsights` chose the trips
 * behind every rate on the screen. It matters at the edge: over `all`, the window opens at the
 * earliest scored drive's end, so filtering on the start would drop the very first drive from the
 * record it opened.
 */
export function inWindow(
  trips: readonly TripSummary[],
  window: { from: number; to: number }
): TripSummary[] {
  return trips.filter(
    (trip) => (trip.endedAt ?? trip.startedAt) >= window.from && trip.startedAt <= window.to
  );
}


export interface Totals {
  drives: number;
  scoredDrives: number;
  milesM: number;
  seconds: number;
  safeDays: number;
  longestSafeStreak: number;
  bestWeek: { weekStart: string; score: number } | null;
  phoneFreeMilesM: number;
  nightMilesM: number;
}

/**
 * The longest run of *driving days* that were safe days (§10.3): a day without a cached entry is
 * a day without driving and neither adds nor breaks; a driving day that was not safe resets.
 */
export function longestSafeStreak(days: readonly DayEntry[]): number {
  let run = 0;
  let best = 0;
  for (const day of [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    run = day.safeDay ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** The highest scored week; on a tie the later one, so the record points at the freshest proof. */
export function bestWeek(trend: readonly InsightTrendPoint[]): Totals['bestWeek'] {
  let best: Totals['bestWeek'] = null;
  for (const p of trend) {
    if (p.score === null) continue;
    if (best === null || p.score >= best.score) best = { weekStart: p.weekStart, score: p.score };
  }
  return best;
}

/**
 * E3's totals over `[from, to]`, from the trips where the driver was the driver. Unscored drives
 * still count as drives and miles; phone-free miles are claimed only for scored drives, since an
 * unscored one detected nothing. Descriptive only (§10.1): no threshold here earns anything.
 */
export function totalsFor(input: {
  trips: readonly TripSummary[];
  days: readonly DayEntry[];
  trend: readonly InsightTrendPoint[];
  from: number;
  to: number;
}): Totals {
  const window = inWindow(
    input.trips.filter((t) => t.role === 'driver'),
    input
  );
  const scored = window.filter((t) => t.scored);
  const sum = (trips: readonly TripSummary[], pick: (t: TripSummary) => number) =>
    trips.reduce((total, t) => total + pick(t), 0);
  return {
    drives: window.length,
    scoredDrives: scored.length,
    milesM: sum(window, (t) => t.distanceM),
    seconds: sum(window, (t) => t.durationS),
    safeDays: input.days.filter((d) => d.safeDay).length,
    longestSafeStreak: longestSafeStreak(input.days),
    bestWeek: bestWeek(input.trend),
    phoneFreeMilesM: sum(
      scored.filter((t) => t.categoryDeductions.phone <= 0),
      (t) => t.distanceM
    ),
    nightMilesM: sum(
      window.filter((t) => t.conditions.night),
      (t) => t.distanceM
    ),
  };
}

/** "12 h 05 min", or "42 min" under an hour — the shared formatter, restated for the record. */
export function formatHours(seconds: number): string {
  return formatDuration(seconds);
}

/** The period's window as `useTrips` wants it, and as `YYYY-MM-DD` for `useScoreDaily`. */
export function windowOf(insights: Pick<Insights, 'from' | 'to'>): {
  from: number;
  to: number;
  days: DayRange;
} {
  return {
    from: insights.from,
    to: insights.to,
    // The record's own calendar: a day belongs to the zone the phone is in now, which is the
    // zone `score_daily_cache` was keyed by when the day was evaluated.
    days: { from: dayKey(new Date(insights.from)), to: dayKey(new Date(insights.to)) },
  };
}

// --- Example drives (E2) -------------------------------------------------------------------------

export interface ExampleTrip {
  clientTripId: string;
  /** "Near Home → Near Lincoln HS", or the date when the drive has no labels. */
  title: string;
  /** "6 points to speeding" — what this drive cost in the category being read. */
  cost: string;
  /** "Score 84 · Mon, Jan 5". */
  detail: string;
  spoken: string;
}

export const MAX_EXAMPLES = 3;

const EXAMPLE_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * The drives §7.E E2 offers as examples: the ones this category actually cost the most, costliest
 * first, newest first on a tie. A drive the category cost nothing is not an example of it.
 */
export function exampleTripsFor(
  trips: readonly TripSummary[],
  category: EventCategory
): ExampleTrip[] {
  return trips
    .filter((trip) => trip.scored && trip.categoryDeductions[category] > 0)
    .sort(
      (a, b) =>
        b.categoryDeductions[category] - a.categoryDeductions[category] || b.startedAt - a.startedAt
    )
    .slice(0, MAX_EXAMPLES)
    .map((trip) => {
      const day = EXAMPLE_DAY.format(new Date(trip.startedAt));
      const route =
        trip.startLabel && trip.endLabel ? `${trip.startLabel} → ${trip.endLabel}` : day;
      const points = formatPoints(trip.categoryDeductions[category]);
      const cost = copy.category.examples.cost(points, categoryPhrase(category));
      const detail =
        trip.score === null
          ? day
          : `${copy.category.examples.score(formatScore(trip.score))} · ${day}`;
      return {
        clientTripId: trip.clientTripId,
        title: route,
        cost,
        detail,
        spoken: `${route}, ${cost}, ${detail}`,
      };
    });
}

// --- Caps (E4) -----------------------------------------------------------------------------------

/**
 * E4's caps chart: one box per category as long as the most that category can take from a single
 * drive. Nothing is filled in — the chart is about the ceiling, not about this driver.
 */
export function capRows(): BarRow[] {
  const max = Math.max(1, ...categoryCaps.map((entry) => entry.cap));
  return categoryCaps.map((entry) => ({
    key: entry.category,
    label: entry.label,
    value: entry.cap,
    max,
    printed: String(entry.cap),
    cells: [entry.label, String(entry.cap)],
    spoken: copy.how.capsSpoken(entry.label, entry.cap),
  }));
}
