// The camera beta wired into the drive (lean M7, lane B; the calibration project's T15 folded in). One bridge per
// launch, built by bootstrap next to the drive host:
//
// - The controller (`createDefaultDmsController`) is built lazily, at the first drive start of a driver who opted in,
//   for that driver's uid, and rebuilt when the uid changes (a sign-in without a relaunch). A driver who never opts in
//   never loads it.
// - The gate (src/core/dms/README.md "Gate inputs"): `optedIn` (this uid's local choice of the current consent
//   version), `ageBand` (the cached profile's), `cameraBeta` (the stored remote flag, read at each drive start),
//   `driveActive` = the engine is `recording` (T15: never during `ending`, so never during the same-car hold either:
//   the hold keeps the trip `ending` and the camera off; README known limit), `mode`, `role` and `appActive`.
//   Re-evaluated on every host snapshot, app-state change and opt-in change, so opting out or backgrounding the app
//   stops the camera in the same tick.
// - Rows: the host hands every 1 Hz row and its motion evidence to `onRow`, which feeds `pushRow`. The focus sample
//   it returns is dropped: the beta uploads nothing camera-derived (its consent says so), so the trip's
//   `cameraFocus` stays null and `camera_session` false.
// - The OS camera prompt: once per trip, at the drive's start (not while locked out), when the permission is the one
//   thing keeping the camera off.
// - Presence: `presence()` for the host's auto-end (driverPresent, the same-car evidence), while a drive is open.
// - The end: leaving `recording` (T15 "endDrive at ending") calls `endDrive()`, stops every camera sound, and keeps the
//   trip's "Camera coaching" numbers on the phone (a resumed trip adds its second leg to the same card).
// - Alerts: through the app's alert ports (alertSink.ts). Status: a tiny store the HUD chip reads.
import type { AudioPort, HapticsPort, VoicePort } from '@/core/alerts/player';
import type { DmsAlertCommand, DmsController, DmsDefaultControllerDeps, DmsHostPower, DmsHudStatus } from '@/core/dms';
import type { MotionEvidence } from '@/core/engine/motionEvidence';
import type { FeatureRow } from '@/core/engine/types';
import type { SettingsRepo } from '@/data/db/settings';
import type { DriverPresence, DriveState } from '@/drive/host';

import { createDmsAlertSink, type DmsAlertSink } from './alertSink';
import { coachingFrom, readCoaching, saveCoaching, type CameraCoaching } from './coaching';
import { readCameraOptIn, subscribeCameraOptIn } from './optIn';

export const DRIVER_SIDE_KEY = 'camera.driverSide';

export interface CameraBridgeDeps {
  settings: Pick<SettingsRepo, 'get' | 'set' | 'remove'>;
  /** the device owner's uid (the signed-in driver), or null */
  readUid(): Promise<string | null>;
  readAgeBand(): Promise<string | null>;
  readCameraBeta(): Promise<boolean>;
  /** builds the controller for a uid (default: createDefaultDmsController over the settings profile store) */
  createController(deps: Pick<DmsDefaultControllerDeps, 'onAlert' | 'onStatus'>, uid: string): DmsController;
  /** the alert ports (default: createExpoAlertPorts), made once, at the first controller */
  createPorts(): Promise<{ audio: AudioPort; voice: VoicePort; haptics: HapticsPort }>;
  voiceEnabled(): boolean;
  /** the app is in front (AppState active) */
  appActive(): boolean;
  subscribeAppState(fn: () => void): () => void;
  /** battery for the capture policy; null fields when unknown */
  power(): DmsHostPower;
  /** removes the stored face profile (the README: after disposing, on sign-out and account deletion) */
  clearProfile(): Promise<void>;
  onError?(e: unknown, ctx: string): void;
}

