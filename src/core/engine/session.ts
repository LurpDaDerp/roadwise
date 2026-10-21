// The per-drive accumulators: miles, safe miles, night miles, the track, integrity counters, and
// the movement rule (product spec v3 "Ending on its own"). Pure functions over a mutable
// `TripSession`; nothing here reads a clock.
//
// Movement: the car counts as moving on two consecutive rows with a trusted GPS speed over 5 mph
// (three when either fix is worse than 20 m), or on two consecutive valid fixes at least
// max(100 m, 2 × (anchor hAcc + fix hAcc)) from where it last moved (the anchor), with no position
// jump no car could make since the anchor, and not at the steady walking pace of someone on foot.
// Each movement row records the mark (the session right after it). A fix-less row on a phone that
// is neither still nor carried holds the idle clock for up to an hour after the last movement,
// without counting as movement, and so does a crawl once the drive has reached driving speed: place
// travel the walking-pace veto refused, made with the phone mostly not carried (a car creeping in a
// queue, not a driver walking off with the phone). Nothing else is movement: a stop, walking pace, an isolated
// reading, a still or carried phone, OS motion reports.
//
// Driving speed: two consecutive rows with a known, trusted GPS speed of 10 mph or more (`droveAt`).
// A drive that never reaches it is not kept; the walking end (`motion.ts`) keys on it too.
//
// Opportunities: every row also goes through the exposure reducer (`exposure.ts`: slowdowns,
// speed-ups, turns, limit time, phone time), and each movement mark keeps its counters, so a drive
// cut back to its last movement counts none of its tail.
import { END_CRAWL_MPH, IDLE_END_S, MAX_H_ACC_M, MOVING_MIN_MPH, NO_EVENTS_FIRST_S, phonePickupTier } from '@scoring';

import { imuAbsent, knownSpeed, MPS_PER_MPH, ROW_MS, speedTrusted } from '@/core/detectors/common';
import { MAX_DRIVE_MS } from '@/data/sync/payload';
import { haversineMeters } from '@/lib/geo';
import { sunIsDown } from '@/lib/time';

import type { DriveOrigin, EndCause, Fix, MotionTrack, MovementMark, StartSource, TripSession } from './engine.types';
import { EMPTY_EXPOSURE_STATE, noteExposure } from './exposure';
import type { DetectedEvent, FeatureRow } from './types';

/** Consecutive fixes implying a speed above this are GNSS noise, not distance. */
export const GNSS_JUMP_MPS = 100;
/** Any IMU extreme beyond this (g, or rad/s for yaw) on a moving row is "the IMU saw motion". */
export const IMU_ACTIVE_MIN = 0.03;

/** Consecutive pace rows that make movement; `MOVE_PACE_ROWS_POOR` when any has a fix worse than `MAX_H_ACC_M`. */
export const MOVE_PACE_ROWS = 2;
export const MOVE_PACE_ROWS_POOR = 3;
/** Place movement: at least this far from the anchor… */
export const MOVE_MIN_M = 100;
/** …and at least this many times the two fixes' combined accuracy. */
export const MOVE_HACC_FACTOR = 2;
/** A step between consecutive valid fixes faster than this is a position jump, not travel. */
export const PLACE_MAX_STEP_MPS = 45;
/** After a jump, no anchor is set for this long. */
export const PLACE_SETTLE_MS = 30_000;
/** A known speed over `min` and at most `max` (mph) is walking pace. */
export const WALK_BAND_MPH = Object.freeze({ min: 2, max: 5 });
/** Place movement is refused when at least this share of the known-speed rows since the anchor were at walking pace. */
export const PED_SHARE = 1 / 3;
/** Fix-less rows, and a crawl, hold the idle clock only this long after the last movement (or the start). */
export const FIXLESS_HOLD_MAX_S = 3600;
/** A crawl: place travel at walking pace with under this share of its known-speed rows from a carried phone. */
export const CRAWL_CARRIED_SHARE = 1 / 3;
/** A run of pace rows in progress delays the automatic end this long after its latest row. */
export const IDLE_FAST_GRACE_MS = 5000;
/** An instant event may start this long after the cut and still be kept (finalize's own slack). */
export const CUT_INSTANT_SLACK_MS = 2000;
/** Driving speed: a known, trusted GPS speed of 10 mph or more. */
export const DRIVING_SPEED_MPS = 10 * MPS_PER_MPH;
/** The walking end: the car must be at or under this (3 mph) for an on-foot report to end the drive. */
export const END_CRAWL_MPS = END_CRAWL_MPH * MPS_PER_MPH;
/** Movement marks kept behind the newest, for the walking end's cut at or before the walk. */
export const MARK_KEEP_MS = 300_000;
/** A fix-less row reads as carried with handling, an unsteady gravity vector, or a turning phone. */
export const CARRIED_HANDLING_MIN = 0.6;
export const CARRIED_GRAVITY_MAX = 0.5;
export const CARRIED_ORIENT_RAD = 0.35;
/** `gravityStability` at or above this, with no handling and a quiet IMU, reads as a still phone. */
export const STILL_GRAVITY_MIN = 0.95;
export const STILL_IMU_MAX_G = 0.05;

