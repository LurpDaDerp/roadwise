/**
 * The coaching model behind the Analytics tab and Home's tip card (plan D6). Pure and
 * deterministic: every function takes the instant it measures from (`now`, `at`) or a cutoff, never
 * the clock, so each rule is testable on its own.
 *
 * The radar's six categories and the Safety Rating at its centre come from the scoring package's
 * `ratingAt`: over the last 90 days, recent weeks counting more, each category judges the driver per
 * chance to slip (hard brakes per slowdown, hard starts per speed-up, sharp turns per turn, time over
 * the limit per second with a known limit, phone pickups and their time in hand per second at
 * driving speed, Attention per mile DashPal watched), smoothed toward a typical driver's, and the
 * rating is their weighted average with Speed and Phone use counting double. Phone use has no score
 * until a drive in the window was watched for it. The categories are shown as whole numbers, the
 * rating to 1 decimal. Time of day is not scored at all
 * (a card under When you drive comments on it instead). Local data includes drives still uploading,
 * so the numbers here can lead the server's by a drive until it answers.
 */
import {
  AXES as SCORING_AXES,
  DASHPAL_AXIS as SCORING_DASHPAL_AXIS,
  RATING_WINDOW_DAYS,
  ratingAt,
  speedingChargedS,
  type AxisKey,
  type DriveEvent,
  type RatingDrive,
  type SafetyRating,
} from '@scoring';

import { isScoredDrive, type LocalDrive } from '@/data/queries/rows';
import type { Region } from '@/features/settings/maps';
import { decodeRuns } from '@/lib/polyline';

// ---------------------------------------------------------------------------------------------
// Axes and sub-scores

export type { AxisKey };

const LABELS: Record<AxisKey, string> = {
  acceleration: 'Acceleration',
  braking: 'Braking',
  turning: 'Turning',
  attention: 'Attention',
  phone: 'Phone use',
  speed: 'Speed',
};

/** Radar order, clockwise from the top (the scoring package's): Acceleration, Braking, Turning, Attention, Phone use, Speed. */
export const AXES: readonly { key: AxisKey; label: string }[] = SCORING_AXES.map((key) => ({ key, label: LABELS[key] }));

export const AXIS_LABEL: Record<AxisKey, string> = LABELS;

/** The axes the Safety Rating averages (all of them), in radar order. */
export const PENALTY_AXES: readonly AxisKey[] = AXES.map((a) => a.key);

/** The axis that needs a paired DashPal: locked on the radar without one. */
export const DASHPAL_AXIS: AxisKey = SCORING_DASHPAL_AXIS;

/** Phone use: no score (and no point on the radar) until a drive in the window was watched for pickups. */
export const PHONE_AXIS: AxisKey = 'phone';

/**
 * 0–100 per axis, whole numbers; null when the window has no miles (Attention: no watched miles;
 * Phone use: no drive watched for it).
 */
export type AxisScores = Record<AxisKey, number | null>;

