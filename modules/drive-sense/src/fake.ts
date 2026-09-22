// In-memory drive-sense for tests and the diagnostics simulation. It follows README.md's native
// contract — including buffering events nobody is listening for (bounded, oldest row dropped
// first) and delivering them asynchronously when the first listener attaches — so host tests
// exercise the same orderings a device produces.
import { runSelfTest } from './extract/vectors';
import { parseVectors } from './selfTest';
import type {
  CaptureMode,
  CaptureRate,
  DriveSenseApi,
  DriveSenseEvent,
  DriveSenseEvents,
  DriveSenseState,
  ExitInfo,
  FakeControls,
  FeatureRow,
  MotionActivity,
  Subscription,
  ThermalLevel,
} from './types';

/** Events buffered while no listener for them is attached, across all events (README §Buffering). */
export const EVENT_BUFFER_MAX = 300;

type Listener = (payload: unknown) => void;
type Buffered = { event: DriveSenseEvent; payload: unknown };

export interface FakeOptions {
  platform?: 'ios' | 'android';
  /** clock for `captureStartedAt`; `Date.now` by default */
  now?: () => number;
}

export function createFakeDriveSense(opts: FakeOptions = {}): DriveSenseApi & FakeControls {
  const platform = opts.platform ?? 'ios';
  const now = opts.now ?? Date.now;
  let state: DriveSenseState = {
    armed: false,
    capturing: false,
    rate: null,
    mode: null,
    platform,
    location: 'none',
    motion: 'undetermined',
    lockSignal: platform === 'ios' ? 'lagged' : 'reliable',
    captureWasOpen: false,
    captureStartedAt: null,
    lastRowTs: null,
  };
  let screen = { locked: false, on: true };
  let thermal: ThermalLevel = 'nominal';
  let history: MotionActivity[] = [];
  let exitInfo: ExitInfo | null = null;
  let ignoringBatteryOptimizations = platform === 'ios';
  let notificationState: { stationary: boolean; startedAt: number | null } | null = null;
  let queue: FeatureRow[] = [];
  const listeners = new Map<DriveSenseEvent, Set<Listener>>();
  let buffer: Buffered[] = [];
  const calls: string[] = [];

  const log = (name: string, arg?: string) => calls.push(arg === undefined ? name : `${name}:${arg}`);

  function observe(event: DriveSenseEvent, payload: unknown) {
    if (event === 'screen') {
      const p = payload as DriveSenseEvents['screen'];
      screen = { locked: p.locked, on: p.on };
    } else if (event === 'thermal') {
      thermal = (payload as DriveSenseEvents['thermal']).level;
    } else if (event === 'row') {
      const ts = (payload as { ts?: unknown } | null)?.ts;
      if (typeof ts === 'number') state = { ...state, lastRowTs: ts };
    }
  }

  function deliver(event: DriveSenseEvent, payload: unknown) {
    const set = listeners.get(event);
    if (!set || set.size === 0) {
      buffer.push({ event, payload });
      if (buffer.length > EVENT_BUFFER_MAX) {
        const oldestRow = buffer.findIndex((b) => b.event === 'row');
        buffer.splice(oldestRow >= 0 ? oldestRow : 0, 1);
      }
      return;
    }
    for (const fn of [...set]) if (set.has(fn)) fn(payload);
  }

  function emitRaw(event: DriveSenseEvent, payload: unknown) {
    observe(event, payload);
    deliver(event, payload);
  }

  const resolve = <T>(v: T): Promise<T> => Promise.resolve(v);

  const api: DriveSenseApi & FakeControls = {
    // ——— DriveSenseApi ———
    arm() {
      log('arm');
      state = { ...state, armed: true };
      return resolve(undefined);
    },
    disarm() {
      log('disarm');
      state = { ...state, armed: false };
      return resolve(undefined);
    },
    startCapture(mode: CaptureMode) {
      log('startCapture', mode);
      state = state.capturing
        ? { ...state, mode }
        : { ...state, capturing: true, mode, rate: 'full', captureStartedAt: now() };
      return resolve(undefined);
    },
    stopCapture() {
      log('stopCapture');
      state = { ...state, capturing: false, mode: null, rate: null, captureStartedAt: null };
      return resolve(undefined);
    },
    setCaptureRate(rate: CaptureRate) {
      log('setCaptureRate', rate);
      if (state.capturing) state = { ...state, rate };
      return resolve(undefined);
    },
    getState() {
      log('getState');
      return resolve({ ...state });
    },
    queryMotionHistory(fromTs: number, toTs: number) {
      log('queryMotionHistory');
      return resolve(history.filter((a) => a.ts >= fromTs && a.ts <= toTs).map((a) => ({ ...a })));
    },
    getScreenState() {
      log('getScreenState');
      return resolve({ ...screen });
    },
    getThermalState() {
      log('getThermalState');
      return resolve(thermal);
    },
    requestMotionPermission() {
      log('requestMotionPermission');
      if (state.motion === 'undetermined') state = { ...state, motion: 'granted' };
      return resolve(state.motion === 'granted' ? 'granted' : state.motion === 'denied' ? 'denied' : 'unavailable');
    },
    excludeFromBackup(uri: string) {
      log('excludeFromBackup', uri);
      return resolve(undefined);
    },
    setNotificationState(s) {
      log('setNotificationState');
      notificationState = { stationary: s.stationary, startedAt: s.startedAt };
      return resolve(undefined);
    },
    getLastExitInfo() {
      log('getLastExitInfo');
      return resolve(exitInfo ? { ...exitInfo } : null);
    },
    isIgnoringBatteryOptimizations() {
      log('isIgnoringBatteryOptimizations');
      return resolve(ignoringBatteryOptimizations);
    },
    selfTest(vectorsJson: string) {
      log('selfTest');
      try {
        return resolve(JSON.stringify(runSelfTest(parseVectors(vectorsJson), 'reference')));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    addListener<E extends DriveSenseEvent>(
      event: E,
      fn: (payload: DriveSenseEvents[E]) => void
    ): Subscription {
      const listener = fn as Listener;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const first = set.size === 0;
      set.add(listener);
      if (first) {
        const pending = buffer.filter((b) => b.event === event);
        if (pending.length > 0) {
          buffer = buffer.filter((b) => b.event !== event);
          // Like the native bridge: delivered after addListener returns, not inside it.
          void Promise.resolve().then(() => {
            for (const b of pending) deliver(b.event, b.payload);
          });
        }
      }
      return {
        remove() {
          set.delete(listener);
        },
      };
    },

    // ——— FakeControls ———
    emit(event, payload) {
      emitRaw(event, payload);
    },
    loadTrace(rows) {
      queue = rows.map((r) => ({ ...r }));
    },
    step() {
      const next = queue.shift();
      if (!next) return false;
      emitRaw('row', { ...next });
      return true;
    },
    drain() {
      while (api.step()) {
        // step until the queue is empty
      }
    },
    calls,
    setMotionHistory(a) {
      history = a.map((x) => ({ ...x }));
    },
    setState(s) {
      state = { ...state, ...s };
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    setLastExitInfo(info) {
      exitInfo = info ? { ...info } : null;
    },
    setIgnoringBatteryOptimizations(value) {
      ignoringBatteryOptimizations = value;
    },
    get notificationState() {
      return notificationState ? { ...notificationState } : null;
    },
  };
  return api;
}
