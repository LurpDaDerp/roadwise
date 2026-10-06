// Driver monitoring wired into the drive (product spec v3 DMS; plan §10 `dms.enabled` / `dms.calibratedAt`). One
// bridge per launch, built by bootstrap next to the drive host:
//
// - The controller (`createDefaultDmsController`) is built lazily — at the first drive started with DMS on, or
//   the first time the settings or setup screen needs the camera — for the signed-in uid, and rebuilt when the
//   uid changes. A driver who never turns DMS on never loads it.
// - The gate (src/core/dms/README.md "Gate inputs"): `enabled` = the recording drive's `dmsOn` (the Start tap,
//   from the `dms.enabled` setting), `driveActive` = the engine is `recording`, `appActive`. Re-evaluated on
//   every host snapshot and app-state change, so the drive ending or the app leaving the front stops the camera
//   in the same tick. The engine's own alert commands are muted (`alerts: 'shadow'`): the v3 sounds are the
//   drive's alert player playing the `eyes_off` / `drowsy` events as they close.
// - Rows: the host hands every 1 Hz row and its motion evidence to `onRow`, which feeds `pushRow`; the focus
//   samples it returns wait for the drive's focus detector (`detectors()`, through the host's `extraDetectors`),
//   which turns them into the two events on the same row.
// - Presence: `presence()` for the host's per-row face count (`dmsOn` / `dmsFaceSeen` shares, `dmsActive`).
// - The OS camera prompt: never mid-drive. The settings switch asks through `requestPermission()`, the setup
//   session at its start.
// - The setup session (`startSetup`): the parked 20-second calibration on the same controller; while it runs the
//   drive gate stays out of its way (no drive can be recording: the screens refuse while one is).
// - The end: leaving `recording` calls `endDrive()`, which stops the camera. Nothing of a drive carries over.
import type { DmsController, DmsDefaultControllerDeps, DmsFocusSample, DmsHostPower, DmsHudStatus, DmsSetupSession, DmsSetupStore, DmsSetupView } from '@/core/dms';
import { createDmsSetupSession } from '@/core/dms';
import { createFocusDetector } from '@/core/detectors/focus';
import type { MotionEvidence } from '@/core/engine/motionEvidence';
import type { Detector, FeatureRow } from '@/core/engine/types';
import type { DriverPresence, DriveState } from '@/drive/host';

export type CameraPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export interface CameraBridgeDeps {
  /** the device owner's uid (the signed-in driver), or null */
  readUid(): Promise<string | null>;
  /** builds the controller for a uid (default: createDefaultDmsController over the uid's profile and setup stores) */
  createController(deps: Pick<DmsDefaultControllerDeps, 'onAlert' | 'onStatus'>, uid: string): DmsController;
  /** the uid's setup store, for the setup session's record */
  setupStore(uid: string): Pick<DmsSetupStore, 'save'>;
  /** the app is in front (AppState active) */
  appActive(): boolean;
  subscribeAppState(fn: () => void): () => void;
  /** battery for the capture policy; null fields when unknown */
  power(): DmsHostPower;
  /** event ids for the focus detector */
  newId(): string;
  /** removes the stored face profile and setup record (after disposing, on sign-out and account deletion) */
  clearStores(): Promise<void>;
  onError?(e: unknown, ctx: string): void;
}

export interface CameraBridge {
  /** follows the host; returns the unsubscribe */
  attach(host: { snapshot(): DriveState; subscribe(fn: (s: DriveState) => void): () => void }): () => void;
  /** the host's per-row hook */
  onRow(row: FeatureRow, motion: MotionEvidence | null): void;
  /** the drive's eyes-off / drowsiness detector (the host's `extraDetectors`): one per drive */
  detectors(): Detector[];
  /** the host's presence dep */
  presence(): DriverPresence | null;
  status(): DmsHudStatus | null;
  subscribeStatus(fn: (s: DmsHudStatus | null) => void): () => void;
  /** The OS camera prompt, for the settings switch. `unavailable`: signed out, or a drive is recording. */
  requestPermission(): Promise<CameraPermission>;
  permissionStatus(): Promise<CameraPermission>;
  /** The setup session, or null when signed out or a drive is recording. The caller runs and cancels it. */
  startSetup(onChange: (v: DmsSetupView) => void): Promise<DmsSetupSession | null>;
  /** sign-out, account switch, runtime stop: stops the camera; later calls are ignored */
  dispose(): Promise<void>;
  /**
   * The session ended (sign-out, or one the driver did not start): after the drive's end, the controller is disposed
   * and the stores cleared. The bridge stays usable: the next drive of a signed-in driver builds a new one.
   */
  sessionEnded(): Promise<void>;
  /** resolves when the last drive end's bookkeeping is done (tests) */
  settled(): Promise<void>;
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
  let status: DmsHudStatus | null = null;
  const statusListeners = new Set<(s: DmsHudStatus | null) => void>();
  let last: DriveState | null = null;
  /** the trip the camera is following (the engine's clientTripId while recording) */
  let trip: string | null = null;
  /** the focus samples waiting for the drive's detector */
  let samples: DmsFocusSample[] = [];
  /** the setup session owns the gate while it runs */
  let setup: DmsSetupSession | null = null;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (f: () => Promise<void>) => {
    chain = chain.then(f).catch((e: unknown) => report(e, 'camera bridge'));
    return chain;
  };

  function publish(s: DmsHudStatus | null): void {
    status = s;
    for (const l of [...statusListeners]) {
      try {
        l(s);
      } catch {
        // a listener that throws does not stop the others
      }
    }
  }

