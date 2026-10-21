// v3 Safety Rating and levels (product spec v3 "Safety Rating", plan §2).
import { clamp, roundTo } from './num';

/** Miles in the 30-day window needed to be ranked. */
export const RANKED_MIN_MILES = 10;
export const MAX_LEVEL = 50;
/** Level n is reached at LEVEL_STEP × n(n−1)/2 points (the driver's total, never below 0). */
export const LEVEL_STEP = 250;

export interface SafetyRating {
  /** 0–100, 1 decimal; null with no miles. */
  rating: number | null;
  ranked: boolean;
}

/** Attention's penalty is divided by at least this many watched miles, so one look away on a short watched stretch can't sink the rating. */
export const ATTENTION_MIN_MILES = 10;

/** The miles DashPal watched on a drive: its miles × the share of its moving seconds the dashcam covered. */
export function watchedMiles(miles: number, movingS: number, coveredS: number): number {
  if (!(miles > 0) || !(movingS > 0) || !(coveredS > 0)) return 0;
  return (miles * Math.min(coveredS, movingS)) / movingS;
}

/**
 * Attention's share of the rating: 10 × its penalty (`attentionPenalty`) ÷ the watched miles (at
 * least `ATTENTION_MIN_MILES`), the same scale as the other categories; 0 with nothing watched.
 */
export function attentionDeficit(penalty: number, watched: number): number {
  if (!(watched > 0)) return 0;
  return (10 * Math.max(0, penalty)) / Math.max(watched, ATTENTION_MIN_MILES);
}

/** The DashPal side of a window: its Attention penalty sum and the miles DashPal watched. */
export interface AttentionWindow {
  penalty: number;
  watchedMiles: number;
}

/**
 * The Safety Rating is 100 less what each radar category takes off, over the last 30 days:
 * the phone's categories (speed, braking, acceleration, turning, phone use) take 10 × their base
 * penalty per mile between them (R = penalty ÷ miles × 100, so R/10), and Attention, for a driver
 * DashPal watched, takes `attentionDeficit` of its own. Clamped to 0–100, 1 decimal. The penalty
 * sums are base penalties only (`ratingPenalty`, `attentionPenalty`), never game multipliers.
 */
export function safetyRating(ratingPenalty30d: number, miles30d: number, attention?: AttentionWindow | null): SafetyRating {
  if (!(miles30d > 0)) return { rating: null, ranked: false };
  const R = (Math.max(0, ratingPenalty30d) * 100) / miles30d;
  const att = attention ? attentionDeficit(attention.penalty, attention.watchedMiles) : 0;
  return { rating: roundTo(clamp(100 - R / 10 - att, 0, 100), 1), ranked: miles30d >= RANKED_MIN_MILES };
}

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
