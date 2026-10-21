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

/**
 * R = base penalty points ÷ miles × 100 over the last 30 days; rating = clamp(100 − R/10, 0, 100).
 * The penalty sum is base penalties only (`ratingPenalty`), never game multipliers.
 */
export function safetyRating(ratingPenalty30d: number, miles30d: number): SafetyRating {
  if (!(miles30d > 0)) return { rating: null, ranked: false };
  const R = (Math.max(0, ratingPenalty30d) * 100) / miles30d;
  return { rating: roundTo(clamp(100 - R / 10, 0, 100), 1), ranked: miles30d >= RANKED_MIN_MILES };
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
