// The Safety Rating, its category scores and the drive score, judged per opportunity: hard brakes
// per slowdown, hard starts per speed-up and sharp turns per turn (each weighted by its peak force
// over its type's threshold), the share of driving time with a known limit spent over the speeding
// line (every second of every episode, weighted by how far over relative to the limit), phone
// pickups (each weighted by its seconds in hand and the speed it was driven at) per second driven at
// driving speed, and DashPal's eyes-off and drowsy episodes (each weighted by its speed and its
// length) per second the dashcam watched. Every event that qualifies weighs something, and more for
// a more severe one; dividing by the drive's own opportunities means one event marks a long drive
// down less than a short one. The categories combine as a weighted harmonic mean, so a weak category
// pulls the total down harder than a strong one lifts it. The window is the last 90 days, recent
// weeks counting more.
//
// Pure and deterministic. The SQL copy (`private.rating_at` and its helpers) matches it to the digit.
import { isDashcamType, speedingChargedS, type DriveEvent, type Tier } from './drive';
import { clamp, roundTo } from './num';
import { HARD_ACCEL_G, HARD_BRAKE_G, HARD_CORNER_G } from './thresholds';

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
/** The categories judged per opportunity: every one of them, in radar order. */
export type RateAxis = AxisKey;
export const RATE_AXES: readonly RateAxis[] = AXES;
/** The category that needs a paired DashPal: no score without watched seconds. */
export const DASHPAL_AXIS: AxisKey = 'attention';
/**
 * What each category weighs in the Safety Rating and the drive score: Phone use, Speed and Attention
 * 3, Braking 2, Acceleration and Turning 1.
 */
export const AXIS_WEIGHT: Readonly<Record<AxisKey, number>> = { speed: 3, phone: 3, attention: 3, braking: 2, acceleration: 1, turning: 1 };

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
  /**
   * 0.024 Attention weight per watched second: one 5 s eyes-off episode at 30 mph (weight 40) about
   * every 28 minutes of watched driving.
   */
  attention: { rate: 0.024, prior: 3600, floor: 600 },
};
/** What a phone pickup weighs on top of its seconds in hand: the reach and the look away. */
export const PHONE_PICKUP_WEIGHT_S = 10;
/**
 * The speed a phone pickup's or a DashPal event's weight is judged at: `speedFactor` is the speed
 * over `refMph` (30 mph weighs 1), read between `minMph` and `maxMph` (so 1/3 to 8/3). The faster the
 * car, the farther it goes while the driver is not watching the road.
 */
export const SPEED_FACTOR = { minMph: 10, refMph: 30, maxMph: 80 } as const;
/**
 * A hard brake, start or turn without a measured peak (an event an older app recorded): minor 1,
 * severe 2 (a two-level type reads anything below severe as minor).
 */
export const HARD_EVENT_WEIGHT: Readonly<Record<'minor' | 'severe', number>> = { minor: 1, severe: 2 };
/** A hard event's weight never passes this (its peak at twice its threshold). */
export const HARD_EVENT_WEIGHT_MAX = 4;
/** Each hard event type's threshold, g: its weight is (peak / this)². */
export const HARD_EVENT_MIN_G: Readonly<Record<'hard_brake' | 'hard_accel' | 'hard_corner', number>> = {
  hard_brake: HARD_BRAKE_G.minor,
  hard_accel: HARD_ACCEL_G.minor,
  hard_corner: HARD_CORNER_G.minor,
};
/**
 * Speeding: the amount over the line that weighs 1 per charged second is the posted limit over this
 * (35 mph → 5, 25 → 3.57, 65 → 9.29)…
 */
export const OVER_REF_LIMIT_DIVISOR = 7;
/** …or this many mph when the event has no usable limit (the same as a 35 mph limit)… */
export const OVER_REF_MPH = 5;
/** …and the cap on the mean over as a multiple of that reference (25 per second at most). */
export const OVER_X_CAP = 5;
/** An older speeding event without `overMphS`: its tier's assumed mean mph over the line. */
export const LEGACY_MEAN_OVER_MPH: Readonly<Record<Tier, number>> = { minor: 2, moderate: 6.5, severe: 12 };
/**
 * Attention (DashPal): each event's base weight, before its speed (`speedFactor`) and its length
 * (`ATTENTION_REF_S`).
 */
export const ATTENTION_PENALTY = { eyes_off: 40, drowsy: 80 } as const;
/** A DashPal episode this long (s) or shorter weighs its base; longer weighs in proportion, up to `ATTENTION_LENGTH_MAX` times. */
export const ATTENTION_REF_S = 5;
export const ATTENTION_LENGTH_MAX = 3;

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

