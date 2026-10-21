// The drive host (product spec "Starting and ending a drive", "Driving screen"; modes plan §3.2,
// §3.5-§3.10, §3.15, §10 A2).
//
// One object wires the native capture, the iOS drive detector, the engine, the detectors, the
// speed-limit client, the alert player, the background display and persistence together, and
// publishes one `DriveState` for the UI. Rules:
// - **How a drive begins.** iOS: native notices driving (15 mph held 30 s) or confirms the Start
//   card's wait (10 mph held 15 s), traces the start back and journals every row; the host adopts
//   the journal wherever JS runs (a `driveStarted` event, or `boot`) and replays it into the
//   engine. Android (no detector): the Start card starts the capture at once and a JS waiting
//   session confirms from the rows with the same trigger and trace-back. Either way a drive
//   confirmed within 5 min and 150 m of a held drive's end re-opens that trip (`continuation.ts`).
// - **How it ends.** The engine decides (5 min still, a walk at 3 mph or slower, 12 h, End); native
//   stops on its own only as a fallback and the engine then cuts at the last movement. "Not
//   driving?" discards the drive (`cancelDrive`), only while its 2-minute visible budget lasts.
// - **One queue.** Every engine dispatch and the native command that follows it run on one serial
//   chain; after each task the capture is reconciled with the engine's state (on iOS the host never
//   starts a capture: native owns it, and `stopCapture` tells native the JS end and its cut).
// - **In front only.** Alert sounds, voice and haptics play only while RoadWise is active; the
//   spot nudge shows only then. The drive records the same either way.
// - **Battery.** Nothing runs while idle: no timer, no read. While recording, one timeout at most
//   (the automatic end, `ticks.ts`), the display throttled to one update per 3 s, the weather
//   checked every 15 min or 20 km, the state published at most once per row.
// - **Background (Android).** Each row first pumps the process's timers (`src/lib/timers.ts`): with
//   the app in the Android background JS timers are paused, and the rows are what keeps the alert
//   player, the waiting clock and the DashPal link moving.
import { parseActivity, parseRow, parseSpeed, type CaptureEnd, type DriveDetectApi, type DriveStartedEvent, type DriveEndedEvent, type DetectStateEvent, type EndCauseNative, type JournaledDrive } from '@drive-sense';
import type { LiveDriveState } from '@live-drive';
import { MERGE_GAP_S } from '@scoring';

import { decisionFor, ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import { knownSpeed, limitShownMph, ROW_MS, speedTrusted, UNKNOWN_LIMIT } from '@/core/detectors/common';
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

import { continuationFor, reopenTrip, type Continuation } from './continuation';
import { toLive, type DriveDisplay, type DriveDisplayState } from './display';
import { displayLook } from './displayLook';
import { speedTintOf } from './displayTint';
import { clearDropNotice, writeDropNotice } from './dropNotice';
import { clearCancelMarker, writeCancelMarker } from './cancel';
import { budgetFor, NOT_DRIVING_KEY, NOT_DRIVING_PERSIST_EVERY_MS, spend, writeBudget, type NotDrivingBudget } from './notDriving';
import { isBusyStatus } from './policy';
import type { DriveSource } from './source';
import { createTicker, realScheduler, type Scheduler } from './ticks';
import { createWaitingSession, nextWaitingChange, WAIT_TOTAL_MS, waitingDeadline, waitingPhaseAt, type WaitingPublic, type WaitingSession } from './waiting';
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
  /** The Start card's wait (no drive yet: `status` is idle), or null. */
  waiting: WaitingPublic | null;
  /** "Not driving?" may still be offered on this drive (its 2-minute budget lasts); false with no drive. */
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
  /** The Start card: the wait begins (the driving screen opens in its waiting state). Already waiting: a touch. */
  start(): Promise<StartResult>;
  /** Any touch on the waiting driving screen (and "Keep waiting"): a fresh 5 min. */
  touchWaiting(): void;
  /** "Cancel" (the sheet's, or End swiped while waiting): the wait ends, nothing is stored. */
  cancelWaiting(): Promise<void>;
  /**
   * The swipe-to-end. Resolves once the drive is finalized; null when none was open (a wait is
   * cancelled). `dropped`: that drive was not kept. Rejects with `DriveEndFailedError` when the
   * drive closed but could not be finalized; with no drive open, the next `end()` finalizes it again.
   */
  end(): Promise<{ clientTripId: string; dropped: DropReason | null } | null>;
  /** "Not driving?": discards the drive. False (nothing done) unless a drive records and its budget lasts. */
  cancelDrive(): Promise<boolean>;
  /** The driving screen is focused (true) or not: with RoadWise active, the "Not driving?" budget counts. */
  setHudVisible(visible: boolean): void;
  /** The driving screen's ✕ on the weather banner: hidden for the rest of the drive (a more severe kind shows again). */
  dismissWeather(): void;
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
  /** A drive continued after a relaunch (or re-opened): its coverage totals are reloaded. */
  adopt(clientTripId: string): Promise<void>;
  /** Drive end: wait ≤ 3 s for the phone to catch up to the dashcam, then stamp the sync time. */
  beforeFinalize(clientTripId: string, opts: { dryRun: boolean }): Promise<void>;
  /** A DashPal continuous alert is active: phone alerts are then haptic + visual only. */
  continuousAlertActive(): boolean;
}

