// The drive host (design §3.1–§3.5; M3 plan task H1).
//
// One object wires the native capture module, the trip engine, the detectors and alert arbiter,
// the speed-limit client, the alert player and persistence (recorder + finalizer) together, and
// publishes one `DriveState` for the UI. Every rule it applies is a pure function in `policy.ts`;
// this file is the plumbing and the ordering:
//
// - **One queue.** Every engine dispatch, and every native command that follows from it, runs on
//   one serial chain. After each task the host reconciles native capture with the engine's state
//   (`capturePlan`), sends the drive notification if it changed, and updates the single tick
//   timer. So a burst of transitions inside one task (finalize → armed → a new candidate) issues
//   the commands for where it ended up, never a stop followed by a start.
// - **Battery (§3.5).** While armed and idle nothing runs: no timer (`ticks.ts` keeps one only in
//   `candidate` and `ending`), no read, no command. Native wakes are the only input; a wake reads
//   the motion history once. Nothing heavy runs per row: the night rule is computed once a minute,
//   the notification is sent on change only, the tick timer is not re-armed per row.
// - **Honesty.** Unknown stays unknown: the snapshot carries the engine's raw limit and
//   `speedKnown`; whether a limit may be shown or acted on is decided in one place,
//   `limitActionable` in `src/core/detectors/common.ts`, which the HUD, the alerts and scoring all
//   use. The host does not re-gate it. A drive that failed to save says so
//   (`lastFinalized.ok: false`) and is never re-finalized here; it stays `recording` for recovery
//   at the next launch.
// - **Never raises the app.** Nothing here brings RoadWise to the foreground (no full-screen
//   intent, no deep link without a tap): SR8 would charge the driver for the app's own behaviour
//   (E1 review M6). Starts, ends and alerts are audio and the notification only.
// - **Finalize is observable.** `untilIdle()` resolves once the snapshot is armed/off after a close,
//   with `lastFinalized` already set; H2's Android headless task settles on it (N3 README §6).
//
// `DriveState.status === 'off'` means the engine is idle with auto-detect NOT armed — which is the
// user's choice being off, OR the feature flag being off, OR Always location missing, OR the arm
// having been refused. It does not mean "the user turned auto-record off"; that intent is
// `autoDetectEnabled()` (M4 seam ruling N-m2).
import type { ThermalLevel } from '@drive-sense';
import { parseRow } from '@drive-sense';

import { createArbiter } from '@/core/alerts/arbiter';
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision, AlertVoiceKey } from '@/core/alerts/types';
import { createDetectors } from '@/core/detectors';
import type { EngineSnapshot, EngineStatus, TripSession } from '@/core/engine/engine.types';
import { finalizeTrip } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { createRecorder } from '@/core/engine/recorder';
import { rebuildFromSamples } from '@/core/engine/replay';
import { roleEvidenceFor } from '@/core/engine/rolePrior';
import type { DetectorContext, FeatureRow } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import type { TraceWriter } from '@/boot/traceWriter';
import { createSettingsRepo, type Db, type TripRow, type TripStatus } from '@/data/db';
import { emitDataChanged, onDataChanged } from '@/data/events';
import type { AppStateLike } from '@/data/foreground';

import {
  ALERT_SHOWN_MS,
  AUTO_DETECT_SETTING_KEY,
  activityEvent,
  captureCommands,
  capturePlan,
  createNightClock,
  detectorContext,
  endDriveAllowed,
  gpsQuality,
  isBusyStatus,
  isIdleStatus,
  isShortDrive,
  l1RespectsSilentSwitch,
  limitOptions,
  notificationStateOf,
  shouldArm,
  shouldSelfDispatch,
  wakeStart,
  WAKE_HISTORY_S,
  type CaptureBelief,
  type CaptureCommand,
} from './policy';
import type { DriveSource } from './source';
import { createTicker, type Scheduler } from './ticks';

export type { DriveSource } from './source';

/** The outcome of the last finalize (rev1: I16), for the end screen (C8). */
export type LastFinalized =
  | { clientTripId: string; ok: true; status: TripStatus; short: boolean; at: number }
  | { clientTripId: string; ok: false; at: number }
  | null;