/** What a window holds: the scored drives' totals. */
export interface WindowTotals {
  drives: number;
  cleanDrives: number;
  miles: number;
  /** Miles DashPal watched (Attention divides by them). */
  watchedMiles: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const byStart = (a: Pick<LocalDrive, 'startedAt' | 'clientTripId'>, b: Pick<LocalDrive, 'startedAt' | 'clientTripId'>): number =>
  a.startedAt - b.startedAt || (a.clientTripId < b.clientTripId ? -1 : a.clientTripId > b.clientTripId ? 1 : 0);

/**
 * Each drive's own events: an event belongs to the latest drive started at or before it (drives
 * never overlap). `drives` in any order; events before the first drive belong to none.
 */
export function eventsByDrive(drives: readonly LocalDrive[], events: readonly DriveEvent[]): Map<string, DriveEvent[]> {
  const sorted = [...drives].sort(byStart);
  const out = new Map<string, DriveEvent[]>(sorted.map((d) => [d.clientTripId, []]));
  if (sorted.length === 0) return out;
  const evs = [...events].sort((a, b) => a.startedAt - b.startedAt);
  let j = -1;
  for (const e of evs) {
    while (j + 1 < sorted.length && sorted[j + 1]!.startedAt <= e.startedAt) j += 1;
    if (j >= 0) out.get(sorted[j]!.clientTripId)!.push(e);
  }
  return out;
}

/**
 * A drive's miles as the server stores them (`trips.miles numeric(7,2)`): the 3-decimal miles the
 * phone sent, rounded half away from zero to 2 decimals on the decimal itself (not its binary
 * float: 4.995 is 5.00, as Postgres reads "4.995"). Not finite or negative: 0, as the server's
 * window reads it.
 */
export function storedMiles(miles: number): number {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  const thousandths = Math.round(miles * 1000);
  return Math.floor((thousandths + 5) / 10) / 100;
}

/**
 * The drives as the rating reads them: each with its miles, watched miles, chances (exposure) and
 * its own events. Miles as the server stores them (`storedMiles`, watched miles in proportion), so
 * the phone's window sums the same miles and is ranked at 10 mi exactly when the server's is.
 */
export function toRatingDrives(drives: readonly LocalDrive[], events: readonly DriveEvent[]): RatingDrive[] {
  const own = eventsByDrive(drives, events);
  return drives.map((d) => {
    const miles = storedMiles(d.miles);
    return {
      id: d.clientTripId,
      startedAt: d.startedAt,
      miles,
      watchedMiles: d.miles > 0 && Number.isFinite(d.watchedMiles) ? (d.watchedMiles * miles) / d.miles : 0,
      exposure: d.exposure,
      events: own.get(d.clientTripId) ?? [],
    };
  });
}

const whole = (v: number | null): number | null => (v === null ? null : Math.round(v));

/** Each category's score over the 90 days ending at `at`, as whole numbers (all null with no miles). */
export function radarScores(drives: readonly LocalDrive[], events: readonly DriveEvent[], at: number): AxisScores {
  return wholeScores(ratingAt(toRatingDrives(drives, events), at).scores);
}

function wholeScores(s: Record<AxisKey, number | null>): AxisScores {
  return {
    acceleration: whole(s.acceleration),
    braking: whole(s.braking),
    turning: whole(s.turning),
    attention: whole(s.attention),
    phone: whole(s.phone),
    speed: whole(s.speed),
  };
}

/** The Safety Rating as of `at` (`ratingAt`: 1 decimal, ranked from 10 mi in its 90 days). The same arithmetic as the server's. */
export function windowRating(drives: readonly LocalDrive[], events: readonly DriveEvent[], at: number): SafetyRating {
  const r = ratingAt(toRatingDrives(drives, events), at);
  return { rating: r.rating, ranked: r.ranked };
}

// ---------------------------------------------------------------------------------------------
// Levels and coaching

export type Level = 'good' | 'fair' | 'poor';

export const GOOD_MIN = 80;
export const FAIR_MIN = 60;

export function levelFor(score: number): Level {
  if (score >= GOOD_MIN) return 'good';
  if (score >= FAIR_MIN) return 'fair';
  return 'poor';
}

/** Ionicons per level. Always drawn with the word (`LEVEL_LABEL`) as a11y text: colour never alone. */
export const LEVEL_ICON = {
  good: 'checkmark-circle',
  fair: 'warning',
  poor: 'alert-circle',
} as const satisfies Record<Level, string>;

/** The theme colour per level (`useTheme().colors[LEVEL_TONE[level]]`). */
export const LEVEL_TONE = {
  good: 'success',
  fair: 'warning',
  poor: 'danger',
} as const satisfies Record<Level, string>;

export const LEVEL_LABEL: Record<Level, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };

/** Enough data for advice: at least this many scored drives and miles in the window. */
export const COACH_MIN_DRIVES = 3;
export const COACH_MIN_MILES = 10;

/** One line per axis, each at most 60 characters. */
export const AXIS_TIP: Record<AxisKey, string> = {
  speed: 'Ease off a little over the limit.',
  braking: 'Leave more room so you can brake gently.',
  acceleration: 'Roll onto the gas smoothly.',
  turning: 'Slow down before the turn, not in it.',
  attention: 'Eyes on the road, and pull over when tired.',
  phone: 'Put your phone away before you pull out.',
};

export const AXIS_TITLE: Record<AxisKey, string> = {
  speed: 'Watch your speed',
  braking: 'Brake more gently',
  acceleration: 'Ease into the gas',
  turning: 'Take turns slower',
  attention: 'Stay focused',
  phone: 'Phone down while driving',
};

export const GOOD_TITLE = 'Driving well';
export const GOOD_TIP = 'Smooth driving lately. Keep it up.';
export const NO_DATA_TITLE = 'Tips are on the way';
export const NO_DATA_TIP = 'Drive a few more times to get tips here.';

export interface Coaching {
  /** null: not enough driving in the window to judge. */
  level: Level | null;
  /** The axis the advice is about; null when there is none (good or no data). */
  axis: AxisKey | null;
  title: string;
  tip: string;
  /**
   * The other axes that are fair or poor, weakest first (ties in radar order), at most
   * `COACH_ALSO_MAX`. Empty when the result is good or there is no advice.
   */
  also: { axis: AxisKey; level: Level }[];
}

