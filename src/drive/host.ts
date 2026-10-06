// The drive host (product spec v3 "Starting and ending a drive", "Driving screen"; plan §5, §6, §10).
//
// One object wires the native capture module, the engine, the detectors, the speed-limit client,
// the alert player, the background display and persistence together, and publishes one `DriveState`
// for the UI. Rules:
// - **Manual start only.** `start()` is the one way a drive begins: it refuses at or above 3 mph,
//   asks for While-Using location and motion just in time, then starts the capture. Nothing here
//   starts a drive from a notification, a wake or a relaunch; `boot({ adopt })` only continues a
//   drive the user already started (the previous process died recording it).
// - **One queue.** Every engine dispatch and the native command that follows it run on one serial
//   chain; after each task the capture is reconciled with the engine's state.
// - **Battery.** Nothing runs while idle: no timer, no read. While recording, one timeout at most
//   (the auto-end deadline), the display throttled to one update per 3 s, the points estimate
//   computed once per stop, and the state published at most once per row.
import { parseRow } from '@drive-sense';
import { scoreDrive, type DriveContext } from '@scoring';

import { decisionFor } from '@/core/alerts/policy';
import type { AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import { knownSpeed } from '@/core/detectors/common';
import type { AdoptedTrip, AlertEvent, EngineSnapshot, EngineStatus, TripSession } from '@/core/engine/engine.types';
import { finalizeTrip } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { createMotionEvidence, type MotionEvidence, type MotionEvidenceSource } from '@/core/engine/motionEvidence';
import { createRecorder } from '@/core/engine/recorder';
import type { Detector, FeatureRow } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import type { Db, TripStatus } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import type { AppStateLike } from '@/data/foreground';
import { metersToMiles, mpsToMph } from '@/lib/units';

import type { DriveDisplay } from './display';
import { detectorContext, isBusyStatus, isMoving, walkingReported } from './policy';
import type { DriveSource } from './source';
import { createTicker, type Scheduler } from './ticks';

export type { DriveSource } from './source';

/** The outcome of the last finalize, for the end flow and the summary notification. */
export type LastFinalized =
  | { clientTripId: string; ok: true; status: TripStatus; pointsNet: number | null; at: number }
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
  /** The DMS is running for this drive. */
  dmsActive: boolean;
  /** The local estimate, non-null only while stopped (≤ 5 mph). */
  points: DrivePoints | null;
  /** A `persistence: 'none'` host (the diagnostics simulation): nothing is stored. */
  dryRun: boolean;
  /** Compatibility for consumers written against v2: a v3 drive is always a mounted driver's. */
  mode: 'mounted';
  role: 'driver';
}

export type StartResult = { ok: true; clientTripId: string } | { ok: false; reason: 'moving' | 'permission' | 'busy' | 'error' };

/** The part of the DMS controller's `presence()` the host reads: the frame clock of the last face. */
export interface DriverPresence {
  lastFaceT: number | null;
}

/** A face this recent (ms) is a driver in the seat. */
export const FACE_RECENT_MS = 60_000;

