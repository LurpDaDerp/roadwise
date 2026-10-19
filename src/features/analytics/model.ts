/**
 * The coaching model behind the Analytics tab and Home's tip card (plan D6). Pure and
 * deterministic: every function takes the instant it measures from (`now`) or a cutoff, never the
 * clock, so each rule is testable on its own.
 *
 * The radar's sub-scores use the Safety Rating's own scale (100 − 10 × penalty per mile), so the
 * five penalty axes add up to the rating over the same 30 days: 100 − rating = Σ (100 − axis),
 * before clamping. Local data includes pending estimates; the server rating stays authoritative.
 */
import { ratingPenalty, safetyRating, type DriveEvent, type EventType } from '@scoring';

import { isScoredDrive, type LocalDrive } from '@/data/queries/rows';
import type { Region } from '@/features/settings/maps';
import { decodeRuns } from '@/lib/polyline';

// ---------------------------------------------------------------------------------------------
// Axes and sub-scores

export type AxisKey = 'speeding' | 'braking' | 'accel' | 'cornering' | 'phone' | 'clean';
export type PenaltyAxisKey = Exclude<AxisKey, 'clean'>;

/** Radar order, clockwise from the top. */
export const AXES: readonly { key: AxisKey; label: string }[] = [
  { key: 'speeding', label: 'Speeding' },
  { key: 'braking', label: 'Braking' },
  { key: 'accel', label: 'Acceleration' },
  { key: 'cornering', label: 'Cornering' },
  { key: 'phone', label: 'Phone use' },
  { key: 'clean', label: 'Clean drives' },
];

export const AXIS_LABEL: Record<AxisKey, string> = Object.fromEntries(AXES.map((a) => [a.key, a.label])) as Record<AxisKey, string>;

export const PENALTY_AXES: readonly PenaltyAxisKey[] = ['speeding', 'braking', 'accel', 'cornering', 'phone'];

/** The axis an event counts toward; null for DashPal events (never in the rating). */
export function axisOf(type: EventType): PenaltyAxisKey | null {
  switch (type) {
    case 'speeding':
      return 'speeding';
    case 'hard_brake':
      return 'braking';
    case 'hard_accel':
      return 'accel';
    case 'hard_corner':
      return 'cornering';
    case 'phone_pickup':
    case 'phone_handling':
      return 'phone';
    case 'eyes_off':
    case 'drowsy':
      return null;
  }
}

/** 0–100 per axis, whole numbers; null when the window has no miles (or no drives, for `clean`). */
export type AxisScores = Record<AxisKey, number | null>;

