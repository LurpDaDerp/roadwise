// v3 points for one drive (product spec v3 "Points per drive", plan §2).
//
//   Drive points = G × M_gain − P × S_short
//
// Pure and deterministic: no clock, no randomness, no imports outside this package.
import { clamp, roundTo } from './num';
import {
  DASHCAM_DROWSY_GAP_S,
  DASHCAM_EYES_OFF_GAP_S,
  DASHCAM_MIN_COVERAGE,
  DASHCAM_MIN_MOVING_S,
  DASHCAM_MIN_MPH,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  SPEEDING_GRACE_S,
} from './thresholds';

export const SCORING_VERSION = 6;

export type EventType =
  | 'speeding'
  | 'hard_brake'
  | 'hard_accel'
  | 'hard_corner'
  | 'phone_pickup'
  | 'phone_handling'
  | 'eyes_off'
  | 'drowsy';

/**
 * The event types only the DashPal dashcam reports (eyes off the road with no return, eyes closed):
 * severe only. They cost points like any event, but never count toward the Safety Rating, the
 * clean-drive check or `activeEventCount`.
 */
export const DASHCAM_EVENT_TYPES = ['eyes_off', 'drowsy'] as const satisfies readonly EventType[];
export type DashcamEventType = (typeof DASHCAM_EVENT_TYPES)[number];

export const isDashcamType = (type: EventType): type is DashcamEventType =>
  (DASHCAM_EVENT_TYPES as readonly EventType[]).includes(type);

/** Colour: minor = yellow, moderate = orange, severe = red. */
export type Tier = 'minor' | 'moderate' | 'severe';

export type Zone = 'school' | 'construction';

/**
 * What the detector measured, as far as scoring reads it. Any other key the detector recorded
 * (limit, peak g, mount, source) travels with it untouched. Every value is re-checked when read:
 * a missing, non-numeric or non-finite one reads as absent.
 */
export type DriveEventMeasured = {
  /** phone_pickup: the GPS speed at the pickup, mph. Read for the phone speed multiplier only when `maxSpeedMph` is absent. */
  speedMph?: number;
  /** phone_pickup, phone_handling: the highest trusted GPS speed during the phone-use episode, mph. */
  maxSpeedMph?: number;
  /**
   * speeding: the sum, over the over-the-line rows AFTER the first `SPEEDING_GRACE_S`, of
   * (row speed − (L + T)) in mph, 1 dp. Absent on an event an older app recorded: it is then priced
   * by tier and duration (`legacySpeedingPenalty`).
   */
  overMphS?: number;
};

export interface DriveEvent {
  /** uuid from the device */
  id: string;
  type: EventType;
  /**
   * speeding: minor | moderate | severe; harsh: minor | severe; phone_pickup: severe;
   * phone_handling: moderate (≤30 s) | severe (>30 s); eyes_off and drowsy (DashPal): severe.
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
  /** phone_pickup only: 16 points instead of 32 (rating 20 instead of 40), and no speed multiplier. */
  stoppedInTraffic?: boolean;
  /** ×2 penalty. Nothing sets it in v1. */
  zone?: Zone | null;
  /** removed = accepted dispute → excluded from points and rating. */
  status?: 'active' | 'removed';
  /** What the detector measured (`DriveEventMeasured`); the scorer reads it for speeding and phone use. */
  measured?: DriveEventMeasured;
}

/** A finite number from a measured value; null for anything else (the readers clamp the sign). */
const measuredNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const measuredOf = (e: DriveEvent, key: keyof DriveEventMeasured): number | null => {
  const m: unknown = e.measured;
  if (typeof m !== 'object' || m === null) return null;
  return measuredNumber((m as Record<string, unknown>)[key]);
};

/**
 * The points an event costs, per type and tier. Two-level types read anything below severe as minor.
 * Speeding's tier prices are the legacy formula only (`legacySpeedingPenalty`): an event with a
 * measured `overMphS` is priced by `speedingCost` instead. Phone use is multiplied by
 * `phoneSpeedMult`.
 */