export interface DriveState extends EngineSnapshot {
  /** The alert whose overlay is showing: L1 3 s, L2 5 s, L3 8 s on the row clock. */
  activeAlert: AlertDecision | null;
  /** C6 "Mute alerts for this drive" is on for the open trip. */
  mutedForDrive: boolean;
  /** From the current row: none without a valid fix, weak when too loose to judge speed. */
  gps: 'good' | 'weak' | 'none';
  thermal: ThermalLevel;
  /** iOS only (drive-sense `call`); always false on Android, which has no source. */
  callActive: boolean;
  screenLocked: boolean;
  lastFinalized: LastFinalized;
  /** Scored driver trips so far (the arbiter's learning period reads it). Additive. */
  tripIndex: number;
  /** A `persistence: 'none'` host: nothing is stored and `lastFinalized` stays null. Additive. */
  dryRun: boolean;
  /**
   * False when the alert sound could not be loaded at launch (H2 r1), or when any sound failed
   * during this drive — at activation or at play time (final review I2); a new drive starts
   * hopeful again. The drive still records, silently, and the HUD says so ("Sound alerts
   * unavailable") rather than let the driver assume alerts. Always set by the host; optional in
   * the type only so existing fixtures stay valid. Additive.
   */
  alertsAvailable?: boolean;
  /**
   * Auto-record is armed right now: opted in, available, signed in and permitted (`shouldArm`,
   * final review I4 / M3). Home and the detection screen read this, never the engine's status, so
   * nothing says "on" while the host is not armed. Always set by the host; optional in the type.
   */
  autoDetectArmed?: boolean;
}

export interface DriveHost {
  /** rev1: I2 — adopts the given trip BEFORE subscribing to native events or arming; returns whether it adopted. */
  start(opts?: { adopt?: TripRow | null }): Promise<{ adopted: boolean }>;
  stop(opts: { endOpenTrip: boolean }): Promise<void>;
  manualStart(opts: {
    mode: 'mounted' | 'pocket';
    passenger: boolean;
    evidence: 'tap' | 'movingStart';
  }): Promise<void>;
  end(): Promise<void>;
  setPassenger(passenger: boolean): Promise<void>;
  setMode(mode: 'mounted' | 'pocket'): Promise<void>;
  muteCurrentAlert(): Promise<void>;
  muteForDrive(): Promise<void>;
  announce(key: AlertVoiceKey): Promise<void>;
  /** Persists the user's choice, then arms only if the flag and Always location also allow it. */
  setAutoDetect(enabled: boolean): Promise<void>;
  /** The user's auto-record choice (loaded at `start`), independent of whether capture is armed. */
  autoDetectEnabled(): boolean;
  /** candidate | recording | ending | finalizing */
  isBusy(): boolean;
  /** native capture believed on */
  captureActive(): boolean;
  /** Resolves once no drive is open or closing and the host's queue has drained. */
  untilIdle(): Promise<void>;
  /** Resolves once the host's queue has drained (tests, diagnostics, orderly shutdown). */
  settled(): Promise<void>;
  snapshot(): DriveState;
  subscribe(fn: (s: DriveState) => void): () => void;
  /** For the alert player: L1 honours the silent switch only when mounted, unlocked, in front. */
  l1RespectsSilentSwitch(): boolean;
  /** The player could not sound an alert: `alertsAvailable` is false until a sound works again. */
  reportAlertsUnavailable(): void;
  /** An alert sounded: a mark from an earlier failure in this drive is cleared (n2). */
  reportAlertsAvailable(): void;
  /**
   * Re-read the permissions and the flag and arm or disarm to match (final review I4). Also runs
   * by itself on every transition to `active`, so a return from Settings takes effect.
   */
  refreshArming(): Promise<void>;
  /**
   * Sign-out (§8.2 "stops recording"; final review I3): an open drive is ended and finalized under
   * the current owner, then auto-record is disarmed natively. The stored opt-in is kept, so the
   * same driver signing back in (`resumeAfterSignIn`) is armed again.
   */
  suspendForSignOut(): Promise<void>;
  /**
   * The driver backed out of the sign-out (it did not happen): arming follows the opt-in again.
   * Explicit, from the sign-out flow only — never from an auth event.
   */
  resumeAfterSignIn(): Promise<void>;
  /**
   * The device owner signed in (a `SIGNED_IN` auth event whose uid is the device owner; the root
   * layout filters). Ignored while a sign-out is in progress — until `signOutCompleted` — so an
   * auth event landing during the sign-out's flush can never re-arm a host nobody is signed in to
   * (final-fix security I-1).
   */
  signedInAgain(opts?: { initial?: boolean }): Promise<void>;
  /** The session has ended (`SIGNED_OUT`): the sign-out is over, and the host stays disarmed. */
  signOutCompleted(): void;
  /**
   * The account's age band changed (the profile refreshed, or the under-13 block): arming is
   * re-applied. `u13` never arms (ruling T12 (1)); the driver's saved choice is untouched.
   */
  setAgeBand(band: string | null): Promise<void>;
  /**
   * The session ended, whoever ended it (a `SIGNED_OUT` auth event; security r2-M2). A sign-out
   * the driver started has already stopped recording, and this only closes it. One they did not
   * start — a revoked or expired token, a password changed elsewhere — is handled exactly like
   * theirs (§8.2): an open drive is finalized under the device's owner, then auto-record is
   * disarmed, and only the owner's next real sign-in re-arms.
   */
  sessionEnded(): Promise<void>;
  /** The per-row detector context the engine is given (diagnostics). */
  detectorContext(): Omit<DetectorContext, 'mode'>;
}