/** A row with no fix on a phone that is not moving. */
export function stillWithoutFix(row: FeatureRow): boolean {
  return (
    !row.gnssValid &&
    row.gravityStability >= STILL_GRAVITY_MIN &&
    row.handlingScore === 0 &&
    Math.abs(row.aLonMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLonMin) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLatMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.aLatMin) <= STILL_IMU_MAX_G &&
    Math.abs(row.yawRateMax) <= STILL_IMU_MAX_G &&
    Math.abs(row.jerkMax) <= STILL_IMU_MAX_G
  );
}

/** The IMU-absent encoding (`detectors/common.ts`). */
export { imuAbsent };

/** A phone being carried or handled (the harsh detector's spike and frame-reset lines). */
export function carried(row: FeatureRow): boolean {
  return row.handlingScore >= CARRIED_HANDLING_MIN || row.gravityStability < CARRIED_GRAVITY_MAX || row.orientationDelta > CARRIED_ORIENT_RAD;
}

/** A row with a known, trusted GPS speed of `DRIVING_SPEED_MPS` or more. */
export function drivingRow(row: FeatureRow): boolean {
  const s = knownSpeed(row);
  return s !== null && s >= DRIVING_SPEED_MPS && speedTrusted(row);
}

/** A row with a trusted GPS speed over `MOVING_MIN_MPH`. Walking pace never is one. */
export function isPaceRow(row: FeatureRow): boolean {
  const speed = knownSpeed(row);
  return speed !== null && speed > MOVING_MIN_MPH * MPS_PER_MPH && speedTrusted(row);
}

const validFix = (row: FeatureRow): boolean => row.gnssValid && Number.isFinite(row.lat) && Number.isFinite(row.lng);

/** End of the drive's latest movement (its mark row plus one row), or null while it never moved. */
export const lastMovedAt = (session: Pick<TripSession, 'moved'>): number | null => (session.moved === null ? null : session.moved.rowTs + ROW_MS);

/**
 * A fix-less row that holds the idle clock: the phone is neither still nor carried (or reports no
 * IMU at all), within `FIXLESS_HOLD_MAX_S` of the last movement or the start. A car in a tunnel, a
 * phone in a glovebox.
 */
export function holdsClock(session: Pick<TripSession, 'moved' | 'startedAt'>, row: FeatureRow): boolean {
  if (row.gnssValid) return false;
  if (row.ts >= (lastMovedAt(session) ?? session.startedAt) + FIXLESS_HOLD_MAX_S * 1000) return false;
  if (imuAbsent(row)) return true;
  return !stillWithoutFix(row) && !carried(row);
}

/** Where the idle clock runs from: the last movement (or the start), or a later holding row's end. */
export function idleSince(session: Pick<TripSession, 'moved' | 'startedAt' | 'motion'>): number {
  return Math.max(lastMovedAt(session) ?? session.startedAt, session.motion.heldUntil ?? Number.NEGATIVE_INFINITY);
}

/**
 * When the drive ends by itself: `IDLE_END_S` after `idleSince`, but not while a run of pace rows
 * may still become movement (until `IDLE_FAST_GRACE_MS` after its latest row), and never later
 * than `MAX_DRIVE_MS` after the start. The engine's row check and its tick both use exactly this.
 */
