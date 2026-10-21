// One drive's facts as the scoring reads them: its events, the speeding line, the DashPal limits
// and whether the drive is long enough to score (`classifyDrive`). The drive's score and the Safety
// Rating are in rating.ts.
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

/** Bumped whenever the rules a drive is judged by change; stored with every drive. */
export const SCORING_VERSION = 7;

export type EventType = 'speeding' | 'hard_brake' | 'hard_accel' | 'hard_corner' | 'eyes_off' | 'drowsy';

/**
 * The event types only the DashPal dashcam reports (eyes off the road with no return, eyes closed):
 * severe only. They count toward Attention only, never toward the clean-drive check or
 * `activeEventCount`.
 */
export const DASHCAM_EVENT_TYPES = ['eyes_off', 'drowsy'] as const satisfies readonly EventType[];
export type DashcamEventType = (typeof DASHCAM_EVENT_TYPES)[number];

export const isDashcamType = (type: EventType): type is DashcamEventType =>
  (DASHCAM_EVENT_TYPES as readonly EventType[]).includes(type);

/** Colour: minor = yellow, moderate = orange, severe = red. */
export type Tier = 'minor' | 'moderate' | 'severe';

export type Zone = 'school' | 'construction';

/**
 * What the detector measured. Every value is re-checked when read: a missing, non-numeric or
 * non-finite one reads as absent.
 */
export type DriveEventMeasured = {
  /** The GPS speed at the event, mph (a DashPal event's speed gate reads it). */
  speedMph?: number;
  /** speeding: the posted limit, mph. */
  limitMph?: number;
  /** harsh events: the peak force, g. */
  peakG?: number;
  /**
   * speeding: the sum, over the over-the-line rows AFTER the first `SPEEDING_GRACE_S`, of
   * (row speed − (L + T)) in mph, 1 dp. Absent on an event an older app recorded: its Speed weight
   * then reads its tier's assumed mean over (`LEGACY_MEAN_OVER_MPH`).
   */
  overMphS?: number;
  /** A DashPal event. */
  source?: 'dashcam';
};

export interface DriveEvent {
  /** uuid from the device */
  id: string;
  type: EventType;
  /** speeding: minor | moderate | severe; harsh: minor | severe; eyes_off and drowsy (DashPal): severe. */
  tier: Tier;
  /** epoch ms */
  startedAt: number;
  durationS: number;
  /** A school or construction zone: the speeding line's tolerance is 2 mph there. */
  zone?: Zone | null;
  /** removed = accepted dispute → counted nowhere. */
  status?: 'active' | 'removed';
  /** What the detector measured (`DriveEventMeasured`); the Speed weight reads `overMphS`. */
  measured?: DriveEventMeasured;
}

/** The DashPal seconds a drive reports: moving at 5 mph or more, and of those, watched by the dashcam. */
export interface DashcamSeconds {
  movingS: number;
  coveredS: number;
  /** The phone had every dashcam event persisted within 30 s of the drive's end. */
  synced: boolean;
}

/**
 * Whether a drive is a DashPal drive: synced at the end, at least `DASHCAM_MIN_MOVING_S` moving and
 * the dashcam watching for at least `DASHCAM_MIN_COVERAGE` of it. Integer arithmetic on whole
 * seconds, so the device and the server always agree.
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
 * stand and the phone's own events pass untouched. Returns the kept uploads in their input order. Pure.
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
 * speeding line is L + T: speeding is judged, weighed and alerted from it.
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

/** `overMphS` is read as at most this many mph over per charged second (the device and the server clamp it). */
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
 * Whether a drive is too short to score: under `MIN_SCORED_MILES` AND under `MIN_SCORED_S`. Either
 * one reached scores it. A missing or unreadable duration reads as 0.
 */
export function tooShort(miles: number, durationS: number | undefined): boolean {
  return !(miles >= MIN_SCORED_MILES) && !(durationS !== undefined && durationS >= MIN_SCORED_S);
}

/** What a drive is, as far as scoring goes: whether it scores, why not, and how many events break clean. */
export interface DriveClass {
  /** Long enough to score: `!tooShort(miles, durationS)`. */
  scored: boolean;
  reason: 'too_short' | null;
  /**
   * Active events that are not DashPal's: the clean check and the server's `n_events`. Counted on a
   * too-short drive too; a drive is clean when `scored && activeEventCount === 0`.
   */
  activeEventCount: number;
}

/** Whether a drive scores and how many of its events break clean (`DriveClass`). Pure. */
export function classifyDrive(input: {
  miles: number;
  durationS?: number;
  events: readonly Pick<DriveEvent, 'type' | 'status'>[];
}): DriveClass {
  const scored = !tooShort(input.miles, input.durationS);
  const activeEventCount = input.events.filter((e) => e.status !== 'removed' && !isDashcamType(e.type)).length;
  return { scored, reason: scored ? null : 'too_short', activeEventCount };
}
