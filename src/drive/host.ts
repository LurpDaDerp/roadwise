// The drive host (product spec "Starting and ending a drive", "Driving screen"; modes plan §3.2,
// §3.5-§3.10, §3.15, §10 A2).
//
// One object wires the native capture, the iOS drive detector, the engine, the detectors, the
// speed-limit client, the alert player, the background display and persistence together, and
// publishes one `DriveState` for the UI. Rules:
// - **How a drive begins.** On its own (iOS): native notices driving once the speed has been held
//   long enough (drive-sense's `AUTO_TRIGGER`: over 15 mph, (5/3)·(30 − mph) s, so about 25 s
//   just over 15 and 5 s less for every 3 mph faster, and from about 30 mph the second good reading
//   in a row; under 20 mph only with fresh car motion, and 15 mph and under never), traces the
//   start back and journals every row; the host adopts the journal wherever JS runs (a
//   `driveStarted` event, or `boot`) and replays it into the engine. From the Start card
//   (both): the drive records from the tap (iOS: native opens a journaled drive at once,
//   `startWaiting`; a native build too old for that, or an answer that cannot be used, falls back to
//   a plain capture once native's own wait is cancelled; Android: the capture starts), and a start
//   counts whenever the drive records afterwards, so no step beside it can refuse it. It waits for
//   driving speed (`waiting.ts`): until the car
//   reaches it the screen asks "Still planning to drive?" at 2 min and the drive ends unsaved at
//   5 min from the tap or the last touch. Every confirmed drive is a drive of its own, however
//   soon and near the last one ended.
// - **How it ends.** The engine decides (5 min still, 10 s after a reported walk began with the
//   report standing 3 s at least, once the car is at 3 mph or slower or its last speed is over
//   15 s old, 12 h, End); native
//   stops on its own only as a fallback and the engine then cuts at the last movement. "Not
//   driving?" discards the drive (`cancelDrive`), only while its 2-minute visible budget lasts,
//   and never while a Start-card drive still waits (its Cancel discards it then; the wait spends
//   none of the budget).
// - **One queue.** Every engine dispatch and the native command that follows it run on one serial
//   chain; after each task the capture is reconciled with the engine's state (on iOS the host never
//   starts a capture: native owns it, and `stopCapture` tells native the JS end and its cut).
// - **In front only.** Alert sounds, voice and haptics play only while RoadWise is active, and
//   never for a replayed row (a journal drained: old news, which the engine never shows or shakes
//   either); the spot nudge shows only then. A phone pickup's
//   alert plays only while the driving screen shows
//   (focused, RoadWise active) and never for a replayed row; with RoadWise not active nothing plays
//   or is posted. The drive records the same either way.
// - **Battery.** Nothing runs while idle: no timer, no read. While recording, one timeout at most
//   (the automatic end, `ticks.ts`), the display throttled (about one update a second on iOS, one
//   per 3 s on Android), the weather
//   checked every 15 min or 20 km, the state published at most once per row.
// - **Background (Android).** Each row first pumps the process's timers (`src/lib/timers.ts`): with
//   the app in the Android background JS timers are paused, and the rows are what keeps the alert
//   player, the waiting clock and the DashPal link moving.
import { parseActivity, parseRow, parseSpeed, type CaptureEnd, type DriveDetectApi, type DriveStartedEvent, type DriveEndedEvent, type EndCauseNative, type JournaledDrive } from '@drive-sense';
import type { LiveDriveState } from '@live-drive';
import { MERGE_GAP_S } from '@scoring';
import { Platform } from 'react-native';

import { decisionFor, ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import { knownSpeed, ROW_MS } from '@/core/detectors/common';
import type { AdoptedTrip, AlertEvent, DriveOrigin, EndCause, EngineSnapshot, EngineStatus, StartSource, TripSession } from '@/core/engine/engine.types';
import { closeDrive, dropTrip, isDropped, type DropReason } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { createRecorder } from '@/core/engine/recorder';
import { rebuildFromSamples, type RebuildDeps } from '@/core/engine/replay';
import type { FeatureRow } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { NUDGE_AFTER_ALERT_MS } from '@/core/spots/constants';
import type { WatchSpot } from '@/core/spots/types';
import { createSpotWatcher, type SpotNudge, type SpotWatcher } from '@/core/spots/watcher';
import { dashcamFinalizeDeps } from '@/dashcam/finalizeDeps';
import { createSettingsRepo, createTripsRepo, type Db, type TripStatus } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import type { AppStateLike } from '@/data/foreground';
import { readWatchSpots } from '@/data/queries/spots';
import { WEATHER_TITLES } from '@/features/weather/copy';
import { moreSevere, type DangerAlert, type DangerKind } from '@/features/weather/danger';
import { processTimers } from '@/lib/timers';
import { sunIsDown } from '@/lib/time';
import { KMH_PER_MPH, mpsToMph } from '@/lib/units';

import { toLive, type DriveDisplay, type DriveDisplayState } from './display';
import { displayLook } from './displayLook';
import { speedTintOf } from './displayTint';
import { clearDropNotice, writeDropNotice } from './dropNotice';
import { clearCancelMarker, readCancelMarker, writeCancelMarker } from './cancel';
import { budgetFor, NOT_DRIVING_KEY, NOT_DRIVING_PERSIST_EVERY_MS, spend, writeBudget, type NotDrivingBudget } from './notDriving';
import { isBusyStatus } from './policy';
import type { DriveSource } from './source';
import { createTicker, realScheduler, type Scheduler } from './ticks';
import { nextWaitingChange, WAIT_TOTAL_MS, waitingDeadline, waitingPhaseAt, type WaitingPublic } from './waiting';
import { createWeatherWatch, type WeatherLookup, type WeatherWatch } from './weatherWatch';

export type { DriveSource } from './source';

/**
 * The outcome of the last finalize (or "Not driving?"), for the end flow and the recap
 * notification. `dropped`: the drive was not kept (it never moved, or `cancelled`), so it has no
 * row, status, time or distance.
 */
export type LastFinalized =
  | {
      clientTripId: string;
      ok: true;
      status: TripStatus | null;
      dropped: DropReason | null;
      endCause: EndCause;
      at: number;
      /** The kept drive's length (s) and distance (mi), for the recap notification; null when dropped. */
      durationS: number | null;
      miles: number | null;
      /**
       * Where the kept drive ended (its cut, epoch ms), for the recap notification's age rule (a drive
       * stored at a launch can have ended hours before); null when dropped or unknown.
       */
      endedAt?: number | null;
    }
  | { clientTripId: string; ok: false; at: number }
  | null;

/** What the Live Activity and the driving screen show for the weather: the alert's kind and its title. */
export interface ShownWeather {
  kind: DangerKind;
  text: string;
}

export interface DriveState extends EngineSnapshot {
  /** A hands-free call is active (iOS CallKit observer; Android phone-state receiver where present): the player's in-call gain. */
  callActive: boolean;
  lastFinalized: LastFinalized;
  /** False when a sound failed during this drive; the drive still records, silently. */
  alertsAvailable: boolean;
  /** A `persistence: 'none'` host (the diagnostics simulation): nothing is stored. */
  dryRun: boolean;
  /** A Start-card drive still waiting for driving speed (it records from the tap: `status` is recording), or null. */
  waiting: WaitingPublic | null;
  /** "Not driving?" may still be offered on this drive (its 2-minute budget lasts); false with no drive, and while it still waits. */
  notDrivingAvailable: boolean;
  /** Of the budget, the visible ms spent so far. */
  notDrivingSpentMs: number;
  /** The driving screen's "Watch your speed here" line (shown once per key), or null. */
  spotNudge: SpotNudge | null;
  /** The dangerous-weather alert at the car, unless dismissed this drive (a more severe kind shows again); null with no drive. */
  weatherAlert: DangerAlert | null;
  /** The same alert as the Live Activity carries it: its kind and title. */
  weather: ShownWeather | null;
}

/**
 * Why a Start Drive swipe started no wait: no location (`permission`), approximate location only
 * (`precise`), the phone's Location Services off (`services`), a drive already open (`busy`), or
 * not ready / signed out / a failure (`error`).
 */
export type StartRefusalReason = 'permission' | 'precise' | 'services' | 'busy' | 'error';

export type StartResult = { ok: true; waiting: true } | { ok: false; reason: StartRefusalReason };

/** `end()`: the drive closed, but finalizing it failed; End again retries it. */
export class DriveEndFailedError extends Error {
  constructor(readonly clientTripId: string) {
    super(`drive ${clientTripId} could not be finalized`);
    this.name = 'DriveEndFailedError';
  }
}

/**
 * What the swipe reads before a wait can start: location (asked once if never answered), and,
 * read only, Precise Location and the Location Services switch (null: could not be read, which
 * never refuses).
 */
export interface DriveStartPermissions {
  location: 'granted' | 'denied';
  precise?: boolean | null;
  services?: boolean | null;
}

export interface DriveHost {
  /** Attach to native events; continue `adopt` (a drive the previous process was recording) and, on iOS, every journaled drive. */
  boot(opts?: { adopt?: AdoptedTrip | null }): Promise<void>;
  /**
   * The Start card: a drive records from the tap, waiting for driving speed (the driving screen
   * opens with the wait's band). Already waiting: a touch.
   */
  start(): Promise<StartResult>;
  /** Any touch on the driving screen while the Start-card drive waits (and "Keep waiting"): a fresh 5 min. */
  touchWaiting(): void;
  /** "Cancel" (the sheet's, or End swiped while waiting): the waiting drive ends unsaved; Home says nothing. */
  cancelWaiting(): Promise<void>;
  /**
   * The swipe-to-end. Resolves once the drive is finalized; null when none was open, or while a
   * Start-card drive still waits (it is cancelled, as `cancelWaiting`). `dropped`: that drive was
   * not kept. Rejects with `DriveEndFailedError` when the drive closed but could not be finalized;
   * with no drive open, the next `end()` finalizes it again.
   */
  end(): Promise<{ clientTripId: string; dropped: DropReason | null } | null>;
  /** "Not driving?": discards the drive. False (nothing done) unless a drive records, no longer waits, and its budget lasts. */
  cancelDrive(): Promise<boolean>;
  /** The driving screen is focused (true) or not: with RoadWise active, the "Not driving?" budget counts. */
  setHudVisible(visible: boolean): void;
  /** The driving screen's ✕ on the weather banner: hidden for the rest of the drive (a more severe kind shows again). */
  dismissWeather(): void;
  /** DEMO: a tap on the driving screen plays the phone-pickup alert (tone, voice, haptic), whatever the drive is doing. */
  demoPhoneAlert(): void;
  stop(opts: { endOpenTrip: boolean }): Promise<void>;
  isBusy(): boolean;
  captureActive(): boolean;
  /** Resolves once no drive is open or closing and the host's queue has drained. */
  untilIdle(): Promise<void>;
  settled(): Promise<void>;
  snapshot(): DriveState;
  subscribe(fn: (s: DriveState) => void): () => void;
  /** `boot` has run (and `stop` has not): until then `start` answers `error`. */
  booted(): boolean;
  signedIn(): boolean;
  /** Sign-out: a wait is cancelled, an open drive is ended and finalized under the current owner. */
  suspendForSignOut(): Promise<void>;
  resumeAfterSignIn(): Promise<void>;
  signedInAgain(opts?: { initial?: boolean }): Promise<void>;
  signOutCompleted(): void;
  /**
   * The session ended, whoever ended it (every sign-out, forced or not, and one the server ended):
   * an open drive is finalized under the device's owner, then Home's drop notice comes down.
   */
  sessionEnded(): Promise<void>;
  reportAlertsUnavailable(): void;
  reportAlertsAvailable(): void;
  /** A drive is recording. */
  recording(): boolean;
}

/**
 * The DashPal dashcam, as the host drives it (`src/dashcam/runtime.ts`). Every hook is optional
 * work beside the drive: a failure never stops a row, an alert or a finalize.
 */
export interface DriveHostDashcam {
  /** Every drive row: the dashcam's context (STATE, its tick) and this drive's coverage. */
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean }): void;
  /** A drive continued after a relaunch: its coverage totals are reloaded. */
  adopt(clientTripId: string): Promise<void>;
  /** Drive end: wait ≤ 3 s for the phone to catch up to the dashcam, then stamp the sync time. */
  beforeFinalize(clientTripId: string, opts: { dryRun: boolean }): Promise<void>;
  /** A DashPal continuous alert is active: phone alerts are then haptic + visual only. */
  continuousAlertActive(): boolean;
}

