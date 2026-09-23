// In-memory DmsVision for tests and the diagnostics simulation. It follows README.md's native
// contract where host tests depend on it:
// - it rejects exactly what native rejects: bad arguments (E_BAD_ARGS), a missing or mismatched gate
//   token (E_BAD_ARGS), no permission (E_PERMISSION), not in the foreground (E_NOT_FOREGROUND),
//   `setPolicy` while stopped (E_STATE);
// - frames flow only while running (`pushRecords` refuses otherwise);
// - it owns what native owns: a stop on backgrounding, the heartbeat watchdog (paused after
//   WATCHDOG_PAUSE_MS without `setPolicy`, stopped WATCHDOG_STOP_MS later), the model release after
//   MODEL_RELEASE_AFTER_PAUSE_MS paused, and the thermal floor with its entry and cooling dwells;
// - time is a fake clock moved only by `advance(ms)`;
// - with `asyncDelivery: true` events arrive on a microtask, as the native bridge always delivers.
import {
  MODEL_RELEASE_AFTER_PAUSE_MS,
  THERMAL_COOL_DWELL_MS,
  THERMAL_FLOOR,
  THERMAL_L1_ENTRY_DWELL_MS,
  WATCHDOG_PAUSE_MS,
  WATCHDOG_STOP_MS,
  FRAME_WIRE_VERSION,
  thermalLevelOf,
  type ThermalLevel,
  type ThermalName,
} from './constants';
import {
  dmsVisionError,
  type CapturePolicy,
  type DmsVisionApi,
  type DmsVisionErrorCode,
  type DmsVisionEvent,
  type DmsVisionEvents,
  type DmsVisionMethod,
  type ModelInfo,
  type NativeState,
  type NativeStatus,
  type PermissionResult,
  type StateReason,
  type Subscription,
} from './types';
import { capturePolicySchema, encodeFrameBatch, startOptionsSchema, type RawRecord } from './wire';

/** The pinned model digests (plan keep table). */
export const LANDMARKER_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
export const GAZE_DIRECT_SHA256 = '4aa9661091efbdc28b20927f905c78097b9a7b5b787401f74ce6259f8f7666c8';

export interface FakeOptions {
  permission?: PermissionResult['status'];
  /** What `requestPermission` turns an `undetermined` permission into. Default 'granted'. */
  permissionOnRequest?: 'granted' | 'denied';
  /** A build with `DMS_GAZE_NET=1`. Default false (the production variant). */
  gazeNetAvailable?: boolean;
  asyncDelivery?: boolean;
  /** Epoch ms at fake time 0, for batch anchors. */
  epochAtZero?: number;
}

export interface FakeCall {
  method: DmsVisionMethod;
  args: unknown[];
}

export interface FakeDmsVision extends DmsVisionApi {
  /** Commands in order (start, setPolicy, stop, requestPermission). */
  readonly calls: FakeCall[];
  /** Read-only calls in order (getPermission, getStatus, getModelInfo, selfTest). */
  readonly queries: DmsVisionMethod[];
  nativeState(): NativeState;
  /** The fake clock, ms. */
  now(): number;
  advance(ms: number): void;
  setForeground(active: boolean): void;
  setPermission(status: PermissionResult['status']): void;
  setThermal(name: ThermalName): void;
  setLowPower(on: boolean): void;
  /** The next call of `method` rejects with `code`. */
  failNext(method: DmsVisionMethod, code: DmsVisionErrorCode): void;
  /** Emit one `frames` batch; false (and nothing emitted) unless running. */
  pushRecords(records: readonly RawRecord[]): boolean;
  /** Emit a `status` event with the current status. */
  emitStatus(): void;
  /** Emit any payload on any event (for tests of the host's validation). */
  emitRaw(event: DmsVisionEvent, payload: unknown): void;
}

type Listener = (payload: unknown) => void;

