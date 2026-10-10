// v3 points for one drive (product spec v3 "Points per drive", plan §2).
//
//   Drive points = G × M_gain − P × S_short
//
// Pure and deterministic: no clock, no randomness, no imports outside this package.
import { clamp, roundTo } from './num';
import { MIN_SCORED_MILES } from './thresholds';

export const SCORING_VERSION = 3;

export type EventType =
  | 'speeding'
  | 'hard_brake'
  | 'hard_accel'
  | 'hard_corner'
  | 'phone_pickup'
  | 'phone_handling';

/** Colour: minor = yellow, moderate = orange, severe = red. */
export type Tier = 'minor' | 'moderate' | 'severe';

export type Zone = 'school' | 'construction';

export interface DriveEvent {
  /** uuid from the device */
  id: string;
  type: EventType;
  /**
   * speeding: minor | moderate | severe; harsh: minor | severe; phone_pickup: severe;
   * phone_handling: moderate (≤30 s) | severe (>30 s).
   */
  tier: Tier;
  /** epoch ms */
  startedAt: number;
  durationS: number;
  /**
   * phone_handling: 15-s blocks beyond the first 15 s after the pickup (≥1, 1 when absent).
   * Ignored for speeding: its extra 30-s blocks are always floor(durationS / 30).
   */
  units?: number;
  /** phone_pickup only: base 20 instead of 40. */
  stoppedInTraffic?: boolean;
  /** ×2 penalty. Nothing sets it in v1. */
  zone?: Zone | null;
  /** removed = accepted dispute → excluded from points and rating. */
  status?: 'active' | 'removed';
}

/** Base penalty per type and tier. Two-level types read anything below severe as minor. */
export const BASE_PENALTY = {
  speeding: { minor: 15, moderate: 40, severe: 100 },
  hard_brake: { minor: 10, severe: 25 },
  hard_accel: { minor: 15, severe: 30 },
  hard_corner: { minor: 10, severe: 25 },
  phone_pickup: 40,
  phone_pickup_stopped: 20,
  phone_handling_per_unit: 10,
} as const;

/** Points per credited safe mile, and the clean-drive bonus (from `CLEAN_BONUS_MIN_MILES`). */
export const POINTS_PER_MILE = 10;
export const CLEAN_BONUS = 25;
export const CLEAN_BONUS_MIN_MILES = 2;
/** Daily cap bands on safe miles: full rate to 40, half rate to 100, nothing beyond. */
export const DAILY_FULL_MILES = 40;
export const DAILY_HALF_MILES = 100;
export const STREAK_STEP = 0.02;
export const STREAK_MULT_CAP = 1.3;

/** T(L): tolerance over the posted limit, mph. Fixed at 3 in a school or construction zone. */
export function speedTolerance(limitMph: number, zone?: Zone | null): number {
  if (zone) return 3;
  // 0.175 = 7/40; the integer form keeps exact halves (L = 28 → 3.5) exact.
  return clamp(Math.round((7 * (limitMph - 8)) / 40), 3, 10);
}

/** Tier by how far the speed is beyond L + T: >0 minor, >5 moderate, >10 severe; null if not over. */
export function speedTier(speedMph: number, limitMph: number, zone?: Zone | null): Tier | null {
  const over = roundTo(speedMph - (limitMph + speedTolerance(limitMph, zone)), 6);
  if (over <= 0) return null;
  if (over > 10) return 'severe';
  if (over > 5) return 'moderate';
  return 'minor';
}

const isActive = (e: DriveEvent): boolean => e.status !== 'removed';

/** Most blocks an event can count (12 h of 30-s speeding blocks), so any input stays finite. */
export const MAX_UNITS = 1440;

function units(e: DriveEvent): number {
  if (e.type === 'speeding') return Math.min(MAX_UNITS, Math.floor(Math.max(0, e.durationS) / 30));
  if (e.type === 'phone_handling') return clamp(Math.floor(e.units ?? 1), 1, MAX_UNITS);
  return 0;
}

/** The event's base penalty: no extension, repeat or zone multiplier. */
export function basePenalty(e: DriveEvent): number {
  const severe = e.tier === 'severe';
  switch (e.type) {
    case 'speeding':
      return BASE_PENALTY.speeding[e.tier];
    case 'hard_brake':
    case 'hard_accel':
    case 'hard_corner':
      return BASE_PENALTY[e.type][severe ? 'severe' : 'minor'];
    case 'phone_pickup':
      return e.stoppedInTraffic ? BASE_PENALTY.phone_pickup_stopped : BASE_PENALTY.phone_pickup;
    case 'phone_handling':
      return BASE_PENALTY.phone_handling_per_unit * units(e);
  }
}

/** What the event adds to the Safety Rating's penalty sum: the base penalty only. */
export const ratingPenalty = (e: DriveEvent): number => basePenalty(e);

const repeatMult = (repeatIndex: number): number => (repeatIndex <= 0 ? 1 : repeatIndex === 1 ? 1.25 : 1.5);