export interface DriveHostDeps {
  db: Db;
  source: DriveSource;
  /**
   * The speed-limit client. A dry run (`persistence: 'none'`) never calls `startTrip` or `prefetch`,
   * the only calls that fetch and store tiles, so it cannot persist or use the network whatever
   * client it is given (review M2). It therefore gets limits only through `lookup()`: a real
   * client built with `persist: false` answers nothing in a dry run, so a simulation must pass a
   * source that answers from `lookup()` itself, such as U5's `fakeLimits`.
   */
  limits: SpeedLimitClient;
  player: AlertPlayer;
  scoring: typeof import('@scoring');
  traceWriter: TraceWriter | Pick<TraceWriter, 'writeGzip'>;
  hash: { sha256(t: string): Promise<string> };
  now: () => number;
  tz: () => string;
  newId: () => string;
  /** `none`: a dry run (parked simulation) — no checkpoint, finalize, setting or change event. */
  persistence?: 'full' | 'none';
  /** The remote feature flag (D2). Absent: treated as on. */
  readFlag?: (key: 'auto_detect') => Promise<boolean>;
  appState?: AppStateLike;
  onError?: (e: unknown, ctx: string) => void;
  /** The tick timer's clock; tests pass a manual one. Defaults to the global timers. */
  scheduler?: Scheduler;
  /** False when the player is a silent stand-in for sound that failed to load. Default true. */
  alertsAvailable?: boolean;
  /** Start with no driver signed in: nothing arms until `resumeAfterSignIn` (§8.2). */
  signedOut?: boolean;
  /**
   * The account's age band as the app last cached it (ruling T12 (1)), read once at `start`; the
   * UI then hands every change in through `setAgeBand`. A read that fails counts as unknown.
   */
  readAgeBand?: () => Promise<string | null>;
}

/** Scored driver trips: the learning period's count (rev1: m). */
export const TRIP_INDEX_SQL =
  "SELECT COUNT(*) AS n FROM trips WHERE role = 'driver' AND status IN ('provisional', 'final') AND deleted_at IS NULL";

/** Rows kept to answer the limit lookups of a candidate's replayed rows (≤ the 3-min window). */
const RECENT_ROWS = 200;

const noop = (): void => {};

/**
 * The alert player's live inputs, late-bound to a host that does not exist yet when the player is
 * built (the host takes the player as a dependency):
 *
 * ```ts
 * let host: DriveHost | undefined;
 * const player = createAlertPlayer({ ...ports, voiceEnabled, ...playerInputs(() => host) });
 * host = createDriveHost({ player, ... });
 * ```
 */
export function playerInputs(getHost: () => DriveHost | undefined): {
  callActive(): boolean;
  l1RespectsSilentSwitch(): boolean;
  deliverable(): boolean;
  onUnavailable(): void;
  onAvailable(): void;
} {
  return {
    onAvailable: () => getHost()?.reportAlertsAvailable(),
    // A sound that failed marks the drive's alerts unavailable (final review I2).
    onUnavailable: () => getHost()?.reportAlertsUnavailable(),
    callActive: () => getHost()?.snapshot().callActive ?? false,
    // Without a host, the playback session: the audible choice.
    l1RespectsSilentSwitch: () => getHost()?.l1RespectsSilentSwitch() ?? false,
    // Re-read by the player as each queued decision starts: a passenger hears nothing (§8.15),
    // including a decision queued just before the switch (P2 review M4).
    deliverable: () => getHost()?.snapshot().role !== 'passenger',
  };
}