export function autoEndAt(session: Pick<TripSession, 'moved' | 'startedAt' | 'motion'>): number {
  const idle = idleSince(session) + IDLE_END_S * 1000;
  const m = session.motion;
  const grace = m.paceRun > 0 && m.lastPaceTs !== null ? m.lastPaceTs + ROW_MS + IDLE_FAST_GRACE_MS : Number.NEGATIVE_INFINITY;
  return Math.min(session.startedAt + MAX_DRIVE_MS, Math.max(idle, grace));
}

const EMPTY_MOTION: Readonly<MotionTrack> = Object.freeze({
  paceRun: 0,
  paceRunPoor: false,
  lastPaceTs: null,
  anchor: null,
  anchorAfter: null,
  placePending: false,
  speedRows: 0,
  walkRows: 0,
  carriedRows: 0,
  heldUntil: null,
  prevDrive: false,
});

const NO_MARKS: readonly Readonly<MovementMark>[] = Object.freeze([]);

export interface SessionStart {
  clientTripId: string;
  startedAt: number;
  /** How the drive began. */
  origin: DriveOrigin;
  /** A start within `MERGE_GAP_S` of the previous drive's end: no warm-up. Default false. */
  continues?: boolean;
  /** Where `startedAt` came from; default null. */
  startSource?: StartSource | null;
  /** The parked spot the drive started from when it is not the first row; default null. */
  startPlace?: { lat: number; lng: number } | null;
  /** Re-opened this many times (a rebuilt continuation); default 0. */
  continuations?: number;
}

export function createSession(start: SessionStart): TripSession {
  const continues = start.continues === true;
  return {
    clientTripId: start.clientTripId,
    startedAt: start.startedAt,
    origin: start.origin,
    continuations: start.continuations ?? 0,
    startSource: start.startSource ?? null,
    startPlace: start.startPlace ?? null,
    endedAt: null,
    endCause: null,
    lastRowTs: null,
    rowsCount: 0,
    validGnssRows: 0,
    mockRows: 0,
    movingRows: 0,
    imuActiveRows: 0,
    distanceM: 0,
    safeDistanceM: 0,
    nightDistanceM: 0,
    maxSpeedMps: 0,
    firstFix: null,
    lastFix: null,
    track: [],
    events: [],
    pending: [],
    checkpointTs: null,
    lastSeq: null,
    warmup: Object.freeze({
      continues,
      decided: continues,
      endsAt: continues ? start.startedAt : start.startedAt + NO_EVENTS_FIRST_S * 1000,
    }),
    exposure: EMPTY_EXPOSURE_STATE,
    moved: null,
    marks: NO_MARKS,
    droveAt: null,
    lastDroveAt: null,
    lastSpeed: null,
    motion: EMPTY_MOTION,
    cut: false,
  };
}

/**
 * Decide the warm-up on a row, before the detectors see it (live and in the replay alike). The
 * first row with a trusted known speed decides: over `MOVING_MIN_MPH` (a start made while moving)
 * the warm-up ends at that row; at or under it the 30 s stand. After 30 s nothing changes it.
 * Replaces `session.warmup`; never mutates the old object.
 */
export function noteWarmup(session: TripSession, row: FeatureRow): void {
  const w = session.warmup;
  if (w.decided) return;
  if (row.ts >= session.startedAt + NO_EVENTS_FIRST_S * 1000) {
    session.warmup = Object.freeze({ ...w, decided: true });
    return;
  }
  const speed = knownSpeed(row);
  if (speed === null || !speedTrusted(row)) return;
  // A row from before the tap (a buffered first row) never opens events before the drive itself.
  const endsAt = speed > MOVING_MIN_MPH * MPS_PER_MPH && row.ts < w.endsAt ? Math.max(session.startedAt, row.ts) : w.endsAt;
  session.warmup = Object.freeze({ ...w, decided: true, endsAt });
}

const imuActive = (row: FeatureRow): boolean =>
  Math.abs(row.aLonMax) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLonMin) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLatMax) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLatMin) > IMU_ACTIVE_MIN ||
  Math.abs(row.yawRateMax) > IMU_ACTIVE_MIN;

/** What the detectors said about a row, for the accumulators. */
export interface RowFlags {
  /** A speeding episode past its grace is active on the row: its distance is not safe miles. */
  unsafe: boolean;
  /** The speeding detector could use the row (`DetectorSuite.speedingNow() !== null`): it counts toward limit time. */
  limitUsable: boolean;
}