export const COACH_ALSO_MAX = 2;

/**
 * The advice for a window. The weakest scored axis decides (ties go to the earlier axis in radar
 * order); Attention takes part only with DashPal miles. A good result is a compliment. Fewer than
 * 3 drives or 10 miles: no advice.
 */
export function coach(scores: AxisScores, window: { drives: number; miles: number }): Coaching {
  if (window.drives < COACH_MIN_DRIVES || window.miles < COACH_MIN_MILES) {
    return { level: null, axis: null, title: NO_DATA_TITLE, tip: NO_DATA_TIP, also: [] };
  }
  let axis: AxisKey | null = null;
  let score: number | null = null;
  for (const key of PENALTY_AXES) {
    const s = scores[key];
    if (s !== null && (score === null || s < score)) {
      axis = key;
      score = s;
    }
  }
  if (axis === null || score === null) return { level: null, axis: null, title: NO_DATA_TITLE, tip: NO_DATA_TIP, also: [] };
  const level = levelFor(score);
  if (level === 'good') return { level, axis: null, title: GOOD_TITLE, tip: GOOD_TIP, also: [] };
  const also = PENALTY_AXES.flatMap((key) => {
    const s = scores[key];
    return key !== axis && s !== null && levelFor(s) !== 'good' ? [{ axis: key, score: s }] : [];
  })
    .sort((a, b) => a.score - b.score)
    .slice(0, COACH_ALSO_MAX)
    .map((a) => ({ axis: a.axis, level: levelFor(a.score) }));
  return { level, axis, title: AXIS_TITLE[axis], tip: AXIS_TIP[axis], also };
}

/** A category's own verdict says this when it is good. */
export const AXIS_GOOD_TIP = 'Keep it up.';

/**
 * One axis's verdict, for its detail sheet: its own level with its title and tip when fair or
 * poor, a short compliment when good, and the wait line under 3 drives or 10 miles (or no score).
 */
export function axisCoaching(axis: AxisKey, score: number | null, window: { drives: number; miles: number }): Omit<Coaching, 'axis' | 'also'> {
  if (score === null || window.drives < COACH_MIN_DRIVES || window.miles < COACH_MIN_MILES) {
    return { level: null, title: NO_DATA_TITLE, tip: NO_DATA_TIP };
  }
  const level = levelFor(score);
  if (level === 'good') return { level, title: GOOD_TITLE, tip: AXIS_GOOD_TIP };
  return { level, title: AXIS_TITLE[axis], tip: AXIS_TIP[axis] };
}

/** Home shows the tip card only when there is something to work on. */
export const showsTip = (c: Coaching): boolean => c.level === 'fair' || c.level === 'poor';

export interface CoachWindow {
  scores: AxisScores;
  /** The window's Safety Rating (the radar's centre): the weighted average of its categories, ranked from 10 mi. */
  rating: SafetyRating;
  totals: WindowTotals;
  coaching: Coaching;
}

/**
 * Sub-scores, the Safety Rating (as of `at`) and advice for the scored drives started at or after
 * `sinceMs` (the 90 days). `events` are the active events of the same window's scored drives
 * (`readWindowEvents(db, sinceMs)`). One `ratingAt` call gives both the scores and the rating.
 */
export function coachWindow(drives: readonly LocalDrive[], events: readonly DriveEvent[], sinceMs: number, at: number): CoachWindow {
  const totals: WindowTotals = { drives: 0, cleanDrives: 0, miles: 0, watchedMiles: 0 };
  const list = scoredSince(drives, sinceMs);
  for (const d of list) {
    totals.drives += 1;
    totals.miles += d.miles;
    totals.watchedMiles += d.watchedMiles;
    if (d.clean === true) totals.cleanDrives += 1;
  }
  const r = ratingAt(toRatingDrives(list, events), at);
  const scores = wholeScores(r.scores);
  return { scores, rating: { rating: r.rating, ranked: r.ranked }, totals, coaching: coach(scores, totals) };
}

// ---------------------------------------------------------------------------------------------
// Windows

export type Range = 'day' | 'week' | 'month' | 'year';
export const RANGES: readonly Range[] = ['day', 'week', 'month', 'year'];
export const RANGE_LABEL: Record<Range, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
export const RANGE_DAYS: Record<Range, number> = { day: 1, week: 7, month: 30, year: 365 };
/** The radar, summary and Home tip window: the Safety Rating's 90 days. */
export const COACH_DAYS = RATING_WINDOW_DAYS;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The cutoff `days` before `now`, with `now` floored to the hour so a query key stays the same for
 * an hour (the same arithmetic as `sinceDays` in the drive screens).
 */
