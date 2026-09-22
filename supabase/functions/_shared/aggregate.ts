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
/**
 * The current period a baseline is read against (§7.E E1, "current 4 weeks"): the window ends
 * where this one begins, so the two never overlap.
 */
export const BASELINE_CURRENT_D = 28;
/**
 * The baseline window: the "rolling 8-week median per category" of §9.6, taken over the eight
 * weeks *preceding* the current four — `[now − 84 d, now − 28 d)`, the lower edge included and the
 * upper excluded. This is the device's own definition (`src/data/queries/insights.ts`
 * `YOU_VS_YOU_CURRENT_D` / `BASELINE_WINDOW_D`), so a card drawn from the stored row means exactly
 * what the same card drawn locally means; the last 56 days would overlap the current four and
 * shrink every delta.
 */
export const BASELINE_WINDOW_D = 56;

/**
 * One `score_daily` row as `apply_trip` / `apply_recompute` take it (camelCase, all keys present).
 * `longTermScore`, `drivingS`, `tripsScored` and `severeEvents` are integers (`int` columns);
 * `severeEvents` counts the day's scored trips that had a severe event, not events.
 */
/**
 * The trip fields a re-score rewrites, returned to the device so its row can follow.
 *
 * `apply_trip` and `apply_recompute` both store a fresh `category_deductions`, `exposure`,
 * `data_quality` and `had_severe_event`; without these on the wire the device keeps whatever its
 * own finalizer computed, for ever. That is what makes D2's bars contradict the score above them
 * after an accepted dispute, and what leaves a crash-recovered drive showing an A the server
 * graded B.
 */
export interface TripFields {
  categoryDeductions: Record<string, number>;
  exposure: number;
  dataQuality: string;
  hadSevereEvent: boolean;
  limitCoveragePct: number | null;
}

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
  /**
   * Soft-deleted by the user (D2). A deleted drive keeps counting against its day: the day is
   * judged with and without it and keeps the lower result, so deleting never raises a day. It
   * adds nothing to the day's counts (driving time, exposure, trips, severe events).
   */
  deleted: boolean;
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
 *
 * D2: a day is judged twice, over all its trips and over the ones not deleted, and each flag keeps
 * the lower of the two, so deleting a drive can never make a day safe, good, phone-free or a
 * camera day that it was not with the drive. A day that was safe with the drive and good without
 * it is good; one that was good with it and safe without it is good too. The counts (driving
 * time, exposure, trips scored, severe events) are the kept drives' alone, as before: a deleted
 * drive is gone from what the day shows, never from how it is judged.
 */
export function dayRows(
  days: readonly string[],
  trips: readonly DayTripInput[],
  lt: LongTermScore
): DayRow[] {
  return days.map((day) => {
    const own = trips.filter((t) => t.localDay === day);
    const live = own.filter((t) => !t.deleted);
    const all = evaluateDay({ trips: own.map(toDayTrip) });
    const kept = evaluateDay({ trips: live.map(toDayTrip) });
    const safeDay = all.safeDay && kept.safeDay;
    const goodDay = !safeDay && (all.safeDay || all.goodDay) && (kept.safeDay || kept.goodDay);
    const scored = live.filter((t) => t.status === 'final' && t.score !== null);
    return {
      day,
      longTermScore: lt.score === null ? null : Math.round(lt.score),
      band: lt.band,
      provisional: lt.provisional,
      safeDay,
      goodDay,
      phoneFreeDay: all.phoneFreeDay && kept.phoneFreeDay,
      cameraDay: all.cameraDay && kept.cameraDay,
      exposure: round6(scored.reduce((sum, t) => sum + t.exposure, 0)),
      drivingS: Math.round(kept.drivingS),
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
 * The "you vs. you" baseline (§9.6): per category, the median of the points that category cost per
 * trip over the eight weeks before the current four, plus the median trip score, over the scored
 * trips the caller passes (final, plus provisional if any ever exist).
 *
 * A window with nothing in it yields `{ medians: {} }`, not the previous medians and not null: a
 * baseline that no longer describes the driver must not keep standing because there is nothing to
 * replace it with. The device's reader keeps only the six categories and `score`, so an empty set
 * of keys reads as "no stored baseline" and the card falls back to the local one.
 */
export function baselines(trips: readonly ScoredTripInput[], nowMs: number): Baselines {
  const to = nowMs - BASELINE_CURRENT_D * DAY_MS;
  const from = to - BASELINE_WINDOW_D * DAY_MS;
  const inWindow = trips.filter((t) => t.endedAt >= from && t.endedAt < to);
  const medians: Record<string, number> = {};
  if (inWindow.length > 0) {
    for (const category of Object.keys(CATEGORY)) {
      medians[category] = median(inWindow.map((t) => t.categoryDeductions[category] ?? 0));
    }
    medians.score = median(inWindow.map((t) => t.score));
  }
  return { medians, computedAt: new Date(nowMs).toISOString() };
}