export const BASE_PENALTY = {
  speeding: { minor: 12, moderate: 32, severe: 80 },
  hard_brake: { minor: 8, severe: 20 },
  hard_accel: { minor: 12, severe: 24 },
  hard_corner: { minor: 8, severe: 20 },
  phone_pickup: 32,
  phone_pickup_stopped: 16,
  phone_handling_per_unit: 8,
  eyes_off: 32,
  drowsy: 40,
} as const;

/**
 * What an event adds to the Safety Rating's penalty sum, per type and tier: its own scale, apart
 * from the points (`BASE_PENALTY`), so the rating means the same however generous points are.
 */
export const RATING_PENALTY = {
  speeding: { minor: 15, moderate: 40, severe: 100 },
  hard_brake: { minor: 10, severe: 25 },
  hard_accel: { minor: 15, severe: 30 },
  hard_corner: { minor: 10, severe: 25 },
  phone_pickup: 40,
  phone_pickup_stopped: 20,
  phone_handling_per_unit: 10,
  eyes_off: 40,
  drowsy: 50,
} as const;

type PenaltyTable = typeof BASE_PENALTY | typeof RATING_PENALTY;

/** Points per credited safe mile, and the clean-drive bonus (from `CLEAN_BONUS_MIN_MILES`). */
export const POINTS_PER_MILE = 20;
export const CLEAN_BONUS = 50;
export const CLEAN_BONUS_MIN_MILES = 2;

/**
 * The rules a drive earns and is charged under. A drive first scored under an older
 * `SCORING_VERSION` keeps its own rules when it is re-scored (an accepted dispute), so the re-score
 * changes only the disputed event's penalty and never pays the newer rate out as a windfall.
 */
export interface ScoringRules {
  pointsPerMile: number;
  cleanBonus: 25 | 50;
  /** Phone use is multiplied by `phoneSpeedMult`. */
  phoneSpeed: boolean;
}
/** The first `SCORING_VERSION` that earns 20 a mile, a 50 clean bonus and prices phone use by speed. */
export const EARN_RATE_VERSION = 6;
export const LEGACY_POINTS_PER_MILE = 10;
export const LEGACY_CLEAN_BONUS = 25;
export const CURRENT_RULES: Readonly<ScoringRules> = { pointsPerMile: POINTS_PER_MILE, cleanBonus: CLEAN_BONUS, phoneSpeed: true };
export const LEGACY_RULES: Readonly<ScoringRules> = { pointsPerMile: LEGACY_POINTS_PER_MILE, cleanBonus: LEGACY_CLEAN_BONUS, phoneSpeed: false };

/**
 * The rules for a drive first scored under `scoringVersion` (`trips.scoring_version`): the current
 * ones for the current version, a later one, or no version at all; `LEGACY_RULES` under
 * `EARN_RATE_VERSION`. A non-finite version reads as current.
 */
export function scoringRules(scoringVersion?: number | null): Readonly<ScoringRules> {
  return typeof scoringVersion === 'number' && Number.isFinite(scoringVersion) && scoringVersion < EARN_RATE_VERSION ? LEGACY_RULES : CURRENT_RULES;
}
/** Daily cap bands on safe miles: full rate to 40, half rate to 100, nothing beyond. */
export const DAILY_FULL_MILES = 40;
export const DAILY_HALF_MILES = 100;
export const STREAK_STEP = 0.02;
export const STREAK_MULT_CAP = 1.3;
/** A DashPal drive (`dashcamDrive`) multiplies gains by this, on top of the streak multiplier… */
export const DASHCAM_MULT = 1.25;
/** …and the two together never pass this. */
export const MULT_CAP = 1.5;

/** The DashPal seconds a drive reports: moving at 5 mph or more, and of those, watched by the dashcam. */
export interface DashcamSeconds {
  movingS: number;
  coveredS: number;
  /** The phone had every dashcam event persisted within 30 s of the drive's end. */
  synced: boolean;
}

/**
 * Whether a drive is a DashPal drive (×1.25 on gains): synced at the end, at least
 * `DASHCAM_MIN_MOVING_S` moving and the dashcam watching for at least `DASHCAM_MIN_COVERAGE` of
 * it. Integer arithmetic on whole seconds, so the device and the server always agree.
 */