/**
 * The event's game penalty before short-drive scaling: base × speeding extension (+25% per extra
 * 30-s block) × repeat multiplier (2nd of a type ×1.25, 3rd and later ×1.5) × zone (×2).
 */
export function eventPenalty(e: DriveEvent, repeatIndex: number): number {
  const extension = e.type === 'speeding' ? 1 + 0.25 * units(e) : 1;
  return basePenalty(e) * extension * repeatMult(repeatIndex) * (e.zone ? 2 : 1);
}

/** Safe miles credited after the daily cap: ∫ rate over [earlier, earlier + safe], 3 dp. */
export function cappedMiles(safeMiles: number, safeMilesEarlierToday: number): number {
  const a = Math.max(0, safeMilesEarlierToday);
  const b = a + Math.max(0, safeMiles);
  const band = (lo: number, hi: number) => Math.max(0, Math.min(b, hi) - Math.max(a, lo));
  return roundTo(band(0, DAILY_FULL_MILES) + 0.5 * band(DAILY_FULL_MILES, DAILY_HALF_MILES), 3);
}

/** Streak multiplier for a drive taken with this streak: 1 + 0.02 × streak, capped at 1.30. */
export function nextMultiplier(streak: number): number {
  return Math.min(STREAK_MULT_CAP, roundTo(1 + STREAK_STEP * Math.max(0, streak), 2));
}

export interface DriveInput {
  miles: number;
  safeMiles: number;
  events: DriveEvent[];
  /** Repeats a recent short loop → credited miles halved. */
  loopRepeat?: boolean;
}

export interface DriveContext {
  streak: number;
  safeMilesEarlierToday: number;
}

export interface DriveBreakdown {
  /** miles < 0.5 → not scored, all point fields zero. */
  scored: boolean;
  reason?: 'too_short';
  safeMiles: number;
  /** After the daily cap (and ×0.5 if loopRepeat), 3 dp. */
  creditedMiles: number;
  /** creditedMiles × 10 (unrounded). */
  milePoints: number;
  /** 25 iff miles ≥ 2, zero active events, creditedMiles > 0 and not a loop repeat. */
  cleanBonus: 0 | 25;
  /** M_gain: the streak multiplier, 1 + 0.02 × streak capped at 1.30. Scales gains only. */
  streakMult: number;
  /** round((milePoints + cleanBonus) × streakMult) */
  gains: number;
  /** min(1, 0.5 + miles / 6) */
  shortScale: number;
  /** round(eventPenalty × shortScale) per active event, in startedAt order. */
  events: { id: string; penalty: number }[];
  penalties: number;
  /** gains − penalties */
  net: number;
  /** Σ ratingPenalty of active events. */
  ratingPenalty: number;
  activeEventCount: number;
}

/** Score one drive. Deterministic; does not mutate its input. */
export function scoreDrive(input: DriveInput, ctx: DriveContext): DriveBreakdown {
  const streakMult = nextMultiplier(ctx.streak);
  const shortScale = Math.min(1, 0.5 + Math.max(0, input.miles) / 6);
  const base = { streakMult, shortScale };

  if (!(input.miles >= MIN_SCORED_MILES)) {
    return {
      scored: false,
      reason: 'too_short',
      safeMiles: 0,
      creditedMiles: 0,
      milePoints: 0,
      cleanBonus: 0,
      ...base,
      gains: 0,
      events: [],
      penalties: 0,
      net: 0,
      ratingPenalty: 0,
      activeEventCount: 0,
    };
  }

  const safeMiles = clamp(input.safeMiles, 0, input.miles);
  let creditedMiles = cappedMiles(safeMiles, ctx.safeMilesEarlierToday);
  if (input.loopRepeat) creditedMiles = roundTo(creditedMiles * 0.5, 3);
  const milePoints = creditedMiles * POINTS_PER_MILE;

  const active = input.events
    .filter(isActive)
    .slice()
    .sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // No bonus once the daily cap is used up or on a repeated loop, so short clean loops can't farm it.
  const earnsBonus =
    input.miles >= CLEAN_BONUS_MIN_MILES && active.length === 0 && creditedMiles > 0 && !input.loopRepeat;
  const cleanBonus: 0 | 25 = earnsBonus ? CLEAN_BONUS : 0;
  const gains = roundTo((milePoints + cleanBonus) * streakMult);

  const seen: Partial<Record<EventType, number>> = {};
  let penalties = 0;
  let rating = 0;
  const events = active.map((e) => {
    const repeatIndex = seen[e.type] ?? 0;
    seen[e.type] = repeatIndex + 1;
    const penalty = roundTo(eventPenalty(e, repeatIndex) * shortScale);
    penalties += penalty;
    rating += ratingPenalty(e);
    return { id: e.id, penalty };
  });

  return {
    scored: true,
    safeMiles,
    creditedMiles,
    milePoints,
    cleanBonus,
    ...base,
    gains,
    events,
    penalties,
    net: gains - penalties,
    ratingPenalty: rating,
    activeEventCount: active.length,
  };
}
