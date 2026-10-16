// The drive host (product spec v3 "Starting and ending a drive", "Driving screen"; plan §5, §6, §10).
//
// One object wires the native capture module, the engine, the detectors, the speed-limit client,
// the alert player, the background display and persistence together, and publishes one `DriveState`
// for the UI. Rules:
// - **Manual start only.** `start()` is the one way a drive begins: it asks for While-Using location
//   just in time, then starts the capture, at any speed; nothing reads the speed on the tap. Nothing here
//   starts a drive from a notification, a wake or a relaunch; `boot({ adopt })` only continues a
//   drive the user already started (the previous process died recording it).
// - **One queue.** Every engine dispatch and the native command that follows it run on one serial
//   chain; after each task the capture is reconciled with the engine's state.
// - **Battery.** Nothing runs while idle: no timer, no read. While recording, one timeout at most
//   (the automatic end, re-armed lazily: `ticks.ts`), the display throttled to one update per 3 s, the points estimate
//   computed once per stop, and the state published at most once per row.
// - **Background.** Each row first pumps the process's timers (`src/lib/timers.ts`): with the app
//   in the Android background JS timers are paused, and the rows are what keeps the alert player
//   and the DashPal link moving.
import { parseActivity, parseRow } from '@drive-sense';
import { MERGE_GAP_S, scoreDrive, type DriveContext } from '@scoring';

import { decisionFor } from '@/core/alerts/policy';
import type { AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import { knownSpeed } from '@/core/detectors/common';
import type { AdoptedTrip, AlertEvent, EndCause, EngineSnapshot, EngineStatus, TripSession } from '@/core/engine/engine.types';
import { closeDrive, isDropped, type DropReason } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { createRecorder } from '@/core/engine/recorder';
import type { FeatureRow } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { dashcamFinalizeDeps } from '@/dashcam/finalizeDeps';
import { createTripsRepo, type Db, type TripStatus } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { emitDataChanged } from '@/data/events';
import type { AppStateLike } from '@/data/foreground';
import { processTimers } from '@/lib/timers';
import { KMH_PER_MPH, metersToMiles, mpsToMph } from '@/lib/units';

import type { DriveDisplay } from './display';
import { clearDropNotice, writeDropNotice } from './dropNotice';
import { detectorContext, isBusyStatus } from './policy';
import type { DriveSource } from './source';
import { createTicker, type Scheduler } from './ticks';

export type { DriveSource } from './source';

/**
 * The outcome of the last finalize, for the end flow and the summary notification. `dropped`: the
 * drive was not kept (it never moved), so it has no row, status or points.
 */
export type LastFinalized =
  | { clientTripId: string; ok: true; status: TripStatus | null; pointsNet: number | null; dropped: DropReason | null; endCause: EndCause; at: number }
  | { clientTripId: string; ok: false; at: number }
  | null;

export interface DrivePoints {
  total: number;
  sinceLastStop: number;
}

export interface DriveState extends EngineSnapshot {
  /** A hands-free call is active (iOS CallKit observer; Android phone-state receiver where present). */
  callActive: boolean;
  screenLocked: boolean;
  lastFinalized: LastFinalized;
  /** False when a sound failed during this drive; the drive still records, silently. */
  alertsAvailable: boolean;
  /** The local estimate, non-null only while stopped (≤ 5 mph). */
  points: DrivePoints | null;
  /** A `persistence: 'none'` host (the diagnostics simulation): nothing is stored. */
  dryRun: boolean;
  /** Compatibility for consumers written against v2: a v3 drive is always a mounted driver's. */
  mode: 'mounted';
  role: 'driver';
}

export type StartResult = { ok: true; clientTripId: string } | { ok: false; reason: 'permission' | 'busy' | 'error' };

export interface DriveHost {
  /** Attach to native events; continue `adopt` (a drive the previous process was recording). */
  boot(opts?: { adopt?: AdoptedTrip | null }): Promise<void>;
  /** The user's Start Drive tap, at any speed. Refuses without location, while busy, or signed out. */
  start(): Promise<StartResult>;
  /**
   * The hold-to-end. Resolves once the drive is finalized; null when none was open. `dropped`: that
   * drive was not kept (whichever end closed it: this one or an automatic end it raced).
   */
  end(): Promise<{ clientTripId: string; dropped: DropReason | null } | null>;
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
  /** Sign-out: an open drive is ended and finalized under the current owner. */
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
}

/**
 * The DashPal dashcam, as the host drives it (plan §7.7; `src/dashcam/runtime.ts`). Every hook is
 * optional work beside the drive: a failure never stops a row, an alert or a finalize.
 */
export interface DriveHostDashcam {
  /** Every drive row: the dashcam's context (STATE, its tick) and this drive's coverage. */
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean }): void;
  /** A drive continued after a relaunch: its coverage totals are reloaded. */
  adopt(clientTripId: string): Promise<void>;
  /** The stopped-points estimate: a DashPal drive so far. */
  estimateOn(clientTripId: string | null): boolean;
  /** Drive end: wait ≤ 3 s for the phone to catch up to the dashcam, then stamp the sync time. */
  beforeFinalize(clientTripId: string, opts: { dryRun: boolean }): Promise<void>;
  /** A DashPal continuous alert is active: phone alerts are then haptic + visual only. */
  continuousAlertActive(): boolean;
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
  /** Just-in-time permissions: While-Using location (required; asked when never answered). */
  permissions?: () => Promise<{ location: 'granted' | 'denied' }>;
  /** The cached summary context for the points estimate; null when nothing is cached. */
  context?: () => Promise<DriveContext | null>;
  voiceEnabled?: () => boolean;
  appState?: AppStateLike;
  scheduler?: Scheduler;
  alertsAvailable?: boolean;
  signedOut?: boolean;
  /** `none`: a dry run (a simulation) — no checkpoint, finalize or change event. */
  persistence?: 'full' | 'none';
  /** The DashPal dashcam (none: no hooks). */
  dashcam?: DriveHostDashcam;
  /**
   * Called as each row arrives: fires the pumped timers that are due (`src/lib/timers.ts`), which
   * Android leaves unfired while the app is in the background. Default: the process's.
   */
  pump?: () => void;
  onError?: (e: unknown, ctx: string) => void;
}