/** A posted limit under this (mph) is no usable limit for the Speed weight: no real road posts one. */
export const OVER_REF_MIN_LIMIT_MPH = 1;

/**
 * The mph over the speeding line that weighs 1 per charged second at a posted limit of `limitMph`:
 * limitMph / OVER_REF_LIMIT_DIVISOR (35 → 5, 25 → 3.57, 65 → 9.29); OVER_REF_MPH (5) without a
 * finite limit of at least OVER_REF_MIN_LIMIT_MPH (so a stray near-zero limit can never blow the
 * weight up, here or in the SQL copy).
 */
export function speedingRefMph(limitMph: number | null): number {
  return limitMph !== null && Number.isFinite(limitMph) && limitMph >= OVER_REF_MIN_LIMIT_MPH ? limitMph / OVER_REF_LIMIT_DIVISOR : OVER_REF_MPH;
}

/**
 * A speeding event's weight: its seconds over the line `n = max(1, durationS)` (every one, the first
 * included) × x², where x = min(OVER_X_CAP, max(0, meanOver) / speedingRefMph(limitMph)) and
 * meanOver = overMphS / n (or the tier's LEGACY_MEAN_OVER_MPH without a finite overMphS): longer and
 * further over weighs more, and the same mph over weighs more at a lower limit. At 35 mph a second
 * 5 mph over the line weighs 1 and 10 mph over 4; at 25 mph 5 mph over weighs about 1.96. Written
 * n * x * x, as the SQL copy is, so the two are bit-identical.
 */
export function speedingWeight(durationS: number, overMphS: number | null, tier: Tier, limitMph: number | null = null): number {
  const n = speedingChargedS(durationS);
  const meanOver = overMphS !== null && Number.isFinite(overMphS) ? overMphS / n : LEGACY_MEAN_OVER_MPH[tier];
  const x = Math.min(OVER_X_CAP, Math.max(0, meanOver) / speedingRefMph(limitMph));
  return n * x * x;
}

