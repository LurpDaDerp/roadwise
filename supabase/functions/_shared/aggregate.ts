// The per-user aggregates the writers store beside a trip: day rows (§9.9, `score_daily`) and the
// 8-week baselines (§9.6, `baselines`). Pure functions over plain rows, so finalize-trip can fold
// the trip it is about to write into the stored ones, and trip-actions can re-run the same
// arithmetic after a dispute, a role change or a delete.
//
// The writers cast the integer columns with `::int` from JSON text, which refuses a decimal point,
// so every integer-bound field is rounded here, at the boundary, and nowhere else.
import { CATEGORY, CONSTANTS, evaluateDay } from './scoring/index';
import type { DayTrip, LongTermScore, ScoreBand, TripForLongTerm } from './scoring/index';

const DAY_MS = 86_400_000;
/** The baseline window: "rolling 8-week median per category" (§9.6). */
export const BASELINE_WINDOW_D = 56;

/**
 * One `score_daily` row as `apply_trip` / `apply_recompute` take it (camelCase, all keys present).
 * `longTermScore`, `drivingS`, `tripsScored` and `severeEvents` are integers (`int` columns);
 * `severeEvents` counts the day's scored trips that had a severe event, not events.
 */
export interface DayRow {
  day: string;
  longTermScore: number | null;
  band: ScoreBand | null;
  provisional: boolean;
  safeDay: boolean;
  goodDay: boolean;
  phoneFreeDay: boolean;
  cameraDay: boolean;
  exposure: number;
  drivingS: number;
  tripsScored: number;
  severeEvents: number;
}

/** A trip as the day evaluation needs it, tagged with the local day it belongs to. */
export interface DayTripInput {
  localDay: string;
  score: number | null;
  status: 'provisional' | 'final' | 'unscored' | 'discarded';
  durationS: number;
  exposure: number;
  hadSevereEvent: boolean;
  /** Scored phone events (`category = 'phone' and status = 'scored'`). */
  phoneEvents: number;
  /** `camera_session` for M2: there is no stored signal of camera quality beyond it. */
  cameraGood: boolean;
}

/**
 * A scored trip as the long-term score and the baselines need it: `status` final or provisional
 * with a score (nothing sets `provisional` in M2, so in practice final).
 */
export interface ScoredTripInput extends TripForLongTerm {
  categoryDeductions: Record<string, number>;
}

export interface Baselines {
  medians: Record<string, number>;
  computedAt: string;
}

const parts = (ms: number, tz: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).formatToParts(new Date(ms));

/**
 * The calendar date of `ms` in `tz` as `YYYY-MM-DD`: what `trips_local_day` derives with
 * `(started_at at time zone tz)::date`, and what `apply_trip` requires among the day rows.
 */
export function localDay(ms: number, tz: string): string {
  const p = parts(ms, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const get = (type: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The night condition (§9.4): 23:00 through 04:59 on the clock in `tz`. */
export function isNightAt(ms: number, tz: string): boolean {
  const hour = Number(parts(ms, tz, { hour: 'numeric', hourCycle: 'h23' }).find((x) => x.type === 'hour')?.value);
  return hour >= CONSTANTS.NIGHT_START_H || hour < CONSTANTS.NIGHT_END_H;
}

const toDayTrip = (t: DayTripInput): DayTrip => ({
  score: t.score,
  // only final trips count for a day (§9.9); a provisional one is not yet a result
  status: t.status === 'provisional' ? 'unscored' : t.status,
  durationS: t.durationS,
  hadSevereEvent: t.hadSevereEvent,
  phoneEvents: t.phoneEvents,
  cameraGood: t.cameraGood,
});

/** Six decimals: enough for any exposure sum, and no 3.3000000000000003 in a stored row. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const WITHHELD: LongTermScore = { score: null, band: null, provisional: true, tripsUsed: 0 };

/** The row for a day with nothing on it: all zeros, the long-term score withheld. */
export const emptyDayRow = (day: string): DayRow => dayRows([day], [], WITHHELD)[0];

/**
 * One row per requested day over the trips that fall on it, every row carrying the same
 * long-term score: a late-synced trip writes its own day with the score as of now, and the
 * caller adds today's day when the score should move today too (`apply_trip` accepts an array).
 */
export function dayRows(
  days: readonly string[],
  trips: readonly DayTripInput[],
  lt: LongTermScore
): DayRow[] {
  return days.map((day) => {
    const own = trips.filter((t) => t.localDay === day);
    const result = evaluateDay({ trips: own.map(toDayTrip) });
    const scored = own.filter((t) => t.status === 'final' && t.score !== null);
    return {
      day,
      longTermScore: lt.score === null ? null : Math.round(lt.score),
      band: lt.band,
      provisional: lt.provisional,
      safeDay: result.safeDay,
      goodDay: result.goodDay,
      phoneFreeDay: result.phoneFreeDay,
      cameraDay: result.cameraDay,
      exposure: round6(scored.reduce((sum, t) => sum + t.exposure, 0)),
      drivingS: Math.round(result.drivingS),
      tripsScored: scored.length,
      severeEvents: scored.filter((t) => t.hadSevereEvent).length,
    };
  });
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The "you vs. you" baseline (§9.6): per category, the median of the points that category cost
 * per trip over the last eight weeks, plus the median trip score, over the scored trips the
 * caller passes (final, plus provisional if any ever exist); null when nothing was scored in the
 * window, so the writer leaves the stored row alone.
 */
export function baselines(trips: readonly ScoredTripInput[], nowMs: number): Baselines | null {
  const recent = trips.filter((t) => nowMs - t.endedAt <= BASELINE_WINDOW_D * DAY_MS);
  if (recent.length === 0) return null;
  const medians: Record<string, number> = {};
  for (const category of Object.keys(CATEGORY)) {
    medians[category] = median(recent.map((t) => t.categoryDeductions[category] ?? 0));
  }
  medians.score = median(recent.map((t) => t.score));
  return { medians, computedAt: new Date(nowMs).toISOString() };
}