export function windowStart(now: number, days: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS - days * DAY_MS;
}

export const rangeStart = (now: number, range: Range): number => windowStart(now, RANGE_DAYS[range]);

/** The scored drives started at or after `sinceMs` (null: all time), newest first as given. */
export function scoredSince(drives: readonly LocalDrive[], sinceMs: number | null): LocalDrive[] {
  return drives.filter((d) => isScoredDrive(d) && (sinceMs === null || d.startedAt >= sinceMs));
}

export interface WindowSums {
  drives: number;
  miles: number;
  durationS: number;
  /** Miles driven with the sun down. */
  nightMiles: number;
  /** Whole percent of the miles driven after dark; null with no miles. */
  nightPct: number | null;
  /** Distance / hours; null with no drive time. */
  avgMph: number | null;
  speeding: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
  /** The drives' chances to slip: slowdowns and speed-ups of 12 mph or more, real turns. */
  slowdowns: number;
  speedups: number;
  turns: number;
  /** Seconds driven at 10 mph or more under a known limit. */
  limitS: number;
  /** Seconds over the line of every speeding episode (Σ `speedingChargedS` of the active speeding events). */
  speedingS: number;
  /** Active phone pickups. */
  pickups: number;
  /** Their seconds in hand while moving (Σ the pickups' `durationS`, from the events). */
  inHandS: number;
  /** Seconds at driving speed the phone was watched for pickups (Phone use's chances); 0 before it was tracked. */
  phoneS: number;
  /** A drive in the window was recorded before the counters existed: its chances are estimated. */
  exposureEstimated: boolean;
  /** DashPal's events (Attention's sheet only; never in the phone's stats). */
  eyesOff: number;
  drowsy: number;
  /** Miles DashPal watched. */
  watchedMiles: number;
  cleanDrives: number;
  /** Whole percent of drives that were clean; null with no drives. */
  cleanPct: number | null;
  /** Distance per drive; null with no drives. */
  avgMiles: number | null;
}

export const EMPTY_WINDOW: WindowSums = Object.freeze({
  drives: 0,
  miles: 0,
  durationS: 0,
  nightMiles: 0,
  nightPct: null,
  avgMph: null,
  speeding: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
  slowdowns: 0,
  speedups: 0,
  turns: 0,
  limitS: 0,
  speedingS: 0,
  pickups: 0,
  inHandS: 0,
  phoneS: 0,
  exposureEstimated: false,
  eyesOff: 0,
  drowsy: 0,
  watchedMiles: 0,
  cleanDrives: 0,
  cleanPct: null,
  avgMiles: null,
});

/**
 * The metric sums over scored drives started at or after `sinceMs`, with their chances to slip
 * (each drive's exposure), and the seconds over the limit and in hand (from `events`, the active
 * events of the scored drives: each belongs to the latest drive started at or before it). DashPal
 * eyes-off and drowsy are counted apart, for Attention's sheet only; every other stat leaves them out.
 */
