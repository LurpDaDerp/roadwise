// In-memory drive-sense for tests and the diagnostics simulation. It follows README.md's native
// contract so host tests exercise what a device does:
// - rows flow only while capturing (`step` refuses otherwise — review I5);
// - `arm`/`startCapture` reject with the README's `CodedError` codes (review I4), and `armed` in
//   `getState` is the effective arming;
// - events nobody listens for are buffered (bounded, oldest row dropped first) and delivered
//   asynchronously when the first listener attaches;
// - with `asyncDelivery: true` every event is delivered on a microtask, as the native bridge
//   always does; the default is synchronous delivery, for step-by-step tests (review M4).
import { runSelfTest } from './extract/vectors';
import { parseVectors } from './selfTest';
import type {
  CaptureMode,
  CaptureRate,
  DriveSenseApi,
  DriveSenseErrorCode,
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
  /**
   * Deliver every event on a microtask, as native does (the bridge is always asynchronous). Use it
   * in integration tests, so a host that depends on synchronous delivery fails here and not on a
   * device. Default false: `emit`/`step` call listeners before returning.
   */
  asyncDelivery?: boolean;
}

/** An Error carrying a drive-sense `code`, as an Expo `CodedError` does. */
export function driveSenseError(code: DriveSenseErrorCode, message: string): Error & { code: DriveSenseErrorCode } {
  return Object.assign(new Error(message), { code });
}

export function createFakeDriveSense(opts: FakeOptions = {}): DriveSenseApi & FakeControls {
  const platform = opts.platform ?? 'ios';
  const now = opts.now ?? Date.now;
  const asyncDelivery = opts.asyncDelivery ?? false;
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
  const queries: string[] = [];

  const command = (name: string, arg?: string) =>
    calls.push(arg === undefined ? name : `${name}:${arg}`);
  const query = (name: string) => queries.push(name);

  /** The README's arming requirement: effective only with Always location and granted motion. */
  const armPermitted = () => state.location === 'always' && state.motion === 'granted';

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

  function deliverNow(event: DriveSenseEvent, payload: unknown) {
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
    if (asyncDelivery) void Promise.resolve().then(() => deliverNow(event, payload));
    else deliverNow(event, payload);
  }

  const resolve = <T>(v: T): Promise<T> => Promise.resolve(v);

  const api: DriveSenseApi & FakeControls = {
    // ——— DriveSenseApi ———
    arm() {
      command('arm');
      if (state.motion === 'unavailable') {
        return Promise.reject(driveSenseError('E_UNAVAILABLE', 'motion activity is unavailable'));
      }
      if (!armPermitted()) {
        state = { ...state, armed: false };
        return Promise.reject(
          driveSenseError('E_PERMISSION', `arm needs location 'always' and motion 'granted' (have ${state.location}, ${state.motion})`)
        );
      }
      state = { ...state, armed: true };
      return resolve(undefined);
    },
    disarm() {
      command('disarm');
      state = { ...state, armed: false };
      return resolve(undefined);
    },
    startCapture(mode: CaptureMode) {
      command('startCapture', mode);
      if (state.location === 'none') {
        return Promise.reject(driveSenseError('E_PERMISSION', 'startCapture needs location permission'));
      }
      state = state.capturing
        ? { ...state, mode }
        : { ...state, capturing: true, mode, rate: 'full', captureStartedAt: now() };
      return resolve(undefined);
    },
    stopCapture() {
      command('stopCapture');
      state = { ...state, capturing: false, mode: null, rate: null, captureStartedAt: null };
      return resolve(undefined);
    },
    setCaptureRate(rate: CaptureRate) {
      command('setCaptureRate', rate);
      if (state.capturing) state = { ...state, rate };
      return resolve(undefined);
    },
    getState() {
      query('getState');
      // `armed` is the effective arming: a revoked permission disarms (README §2 "Errors").
      if (state.armed && !armPermitted()) state = { ...state, armed: false };
      return resolve({ ...state });
    },
    queryMotionHistory(fromTs: number, toTs: number) {
      query('queryMotionHistory');
      if (state.motion !== 'granted') return resolve([]);
      return resolve(history.filter((a) => a.ts >= fromTs && a.ts <= toTs).map((a) => ({ ...a })));
    },
    getScreenState() {
      query('getScreenState');
      return resolve({ ...screen });
    },
    getThermalState() {
      query('getThermalState');
      return resolve(thermal);
    },
    requestMotionPermission() {
      command('requestMotionPermission');
      // 'undetermined' → the user accepts the prompt; 'denied' → no prompt, stays denied.
      if (state.motion === 'undetermined') state = { ...state, motion: 'granted' };
      return resolve(state.motion === 'granted' ? 'granted' : state.motion === 'denied' ? 'denied' : 'unavailable');
    },
    excludeFromBackup(uri: string) {
      command('excludeFromBackup', uri);
      return resolve(undefined);
    },
    setNotificationState(s) {
      command('setNotificationState');
      notificationState = { stationary: s.stationary, startedAt: s.startedAt };
      return resolve(undefined);
    },
    getLastExitInfo() {
      query('getLastExitInfo');
      return resolve(exitInfo ? { ...exitInfo } : null);
    },
    isIgnoringBatteryOptimizations() {
      query('isIgnoringBatteryOptimizations');
      return resolve(ignoringBatteryOptimizations);
    },
    selfTest(vectorsJson: string) {
      command('selfTest');
      try {
        return resolve(JSON.stringify(runSelfTest(parseVectors(vectorsJson), 'reference')));
      } catch (e) {
        return Promise.reject(driveSenseError('E_INVALID_INPUT', e instanceof Error ? e.message : String(e)));
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
            for (const b of pending) deliverNow(b.event, b.payload);
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
    step(o) {
      // Native emits rows only while capturing (README §3); a host that never started capture
      // must not see its engine fed. `force` is for tests of that edge itself.
      if (!state.capturing && !o?.force) return false;
      const next = queue.shift();
      if (!next) return false;
      emitRaw('row', { ...next });
      return true;
    },
    drain(o) {
      while (api.step(o)) {
        // step until the queue is empty (or capture is not running)
      }
    },
    pendingRows() {
      return queue.length;
    },
    calls,
    queries,
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