export function createDriveHost(deps: DriveHostDeps): DriveHost {
  const { db, source, limits, player, scoring, now, tz, newId } = deps;
  const persist = (deps.persistence ?? 'full') === 'full';
  const settings = createSettingsRepo(db);

  function report(error: unknown, ctx: string): void {
    try {
      deps.onError?.(error, ctx);
    } catch {
      // A reporter that throws has nobody left to report to.
    }
  }

  // --- host-owned state ---------------------------------------------------------------------------
  let started = false;
  let intent = false;
  let tripIndex = 0;
  /** Until `getState` says otherwise, the signal that is never phone-use evidence. */
  let lockSignal: 'reliable' | 'lagged' | 'unreliable' = 'unreliable';
  let platform: 'ios' | 'android' = 'ios';
  let appActive = deps.appState?.currentState === 'active';
  let belief: CaptureBelief = { on: false, rate: null, mode: null };
  /** The plan a `startCapture` was refused for: not retried until the plan changes. */
  let refusedPlan: string | null = null;
  /**
   * A capture native started by itself (Android receiver or sticky restart, iOS relaunch) found
   * running at `start()`. It is not stopped while its trigger — the buffered wake — is still to be
   * judged: stopping and restarting a foreground service from the background can be refused.
   * Cleared by the first wake handled, or by the claim.
   */
  let inheritedCapture = false;
  let notified: string | null = null;
  let activeAlert: { decision: AlertDecision; until: number } | null = null;
  let mutedForDrive = false;
  let adoptMuted = false;
  /** A sound failed during this drive (I2); reset when the next trip opens. */
  let soundFailedThisDrive = false;
  /** The last arming decision: auto-record armed natively and in the engine (I4). */
  let autoDetectArmed = false;
  /** No driver signed in (§8.2, I3): arming, wakes and manual starts are refused. */
  let signedOut = deps.signedOut === true;
  /** Between `suspendForSignOut` and `signOutCompleted` (or a back-out): auth events are ignored. */
  let signingOut = false;
  /**
   * A sign-out completed in this process. From then on only a real sign-in re-arms: an
   * `INITIAL_SESSION` (a restored session) never does (ruling on H2 concern 2).
   */
  let signOutDone = false;
  /** The account's age band (ruling T12 (1)); null until known. Only `u13` blocks arming. */
  let ageBand: string | null = null;
  /** A session end the driver did not start is suspending (r2-M2): an owner sign-in waits for it. */
  let involuntaryEnd = false;
  /** The owner signed in while `involuntaryEnd` was suspending: applied once it completes (r3). */
  let signInWaiting = false;
  let thermal: ThermalLevel = 'nominal';
  let callActive = false;
  let screenLocked = false;
  let lastFinalized: LastFinalized = null;
  let currentRow: FeatureRow | null = null;
  const recent: FeatureRow[] = [];
  let startTripPending = false;
  let finalizedPending = false;
  let prevStatus: EngineStatus = 'off';
  let prevTripId: string | null = null;
  let subscriptions: (() => void)[] = [];
  const idleWaiters = new Set<() => void>();
  const listeners = new Set<(s: DriveState) => void>();
  const nightClock = createNightClock(scoring.CONSTANTS);
  let ctxCache: { key: string; value: Omit<DetectorContext, 'mode'> } | null = null;

  // --- engine wiring -------------------------------------------------------------------------------

  /** The row a limit lookup is for: the current one, or a replayed candidate row. */
  function rowAt(lat: number, lng: number): FeatureRow | null {
    if (currentRow && currentRow.lat === lat && currentRow.lng === lng) return currentRow;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const r = recent[i] as FeatureRow;
      if (r.lat === lat && r.lng === lng) return r;
    }
    return null;
  }

  function ctx(): Omit<DetectorContext, 'mode'> {
    const night = nightClock.at(now(), tz());
    const key = `${night}|${lockSignal}`;
    if (ctxCache?.key !== key) ctxCache = { key, value: detectorContext(night, lockSignal) };
    return ctxCache.value;
  }

  async function onFinalize(session: Readonly<TripSession>): Promise<void> {
    if (!persist) return;
    const id = session.clientTripId;
    try {
      // E2: without these every auto or moving-start drive would be asked about. The same helper
      // recovery uses (final review I1).
      const { rolePrior, habitualRoute } = await roleEvidenceFor(db, session);
      const result = await finalizeTrip(session, {
        db,
        scoring,
        tz: tz(),
        fs: deps.traceWriter,
        hash: deps.hash,
        now,
        rolePrior,
        habitualRoute,
      });
      lastFinalized = {
        clientTripId: id,
        ok: true,
        status: result.trip.status,
        short: isShortDrive(result.trip, scoring.CONSTANTS),
        at: now(),
      };
      finalizedPending = true;
    } catch (error) {
      // rev1: I16 — said honestly. A transient failure leaves the row `recording` for the next
      // launch's recovery; a payload the upload contract refuses (FinalizePayloadRefusedError) has
      // already been ended as `failed` with `invalid_payload`, so recovery never retries it. The
      // engine reports the error through `onError`.
      lastFinalized = { clientTripId: id, ok: false, at: now() };
      throw error;
    }
  }

  const engine = createEngine({
    now,
    newId,
    limits: {
      lookup: (lat, lng, course) => {
        const r = rowAt(lat, lng);
        return limits.lookup(lat, lng, course, r ? limitOptions(r) : { gnssValid: false, speedMps: null });
      },
      // M2: a dry run never fetches, so no client — whatever it was built with — stores a tile or
      // touches the network; lookups still read what memory and SQLite already hold.
      prefetch: (lat, lng, course) => {
        if (persist) limits.prefetch(lat, lng, course);
      },
    },
    createDetectors: () => createDetectors(newId),
    createArbiter: (resume) => createArbiter(resume ?? { tripIndex }),
    onAlert(decision) {
      activeAlert = { decision, until: decision.ts + ALERT_SHOWN_MS[decision.level] };
      player.deliver(decision).catch((e: unknown) => report(e, 'player'));
    },
    onCheckpoint: (session) =>
      persist ? createRecorder(db, { tz: tz(), now }).onCheckpoint(session) : Promise.resolve(),
    onFinalize,
    onError: (e) => report(e, 'engine'),
    ctx,
  });

  // --- the published state ------------------------------------------------------------------------

  function build(): DriveState {
    return Object.freeze({
      ...engine.snapshot(),
      activeAlert: activeAlert?.decision ?? null,
      mutedForDrive,
      gps: gpsQuality(currentRow),
      thermal,
      callActive,
      screenLocked,
      lastFinalized,
      tripIndex,
      dryRun: !persist,
      alertsAvailable: (deps.alertsAvailable ?? true) && !soundFailedThisDrive,
      autoDetectArmed,
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

  engine.subscribe((s) => {
    let opened = false;
    let closed = false;
    if (s.clientTripId !== prevTripId) {
      if (s.clientTripId !== null) opened = true;
      prevTripId = s.clientTripId;
    }
    if (s.status !== prevStatus) {
      if (s.status !== 'recording') activeAlert = null;
      if (isIdleStatus(s.status) && isBusyStatus(prevStatus)) closed = true;
      prevStatus = s.status;
    }
    if (opened) {
      // A new trip, confirmed or adopted: its own mute, and one tile batch at its first fix (S2).
      mutedForDrive = adoptMuted;
      adoptMuted = false;
      soundFailedThisDrive = false;
      startTripPending = true;
      if (currentRow?.gnssValid) startTripNow(currentRow);
    }
    if (closed) {
      limits.resetTrip(); // frees the decoded tiles: an armed process holds none
      startTripPending = false;
      currentRow = null;
      recent.length = 0;
    }
    publish();
    if (closed) afterClose();
  });

  function startTripNow(row: FeatureRow): void {
    startTripPending = false;
    if (persist) limits.startTrip(row.lat, row.lng, row.course);
  }

  /** The drive has closed and the snapshot already says armed/off. */
  function afterClose(): void {
    // Release the audio session: nothing guarantees the last alert's release worked (P2 M2).
    player.stopCurrent().catch((e: unknown) => report(e, 'player'));
    if (finalizedPending) {
      finalizedPending = false;
      // Now the runner may drain (rev1: m): the snapshot is armed/off, not finalizing.
      emitDataChanged({ source: 'finalize' }, (e) => report(e, 'dataChanged'));
      void run(refreshTripIndex, 'tripIndex');
    }
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
  }

  // --- the queue ---------------------------------------------------------------------------------

  let chain: Promise<void> = Promise.resolve();

  /** Run `fn` after everything queued before it, then reconcile. Never rejects: failures are reported. */
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
    if (!started) return;
    const s = engine.snapshot();
    await reconcileCapture(s);
    await reconcileNotification(s);
    ticker.update(s.status);
  }

  async function runCommand(cmd: CaptureCommand): Promise<void> {
    switch (cmd.type) {
      case 'startCapture':
        await source.startCapture(cmd.mode);
        inheritedCapture = false;
        belief = { on: true, rate: belief.on ? belief.rate : null, mode: cmd.mode };
        return;
      case 'setCaptureRate':
        await source.setCaptureRate(cmd.rate);
        belief = { ...belief, rate: cmd.rate };
        return;
      case 'stopCapture':
        await source.stopCapture();
        belief = { on: false, rate: null, mode: null };
        return;
    }
  }

  async function reconcileCapture(s: EngineSnapshot): Promise<void> {
    const plan = capturePlan(s.status, s.mode);
    if (inheritedCapture && plan !== 'keep' && !plan.on) return;
    const key = plan === 'keep' ? 'keep' : plan.on ? `${plan.rate}|${plan.mode}` : 'off';
    if (key === refusedPlan) return;
    refusedPlan = null;
    for (const cmd of captureCommands(belief, plan)) {
      try {
        await runCommand(cmd);
      } catch (e) {
        report(e, cmd.type);
        // Not retried on every event: only once the plan changes (a permission prompt, SR9 silent).
        if (cmd.type === 'startCapture') refusedPlan = key;
        return;
      }
    }
  }

  /** Android S3: the notification follows the drive, sent on change only; iOS has none. */
  async function reconcileNotification(s: EngineSnapshot): Promise<void> {
    if (platform !== 'android' || !belief.on || !isBusyStatus(s.status)) {
      if (!belief.on) notified = null;
      return;
    }
    const state = notificationStateOf(s);
    const key = `${state.stationary}|${state.startedAt}`;
    if (key === notified) return;
    notified = key;
    await source.setNotificationState(state).catch((e: unknown) => report(e, 'setNotificationState'));
  }

  // --- native events -------------------------------------------------------------------------------

  async function onWake(reason: 'significantChange' | 'activityTransition' | 'boot' | 'geofence'): Promise<void> {
    try {
      // Only an armed engine opens a candidate; anything else owns the drive already. And nothing
      // is opened with nobody signed in (final-fix security M-1), whatever the engine says.
      if (signedOut || engine.snapshot().status !== 'armed') return;
      const t = now();
      const history = await source.queryMotionHistory(t - WAKE_HISTORY_S * 1000, t);
      const candidateStartTs = wakeStart(history);
      if (candidateStartTs === null) return;
      await engine.dispatch({ type: 'wake', reason, ts: now(), candidateStartTs });
    } finally {
      // The wake that explains an inherited capture has been judged: claimed, or now stopped.
      inheritedCapture = false;
    }
  }

  async function onRow(row: FeatureRow): Promise<void> {
    currentRow = row;
    recent.push(row);
    if (recent.length > RECENT_ROWS) recent.shift();
    screenLocked = row.locked;
    if (activeAlert !== null && row.ts >= activeAlert.until) activeAlert = null;
    if (startTripPending && row.gnssValid) startTripNow(row);
    await engine.dispatch({ type: 'row', row });
    if (shouldSelfDispatch(engine.snapshot().status, row)) {
      // M1 post-gap note: the engine went back to armed on this very row; it opens the next drive.
      await engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: row.ts });
      await engine.dispatch({ type: 'row', row });
    }
  }

  function attachNative(): void {
    subscriptions.push(
      remover(source.addListener('wake', (p) => void run(() => onWake(p.reason), 'wake'))),
      remover(
        source.addListener('activity', (a) => {
          void run(async () => {
            const e = activityEvent(a, now());
            if (e) await engine.dispatch(e);
          }, 'activity');
        })
      ),
      remover(
        source.addListener('row', (raw) => {
          const row = parseRow(raw);
          if (row === null) return; // the contract says drop it, never throw on the hot path
          void run(() => onRow(row), 'row');
        })
      ),
      remover(
        source.addListener('screen', (p) => {
          screenLocked = p.locked;
          publish();
        })
      ),
      remover(
        source.addListener('thermal', (p) => {
          thermal = p.level;
          publish();
        })
      ),
      remover(
        source.addListener('call', (p) => {
          const ended = callActive && !p.active;
          callActive = p.active;
          publish();
          // expo-audio re-activates the session by itself when an interruption ends (P2-M2): with
          // no alert showing, an idle stop releases it so music is not left ducked.
          if (ended && activeAlert === null) {
            player.stopCurrent().catch((e: unknown) => report(e, 'player'));
          }
        })
      ),
      remover(
        source.addListener('notificationAction', (p) => {
          if (p.action !== 'endDrive') return;
          void run(async () => {
            if (endDriveAllowed(engine.snapshot())) await engine.dispatch({ type: 'end', ts: now() });
          }, 'notificationAction');
        })
      )
    );
  }

  const remover = (sub: { remove(): void }) => () => sub.remove();

  // --- arming, trip index, adopt -------------------------------------------------------------------

  async function refreshTripIndex(): Promise<void> {
    const { rows } = await db.execute(TRIP_INDEX_SQL);
    const n = Number(rows[0]?.n ?? 0);
    if (n !== tripIndex) {
      tripIndex = n;
      publish();
    }
  }

  async function applyArming(): Promise<void> {
    if (!started) return;
    const state = await source.getState();
    lockSignal = state.lockSignal;
    let flag = true;
    if (deps.readFlag) {
      try {
        flag = await deps.readFlag('auto_detect');
      } catch (e) {
        report(e, 'readFlag');
        flag = false;
      }
    }
    const arm = shouldArm({
      intent,
      flag,
      location: state.location,
      motion: state.motion,
      signedIn: !signedOut,
      ageBand,
    });
    if (arm) {
      try {
        await source.arm();
        await engine.dispatch({ type: 'arm' });
        setArmed(true);
        return;
      } catch (e) {
        report(e, 'arm');
      }
    } else if (state.armed) {
      await source.disarm().catch((e: unknown) => report(e, 'disarm'));
    }
    await engine.dispatch({ type: 'disarm' });
    setArmed(false);
  }

  function setArmed(next: boolean): void {
    if (autoDetectArmed === next) return;
    autoDetectArmed = next;
    publish();
  }

  async function adopt(trip: TripRow): Promise<boolean> {
    const rebuilt = await rebuildFromSamples(db, trip, {
      createDetectors: () => createDetectors(newId),
      limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
      tz: tz(),
      constants: scoring.CONSTANTS,
    });
    if (rebuilt === null) return false;
    adoptMuted = rebuilt.arbiterState?.mutedAll === true;
    await engine.dispatch({
      type: 'adopt',
      trip: {
        session: rebuilt.session,
        detectors: rebuilt.detectors,
        checkpointTs: trip.checkpoint_ts ?? rebuilt.session.lastRowTs ?? trip.started_at,
        arbiterState: rebuilt.arbiterState,
      },
      ts: now(),
    });
    // E1 adopt protocol: adopt is ignored unless the engine was idle; the caller finalizes an orphan.
    const adopted = engine.snapshot().clientTripId === trip.client_trip_id;
    adoptMuted = false;
    return adopted;
  }

  // --- the host ------------------------------------------------------------------------------------

  const dispatch = (what: string, e: Parameters<typeof engine.dispatch>[0]) =>
    run(() => engine.dispatch(e), what);

  async function settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = chain;
      await seen;
    } while (seen !== chain);
  }

  // Bound as a named object, never through `this`: the layout may hold a detached reference, and
  // a `this` that is undefined would throw into a swallowed `.catch` and leave recording on (r3).
  const self: DriveHost = {
    async start(opts = {}) {
      if (started) return { adopted: false };
      started = true;
      let adopted = false;
      await run(async () => {
        try {
          const state = await source.getState();
          lockSignal = state.lockSignal;
          platform = state.platform;
          // C1: a capture found running is UNCLAIMED — mode null — so the first reconcile sends the
          // JS claim (`startCapture`, README §6) even when native already runs in the plan's mode;
          // without it native's 60 s watchdog stops the capture and the drive is lost.
          belief = { on: state.capturing, rate: state.capturing ? state.rate : null, mode: null };
          inheritedCapture = state.capturing;
        } catch (e) {
          report(e, 'getState');
        }
        if (persist) intent = (await settings.get<boolean>(AUTO_DETECT_SETTING_KEY)) === true;
        if (deps.readAgeBand && ageBand === null) {
          try {
            ageBand = await deps.readAgeBand();
          } catch (e) {
            report(e, 'ageBand');
          }
        }
        await refreshTripIndex().catch((e: unknown) => report(e, 'tripIndex'));
        // rev1: I2 — before any native listener exists and before arming, so a buffered wake
        // cannot open a second trip for the same drive.
        if (opts.adopt && persist) {
          try {
            adopted = await adopt(opts.adopt);
          } catch (e) {
            report(e, 'adopt');
          }
        }
        // An under-13 account records nothing (u13 security M-2): a trip the relaunch adopted is
        // ended and finalized under the owner as usual, and nothing is recorded onto it.
        if (ageBand === 'u13') {
          if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
          // Nor is a capture native started kept waiting for a wake: nothing may be recorded, so
          // it is stopped at the first reconcile rather than left to the 60 s watchdog.
          inheritedCapture = false;
        }
        attachNative();
        if (deps.appState) {
          subscriptions.push(
            remover(
              deps.appState.addEventListener('change', (next) => {
                appActive = next === 'active';
                // A return from Settings, or any permission changed while away (I4): one
                // `getState` read on the foreground transition — never while armed and idle.
                if (appActive) void run(applyArming, 'arming');
              })
            )
          );
        }
        if (persist) {
          subscriptions.push(
            onDataChanged((e) => {
              if (e.source === 'hydrate') void run(refreshTripIndex, 'tripIndex');
            })
          );
        }
        await applyArming();
      }, 'start');
      return { adopted };
    },

    async stop({ endOpenTrip }) {
      if (!started) return;
      if (endOpenTrip) {
        await run(async () => {
          if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
        }, 'stop');
      }
      await settled();
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      ticker.stop();
      started = false;
      for (const resolve of [...idleWaiters]) resolve();
      idleWaiters.clear();
    },

    manualStart: ({ mode, passenger, evidence }) =>
      run(async () => {
        // No drive is recorded for nobody (§8.2; final-fix security M-1), nor for an under-13
        // account (u13 security M-2): it would sit on the phone and fail as a permanent 403.
        if (signedOut || ageBand === 'u13') return;
        await engine.dispatch({ type: 'manualStart', mode, passenger, evidence, ts: now() });
      }, 'manualStart'),

    end: () => dispatch('end', { type: 'end', ts: now() }),

    setPassenger: (passenger) => dispatch('setPassenger', { type: 'setPassenger', passenger, ts: now() }),

    setMode: (mode) => dispatch('setMode', { type: 'setMode', mode, ts: now() }),

    async muteCurrentAlert() {
      // The sound stops first, before anything queued; then the arbiter mutes the repeats.
      activeAlert = null;
      publish();
      await Promise.all([
        player.stopCurrent().catch((e: unknown) => report(e, 'player')),
        dispatch('muteCurrent', { type: 'muteCurrent', ts: now() }),
      ]);
    },

    async muteForDrive() {
      await Promise.all([
        player.stopCurrent().catch((e: unknown) => report(e, 'player')),
        run(async () => {
          if (engine.snapshot().clientTripId === null) return;
          await engine.dispatch({ type: 'muteForDrive', ts: now() });
          mutedForDrive = true;
          activeAlert = null;
          publish();
        }, 'muteForDrive'),
      ]);
    },

    announce: (key) => player.announce(key).catch((e: unknown) => report(e, 'player')),

    setAutoDetect: (enabled) =>
      run(async () => {
        intent = enabled;
        if (persist) await settings.set(AUTO_DETECT_SETTING_KEY, enabled);
        await applyArming();
      }, 'setAutoDetect'),

    autoDetectEnabled: () => intent,
    isBusy: () => isBusyStatus(engine.snapshot().status),
    captureActive: () => belief.on,

    async untilIdle() {
      for (;;) {
        await settled();
        if (!isBusyStatus(engine.snapshot().status) || !started) {
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

    refreshArming: () => run(applyArming, 'arming'),

    async suspendForSignOut() {
      // Ended and finalized under the owner who is still signed in, before the session goes; and
      // disarmed in the same task, so nothing can open a trip between the two (security M-1).
      await run(async () => {
        signedOut = true;
        signingOut = true;
        if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
        await engine.dispatch({ type: 'disarm' });
      }, 'signOut');
      await self.untilIdle();
      await run(applyArming, 'signOut');
    },

    resumeAfterSignIn: () =>
      run(async () => {
        signingOut = false;
        if (!signedOut) return;
        signedOut = false;
        await applyArming();
      }, 'signIn'),

    signedInAgain: (opts = {}) =>
      run(async () => {
        // The owner signed straight back in while a session end they did not start is still
        // stopping: applied once it completes, so they miss no drives (security r3). A sign-out
        // the driver started still refuses it (I-1).
        if (involuntaryEnd && opts.initial !== true) {
          signInWaiting = true;
          return;
        }
        if (signingOut || !signedOut) return;
        // A restored session at launch (a slow keychain, `INITIAL_SESSION`) re-arms a host that
        // started signed out — never once a sign-out has completed in this process.
        if (opts.initial === true && signOutDone) return;
        signedOut = false;
        await applyArming();
      }, 'signIn'),

    signOutCompleted() {
      signingOut = false;
      signOutDone = true;
    },

    setAgeBand: (band) =>
      run(async () => {
        if (band === ageBand) return;
        ageBand = band;
        // A drive open when the account turns out to be under 13 is ended and finalized, like the
        // one a relaunch adopted (u13 security M-2).
        if (band === 'u13' && isBusyStatus(engine.snapshot().status)) {
          await engine.dispatch({ type: 'end', ts: now() });
        }
        await applyArming();
      }, 'ageBand'),

    async sessionEnded() {
      // Recording is still on (no sign-out stopped it, or the owner signed in again since).
      if (!signingOut && !signedOut) {
        involuntaryEnd = true;
        try {
          await self.suspendForSignOut();
        } finally {
          involuntaryEnd = false;
        }
      }
      self.signOutCompleted();
      if (signInWaiting) {
        signInWaiting = false;
        await self.signedInAgain();
      }
    },

    l1RespectsSilentSwitch: () =>
      l1RespectsSilentSwitch({ mode: engine.snapshot().mode, screenLocked }, appActive),

    detectorContext: ctx,
  };
  return self;
}