export function windowSums(drives: readonly LocalDrive[], sinceMs: number | null, events: readonly DriveEvent[] = []): WindowSums {
  const out = { ...EMPTY_WINDOW };
  const scored = scoredSince(drives, null);
  const own = events.length > 0 ? eventsByDrive(scored, events) : null;
  for (const d of scoredSince(drives, sinceMs)) {
    out.drives += 1;
    out.miles += d.miles;
    out.durationS += d.durationS;
    out.nightMiles += d.nightMiles;
    out.speeding += d.counts.speeding;
    out.hardBrake += d.counts.hardBrake;
    out.hardAccel += d.counts.hardAccel;
    out.hardCorner += d.counts.hardCorner;
    out.slowdowns += d.exposure.slowdowns;
    out.speedups += d.exposure.speedups;
    out.turns += d.exposure.turns;
    out.limitS += d.exposure.limitS;
    out.phoneS += d.exposure.phoneS;
    out.pickups += d.counts.pickups;
    if (d.exposureEstimated) out.exposureEstimated = true;
    out.eyesOff += d.counts.eyesOff;
    out.drowsy += d.counts.drowsy;
    out.watchedMiles += d.watchedMiles;
    if (d.clean === true) out.cleanDrives += 1;
    for (const e of own?.get(d.clientTripId) ?? []) {
      if (e.status === 'removed') continue;
      if (e.type === 'speeding') out.speedingS += speedingChargedS(e.durationS);
      else if (e.type === 'phone_pickup' && Number.isFinite(e.durationS)) out.inHandS += Math.max(0, e.durationS);
    }
  }
  out.avgMph = out.durationS > 0 ? out.miles / (out.durationS / 3600) : null;
  out.nightPct = out.miles > 0 ? Math.round((Math.min(out.nightMiles, out.miles) / out.miles) * 100) : null;
  out.cleanPct = out.drives > 0 ? Math.round((out.cleanDrives / out.drives) * 100) : null;
  out.avgMiles = out.drives > 0 ? out.miles / out.drives : null;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Trend

export type TrendKind = 'score' | 'events';
export const TREND_KINDS: readonly TrendKind[] = ['score', 'events'];

/**
 * What one point of the trend stands for, per range: each drive of the day, each day of the
 * week, each week (Monday first) of the month and each month of the year. A month reads as weeks:
 * one day's score swings on a single short drive, and 30 daily dots are noise, not a trend.
 */
export type TrendStep = 'drive' | 'day' | 'week' | 'month';
export const TREND_STEP: Record<Range, TrendStep> = { day: 'drive', week: 'day', month: 'week', year: 'month' };

export interface TrendPoint {
  /** Across the chart: 0 is the range's first slot (or its start, by drive), 1 the latest (now). */
  x: number;
  /** Score: the Safety Rating, whole. Events: events per mile. */
  value: number;
  /** When, for a screen reader: "at 8:15 AM", "now", "on Tuesday", "today", "in the week of Sep 22", "in March". */
  when: string;
}

export interface TrendTick {
  x: number;
  label: string;
}

export interface Trend {
  step: TrendStep;
  /** Every slot's tick (by day, week or month), or the 6-hour marks of a day; the chart thins them to fit. */
  ticks: TrendTick[];
  /**
   * Per series, oldest first (see `trend`): Score per slot whose 90 days hold 10 mi or more (by
   * drive, also one now), Events per slot with miles. Score stays empty until the events are in.
   */
  series: Record<TrendKind, TrendPoint[]>;
}

/**
 * How far back the trend's events reach, whatever the range: a year and the 90 days its first
 * Score point looks back over. One read serves every range, so switching it never waits.
 */
export const TREND_EVENT_DAYS = RANGE_DAYS.year + COACH_DAYS;

export const EMPTY_TREND: Trend = Object.freeze({ step: 'day', ticks: [], series: { score: [], events: [] } });

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
/** "8:15 AM", local time. */
const clock = (ts: number): string => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
/** "Sep 22". */
const monthDay = (d: Date): string => `${MONTH_NAMES[d.getMonth()]!.slice(0, 3)} ${d.getDate()}`;
const HOUR_TICK = ['12a', '6a', '12p', '6p'] as const;

/** The first instant of the local day, Monday-first week or month holding `ts`. */
function slotStart(ts: number, step: Exclude<TrendStep, 'drive'>): Date {
  const d = new Date(ts);
  if (step === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (step === 'week') day.setDate(day.getDate() - weekdayIndex(ts));
  return day;
}

function nextSlot(d: Date, step: Exclude<TrendStep, 'drive'>): Date {
  if (step === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (step === 'week' ? 7 : 1));
}

interface Slot {
  start: number;
  x: number;
  tick: string;
  when: string;
}

/** The range's calendar slots, oldest first: every local day, week or month it touches. */
function calendarSlots(sinceMs: number, now: number, step: Exclude<TrendStep, 'drive'>): Slot[] {
  const starts: Date[] = [];
  for (let d = slotStart(sinceMs, step); d.getTime() <= now; d = nextSlot(d, step)) starts.push(d);
  const n = starts.length;
  const today = slotStart(now, 'day').getTime();
  // A year touches 13 months: the two that share a name say their year.
  const monthCount = new Map<number, number>();
  for (const d of starts) monthCount.set(d.getMonth(), (monthCount.get(d.getMonth()) ?? 0) + 1);
  return starts.map((d, i) => {
    const x = n === 1 ? 1 : i / (n - 1);
    const start = d.getTime();
    if (step === 'day') {
      const name = WEEKDAY_NAMES[d.getDay()]!;
      // A week touches 8 days: the oldest shares today's weekday.
      const when = start === today ? 'today' : today - start >= 6.5 * DAY_MS ? `last ${name}` : `on ${name}`;
      return { start, x, tick: WEEKDAY_LABELS[weekdayIndex(start)]!, when };
    }
    if (step === 'week') return { start, x, tick: monthDay(d), when: `in the week of ${monthDay(d)}` };
    const name = MONTH_NAMES[d.getMonth()]!;
    return { start, x, tick: name[0]!, when: `in ${name}${(monthCount.get(d.getMonth()) ?? 0) > 1 ? ` ${d.getFullYear()}` : ''}` };
  });
}

/** The local 12a / 6a / 12p / 6p marks inside a day range, placed by time. */
function hourTicks(sinceMs: number, now: number): TrendTick[] {
  const out: TrendTick[] = [];
  const s = new Date(sinceMs);
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d.getTime() <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 6)) {
    if (d.getTime() >= sinceMs) out.push({ x: (d.getTime() - sinceMs) / (now - sinceMs), label: HOUR_TICK[Math.floor(d.getHours() / 6)]! });
  }
  return out;
}