const noop = (): void => {};

/** The local mirror of `profiles.units` (plan §10): 'km' shows km/h on the background display. */
export const UNITS_KEY = 'units';
export type DisplayUnit = 'mph' | 'km/h';

/** A whole speed or limit in the display's unit; null stays null. */
export const inDisplayUnit = (mph: number | null, unit: DisplayUnit): number | null =>
  mph === null ? null : Math.round(unit === 'km/h' ? mph * KMH_PER_MPH : mph);

export function createDriveHost(deps: DriveHostDeps): DriveHost {
  const { db, source, limits, player, now, tz, newId } = deps;
  const persist = (deps.persistence ?? 'full') === 'full';

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
  let callActive = false;
  let screenLocked = false;
  let lastFinalized: LastFinalized = null;
  let soundFailedThisDrive = false;
  let signedOut = deps.signedOut === true;
  let signingOut = false;
  let points: DrivePoints | null = null;
  /** The driver's units, read as the drive starts; every display call of the drive uses it. */
  let displayUnit: DisplayUnit = 'mph';
  let pointsCtx: DriveContext = { streak: 0, safeMilesEarlierToday: 0 };
  let lastStopTotal = 0;
  let wasStopped = false;
  let startTripPending = false;
  let finalizedPending = false;
  let prevStatus: EngineStatus = 'idle';
  let subscriptions: (() => void)[] = [];
  const idleWaiters = new Set<() => void>();
  const listeners = new Set<(s: DriveState) => void>();

  // --- engine wiring -------------------------------------------------------------------------------

  async function onFinalize(session: Readonly<TripSession>): Promise<void> {
    if (!persist) return;
    const id = session.clientTripId;
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
        context: async () => (await deps.context?.()) ?? null,
        ...dashcamFinalizeDeps(db),
      });
      const endCause = session.endCause ?? 'manual';
      if (isDropped(result)) {
        lastFinalized = { clientTripId: id, ok: true, status: null, pointsNet: null, dropped: result.dropped, endCause, at: now() };
        // Home says why; no OS notification (nothing was earned or lost).
        await writeDropNotice(db, { clientTripId: id, cause: endCause, reason: result.dropped, at: now() }).catch((e: unknown) => report(e, 'dropNotice'));
      } else {
        lastFinalized = { clientTripId: id, ok: true, status: result.trip.status, pointsNet: result.trip.points_net, dropped: null, endCause, at: now() };
      }
      finalizedPending = true;
    } catch (error) {
      lastFinalized = { clientTripId: id, ok: false, at: now() };
      throw error;
    }
  }

  const recorder = createRecorder(db, { tz: tz(), now });

  const engine = createEngine({
    now,
    newId,
    limits: {
      lookup: (lat, lng, course) => limits.lookup(lat, lng, course, { gnssValid: true, speedMps: null }),
      prefetch: (lat, lng, course) => {
        if (persist) limits.prefetch(lat, lng, course);
      },
    },
    createDetectors: () => createDetectors(newId),
    ctx: () => detectorContext(callActive),
    onAlert(alert: AlertEvent) {
      const decision = decisionFor(alert, { voiceEnabled: deps.voiceEnabled?.() ?? false });
      // A DashPal continuous alert owns the sound: a phone alert meanwhile is haptic + visual only.
      if (dashcamAlertActive()) decision.silent = true;
      player.deliver(decision).catch((e: unknown) => report(e, 'player'));
    },
    onCheckpoint: (session) => (persist ? recorder.onCheckpoint(session) : Promise.resolve()),
    onFinalize,
    onError: (e) => report(e, 'engine'),
  });

  // --- the published state ------------------------------------------------------------------------

  function build(): DriveState {
    return Object.freeze({
      ...engine.snapshot(),
      callActive,
      screenLocked,
      lastFinalized,
      alertsAvailable: (deps.alertsAvailable ?? true) && !soundFailedThisDrive,
      points,
      dryRun: !persist,
      mode: 'mounted' as const,
      role: 'driver' as const,
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

  /**
   * The local estimate for the drive so far, computed once per stop. A DashPal drive so far counts
   * its bonus; DashPal deductions are not estimated (they are decided at the end).
   */
  function estimateNow(): number {
    const s = engine.session();
    if (s === null) return 0;
    const miles = metersToMiles(s.distanceM);
    let dashcamOn = false;
    try {
      dashcamOn = deps.dashcam?.estimateOn(s.clientTripId) ?? false;
    } catch (e) {
      report(e, 'dashcam');
    }
    const bd = scoreDrive(
      { miles, safeMiles: Math.min(miles, metersToMiles(s.safeDistanceM)), events: s.events.map(({ measured: _m, ...e }) => e), dashcam: dashcamOn },
      pointsCtx
    );
    return bd.scored ? bd.net : 0;
  }

  function updatePoints(s: EngineSnapshot): void {
    if (s.status !== 'recording') {
      points = null;
      wasStopped = false;
      return;
    }
    if (s.stopped && !wasStopped) {
      const total = estimateNow();
      points = { total, sinceLastStop: total - lastStopTotal };
      lastStopTotal = total;
    } else if (!s.stopped) {
      // Not a confirmed stop (a known speed ≤ 5 mph): no points, whether moving or without a fix —
      // a fix lost while pulling away must not leave the stopped estimate on the screen.
      points = null;
    }
    wasStopped = s.stopped;
  }

  function display(s: EngineSnapshot): void {
    if (!deps.display || s.status !== 'recording') return;
    deps.display.update({
      speed: s.speedKnown ? inDisplayUnit(mpsToMph(s.speedMps), displayUnit) : null,
      limit: inDisplayUnit(s.limitMph, displayUnit),
      unit: displayUnit,
      points: points?.total ?? null,
      pointsDelta: points?.sinceLastStop ?? null,
      stopped: s.stopped,
    });
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
      soundFailedThisDrive = false;
      points = null;
      lastStopTotal = 0;
      wasStopped = false;
      startTripPending = true;
      deps.display?.start({ speed: null, limit: null, unit: displayUnit, points: null, pointsDelta: null, stopped: true });
    }
    updatePoints(s);
    display(s);
    if (closed) {
      limits.resetTrip();
      startTripPending = false;
      deps.display?.end();
    }
    publish();
    if (closed) afterClose();
  });

  function afterClose(): void {
    player.stopCurrent().catch((e: unknown) => report(e, 'player'));
    if (finalizedPending) {
      finalizedPending = false;
      emitDataChanged({ source: 'finalize' }, (e) => report(e, 'dataChanged'));
    }
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
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
  }

  async function reconcileCapture(status: EngineStatus): Promise<void> {
    const want = status === 'recording';
    if (want === captureOn) return;
    try {
      if (want) await source.startCapture('mounted');
      else await source.stopCapture();
      captureOn = want;
    } catch (e) {
      report(e, want ? 'startCapture' : 'stopCapture');
    }
  }

  /**
   * The phone's previous drive ended within `MERGE_GAP_S` of this tap (a restart): the new drive has
   * no warm-up, so End then Start never buys 30 s without events. Unreadable: false.
   */
  async function continuesPrevious(at: number): Promise<boolean> {
    if (!persist) return false;
    try {
      const last = await createTripsRepo(db).lastEndedAt();
      return last !== null && at - last <= MERGE_GAP_S * 1000;
    } catch (e) {
      report(e, 'continues');
      return false;
    }
  }

  // --- native events -------------------------------------------------------------------------------

  async function onRow(row: FeatureRow): Promise<void> {
    screenLocked = row.locked;
    if (startTripPending && row.gnssValid) {
      startTripPending = false;
      if (persist) limits.startTrip(row.lat, row.lng, row.course);
    }
    await engine.dispatch({ type: 'row', row });
    if (deps.dashcam) {
      const snap = engine.snapshot();
      try {
        deps.dashcam.row(row, { clientTripId: snap.clientTripId, recording: snap.status === 'recording', dryRun: !persist });
      } catch (e) {
        report(e, 'dashcam');
      }
    }
  }

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
          const row = parseRow(raw);
          if (row === null) return;
          void run(() => onRow(row), 'row');
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
        source.addListener('screen', (p) => {
          screenLocked = p.locked;
        })
      ),
      remover(
        // Android's drive notification offers End drive while stopped: a manual end at the tap, with
        // the same rules as the hold (cut after 2 min standing still, dropped if it never moved). A
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
        if (opts.adopt) {
          try {
            pointsCtx = (await deps.context?.()) ?? pointsCtx;
          } catch (e) {
            report(e, 'context');
          }
          await readDisplayUnit();
          await engine.dispatch({ type: 'adopt', trip: opts.adopt, ts: now() });
          await deps.dashcam?.adopt(opts.adopt.session.clientTripId).catch((e: unknown) => report(e, 'dashcam'));
        }
        attachNative();
      }, 'boot');
    },

    async start() {
      if (!booted || signedOut) return { ok: false, reason: 'error' };
      if (isBusyStatus(engine.snapshot().status)) return { ok: false, reason: 'busy' };
      try {
        const perms = await deps.permissions?.();
        if (perms !== undefined && perms.location !== 'granted') return { ok: false, reason: 'permission' };
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
        try {
          const state = await source.getState();
          captureOn = state.capturing;
        } catch (e) {
          report(e, 'getState');
        }
        try {
          pointsCtx = (await deps.context?.()) ?? { streak: 0, safeMilesEarlierToday: 0 };
        } catch (e) {
          report(e, 'context');
          pointsCtx = { streak: 0, safeMilesEarlierToday: 0 };
        }
        await readDisplayUnit();
        const at = now();
        await engine.dispatch({ type: 'start', ts: at, continues: await continuesPrevious(at) });
        const id = engine.snapshot().clientTripId;
        if (id === null) return;
        try {
          await source.startCapture('mounted');
          captureOn = true;
        } catch (e) {
          report(e, 'startCapture');
          await engine.dispatch({ type: 'end', ts: now() });
          return;
        }
        result = { ok: true, clientTripId: id };
        // A new drive replaces Home's notice about the last one that was not kept.
        if (persist) await clearDropNotice(db).catch((e: unknown) => report(e, 'dropNotice'));
      }, 'start');
      return result;
    },

    async end() {
      const id = engine.snapshot().clientTripId;
      if (id === null) return null;
      await run(() => engine.dispatch({ type: 'end', ts: now() }), 'end');
      await self.untilIdle();
      const f = lastFinalized;
      return { clientTripId: id, dropped: f !== null && f.ok && f.clientTripId === id ? f.dropped : null };
    },

    async stop({ endOpenTrip }) {
      if (!booted) return;
      if (endOpenTrip) {
        await run(async () => {
          if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
        }, 'stop');
      }
      await settled();
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions = [];
      ticker.stop();
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
        if (isBusyStatus(engine.snapshot().status)) await engine.dispatch({ type: 'end', ts: now() });
      }, 'signOut');
      await self.untilIdle();
    },
    resumeAfterSignIn: () =>
      run(() => {
        signingOut = false;
        signedOut = false;
      }, 'signIn'),
    signedInAgain: () =>
      run(() => {
        if (signingOut) return;
        signedOut = false;
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