/** The bridge-only journal sequence number a row may carry (iOS), or null. */
export function rowSeq(row: FeatureRow): number | null {
  const seq = (row as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 1 ? seq : null;
}

/**
 * Append one row the machine has accepted. The accumulators first, then the opportunity counters,
 * then the movement step (whose mark keeps both), then the driving-speed step.
 */
export function appendRow(session: TripSession, row: FeatureRow, flags: RowFlags): void {
  const prevFix = session.lastFix;
  accumulate(session, row, flags.unsafe);
  session.exposure = noteExposure(session.exposure, row, flags.limitUsable);
  noteMovement(session, row, prevFix);
  noteDriving(session, row);
}

/**
 * The last known speed, and `droveAt` (the first) and `lastDroveAt` (the latest) on the second of
 * two consecutive driving rows. Replaces `session.lastSpeed` and `session.motion`; never mutates either.
 */
function noteDriving(session: TripSession, row: FeatureRow): void {
  const speed = knownSpeed(row);
  if (speed !== null) session.lastSpeed = Object.freeze({ mps: speed, ts: row.ts });
  const d = drivingRow(row);
  if (d && session.motion.prevDrive) {
    if (session.droveAt === null) session.droveAt = row.ts;
    session.lastDroveAt = row.ts;
  }
  if (session.motion.prevDrive !== d) session.motion = Object.freeze({ ...session.motion, prevDrive: d });
}

function accumulate(session: TripSession, row: FeatureRow, unsafe: boolean): void {
  session.rowsCount += 1;
  session.lastRowTs = row.ts;
  session.pending.push(row);
  const seq = rowSeq(row);
  if (seq !== null) session.lastSeq = seq;
  if (row.mock === true) session.mockRows += 1;
  const speed = knownSpeed(row);
  if (speed !== null) {
    if (speed > session.maxSpeedMps) session.maxSpeedMps = speed;
    if (speed >= MOVING_MIN_MPH * MPS_PER_MPH) {
      session.movingRows += 1;
      if (imuActive(row)) session.imuActiveRows += 1;
    }
  }
  if (!validFix(row)) return;
  session.validGnssRows += 1;
  const fix: Fix = { lat: row.lat, lng: row.lng, ts: row.ts };
  const prev = session.lastFix;
  if (prev !== null) {
    const d = haversineMeters(prev, fix);
    const dtS = Math.max(1, (fix.ts - prev.ts) / 1000);
    // A jump faster than any car is a bad fix: skip the segment but still move on from it.
    if (d <= GNSS_JUMP_MPS * dtS) {
      session.distanceM += d;
      if (!unsafe) session.safeDistanceM += d;
      if (sunIsDown(new Date(row.ts), row.lat, row.lng)) session.nightDistanceM += d;
    }
  }
  if (session.firstFix === null) session.firstFix = fix;
  session.lastFix = fix;
  session.track.push({ ...fix, hAcc: row.hAcc });
}

const markOf = (session: TripSession, rowTs: number): Readonly<MovementMark> =>
  Object.freeze({
    rowTs,
    rowsCount: session.rowsCount,
    validGnssRows: session.validGnssRows,
    mockRows: session.mockRows,
    movingRows: session.movingRows,
    imuActiveRows: session.imuActiveRows,
    distanceM: session.distanceM,
    safeDistanceM: session.safeDistanceM,
    nightDistanceM: session.nightDistanceM,
    maxSpeedMps: session.maxSpeedMps,
    lastFix: session.lastFix,
    trackLength: session.track.length,
    exposure: session.exposure,
  });

/**
 * The movement step, after the row's accumulators. `prevFix` is the last valid fix before this
 * row. Replaces `session.motion` (and `session.moved` on movement); never mutates either.
 */
function noteMovement(session: TripSession, row: FeatureRow, prevFix: Fix | null): void {
  const m: MotionTrack = { ...session.motion };
  // Pace: consecutive trusted readings over 5 mph.
  if (isPaceRow(row)) {
    m.paceRun += 1;
    m.paceRunPoor ||= !(row.hAcc <= MAX_H_ACC_M);
    m.lastPaceTs = row.ts;
  } else {
    m.paceRun = 0;
    m.paceRunPoor = false;
  }
  let moved = m.paceRun >= (m.paceRunPoor ? MOVE_PACE_ROWS_POOR : MOVE_PACE_ROWS);

  const valid = validFix(row);
  const here = { lat: row.lat, lng: row.lng };
  // A position jump no car could make: start again from wherever the fixes settle.
  let jump = false;
  if (valid && prevFix !== null) {
    const stepMps = haversineMeters(prevFix, here) / Math.max(1, (row.ts - prevFix.ts) / 1000);
    if (stepMps > PLACE_MAX_STEP_MPS) {
      jump = true;
      m.anchor = null;
      m.anchorAfter = row.ts + PLACE_SETTLE_MS;
      m.placePending = false;
    }
  }
  let anchoredNow = false;
  if (valid && !jump && m.anchor === null && (m.anchorAfter === null || row.ts >= m.anchorAfter)) {
    m.anchor = Object.freeze({ lat: row.lat, lng: row.lng, hAcc: row.hAcc });
    m.speedRows = 0;
    m.walkRows = 0;
    m.carriedRows = 0;
    m.placePending = false;
    anchoredNow = true;
  }
  // Place: two consecutive valid fixes past the threshold, unless the way there was at walking pace.
  // At walking pace after the drive reached driving speed, with the phone mostly not carried, it is
  // a crawl: the clock is held (within `FIXLESS_HOLD_MAX_S`) and the next 100 m measured from here.
  let crawl = false;
  if (valid && !jump && !anchoredNow && m.anchor !== null) {
    const speed = knownSpeed(row);
    if (speed !== null) {
      m.speedRows += 1;
      const mph = speed / MPS_PER_MPH;
      if (mph > WALK_BAND_MPH.min && mph <= WALK_BAND_MPH.max) m.walkRows += 1;
      if (carried(row)) m.carriedRows += 1;
    }
    const d = haversineMeters(m.anchor, here);
    if (d >= Math.max(MOVE_MIN_M, MOVE_HACC_FACTOR * (m.anchor.hAcc + row.hAcc))) {
      const onFoot = m.speedRows > 0 && m.walkRows >= m.speedRows * PED_SHARE;
      if (m.placePending && !onFoot) moved = true;
      else if (m.placePending && session.droveAt !== null && m.carriedRows < m.speedRows * CRAWL_CARRIED_SHARE) crawl = true;
      else m.placePending = true;
    } else {
      m.placePending = false;
    }
  }

  if (moved) {
    m.anchor = valid && !jump ? Object.freeze({ lat: row.lat, lng: row.lng, hAcc: row.hAcc }) : null;
    m.placePending = false;
    m.speedRows = 0;
    m.walkRows = 0;
    m.carriedRows = 0;
    m.heldUntil = null;
    const mark = markOf(session, row.ts);
    session.moved = mark;
    session.marks = Object.freeze([...session.marks.filter((k) => k.rowTs >= row.ts - MARK_KEEP_MS), mark]);
  } else if (crawl) {
    m.anchor = Object.freeze({ lat: row.lat, lng: row.lng, hAcc: row.hAcc });
    m.placePending = false;
    m.speedRows = 0;
    m.walkRows = 0;
    m.carriedRows = 0;
    if (row.ts < (lastMovedAt(session) ?? session.startedAt) + FIXLESS_HOLD_MAX_S * 1000) m.heldUntil = row.ts + ROW_MS;
  } else if (holdsClock(session, row)) {
    m.heldUntil = row.ts + ROW_MS;
  }
  session.motion = Object.freeze(m);
}

/** A frozen copy, arrays included, so a callback holding it sees what it was handed. */
export function snapshotSession(session: TripSession): Readonly<TripSession> {
  return Object.freeze({
    ...session,
    track: Object.freeze(session.track.slice()) as TripSession['track'],
    events: Object.freeze(session.events.slice()) as TripSession['events'],
    pending: Object.freeze(session.pending.slice()) as TripSession['pending'],
  });
}

/** The closed drive as the finalizer receives it. The open session object is left as it was. */
export function closeSession(session: TripSession, endedAt: number, cause: EndCause): Readonly<TripSession> {
  // The drive ends where driving stopped, never before its own start or last row of driving.
  const end = Math.max(endedAt, session.startedAt + 1000);
  return snapshotSession({ ...session, endedAt: Math.round(end), endCause: cause });
}

const INSTANT = new Set<DetectedEvent['type']>(['hard_brake', 'hard_accel', 'hard_corner']);

/**
 * The events of a drive closed at `cutTs`, in input order: an instant event (brake, start, turn)
 * is kept when it starts before `cutTs + CUT_INSTANT_SLACK_MS`; any other event starting at or
 * after the cut is dropped, and one running across it ends there. A phone pickup keeps whole
 * seconds in hand (at least 1) and the tier they make. Pure.
 */
export function cutEvents(events: readonly DetectedEvent[], cutTs: number): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (const e of events) {
    const kept = cutEvent(e, cutTs);
    if (kept !== null) out.push(kept);
  }
  return out;
}