/**
 * The range's trend, per series, from the scored drives (all of them, as the cards read them) and
 * the active events of the scored drives since `TREND_EVENT_DAYS` ago (null while they load).
 *
 * - Score: the Safety Rating over time. Each point is `ratingAt` (whole) as of the point's moment:
 *   the end of its day, week or month (now for the current one), or on Day the drive's start, with
 *   one more point now. The latest point (now) is the radar's centre on every range. A point only
 *   where those 90 days hold 10 mi or more (ranked), so a slot with no drives of its own can still
 *   have one.
 * - Events: the slot's speeding, hard brakes, hard starts, sharp turns and phone pickups, from the
 *   drives' counts like the window's numbers, per mile driven in the slot; a slot with no miles has
 *   no point.
 *
 * An event belongs to the drive it happened in: the latest drive started at or before it (drives
 * never overlap).
 */
export function trend(drives: readonly LocalDrive[], events: readonly DriveEvent[] | null, range: Range, now: number): Trend {
  const sinceMs = rangeStart(now, range);
  const step = TREND_STEP[range];
  // Every scored drive, oldest first (a tie in start time keeps one order).
  const scored = scoredSince(drives, null).sort(byStart);
  const first = scored.findIndex((d) => d.startedAt >= sinceMs);
  const list = first < 0 ? [] : scored.slice(first);
  const slots: Slot[] =
    step === 'drive'
      ? list.map((d) => ({ start: d.startedAt, x: clamp((d.startedAt - sinceMs) / (now - sinceMs), 0, 1), tick: '', when: `at ${clock(d.startedAt)}` }))
      : calendarSlots(sinceMs, now, step);
  const ticks = step === 'drive' ? hourTicks(sinceMs, now) : slots.map((s) => ({ x: s.x, label: s.tick }));
  // Each slot's moment: the drive's start by drive, else the end of its period (now for the current one).
  const ends = slots.map((s, i) => (step === 'drive' ? s.start : Math.min(i + 1 < slots.length ? slots[i + 1]!.start - 1 : now, now)));
  const series: Trend['series'] = { score: [], events: [] };

  // Events per mile, from the range's drives.
  const acc = slots.map(() => ({ miles: 0, events: 0 }));
  list.forEach((d, i) => {
    let k = i;
    if (step !== 'drive') {
      k = 0;
      while (k + 1 < slots.length && slots[k + 1]!.start <= d.startedAt) k += 1;
    }
    const a = acc[k]!;
    a.miles += d.miles;
    a.events += d.counts.speeding + d.counts.hardBrake + d.counts.hardAccel + d.counts.hardCorner + d.counts.pickups;
  });
  slots.forEach((s, i) => {
    const a = acc[i]!;
    if (a.miles > 0) series.events.push({ x: s.x, value: a.events / a.miles, when: s.when });
  });

  // Score: the rating as of each slot's moment, from every drive that can fall in its 90 days.
  if (events !== null) {
    const pool = toRatingDrives(
      scored.filter((d) => d.startedAt >= sinceMs - COACH_DAYS * DAY_MS),
      events
    );
    /** The rating as of `at`, whole; null while its 90 days hold under 10 mi. */
    const scoreAt = (at: number): number | null => {
      const r = ratingAt(pool, at);
      return r.ranked && r.rating !== null ? Math.round(r.rating) : null;
    };
    slots.forEach((s, i) => {
      const value = scoreAt(ends[i]!);
      if (value !== null) series.score.push({ x: s.x, value, when: s.when });
    });
    // By drive the line also ends now: a drive leaving the 90 days since the last drive shows, and
    // the latest point is the radar's centre.
    if (step === 'drive') {
      const value = scoreAt(now);
      if (value !== null) series.score.push({ x: 1, value, when: 'now' });
    }
  }
  return { step, ticks, series };
}

/**
 * The chart's value range per series: Score is always 0–100; Events pads the data by 15 % of its
 * spread (at least 0.05 events a mile each way), and never dips below 0.
 */
export function trendRange(kind: TrendKind, values: readonly number[]): { lo: number; hi: number } {
  if (kind === 'score') return { lo: 0, hi: 100 };
  if (values.length === 0) return { lo: 0, hi: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, 0.05);
  return { lo: Math.max(0, min - pad), hi: max + pad };
}

