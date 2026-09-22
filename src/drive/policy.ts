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
export function capturePlan(status: EngineStatus, mode: DriveMode): CapturePlan | 'keep' {
  switch (status) {
    case 'candidate':
    case 'recording':
      return { on: true, rate: 'full', mode };
    case 'ending':
      return { on: true, rate: 'low', mode };
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

/** Walking or running the host acts on: medium confidence or above (rev1: m). */
const decisiveWalk = (a: MotionActivity): boolean =>
  (a.type === 'walking' || a.type === 'running') && a.confidence !== 'low';

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

/**
 * Post-gap self-dispatch (M1 note). A row that arrives after the gap window finalizes the trip and
 * returns the engine to `armed`, which ignores rows until a wake or an activity. If the OS does not
 * re-fire IN_VEHICLE, the next drive would be lost; so when the engine is armed and a row still
 * comes in faster than the lockout speed, the host opens the candidate itself.
 */
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