/** One event under `cutEvents`' rule: as it was, clipped, or null when the cut drops it. */
function cutEvent(e: DetectedEvent, cutTs: number): DetectedEvent | null {
  if (INSTANT.has(e.type)) return e.startedAt < cutTs + CUT_INSTANT_SLACK_MS ? e : null;
  if (e.startedAt >= cutTs) return null;
  if (e.startedAt + e.durationS * 1000 <= cutTs) return e;
  if (e.type === 'phone_pickup') {
    const durationS = Math.max(1, Math.floor((cutTs - e.startedAt) / 1000));
    return { ...e, durationS, tier: phonePickupTier(durationS) };
  }
  return { ...e, durationS: (cutTs - e.startedAt) / 1000 };
}

/**
 * The mark a cut lands on: the latest movement, or with `notAfter` (the walking end: when the walk
 * began) the latest kept mark at or before it, falling back to the oldest kept mark when every one
 * is later (at most `MARK_KEEP_MS` of walking then stays in the drive).
 */
function cutMark(session: TripSession, notAfter: number | undefined): Readonly<MovementMark> | null {
  if (notAfter === undefined || session.moved === null) return session.moved;
  for (let i = session.marks.length - 1; i >= 0; i -= 1) {
    const m = session.marks[i] as Readonly<MovementMark>;
    if (m.rowTs <= notAfter) return m;
  }
  return session.marks[0] ?? session.moved;
}