/**
 * What a push-to-start request came to (`LiveActivityStartOutcome`): sent, or why not (`reason`,
 * Apple's code in `detail`) and whether asking again soon may send (`retryable`).
 */
export interface PushToStartOutcome {
  sent: boolean;
  reason: string | null;
  detail?: string | null;
  retryable: boolean;
}

/** After the confirming rows are in, the push-to-start waits this long at most for the drive's speed and limit. */
export const PUSH_START_WAIT_MS = 1_500;
/** A push-to-start that failed in a way a retry may fix is asked once more this long after. */
export const PUSH_START_RETRY_MS = 30_000;

/** The first Live Activity state, for a server push-to-start (iOS 17.2+). */
export interface PushToStartRequest {
  clientTripId: string;
  /** Always 0: one push per drive (the server keys its pushes by drive and leg, leg 0 the first). */
  leg: 0;
  startedAt: number;
  state: LiveDriveState;
}

export interface DriveHostDeps {
  db: Db;
  source: DriveSource;
  limits: SpeedLimitClient;
  player: AlertPlayer;
  display?: DriveDisplay;
  now: () => number;
  tz: () => string;
  newId: () => string;
  appVersion: string;
  /**
   * Just-in-time permissions: While-Using location (required; asked when never answered), then the
   * Location Services switch and Precise Location (read only).
   */
  permissions?: () => Promise<DriveStartPermissions>;
  /** The phone's cached position (no GPS of its own), or null: the limit tiles at a start, the weather before a fix. */
  lastPosition?: () => Promise<{ lat: number; lng: number } | null>;
  voiceEnabled?: () => boolean;
  appState?: AppStateLike;
  scheduler?: Scheduler;
  alertsAvailable?: boolean;
  signedOut?: boolean;
  /** `none`: a dry run (a simulation) — no checkpoint, finalize, change event, weather or spots. */
  persistence?: 'full' | 'none';
  /** The DashPal dashcam (none: no hooks). */
  dashcam?: DriveHostDashcam;
  /** iOS: the drive detector (`DriveDetect`); null or absent on Android. */
  detect?: DriveDetectApi | null;
  /**
   * iOS: ask our server to push-start the Live Activity (any drive begun with RoadWise behind), once the confirming rows are in. A bare boolean is an outcome without a reason (false
   * counts as worth one retry). Not sent: the native note stands.
   */
  pushToStart?: (req: PushToStartRequest) => Promise<boolean | PushToStartOutcome>;
  /** The spots the driving screen nudges about (default `readWatchSpots` over `db`). */
  spots?: { readWatchSpots(): Promise<WatchSpot[]> };
  /** The weather at a place (default Open-Meteo). */
  weather?: WeatherLookup;
  /** The phone recording the drives (default `Platform.OS`): the phone detector reads it (on iPhone a row with a call is never phone use). */
  platform?: 'ios' | 'android';
  /**
   * Called as each row arrives: fires the pumped timers that are due (`src/lib/timers.ts`), which
   * Android leaves unfired while the app is in the background. Default: the process's.
   */
  pump?: () => void;
  onError?: (e: unknown, ctx: string) => void;
}

const noop = (): void => {};

/** The local mirror of `profiles.units`: 'km' shows km/h on the background display. */
export const UNITS_KEY = 'units';
/**
 * Which native journal feeds which trip. A drive this build begins has its journal's id as its trip
 * id; one begun under an older build may not, so the link is written and read for every drive.
 * Cleared at every end.
 */
export const JOURNAL_LINK_KEY = 'drive.journalLink';
/**
 * Rows of the LIVE drive's journal replayed per boot at most; the rest arrive live (a live row past
 * a gap reads the journal up to it). An ended journal is always read to its end.
 */
export const MAX_JOURNAL_REPLAY_ROWS = 1800;
/** Rows read from the journal per call. */
export const JOURNAL_READ_ROWS = 300;
/** The car counts as still driving at the end only when its latest speed reading is at most this old then. */
export const DRIVING_AT_END_MS = 5_000;

/**
 * Whether native's journal (or the one the journal link names) holds `clientTripId`: the
 * boot's recovery adopts such a drive whatever the capture says. False when it cannot be read.
 */
export async function isJournaled(db: Db, detect: Pick<DriveDetectApi, 'listDrives'>, clientTripId: string): Promise<boolean> {
  try {
    const drives = await detect.listDrives();
    if (drives.some((d) => d.driveId === clientTripId)) return true;
    const link = await createSettingsRepo(db).get<{ driveId?: unknown; clientTripId?: unknown }>(JOURNAL_LINK_KEY);
    return link !== null && link.clientTripId === clientTripId && drives.some((d) => d.driveId === link.driveId);
  } catch {
    return false;
  }
}

/**
 * What native takes from a drive that closed at `at` (`stopCapture`'s end): its driving end (the
 * cut where the car last moved, or the End tap), and whether the car was still at driving speed as
 * it ended. A drive that is not kept passes null as its driving end.
 */
export function captureEndOf(session: Readonly<TripSession>, at: number, kept: boolean): CaptureEnd {
  const last = session.lastDroveAt;
  const drivingAtEnd = last !== null && session.lastSpeed !== null && session.lastSpeed.ts === last && at - last <= DRIVING_AT_END_MS;
  return { drivingEndedAt: kept ? (session.endedAt ?? at) : null, drivingAtEnd };
}
export type DisplayUnit = 'mph' | 'km/h';

/** A whole speed or limit in the display's unit; null stays null. */
export const inDisplayUnit = (mph: number | null, unit: DisplayUnit): number | null =>
  mph === null ? null : Math.round(unit === 'km/h' ? mph * KMH_PER_MPH : mph);

/**
 * At a launch, before any drive is recovered: a "Not driving?" the last process did not finish is
 * finished. Native is told first (iOS: the drive still recording is cancelled, an ended journal
 * deleted), then the trip goes whole, then the marker. Returns the cancelled trip's id, or null
 * when nothing was pending. Rejects (the marker kept for the next launch) when the trip cannot be
 * deleted.
 */
export async function finishPendingCancel(db: Db, detect: DriveDetectApi | null, onError?: (e: unknown, ctx: string) => void): Promise<string | null> {
  const c = await readCancelMarker(db);
  if (c === null) return null;
  if (detect !== null && detect.available && c.driveId !== null) {
    try {
      const state = await detect.getState();
      if ((state.state === 'recording' || state.state === 'ending') && state.driveId === c.driveId) await detect.notDriving();
      else await detect.discardDrive(c.driveId);
    } catch (e) {
      onError?.(e, 'notDriving');
    }
  }
  await dropTrip(db, c.clientTripId);
  await createSettingsRepo(db).remove(NOT_DRIVING_KEY).catch((e: unknown) => onError?.(e, 'notDriving'));
  await clearCancelMarker(db);
  return c.clientTripId;
}

/** The engine's end cause for native's own stop. */
export function endCauseOfNative(cause: EndCauseNative | 'js'): EndCause {
  if (cause === 'walking') return 'walking';
  if (cause === 'limit') return 'limit';
  if (cause === 'still') return 'stopped';
  return 'orphan';
}

interface JournalLink {
  driveId: string;
  clientTripId: string;
}

const parseLink = (raw: unknown): JournalLink | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.driveId === 'string' && typeof r.clientTripId === 'string' ? { driveId: r.driveId, clientTripId: r.clientTripId } : null;
};

/** A row with its bridge-only journal `seq` (iOS). */
type SeqRow = FeatureRow & { seq?: number };

/** A Start-card drive's wait for driving speed (host clock). */
interface Waiting {
  /** The tap, or the last touch. */
  since: number;
  timer: unknown;
  phase: WaitingPublic['phase'];
}

/**
 * iOS, RoadWise behind: the push-to-start of one drive. `due`: waiting for the task that
 * opened the drive (its confirming rows) to finish, then up to `PUSH_START_WAIT_MS` for a speed and
 * a limit; `asking`: the request is out; `retry`: one more ask after `PUSH_START_RETRY_MS`; `done`.
 */
interface PushStart {
  id: string;
  startedAt: number;
  phase: 'due' | 'asking' | 'retry' | 'done';
  /** The wait for a speed and a limit has begun (the opening task finished). */
  armed: boolean;
  timer: unknown;
  retried: boolean;
}

/** How the host begins a confirmed drive. */
interface Begin {
  ts: number;
  clientTripId?: string;
  origin: DriveOrigin;
  startSource: StartSource;
  /** The parked spot (a motion-history start), else null. */
  startPlace: { lat: number; lng: number } | null;
  continues: boolean;
}

