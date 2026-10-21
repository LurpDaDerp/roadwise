// v3 Safety Rating, category scores, the drive score and levels (product spec v3 "Safety Rating").
import { attentionPenalty, isDashcamType, ratingPenalty, type DriveEvent, type EventType } from './drive';
import { clamp, roundTo } from './num';

/** Miles in the 30-day window needed to be ranked, and the window's miles floor (`categoryScore`). */
export const RANKED_MIN_MILES = 10;
/** The miles floor of one drive's score, so one event on a short drive can't sink it. */
export const DRIVE_SCORE_MIN_MILES = 3;
export const MAX_LEVEL = 50;
/** Level n is reached at LEVEL_STEP × n(n−1)/2 points (the driver's total, never below 0). */
export const LEVEL_STEP = 250;

export interface SafetyRating {
  /** 0–100, 1 decimal; null with no miles. */
  rating: number | null;
  ranked: boolean;
}

/** The miles DashPal watched on a drive: its miles × the share of its moving seconds the dashcam covered. */
export function watchedMiles(miles: number, movingS: number, coveredS: number): number {
  if (!(miles > 0) || !(movingS > 0) || !(coveredS > 0)) return 0;
  return (miles * Math.min(coveredS, movingS)) / movingS;
}

// ---------------------------------------------------------------------------------------------
// Categories (the Analytics radar's axes)

/** The six categories, in radar order, clockwise from the top. */
export type AxisKey = 'acceleration' | 'braking' | 'turning' | 'attention' | 'phone' | 'speed';
export const AXES: readonly AxisKey[] = ['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed'];

/** The category that needs a paired DashPal: no score without watched miles. */
export const DASHPAL_AXIS: AxisKey = 'attention';

/** What each category weighs in the Safety Rating and the drive score: speed and phone use count double. */
export const AXIS_WEIGHT: Readonly<Record<AxisKey, number>> = {
  speed: 2,
  phone: 2,
  braking: 1,
  acceleration: 1,
  turning: 1,
  attention: 1,
};

/** The category an event counts toward: DashPal's eyes-off and drowsy events are Attention. */
export function axisOf(type: EventType): AxisKey {
  switch (type) {
    case 'speeding':
      return 'speed';
    case 'hard_brake':
      return 'braking';
    case 'hard_accel':
      return 'acceleration';
    case 'hard_corner':
      return 'turning';
    case 'phone_pickup':
    case 'phone_handling':
      return 'phone';
    case 'eyes_off':
    case 'drowsy':
      return 'attention';
  }
}

/** A rating-penalty sum per category. */
export type AxisPenalties = Record<AxisKey, number>;

export const zeroAxisPenalties = (): AxisPenalties => ({ acceleration: 0, braking: 0, turning: 0, attention: 0, phone: 0, speed: 0 });

/**
 * The rating-penalty sum per category over the given events, active ones only: a phone event's
 * `ratingPenalty` on its category, a DashPal event's `attentionPenalty` on Attention. Base
 * penalties only (`RATING_PENALTY`), never the points' multipliers.
 */
export function axisPenalties(events: readonly DriveEvent[]): AxisPenalties {
  const out = zeroAxisPenalties();
  for (const e of events) {
    if (e.status === 'removed') continue;
    out[axisOf(e.type)] += isDashcamType(e.type) ? attentionPenalty(e) : ratingPenalty(e);
  }
  return out;
}

/** The curve's scale: a category is at 50 when its penalty per mile reaches this. */
export const CATEGORY_K = 16;

/**
 * A category's score, 0–100 (never 0), from its rating penalty `penalty` over `miles`, with the
 * miles floored at `floorMiles`:
 *
 *   100 / (1 + (penalty / max(miles, floorMiles)) / CATEGORY_K)
 *
 * One phone pickup (40) every 10 mi scores 80; one hard brake (10) every 20 mi about 97; one
 * severe speeding (100) every 10 mi about 62. Unrounded: the rating and the drive score average
 * these; a screen rounds them to whole numbers. The SQL `private.category_score` does the same
 * arithmetic. A non-finite or negative penalty reads as 0; non-finite miles as 0 (so the floor).
 */