/** What a window holds: the scored drives' totals the axes divide by. */
export interface WindowTotals {
  drives: number;
  cleanDrives: number;
  miles: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Rating-penalty sum per penalty axis over the given (active) events. */
export function axisPenalties(events: readonly DriveEvent[]): Record<PenaltyAxisKey, number> {
  const out: Record<PenaltyAxisKey, number> = { speeding: 0, braking: 0, accel: 0, cornering: 0, phone: 0 };
  for (const e of events) {
    if (e.status === 'removed') continue;
    const axis = axisOf(e.type);
    if (axis !== null) out[axis] += ratingPenalty(e);
  }
  return out;
}

/**
 * S = clamp(100 − 10 · P / miles, 0, 100) per penalty axis; clean = clean drives / drives × 100.
 * `events` are the active events of the window's scored drives; `totals` the same drives' sums.
 */
export function axisScores(events: readonly DriveEvent[], totals: WindowTotals): AxisScores {
  const p = axisPenalties(events);
  const score = (penalty: number): number | null =>
    totals.miles > 0 ? Math.round(clamp(100 - (10 * penalty) / totals.miles, 0, 100)) : null;
  return {
    speeding: score(p.speeding),
    braking: score(p.braking),
    accel: score(p.accel),
    cornering: score(p.cornering),
    phone: score(p.phone),
    clean: totals.drives > 0 ? Math.round((totals.cleanDrives / totals.drives) * 100) : null,
  };
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
  speeding: 'Ease off a little over the limit.',
  braking: 'Leave more room so you can brake gently.',
  accel: 'Roll onto the gas smoothly.',
  cornering: 'Slow down before the turn, not in it.',
  phone: 'Put the phone away before you pull out.',
  clean: 'Aim for one clean drive at a time.',
};

export const AXIS_TITLE: Record<AxisKey, string> = {
  speeding: 'Watch your speed',
  braking: 'Brake more gently',
  accel: 'Ease into the gas',
  cornering: 'Take turns slower',
  phone: 'Phone down while driving',
  clean: 'More clean drives',
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
   * The other penalty axes that are fair or poor, weakest first (ties in radar order), at most
   * `COACH_ALSO_MAX`. Empty when the result is good or there is no advice. The clean-drive share
   * never appears here: it follows from the penalty axes, as in the main choice.
   */
  also: { axis: AxisKey; level: Level }[];
}

export const COACH_ALSO_MAX = 2;

/**
 * The advice for a window. The weakest penalty axis decides (ties go to the earlier axis in radar
 * order); when every penalty axis is good, a fair or poor clean-drive share speaks instead. A good
 * result is a compliment. Fewer than 3 drives or 10 miles: no advice.
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
  if ((score === null || levelFor(score) === 'good') && scores.clean !== null && levelFor(scores.clean) !== 'good') {
    axis = 'clean';
    score = scores.clean;
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

/** Home shows the tip card only when there is something to work on. */
export const showsTip = (c: Coaching): boolean => c.level === 'fair' || c.level === 'poor';

export interface CoachWindow {
  scores: AxisScores;
  totals: WindowTotals;
  coaching: Coaching;
}

/**
 * Sub-scores and advice for the scored drives started at or after `sinceMs`. `events` are the
 * active events of the same window's scored drives (`readWindowEvents(db, sinceMs)`).
 */
export function coachWindow(drives: readonly LocalDrive[], events: readonly DriveEvent[], sinceMs: number): CoachWindow {
  const totals: WindowTotals = { drives: 0, cleanDrives: 0, miles: 0 };
  for (const d of scoredSince(drives, sinceMs)) {
    totals.drives += 1;
    totals.miles += d.miles;
    if (d.clean === true) totals.cleanDrives += 1;
  }
  const scores = axisScores(events, totals);
  return { scores, totals, coaching: coach(scores, totals) };
}

// ---------------------------------------------------------------------------------------------
// Windows

export type Range = 'day' | 'week' | 'month' | 'year';
export const RANGES: readonly Range[] = ['day', 'week', 'month', 'year'];
export const RANGE_LABEL: Record<Range, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
export const RANGE_DAYS: Record<Range, number> = { day: 1, week: 7, month: 30, year: 365 };
/** The radar, summary and Home tip window: the Safety Rating's 30 days. */
export const COACH_DAYS = 30;

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
  /** Distance / hours; null with no drive time. */
  avgMph: number | null;
  speeding: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
  pickups: number;
  handlingS: number;
  cleanDrives: number;
  /** Whole percent of drives that were clean; null with no drives. */
  cleanPct: number | null;
  /** Net points of the window's drives (estimates included). */
  points: number;
  /** Distance per drive; null with no drives. */
  avgMiles: number | null;
  /** Net points per drive; null with no drives. */
  avgPoints: number | null;
}

export const EMPTY_WINDOW: WindowSums = Object.freeze({
  drives: 0,
  miles: 0,
  durationS: 0,
  avgMph: null,
  speeding: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
  pickups: 0,
  handlingS: 0,
  cleanDrives: 0,
  cleanPct: null,
  points: 0,
  avgMiles: null,
  avgPoints: null,
});

/**
 * The metric sums over scored drives started at or after `sinceMs`. DashPal eyes-off and drowsy
 * stay out, as in every other stat.
 */
export function windowSums(drives: readonly LocalDrive[], sinceMs: number | null): WindowSums {
  const out = { ...EMPTY_WINDOW };
  for (const d of scoredSince(drives, sinceMs)) {
    out.drives += 1;
    out.miles += d.miles;
    out.durationS += d.durationS;
    out.speeding += d.counts.speeding;
    out.hardBrake += d.counts.hardBrake;
    out.hardAccel += d.counts.hardAccel;
    out.hardCorner += d.counts.hardCorner;
    out.pickups += d.counts.pickups;
    out.handlingS += d.counts.handlingS;
    if (d.clean === true) out.cleanDrives += 1;
    out.points += d.pointsNet ?? 0;
  }
  out.avgMph = out.durationS > 0 ? out.miles / (out.durationS / 3600) : null;
  out.cleanPct = out.drives > 0 ? Math.round((out.cleanDrives / out.drives) * 100) : null;
  out.avgMiles = out.drives > 0 ? out.miles / out.drives : null;
  out.avgPoints = out.drives > 0 ? out.points / out.drives : null;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Trend

export type TrendKind = 'score' | 'events' | 'points';
export const TREND_KINDS: readonly TrendKind[] = ['score', 'events', 'points'];

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
  value: number;
  /** When, for a screen reader: "at 8:15 AM", "on Tuesday", "today", "in the week of Sep 22", "in March". */
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
   * Per series, one point per slot that has drives, oldest first; a slot with none has no point,
   * so the line joins the slots that do. Score stays empty until the range's events are in.
   */
  series: Record<TrendKind, TrendPoint[]>;
}

