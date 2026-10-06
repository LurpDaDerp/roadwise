// The setup session (product spec v3: the camera permission "also runs a 20-second mount and gaze calibration"):
// runs the controller as a parked pseudo-drive in SETUP (15 fps, the preview allowed while stationary), feeds
// its live checks and gaze into the step machine (setupMachine.ts), takes the engine's C2 seed at the end of
// the road step, measures the mirror zones during the mirror prompts, and stores the result as the uid's setup
// record. Every later drive starts seeded, with the mirrors promoted (controller → engine init).
//
// - No drive-sense capture runs here (nothing records): the 1 Hz rows the policy needs are synthesized as a
//   stationary car, so the framing check comes from the frames (the face box), not the IMU.
// - The OS camera prompt is asked at the start if the permission is what keeps the camera off: in context,
//   once. A refusal ends the setup (`permission`).
// - `cancel()` and the app leaving the front end it too; nothing of a cancelled setup is stored.
// - The engine's own alert commands are muted (`alerts: 'shadow'`): nothing sounds while parked in setup.
import type { FeatureRow } from '@/core/engine/types';
import { mirrorZoneFromSamples, SETUP_MIRRORS, type DmsSetupRecord } from '../engine/setupRecord';
import type { LearnedZone } from '../engine/profile';
import type { DmsController, DmsHostPower } from './controller';
import type { DmsSetupStore } from './profileStore';
import { initialSetup, setupProgress, stepSetup, type SetupFailure, type SetupState } from './setupMachine';

export type SetupResult = { ok: true; mirrors: number; savedAtMs: number } | { ok: false; reason: SetupFailure | 'permission' | 'cancelled' };

export interface DmsSetupView {
  state: SetupState;
  /** 0..1 */
  progress: number;
  /** the controller's camera status word, for the screen's hint */
  camera: 'off' | 'starting' | 'active' | 'limited' | 'paused';
}

export interface DmsSetupSessionDeps {
  controller: Pick<DmsController, 'setGate' | 'pushRow' | 'beginSetup' | 'endSetup' | 'setupCheck' | 'setupGaze' | 'seedFromSetup' | 'status' | 'endDrive' | 'requestPermission' | 'idle'>;
  store: Pick<DmsSetupStore, 'save'>;
  appActive(): boolean;
  power(): DmsHostPower;
  onChange?(view: DmsSetupView): void;
  now?: () => number;
  /** the tick scheduler (tests inject a manual one) */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface DmsSetupSession {
  /** Runs the whole setup; resolves with its result. Call once. */
  run(): Promise<SetupResult>;
  cancel(): void;
  /** The app state changed: inactive ends the setup (the gate closes). */
  setAppActive(active: boolean): void;
  view(): DmsSetupView;
}

export const SETUP_TICK_MS = 200;
const ROW_EVERY_MS = 1_000;

/** A parked car's 1 Hz row: the capture policy's heartbeat during setup (no capture runs). */
export function setupRow(ts: number): FeatureRow {
  return {
    ts,
    lat: 0,
    lng: 0,
    hAcc: 5,
    speed: 0,
    speedAcc: 0.5,
    course: 0,
    alt: 0,
    gnssValid: true,
    aLonMax: 0,
    aLonMin: 0,
    aLatMax: 0,
    aLatMin: 0,
    yawRateMax: 0,
    jerkMax: 0,
    gravityStability: 1,
    orientationDelta: 0,
    handlingScore: 0,
    locked: false,
    screenOn: true,
    appForeground: true,
  };
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createDmsSetupSession(deps: DmsSetupSessionDeps): DmsSetupSession {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const c = deps.controller;
  let state = initialSetup(now());
  let appActive = deps.appActive();
  let cancelled = false;
  let finished = false;
  let unschedule: (() => void) | null = null;
  let lastRowAt = Number.NEGATIVE_INFINITY;
  let seedResult: ReturnType<DmsController['seedFromSetup']> | undefined;
  let resolveRun: ((r: SetupResult) => void) | null = null;

  const view = (): DmsSetupView => ({ state, progress: setupProgress(state, now()), camera: c.status().camera });
  const publish = () => {
    try {
      deps.onChange?.(view());
    } catch {
      // the screen's bug is never the setup's
    }
  };

  function gate(active: boolean): void {
    c.setGate({ enabled: true, driveActive: active, appActive, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  }

  async function finish(result: SetupResult): Promise<void> {
    if (finished) return;
    finished = true;
    unschedule?.();
    unschedule = null;
    try {
      c.endSetup();
      await c.endDrive(); // closes the gate first and stops the camera
    } catch {
      // the camera is stopped on the next evaluation regardless
    }
    publish();
    resolveRun?.(result);
  }

  async function complete(s: SetupState): Promise<void> {
    if (s.seed === null) {
      await finish({ ok: false, reason: 'unsteady' });
      return;
    }
    const mirrors: LearnedZone[] = [];
    for (const m of SETUP_MIRRORS) {
      const z = mirrorZoneFromSamples(m.id, s.mirrors[m.prompt] ?? []);
      if (z !== null) mirrors.push(z);
    }
    const savedAtMs = now();
    const record: DmsSetupRecord = { v: 1, seed: s.seed, mirrors, savedAtMs };
    try {
      await deps.store.save(record);
    } catch {
      await finish({ ok: false, reason: 'timeout' });
      return;
    }
    await finish({ ok: true, mirrors: mirrors.length, savedAtMs });
  }

  function tick(): void {
    if (finished) return;
    const t = now();
    if (cancelled) {
      void finish({ ok: false, reason: 'cancelled' });
      return;
    }
    if (!appActive) {
      void finish({ ok: false, reason: 'cancelled' });
      return;
    }
    if (t - lastRowAt >= ROW_EVERY_MS) {
      lastRowAt = t;
      c.pushRow(setupRow(t), deps.power());
    }
    const r = stepSetup(state, { tMs: t, check: c.setupCheck(), gaze: c.setupGaze(), ...(seedResult !== undefined ? { seedResult } : {}) });
    seedResult = undefined;
    state = r.state;
    for (const e of r.effects) if (e === 'seed') seedResult = c.seedFromSetup();
    publish();
    if (state.step === 'done') {
      void complete(state);
      return;
    }
    if (state.step === 'failed') {
      void finish({ ok: false, reason: state.failure ?? 'timeout' });
      return;
    }
    unschedule = schedule(tick, SETUP_TICK_MS);
  }

  return {
    async run() {
      const done = new Promise<SetupResult>((resolve) => {
        resolveRun = resolve;
      });
      if (cancelled || !appActive) {
        void finish({ ok: false, reason: 'cancelled' });
        return done;
      }
      state = initialSetup(now());
      gate(true); // the drive-start edge clears any setup flag, so setup begins after it
      c.beginSetup();
      lastRowAt = now();
      c.pushRow(setupRow(lastRowAt), deps.power());
      await c.idle();
      // The permission, in context: once, only if it is what keeps the camera off.
      const st = c.status();
      if (st.camera === 'off' && st.reason === 'permission') {
        const answer = await c.requestPermission();
        if (answer !== 'granted') {
          void finish({ ok: false, reason: 'permission' });
          return done;
        }
        await c.idle();
      }
      publish();
      unschedule = schedule(tick, SETUP_TICK_MS);
      return done;
    },
    cancel() {
      // The next tick (or the first one after the permission answer) ends the session without storing anything.
      cancelled = true;
    },
    setAppActive(active) {
      appActive = active;
      if (!finished && resolveRun !== null) gate(true); // re-evaluates the gate with the new app state (closes it when inactive)
    },
    view,
  };
}