export interface CameraBridge {
  /** follows the host; returns the unsubscribe */
  attach(host: { snapshot(): DriveState; subscribe(fn: (s: DriveState) => void): () => void }): () => void;
  /** the host's per-row hook */
  onRow(row: FeatureRow, motion: MotionEvidence | null): void;
  /** the host's presence dep */
  presence(): DriverPresence | null;
  status(): DmsHudStatus | null;
  subscribeStatus(fn: (s: DmsHudStatus | null) => void): () => void;
  /** sign-out, account switch, runtime stop: stops the camera and its sounds; later calls are ignored */
  dispose(): Promise<void>;
  /**
   * The session ended (sign-out, or one the driver did not start): after the drive's end, the controller is disposed
   * and the face profile removed. The bridge stays usable: the next drive of a signed-in driver builds a new one.
   */
  sessionEnded(): Promise<void>;
  /** resolves when the last drive end's bookkeeping is done (tests) */
  settled(): Promise<void>;
}

export function mergeCoaching(a: CameraCoaching, b: CameraCoaching): CameraCoaching {
  return {
    v: 1,
    seenPct: a.seenPct === null ? b.seenPct : b.seenPct === null ? a.seenPct : Math.min(a.seenPct, b.seenPct),
    cameraSession: a.cameraSession === 'good' && b.cameraSession === 'good' ? 'good' : 'limited',
    glancesOver2s: a.glancesOver2s + b.glancesOver2s,
    longestGlanceS: a.longestGlanceS === null ? b.longestGlanceS : b.longestGlanceS === null ? a.longestGlanceS : Math.max(a.longestGlanceS, b.longestGlanceS),
    distractionAlerts: a.distractionAlerts + b.distractionAlerts,
    sleepAlerts: a.sleepAlerts + b.sleepAlerts,
  };
}