export interface DriveHost {
  /** Attach to native events; continue `adopt` (a drive the previous process was recording). */
  boot(opts?: { adopt?: AdoptedTrip | null }): Promise<void>;
  /** The user's Start Drive tap. Refuses at ≥ 3 mph, without location, while busy, or signed out. */
  start(opts: { dmsOn: boolean }): Promise<StartResult>;
  /** The hold-to-end. Resolves once the drive is finalized; null when none was open. */
  end(): Promise<{ clientTripId: string } | null>;
  stop(opts: { endOpenTrip: boolean }): Promise<void>;
  isBusy(): boolean;
  captureActive(): boolean;
  /** Resolves once no drive is open or closing and the host's queue has drained. */
  untilIdle(): Promise<void>;
  settled(): Promise<void>;
  snapshot(): DriveState;
  subscribe(fn: (s: DriveState) => void): () => void;
  /** The shared motion evidence of the latest row (the DMS reads it). */
  motionEvidence(): MotionEvidence | null;
  signedIn(): boolean;
  /** Sign-out: an open drive is ended and finalized under the current owner. */
  suspendForSignOut(): Promise<void>;
  resumeAfterSignIn(): Promise<void>;
  signedInAgain(opts?: { initial?: boolean }): Promise<void>;
  signOutCompleted(): void;
  /** The session ended, whoever ended it: an open drive is finalized under the device's owner. */
  sessionEnded(): Promise<void>;
  reportAlertsUnavailable(): void;
  reportAlertsAvailable(): void;
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
  /** Just-in-time permissions: While-Using location (required) and motion. */
  permissions?: () => Promise<{ location: 'granted' | 'denied' }>;
  /** One speed read on the tap (m/s, or null when no fresh fix). */
  speedProbe?: () => Promise<number | null>;
  /** The cached summary context for the points estimate; null when nothing is cached. */
  context?: () => Promise<DriveContext | null>;
  /** The driver-seat presence, from the DMS controller while it runs. */
  presence?: () => DriverPresence | null;
  /** Extra detectors for each drive (the DMS's eyes-off/drowsiness detector). */
  extraDetectors?: () => Detector[];
  /** Told every 1 Hz row with its motion evidence, before the engine sees it (the DMS). */
  onRow?: (row: FeatureRow, motion: MotionEvidence | null) => void;
  voiceEnabled?: () => boolean;
  motionEvidence?: () => MotionEvidenceSource;
  appState?: AppStateLike;
  scheduler?: Scheduler;
  alertsAvailable?: boolean;
  signedOut?: boolean;
  /** `none`: a dry run (a simulation) — no checkpoint, finalize or change event. */
  persistence?: 'full' | 'none';
  onError?: (e: unknown, ctx: string) => void;
}

