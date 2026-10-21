// The Safety Rating, its category scores and the drive score, judged per opportunity: hard brakes
// per slowdown, hard starts per speed-up, sharp turns per turn, the share of driving time with a
// known limit spent over the speeding line, weighted by how far over, and phone pickups (each
// weighted by its seconds in hand) per second driven at driving speed. Attention (DashPal) stays
// per watched mile. The window is the last 90 days, recent weeks counting more.
//
// Pure and deterministic. The SQL copy (`private.rating_at` and its helpers) matches it to the digit.
import { isDashcamType, speedingChargedS, type DriveEvent, type Tier } from './drive';
import { clamp, roundTo } from './num';

/** The Safety Rating's window, in days. */
export const RATING_WINDOW_DAYS = 90;
/** A drive's weight halves every this many days. */
export const RATING_HALF_LIFE_DAYS = 21;
/** 2^(−d / 21) for d = 0..89, rounded half up to 4 dp. A literal, so the SQL copy is bit-identical. */
export const RECENCY_WEIGHT: readonly number[] = [
  1, 0.9675, 0.9361, 0.9057, 0.8763, 0.8479, 0.8203, 0.7937, 0.7679, 0.743, 0.7189, 0.6955, 0.673, 0.6511, 0.63, 0.6095, 0.5897, 0.5706,
  0.552, 0.5341, 0.5168, 0.5, 0.4838, 0.4681, 0.4529, 0.4382, 0.4239, 0.4102, 0.3969, 0.384, 0.3715, 0.3594, 0.3478, 0.3365, 0.3256, 0.315,
  0.3048, 0.2949, 0.2853, 0.276, 0.2671, 0.2584, 0.25, 0.2419, 0.234, 0.2264, 0.2191, 0.212, 0.2051, 0.1984, 0.192, 0.1857, 0.1797, 0.1739,
  0.1682, 0.1628, 0.1575, 0.1524, 0.1474, 0.1426, 0.138, 0.1335, 0.1292, 0.125, 0.1209, 0.117, 0.1132, 0.1095, 0.106, 0.1025, 0.0992, 0.096,
  0.0929, 0.0899, 0.0869, 0.0841, 0.0814, 0.0787, 0.0762, 0.0737, 0.0713, 0.069, 0.0668, 0.0646, 0.0625, 0.0605, 0.0585, 0.0566, 0.0548, 0.053,
];

/** The weight of a drive `ageDays` old (whole days, floored); 0 outside the window or in the future. */
export function recencyWeight(ageDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  const d = Math.floor(ageDays);
  return d >= 0 && d < RATING_WINDOW_DAYS ? (RECENCY_WEIGHT[d] ?? 0) : 0;
}

/** Raw miles in the window needed to be ranked. */
export const RANKED_MIN_MILES = 10;
/** What typical driving scores on every category: the curve's anchor. */
export const TYPICAL_SCORE = 85;

/** The six categories, in radar order, clockwise from the top. */
export type AxisKey = 'acceleration' | 'braking' | 'turning' | 'attention' | 'phone' | 'speed';
export const AXES: readonly AxisKey[] = ['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed'];
/** The categories judged per opportunity (Attention is per watched mile). */
export type RateAxis = Exclude<AxisKey, 'attention'>;
export const RATE_AXES: readonly RateAxis[] = ['acceleration', 'braking', 'turning', 'phone', 'speed'];
/** The category that needs a paired DashPal: no score without watched miles. */
export const DASHPAL_AXIS: AxisKey = 'attention';
/** What each category weighs in the Safety Rating and the drive score: Speed and Phone use count double. */
export const AXIS_WEIGHT: Readonly<Record<AxisKey, number>> = { speed: 2, phone: 2, braking: 1, acceleration: 1, turning: 1, attention: 1 };

/**
 * The category an event counts toward; null for any other type (a stored type no score reads).
 * The SQL `private.axis_of` is the same switch.
 */
export function axisOf(type: string): AxisKey | null {
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
      return 'phone';
    case 'eyes_off':
    case 'drowsy':
      return 'attention';
    default:
      return null;
  }
}