export function dashcamDrive(d: DashcamSeconds | null | undefined): boolean {
  if (!d || d.synced !== true) return false;
  const moving = Number.isFinite(d.movingS) ? Math.max(0, Math.floor(d.movingS)) : 0;
  const covered = Number.isFinite(d.coveredS) ? Math.max(0, Math.floor(d.coveredS)) : 0;
  return moving >= DASHCAM_MIN_MOVING_S && covered * 100 >= Math.round(DASHCAM_MIN_COVERAGE * 100) * moving;
}

/** The part of an event the DashPal limits read: a stored or uploaded event with what was measured. */
export interface DashcamLimitEvent {
  id: string;
  type: EventType;
  /** epoch ms */
  startedAt: number;
  status?: 'active' | 'removed';
  measured?: Readonly<Record<string, unknown>>;
}

const DASHCAM_GAP_MS: Readonly<Record<DashcamEventType, number>> = {
  drowsy: DASHCAM_DROWSY_GAP_S * 1000,
  eyes_off: DASHCAM_EYES_OFF_GAP_S * 1000,
};

/**
 * The uploaded events a drive keeps once the DashPal limits are re-applied over the whole drive:
 * the upload, plus `stored` (the events the drive it merges into already holds; none for a fresh
 * drive). An uploaded DashPal event is dropped, never the whole drive, when its measured speed is
 * missing or under `DASHCAM_MIN_MPH`, or when it starts within `DASHCAM_DROWSY_GAP_S` (drowsy) or
 * `DASHCAM_EYES_OFF_GAP_S` (eyes_off) of a kept event of its type: an active stored one, or an
 * uploaded one kept before it (time order, then id, so the earliest is kept). Stored events always
 * stand and phone events pass untouched. Returns the kept uploads in their input order. Pure.
 */
export function keepDashcamEvents<E extends DashcamLimitEvent>(uploaded: readonly E[], stored: readonly DashcamLimitEvent[] = []): E[] {
  const kept: Record<DashcamEventType, number[]> = { drowsy: [], eyes_off: [] };
  for (const s of stored) {
    if (isDashcamType(s.type) && s.status !== 'removed' && Number.isFinite(s.startedAt)) kept[s.type].push(s.startedAt);
  }
  const dropped = new Set<E>();
  const dashcam = uploaded
    .filter((e) => isDashcamType(e.type))
    .sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const e of dashcam) {
    const type = e.type as DashcamEventType;
    const speed = e.measured?.speedMph;
    const fast = typeof speed === 'number' && Number.isFinite(speed) && speed >= DASHCAM_MIN_MPH;
    if (!fast || !Number.isFinite(e.startedAt) || kept[type].some((t) => Math.abs(e.startedAt - t) < DASHCAM_GAP_MS[type])) {
      dropped.add(e);
      continue;
    }
    kept[type].push(e.startedAt);
  }
  return uploaded.filter((e) => !dropped.has(e));
}

/**
 * T(L): tolerance over the posted limit, mph: 0.175 × (L − 8) rounded, less 1, between 3 and 9
 * (25 → 3, 35 → 4, 45 → 5, 55 → 7, 65 → 9). Fixed at 2 in a school or construction zone. The
 * points line is L + T: speeding is judged, charged and alerted from it.
 */
export function speedTolerance(limitMph: number, zone?: Zone | null): number {
  if (zone) return 2;
  // 0.175 = 7/40; the integer form keeps exact halves (L = 28 → 3.5) exact.
  return clamp(Math.round((7 * (limitMph - 8)) / 40) - 1, 3, 9);
}

