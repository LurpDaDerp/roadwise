// The drive host's rules, as pure functions (design §3.1, §3.5; spec §8.4–8.9, Appendix A).
//
// Everything the host decides about the native module, the engine's inputs and the alert player
// is here, so every §3.5 battery rule and every honesty rule has one place and one test. Nothing
// in this file does I/O or reads a clock; `host.ts` feeds it and acts on its answers.
import { CONSTANTS } from '@scoring';
import type {
  CaptureMode,
  CaptureRate,
  DriveSenseState,
  MotionActivity,
} from '@drive-sense';

import type { AlertLevel } from '@/core/alerts/types';
import { gnssPoor, knownSpeed } from '@/core/detectors/common';
import type { EngineEvent, EngineSnapshot, EngineStatus } from '@/core/engine/engine.types';
import { nightAt } from '@/core/engine/finalize';
import type { DetectorContext, DriveMode, FeatureRow } from '@/core/engine/types';

const { AUTO_DETECT_WINDOW_S, LOCKOUT_SPEED_MPS, MIN_SCORED_DISTANCE_M, MIN_SCORED_DURATION_S } =
  CONSTANTS;

/** Settings key of the user's auto-record choice (their intent, not whether capture is armed). */
export const AUTO_DETECT_SETTING_KEY = 'drive.autoDetect';

/** How far back a wake reads the motion history: the auto-detect window (Appendix A, 3 min). */
export const WAKE_HISTORY_S = AUTO_DETECT_WINDOW_S;

/** How long an alert's overlay shows, by level (L1 3 s, L2 5 s, L3 8 s). */
export const ALERT_SHOWN_MS: Readonly<Record<AlertLevel, number>> = Object.freeze({
  1: 3000,
  2: 5000,
  3: 8000,
});

export const isBusyStatus = (status: EngineStatus): boolean =>
  status === 'candidate' || status === 'recording' || status === 'ending' || status === 'finalizing';

export const isIdleStatus = (status: EngineStatus): boolean => status === 'armed' || status === 'off';

/**
 * A drive is under way on the road: a candidate or a confirmed recording (not the gap window, not
 * finalizing). The summary notifier cancels a pending "drive ready" on it. The status sets live
 * here, once (final review M10b), so no screen keeps its own copy.
 */
export const isDrivingStatus = (status: EngineStatus): boolean =>
  status === 'candidate' || status === 'recording';

/** A confirmed trip is open: recording, or in its gap window (keep-awake, Android back). */
export const tripRecords = (status: EngineStatus): boolean => status === 'recording' || status === 'ending';

// --- capture ------------------------------------------------------------------------------------

export type CapturePlan = { on: false } | { on: true; rate: CaptureRate; mode: CaptureMode };

/** What the host believes native is doing. `rate`/`mode` null: not capturing, or not known. */
export interface CaptureBelief {
  on: boolean;
  rate: CaptureRate | null;
  mode: CaptureMode | null;
}

export type CaptureCommand =
  | { type: 'startCapture'; mode: CaptureMode }
  | { type: 'setCaptureRate'; rate: CaptureRate }
  | { type: 'stopCapture' };

/**
 * What capture the engine's state calls for (§3.5, rev1 I5):
 * - `candidate` / `recording`: full rate (1 Hz GNSS + 25 Hz IMU) in the trip's mode;
 * - `ending`: the low rate — coarse location, no IMU, a row only per fix. The engine resumes on an
 *   automotive activity or a row faster than the lockout speed, and resuming means `recording`,
 *   so full rate comes back through this same rule. Ruling N-m1: after parking, the low-rate fixes
 *   rarely pass the 50 m validity check, so in practice the return to full rate depends on the
 *   'driving' motion activity rather than on a fast fix. That is accepted, not a bug (device pass);
 * - `armed` / `off`: nothing — OS wakes only;
 * - `finalizing`: whatever is running stays until the engine settles on its next state.
 */
export function capturePlan(status: EngineStatus, mode: DriveMode, opts: { sameCarHold?: boolean } = {}): CapturePlan | 'keep' {
  switch (status) {
    case 'candidate':
    case 'recording':
      return { on: true, rate: 'full', mode };
    case 'ending':
      // DMS calib T13: a resume held for same-car evidence needs the IMU (the mount's gravity and accRms, rev5 §4.2),
      // which the low rate stops.
      return { on: true, rate: opts.sameCarHold === true ? 'full' : 'low', mode };
    case 'finalizing':
      return 'keep';
    default:
      return { on: false };
  }
}