/** The first Live Activity state, for a server push-to-start (iOS 17.2+). */
export interface PushToStartRequest {
  clientTripId: string;
  /**
   * Which leg of the drive (`TripSession.continuations`): 0 for the first, 1 once it was re-opened
   * after a stop, and so on. The server sends one push per drive and leg.
   */
  leg: number;
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
  /** iOS: ask our server to push-start the Live Activity (any drive begun or re-opened with RoadWise behind). False: the native note stands. */
  pushToStart?: (req: PushToStartRequest) => Promise<boolean>;
  /** The held drive a confirmed start continues (default `continuationFor` over `db`). */
  continuation?: (now: number, fix: { lat: number; lng: number } | null) => Promise<Continuation | null>;
  /** The spots the driving screen nudges about (default `readWatchSpots` over `db`). */
  spots?: { readWatchSpots(): Promise<WatchSpot[]> };
  /** The weather at a place (default Open-Meteo). */
  weather?: WeatherLookup;
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
/** Which native journal feeds which trip (they differ for a re-opened drive). Cleared at every end. */
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
 * Whether native's journal (or the journal link of a re-opened drive) holds `clientTripId`: the
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

/** The engine's end cause for native's own stop. */
export function endCauseOfNative(cause: EndCauseNative | 'js'): EndCause {
  if (cause === 'walking') return 'walking';
  if (cause === 'limit') return 'limit';
  if (cause === 'still') return 'stopped';
  return 'orphan';
}

/** A trusted GPS speed from a `speed` event, m/s, or null. */
const trustedSampleSpeed = (s: { speed: number; speedAcc: number; hAcc: number }): number | null =>
  s.speed >= 0 && (s.speedAcc < 0 || s.speedAcc <= 2) && s.hAcc >= 0 && s.hAcc <= 30 ? s.speed : null;

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

interface Waiting {
  since: number;
  /** Android: the JS confirmation; null on iOS (native confirms). */
  session: WaitingSession | null;
  speedMps: number | null;
  limitMph: number | null;
  timer: unknown;
  phase: WaitingPublic['phase'];
  /**
   * The drive confirmed and is being begun: the wait still shows (so the driving screen never sees
   * an idle state between the wait and the drive), but nothing more happens to it. The drive's
   * start (or re-open) clears it in the same publish.
   */
  confirming: boolean;
}

/** How the host begins a confirmed drive. */
interface Begin {
  ts: number;
  clientTripId?: string;
  origin: DriveOrigin;
  startSource: StartSource;
  /** The parked spot (a motion-history start), else null. */
  startPlace: { lat: number; lng: number } | null;
  /** Where the drive starts (the traced row's fix), for the continuation check; null when unknown. */
  fix: { lat: number; lng: number } | null;
  continues: boolean;
}

export function createDriveHost(deps: DriveHostDeps): DriveHost {
  const { db, source, limits, player, now, tz, newId } = deps;
  const persist = (deps.persistence ?? 'full') === 'full';
  const detect = deps.detect && deps.detect.available ? deps.detect : null;
  const ios = detect !== null;
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
  /** The Start card's wait, or null. */
  let waiting: Waiting | null = null;
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
  /** The open drive's leg a push-to-start was asked for (`<id>#<leg>`), or null; cleared when the drive closes or is cancelled. */
  let pushedFor: string | null = null;
  let spotWatcher: SpotWatcher | null = null;
  let spotNudge: SpotNudge | null = null;
  let spotsLoad = 0;
  let weatherWatch: WeatherWatch | null = null;
  let weatherRaw: DangerAlert | null = null;
  let weatherDismissed: DangerKind | null = null;
  let lastFixAt: { lat: number; lng: number; ts: number } | null = null;
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
        lastFinalized = { clientTripId: id, ok: true, status: null, dropped: result.dropped, endCause, at: now(), durationS: null, miles: null };
        // Home says why; no OS notification (nothing was kept).
        await writeDropNotice(db, { clientTripId: id, cause: endCause, reason: result.dropped, at: now(), origin: session.origin }).catch((e: unknown) => report(e, 'dropNotice'));
      } else {
        lastFinalized = { clientTripId: id, ok: true, status: result.trip.status, dropped: null, endCause, at: now(), durationS: result.trip.duration_s, miles: result.trip.miles };
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
   * "Not driving?": the drive goes whole (a re-opened one with its earlier leg); nothing is kept,
   * sent or told. Order: a durable marker first, then native (iOS: it deletes the journal and
   * rests; Android's capture stops after the task, whatever happens here), then the trip, then the
   * marker. A kill anywhere in between is finished at the next launch (`finishPendingCancel`), and
   * a trip that cannot be deleted never leaves native recording.
   */
  async function onCancel(session: Readonly<TripSession>): Promise<void> {
    const id = session.clientTripId;
    const driveId = liveDrive !== null && liveDrive.clientTripId === id ? liveDrive.driveId : null;
    captureEnd = null;
    if (persist) await writeCancelMarker(db, { clientTripId: id, driveId }).catch((e: unknown) => report(e, 'notDriving'));
    if (ios && detect !== null) {
      // Native deletes the journal and rests until walking or 5 min still; it is no capture of ours to stop.
      captureOn = false;
      liveDrive = null;
      await detect.notDriving().catch((e: unknown) => report(e, 'notDriving'));
    }
    lastFinalized = { clientTripId: id, ok: true, status: null, dropped: 'cancelled', endCause: 'manual', at: now(), durationS: null, miles: null };
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
    ctx: () => ({}),
    onAlert(alert: AlertEvent) {
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
      if (!appActive()) decision.suppressed = true;
      player.deliver(decision).catch((e: unknown) => report(e, 'player'));
    },
    onCheckpoint: (session) => (persist ? recorder.onCheckpoint(session) : Promise.resolve()),
    onFinalize,
    onCancel,
    onError: (e) => report(e, 'engine'),
  });

  // --- the published state ------------------------------------------------------------------------

  function waitingPublic(): WaitingPublic | null {
    if (waiting === null) return null;
    return { since: waiting.since, phase: waiting.phase, deadlineAt: waitingDeadline(waiting.since, waiting.phase), speedMps: waiting.speedMps, limitMph: waiting.limitMph };
  }

  function shownWeather(): DangerAlert | null {
    if (weatherRaw === null || engine.snapshot().status !== 'recording') return null;
    return weatherDismissed === null || moreSevere(weatherRaw.kind, weatherDismissed) ? weatherRaw : null;
  }

  const notDrivingAvailable = (): boolean => budget !== null && !budget.expired && engine.snapshot().status === 'recording' && budget.clientTripId === engine.snapshot().clientTripId;

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

  /** What the background surfaces show for `s`: the speed (0 while unknown), the limit, its tint, the hint and the weather. */
  function displayState(s: EngineSnapshot): DriveDisplayState {
    const w = shownWeather();
    return {
      speed: inDisplayUnit(s.speedKnown ? mpsToMph(s.speedMps) : 0, displayUnit),
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

  function display(s: EngineSnapshot): void {
    if (!deps.display || !surfaces || s.status !== 'recording') return;
    deps.display.update(displayState(s));
  }

  /** A change the lock screen must show now (the weather line, the hint running out). */
  function refreshDisplay(): void {
    const s = engine.snapshot();
    if (!deps.display || !surfaces || s.status !== 'recording') return;
    const state = displayState(s);
    if (deps.display.refresh) deps.display.refresh(state);
    else deps.display.update(state);
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
      // A confirmed wait's drive replaces the wait in this same publish: never an idle state between.
      if (waiting?.confirming === true) dropWaiting();
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

  /** Everything a drive opened beside the engine goes with it. */
  function closeSurfaces(): void {
    limits.resetTrip();
    startTripPending = false;
    if (surfaces) deps.display?.end();
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
    // A re-opened drive (a new leg) asks again.
    pushedFor = null;
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
   * A drive just opened (started, re-opened or adopted): its "Not driving?" budget comes back by
   * trip id, the display starts (or, behind on iOS, the server is asked for a push-to-start for
   * this leg, whatever started the drive), and
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
    if (deps.display) {
      if (!ios || appActive()) deps.display.start({ ...displayState(s), stopped: s.lastRowTs === null || s.stopped });
      // iOS cannot start an activity from the background: the server push-starts it, for an
      // automatic drive, a Start-card drive that confirmed behind (navigation open) and a re-opened leg alike.
      else void askPushToStart(id, engine.session()?.continuations ?? 0, s.startedAt ?? now());
    }
    if (persist) {
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
      const gen = (spotsLoad += 1);
      const read = deps.spots ? deps.spots.readWatchSpots() : readWatchSpots(db);
      read
        .then((spots) => {
          if (gen === spotsLoad && engine.snapshot().status === 'recording') spotWatcher = createSpotWatcher(spots);
        })
        .catch((e: unknown) => report(e, 'spots'));
    }
  }

  /** iOS, RoadWise behind: the server push-starts the Live Activity, once per drive and leg, unless one already runs. */
  async function askPushToStart(id: string, leg: number, startedAt: number): Promise<void> {
    const key = `${id}#${leg}`;
    if (!deps.pushToStart || pushedFor === key) return;
    pushedFor = key;
    try {
      if (await deps.display?.isRunning?.()) return;
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
      await deps.pushToStart({ clientTripId: id, leg, startedAt, state });
    } catch (e) {
      report(e, 'pushToStart');
    }
  }

  // --- "Not driving?" budget ----------------------------------------------------------------------

  function persistBudget(): void {
    const b = budget;
    if (!persist || b === null) return;
    persistedSpent = b.spentMs;
    budgetWrites = budgetWrites.then(() => writeBudget(db, b)).catch((e: unknown) => report(e, 'notDriving'));
  }

  function accrue(dt: number): void {
    const b = budget;
    if (b === null || b.expired || dt <= 0 || engine.snapshot().status !== 'recording') return;
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
    if (!hudVisible()) {
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
    // Stored drives' journals go (never the live one: native would refuse it).
    if (detect !== null && discardQueue.length > 0) {
      for (const id of discardQueue.splice(0)) {
        if (liveDrive !== null && liveDrive.driveId === id) discardQueue.push(id);
        else await detect.discardDrive(id).catch((e: unknown) => report(e, 'discardDrive'));
      }
    }
  }

  /**
   * The capture follows the engine: on while a drive records (Android: also while the Start card
   * waits), off after. iOS never starts one (native owns it); its `stopCapture` tells native the
   * JS end and the cut.
   */
  async function reconcileCapture(status: EngineStatus): Promise<void> {
    const want = status === 'recording' || (waiting !== null && !ios);
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
    limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
  };

  /**
   * A confirmed drive: it re-opens the held drive it continues (`continuation.ts`), else it starts.
   * Runs inside the queue.
   */
  async function beginDrive(b: Begin, opts: { quiet?: boolean } = {}): Promise<void> {
    if (engine.snapshot().status !== 'idle') return;
    const at = now();
    await readDisplayUnit();
    let c: Continuation | null = null;
    if (persist) {
      try {
        c = await (deps.continuation ?? ((t, fix) => continuationFor(db, t, fix)))(at, b.fix);
      } catch (e) {
        report(e, 'continuation');
      }
    }
    if (c !== null) {
      try {
        const adopted = await reopenTrip(db, c, { ...rebuildDeps, now: at, at: b.ts });
        if (adopted !== null) {
          // The re-opened drive's journal is a new one: its rows count from 1.
          adopted.session.lastSeq = null;
          await createTripsRepo(db).update(c.clientTripId, { last_seq: null }, at);
          await engine.dispatch({ type: 'adopt', trip: adopted, ts: at });
          await driveOpened({ adopted: true, quiet: opts.quiet });
          return;
        }
      } catch (e) {
        report(e, 'reopen');
      }
    }
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

  /** The wait's phase now: the sheet, the countdown, or the quiet end at 5 min. */
  async function evaluateWaiting(): Promise<void> {
    const w = waiting;
    if (w === null || w.confirming) return;
    const phase = waitingPhaseAt(w.since, now());
    if (phase === 'expired') {
      await endWaiting('expired');
      return;
    }
    if (phase !== w.phase) {
      w.phase = phase;
      publish();
    }
    if (w.timer === null) armWaitingTimer();
  }

  /** The wait ends with nothing stored (`expired`, `cancelled`; `native`: native already let it go). */
  async function endWaiting(why: 'expired' | 'cancelled' | 'native'): Promise<void> {
    const w = waiting;
    if (w === null) return;
    waiting = null;
    if (w.timer !== null) scheduler.clearTimeout(w.timer);
    if (engine.snapshot().status === 'idle') limits.resetTrip();
    if (ios && detect !== null && (why === 'expired' || why === 'cancelled')) await detect.cancelWaiting().catch((e: unknown) => report(e, 'cancelWaiting'));
    publish();
  }

  /** The wait goes, unpublished: the drive opening publishes the change. */
  function dropWaiting(): void {
    const w = waiting;
    if (w === null) return;
    waiting = null;
    if (w.timer !== null) scheduler.clearTimeout(w.timer);
  }

  /**
   * The wait confirmed: it stays on screen while the drive is begun (nothing is published here), and
   * the drive's start or re-open takes it down in the same publish. Call `afterConfirm` once the
   * drive is begun.
   */
  function confirmWaiting(): void {
    const w = waiting;
    if (w === null) return;
    w.confirming = true;
    if (w.timer !== null) scheduler.clearTimeout(w.timer);
    w.timer = null;
  }

  /** A confirmed wait whose drive did not open (a failed start): it ends now, nothing stored. */
  async function afterConfirm(): Promise<void> {
    if (waiting !== null && waiting.confirming) await endWaiting('native');
  }

  /** A row while the Start card waits (Android): the sign and the speed, the phase, and the confirmation. */
  async function onWaitingRow(row: FeatureRow): Promise<void> {
    const w = waiting;
    if (w === null) return;
    const speed = knownSpeed(row);
    if (speed !== null && speedTrusted(row)) w.speedMps = speed;
    const sample = limits.lookup(row.lat, row.lng, row.course, { gnssValid: row.gnssValid, speedMps: speed }) ?? UNKNOWN_LIMIT;
    w.limitMph = limitShownMph(row, sample);
    const confirmed = w.session?.push(row) ?? null;
    if (confirmed === null) {
      await evaluateWaiting();
      publish();
      return;
    }
    // The wait shows until the drive's own start replaces it (one publish: never idle in between).
    confirmWaiting();
    await beginDrive({
      ts: confirmed.startedAt,
      origin: 'manual',
      startSource: confirmed.startSource,
      startPlace: null,
      fix: confirmed.startFix ?? (row.gnssValid ? { lat: row.lat, lng: row.lng } : null),
      continues: false,
    });
    await afterConfirm();
    for (const r of confirmed.rows) await onRow(r, { replay: true });
  }

  // --- rows ----------------------------------------------------------------------------------------

  /**
   * The speed-limit tiles around the phone's cached position, while the capture waits for its
   * first fix (which asks again from the fix itself: tiles already held cost nothing).
   */
  function fetchLimitsNearby(): void {
    if (!deps.lastPosition || !persist) return;
    deps
      .lastPosition()
      .then((p) => {
        if (p !== null && (startTripPending || waiting !== null)) limits.startTrip(p.lat, p.lng, -1);
      })
      .catch((e: unknown) => report(e, 'lastPosition'));
  }

  /** One row through the engine and everything beside it. `replay`: a journal or waiting-buffer row (no live budget time, no nudge). */
  async function onRow(row: FeatureRow, opts: { replay?: boolean } = {}): Promise<void> {
    if (waiting !== null && waiting.session !== null && engine.snapshot().status === 'idle') {
      await onWaitingRow(row);
      return;
    }
    if (startTripPending && row.gnssValid) {
      startTripPending = false;
      if (persist) limits.startTrip(row.lat, row.lng, row.course);
    }
    // Visible time first, so the state the row publishes carries it.
    if (!opts.replay && engine.snapshot().status === 'recording') accrueRow(row);
    await engine.dispatch({ type: 'row', row });
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
  }

  /**
   * Journal rows of `driveId` after `afterSeq`, oldest first, through `onRow` (as replays), until
   * the file holds no more (`done`), the boot's cap is spent (`capped`: the live drive only) or a
   * read fails. Pages of `JOURNAL_READ_ROWS`; between pages the JS thread is let go once (`pace`),
   * so a long drive read at a launch never holds the screen. Returns the last `seq` taken in and
   * whether the file was read to its end.
   */
  async function drainJournal(driveId: string, afterSeq: number, opts: { capped: boolean; pace?: boolean }): Promise<{ last: number; done: boolean }> {
    if (detect === null) return { last: afterSeq, done: true };
    let last = afterSeq;
    for (let first = true; ; first = false) {
      if (opts.capped && replayBudget <= 0) return { last, done: false };
      if (!first && opts.pace) await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    return { ts: j.startedAt, clientTripId: j.driveId, origin: j.origin, startSource: j.startSource, startPlace: j.startSource === 'motion' ? fix : null, fix, continues: j.continues };
  };

  /** A native drive starts (or is found at boot with no trip of its own): begin it and take its journal in. */
  async function beginNative(j: Pick<JournaledDrive, 'driveId' | 'origin' | 'startedAt' | 'startSource' | 'startLat' | 'startLng' | 'continues'>, opts: { capped: boolean; quiet?: boolean }): Promise<boolean> {
    await beginDrive(beginOf(j), { quiet: opts.quiet });
    const s = engine.snapshot();
    if (s.status !== 'recording' || s.clientTripId === null) return false;
    liveDrive = { driveId: j.driveId, clientTripId: s.clientTripId, lastSeq: 0 };
    await writeLink(j.driveId, s.clientTripId);
    await drainJournal(j.driveId, 0, { capped: opts.capped });
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
    // The Start card's wait shows until the drive's own start replaces it (one publish).
    confirmWaiting();
    if (await beginNative(e, { capped: false })) captureOn = true;
    await afterConfirm();
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

  function onDetectState(e: DetectStateEvent): void {
    if (waiting === null) return;
    if (e.reason === 'waitTimeout' || e.reason === 'cancelled') void run(() => endWaiting('native'), 'detectState');
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
    if (liveId === null || d === null) return;
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
        // the rows (a checkpoint's write must not hold it), and timed at the fix (arrival less its
        // age). While the Start card waits (iOS: no rows yet), it is the waiting screen's speed.
        source.addListener('speed', (raw) => {
          const s = parseSpeed(raw);
          if (s === null) return;
          if (waiting !== null && engine.snapshot().status === 'idle') {
            const v = trustedSampleSpeed(s);
            if (v !== null && v !== waiting.speedMps) {
              waiting.speedMps = v;
              publish();
            }
            return;
          }
          try {
            engine.speed({ at: now() - s.ageMs, mps: s.speed, acc: s.speedAcc, hAcc: s.hAcc });
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
        // the same rules as the swipe (cut after 2 min standing still, dropped if it never moved). A
        // tap buffered from before this drive, or one landing while it is already closing, does nothing.
        source.addListener('notificationAction', (a) => {
          if (a.action !== 'endDrive') return;
          void run(async () => {
            const s = engine.snapshot();
            if (s.status !== 'recording' || s.startedAt === null || !(a.ts >= s.startedAt)) return;
            await engine.dispatch({ type: 'end', ts: now() });
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
        remover(detect.addListener('driveEnded', (e) => void run(() => onDriveEnded(e), 'driveEnded'))),
        remover(detect.addListener('detectState', (e) => onDetectState(e)))
      );
    }
    if (deps.appState) {
      let wasActive = appActive();
      const sub = deps.appState.addEventListener('change', () => {
        const active = appActive();
        updateVisibility();
        if (active && !wasActive) {
          void run(async () => {
            // Back in front during a drive: the Live Activity is adopted (pushed) or started here.
            const s = engine.snapshot();
            if (s.status === 'recording' && surfaces && deps.display) deps.display.start({ ...displayState(s), stopped: s.lastRowTs === null || s.stopped });
            await evaluateWaiting();
          }, 'foreground');
        }
        wasActive = active;
        publish();
      });
      subscriptions.push(() => sub.remove());
    }
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
      await run(async () => {
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
        attachNative();
      }, 'boot');
    },

    async start() {
      if (!booted || signedOut) return { ok: false, reason: 'error' };
      if (isBusyStatus(engine.snapshot().status)) return { ok: false, reason: 'busy' };
      if (waiting !== null) {
        self.touchWaiting();
        return { ok: true, waiting: true };
      }
      try {
        const perms = await deps.permissions?.();
        if (perms !== undefined && perms.location !== 'granted') return { ok: false, reason: 'permission' };
        // With the switch off nothing records; approximate fixes are kilometres wide and never count.
        if (perms?.services === false) return { ok: false, reason: 'services' };
        if (perms?.precise === false) return { ok: false, reason: 'precise' };
      } catch (e) {
        report(e, 'permissions');
        return { ok: false, reason: 'permission' };
      }
      let result: StartResult = { ok: false, reason: 'error' };
      await run(async () => {
        if (isBusyStatus(engine.snapshot().status)) {
          result = { ok: false, reason: 'busy' };
          return;
        }
        if (waiting !== null) {
          result = { ok: true, waiting: true };
          return;
        }
        if (ios && detect !== null) {
          let r: Awaited<ReturnType<DriveDetectApi['startWaiting']>>;
          try {
            r = await detect.startWaiting();
          } catch (e) {
            report(e, 'startWaiting');
            return;
          }
          if (!r.ok) {
            result = { ok: false, reason: r.reason === 'permission' ? 'permission' : r.reason === 'busy' ? 'busy' : 'error' };
            return;
          }
          waiting = { since: r.waitUntil - WAIT_TOTAL_MS, session: null, speedMps: null, limitMph: null, timer: null, phase: 'waiting', confirming: false };
        } else {
          try {
            await source.startCapture('mounted');
            captureOn = true;
          } catch (e) {
            report(e, 'startCapture');
            return;
          }
          waiting = { since: now(), session: createWaitingSession(), speedMps: null, limitMph: null, timer: null, phase: 'waiting', confirming: false };
        }
        await readDisplayUnit();
        fetchLimitsNearby();
        armWaitingTimer();
        result = { ok: true, waiting: true };
        publish();
      }, 'start');
      return result;
    },

    touchWaiting() {
      if (waiting === null || waiting.confirming) return;
      waiting.since = now();
      waiting.phase = 'waiting';
      armWaitingTimer();
      publish();
      if (ios && detect !== null) {
        detect
          .extendWaiting()
          .then((until) => {
            if (until !== null && waiting !== null) waiting.since = until - WAIT_TOTAL_MS;
          })
          .catch((e: unknown) => report(e, 'extendWaiting'));
      }
    },

    async cancelWaiting() {
      await run(() => endWaiting('cancelled'), 'cancelWaiting');
    },

    async end() {
      const open = engine.snapshot().clientTripId;
      if (open === null && waiting !== null) {
        await self.cancelWaiting();
        return null;
      }
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
          await endWaiting('cancelled');
          if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
        }, 'stop');
      }
      await settled();
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      ticker.stop();
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
        await endWaiting('cancelled');
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