/** Tier by how far the speed is beyond L + T: >0 minor, >4 moderate, >9 severe; null if not over. */
export function speedTier(speedMph: number, limitMph: number, zone?: Zone | null): Tier | null {
  const over = roundTo(speedMph - (limitMph + speedTolerance(limitMph, zone)), 6);
  if (over <= 0) return null;
  if (over > 9) return 'severe';
  if (over > 4) return 'moderate';
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

// --- Speeding cost -----------------------------------------------------------------------------

/** Points per charged second and mph over the line, before the growth. */
export const SPEEDING_K = 0.15;
/** The cost compounds by this share for every charged second. */
export const SPEEDING_G = 0.02;
/** The most one speeding event costs before the repeat, zone and short-drive multipliers. */
export const SPEEDING_EVENT_CAP = 300;
/** `overMphS` is read as at most this many mph over per charged second (a bad reading can't buy more than the cap anyway). */
export const SPEEDING_MAX_OVER_MPH = 150;

/**
 * The seconds a speeding event is charged for: every over-the-line row (`durationS`) less the
 * `SPEEDING_GRACE_S` grace rows, never under 1.
 */
export function speedingChargedS(durationS: number): number {
  const d = Number.isFinite(durationS) ? Math.max(0, durationS) : 0;
  return Math.max(1, d - SPEEDING_GRACE_S);
}

/**
 * What a speeding event costs, in points, from its charged seconds `chargedS` (n) and the mph-seconds
 * over the line after the grace `overMphS`:
 *
 *   clamp(round(K × (overMphS / n) × ((1 + G)^n − 1) / G), 1, CAP)
 *
 * The mean over per second sets the rate; the rate compounds at G per second, so staying over costs
 * more and more. 10 s at 3 mph over → 5; 30 s at 3 → 18; 60 s at 3 → 51; 30 s at 10 → 61. Never
 * under 1 (an event always costs something) and never over `SPEEDING_EVENT_CAP`. Repeat, zone and
 * short-drive multipliers apply on top. Pure.
 */
export function speedingCost(chargedS: number, overMphS: number): number {
  const n = Number.isFinite(chargedS) ? Math.max(1, chargedS) : 1;
  const over = Number.isFinite(overMphS) ? clamp(overMphS, 0, n * SPEEDING_MAX_OVER_MPH) : 0;
  const rate = over / n;
  if (!(rate > 0)) return 1;
  const growth = ((1 + SPEEDING_G) ** n - 1) / SPEEDING_G;
  const raw = SPEEDING_K * rate * growth;
  // (1 + G)^n overflows to Infinity for a very long n; the cap is what it means.
  return Number.isFinite(raw) ? clamp(roundTo(raw), 1, SPEEDING_EVENT_CAP) : SPEEDING_EVENT_CAP;
}

/**
 * The points a speeding event recorded without `overMphS` costs (an older app, or a stored event
 * from before measured speeding): its tier's price plus 25% for every extra 30-s block. Exactly the
 * pre-round-7 formula, so a dispute on an old drive re-prices its other events the same as before.
 */
export function legacySpeedingPenalty(e: DriveEvent): number {
  return BASE_PENALTY.speeding[e.tier] * (1 + 0.25 * units(e));
}

/** The points a speeding event costs before the repeat, zone and short-drive multipliers. */
export function speedingPenalty(e: DriveEvent): number {
  const over = measuredOf(e, 'overMphS');
  return over === null ? legacySpeedingPenalty(e) : speedingCost(speedingChargedS(e.durationS), over);
}

// --- Phone use at speed ------------------------------------------------------------------------

/**
 * Phone use costs more points the faster the car was going (the rating is untouched): unknown
 * or at most 25 mph ×1, over 25 to 45 mph ×1.5, over 45 mph ×2.
 */
export function phoneSpeedMult(speedMph: number | null | undefined): 1 | 1.5 | 2 {
  if (typeof speedMph !== 'number' || !Number.isFinite(speedMph) || speedMph <= 25) return 1;
  return speedMph <= 45 ? 1.5 : 2;
}

/** The speed a phone event's multiplier reads: the episode's highest trusted speed, else the pickup speed. */
const phoneSpeedOf = (e: DriveEvent): number | null => measuredOf(e, 'maxSpeedMph') ?? measuredOf(e, 'speedMph');

function penaltyFrom(table: PenaltyTable, e: DriveEvent): number {
  const severe = e.tier === 'severe';
  switch (e.type) {
    case 'speeding':
      return table.speeding[e.tier];
    case 'hard_brake':
    case 'hard_accel':
    case 'hard_corner':
      return table[e.type][severe ? 'severe' : 'minor'];
    case 'phone_pickup':
      return e.stoppedInTraffic ? table.phone_pickup_stopped : table.phone_pickup;
    case 'phone_handling':
      return table.phone_handling_per_unit * units(e);
    case 'eyes_off':
    case 'drowsy':
      return table[e.type];
  }
}

/**
 * The event's base penalty in points: no repeat or zone multiplier. Speeding is `speedingPenalty`
 * (measured, or the legacy tier price with its duration extension); a phone pickup that was not
 * stopped in traffic, and phone handling, are multiplied by `phoneSpeedMult` (under `rules` that
 * price phone use by speed; `LEGACY_RULES` do not). Whole numbers.
 */
export function basePenalty(e: DriveEvent, rules: Readonly<ScoringRules> = CURRENT_RULES): number {
  const speedMult = rules.phoneSpeed ? phoneSpeedMult(phoneSpeedOf(e)) : 1;
  switch (e.type) {
    case 'speeding':
      return speedingPenalty(e);
    case 'phone_pickup':
      return e.stoppedInTraffic ? BASE_PENALTY.phone_pickup_stopped : BASE_PENALTY.phone_pickup * speedMult;
    case 'phone_handling':
      return penaltyFrom(BASE_PENALTY, e) * speedMult;
    default:
      return penaltyFrom(BASE_PENALTY, e);
  }
}

/**
 * What the event adds to the Safety Rating's penalty sum (`RATING_PENALTY`, no multipliers), and
 * nothing for a DashPal event (the rating measures what every phone sees, so owners and non-owners compare).
 */
export const ratingPenalty = (e: DriveEvent): number => (isDashcamType(e.type) ? 0 : penaltyFrom(RATING_PENALTY, e));

/**
 * What a DashPal event (eyes off the road, drowsy) adds to the rating's Attention sum
 * (`RATING_PENALTY`); 0 for every phone event. Attention is divided by the miles DashPal watched,
 * not all the miles (`attentionDeficit`), so drivers without one are never judged on it.
 */
export const attentionPenalty = (e: DriveEvent): number => (isDashcamType(e.type) ? penaltyFrom(RATING_PENALTY, e) : 0);

const repeatMult = (repeatIndex: number): number => (repeatIndex <= 0 ? 1 : repeatIndex === 1 ? 1.25 : 1.5);

/**
 * The event's game penalty before short-drive scaling: `basePenalty` (speeding's measured cost or
 * legacy extension, phone use's speed multiplier included under the current `rules`) × repeat
 * multiplier (2nd of a type ×1.25, 3rd and later ×1.5) × zone (×2).
 */
export function eventPenalty(e: DriveEvent, repeatIndex: number, rules: Readonly<ScoringRules> = CURRENT_RULES): number {
  return basePenalty(e, rules) * repeatMult(repeatIndex) * (e.zone ? 2 : 1);
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
  /** A DashPal drive (`dashcamDrive` of its seconds): gains × `DASHCAM_MULT`. Absent: false. */
  dashcam?: boolean;
  /**
   * The drive's length in seconds, start to end (stops included). Read only for the minimum-drive
   * rule: absent reads as 0, so a caller that does not send it keeps the miles-only rule.
   */
  durationS?: number;
  /**
   * The `SCORING_VERSION` the drive was first scored under (`trips.scoring_version`), for a
   * re-score (an accepted dispute). Absent reads as the current version. Under `EARN_RATE_VERSION`
   * the drive keeps `LEGACY_RULES` (10 a safe mile, a 25 clean bonus, phone use without the speed
   * multiplier; `scoringRules`), so the re-score changes only the disputed event's penalty.
   */
  scoringVersion?: number | null;
}

export interface DriveContext {
  streak: number;
  safeMilesEarlierToday: number;
}

export interface DriveBreakdown {
  /** Under `MIN_SCORED_MILES` and under `MIN_SCORED_S` → not scored, all point fields zero. */
  scored: boolean;
  reason?: 'too_short';
  safeMiles: number;
  /** After the daily cap (and ×0.5 if loopRepeat), 3 dp. */
  creditedMiles: number;
  /** creditedMiles × pointsPerMile (unrounded). */
  milePoints: number;
  /**
   * The points each credited mile earned: `POINTS_PER_MILE`, or `LEGACY_POINTS_PER_MILE` on a
   * re-score of a drive first scored before `EARN_RATE_VERSION`. A breakdown stored before it was
   * recorded earned 10.
   */
  pointsPerMile?: number;
  /**
   * `CLEAN_BONUS` iff miles ≥ 2, zero active non-DashPal events, creditedMiles > 0 and not a loop
   * repeat (`LEGACY_CLEAN_BONUS` on a drive first scored before `EARN_RATE_VERSION`, or stored then).
   */
  cleanBonus: 0 | 25 | 50;
  /** The streak multiplier, 1 + 0.02 × streak capped at 1.30. */
  streakMult: number;
  /** `DASHCAM_MULT` on a DashPal drive, else 1. */
  dashcamMult: 1 | 1.25;
  /** M_gain: min(1.50, streakMult × dashcamMult), 4 dp. Scales gains only. */
  mult: number;
  /** round((milePoints + cleanBonus) × mult) */
  gains: number;
  /** min(1, 0.5 + miles / 6) */
  shortScale: number;
  /** round(eventPenalty × shortScale) per active event, in startedAt order. */
  events: { id: string; penalty: number }[];
  penalties: number;
  /** gains − penalties */
  net: number;
  /** Σ ratingPenalty of active events (a DashPal event adds 0). */
  ratingPenalty: number;
  /** Active events that are not DashPal events: the clean check, the streak's "clean" and the server's `n_events`. */
  activeEventCount: number;
}

/**
 * Whether a drive is too short to score: under `MIN_SCORED_MILES` AND under `MIN_SCORED_S`. Either
 * one reached scores it. A missing or unreadable duration reads as 0.
 */
export function tooShort(miles: number, durationS: number | undefined): boolean {
  return !(miles >= MIN_SCORED_MILES) && !(durationS !== undefined && durationS >= MIN_SCORED_S);
}

/** Score one drive. Deterministic; does not mutate its input. */
export function scoreDrive(input: DriveInput, ctx: DriveContext): DriveBreakdown {
  const streakMult = nextMultiplier(ctx.streak);
  const dashcamMult: 1 | 1.25 = input.dashcam === true ? DASHCAM_MULT : 1;
  const mult = Math.min(MULT_CAP, roundTo(streakMult * dashcamMult, 4));
  const shortScale = Math.min(1, 0.5 + Math.max(0, input.miles) / 6);
  const rules = scoringRules(input.scoringVersion);
  const base = { pointsPerMile: rules.pointsPerMile, streakMult, dashcamMult, mult, shortScale };

  if (tooShort(input.miles, input.durationS)) {
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
  const milePoints = creditedMiles * rules.pointsPerMile;

  const active = input.events
    .filter(isActive)
    .slice()
    .sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // DashPal events cost points (below) but never break a clean drive.
  const phoneCount = active.filter((e) => !isDashcamType(e.type)).length;
  // No bonus once the daily cap is used up or on a repeated loop, so short clean loops can't farm it.
  const earnsBonus =
    input.miles >= CLEAN_BONUS_MIN_MILES && phoneCount === 0 && creditedMiles > 0 && !input.loopRepeat;
  const cleanBonus: 0 | 25 | 50 = earnsBonus ? rules.cleanBonus : 0;
  const gains = roundTo((milePoints + cleanBonus) * mult);

  const seen: Partial<Record<EventType, number>> = {};
  let penalties = 0;
  let rating = 0;
  const events = active.map((e) => {
    const repeatIndex = seen[e.type] ?? 0;
    seen[e.type] = repeatIndex + 1;
    const penalty = roundTo(eventPenalty(e, repeatIndex, rules) * shortScale);
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
    activeEventCount: phoneCount,
  };
}