/** Typical rate per opportunity, the prior's pseudo-opportunities, and one drive's opportunity floor. */
export interface Baseline {
  rate: number;
  prior: number;
  floor: number;
}
export const BASELINE: Readonly<Record<RateAxis, Baseline>> = {
  /** 1 hard brake per 100 slowdowns. */
  braking: { rate: 0.01, prior: 60, floor: 10 },
  /** 1 hard start per 125 speed-ups. */
  acceleration: { rate: 0.008, prior: 60, floor: 10 },
  /** 1 sharp turn per 125 turns. */
  turning: { rate: 0.008, prior: 60, floor: 10 },
  /** 4 weighted seconds over the line per 100 s with a limit. */
  speed: { rate: 0.04, prior: 3600, floor: 600 },
  /** 4 weighted phone seconds (`PHONE_PICKUP_WEIGHT_S` + in hand, per pickup) per 100 s at driving speed. */
  phone: { rate: 0.04, prior: 3600, floor: 600 },
};
/** What a phone pickup weighs on top of its seconds in hand: the reach and the look away. */
export const PHONE_PICKUP_WEIGHT_S = 10;
/** A hard brake, start or turn: minor 1, severe 2 (a two-level type reads anything below severe as minor). */
export const HARD_EVENT_WEIGHT: Readonly<Record<'minor' | 'severe', number>> = { minor: 1, severe: 2 };
/** Speeding: the over-the-line reference (5 mph over weighs 1 per charged second)… */
export const OVER_REF_MPH = 5;
/** …and the cap on the mean over. */
export const OVER_CAP_MPH = 40;
/** An older speeding event without `overMphS`: its tier's assumed mean mph over the line. */
export const LEGACY_MEAN_OVER_MPH: Readonly<Record<Tier, number>> = { minor: 2, moderate: 6.5, severe: 12 };
/** Attention (DashPal): its events' penalty per watched mile on `categoryScore`. */
export const ATTENTION_PENALTY = { eyes_off: 40, drowsy: 50 } as const;
/** The window's watched-miles floor for Attention. */
export const ATTENTION_MIN_MILES = 10;
/** One drive's watched-miles floor for Attention. */
export const DRIVE_ATTENTION_MIN_MILES = 3;

/** Per-drive opportunity counters, as stored and uploaded. Whole numbers. */
export interface Exposure {
  /** Drops of 12 mph or more from a peak to a trough. */
  slowdowns: number;
  /** Rises of 12 mph or more from a trough to a peak. */
  speedups: number;
  /** Heading changes of 60° or more within 20 s at 10 mph or more. */
  turns: number;
  /** Seconds with a known, actionable limit while driving at 10 mph or more. */
  limitS: number;
  /** Seconds moving at 5 mph or more. */
  movingS: number;
  /**
   * Seconds at driving speed (10 mph or more on a trusted GPS speed) with the motion sensors read:
   * Phone use's opportunities. 0 on a drive recorded before phone use was tracked.
   */
  phoneS: number;
}
export const EXPOSURE_MAX = { count: 20_000, seconds: 43_200 } as const;

const wholeIn = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.floor(Math.max(0, v))) : 0;

/**
 * Clamped, floored, finite whole numbers (counts ≤ 20 000, seconds ≤ 43 200), with limitS ≤ movingS
 * and phoneS ≤ movingS. A missing counter reads 0.
 */
export function clampExposure(e: Partial<Exposure> | null | undefined): Exposure {
  const movingS = wholeIn(e?.movingS, EXPOSURE_MAX.seconds);
  return {
    slowdowns: wholeIn(e?.slowdowns, EXPOSURE_MAX.count),
    speedups: wholeIn(e?.speedups, EXPOSURE_MAX.count),
    turns: wholeIn(e?.turns, EXPOSURE_MAX.count),
    limitS: Math.min(wholeIn(e?.limitS, EXPOSURE_MAX.seconds), movingS),
    movingS,
    phoneS: Math.min(wholeIn(e?.phoneS, EXPOSURE_MAX.seconds), movingS),
  };
}

/**
 * The knots of `estimateExposure`: [average mph, slowdowns / mi, speed-ups / mi, turns / mi, limit
 * share of the duration, moving share of the duration]. UNVERIFIED against real drives: tune with
 * `BASELINE` after the pilot. The SQL `private.estimate_exposure` holds the same table.
 */
export const ESTIMATE_KNOTS: readonly (readonly [number, number, number, number, number, number])[] = [
  [10, 3.0, 3.0, 2.0, 0.45, 0.55],
  [20, 2.0, 2.0, 1.2, 0.6, 0.75],
  [35, 0.9, 0.9, 0.5, 0.7, 0.9],
  [50, 0.3, 0.3, 0.15, 0.8, 0.97],
];