export function categoryScore(penalty: number, miles: number, floorMiles: number): number {
  const p = Number.isFinite(penalty) ? Math.max(0, penalty) : 0;
  const m = Math.max(Number.isFinite(miles) ? miles : 0, floorMiles);
  return 100 / (1 + p / m / CATEGORY_K);
}

/** What a window (30 days, or one drive) holds: its penalty per category, its miles and the miles DashPal watched. */
export interface RatingWindow {
  penalties: AxisPenalties;
  miles: number;
  /** Attention's miles: 0 (or less) means no Attention score. */
  watchedMiles: number;
}

/** 0–100 per category, unrounded; null where there is no score. */
export type AxisScores = Record<AxisKey, number | null>;

/**
 * Every category's `categoryScore` over the window, each over the window's miles (Attention over
 * the miles DashPal watched, null with none), floored at `floorMiles`. All null with no miles.
 */
export function axisScores(window: RatingWindow, floorMiles: number): AxisScores {
  const none: AxisScores = { acceleration: null, braking: null, turning: null, attention: null, phone: null, speed: null };
  if (!(window.miles > 0)) return none;
  const p = window.penalties;
  return {
    acceleration: categoryScore(p.acceleration, window.miles, floorMiles),
    braking: categoryScore(p.braking, window.miles, floorMiles),
    turning: categoryScore(p.turning, window.miles, floorMiles),
    attention: window.watchedMiles > 0 ? categoryScore(p.attention, window.watchedMiles, floorMiles) : null,
    phone: categoryScore(p.phone, window.miles, floorMiles),
    speed: categoryScore(p.speed, window.miles, floorMiles),
  };
}

/**
 * The weighted mean of the scored categories (`AXIS_WEIGHT`: speed and phone use double, the rest
 * single, a null category left out of both sums); null when none is scored. Unrounded.
 */
export function weightedScore(scores: Readonly<Partial<Record<AxisKey, number | null>>>): number | null {
  let sum = 0;
  let weight = 0;
  for (const axis of AXES) {
    const s = scores[axis];
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    sum += AXIS_WEIGHT[axis] * s;
    weight += AXIS_WEIGHT[axis];
  }
  return weight > 0 ? sum / weight : null;
}

/**
 * The Safety Rating over the last 30 days: the weighted mean (`weightedScore`) of the categories'
 * scores (`axisScores`, each over the window's miles floored at `RANKED_MIN_MILES`; Attention over
 * the miles DashPal watched, and only for a driver DashPal watched), 1 decimal. Null with no miles.
 * Ranked from `RANKED_MIN_MILES` in the window. The SQL `private.safety_rating` matches it exactly.
 */
export function safetyRatingOf(window: RatingWindow): SafetyRating {
  if (!(window.miles > 0)) return { rating: null, ranked: false };
  const mean = weightedScore(axisScores(window, RANKED_MIN_MILES));
  return { rating: mean === null ? null : roundTo(clamp(mean, 0, 100), 1), ranked: window.miles >= RANKED_MIN_MILES };
}

/**
 * One drive's score out of 100: the same weighted mean over the drive's active events, its miles
 * floored at `DRIVE_SCORE_MIN_MILES` (Attention over the miles DashPal watched on it), a whole
 * number. Null for a drive with no miles. Shown on the summary and the share card.
 */
export function driveScore(events: readonly DriveEvent[], miles: number, watchedMiles: number): number | null {
  const mean = weightedScore(axisScores({ penalties: axisPenalties(events), miles, watchedMiles }, DRIVE_SCORE_MIN_MILES));
  return mean === null ? null : roundTo(clamp(mean, 0, 100));
}

// ---------------------------------------------------------------------------------------------
// Levels

export interface LevelInfo {
  level: number;
  /** Points at which this level is reached. */
  floor: number;
  /** Points for the next level; null at the cap. */
  next: number | null;
}

const threshold = (n: number): number => (LEVEL_STEP * n * (n - 1)) / 2;

/**
 * Level for the driver's points total (earned less lost, never below 0), so a level can be lost
 * again. Level 1 at 0, L2 250, L3 750, L4 1500 … cap 50.
 */
export function levelForPoints(points: number): LevelInfo {
  let level = 1;
  if (Number.isFinite(points)) {
    while (level < MAX_LEVEL && points >= threshold(level + 1)) level += 1;
  }
  return { level, floor: threshold(level), next: level < MAX_LEVEL ? threshold(level + 1) : null };
}