export type TrendDirection = 'up' | 'down' | 'steady';

/**
 * Which way the line leans: the least-squares slope across the points, as the change it makes
 * from the first point to the last. Under 5 % of the chart's range (`span`) reads as steady.
 */
export function trendDirection(points: readonly Pick<TrendPoint, 'x' | 'value'>[], span: number): TrendDirection {
  if (points.length < 2) return 'steady';
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.value - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return 'steady';
  const change = (num / den) * (points[n - 1]!.x - points[0]!.x);
  if (Math.abs(change) < 0.05 * span) return 'steady';
  return change > 0 ? 'up' : 'down';
}

// ---------------------------------------------------------------------------------------------
// Personal bests

export interface Best {
  value: number;
  clientTripId: string;
}

export interface PersonalBests {
  /** Longest clean drive, in miles. */
  longestClean: Best | null;
}

/** All-time bests over scored drives. The first (newest, as given) wins a tie. */
export function personalBests(drives: readonly LocalDrive[]): PersonalBests {
  let longestClean: Best | null = null;
  for (const d of drives) {
    if (!isScoredDrive(d)) continue;
    if (d.miles > 0 && d.clean === true && (longestClean === null || d.miles > longestClean.value)) {
      longestClean = { value: d.miles, clientTripId: d.clientTripId };
    }
  }
  return { longestClean };
}

/** The all-time card's numbers and the time-of-day comment's share after dark: every scored drive. */
export interface AllTimeTotals extends PersonalBests {
  /** Scored drives with no events (`clean === true`), counted as `windowSums` counts them. */
  cleanDrives: number;
  /** Whole percent of all the miles driven after dark; null with no miles. */
  nightPct: number | null;
}

/** All time, over every scored drive: the longest clean drive, the clean drives, the share of miles after dark. */
export function allTimeTotals(drives: readonly LocalDrive[]): AllTimeTotals {
  const { cleanDrives, nightPct } = windowSums(drives, null);
  return { ...personalBests(drives), cleanDrives, nightPct };
}

// ---------------------------------------------------------------------------------------------
// When you drive

/** Rows Monday first. */
export const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
/** 3-hour bands from midnight. */
export const BAND_LABELS = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'] as const;
/** Every other band carries a tick on the chart. */
export const BAND_TICKS = ['12a', '6a', '12p', '6p'] as const;

export interface DriveGrid {
  /** `cells[weekday][band]`: weekday 0 = Monday, band 0 = 12a–3a. */
  cells: number[][];
  /** The largest cell (0 when empty), for shading. */
  max: number;
  total: number;
}

/** Monday = 0 … Sunday = 6, in the device's local time. */
export const weekdayIndex = (ts: number): number => (new Date(ts).getDay() + 6) % 7;
export const bandIndex = (ts: number): number => Math.floor(new Date(ts).getHours() / 3);

/** Scored drives since `sinceMs` counted by local weekday × 3-hour band of their start. */
export function driveGrid(drives: readonly LocalDrive[], sinceMs: number | null): DriveGrid {
  const cells = Array.from({ length: 7 }, () => new Array<number>(8).fill(0));
  let max = 0;
  let total = 0;
  for (const d of scoredSince(drives, sinceMs)) {
    const row = cells[weekdayIndex(d.startedAt)]!;
    const band = bandIndex(d.startedAt);
    row[band] = (row[band] ?? 0) + 1;
    max = Math.max(max, row[band]!);
    total += 1;
  }
  return { cells, max, total };
}

// ---------------------------------------------------------------------------------------------
// Time of day: a comment on the grid, never a score

/** A band's words in a sentence ("3–6pm"). */
export const BAND_WORDS = ['midnight–3am', '3–6am', '6–9am', '9am–noon', 'noon–3pm', '3–6pm', '6–9pm', '9pm–midnight'] as const;
const WEEKDAY_PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'] as const;

/** Under this many drives the card only asks for more. */
export const TIME_COMMENT_MIN_DRIVES = 3;

export type TimeCommentKind = 'few' | 'late' | 'dark' | 'rush' | 'weekend' | 'daytime' | 'busiest';

export interface TimeComment {
  kind: TimeCommentKind;
  text: string;
}

/**
 * One or two short, friendly lines about when the drives start, read off the When you drive
 * grid (and the share of miles after dark). It scores nothing and costs nothing: the first rule that
 * fits speaks.
 *
 * - Fewer than 3 drives: ask for a few more.
 * - A quarter or more of the drives start between midnight and 6am: late nights.
 * - 40 % or more of the miles after dark: night driving, with the share.
 * - Half or more start on a weekday 6–9am or 3–6pm: rush hour.
 * - 60 % or more on a Saturday or Sunday: a weekend driver.
 * - 70 % or more start 9am–6pm: daylight.
 * - Otherwise the busiest day and band, plus the share after dark when it is 15 % or more.
 *
 * Null with no drives (the grid says so already).
 */