/** The knots' value in column `col` at average speed `avg`: piecewise-linear, clamped at the ends. */
function knotAt(avg: number, col: 1 | 2 | 3 | 4 | 5): number {
  const first = ESTIMATE_KNOTS[0]!;
  const last = ESTIMATE_KNOTS[ESTIMATE_KNOTS.length - 1]!;
  if (avg <= first[0]) return first[col];
  if (avg >= last[0]) return last[col];
  for (let i = 1; i < ESTIMATE_KNOTS.length; i += 1) {
    const hi = ESTIMATE_KNOTS[i]!;
    if (avg <= hi[0]) {
      const lo = ESTIMATE_KNOTS[i - 1]!;
      const t = (avg - lo[0]) / (hi[0] - lo[0]);
      return lo[col] + t * (hi[col] - lo[col]);
    }
  }
  return last[col];
}

/**
 * The counters for a drive recorded before they existed, from its miles and duration: the average
 * speed picks the per-mile counts and the shares of the duration (`ESTIMATE_KNOTS`), each rounded
 * half up, then clamped (`clampExposure`). phoneS is 0: such a drive was not watched for phone use.
 */
export function estimateExposure(miles: number, durationS: number): Exposure {
  const mi = Number.isFinite(miles) ? Math.max(0, miles) : 0;
  const s = Number.isFinite(durationS) ? Math.max(0, durationS) : 0;
  const avg = s > 0 ? mi / (s / 3600) : 0;
  return clampExposure({
    slowdowns: Math.round(mi * knotAt(avg, 1)),
    speedups: Math.round(mi * knotAt(avg, 2)),
    turns: Math.round(mi * knotAt(avg, 3)),
    limitS: Math.round(s * knotAt(avg, 4)),
    movingS: Math.round(s * knotAt(avg, 5)),
    phoneS: 0,
  });
}

/**
 * A speeding event's weight: charged seconds `n = max(1, durationS − SPEEDING_GRACE_S)` × (x · √x),
 * where x = min(OVER_CAP_MPH, max(0, meanOver)) / OVER_REF_MPH and meanOver = overMphS / n (or the
 * tier's LEGACY_MEAN_OVER_MPH without a finite overMphS). Written as x * Math.sqrt(x), never
 * x ** 1.5, so the SQL copy (x * sqrt(x)) is bit-identical.
 */
export function speedingWeight(durationS: number, overMphS: number | null, tier: Tier): number {
  const n = speedingChargedS(durationS);
  const meanOver = overMphS !== null && Number.isFinite(overMphS) ? overMphS / n : LEGACY_MEAN_OVER_MPH[tier];
  const x = Math.min(OVER_CAP_MPH, Math.max(0, meanOver)) / OVER_REF_MPH;
  return n * x * Math.sqrt(x);
}