export function createDriveHost(deps: DriveHostDeps): DriveHost {
  const { db, source, limits, player, now, tz, newId } = deps;
  const persist = (deps.persistence ?? 'full') === 'full';
  const detect = deps.detect && deps.detect.available ? deps.detect : null;
  const ios = detect !== null;
  const platform: 'ios' | 'android' = deps.platform ?? (Platform.OS === 'android' ? 'android' : 'ios');
  const scheduler = deps.scheduler ?? realScheduler;

  function report(error: unknown, ctx: string): void {
    try {
      deps.onError?.(error, ctx);
    } catch {
      // A reporter that throws has nobody left to report to.
    }
  }

  // --- host-owned state ---------------------------------------------------------------------------
  let booted = false;
  let captureOn = false;
  /** The finalized drive's end for the next `stopCapture`, or null. */
  let captureEnd: CaptureEnd | null = null;
  let callActive = false;
  let lastFinalized: LastFinalized = null;
  /** The closed drive whose finalize failed, kept for End to finalize again; null when none. */
  let unfinalized: Readonly<TripSession> | null = null;
  let soundFailedThisDrive = false;
  let signedOut = deps.signedOut === true;
  let signingOut = false;
  /** The driver's units, read as the drive starts; every display call of the drive uses it. */
  let displayUnit: DisplayUnit = 'mph';
  let startTripPending = false;
  let finalizedPending = false;
  let prevStatus: EngineStatus = 'idle';
  /** The last state's `speedingOver`: a speeding alert's held session is released when it turns false. */
  let prevSpeedingOver = false;
  /** Bumped by every speeding sound: only the newest one queued may still play. */
  let speedingSounds = 0;
  /** The Start-card drive's wait for driving speed, or null. */
  let waiting: Waiting | null = null;
  /** The drive closing is the wait's own end (it ran out, Cancel, a sign-out while it waits): Home says nothing. */
  let quietEnd = false;
  /** iOS: the native drive feeding the open trip, and the last journal `seq` taken in. */
  let liveDrive: { driveId: string; clientTripId: string; lastSeq: number } | null = null;
  /** iOS: native journals to delete once the host has settled (their drive is stored). */
  const discardQueue: string[] = [];
  /** Rows replayed from journals at this boot (capped). */
  let replayBudget = MAX_JOURNAL_REPLAY_ROWS;
  /** The open drive's "Not driving?" budget, or null. */
  let budget: NotDrivingBudget | null = null;
  let hudFocused = false;
  /** `hudVisible()` as last settled (the budget counts while it holds). */
  let visibleNow = false;
  /** The journal link was written for the open drive. */
  let linkWritten = false;
  /** A drive let go unended (`releaseDrive`): its journal link stays for the next launch. */
  let keepLink = false;
  let lastCountedRowTs: number | null = null;
  let lastAccrualAt = 0;
  let persistedSpent = 0;
  let budgetWrites: Promise<void> = Promise.resolve();
  /** The open drive's surfaces are live (not an ended journal drive replayed at boot). */
  let surfaces = false;
  /**
   * iOS: native drives were left alone while signed out (refused at a start, or not taken in at
   * boot): the same driver signing in again takes them in. Another driver's sign-in is a handover,
   * whose device wipe discards them. `deferredAdopt`: the recovered drive the signed-out boot left.
   */
  let journalsOwed = false;
  let deferredAdopt: AdoptedTrip | null = null;
  /** The open drive's push-to-start (iOS, RoadWise behind), or null; cleared when the drive closes or is cancelled. */
  let push: PushStart | null = null;
  /**
   * iOS: the open drive records through a plain capture (the Start fallback on a native build
   * without the journaled Start, or one whose answer could not be used): no detector drive, so
   * "Not driving?" stops the capture instead of telling native.
   */
  let plainCapture = false;
  let spotWatcher: SpotWatcher | null = null;
  let spotNudge: SpotNudge | null = null;
  let spotsLoad = 0;
  let weatherWatch: WeatherWatch | null = null;
  let weatherRaw: DangerAlert | null = null;
  let weatherDismissed: DangerKind | null = null;
  let lastFixAt: { lat: number; lng: number; ts: number } | null = null;
  /** The row the engine is taking in is a replay (a journal drained): no sound or reminder from it. */
  let replayingRow = false;
  let subscriptions: (() => void)[] = [];
  const idleWaiters = new Set<() => void>();
  const listeners = new Set<(s: DriveState) => void>();

  const appActive = (): boolean => (deps.appState?.currentState ?? 'active') === 'active';
  const hudVisible = (): boolean => hudFocused && appActive();

  // --- engine wiring -------------------------------------------------------------------------------

  async function onFinalize(session: Readonly<TripSession>): Promise<void> {
    if (!persist) return;
    const id = session.clientTripId;
    const closedAt = now();
    captureEnd = captureEndOf(session, closedAt, true);
    try {
      // The phone catches up to the dashcam (≤ 3 s) before the drive's facts are read.
      try {
        await deps.dashcam?.beforeFinalize(id, { dryRun: !persist });
      } catch (e) {
        report(e, 'dashcam');
      }
      const result = await closeDrive(session, {
        db,
        tz: tz(),
        now,
        appVersion: deps.appVersion,
        notDrivingExpired: budget !== null && budget.clientTripId === id && budget.expired,
        ...dashcamFinalizeDeps(db),
      });
      const endCause = session.endCause ?? 'manual';
      if (isDropped(result)) {
        captureEnd = captureEndOf(session, closedAt, false);
        lastFinalized = { clientTripId: id, ok: true, status: null, dropped: result.dropped, endCause, at: now(), durationS: null, miles: null, endedAt: null };
        // Home says why (not for a wait that ended: nothing to say); no OS notification (nothing was kept).
        if (!quietEnd) await writeDropNotice(db, { clientTripId: id, cause: endCause, reason: result.dropped, at: now(), origin: session.origin }).catch((e: unknown) => report(e, 'dropNotice'));
      } else {
        lastFinalized = {
          clientTripId: id,
          ok: true,
          status: result.trip.status,
          dropped: null,
          endCause,
          at: now(),
          durationS: result.trip.duration_s,
          miles: result.trip.miles,
          endedAt: result.trip.ended_at ?? session.endedAt ?? null,
        };
      }
      finalizedPending = true;
      if (unfinalized?.clientTripId === id) unfinalized = null;
      if (liveDrive !== null && liveDrive.clientTripId === id) discardQueue.push(liveDrive.driveId);
    } catch (error) {
      lastFinalized = { clientTripId: id, ok: false, at: now() };
      unfinalized = session;
      throw error;
    }
  }

  /**
   * "Not driving?": the drive goes whole; nothing is kept, sent or told. Order: a durable marker first, then native (iOS: it deletes the journal and
   * rests; Android's capture stops after the task, whatever happens here), then the trip, then the
   * marker. A kill anywhere in between is finished at the next launch (`finishPendingCancel`), and
   * a trip that cannot be deleted never leaves native recording.
   */
  async function onCancel(session: Readonly<TripSession>): Promise<void> {
    const id = session.clientTripId;
    const driveId = liveDrive !== null && liveDrive.clientTripId === id ? liveDrive.driveId : null;
    captureEnd = null;
    if (persist) await writeCancelMarker(db, { clientTripId: id, driveId }).catch((e: unknown) => report(e, 'notDriving'));
    // A plain capture (the Start fallback) is no detector drive: it stops after this task, as on Android.
    if (ios && detect !== null && !plainCapture) {
      // Native deletes the journal and rests until walking or 5 min still; it is no capture of ours to stop.
      captureOn = false;
      liveDrive = null;
      await detect.notDriving().catch((e: unknown) => report(e, 'notDriving'));
    }
    lastFinalized = { clientTripId: id, ok: true, status: null, dropped: 'cancelled', endCause: 'manual', at: now(), durationS: null, miles: null, endedAt: null };
    finalizedPending = persist;
    if (unfinalized?.clientTripId === id) unfinalized = null;
    if (persist) {
      // A failure here keeps the marker: the next launch deletes the trip.
      await dropTrip(db, id);
      await createSettingsRepo(db).remove(NOT_DRIVING_KEY).catch((e: unknown) => report(e, 'notDriving'));
      await clearCancelMarker(db).catch((e: unknown) => report(e, 'notDriving'));
    }
  }

  /** End on a drive whose finalize failed (no drive open): finalize it again, from memory. */
  async function finalizeAgain(session: Readonly<TripSession>): Promise<void> {
    try {
      await onFinalize(session);
    } finally {
      // The capture stopped with the first attempt: this end is for nothing to hand on.
      captureEnd = null;
      publish();
      if (finalizedPending) {
        finalizedPending = false;
        emitDataChanged({ source: 'finalize' }, (e) => report(e, 'dataChanged'));
      }
    }
  }

  const recorder = createRecorder(db, { tz: tz(), now });

  const engine = createEngine({
    now,
    newId,
    limits: {
      // The row's own fix: the stopped hold, the lost-fix reset and the point fallback read it.
      lookup: (lat, lng, course, fix) => limits.lookup(lat, lng, course, fix ?? { gnssValid: true, speedMps: null }),
      prefetch: (lat, lng, course) => {
        if (persist) limits.prefetch(lat, lng, course);
      },
    },
    createDetectors: () => createDetectors(newId),
    ctx: () => ({ platform }),
    onAlert(alert: AlertEvent) {
      if (alert.type === 'phone_pickup') {
        phoneAlert(alert);
        return;
      }
      // Speeding sounds never queue up: a newer one drops one that has not started, and one still
      // queued is dropped once the row is not over the line. A held session is released then.
      const decision = decisionFor(alert, { voiceEnabled: deps.voiceEnabled?.() ?? false });
      if (alert.type === 'speeding') {
        speedingSounds += 1;
        const mine = speedingSounds;
        decision.stillWanted = () => mine === speedingSounds && engine.snapshot().speedingOver;
      }
      // A DashPal continuous alert owns the sound: a phone alert meanwhile is haptic + visual only.
      if (dashcamAlertActive()) decision.silent = true;
      // RoadWise behind: nothing sounds or vibrates; the driving screen never replays what was missed.
      // Nor does a replayed row (a journal drained): it is old news, or played already; the engine
      // never shows it either.
      if (!appActive() || replayingRow) decision.suppressed = true;
      player.deliver(decision).catch((e: unknown) => report(e, 'player'));
    },
    onCheckpoint: (session) => (persist ? recorder.onCheckpoint(session) : Promise.resolve()),
    onFinalize,
    onCancel,
    // A Start-card drive still waiting for driving speed: its wait ends it (`endWait`), never the still or walking end.
    holdEnds: () => waiting !== null,
    onError: (e) => report(e, 'engine'),
  });

  /**
   * A phone pickup's alert (phone plan P4): it plays (the urgent tone, "Phone down", the haptic; a
   * repeat the tone and haptic) only while the driving screen shows, focused with RoadWise active.
   * RoadWise not active, or active on another screen: nothing plays and nothing is posted. A
   * replayed row (a journal drained) plays nothing either: it is
   * old news, maybe minutes old. The pickup counts the same either way.
   */
  function phoneAlert(alert: AlertEvent): void {
    const decision = decisionFor(alert, { voiceEnabled: deps.voiceEnabled?.() ?? false });
    // A DashPal continuous alert owns the sound: a phone alert meanwhile is haptic + visual only.
    if (dashcamAlertActive()) decision.silent = true;
    if (!hudVisible() || replayingRow) decision.suppressed = true;
    player.deliver(decision).catch((e: unknown) => report(e, 'player'));
  }

  // --- the published state ------------------------------------------------------------------------

  function waitingPublic(): WaitingPublic | null {
    if (waiting === null) return null;
    return { since: waiting.since, phase: waiting.phase, deadlineAt: waitingDeadline(waiting.since, waiting.phase) };
  }

  function shownWeather(): DangerAlert | null {
    if (weatherRaw === null || engine.snapshot().status !== 'recording') return null;
    return weatherDismissed === null || moreSevere(weatherRaw.kind, weatherDismissed) ? weatherRaw : null;
  }

  /** Never while a Start-card drive still waits for driving speed: its Cancel is the one discard then. */
  const notDrivingAvailable = (): boolean =>
    waiting === null && budget !== null && !budget.expired && engine.snapshot().status === 'recording' && budget.clientTripId === engine.snapshot().clientTripId;

  function build(): DriveState {
    const alertNow = shownWeather();
    return Object.freeze({
      ...engine.snapshot(),
      callActive,
      lastFinalized,
      alertsAvailable: (deps.alertsAvailable ?? true) && !soundFailedThisDrive,
      dryRun: !persist,
      waiting: waitingPublic(),
      notDrivingAvailable: notDrivingAvailable(),
      notDrivingSpentMs: budget?.spentMs ?? 0,
      spotNudge,
      weatherAlert: alertNow,
      weather: alertNow === null ? null : { kind: alertNow.kind, text: WEATHER_TITLES[alertNow.kind] },
    });
  }

  let current: DriveState = build();

  function publish(): void {
    current = build();
    for (const fn of [...listeners]) {
      try {
        fn(current);
      } catch (e) {
        report(e, 'subscriber');
      }
    }
  }

  /** The driver's units for this drive's display, read as it starts or is adopted; mph when unreadable. */
  async function readDisplayUnit(): Promise<void> {
    try {
      displayUnit = (await createSettingsRepo(db).get<unknown>(UNITS_KEY)) === 'km' ? 'km/h' : 'mph';
    } catch (e) {
      report(e, 'units');
      displayUnit = 'mph';
    }
  }

  function dashcamAlertActive(): boolean {
    try {
      return deps.dashcam?.continuousAlertActive() ?? false;
    } catch (e) {
      report(e, 'dashcam');
      return false;
    }
  }

  /** The driving screen's night look, for the Live Activity's tint: the theme's when it says, else the sun at the car. */
  function night(): boolean {
    const look = displayLook();
    if (typeof look?.night === 'boolean') return look.night;
    return lastFixAt === null ? false : sunIsDown(new Date(lastFixAt.ts), lastFixAt.lat, lastFixAt.lng);
  }

  /**
   * What the background surfaces show for `s`: the speed (null until the drive's first fix: the
   * Live Activity and the Android notification both show "-" then, where the driving screen shows
   * 0), the limit, its tint, the hint and the weather.
   */
  function displayState(s: EngineSnapshot): DriveDisplayState {
    const w = shownWeather();
    return {
      speed: s.speedKnown && s.speedAt !== null ? inDisplayUnit(mpsToMph(s.speedMps), displayUnit) : null,
      limit: inDisplayUnit(s.limitMph, displayUnit),
      unit: displayUnit,
      points: null,
      pointsDelta: null,
      stopped: s.stopped,
      speedTint: speedTintOf(s.speedingRatio, night()),
      speeding: s.speedingTier !== null,
      notDrivingAvailable: notDrivingAvailable(),
      weatherKind: w?.kind ?? null,
      weatherText: w === null ? null : WEATHER_TITLES[w.kind],
    };
  }

  /**
   * Never throws: a display that fails must not keep a change from being published, nor a drive from
   * closing. The halo's speed goes along, so the Live Activity's number is the halo's (display.ts).
   */
  function display(s: EngineSnapshot): void {
    if (!deps.display || !surfaces || s.status !== 'recording') return;
    try {
      const carry = s.speedKnown && s.speedAt !== null ? { mps: s.speedMps, accel: s.speedAccelMps2, at: s.speedAt } : null;
      deps.display.update(displayState(s), carry);
    } catch (e) {
      report(e, 'display');
    }
  }

  /** A change the lock screen must show now (the weather line, the hint running out). Never throws. */
  function refreshDisplay(): void {
    const s = engine.snapshot();
    if (!deps.display || !surfaces || s.status !== 'recording') return;
    try {
      const state = displayState(s);
      if (deps.display.refresh) deps.display.refresh(state);
      else deps.display.update(state);
    } catch (e) {
      report(e, 'display');
    }
  }

  engine.subscribe((s) => {
    let opened = false;
    let closed = false;
    if (s.status !== prevStatus) {
      if (s.status === 'recording' && prevStatus === 'idle') opened = true;
      if (s.status === 'idle' && prevStatus !== 'idle') closed = true;
      prevStatus = s.status;
    }
    if (opened) {
      // A drive left unfinalized stays `recording` in storage: the next launch recovers it.
      unfinalized = null;
      soundFailedThisDrive = false;
      startTripPending = true;
      spotNudge = null;
    }
    display(s);
    // The car is back under the speeding line (or the drive ended): its alert's held session goes.
    if (prevSpeedingOver && !s.speedingOver) player.release?.('speeding').catch((e: unknown) => report(e, 'player'));
    prevSpeedingOver = s.speedingOver;
    if (closed) closeSurfaces();
    publish();
    if (closed) afterClose();
  });

  /** Everything a drive opened beside the engine goes with it (a Start-card drive's wait too). */
  function closeSurfaces(): void {
    dropWaiting();
    limits.resetTrip();
    startTripPending = false;
    if (surfaces) {
      try {
        deps.display?.end();
      } catch (e) {
        report(e, 'display');
      }
    }
    surfaces = false;
    budget = null;
    lastCountedRowTs = null;
    persistedSpent = 0;
    spotWatcher = null;
    spotNudge = null;
    spotsLoad += 1;
    weatherWatch?.stop();
    weatherWatch = null;
    weatherRaw = null;
    weatherDismissed = null;
    lastFixAt = null;
    if (persist && linkWritten && !keepLink) void createSettingsRepo(db).remove(JOURNAL_LINK_KEY).catch((e: unknown) => report(e, 'journalLink'));
    linkWritten = false;
    liveDrive = null;
    plainCapture = false;
    clearPush();
  }

  function afterClose(): void {
    player.stopCurrent().catch((e: unknown) => report(e, 'player'));
    if (finalizedPending) {
      finalizedPending = false;
      emitDataChanged({ source: 'finalize' }, (e) => report(e, 'dataChanged'));
    }
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
  }

  // --- a drive's surfaces -------------------------------------------------------------------------

  /**
   * A drive just opened (started or adopted): its "Not driving?" budget comes back by trip id, the
   * display starts (or, behind on iOS, the server is asked for a push-to-start, whatever started
   * the drive), and
   * the weather watch and the spot nudges begin. `quiet`: an ended journal drive replayed at boot
   * (it closes at once): none of that.
   */
  async function driveOpened(opts: { adopted: boolean; quiet?: boolean }): Promise<void> {
    const s = engine.snapshot();
    const id = s.clientTripId;
    if (s.status !== 'recording' || id === null) return;
    if (opts.adopted) await deps.dashcam?.adopt(id).catch((e: unknown) => report(e, 'dashcam'));
    budget = persist ? await budgetFor(db, id, now()).catch(() => null) : null;
    budget ??= { clientTripId: id, spentMs: 0, expired: false, updatedAt: now() };
    persistedSpent = budget.spentMs;
    lastCountedRowTs = null;
    lastAccrualAt = now();
    if (opts.quiet) return;
    surfaces = true;
    // Nothing from here on is the drive itself: a surface that fails is reported, and the drive records on.
    if (deps.display) {
      try {
        if (!ios || appActive()) deps.display.start({ ...displayState(s), stopped: s.lastRowTs === null || s.stopped });
        // iOS cannot start an activity from the background: the server push-starts it, for an
        // automatic drive and a Start-card drive that confirmed behind (navigation open) alike, once
        // the rows that confirmed it are in (`flushPush`).
        else pushDue(id, s.startedAt ?? now());
      } catch (e) {
        report(e, 'display');
      }
    }
    if (persist) {
      try {
        weatherWatch = createWeatherWatch({
          now,
          lookup: deps.weather,
          lastPosition: deps.lastPosition,
          onAlert: (a) => {
            const before = shownWeather();
            weatherRaw = a;
            const after = shownWeather();
            if (before?.kind !== after?.kind || before?.gustMph !== after?.gustMph || before?.visibilityM !== after?.visibilityM) {
              publish();
              refreshDisplay();
            }
          },
        });
      } catch (e) {
        report(e, 'weather');
      }
      try {
        const gen = (spotsLoad += 1);
        const read = deps.spots ? deps.spots.readWatchSpots() : readWatchSpots(db);
        read
          .then((spots) => {
            if (gen === spotsLoad && engine.snapshot().status === 'recording') spotWatcher = createSpotWatcher(spots);
          })
          .catch((e: unknown) => report(e, 'spots'));
      } catch (e) {
        report(e, 'spots');
      }
    }
  }

  // --- the push-to-start (iOS, RoadWise behind) ---------------------------------------------------

  /** The open drive is to be push-started once its confirming rows are in (`flushPush`, after the task). */
  function pushDue(id: string, startedAt: number): void {
    if (!deps.pushToStart) return;
    if (push !== null && push.id === id) return;
    clearPush();
    push = { id, startedAt, phase: 'due', armed: false, timer: null, retried: false };
  }

  function clearPush(): void {
    const p = push;
    if (p === null) return;
    push = null;
    if (p.timer !== null) scheduler.clearTimeout(p.timer);
    p.timer = null;
    p.phase = 'done';
  }

  /** `p`'s timer: the speed-and-limit wait running out, or the retry coming due. */
  function pushTimer(p: PushStart, ms: number): void {
    if (p.timer !== null) scheduler.clearTimeout(p.timer);
    p.timer = scheduler.setTimeout(() => {
      p.timer = null;
      if (push === p) void run(() => flushPush(true), 'pushToStart');
    }, ms);
  }

  /**
   * After every queued task: the open drive's push-to-start goes once the task that opened the drive
   * (and drained its confirming rows) has finished and the drive shows a speed and a limit, or once
   * `PUSH_START_WAIT_MS` has passed (`force`); its retry only when it comes due (`force`). RoadWise in
   * front: the local start covers it (as the drive opens, and on each return to the front).
   */
  function flushPush(force: boolean): void {
    const p = push;
    if (p === null || p.phase === 'asking' || p.phase === 'done') return;
    const s = engine.snapshot();
    if (s.status !== 'recording' || s.clientTripId !== p.id || !surfaces || appActive()) {
      clearPush();
      return;
    }
    if (p.phase === 'retry' && !force) return;
    if (!p.armed) {
      p.armed = true;
      pushTimer(p, PUSH_START_WAIT_MS);
    }
    const shown = displayState(s);
    if (p.phase === 'due' && !force && (shown.speed === null || shown.limit === null)) return;
    if (p.timer !== null) scheduler.clearTimeout(p.timer);
    p.timer = null;
    p.phase = 'asking';
    void askPushToStart(p);
  }

  /**
   * The server push-starts the drive's Live Activity unless one already runs, with the drive's state
   * now (its speed and limit). A failure is reported with its reason; one a retry may fix is asked
   * once more after `PUSH_START_RETRY_MS`.
   */
  async function askPushToStart(p: PushStart): Promise<void> {
    const ask = deps.pushToStart;
    if (!ask) return;
    let outcome: PushToStartOutcome;
    try {
      if (await deps.display?.isRunning?.()) {
        if (push === p) p.phase = 'done';
        return;
      }
      if (push !== p) return;
      const look = displayLook();
      const state: LiveDriveState = {
        ...toLive(displayState(engine.snapshot())),
        weatherKind: null,
        weatherText: null,
        skyTop: look?.skyTop ?? null,
        skyMid: look?.skyMid ?? null,
        skyLow: look?.skyLow ?? null,
        accent: look?.accent ?? null,
      };
      const out = await ask({ clientTripId: p.id, leg: 0, startedAt: p.startedAt, state });
      outcome = typeof out === 'boolean' ? { sent: out, reason: out ? null : 'unknown', detail: null, retryable: !out } : out;
    } catch (e) {
      report(e, 'pushToStart');
      outcome = { sent: false, reason: 'error', detail: null, retryable: true };
    }
    // The drive closed meanwhile: this answer is for nothing.
    if (push !== p) return;
    if (outcome.sent) {
      p.phase = 'done';
      return;
    }
    const again = outcome.retryable && !p.retried;
    report(new Error(`push-to-start not sent: ${outcome.reason ?? 'unknown'}${outcome.detail ? ` (${outcome.detail})` : ''}${again ? `; asking again in ${PUSH_START_RETRY_MS / 1000} s` : ''}`), 'pushToStart');
    if (!again) {
      p.phase = 'done';
      return;
    }
    p.retried = true;
    p.phase = 'retry';
    pushTimer(p, PUSH_START_RETRY_MS);
  }

  // --- "Not driving?" budget ----------------------------------------------------------------------

  /** Never while a Start-card drive waits: nothing was spent, and the stored budget stays the last drive's. */
  function persistBudget(): void {
    const b = budget;
    if (!persist || b === null || waiting !== null) return;
    persistedSpent = b.spentMs;
    budgetWrites = budgetWrites.then(() => writeBudget(db, b)).catch((e: unknown) => report(e, 'notDriving'));
  }

  /** Visible time spent from the budget; none while a Start-card drive still waits (the link is not offered then). */
  function accrue(dt: number): void {
    const b = budget;
    if (b === null || b.expired || dt <= 0 || waiting !== null || engine.snapshot().status !== 'recording') return;
    budget = spend(b, dt, now());
    if (budget.expired) {
      persistBudget();
      const id = budget.clientTripId;
      if (persist) {
        budgetWrites = budgetWrites
          .then(async () => {
            await createTripsRepo(db).update(id, { not_driving_expired: 1 }, now());
          })
          .catch((e: unknown) => report(e, 'notDriving'));
      }
      publish();
      refreshDisplay();
    } else if (budget.spentMs - persistedSpent >= NOT_DRIVING_PERSIST_EVERY_MS) {
      persistBudget();
    }
  }

  /** The visible flag may have changed (the driving screen's focus, or RoadWise's app state): settle the time so far. */
  function updateVisibility(): void {
    const is = hudVisible();
    if (is === visibleNow) return;
    if (visibleNow) accrue(Math.min(ROW_MS, Math.max(0, now() - lastAccrualAt)));
    visibleNow = is;
    lastCountedRowTs = null;
    lastAccrualAt = now();
    persistBudget();
    publish();
  }

  /** A live row while the drive records: visible time on the row clock, one row's worth at most. */
  function accrueRow(row: FeatureRow): void {
    if (!hudVisible() || waiting !== null) {
      lastCountedRowTs = null;
      return;
    }
    // The first row since the screen showed counts the host clock since then; later rows the row clock.
    const dt = Math.min(ROW_MS, Math.max(0, lastCountedRowTs === null ? now() - lastAccrualAt : row.ts - lastCountedRowTs));
    lastCountedRowTs = row.ts;
    lastAccrualAt = now();
    accrue(dt);
  }

  // --- the queue ---------------------------------------------------------------------------------

  let chain: Promise<void> = Promise.resolve();

  /** Run `fn` after everything queued before it, then reconcile the capture. Never rejects. */
  function run(fn: () => Promise<void> | void, what: string): Promise<void> {
    const task = chain
      .then(fn)
      .catch((e: unknown) => report(e, what))
      .then(afterTask);
    chain = task.then(noop, noop);
    return task;
  }

  const ticker = createTicker({
    now,
    scheduler: deps.scheduler,
    onTick: (ts) => {
      void run(() => engine.dispatch({ type: 'tick', ts }), 'tick');
    },
  });

  async function afterTask(): Promise<void> {
    if (!booted) return;
    const s = engine.snapshot();
    await reconcileCapture(s.status);
    ticker.update(s.status === 'recording' ? s.autoEndAt : null);
    // The task that opened a drive behind has taken its confirming rows in: its push-to-start may go.
    flushPush(false);
    // Stored drives' journals go (never the live one: native would refuse it).
    if (detect !== null && discardQueue.length > 0) {
      for (const id of discardQueue.splice(0)) {
        if (liveDrive !== null && liveDrive.driveId === id) discardQueue.push(id);
        else await detect.discardDrive(id).catch((e: unknown) => report(e, 'discardDrive'));
      }
    }
  }

  /**
   * The capture follows the engine: on while a drive records, off after. iOS never starts one
   * (native owns it); its `stopCapture` tells native the JS end and the cut.
   */
  async function reconcileCapture(status: EngineStatus): Promise<void> {
    const want = status === 'recording';
    if (want === captureOn) return;
    if (want && ios) return;
    try {
      if (want) {
        captureEnd = null;
        await source.startCapture('mounted');
      } else {
        const end = captureEnd;
        captureEnd = null;
        await source.stopCapture(end ?? undefined);
      }
      captureOn = want;
    } catch (e) {
      report(e, want ? 'startCapture' : 'stopCapture');
    }
  }

  /**
   * The phone's previous drive ended within `MERGE_GAP_S` of `at`: the new drive has no warm-up,
   * so End then Start never buys 30 s without events. Unreadable: false.
   */
  async function continuesPrevious(at: number): Promise<boolean> {
    if (!persist) return false;
    try {
      const last = await createTripsRepo(db).lastEndedAt();
      return last !== null && at - last <= MERGE_GAP_S * 1000 && at >= last;
    } catch (e) {
      report(e, 'continues');
      return false;
    }
  }

  const rebuildDeps: RebuildDeps = {
    createDetectors: () => createDetectors(newId),
    platform,
    limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
  };

  /** A confirmed drive starts as a new trip of its own. Runs inside the queue. */
  async function beginDrive(b: Begin, opts: { quiet?: boolean } = {}): Promise<void> {
    if (engine.snapshot().status !== 'idle') return;
    await readDisplayUnit();
    const continues = b.continues || (await continuesPrevious(b.ts));
    await engine.dispatch({ type: 'start', ts: b.ts, clientTripId: b.clientTripId, origin: b.origin, continues, startSource: b.startSource, startPlace: b.startPlace });
    if (engine.snapshot().status !== 'recording') return;
    await driveOpened({ adopted: false, quiet: opts.quiet });
    // A new drive replaces Home's notice about the last one that was not kept.
    if (persist) await clearDropNotice(db).catch((e: unknown) => report(e, 'dropNotice'));
  }

  /** Continue a drive rebuilt from its stored rows (a relaunch mid-drive). */
  async function adoptTrip(trip: AdoptedTrip, opts: { quiet?: boolean } = {}): Promise<void> {
    if (engine.snapshot().status !== 'idle') return;
    await readDisplayUnit();
    await engine.dispatch({ type: 'adopt', trip, ts: now() });
    await driveOpened({ adopted: true, quiet: opts.quiet });
  }

  // --- the waiting session ------------------------------------------------------------------------

  function armWaitingTimer(): void {
    const w = waiting;
    if (w === null) return;
    if (w.timer !== null) scheduler.clearTimeout(w.timer);
    const at = nextWaitingChange(w.since, now());
    w.timer = scheduler.setTimeout(
      () => {
        w.timer = null;
        void run(() => evaluateWaiting(), 'waiting');
      },
      Math.max(ROW_MS, at - now())
    );
  }

  /** The wait's phase now: the sheet, the countdown, or the unsaved end at 5 min. */
  async function evaluateWaiting(): Promise<void> {
    const w = waiting;
    if (w === null) return;
    const phase = waitingPhaseAt(w.since, now());
    if (phase === 'expired') {
      await endWait();
      return;
    }
    if (phase !== w.phase) {
      w.phase = phase;
      publish();
    }
    if (w.timer === null) armWaitingTimer();
  }

  /**
   * The wait runs out (5 min with no driving speed and no touch), is cancelled (the panel's Cancel,
   * End swiped as Cancel) or a sign-out comes while it waits: the drive ends at once and, never
   * having reached driving speed, is not kept (`closeDrive` drops it). Home says nothing about it.
   */
  async function endWait(): Promise<void> {
    if (waiting === null) return;
    dropWaiting();
    if (engine.snapshot().status !== 'recording') {
      publish();
      return;
    }
    quietEnd = true;
    try {
      await engine.dispatch({ type: 'end', ts: now() });
    } finally {
      quietEnd = false;
    }
  }

  /** The wait goes, unpublished (the caller publishes, or the drive closing does). */
  function dropWaiting(): void {
    const w = waiting;
    if (w === null) return;
    waiting = null;
    if (w.timer !== null) scheduler.clearTimeout(w.timer);
  }

  /**
   * A row of a Start-card drive still waiting: the wait's phase (Android pumps its timers with the
   * rows), and the wait's end once the drive has reached driving speed.
   */
  async function waitingRow(drove: boolean): Promise<void> {
    if (waiting === null) return;
    if (!drove) {
      await evaluateWaiting();
      return;
    }
    dropWaiting();
    // "Not driving?" is offered from here, its visible time counted from now.
    lastCountedRowTs = null;
    lastAccrualAt = now();
    publish();
    refreshDisplay();
  }

  // --- rows ----------------------------------------------------------------------------------------

  /**
   * The speed-limit tiles around the phone's cached position, while the capture waits for its
   * first fix (which asks again from the fix itself: tiles already held cost nothing).
   */
  function fetchLimitsNearby(): void {
    if (!deps.lastPosition || !persist) return;
    let position: Promise<{ lat: number; lng: number } | null>;
    try {
      position = deps.lastPosition();
    } catch (e) {
      report(e, 'lastPosition');
      return;
    }
    position
      .then((p) => {
        if (p !== null && (startTripPending || waiting !== null)) limits.startTrip(p.lat, p.lng, -1);
      })
      .catch((e: unknown) => report(e, 'lastPosition'));
  }

  /**
   * One row through the engine and everything beside it. `replay`: a journal row (no live budget
   * time, no nudge, and not the trip's first tile batch: that is asked for where the car is now,
   * from the first live row).
   */
  async function onRow(row: FeatureRow, opts: { replay?: boolean } = {}): Promise<void> {
    if (startTripPending && row.gnssValid && opts.replay !== true) {
      startTripPending = false;
      if (persist) limits.startTrip(row.lat, row.lng, row.course);
    }
    // Visible time first, so the state the row publishes carries it.
    if (!opts.replay && engine.snapshot().status === 'recording') accrueRow(row);
    replayingRow = opts.replay === true;
    try {
      // RoadWise behind: the row's alerts are never shown or shaken, then or when the driver comes back.
      await engine.dispatch({ type: 'row', row, replay: opts.replay === true, unseen: !appActive() });
    } finally {
      replayingRow = false;
    }
    const snap = engine.snapshot();
    const recording = snap.status === 'recording';
    if (recording) {
      if (row.gnssValid) lastFixAt = { lat: row.lat, lng: row.lng, ts: row.ts };
      weatherWatch?.onRow(row, snap.distanceM);
      if (!opts.replay && spotWatcher !== null) {
        const nudge = spotWatcher.push({
          ts: row.ts,
          lat: row.lat,
          lng: row.lng,
          hAcc: row.hAcc,
          gnssValid: row.gnssValid,
          speedMps: row.speed,
          courseDeg: row.course >= 0 ? row.course : snap.courseDeg,
          recording: true,
          foreground: appActive(),
          busy: (snap.lastAlert !== null && row.ts - snap.lastAlert.at < ALERT_GLOW_MS + NUDGE_AFTER_ALERT_MS) || dashcamAlertActive(),
          speedingOver: snap.speedingOver,
        });
        if (nudge !== null) {
          spotNudge = nudge;
          publish();
        }
      }
    }
    if (deps.dashcam) {
      try {
        deps.dashcam.row(row, { clientTripId: snap.clientTripId, recording, dryRun: !persist });
      } catch (e) {
        report(e, 'dashcam');
      }
    }
    if (waiting !== null && recording) await waitingRow(snap.drove);
  }

  /**
   * Journal rows of `driveId` after `afterSeq`, oldest first, through `onRow` (as replays), until
   * the file holds no more (`done`), the boot's cap is spent (`capped`: the live drive only) or a
   * read fails. Pages of `JOURNAL_READ_ROWS`; between pages the JS thread is let go once (always,
   * unless `pace` is false), so a long drive read at a launch, a gap filled after a backlog or the
   * rows a confirmation journaled never hold the screen, its speed or its compass. Returns the last
   * `seq` taken in and whether the file was read to its end.
   */
  async function drainJournal(driveId: string, afterSeq: number, opts: { capped: boolean; pace?: boolean }): Promise<{ last: number; done: boolean }> {
    if (detect === null) return { last: afterSeq, done: true };
    let last = afterSeq;
    for (let first = true; ; first = false) {
      if (opts.capped && replayBudget <= 0) return { last, done: false };
      if (!first && opts.pace !== false) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const limit = opts.capped ? Math.max(1, Math.min(JOURNAL_READ_ROWS, replayBudget)) : JOURNAL_READ_ROWS;
      let page: { rows: unknown[]; lastSeq: number; done: boolean };
      try {
        page = await detect.readRows(driveId, last, limit);
      } catch (e) {
        report(e, 'readRows');
        return { last, done: false };
      }
      for (const raw of page.rows) {
        const row: SeqRow | null = parseRow(raw);
        if (row === null) continue;
        const seq = row.seq;
        if (typeof seq === 'number') {
          if (seq <= last) continue;
          last = seq;
        }
        if (liveDrive !== null && liveDrive.driveId === driveId) liveDrive.lastSeq = last;
        if (opts.capped) replayBudget -= 1;
        await onRow(row, { replay: true });
      }
      if (page.lastSeq > last) last = page.lastSeq;
      if (liveDrive !== null && liveDrive.driveId === driveId) liveDrive.lastSeq = last;
      if (page.done || page.rows.length === 0) return { last, done: true };
    }
  }

  /**
   * A live `row` event. iOS: a journal row (with `seq`) belongs only to the native drive the host
   * holds, in journal order (a gap is filled from the journal first, a repeat dropped); with none
   * held it is dropped, never added to another open trip (its journal is read when it is taken in).
   */
  async function onLiveRow(row: SeqRow): Promise<void> {
    const seq = row.seq;
    const live = liveDrive;
    if (ios && typeof seq === 'number') {
      if (live === null || engine.snapshot().status !== 'recording') return;
      if (seq <= live.lastSeq) return;
      if (seq > live.lastSeq + 1) {
        await drainJournal(live.driveId, live.lastSeq, { capped: false });
        if (liveDrive === null || seq <= liveDrive.lastSeq) return;
      }
      if (liveDrive !== null) liveDrive.lastSeq = seq;
    }
    await onRow(row);
  }

  // --- iOS: the drive detector ---------------------------------------------------------------------

  async function writeLink(driveId: string, clientTripId: string): Promise<void> {
    if (!persist) return;
    linkWritten = true;
    await createSettingsRepo(db)
      .set(JOURNAL_LINK_KEY, { driveId, clientTripId })
      .catch((e: unknown) => report(e, 'journalLink'));
  }

  const beginOf = (j: Pick<JournaledDrive, 'driveId' | 'origin' | 'startedAt' | 'startSource' | 'startLat' | 'startLng' | 'continues'>): Begin => {
    const fix = j.startLat === null || j.startLng === null ? null : { lat: j.startLat, lng: j.startLng };
    return { ts: j.startedAt, clientTripId: j.driveId, origin: j.origin, startSource: j.startSource, startPlace: j.startSource === 'motion' ? fix : null, continues: j.continues };
  };

  /**
   * A native drive starts (or is found at boot with no trip of its own): begin it and take its
   * journal in (paced). True whenever the drive records afterwards: a step beside it that throws is
   * reported and never leaves native recording a drive JS does not hold (the journal is linked
   * whatever happened after the drive opened, and rows a failed read missed come with the next live
   * row's gap).
   */
  async function beginNative(j: Pick<JournaledDrive, 'driveId' | 'origin' | 'startedAt' | 'startSource' | 'startLat' | 'startLng' | 'continues'>, opts: { capped: boolean; quiet?: boolean }): Promise<boolean> {
    try {
      await beginDrive(beginOf(j), { quiet: opts.quiet });
    } catch (e) {
      report(e, 'begin');
    }
    const s = engine.snapshot();
    if (s.status !== 'recording' || s.clientTripId === null) return false;
    liveDrive = { driveId: j.driveId, clientTripId: s.clientTripId, lastSeq: 0 };
    plainCapture = false;
    await writeLink(j.driveId, s.clientTripId);
    try {
      await drainJournal(j.driveId, 0, { capped: opts.capped });
    } catch (e) {
      report(e, 'readRows');
    }
    return true;
  }

  async function onDriveStarted(e: DriveStartedEvent): Promise<void> {
    if (liveDrive !== null && liveDrive.driveId === e.driveId) return;
    // Signed out, no drive is recorded: native's journal waits for this driver's next sign-in (a
    // different driver's sign-in wipes it).
    if (signedOut) {
      journalsOwed = true;
      return;
    }
    if (engine.snapshot().status !== 'idle') {
      report(new Error('a native drive started while another is open'), 'driveStarted');
      return;
    }
    // An event native held for the first listener, about a drive whose journal is gone (a device
    // wipe at an account switch, a "Not driving?"): nothing to take in.
    if (detect !== null) {
      const drives = await detect.listDrives().catch(() => null);
      if (drives !== null && !drives.some((d) => d.driveId === e.driveId)) return;
    }
    if (await beginNative(e, { capped: false })) captureOn = true;
  }

  async function onDriveEnded(e: DriveEndedEvent): Promise<void> {
    const live = liveDrive;
    if (live === null || live.driveId !== e.driveId) {
      // Not the drive we hold: an ended journal is taken in at the next boot (or now, while idle);
      // signed out, at the same driver's next sign-in.
      if (signedOut) {
        journalsOwed = true;
        return;
      }
      if (e.cause !== 'cancelled' && engine.snapshot().status === 'idle' && detect !== null) {
        const j = (await detect.listDrives().catch(() => [] as JournaledDrive[])).find((x) => x.driveId === e.driveId && x.ended !== null);
        if (j) await adoptEndedJournal(j, null);
      }
      return;
    }
    if (e.cause === 'cancelled') {
      // Native discarded it ("Not driving?" from here already dropped the trip).
      captureOn = false;
      liveDrive = null;
      if (engine.snapshot().status === 'recording' && engine.snapshot().clientTripId === live.clientTripId) await engine.dispatch({ type: 'cancel', ts: now() });
      return;
    }
    const drained = await drainJournal(live.driveId, live.lastSeq, { capped: false, pace: true });
    captureOn = false;
    if (!drained.done) {
      // Rows still unread: never ended short. The ended journal is finished at the next launch.
      await releaseDrive();
      return;
    }
    // Native stopped sensing on its own: the engine still decides the cut, at the last movement.
    await engine.dispatch({ type: 'end', ts: e.endedAt, cause: endCauseOfNative(e.cause) });
  }

  /**
   * A drive native ended while JS was away (or one still journaled): taken in from where SQLite
   * stops, ended where native ended it (the engine cuts at the last movement), finalized, and its
   * journal deleted. A drive already stored is just deleted from the journal.
   */
  async function adoptEndedJournal(j: JournaledDrive, recovered: AdoptedTrip | null): Promise<AdoptedTrip | null> {
    if (j.ended === null || engine.snapshot().status !== 'idle' || detect === null) return recovered;
    const link = persist ? parseLink(await createSettingsRepo(db).get<unknown>(JOURNAL_LINK_KEY).catch(() => null)) : null;
    const tripId = link !== null && link.driveId === j.driveId ? link.clientTripId : j.driveId;
    let afterSeq = 0;
    if (recovered !== null && recovered.session.clientTripId === tripId) {
      await adoptTrip(recovered, { quiet: true });
      afterSeq = recovered.session.lastSeq ?? 0;
      recovered = null;
    } else {
      const trip = persist ? await createTripsRepo(db).get(tripId) : null;
      if (trip === null) {
        await beginDrive(beginOf(j), { quiet: true });
      } else if (trip.status === 'recording') {
        const rebuilt = await rebuildFromSamples(db, trip, rebuildDeps);
        if (rebuilt === null) await beginDrive(beginOf(j), { quiet: true });
        else {
          await adoptTrip(rebuilt, { quiet: true });
          afterSeq = trip.last_seq ?? 0;
        }
      } else {
        discardQueue.push(j.driveId);
        return recovered;
      }
    }
    const s = engine.snapshot();
    if (s.status !== 'recording' || s.clientTripId === null) return recovered;
    liveDrive = { driveId: j.driveId, clientTripId: s.clientTripId, lastSeq: afterSeq };
    // Read to its end, however long: a drive is never finalized (nor its journal deleted) with
    // rows still unread.
    const drained = await drainJournal(j.driveId, afterSeq, { capped: false, pace: true });
    if (!drained.done) {
      // The journal could not be read to its end: the drive stays stored as far as it was read,
      // unended, and its journal stays for the next launch to finish it.
      await releaseDrive();
      return recovered;
    }
    if (engine.snapshot().status === 'recording') await engine.dispatch({ type: 'end', ts: j.ended.endedAt, cause: endCauseOfNative(j.ended.cause) });
    return recovered;
  }

  /**
   * The open drive goes from memory unended (its journal could not be read to its end): stored as
   * far as read and still `recording`, with its journal and the journal link kept, so the next
   * launch takes it up where it stopped.
   */
  async function releaseDrive(): Promise<void> {
    keepLink = true;
    try {
      await engine.dispatch({ type: 'release', ts: now() });
    } finally {
      keepLink = false;
      liveDrive = null;
    }
  }

  /** iOS at boot: every ended journal first (oldest first), then the recovered drive, then the live one. */
  async function bootIos(recoveredIn: AdoptedTrip | null): Promise<void> {
    if (detect === null) return;
    let recovered = recoveredIn;
    let d: Awaited<ReturnType<DriveDetectApi['getState']>> | null = null;
    let drives: JournaledDrive[] = [];
    try {
      d = await detect.getState();
      drives = await detect.listDrives();
    } catch (e) {
      report(e, 'detect');
    }
    const liveId = d !== null && (d.state === 'recording' || d.state === 'ending') ? d.driveId : null;
    const ended = drives.filter((j) => j.ended !== null && j.driveId !== liveId).sort((a, b) => a.startedAt - b.startedAt);
    for (const j of ended) {
      recovered = await adoptEndedJournal(j, recovered);
      if (engine.snapshot().status !== 'idle') break;
    }
    if (recovered !== null && engine.snapshot().status === 'idle') await adoptTrip(recovered);
    if (liveId === null || d === null) {
      // Native still holds a capture that is no detector drive: the plain capture of a Start
      // fallback the last process recorded, now feeding the drive it recovered.
      plainCapture = d !== null && captureOn && liveDrive === null && engine.snapshot().status === 'recording';
      return;
    }
    const link = persist ? parseLink(await createSettingsRepo(db).get<unknown>(JOURNAL_LINK_KEY).catch(() => null)) : null;
    const tripId = link !== null && link.driveId === liveId ? link.clientTripId : liveId;
    const j: JournaledDrive | undefined = drives.find((x) => x.driveId === liveId);
    const s = engine.snapshot();
    if (s.status === 'recording' && s.clientTripId === tripId) {
      liveDrive = { driveId: liveId, clientTripId: tripId, lastSeq: engine.session()?.lastSeq ?? 0 };
      captureOn = true;
      await drainJournal(liveId, liveDrive.lastSeq, { capped: true });
      return;
    }
    if (s.status !== 'idle') {
      report(new Error('the live native drive is not the open one'), 'detect');
      return;
    }
    const trip = persist ? await createTripsRepo(db).get(tripId) : null;
    if (trip !== null && trip.status === 'recording') {
      const rebuilt = await rebuildFromSamples(db, trip, rebuildDeps);
      if (rebuilt !== null) {
        await adoptTrip(rebuilt);
        liveDrive = { driveId: liveId, clientTripId: tripId, lastSeq: trip.last_seq ?? 0 };
        captureOn = true;
        await drainJournal(liveId, liveDrive.lastSeq, { capped: true });
        return;
      }
    } else if (trip !== null) {
      report(new Error('the live native drive is already stored'), 'detect');
      return;
    }
    const begin = j ?? { driveId: liveId, origin: d.origin ?? 'auto', startedAt: d.startedAt ?? now(), startSource: 'wake' as const, startLat: null, startLng: null, continues: false };
    if (await beginNative(begin, { capped: true })) captureOn = true;
  }

  /** Signed in again (the same driver): the native drives left alone while signed out are taken in, as at a boot. */
  async function takeInOwedJournals(): Promise<void> {
    if (!ios || !booted || !journalsOwed || engine.snapshot().status !== 'idle') return;
    journalsOwed = false;
    const adopt = deferredAdopt;
    deferredAdopt = null;
    replayBudget = MAX_JOURNAL_REPLAY_ROWS;
    await bootIos(adopt);
  }

  // --- native events -------------------------------------------------------------------------------

  function attachNative(): void {
    const remover = (sub: { remove(): void }) => () => sub.remove();
    subscriptions.push(
      remover(
        source.addListener('row', (raw) => {
          // First, on every row: a timer the alert player or the dashcam waits on fires here when
          // JS timers are paused (Android, app in the background).
          try {
            (deps.pump ?? processTimers.pump)();
          } catch (e) {
            report(e, 'timers');
          }
          const row: SeqRow | null = parseRow(raw);
          if (row === null) return;
          void run(() => onLiveRow(row), 'row');
        })
      ),
      remover(
        // Each fix's speed the moment it lands, straight to the screen's number: not queued behind
        // the rows (a checkpoint's write must not hold it), and timed at the fix. iPhone: the fix's
        // own time (`CLLocation.timestamp`, the same wall clock as ours; never later than now), so a
        // busy JS thread never bunches the fixes up. Android: arrival less its age, as its capture
        // stamps fixes on its own anchored clock.
        source.addListener('speed', (raw) => {
          const s = parseSpeed(raw);
          if (s === null) return;
          try {
            const at = platform === 'ios' ? Math.min(now(), s.ts) : now() - s.ageMs;
            engine.speed({ at, mps: s.speed, acc: s.speedAcc, hAcc: s.hAcc });
          } catch (e) {
            report(e, 'speed');
          }
        })
      ),
      remover(
        // Every valid report goes to the engine, which reads it for the walking end alone
        // (`core/engine/motion.ts`); a malformed payload is dropped. With motion not granted none come.
        source.addListener('activity', (raw) => {
          const activity = parseActivity(raw);
          if (activity === null) return;
          void run(() => engine.dispatch({ type: 'motion', activity, ts: now() }), 'activity');
        })
      ),
      remover(
        // Android's drive notification offers End drive while stopped: a manual end at the tap, with
        // the same rules as the swipe (cut after 2 min standing still, dropped if it never moved;
        // while a Start-card drive still waits, its Cancel: unsaved, saying nothing). A tap buffered
        // from before this drive, or one landing while it is already closing, does nothing.
        source.addListener('notificationAction', (a) => {
          if (a.action !== 'endDrive') return;
          void run(async () => {
            const s = engine.snapshot();
            if (s.status !== 'recording' || s.startedAt === null || !(a.ts >= s.startedAt)) return;
            if (waiting !== null) await endWait();
            else await engine.dispatch({ type: 'end', ts: now() });
          }, 'notificationEnd');
        })
      ),
      remover(
        source.addListener('call', (p) => {
          const ended = callActive && !p.active;
          callActive = p.active;
          publish();
          if (ended) player.stopCurrent().catch((e: unknown) => report(e, 'player'));
        })
      )
    );
    if (detect !== null) {
      subscriptions.push(
        remover(detect.addListener('driveStarted', (e) => void run(() => onDriveStarted(e), 'driveStarted'))),
        remover(detect.addListener('driveEnded', (e) => void run(() => onDriveEnded(e), 'driveEnded')))
      );
    }
    if (deps.appState) {
      let wasActive = appActive();
      const sub = deps.appState.addEventListener('change', () => {
        const active = appActive();
        updateVisibility();
        if (active && !wasActive) {
          void run(async () => {
            // Back in front during a drive: the Live Activity is adopted (pushed) or started here,
            // which also stands in for a push-to-start still waiting or to be asked again.
            const s = engine.snapshot();
            if (s.status === 'recording' && surfaces && deps.display) {
              clearPush();
              deps.display.start({ ...displayState(s), stopped: s.lastRowTs === null || s.stopped });
            }
            await evaluateWaiting();
          }, 'foreground');
        }
        wasActive = active;
        publish();
      });
      subscriptions.push(() => sub.remove());
    }
  }

  // --- the Start card ------------------------------------------------------------------------------

  /** A start's steps beside the drive (the wait's timer first): one that throws is reported and refuses nothing. */
  function afterStart(): void {
    for (const step of [armWaitingTimer, fetchLimitsNearby, publish]) {
      try {
        step();
      } catch (e) {
        report(e, 'start');
      }
    }
  }

  /**
   * iOS, inside the queue: native opens a journaled drive at the tap (`startWaiting`) and it is
   * taken in. An answer without the drive (a native build from before the drive opened at the tap
   * answers `{ ok, waitUntil }` alone), or none at all, asks native what it holds: its manual drive
   * is taken in the same way; anything else cancels native's own wait (an older build waits in a
   * manual candidate of its own, which would confirm a second drive later) and a plain capture
   * records the drive instead. Refuses only for a real reason: no permission, a drive already
   * recording, or a capture that could not start. Null: started.
   */
  async function startDetected(d: DriveDetectApi): Promise<StartRefusalReason | null> {
    let r: Awaited<ReturnType<DriveDetectApi['startWaiting']>> | null = null;
    try {
      r = await d.startWaiting();
    } catch (e) {
      report(e, 'startWaiting');
    }
    if (r !== null && !r.ok) {
      if (r.reason === 'permission') return 'permission';
      if (r.reason === 'busy') return 'busy';
      // 'unavailable': native could not open its drive; a plain capture records it instead.
    }
    let open: { driveId: string; startedAt: number; waitUntil: number } | null =
      r !== null && r.ok && r.driveId !== null && r.startedAt !== null ? { driveId: r.driveId, startedAt: r.startedAt, waitUntil: r.waitUntil } : null;
    if (open === null) {
      let st: Awaited<ReturnType<DriveDetectApi['getState']>> | null = null;
      try {
        st = await d.getState();
      } catch (e) {
        report(e, 'detect');
      }
      if (st !== null && (st.state === 'recording' || st.state === 'ending')) {
        // Native records a drive: the one this tap opened (its answer lost) is taken in; any other is a drive already running.
        if (st.state !== 'recording' || st.origin !== 'manual' || st.driveId === null || st.startedAt === null) return 'busy';
        open = { driveId: st.driveId, startedAt: st.startedAt, waitUntil: (r !== null && r.ok ? r.waitUntil : null) ?? st.waitUntil ?? now() + WAIT_TOTAL_MS };
      } else {
        await d.cancelWaiting().catch((e: unknown) => report(e, 'cancelWaiting'));
        return startPlain();
      }
    }
    // Native opened the drive at the tap (journaled); it is taken in now, its rows follow live.
    waiting = { since: open.waitUntil - WAIT_TOTAL_MS, timer: null, phase: 'waiting' };
    const begin = { driveId: open.driveId, origin: 'manual' as const, startedAt: open.startedAt, startSource: 'wake' as const, startLat: null, startLng: null, continues: false };
    if (!(await beginNative(begin, { capped: false }))) {
      // Not taken in after all: native stops it and its journal goes (nothing was kept).
      dropWaiting();
      await source.stopCapture().catch((e: unknown) => report(e, 'stopCapture'));
      await d.discardDrive(open.driveId).catch((e: unknown) => report(e, 'discardDrive'));
      return 'error';
    }
    captureOn = true;
    afterStart();
    return null;
  }

  /**
   * Inside the queue: the capture starts and the drive opens at the tap (Android; iOS when native
   * has no journaled Start to give). iOS answers a start its drive detector's own sensing holds
   * without capturing anything, so there the capture must be seen running before the drive opens.
   * Null: started.
   */
  async function startPlain(): Promise<StartRefusalReason | null> {
    try {
      await source.startCapture('mounted');
    } catch (e) {
      report(e, 'startCapture');
      return (e as { code?: unknown } | null)?.code === 'E_PERMISSION' ? 'permission' : 'error';
    }
    if (ios) {
      let capturing = false;
      try {
        capturing = (await source.getState()).capturing;
      } catch (e) {
        report(e, 'getState');
      }
      if (!capturing) {
        report(new Error('the Start fallback capture is not running'), 'startCapture');
        return 'error';
      }
      plainCapture = true;
    }
    captureOn = true;
    waiting = { since: now(), timer: null, phase: 'waiting' };
    try {
      await beginDrive({ ts: now(), origin: 'manual', startSource: 'wake', startPlace: null, continues: false });
    } catch (e) {
      report(e, 'start');
    }
    // Not begun: the capture stops after this task (`reconcileCapture`).
    if (engine.snapshot().status !== 'recording') {
      dropWaiting();
      plainCapture = false;
      return 'error';
    }
    afterStart();
    return null;
  }

  // --- the host ------------------------------------------------------------------------------------

  async function settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = chain;
      await seen;
    } while (seen !== chain);
  }

  const self: DriveHost = {
    async boot(opts = {}) {
      if (booted) return;
      booted = true;
      // The boot's own work goes on the queue first, and native's listeners attach right after it,
      // before the journals are drained: a live `speed` reading (dropped by native with no listener)
      // reaches the screen as soon as a drive records, and every event native held for the first
      // listener (and every row) queues behind the boot, as it always did.
      const work = run(async () => {
        try {
          const state = await source.getState();
          captureOn = state.capturing;
        } catch (e) {
          report(e, 'getState');
        }
        replayBudget = MAX_JOURNAL_REPLAY_ROWS;
        if (ios && signedOut) {
          // Signed out: native's drives are not taken in (nor stopped); they wait for this
          // driver's next sign-in, or a different driver's wipe.
          captureOn = false;
          journalsOwed = true;
          deferredAdopt = opts.adopt ?? null;
        } else if (ios) await bootIos(opts.adopt ?? null);
        else if (opts.adopt) await adoptTrip(opts.adopt);
      }, 'boot');
      attachNative();
      await work;
    },

    async start() {
      if (!booted || signedOut) return { ok: false, reason: 'error' };
      // A second swipe while the Start-card drive waits is a touch.
      if (waiting !== null) {
        self.touchWaiting();
        return { ok: true, waiting: true };
      }
      if (isBusyStatus(engine.snapshot().status)) return { ok: false, reason: 'busy' };
      try {
        const perms = await deps.permissions?.();
        if (perms !== undefined && perms.location !== 'granted') return { ok: false, reason: 'permission' };
        // With the switch off nothing records; approximate fixes are kilometres wide and never count.
        if (perms?.services === false) return { ok: false, reason: 'services' };
        if (perms?.precise === false) return { ok: false, reason: 'precise' };
      } catch (e) {
        // Unreadable is no answer: native refuses a start it cannot record (`permission`).
        report(e, 'permissions');
      }
      // A refusal native or the engine gave; null: none (the drive's own state then decides).
      let refused: StartRefusalReason | null = null;
      await run(async () => {
        if (waiting !== null) return;
        if (isBusyStatus(engine.snapshot().status)) {
          refused = 'busy';
          return;
        }
        // The drive records from the tap, waiting for driving speed: the wait is set before the
        // drive opens, so no state ever shows the drive without it.
        refused = ios && detect !== null ? await startDetected(detect) : await startPlain();
      }, 'start');
      if (refused !== null) return { ok: false, reason: refused };
      // A drive that records is a start, whatever a step beside it did; Home opens the driving screen.
      return engine.snapshot().status === 'recording' ? { ok: true, waiting: true } : { ok: false, reason: 'error' };
    },

    touchWaiting() {
      if (waiting === null) return;
      waiting.since = now();
      waiting.phase = 'waiting';
      armWaitingTimer();
      publish();
      // A plain capture (the Start fallback) has no native wait to move on.
      if (ios && detect !== null && !plainCapture) {
        detect
          .extendWaiting()
          .then((until) => {
            if (until !== null && waiting !== null) waiting.since = until - WAIT_TOTAL_MS;
          })
          .catch((e: unknown) => report(e, 'extendWaiting'));
      }
    },

    async cancelWaiting() {
      await run(() => endWait(), 'cancelWaiting');
    },

    async end() {
      // While the Start-card drive waits, End is its Cancel.
      if (waiting !== null) {
        await self.cancelWaiting();
        return null;
      }
      const open = engine.snapshot().clientTripId;
      const id = open ?? unfinalized?.clientTripId ?? null;
      if (id === null) return null;
      if (open !== null) {
        await run(() => engine.dispatch({ type: 'end', ts: now() }), 'end');
        await self.untilIdle();
      } else {
        await run(async () => {
          const again = unfinalized;
          if (again !== null && again.clientTripId === id && !isBusyStatus(engine.snapshot().status)) await finalizeAgain(again);
        }, 'end');
      }
      const f = lastFinalized;
      if (f !== null && f.clientTripId === id && !f.ok) throw new DriveEndFailedError(id);
      return { clientTripId: id, dropped: f !== null && f.ok && f.clientTripId === id ? f.dropped : null };
    },

    async cancelDrive() {
      if (engine.snapshot().status !== 'recording' || !notDrivingAvailable()) return false;
      let cancelled = false;
      await run(async () => {
        if (engine.snapshot().status !== 'recording' || !notDrivingAvailable()) return;
        cancelled = true;
        await engine.dispatch({ type: 'cancel', ts: now() });
      }, 'cancelDrive');
      await self.untilIdle();
      return cancelled;
    },

    setHudVisible(visible) {
      hudFocused = visible;
      updateVisibility();
    },

    demoPhoneAlert() {
      phoneAlert({ id: `demo-tap-${now()}`, type: 'phone_pickup', tier: 'moderate', at: now() });
    },

    dismissWeather() {
      const shown = shownWeather();
      if (shown === null) return;
      weatherDismissed = weatherDismissed === null || moreSevere(shown.kind, weatherDismissed) ? shown.kind : weatherDismissed;
      publish();
      refreshDisplay();
    },

    async stop({ endOpenTrip }) {
      if (!booted) return;
      if (endOpenTrip) {
        await run(async () => {
          await endWait();
          if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
        }, 'stop');
      }
      await settled();
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      ticker.stop();
      clearPush();
      if (waiting?.timer != null) scheduler.clearTimeout(waiting.timer);
      weatherWatch?.stop();
      booted = false;
      for (const resolve of [...idleWaiters]) resolve();
      idleWaiters.clear();
    },

    isBusy: () => isBusyStatus(engine.snapshot().status),
    captureActive: () => captureOn,

    async untilIdle() {
      for (;;) {
        await settled();
        if (!isBusyStatus(engine.snapshot().status) || !booted) {
          await settled();
          return;
        }
        await new Promise<void>((resolve) => idleWaiters.add(resolve));
      }
    },

    settled,
    snapshot: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    booted: () => booted,
    signedIn: () => !signedOut || signingOut,

    async suspendForSignOut() {
      await run(async () => {
        signedOut = true;
        signingOut = true;
        await endWait();
        if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
      }, 'signOut');
      await self.untilIdle();
    },
    resumeAfterSignIn: () =>
      run(async () => {
        signingOut = false;
        signedOut = false;
        await takeInOwedJournals();
      }, 'signIn'),
    signedInAgain: () =>
      run(async () => {
        if (signingOut) return;
        signedOut = false;
        await takeInOwedJournals();
      }, 'signIn'),
    signOutCompleted() {
      signingOut = false;
    },
    async sessionEnded() {
      if (!signingOut && !signedOut) await self.suspendForSignOut();
      // Sign-out takes the notice down, also when the wipe did not run (uploads still owed).
      if (persist) await clearDropNotice(db).catch((e: unknown) => report(e, 'dropNotice'));
      self.signOutCompleted();
    },
    reportAlertsUnavailable() {
      if (soundFailedThisDrive) return;
      soundFailedThisDrive = true;
      publish();
    },
    reportAlertsAvailable() {
      if (!soundFailedThisDrive) return;
      soundFailedThisDrive = false;
      publish();
    },
    recording: () => engine.snapshot().status === 'recording',
  };
  return self;
}

/** The alert player's live inputs, late-bound to a host that does not exist yet when the player is built. */
export function playerInputs(getHost: () => DriveHost | undefined): {
  callActive(): boolean;
  l1RespectsSilentSwitch(): boolean;
  deliverable(): boolean;
  onUnavailable(): void;
  onAvailable(): void;
} {
  return {
    onAvailable: () => getHost()?.reportAlertsAvailable(),
    onUnavailable: () => getHost()?.reportAlertsUnavailable(),
    callActive: () => getHost()?.snapshot().callActive ?? false,
    // The chime and the tones must carry over music and road noise: the playback session, always.
    l1RespectsSilentSwitch: () => false,
    deliverable: () => true,
  };
}

export { knownSpeed };