/** The commands that take native from `belief` to `plan`; empty when it is already there. */
export function captureCommands(belief: CaptureBelief, plan: CapturePlan | 'keep'): CaptureCommand[] {
  if (plan === 'keep') return [];
  if (!plan.on) return belief.on ? [{ type: 'stopCapture' }] : [];
  const out: CaptureCommand[] = [];
  // `startCapture` both starts and claims a capture native started itself (README §6); while
  // capturing it only updates the mode, so it is also how a mode change reaches native.
  const claim = !belief.on || belief.mode !== plan.mode;
  if (claim) out.push({ type: 'startCapture', mode: plan.mode });
  // A capture we have just started (or claimed without knowing its rate) gets its rate said.
  if (!belief.on || belief.rate !== plan.rate) out.push({ type: 'setCaptureRate', rate: plan.rate });
  return out;
}

// --- motion ---------------------------------------------------------------------------------------

/**
 * Walking or running the host acts on: medium confidence or above (rev1: m). DMS calib T12: an Android
 * EXIT (`exit: true`, the walk's end) is never a walk.
 */
const decisiveWalk = (a: MotionActivity): boolean =>
  (a.type === 'walking' || a.type === 'running') && a.confidence !== 'low' && a.exit !== true;

/**
 * A wake opens a candidate only when the motion history says the phone is in a vehicle
 * (§8.5 step 1): the latest decisive entry — automotive, or walking/running at medium or above —
 * must be automotive. The answer is the start of that automotive run, which backfills the trip's
 * start (§8.5 step 4). Stationary, cycling, unknown and low-confidence walking are not evidence
 * either way (a red light reads `automotive` on iOS anyway). Null: open nothing.
 */
export function wakeStart(history: readonly MotionActivity[]): number | null {
  const ordered = [...history].sort((a, b) => a.ts - b.ts);
  let runStart: number | null = null;
  for (const a of ordered) {
    if (a.type === 'automotive') runStart ??= a.ts;
    else if (decisiveWalk(a)) runStart = null;
  }
  return runStart;
}

/**
 * A live `activity` event as the engine event it means, or null for nothing to say.
 * Automotive at any confidence (its own time backfills a candidate's start); walking or running
 * only at medium or above, so a low-confidence reading never ends a trip.
 */
export function activityEvent(
  a: MotionActivity,
  ts: number
): Extract<EngineEvent, { type: 'activity' }> | null {
  if (a.type === 'automotive') {
    return { type: 'activity', automotive: true, walking: false, ts, candidateStartTs: a.ts };
  }
  if (decisiveWalk(a)) return { type: 'activity', automotive: false, walking: true, ts };
  return null;
}

// --- walking away: the confirmation and the same car (DMS calib T13; rev4 §2.12.2, §2.13.4; rev5 §4.2) ---------

/** rev4 §2.12.2: a walk is held this long before it ends a recording drive */
export const WALK_CONFIRM_S = 20;
/** rev4 §2.12.2: a known speed above this in the confirmation window vetoes it (a passenger walking in a bus) */
export const WALK_MAX_SPEED_MPS = 3.0;
/** rev4 §2.12.2: a face in the driver's seat this recently (the DMS frame clock) vetoes it */
export const WALK_FACE_VETO_S = 10;
/** rev4 §2.13.4 (a): a face within this long of the first moving row is the same car */
export const SAME_CAR_FACE_S = 30;
/** rev4 §2.13.4 (b), rev5 §4.2: the mount matched, quiet and unhandled this long is the same car */
export const SAME_CAR_MOUNT_S = 10;
/** How long the host holds a resume for same-car evidence after the first moving row (the face window). */
export const SAME_CAR_HOLD_S = SAME_CAR_FACE_S;

/** A walk the host is timing: since when (the activity's own time). */
export interface WalkCandidate {
  startTs: number;
}

/**
 * The walk candidate after a motion update. A decisive walk (walking or running at medium or above) opens it, or
 * keeps the one open. Anything else ends it: an EXIT (Android), automotive, stationary, cycling or unknown (iOS's
 * non-walking updates). A low-confidence walk changes nothing.
 */
export function walkCandidate(prev: WalkCandidate | null, a: MotionActivity): WalkCandidate | null {
  if (decisiveWalk(a)) return prev ?? { startTs: a.ts };
  if ((a.type === 'walking' || a.type === 'running') && a.exit !== true) return prev;
  return null;
}