export function timeComment(grid: DriveGrid, nightPct: number | null): TimeComment | null {
  const n = grid.total;
  if (n === 0) return null;
  if (n < TIME_COMMENT_MIN_DRIVES) return { kind: 'few', text: "A few more drives and we'll see when you usually hit the road." };
  const sum = (days: readonly number[], bands: readonly number[]) =>
    days.reduce((s, d) => s + bands.reduce((t, b) => t + (grid.cells[d]?.[b] ?? 0), 0), 0);
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const ALL_BANDS = [0, 1, 2, 3, 4, 5, 6, 7];
  const share = (count: number) => count / n;
  if (share(sum(ALL_DAYS, [0, 1])) >= 0.25) {
    return { kind: 'late', text: 'Quite a few of your drives start between midnight and 6am. Late nights are tiring, so go easy on those.' };
  }
  if (nightPct !== null && nightPct >= 40) {
    return { kind: 'dark', text: `About ${nightPct}% of your miles are after dark. Give yourself a bit more room at night.` };
  }
  if (share(sum([0, 1, 2, 3, 4], [2, 5])) >= 0.5) {
    return { kind: 'rush', text: 'Most of your drives hit weekday rush hour. A little extra following distance makes traffic calmer.' };
  }
  if (share(sum([5, 6], ALL_BANDS)) >= 0.6) {
    return { kind: 'weekend', text: "You're mostly a weekend driver. Enjoy the quieter roads." };
  }
  if (share(sum(ALL_DAYS, [3, 4, 5])) >= 0.7) {
    return { kind: 'daytime', text: 'You mostly drive in daylight, the easiest time to be on the road.' };
  }
  let day = 0;
  let band = 0;
  for (let d = 0; d < 7; d++) {
    for (let b = 0; b < 8; b++) {
      if ((grid.cells[d]?.[b] ?? 0) > (grid.cells[day]?.[band] ?? 0)) {
        day = d;
        band = b;
      }
    }
  }
  const dark = nightPct !== null && nightPct >= 15 ? ` About ${nightPct}% of your miles are after dark.` : '';
  return { kind: 'busiest', text: `Your busiest time is ${WEEKDAY_PLURAL[day]}, ${BAND_WORDS[band]}.${dark}` };
}

// ---------------------------------------------------------------------------------------------
// All trips map

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * Every route as map lines, one per privacy run (a cut never joins up across the gap). A run that
 * doesn't decode to a line is skipped.
 */
export function routeLines(polylines: readonly string[]): MapPoint[][] {
  const out: MapPoint[][] = [];
  for (const p of polylines) {
    try {
      for (const pts of decodeRuns(p)) {
        if (pts.length >= 2) out.push(pts.map((q) => ({ latitude: q.lat, longitude: q.lng })));
      }
    } catch {
      // A malformed route draws nothing.
    }
  }
  return out;
}

export const FIT_SPAN_SCALE = 1.6;
export const FIT_MIN_DELTA = 0.02;

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.round(q * (sorted.length - 1))]!;
}

/**
 * The region the trip map opens on: centred on the median point, wide enough for the 10th–90th
 * percentile span × 1.6 (at least 0.02°), so the most-driven roads sit in the middle with room
 * around them and outliers stay a pinch away. Null with no points.
 */
export function fitRegion(points: readonly MapPoint[]): Region | null {
  const lats: number[] = [];
  const lngs: number[] = [];
  for (const p of points) {
    if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
      lats.push(p.latitude);
      lngs.push(p.longitude);
    }
  }
  if (lats.length === 0) return null;
  lats.sort((a, b) => a - b);
  lngs.sort((a, b) => a - b);
  return {
    latitude: quantile(lats, 0.5),
    longitude: quantile(lngs, 0.5),
    latitudeDelta: Math.max(FIT_MIN_DELTA, (quantile(lats, 0.9) - quantile(lats, 0.1)) * FIT_SPAN_SCALE),
    longitudeDelta: Math.max(FIT_MIN_DELTA, (quantile(lngs, 0.9) - quantile(lngs, 0.1)) * FIT_SPAN_SCALE),
  };
}

/** `fitRegion` over every point of the given lines. */
export const fitLines = (lines: readonly (readonly MapPoint[])[]): Region | null => fitRegion(lines.flat());