  async function ensureController(uid: string): Promise<DmsController> {
    if (controller !== null && controllerUid === uid) return controller;
    if (controller !== null) await controller.dispose();
    controller = deps.createController({ onAlert: () => {}, onStatus: publish }, uid);
    controllerUid = uid;
    return controller;
  }

  const recording = (s: DriveState | null): boolean => s !== null && s.status === 'recording' && trip !== null && s.clientTripId === trip;

  function applyGate(): void {
    if (controller === null || disposed || setup !== null) return;
    const s = last;
    const on = recording(s);
    try {
      controller.setGate({ enabled: on && s!.dmsOn, driveActive: on, appActive: deps.appActive(), driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
    } catch (e) {
      report(e, 'camera gate');
    }
  }

  async function startTrip(id: string): Promise<void> {
    samples = [];
    const uid = await deps.readUid();
    if (disposed || uid === null || last?.clientTripId !== id || last.status !== 'recording') return;
    if (!last.dmsOn) {
      // DMS off for this drive: nothing is loaded, nothing runs (an existing controller is told, so it stays closed).
      trip = id;
      applyGate();
      return;
    }
    await ensureController(uid);
    trip = id;
    followApp(true);
    applyGate();
  }

  async function endTrip(): Promise<void> {
    trip = null;
    samples = [];
    followApp(false);
    const c = controller;
    if (c === null) return;
    await c.endDrive();
  }

  function onSnapshot(s: DriveState): void {
    const prev = last;
    last = s;
    const wasRecording = prev !== null && prev.status === 'recording' ? prev.clientTripId : null;
    const isRecording = s.status === 'recording' ? s.clientTripId : null;
    if (wasRecording !== null && wasRecording !== isRecording) {
      applyGate(); // closes at once (driveActive false), before the async end
      void enqueue(() => endTrip());
    }
    if (isRecording !== null && isRecording !== wasRecording) void enqueue(() => startTrip(isRecording));
    else applyGate();
  }

  // The app-state listener exists only while the camera follows a trip or a setup: a launch without DMS adds none.
  let offApp: (() => void) | null = null;
  const followApp = (on: boolean) => {
    if (on && offApp === null)
      offApp = deps.subscribeAppState(() => {
        if (setup !== null) setup.setAppActive(deps.appActive());
        else applyGate();
      });
    if (!on && offApp !== null && setup === null && trip === null) {
      offApp();
      offApp = null;
    }
  };

  /** A controller for the signed-in driver outside a drive (the settings switch, the setup), or null. */
  async function idleController(): Promise<DmsController | null> {
    if (disposed || recording(last) || (last !== null && last.status !== 'idle')) return null;
    const uid = await deps.readUid();
    if (uid === null) return null;
    return ensureController(uid);
  }

  /** The permission call under a parked gate (enabled, no drive): the prompt is allowed, the camera cannot start. */
  async function withParkedGate<T>(f: (c: DmsController) => Promise<T | null>): Promise<T | 'unavailable'> {
    const c = await idleController();
    if (c === null || setup !== null) return 'unavailable';
    try {
      c.setGate({ enabled: true, driveActive: false, appActive: deps.appActive(), driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
      const r = await f(c);
      return r ?? 'unavailable';
    } catch (e) {
      report(e, 'camera permission');
      return 'unavailable';
    } finally {
      applyGate();
    }
  }

  return {
    attach(host) {
      const off = host.subscribe(onSnapshot);
      onSnapshot(host.snapshot());
      return off;
    },
    onRow(row, motion) {
      if (disposed || controller === null) return;
      try {
        const first = controller.pushRow(row, deps.power(), motion ?? undefined);
        if (trip === null) return; // no drive: nothing to score
        if (first !== null) samples.push(first);
        for (let s = controller.takeFocus(); s !== null; s = controller.takeFocus()) samples.push(s);
      } catch (e) {
        report(e, 'camera row');
      }
    },
    detectors() {
      return [
        createFocusDetector(deps.newId, () => {
          const out = samples;
          samples = [];
          return out;
        }),
      ];
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
    requestPermission: () => withParkedGate((c) => c.requestPermission()),
    permissionStatus: () => withParkedGate((c) => c.permissionStatus()),
    async startSetup(onChange) {
      const c = await idleController();
      if (c === null || setup !== null || controllerUid === null) return null;
      const uid = controllerUid;
      const session = createDmsSetupSession({
        controller: c,
        store: deps.setupStore(uid),
        appActive: deps.appActive,
        power: deps.power,
        onChange: (v) => {
          onChange(v);
          if (v.state.step === 'done' || v.state.step === 'failed') release();
        },
      });
      const release = () => {
        if (setup !== session) return;
        setup = null;
        followApp(false);
        applyGate();
      };
      setup = session;
      followApp(true);
      const run = session.run.bind(session);
      const cancel = session.cancel.bind(session);
      return {
        ...session,
        run: async () => {
          const r = await run();
          release();
          return r;
        },
        cancel: () => {
          cancel();
          // a cancel before the first tick still ends on the session's own path; the gate is released with it
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      setup?.cancel();
      setup = null;
      trip = null;
      samples = [];
      followApp(false);
      const c = controller;
      controller = null;
      try {
        await c?.dispose();
      } catch (e) {
        report(e, 'camera dispose');
      }
      publish(null);
    },
    sessionEnded() {
      return enqueue(async () => {
        setup?.cancel();
        setup = null;
        trip = null;
        samples = [];
        followApp(false);
        const c = controller;
        controller = null;
        controllerUid = null;
        if (c !== null) await c.dispose();
        await deps.clearStores();
        publish(null);
      });
    },
    settled: () => chain,
  };
}