/** One row's evidence for the walk confirmation. */
export interface WalkEvidence {
  ts: number;
  /** the row's known speed, m/s; null without a fix (not evaluated) */
  speedMps: number | null;
  /** a strong vehicle row (the motion evidence's `vehicleMotion`: the car itself accelerating) */
  vehicleMotion: boolean;
}

/**
 * rev4 §2.12.2: the walk is confirmed at `now` when it has held WALK_CONFIRM_S, and in the last WALK_CONFIRM_S there
 * was no known speed above WALK_MAX_SPEED_MPS and no strong vehicle row, and no face was in the driver's seat within
 * WALK_FACE_VETO_S (`lastFaceT` from the DMS's `presence()`, null when it is not running). The vetoes hold the
 * candidate open (they are re-read at every row), they do not end it.
 */
export function confirmWalk(c: WalkCandidate, now: number, recent: readonly WalkEvidence[], lastFaceT: number | null): boolean {
  if (now - c.startTs < WALK_CONFIRM_S * 1000) return false;
  const from = now - WALK_CONFIRM_S * 1000;
  for (const e of recent) {
    if (e.ts < from || e.ts > now) continue;
    if (e.speedMps !== null && e.speedMps > WALK_MAX_SPEED_MPS) return false;
    if (e.vehicleMotion) return false;
  }
  return !(lastFaceT !== null && now - lastFaceT <= WALK_FACE_VETO_S * 1000);
}

/** rev5 §4.2: a row of same-car mount evidence: the mount matched, quiet (accRms < MOUNT_QUIET_G) and unhandled. */
export function mountSameCarRow(ev: { mountMatch: boolean | null; mountQuiet: boolean | null }, row: FeatureRow): boolean {
  return ev.mountMatch === true && ev.mountQuiet === true && row.handlingScore === 0;
}

export type SameCar = 'face' | 'mount' | 'manual';

/**
 * rev4 §2.13.4 and rev5 §4.2: after a walking end, a resume is the same car when (c) the driver started it by hand,
 * (a) a face was in the driver's seat within SAME_CAR_FACE_S of the first moving row, or (b) the mount matched,
 * quiet and unhandled for SAME_CAR_MOUNT_S. Null: no evidence (yet).
 */
export function sameCarEvidence(i: { firstMovingTs: number; lastFaceT: number | null; mountRunS: number; manual: boolean }): SameCar | null {
  if (i.manual) return 'manual';
  if (i.lastFaceT !== null && Math.abs(i.lastFaceT - i.firstMovingTs) <= SAME_CAR_FACE_S * 1000) return 'face';
  if (i.mountRunS >= SAME_CAR_MOUNT_S) return 'mount';
  return null;
}

/**
 * Post-gap self-dispatch (M1 note). A row that arrives after the gap window finalizes the trip and
 * returns the engine to `armed`, which ignores rows until a wake or an activity. If the OS does not
 * re-fire IN_VEHICLE, the next drive would be lost; so when the engine is armed and a row still
 * comes in faster than the lockout speed, the host opens the candidate itself.
 */
/** DMS calib T13: a row that would resume a trip in its gap window (the machine's own test: a known speed above the lockout speed). */
export const resumesTrip = (row: FeatureRow): boolean => (knownSpeed(row) ?? 0) > LOCKOUT_SPEED_MPS;

export function shouldSelfDispatch(status: EngineStatus, row: FeatureRow): boolean {
  return status === 'armed' && (knownSpeed(row) ?? 0) > LOCKOUT_SPEED_MPS;
}

// --- the drive notification (Android S3) -----------------------------------------------------------

/** Stopped (C8's stationary run) or already in the gap window. */
export const isStationary = (s: EngineSnapshot): boolean =>
  s.status === 'ending' || (s.status === 'recording' && s.stationarySinceTs !== null);

/** What the ongoing notification shows; the End action is offered only while stationary. */
export function notificationStateOf(s: EngineSnapshot): {
  stationary: boolean;
  startedAt: number | null;
  candidate: boolean;
} {
  return {
    stationary: isStationary(s),
    startedAt: s.startedAt === null ? null : Math.round(s.startedAt),
    // A candidate may still be discarded: the notice says "Checking for a drive" (final review M5).
    candidate: s.status === 'candidate',
  };
}

/** The notification's End action is honoured only while stationary (SR1: nothing while moving). */
export const endDriveAllowed = (s: EngineSnapshot): boolean => isStationary(s);

// --- detector context -----------------------------------------------------------------------------

/**
 * The per-row detector context minus `mode`. `lockReliable` and `lockLagged` come from drive-sense's
 * `lockSignal` (E1 ruling D2): an unreliable signal is never phone-use evidence, a lagged one needs
 * the 12 s confirmation. `precipitation` has no source in M3 (carry-over 8).
 */