export function createFakeDmsVision(opts: FakeOptions = {}): FakeDmsVision {
  const gazeNetAvailable = opts.gazeNetAvailable ?? false;
  const asyncDelivery = opts.asyncDelivery ?? false;
  const epochAtZero = opts.epochAtZero ?? 1_700_000_000_000;
  const listeners = new Map<DmsVisionEvent, Set<Listener>>();
  const calls: FakeCall[] = [];
  const queries: DmsVisionMethod[] = [];
  const failures = new Map<DmsVisionMethod, DmsVisionErrorCode>();

  let t = 0;
  let permission: PermissionResult['status'] = opts.permission ?? 'granted';
  let foreground = true;
  let lowPower = false;
  let state: NativeState = 'stopped';
  let token: string | null = null;
  let lastHeartbeat = 0;
  let pausedAt = 0;
  let policy: Pick<CapturePolicy, 'capture' | 'fps' | 'gazeNet' | 'gazeNetEvery'> = {
    capture: 'run',
    fps: 15,
    gazeNet: false,
    gazeNetEvery: 1,
  };
  let thermal: ThermalName = 'nominal';
  let thermalSince = 0;
  let floor: ThermalLevel = 0;

  function deliverNow(event: DmsVisionEvent, payload: unknown) {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
  }
  function emit(event: DmsVisionEvent, payload: unknown) {
    if (asyncDelivery) void Promise.resolve().then(() => deliverNow(event, payload));
    else deliverNow(event, payload);
  }
  function setState(next: NativeState, reason: StateReason) {
    if (next === state && next !== 'starting') return;
    state = next;
    if (next === 'paused') pausedAt = t;
    if (next === 'stopped') token = null;
    emit('state', { state: next, reason });
  }

  /** Apply the thermal floor for the current time: hotter at once (level 1 after its dwell), cooler after its dwell. */
  function evaluateThermal() {
    const raw = thermalLevelOf(thermal);
    if (raw > floor) {
      if (raw >= 2 || t - thermalSince >= THERMAL_L1_ENTRY_DWELL_MS) floor = raw;
    } else if (raw < floor) {
      if (t - thermalSince >= THERMAL_COOL_DWELL_MS) floor = raw;
    }
    if (floor === 3 && state === 'running') setState('paused', 'thermal');
  }

  function evaluateTimers() {
    if (state === 'running' && t - lastHeartbeat >= WATCHDOG_PAUSE_MS) {
      setState('paused', 'watchdog');
      pausedAt = lastHeartbeat + WATCHDOG_PAUSE_MS;
    }
    if (state !== 'stopped' && t - lastHeartbeat >= WATCHDOG_PAUSE_MS + WATCHDOG_STOP_MS) {
      setState('stopped', 'watchdog');
    }
    if (state === 'paused' && t - pausedAt >= MODEL_RELEASE_AFTER_PAUSE_MS) setState('stopped', 'released');
    evaluateThermal();
  }

  function takeFailure(method: DmsVisionMethod) {
    const code = failures.get(method);
    if (code === undefined) return;
    failures.delete(method);
    throw dmsVisionError(code, `injected failure of ${method}`);
  }

  function status(): NativeStatus {
    evaluateThermal();
    const step = THERMAL_FLOOR[floor]!;
    const running = state === 'running';
    const cap = lowPower ? Math.min(8, step.fpsCap) : step.fpsCap;
    return {
      state,
      fpsTarget: running ? Math.min(policy.fps, cap) : 0,
      fpsActual: 0,
      dropped: 0,
      gazeNetAvailable,
      gazeNetOn: running && gazeNetAvailable && policy.gazeNet && step.gazeNet,
      thermal,
      thermalLevel: floor,
      lowPower,
      latLandmarkP50: null,
      latLandmarkP95: null,
      latGazeP50: null,
      latGazeP95: null,
      latTotalP50: null,
      latTotalP95: null,
      procCpuMsPerS: null,
    };
  }

  function applyRunOrPause(reason: StateReason) {
    if (policy.capture === 'pause') {
      if (state === 'running') setState('paused', 'policy');
      return;
    }
    evaluateThermal();
    if (floor === 3) {
      if (state === 'running') setState('paused', 'thermal');
      return;
    }
    if (state === 'paused') setState('running', reason);
  }

  const fake: FakeDmsVision = {
    calls,
    queries,
    isAvailable: () => true,

    async getPermission() {
      queries.push('getPermission');
      takeFailure('getPermission');
      return { status: permission, canAskAgain: permission === 'undetermined' };
    },

    async requestPermission() {
      calls.push({ method: 'requestPermission', args: [] });
      takeFailure('requestPermission');
      if (permission === 'undetermined') permission = opts.permissionOnRequest ?? 'granted';
      // Answered: the OS will not show the prompt again.
      return { status: permission, canAskAgain: false };
    },

    async start(options) {
      calls.push({ method: 'start', args: [options] });
      takeFailure('start');
      if (!startOptionsSchema.safeParse(options).success) throw dmsVisionError('E_BAD_ARGS', 'invalid start options');
      if (permission !== 'granted') throw dmsVisionError('E_PERMISSION', 'camera permission has not been granted');
      if (!foreground) throw dmsVisionError('E_NOT_FOREGROUND', 'the app is not in the foreground');
      if (state !== 'stopped') {
        if (options.gateToken !== token) throw dmsVisionError('E_BAD_ARGS', 'a different gate token');
        lastHeartbeat = t;
        policy = { capture: 'run', fps: options.fps, gazeNet: options.gazeNet, gazeNetEvery: options.gazeNetEvery };
        applyRunOrPause('user');
        return;
      }
      token = options.gateToken;
      lastHeartbeat = t;
      policy = { capture: 'run', fps: options.fps, gazeNet: options.gazeNet, gazeNetEvery: options.gazeNetEvery };
      setState('starting', 'user');
      setState('running', 'user');
      evaluateThermal();
    },

    async setPolicy(p) {
      calls.push({ method: 'setPolicy', args: [p] });
      takeFailure('setPolicy');
      if (!capturePolicySchema.safeParse(p).success) throw dmsVisionError('E_BAD_ARGS', 'invalid policy');
      if (state === 'stopped') throw dmsVisionError('E_STATE', 'not started');
      if (p.gateToken !== token) throw dmsVisionError('E_BAD_ARGS', 'gate token mismatch');
      lastHeartbeat = t;
      policy = { capture: p.capture, fps: p.fps, gazeNet: p.gazeNet, gazeNetEvery: p.gazeNetEvery };
      applyRunOrPause('policy');
    },

    async stop() {
      calls.push({ method: 'stop', args: [] });
      takeFailure('stop');
      if (state !== 'stopped') setState('stopped', 'user');
    },

    async getStatus() {
      queries.push('getStatus');
      takeFailure('getStatus');
      return status();
    },

    async getModelInfo(): Promise<ModelInfo> {
      queries.push('getModelInfo');
      takeFailure('getModelInfo');
      return {
        landmarkerSha256: LANDMARKER_SHA256,
        gazeNetAvailable,
        gazeSha256: gazeNetAvailable ? GAZE_DIRECT_SHA256 : null,
        mediapipe: '0.10.35',
        onnxruntime: gazeNetAvailable ? '1.30.0' : null,
      };
    },

    async selfTest(vectorsJson) {
      queries.push('selfTest');
      takeFailure('selfTest');
      if (typeof vectorsJson !== 'string') throw dmsVisionError('E_BAD_ARGS', 'vectors must be a string');
      return JSON.stringify({ version: 1, platform: 'fake', results: [] });
    },

    addListener<E extends DmsVisionEvent>(event: E, fn: (payload: DmsVisionEvents[E]) => void): Subscription {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      const l = fn as Listener;
      set.add(l);
      return { remove: () => void set.delete(l) };
    },

    nativeState: () => state,
    now: () => t,

    advance(ms) {
      if (!(ms >= 0)) throw new RangeError('advance needs a non-negative duration');
      t += ms;
      evaluateTimers();
    },

    setForeground(active) {
      foreground = active;
      if (!active && state !== 'stopped') setState('stopped', 'background');
    },

    setPermission(s) {
      permission = s;
    },

    setThermal(name) {
      if (name !== thermal) {
        thermal = name;
        thermalSince = t;
      }
      evaluateThermal();
    },

    setLowPower(on) {
      lowPower = on;
    },

    failNext(method, code) {
      failures.set(method, code);
    },

    pushRecords(records) {
      if (state !== 'running' || records.length === 0) return false;
      emit('frames', {
        v: FRAME_WIRE_VERSION,
        anchorTMs: t,
        anchorEpochMs: epochAtZero + t,
        n: records.length,
        data: encodeFrameBatch(records),
      });
      return true;
    },

    emitStatus() {
      emit('status', status());
    },

    emitRaw(event, payload) {
      emit(event, payload);
    },
  };
  return fake;
}