/** The event's measured `key`, when it is a finite number. */
function measuredOf(e: DriveEvent, key: 'overMphS' | 'peakG' | 'speedMph' | 'maxSpeedMph' | 'limitMph'): number | null {
  const m: unknown = e.measured;
  if (typeof m !== 'object' || m === null) return null;
  const v = (m as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The speed factor at `mph`: min(80, max(10, mph)) / 30 (`SPEED_FACTOR`), so 30 mph is 1, 10 mph or
 * slower 1/3 and 80 mph or faster 8/3; 1 with no speed (null or not finite).
 */
export function speedFactor(mph: number | null): number {
  if (mph === null || !Number.isFinite(mph)) return 1;
  return Math.min(SPEED_FACTOR.maxMph, Math.max(SPEED_FACTOR.minMph, mph)) / SPEED_FACTOR.refMph;
}

/**
 * A hard brake, start or turn's weight: (peakG / its type's threshold)², between 1 and
 * `HARD_EVENT_WEIGHT_MAX` (4): a brake at 0.36 g weighs 1, at 0.45 g 1.5625, at 0.72 g or more 4.
 * Without a finite peak, its tier's `HARD_EVENT_WEIGHT`. Written r * r, as the SQL copy is.
 */
export function hardEventWeight(type: 'hard_brake' | 'hard_accel' | 'hard_corner', tier: Tier, peakG: number | null): number {
  if (peakG === null || !Number.isFinite(peakG)) return HARD_EVENT_WEIGHT[tier === 'severe' ? 'severe' : 'minor'];
  const r = peakG / HARD_EVENT_MIN_G[type];
  return Math.min(HARD_EVENT_WEIGHT_MAX, Math.max(1, r * r));
}

/**
 * A DashPal event's weight on Attention: ATTENTION_PENALTY × speedFactor(its speed) ×
 * min(3, max(1, durationS / 5)), so an episode at 30 mph of 5 s or less weighs its base (eyes off
 * 40, drowsy 80), one at 60 mph twice that, and one of 10 s twice again. 0 for a removed event or
 * any other type. Multiplied left to right, as the SQL copy is.
 */
export function attentionWeight(e: DriveEvent): number {
  if (e.status === 'removed' || !isDashcamType(e.type)) return 0;
  const d = Number.isFinite(e.durationS) ? Math.max(0, e.durationS) : 0;
  const length = Math.min(ATTENTION_LENGTH_MAX, Math.max(1, d / ATTENTION_REF_S));
  return ATTENTION_PENALTY[e.type] * speedFactor(measuredOf(e, 'speedMph')) * length;
}

/**
 * A phone pickup's weight: (PHONE_PICKUP_WEIGHT_S + its seconds in hand) × speedFactor of the
 * highest speed it was driven at (`maxSpeedMph`, else `speedMph`, else 1).
 */
export function phonePickupWeight(e: DriveEvent): number {
  const v = measuredOf(e, 'maxSpeedMph') ?? measuredOf(e, 'speedMph');
  return (PHONE_PICKUP_WEIGHT_S + phoneInHandS(e.durationS)) * speedFactor(v);
}

/**
 * A phone pickup's seconds in hand as Phone use reads them: its `durationS`, clamped to
 * 0..EXPOSURE_MAX.seconds (43 200); a non-finite one reads 0.
 */
export function phoneInHandS(durationS: number): number {
  return Number.isFinite(durationS) ? clamp(durationS, 0, EXPOSURE_MAX.seconds) : 0;
}

/**
 * The weight an active event adds to its category: `hardEventWeight`, `speedingWeight`,
 * `phonePickupWeight`, or 0 (removed; DashPal, whose weight is `attentionWeight`; any other type).
 */
export function eventWeight(e: DriveEvent): number {
  if (e.status === 'removed') return 0;
  switch (e.type) {
    case 'hard_brake':
    case 'hard_accel':
    case 'hard_corner':
      return hardEventWeight(e.type, e.tier, measuredOf(e, 'peakG'));
    case 'speeding':
      return speedingWeight(e.durationS, measuredOf(e, 'overMphS'), e.tier, measuredOf(e, 'limitMph'));
    case 'phone_pickup':
      return phonePickupWeight(e);
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
}

const byStart = (x: DriveEvent, y: DriveEvent): number => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Over the drive's ACTIVE events (sorted by startedAt then id, so sums are order-stable), its
 * exposure and its watched seconds: braking/acceleration/turning weight and count; speed weight and
 * count = Σ seconds over the line; phone weight and count = Σ seconds in hand; Attention weight =
 * Σ `attentionWeight` of eyes_off / drowsy, count 0 (only watched seconds open it); opportunities =
 * slowdowns / speedups / turns / watchedS / phoneS / limitS.
 */
export function driveLoads(events: readonly DriveEvent[], exposure: Exposure, watchedS = 0): DriveLoads {
  const rates: Record<RateAxis, AxisLoad> = {
    acceleration: { weight: 0, count: 0, opportunities: exposure.speedups },
    braking: { weight: 0, count: 0, opportunities: exposure.slowdowns },
    turning: { weight: 0, count: 0, opportunities: exposure.turns },
    attention: { weight: 0, count: 0, opportunities: Number.isFinite(watchedS) ? Math.max(0, watchedS) : 0 },
    phone: { weight: 0, count: 0, opportunities: exposure.phoneS },
    speed: { weight: 0, count: 0, opportunities: exposure.limitS },
  };
  for (const e of events.filter((x) => x.status !== 'removed').sort(byStart)) {
    const axis = axisOf(e.type);
    if (axis === null) continue;
    const load = rates[axis];
    load.weight += axis === 'attention' ? attentionWeight(e) : eventWeight(e);
    load.count += axis === 'speed' ? speedingChargedS(e.durationS) : axis === 'phone' ? phoneInHandS(e.durationS) : axis === 'attention' ? 0 : 1;
  }
  return { rates };
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
  /** The seconds DashPal watched (`watchedSeconds`); 0 without one. */
  watchedS: number;
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
   * Unrounded per category; Attention null without watched seconds; Phone use null without phone
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
 * by recencyWeight(floor((at − startedAt) / 86 400 000)). Per category:
 *   W = Σ w·weight, O = Σ w·max(opportunities, count), r = (W + prior·rate) / (O + prior), score = rateScore(r, rate).
 * Phone use is null (not tracked, no score) when its O is 0: no phone seconds and no pickups in the
 * window, as on every drive recorded before phone use was tracked. Attention is null when its O (the
 * watched seconds) is 0: no DashPal drive in the window.
 * Rating = clamp(weightedScore(scores), 0, 100) rounded half up to 1 dp; ranked = miles ≥ RANKED_MIN_MILES
 * (the miles snapped to 6 dp first, so float drift never drops a 10.00 mi window under the line).
 * Drives are summed in (startedAt, id) order. Pure; the SQL `private.rating_at` matches it to the digit.
 */
export function ratingAt(drives: readonly RatingDrive[], at: number): RatingResult {
  const W: Record<RateAxis, number> = { acceleration: 0, braking: 0, turning: 0, attention: 0, phone: 0, speed: 0 };
  const O: Record<RateAxis, number> = { acceleration: 0, braking: 0, turning: 0, attention: 0, phone: 0, speed: 0 };
  let miles = 0;
  const inWindow = drives
    .filter((d) => Number.isFinite(d.startedAt) && d.startedAt <= at && d.startedAt > at - RATING_WINDOW_DAYS * DAY_MS)
    .sort(driveOrder);
  for (const d of inWindow) {
    const w = recencyWeight(Math.floor((at - d.startedAt) / DAY_MS));
    miles += Number.isFinite(d.miles) ? Math.max(0, d.miles) : 0;
    const loads = driveLoads(d.events, clampExposure(d.exposure), d.watchedS);
    for (const axis of RATE_AXES) {
      const l = loads.rates[axis];
      W[axis] += w * l.weight;
      O[axis] += w * Math.max(l.opportunities, l.count);
    }
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
    attention: O.attention > 0 ? rateOf('attention') : null,
    phone: O.phone > 0 ? rateOf('phone') : null,
    speed: rateOf('speed'),
  };
  const mean = weightedScore(scores);
  return {
    rating: mean === null ? null : roundTo(clamp(mean, 0, 100), 1),
    // Compared free of binary drift, as the SQL's exact numeric sum is: 0.10 + 8.04 + 1.86 adds up
    // to 9.999999999999998 in floats, and the server ranks that window at 10.00 mi.
    ranked: roundTo(miles, 6) >= RANKED_MIN_MILES,
    scores,
    miles,
  };
}


/**
 * One drive's score out of 100: per category r = weight / max(opportunities, floor, count) (no
 * prior), Attention only when DashPal watched (`watchedS` > 0), Phone use only when the drive has
 * phone seconds or a pickup; the weighted harmonic mean (`weightedScore`), a whole number. Null with
 * no miles. Shown on the recap and the share card.
 */
export function driveScore(events: readonly DriveEvent[], miles: number, watchedS: number, exposure: Exposure): number | null {
  if (!(miles > 0)) return null;
  const loads = driveLoads(events, clampExposure(exposure), watchedS);
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
    attention: loads.rates.attention.opportunities > 0 ? rateOf('attention') : null,
    phone: phone.opportunities > 0 || phone.count > 0 ? rateOf('phone') : null,
    speed: rateOf('speed'),
  });
  return mean === null ? null : roundTo(clamp(mean, 0, 100));
}

/**
 * The weighted harmonic mean of the scored categories (`AXIS_WEIGHT`), Σ w / Σ (w / s), each sum
 * added in radar order; a null, non-finite or non-positive category is left out of both sums. Each
 * score is 100 / (1 + x), so this is 100 / (1 + the weighted mean of each category's excess risk x):
 * a weak category pulls the total down harder than a strong one lifts it. Null when none is scored.
 * Unrounded. The SQL `private.weighted_score` adds the same terms in the same order.
 */
export function weightedScore(scores: Readonly<Partial<Record<AxisKey, number | null>>>): number | null {
  let weight = 0;
  let inverse = 0;
  for (const axis of AXES) {
    const s = scores[axis];
    if (typeof s !== 'number' || !Number.isFinite(s) || !(s > 0)) continue;
    weight += AXIS_WEIGHT[axis];
    inverse += AXIS_WEIGHT[axis] / s;
  }
  return weight > 0 ? weight / inverse : null;
}

/** The miles DashPal watched on a drive: its miles × the share of its moving seconds the dashcam covered. */
export function watchedMiles(miles: number, movingS: number, coveredS: number): number {
  if (!(miles > 0) || !(movingS > 0) || !(coveredS > 0)) return 0;
  return (miles * Math.min(coveredS, movingS)) / movingS;
}

/**
 * The seconds DashPal watched on a drive, Attention's opportunities: its covered seconds held to its
 * moving seconds, min(coveredS, movingS), on the same terms that give it watched miles (miles, moving
 * and covered seconds all above 0); 0 otherwise.
 */
export function watchedSeconds(miles: number, movingS: number, coveredS: number): number {
  if (!(miles > 0) || !(movingS > 0) || !(coveredS > 0)) return 0;
  return Math.min(coveredS, movingS);
}