export function detectorContext(
  night: boolean,
  lockSignal: DriveSenseState['lockSignal']
): Omit<DetectorContext, 'mode'> {
  return {
    night,
    precipitation: false,
    lockReliable: lockSignal !== 'unreliable',
    lockLagged: lockSignal === 'lagged',
  };
}

/**
 * `nightAt` builds an `Intl.DateTimeFormat`, too heavy for every row (§3.5: nothing heavy on the
 * 1 Hz path) and the hour cannot change within a minute, so the answer is kept per minute and zone.
 */
export function createNightClock(constants: { NIGHT_START_H: number; NIGHT_END_H: number }) {
  let key = '';
  let value = false;
  return {
    at(ts: number, tz: string): boolean {
      const k = `${Math.floor(ts / 60_000)}|${tz}`;
      if (k !== key) {
        key = k;
        value = nightAt(ts, tz, constants);
      }
      return value;
    },
  };
}

// --- small rules ----------------------------------------------------------------------------------

/**
 * What the phone's permissions allow: Always location and granted motion. The one permission rule
 * behind auto-record — the host arms on it (`shouldArm`) and the detection screen reads the same
 * function, so the two can never disagree about what the phone allows (final review I4).
 */
export const permissionsAllowArming = (s: {
  location: DriveSenseState['location'];
  motion: DriveSenseState['motion'] | string;
}): boolean => s.location === 'always' && s.motion === 'granted';

/**
 * Auto-record arms only when the driver opted in, the feature flag makes it available, the device
 * owner has affirmed the background-location disclosure, a driver is signed in (§8.2: sign-out
 * stops recording), and the permissions allow it. The single predicate
 * (final review I4); the host publishes its result as `DriveState.autoDetectArmed`, which Home and
 * the detection screen read rather than re-deriving it.
 */
export const shouldArm = (a: {
  intent: boolean;
  flag: boolean;
  location: DriveSenseState['location'];
  motion: DriveSenseState['motion'];
  signedIn?: boolean;
  /**
   * The account's server-derived age band (ruling T12 (1)): an under-13 account never arms — its
   * drives would sit on the phone and fail as a permanent 403. `unknown` (or not yet known) does
   * not block: its uploads defer safely. The driver's saved choice is never changed by this.
   */
  ageBand?: string | null;
  /**
   * The device owner affirmed the background-location disclosure, at or above the arming minimum
   * (Task 19 r1, security I-1: defence in depth). Required: Always is device-level and survives a
   * handover, so a phone that allows it proves nothing about this account's consent.
   */
  affirmed: boolean;
}): boolean =>
  a.intent &&
  a.flag &&
  a.affirmed &&
  a.signedIn !== false &&
  a.ageBand !== 'u13' &&
  permissionsAllowArming(a);

/**
 * L1 may honour the silent switch only while the phone is mounted and RoadWise is frontmost and
 * unlocked (R14 as amended by the P2 review, I1): iOS silences the silent-switch categories
 * whenever the app is not in front — locked, or behind a navigation app — so any other case must
 * use the playback session or the alert would be lost.
 */
export const l1RespectsSilentSwitch = (
  s: { mode: DriveMode; screenLocked: boolean },
  appActive: boolean
): boolean => s.mode === 'mounted' && !s.screenLocked && appActive;

/** The GPS indicator (C3): none without a valid fix, weak when the fix is too loose to judge speed. */
export function gpsQuality(row: FeatureRow | null): 'good' | 'weak' | 'none' {
  if (row === null || !row.gnssValid) return 'none';
  return gnssPoor(row) ? 'weak' : 'good';
}

/** The speed-limit client's per-row options, from the row being judged (S2). */
export const limitOptions = (row: FeatureRow): { gnssValid: boolean; speedMps: number | null } => ({
  gnssValid: row.gnssValid,
  speedMps: knownSpeed(row),
});

/** Under either scoring minimum — "too short to score" is then true whatever the role. */
export const isShortDrive = (
  trip: { distance_m: number | null; duration_s: number | null },
  constants: { MIN_SCORED_DISTANCE_M: number; MIN_SCORED_DURATION_S: number } = {
    MIN_SCORED_DISTANCE_M,
    MIN_SCORED_DURATION_S,
  }
): boolean =>
  (trip.distance_m ?? 0) < constants.MIN_SCORED_DISTANCE_M ||
  (trip.duration_s ?? 0) < constants.MIN_SCORED_DURATION_S;