export const EMPTY_TREND: Trend = Object.freeze({ step: 'day', ticks: [], series: { score: [], events: [], points: [] } });

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

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The range's trend, per series, from the same scored drives as the cards and the active events of
 * those drives (`readWindowEvents(db, sinceMs)`; null while they load).
 *
 * - Score: the Safety Rating's own formula over the slot's drives, clamp(100 − 10 · P / miles),
 *   where P is the rating penalty of their events (`ratingPenalty`: base penalties, DashPal never
 *   counts), as a whole number. Over 30 days of drives it is the rating; the radar's axes split
 *   the same P.
 * - Events: speeding, hard brakes, hard starts, sharp turns and pickups per 100 miles, from the
 *   drives' counts like the window's numbers (phone handling is a time, not a count). 1 decimal.
 * - Points: net points per drive, whole.
 *
 * An event belongs to the drive it happened in: the latest drive started at or before it (drives
 * never overlap). A slot with no miles has no Score or Events point.
 */
export function trend(drives: readonly LocalDrive[], events: readonly DriveEvent[] | null, range: Range, now: number): Trend {
  const sinceMs = rangeStart(now, range);
  const step = TREND_STEP[range];
  const list = scoredSince(drives, sinceMs).sort((a, b) => a.startedAt - b.startedAt);
  const slots: Slot[] =
    step === 'drive'
      ? list.map((d) => ({ start: d.startedAt, x: clamp((d.startedAt - sinceMs) / (now - sinceMs), 0, 1), tick: '', when: `at ${clock(d.startedAt)}` }))
      : calendarSlots(sinceMs, now, step);
  const ticks = step === 'drive' ? hourTicks(sinceMs, now) : slots.map((s) => ({ x: s.x, label: s.tick }));

  const acc = slots.map(() => ({ drives: 0, miles: 0, points: 0, events: 0, penalty: 0 }));
  // The slot of each drive: its own (by drive), else the latest slot started at or before it.
  const slotOf = list.map((d, i) => {
    if (step === 'drive') return i;
    let k = 0;
    while (k + 1 < slots.length && slots[k + 1]!.start <= d.startedAt) k += 1;
    return k;
  });
  list.forEach((d, i) => {
    const a = acc[slotOf[i]!]!;
    a.drives += 1;
    a.miles += d.miles;
    a.points += d.pointsNet ?? 0;
    a.events += d.counts.speeding + d.counts.hardBrake + d.counts.hardAccel + d.counts.hardCorner + d.counts.pickups;
  });
  if (events !== null && list.length > 0) {
    const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt);
    let j = -1;
    for (const e of sorted) {
      if (e.status === 'removed') continue;
      while (j + 1 < list.length && list[j + 1]!.startedAt <= e.startedAt) j += 1;
      if (j >= 0) acc[slotOf[j]!]!.penalty += ratingPenalty(e);
    }
  }

  const series: Trend['series'] = { score: [], events: [], points: [] };
  slots.forEach((s, i) => {
    const a = acc[i]!;
    if (a.drives === 0) return;
    const at = { x: s.x, when: s.when };
    if (a.miles > 0) {
      if (events !== null) series.score.push({ ...at, value: Math.round(safetyRating(a.penalty, a.miles).rating ?? 100) });
      series.events.push({ ...at, value: round1((a.events / a.miles) * 100) });
    }
    series.points.push({ ...at, value: Math.round(a.points / a.drives) });
  });
  return { step, ticks, series };
}

/**
 * The chart's value range per series: Score is always 0–100; Events and Points pad the data by
 * 15 % of its spread (at least 0.5 events or 5 points each way), and Events never dips below 0.
 */
export function trendRange(kind: TrendKind, values: readonly number[]): { lo: number; hi: number } {
  if (kind === 'score' || values.length === 0) return kind === 'score' ? { lo: 0, hi: 100 } : { lo: 0, hi: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, kind === 'events' ? 0.5 : 5);
  return { lo: kind === 'events' ? Math.max(0, min - pad) : min - pad, hi: max + pad };
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
  /** Most net points in one drive. */
  mostPoints: Best | null;
  /** Longest clean drive, in miles. */
  longestClean: Best | null;
  /** Longest drive with no pickup and no handling, in miles. */
  longestPhoneFree: Best | null;
}

/** All-time bests over scored drives. The first (newest, as given) wins a tie. */
export function personalBests(drives: readonly LocalDrive[]): PersonalBests {
  let mostPoints: Best | null = null;
  let longestClean: Best | null = null;
  let longestPhoneFree: Best | null = null;
  for (const d of drives) {
    if (!isScoredDrive(d)) continue;
    if (d.pointsNet !== null && (mostPoints === null || d.pointsNet > mostPoints.value)) {
      mostPoints = { value: d.pointsNet, clientTripId: d.clientTripId };
    }
    if (d.miles > 0 && d.clean === true && (longestClean === null || d.miles > longestClean.value)) {
      longestClean = { value: d.miles, clientTripId: d.clientTripId };
    }
    const phoneFree = d.counts.pickups === 0 && d.counts.handlingS === 0;
    if (d.miles > 0 && phoneFree && (longestPhoneFree === null || d.miles > longestPhoneFree.value)) {
      longestPhoneFree = { value: d.miles, clientTripId: d.clientTripId };
    }
  }
  return { mostPoints, longestClean, longestPhoneFree };
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