export function createCameraBridge(deps: CameraBridgeDeps): CameraBridge {
  const report = (e: unknown, ctx: string) => {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  };
  let disposed = false;
  let controller: DmsController | null = null;
  let controllerUid: string | null = null;
  let sink: DmsAlertSink | null = null;
  let status: DmsHudStatus | null = null;
  const statusListeners = new Set<(s: DmsHudStatus | null) => void>();
  let last: DriveState | null = null;
  /** the trip the camera is following (the engine's clientTripId while recording), and its cached gate inputs */
  let trip: { id: string; optedIn: boolean; ageBand: string | null; cameraBeta: boolean; driverSide: 'left' | 'right'; asked: boolean } | null = null;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (f: () => Promise<void>) => {
    chain = chain.then(f).catch((e: unknown) => report(e, 'camera bridge'));
    return chain;
  };

  function publish(s: DmsHudStatus | null): void {
    status = s;
    // The OS camera prompt, in context (README "Gate inputs"): once per trip, when the permission is the one input
    // keeping the camera off, and only while the car is not moving fast enough to lock the screen.
    if (s !== null && s.camera === 'off' && s.reason === 'permission' && trip !== null && !trip.asked && last !== null && !last.lockedOut) {
      trip.asked = true;
      const c = controller;
      void c?.requestPermission().catch((e: unknown) => report(e, 'camera permission'));
    }
    for (const l of [...statusListeners]) {
      try {
        l(s);
      } catch {
        // a listener that throws does not stop the others
      }
    }
  }

  function onAlert(cmd: DmsAlertCommand): void {
    sink?.handle(cmd);
  }

  async function ensureController(uid: string): Promise<DmsController> {
    if (controller !== null && controllerUid === uid) return controller;
    if (controller !== null) await controller.dispose();
    if (sink === null) {
      const ports = await deps.createPorts();
      sink = createDmsAlertSink({
        ...ports,
        voiceEnabled: deps.voiceEnabled,
        callActive: () => last?.callActive ?? false,
        onError: (e) => report(e, 'camera alert'),
      });
    }
    controller = deps.createController({ onAlert, onStatus: publish }, uid);
    controllerUid = uid;
    return controller;
  }

  function applyGate(): void {
    if (controller === null || disposed) return;
    const s = last;
    const recording = s !== null && s.status === 'recording' && trip !== null && s.clientTripId === trip.id;
    try {
      controller.setGate({
        optedIn: recording && trip!.optedIn,
        cameraBeta: trip?.cameraBeta ?? false,
        ageBand: trip?.ageBand === '18_plus' ? '18_plus' : 'unknown',
        driveActive: recording,
        mode: s?.mode ?? 'pocket',
        role: s?.role ?? 'passenger',
        appActive: deps.appActive(),
        driverSide: trip?.driverSide ?? 'left',
        sensitivity: 'normal',
        alerts: 'live',
      });
    } catch (e) {
      report(e, 'camera gate');
    }
  }

  async function startTrip(id: string): Promise<void> {
    const uid = await deps.readUid();
    const optedIn = await readCameraOptIn(deps.settings, uid);
    if (disposed || uid === null || !optedIn) {
      trip = null;
      applyGate();
      return;
    }
    const [ageBand, cameraBeta, side] = await Promise.all([
      deps.readAgeBand().catch(() => null),
      deps.readCameraBeta().catch(() => false),
      deps.settings.get<unknown>(DRIVER_SIDE_KEY).catch(() => null),
    ]);
    if (disposed || last?.clientTripId !== id || last.status !== 'recording') return;
    await ensureController(uid);
    trip = { id, optedIn, ageBand, cameraBeta, driverSide: side === 'right' ? 'right' : 'left', asked: false };
    followApp(true);
    applyGate();
  }

  async function endTrip(id: string): Promise<void> {
    trip = null;
    followApp(false);
    const c = controller;
    if (c === null) return;
    const summary = await c.endDrive();
    await sink?.stopAll();
    const card = coachingFrom(summary);
    if (card === null) return;
    const before = await readCoaching(deps.settings, id);
    await saveCoaching(deps.settings, id, before === null ? card : mergeCoaching(before, card));
  }

  function onSnapshot(s: DriveState): void {
    const prev = last;
    last = s;
    const wasRecording = prev !== null && prev.status === 'recording' ? prev.clientTripId : null;
    const isRecording = s.status === 'recording' ? s.clientTripId : null;
    if (wasRecording !== null && wasRecording !== isRecording) {
      applyGate(); // closes at once (driveActive false), before the async end
      void enqueue(() => endTrip(wasRecording));
    }
    if (isRecording !== null && isRecording !== wasRecording) void enqueue(() => startTrip(isRecording));
    else applyGate();
  }

  const offOptIn = subscribeCameraOptIn(() => {
    const id = last?.status === 'recording' ? last.clientTripId : null;
    if (id === null) return;
    void enqueue(async () => {
      const uid = await deps.readUid();
      const on = await readCameraOptIn(deps.settings, uid);
      if (trip !== null && trip.id === id) {
        trip = { ...trip, optedIn: on };
        applyGate();
      } else if (on) await startTrip(id);
    });
  });
  // The app-state listener exists only while the camera follows a trip: a launch without the beta adds none.
  let offApp: (() => void) | null = null;
  const followApp = (on: boolean) => {
    if (on && offApp === null) offApp = deps.subscribeAppState(() => applyGate());
    if (!on && offApp !== null) {
      offApp();
      offApp = null;
    }
  };

  return {
    attach(host) {
      const off = host.subscribe(onSnapshot);
      onSnapshot(host.snapshot());
      return off;
    },
    onRow(row, motion) {
      if (disposed || controller === null) return;
      try {
        // The focus sample is dropped on purpose: nothing camera-derived is uploaded in the beta.
        controller.pushRow(row, deps.power(), motion ?? undefined);
      } catch (e) {
        report(e, 'camera row');
      }
    },
    presence() {
      if (disposed || controller === null || trip === null) return null;
      try {
        return controller.presence();
      } catch (e) {
        report(e, 'camera presence');
        return null;
      }
    },
    status: () => status,
    subscribeStatus(fn) {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      offOptIn();
      followApp(false);
      trip = null;
      const c = controller;
      controller = null;
      try {
        await c?.dispose();
      } catch (e) {
        report(e, 'camera dispose');
      }
      await sink?.stopAll();
      publish(null);
    },
    sessionEnded() {
      return enqueue(async () => {
        trip = null;
        followApp(false);
        const c = controller;
        controller = null;
        controllerUid = null;
        if (c !== null) await c.dispose();
        await sink?.stopAll();
        await deps.clearProfile();
        publish(null);
      });
    },
    settled: () => chain,
  };
}