/**
 * The drive closed where the car last moved (every automatic end, and a manual end after standing
 * still): the accumulators and the opportunity counters come back to the mark, the track ends there
 * and the events are cut (`cutEvents`), so the time standing still counts for nothing. A drive that
 * never moved keeps what it has and ends after its last row; it is dropped, never stored. The open
 * session is left as it was.
 *
 * `notAfter` (the walking end, at the walk's start): the cut lands on the last movement at or
 * before it (`cutMark`), so the walk's own distance and track are left out.
 */
export function closeAtLastMovement(session: TripSession, cause: EndCause, opts: { notAfter?: number } = {}): Readonly<TripSession> {
  const mark = cutMark(session, opts.notAfter);
  if (mark === null) {
    const end = Math.max((session.lastRowTs ?? session.startedAt) + ROW_MS, session.startedAt + 1000);
    return snapshotSession({ ...session, endedAt: Math.round(end), endCause: cause, cut: false });
  }
  const cutTs = mark.rowTs + ROW_MS;
  const endedAt = Math.max(cutTs, session.startedAt + 1000);
  return snapshotSession({
    ...session,
    endedAt: Math.round(endedAt),
    endCause: cause,
    cut: true,
    lastRowTs: mark.rowTs,
    rowsCount: mark.rowsCount,
    validGnssRows: mark.validGnssRows,
    mockRows: mark.mockRows,
    movingRows: mark.movingRows,
    imuActiveRows: mark.imuActiveRows,
    distanceM: mark.distanceM,
    safeDistanceM: mark.safeDistanceM,
    nightDistanceM: mark.nightDistanceM,
    maxSpeedMps: mark.maxSpeedMps,
    lastFix: mark.lastFix,
    track: session.track.slice(0, mark.trackLength),
    exposure: mark.exposure,
    events: cutEvents(session.events, cutTs),
  });
}

export const durationSOf = (session: Pick<TripSession, 'startedAt' | 'endedAt'>): number =>
  Math.max(0, ((session.endedAt ?? session.startedAt) - session.startedAt) / 1000);