const noop = (): void => {};

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
  let lockSignal: 'reliable' | 'lagged' | 'unreliable' = 'unreliable';
  let callActive = false;
  let screenLocked = false;
  let lastFinalized: LastFinalized = null;
  let soundFailedThisDrive = false;
  let signedOut = deps.signedOut === true;
  let signingOut = false;
  let dmsActive = false;
  let points: DrivePoints | null = null;
  let pointsCtx: DriveContext = { streak: 0, safeMilesEarlierToday: 0 };
  let lastStopTotal = 0;
  let wasStopped = false;
  let startTripPending = false;
  let finalizedPending = false;
  let prevStatus: EngineStatus = 'idle';
  const motion = (deps.motionEvidence ?? createMotionEvidence)();
  let lastMotion: MotionEvidence | null = null;
  let motionTripId: string | null = null;
  let subscriptions: (() => void)[] = [];
  const idleWaiters = new Set<() => void>();
  const listeners = new Set<(s: DriveState) => void>();

  function faceSeen(): boolean {
    try {
      const p = deps.presence?.() ?? null;
      return p !== null && p.lastFaceT !== null && now() - p.lastFaceT <= FACE_RECENT_MS;
    } catch (e) {
      report(e, 'presence');
      return false;
    }
  }

  // --- engine wiring -------------------------------------------------------------------------------

  async function onFinalize(session: Readonly<TripSession>): Promise<void> {
    if (!persist) return;
    const id = session.clientTripId;
    try {
      const result = await finalizeTrip(session, {
        db,
        tz: tz(),
        now,
        appVersion: deps.appVersion,
        context: async () => (await deps.context?.()) ?? null,
      });
      lastFinalized = { clientTripId: id, ok: true, status: result.trip.status, pointsNet: result.trip.points_net, at: now() };
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
    createDetectors: () => createDetectors(newId, deps.extraDetectors?.() ?? []),
    ctx: () => detectorContext(lockSignal, callActive),
    faceSeen,
    onAlert(alert: AlertEvent) {
      const decision = decisionFor(alert, { voiceEnabled: deps.voiceEnabled?.() ?? false });
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
      dmsActive,
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

  /** The local estimate for the drive so far, computed once per stop. */
  function estimateNow(): number {
    const s = engine.session();
    if (s === null) return 0;
    const miles = metersToMiles(s.distanceM);
    const bd = scoreDrive(
      { miles, safeMiles: Math.min(miles, metersToMiles(s.safeDistanceM)), events: s.events.map(({ measured: _m, ...e }) => e), dmsOn: s.dmsOn },
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
    } else if (!s.stopped && s.speedKnown) {
      points = null;
    }
    wasStopped = s.stopped;
  }

  function display(s: EngineSnapshot): void {
    if (!deps.display || s.status !== 'recording') return;
    deps.display.update({
      speed: s.speedKnown ? Math.round(mpsToMph(s.speedMps)) : null,
      limit: s.limitMph,
      unit: 'mph',
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
      deps.display?.start({ speed: null, limit: null, unit: 'mph', points: null, pointsDelta: null, stopped: true });
    }
    updatePoints(s);
    display(s);
    if (closed) {
      limits.resetTrip();
      startTripPending = false;
      dmsActive = false;
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
    ticker.update(s.status === 'recording' ? s.stoppedSinceTs : null);
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

  // --- native events -------------------------------------------------------------------------------

  async function onRow(row: FeatureRow): Promise<void> {
    const before = engine.snapshot();
    if (before.clientTripId !== motionTripId) {
      motion.reset();
      motionTripId = before.clientTripId;
    }
    lastMotion = motion.onRow(row, { mounted: true });
    if (deps.onRow) {
      try {
        deps.onRow(row, lastMotion);
      } catch (e) {
        report(e, 'row hook');
      }
    }
    screenLocked = row.locked;
    if (startTripPending && row.gnssValid) {
      startTripPending = false;
      if (persist) limits.startTrip(row.lat, row.lng, row.course);
    }
    await engine.dispatch({ type: 'row', row });
  }

  function attachNative(): void {
    const remover = (sub: { remove(): void }) => () => sub.remove();
    subscriptions.push(
      remover(
        source.addListener('row', (raw) => {
          const row = parseRow(raw);
          if (row === null) return;
          void run(() => onRow(row), 'row');
        })
      ),
      remover(
        source.addListener('activity', (a) => {
          if (!walkingReported(a)) return;
          void run(() => engine.dispatch({ type: 'walking', ts: now() }), 'activity');
        })
      ),
      remover(
        source.addListener('screen', (p) => {
          screenLocked = p.locked;
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
          lockSignal = state.lockSignal;
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
          dmsActive = opts.adopt.session.dmsOn;
          await engine.dispatch({ type: 'adopt', trip: opts.adopt, ts: now() });
        }
        attachNative();
      }, 'boot');
    },

    async start({ dmsOn }) {
      if (!booted || signedOut) return { ok: false, reason: 'error' };
      if (isBusyStatus(engine.snapshot().status)) return { ok: false, reason: 'busy' };
      try {
        const perms = await deps.permissions?.();
        if (perms !== undefined && perms.location !== 'granted') return { ok: false, reason: 'permission' };
      } catch (e) {
        report(e, 'permissions');
        return { ok: false, reason: 'permission' };
      }
      let speed: number | null = null;
      try {
        speed = (await deps.speedProbe?.()) ?? null;
      } catch (e) {
        report(e, 'speedProbe');
      }
      if (isMoving(speed)) return { ok: false, reason: 'moving' };
      let result: StartResult = { ok: false, reason: 'error' };
      await run(async () => {
        if (isBusyStatus(engine.snapshot().status)) {
          result = { ok: false, reason: 'busy' };
          return;
        }
        try {
          const state = await source.getState();
          lockSignal = state.lockSignal;
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
        dmsActive = dmsOn;
        await engine.dispatch({ type: 'start', ts: now(), dmsOn });
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
      }, 'start');
      return result;
    },

    async end() {
      const id = engine.snapshot().clientTripId;
      if (id === null) return null;
      await run(() => engine.dispatch({ type: 'end', ts: now() }), 'end');
      await self.untilIdle();
      return { clientTripId: id };
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
    motionEvidence: () => lastMotion,
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