/** The event's measured `overMphS`, when it is a finite number. */
function overMphSOf(e: DriveEvent): number | null {
  const m: unknown = e.measured;
  if (typeof m !== 'object' || m === null) return null;
  const v = (m as Record<string, unknown>).overMphS;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A phone pickup's seconds in hand as Phone use reads them: its `durationS`, clamped to
 * 0..EXPOSURE_MAX.seconds (43 200); a non-finite one reads 0.
 */
export function phoneInHandS(durationS: number): number {
  return Number.isFinite(durationS) ? clamp(durationS, 0, EXPOSURE_MAX.seconds) : 0;
}

/**
 * The weight an active event adds to its category: HARD_EVENT_WEIGHT, speedingWeight, a phone
 * pickup's PHONE_PICKUP_WEIGHT_S + its seconds in hand (`phoneInHandS`), or 0 (removed, DashPal).
 */
export function eventWeight(e: DriveEvent): number {
  if (e.status === 'removed') return 0;
  switch (e.type) {
    case 'hard_brake':
    case 'hard_accel':
    case 'hard_corner':
      return HARD_EVENT_WEIGHT[e.tier === 'severe' ? 'severe' : 'minor'];
    case 'speeding':
      return speedingWeight(e.durationS, overMphSOf(e), e.tier);
    case 'phone_pickup':
      return PHONE_PICKUP_WEIGHT_S + phoneInHandS(e.durationS);
    default:
      return 0;
  }
}

/** One drive's share of a category: the events' weight, their count and the opportunities. */
export interface AxisLoad {
  weight: number;
  count: number;
  opportunities: number;
}
export interface DriveLoads {
  rates: Record<RateAxis, AxisLoad>;
  /** Σ ATTENTION_PENALTY of the active eyes_off / drowsy events. */
  attentionPenalty: number;
}

const byStart = (x: DriveEvent, y: DriveEvent): number => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Over the drive's ACTIVE events (sorted by startedAt then id, so sums are order-stable) and its
 * exposure: braking/acceleration/turning weight and count; speed weight and count = Σ charged
 * seconds; phone weight and count = Σ seconds in hand; opportunities = slowdowns / speedups / turns
 * / phoneS / limitS. Attention = Σ ATTENTION_PENALTY of eyes_off / drowsy.
 */
export function driveLoads(events: readonly DriveEvent[], exposure: Exposure): DriveLoads {
  const rates: Record<RateAxis, AxisLoad> = {
    acceleration: { weight: 0, count: 0, opportunities: exposure.speedups },
    braking: { weight: 0, count: 0, opportunities: exposure.slowdowns },
    turning: { weight: 0, count: 0, opportunities: exposure.turns },
    phone: { weight: 0, count: 0, opportunities: exposure.phoneS },
    speed: { weight: 0, count: 0, opportunities: exposure.limitS },
  };
  let attentionPenalty = 0;
  for (const e of events.filter((x) => x.status !== 'removed').sort(byStart)) {
    if (isDashcamType(e.type)) {
      attentionPenalty += ATTENTION_PENALTY[e.type];
      continue;
    }
    const axis = axisOf(e.type);
    if (axis === null || axis === 'attention') continue;
    const load = rates[axis];
    load.weight += eventWeight(e);
    load.count += axis === 'speed' ? speedingChargedS(e.durationS) : axis === 'phone' ? phoneInHandS(e.durationS) : 1;
  }
  return { rates, attentionPenalty };
}

/** The curve: 100 / (1 + (rate / baseline) × (100 − TYPICAL_SCORE) / TYPICAL_SCORE). rate ≤ 0 → 100; never 0. */
export function rateScore(rate: number, baseline: number): number {
  if (!(Number.isFinite(rate) && rate > 0)) return 100;
  return 100 / (1 + (rate / baseline) * ((100 - TYPICAL_SCORE) / TYPICAL_SCORE));
}

/** What the rating reads of one drive. `events` are its events (removed ones may be passed; they weigh 0). */
export interface RatingDrive {
  /** The drive's id, for a stable order among drives that start at the same moment (optional). */
  id?: string;
  /** epoch ms */
  startedAt: number;
  miles: number;
  watchedMiles: number;
  exposure: Exposure;
  events: readonly DriveEvent[];
}
/** 0–100 per category, unrounded; null where there is no score. */
export type AxisScores = Record<AxisKey, number | null>;
export interface RatingResult {
  /** 0–100, 1 dp; null with no miles in the window. */
  rating: number | null;
  ranked: boolean;
  /**
   * Unrounded per category; Attention null without watched miles; Phone use null without phone
   * seconds or pickups in the window; all null with no miles.
   */
  scores: AxisScores;
  /** Raw miles in the window. */
  miles: number;
}
/** A rating and whether it is ranked, as the screens read it. */
export interface SafetyRating {
  /** 0–100, 1 decimal; null with no miles. */
  rating: number | null;
  ranked: boolean;
}

const DAY_MS = 86_400_000;
const NO_SCORES: Readonly<AxisScores> = { acceleration: null, braking: null, turning: null, attention: null, phone: null, speed: null };

const driveOrder = (x: RatingDrive, y: RatingDrive): number => {
  if (x.startedAt !== y.startedAt) return x.startedAt - y.startedAt;
  const a = x.id ?? '';
  const b = y.id ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The Safety Rating as of `at` (epoch ms): over the drives started in (at − 90 d, at], each weighted
 * by recencyWeight(floor((at − startedAt) / 86 400 000)). Per rate axis:
 *   W = Σ w·weight, O = Σ w·max(opportunities, count), r = (W + prior·rate) / (O + prior), score = rateScore(r, rate).
 * Phone use is null (not tracked, no score) when its O is 0: no phone seconds and no pickups in the
 * window, as on every drive recorded before phone use was tracked.
 * Attention: P = Σ w·attentionPenalty, M = Σ w·watchedMiles; categoryScore(P, M, ATTENTION_MIN_MILES) when M > 0.
 * Rating = clamp(weightedScore(scores), 0, 100) rounded half up to 1 dp; ranked = miles ≥ RANKED_MIN_MILES.
 * Drives are summed in (startedAt, id) order. Pure; the SQL `private.rating_at` matches it to the digit.
 */
export function ratingAt(drives: readonly RatingDrive[], at: number): RatingResult {
  const W: Record<RateAxis, number> = { acceleration: 0, braking: 0, turning: 0, phone: 0, speed: 0 };
  const O: Record<RateAxis, number> = { acceleration: 0, braking: 0, turning: 0, phone: 0, speed: 0 };
  let miles = 0;
  let attP = 0;
  let attM = 0;
  const inWindow = drives
    .filter((d) => Number.isFinite(d.startedAt) && d.startedAt <= at && d.startedAt > at - RATING_WINDOW_DAYS * DAY_MS)
    .sort(driveOrder);
  for (const d of inWindow) {
    const w = recencyWeight(Math.floor((at - d.startedAt) / DAY_MS));
    miles += Number.isFinite(d.miles) ? Math.max(0, d.miles) : 0;
    const loads = driveLoads(d.events, clampExposure(d.exposure));
    for (const axis of RATE_AXES) {
      const l = loads.rates[axis];
      W[axis] += w * l.weight;
      O[axis] += w * Math.max(l.opportunities, l.count);
    }
    attP += w * loads.attentionPenalty;
    attM += w * (Number.isFinite(d.watchedMiles) ? Math.max(0, d.watchedMiles) : 0);
  }
  if (!(miles > 0)) return { rating: null, ranked: false, scores: { ...NO_SCORES }, miles: 0 };
  const rateOf = (axis: RateAxis): number => {
    const b = BASELINE[axis];
    return rateScore((W[axis] + b.prior * b.rate) / (O[axis] + b.prior), b.rate);
  };
  const scores: AxisScores = {
    acceleration: rateOf('acceleration'),
    braking: rateOf('braking'),
    turning: rateOf('turning'),
    attention: attM > 0 ? categoryScore(attP, attM, ATTENTION_MIN_MILES) : null,
    phone: O.phone > 0 ? rateOf('phone') : null,
    speed: rateOf('speed'),
  };
  const mean = weightedScore(scores);
  return {
    rating: mean === null ? null : roundTo(clamp(mean, 0, 100), 1),
    ranked: miles >= RANKED_MIN_MILES,
    scores,
    miles,
  };
}

/**
 * One drive's score out of 100: per rate axis r = weight / max(opportunities, floor, count) (no
 * prior), Attention over max(watchedMiles, DRIVE_ATTENTION_MIN_MILES) when watched, Phone use only
 * when the drive has phone seconds or a pickup; the weighted mean, a whole number. Null with no
 * miles. Shown on the recap and the share card.
 */
export function driveScore(events: readonly DriveEvent[], miles: number, watchedMiles: number, exposure: Exposure): number | null {
  if (!(miles > 0)) return null;
  const loads = driveLoads(events, clampExposure(exposure));
  const rateOf = (axis: RateAxis): number => {
    const l = loads.rates[axis];
    const b = BASELINE[axis];
    return rateScore(l.weight / Math.max(l.opportunities, b.floor, l.count), b.rate);
  };
  const phone = loads.rates.phone;
  const mean = weightedScore({
    acceleration: rateOf('acceleration'),
    braking: rateOf('braking'),
    turning: rateOf('turning'),
    attention: watchedMiles > 0 ? categoryScore(loads.attentionPenalty, watchedMiles, DRIVE_ATTENTION_MIN_MILES) : null,
    phone: phone.opportunities > 0 || phone.count > 0 ? rateOf('phone') : null,
    speed: rateOf('speed'),
  });
  return mean === null ? null : roundTo(clamp(mean, 0, 100));
}

/**
 * The weighted mean of the scored categories (`AXIS_WEIGHT`: Speed and Phone use double, the rest
 * single, a null category left out of both sums), summed in radar order; null when none is scored.
 * Unrounded.
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

/** Attention's curve scale: the score is 50 when the penalty per watched mile reaches this. */
export const CATEGORY_K = 16;

/**
 * Attention's score, 0–100 (never 0), from its penalty over `miles` floored at `floorMiles`:
 *
 *   100 / (1 + (penalty / max(miles, floorMiles)) / CATEGORY_K)
 *
 * Unrounded. The SQL `private.category_score` does the same arithmetic. A non-finite or negative
 * penalty reads as 0; non-finite miles as 0 (so the floor).
 */
export function categoryScore(penalty: number, miles: number, floorMiles: number): number {
  const p = Number.isFinite(penalty) ? Math.max(0, penalty) : 0;
  const m = Math.max(Number.isFinite(miles) ? miles : 0, floorMiles);
  return 100 / (1 + p / m / CATEGORY_K);
}

/** The miles DashPal watched on a drive: its miles × the share of its moving seconds the dashcam covered. */
export function watchedMiles(miles: number, movingS: number, coveredS: number): number {
  if (!(miles > 0) || !(movingS > 0) || !(coveredS > 0)) return 0;
  return (miles * Math.min(coveredS, movingS)) / movingS;
}
