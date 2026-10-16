// In-memory drive-sense for tests and the diagnostics simulation. It follows README.md's native
// contract so host tests exercise what a device does:
// - rows flow only while capturing (`step` refuses otherwise — review I5);
// - `startCapture` rejects with the README's `CodedError` code (review I4);
// - events nobody listens for are buffered (bounded, oldest row dropped first) and delivered
//   asynchronously when the first listener attaches;
// - with `asyncDelivery: true` every event is delivered on a microtask, as the native bridge
//   always does; the default is synchronous delivery, for step-by-step tests (review M4).
import { runSelfTest } from './extract/vectors';
import { claim, INITIAL, newSession, posted, setEnabled, settle, statusOf, tapDelivered, type ReminderState } from './reminder/policy';
import { isReminderWireVector, referenceReminderOutput } from './reminder/selfTest';
import { parseVectors } from './selfTest';
import type {
  CaptureMode,
  CaptureRate,
  DriveDisplayState,
  DriveSenseApi,
  DriveSenseErrorCode,
  DriveSenseEvent,
  DriveSenseEvents,
  DriveSenseRow,
  DriveSenseState,
  ExitInfo,
  FakeControls,
  InstalledApp,
  ReminderLocationAnswer,
  ReminderTap,
  Subscription,
  ThermalLevel,
  TripReminderMissing,
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
  /** `getState().lockProof` at start; default true on iOS (a proven phone), false on Android. */
  lockProof?: boolean;
  /** `getState().lockDelayMs` at start; default 10 000 on iOS, null on Android. */
  lockDelayMs?: number | null;
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
    capturing: false,
    rate: null,
    mode: null,
    platform,
    location: 'none',
    motion: 'undetermined',
    lockSignal: platform === 'ios' ? 'lagged' : 'reliable',
    lockProof: opts.lockProof ?? platform === 'ios',
    lockDelayMs: opts.lockDelayMs !== undefined ? opts.lockDelayMs : platform === 'ios' ? 10_000 : null,
    captureWasOpen: false,
    captureStartedAt: null,
    lastRowTs: null,
  };
  let screen = { locked: false, on: true };
  let thermal: ThermalLevel = 'nominal';
  let exitInfo: ExitInfo | null = null;
  let ignoringBatteryOptimizations = platform === 'ios';
  let driveDisplay: DriveDisplayState | null = null;
  /** The capture's own activity subscription (best effort), and a forced failure of it. */
  let captureFeed = false;
  let captureSubscribeFails = false;
  /** The forgot-to-start reminder: its state (the policy's own), and the phone as it sees it. */
  let reminder: ReminderState = INITIAL;
  let reminderAvailable = true;
  let reminderMissing: TripReminderMissing[] = [];
  let reminderLocation: ReminderLocationAnswer = platform === 'ios' ? 'always' : 'notNeeded';
  /** Android: the apps installed on the phone, and what a launch of one answers. */
  let installedApps: InstalledApp[] = [];
  let launchOk = true;
  /** Android: the tap handed over and not yet taken (the module's hold). */
  let heldTap: ReminderTap | null = null;
  let queue: DriveSenseRow[] = [];
  const listeners = new Map<DriveSenseEvent, Set<Listener>>();
  let buffer: Buffered[] = [];
  const calls: string[] = [];
  const queries: string[] = [];

  const command = (name: string, arg?: string) =>
    calls.push(arg === undefined ? name : `${name}:${arg}`);
  const query = (name: string) => queries.push(name);

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
    startCapture(mode: CaptureMode) {
      command('startCapture', mode);
      if (state.location === 'none') {
        return Promise.reject(driveSenseError('E_PERMISSION', 'startCapture needs location permission'));
      }
      if (!state.capturing) {
        // WK-m1: a new capture subscribes to the activity feed when motion is granted,
        // best effort: a failed subscription never rejects the start nor stops the capture.
        captureFeed = state.motion === 'granted' && !captureSubscribeFails;
      }
      state = state.capturing
        ? { ...state, mode }
        : { ...state, capturing: true, mode, rate: 'full', captureStartedAt: now() };
      return resolve(undefined);
    },
    stopCapture() {
      command('stopCapture');
      // The capture's feed ends with it; the notification goes with the service.
      captureFeed = false;
      driveDisplay = null;
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
      return resolve({ ...state });
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
    setDriveDisplay(s) {
      command('setDriveDisplay');
      // Android: the notification exists only while the capture does; iOS: only a running Live
      // Activity (which a drive start opens) can show it. Ignored otherwise, like native.
      if (state.capturing) driveDisplay = { ...s };
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
        // The forgot-to-start reminder's rows run through the TS reference, as a native mirror would.
        const all: unknown = JSON.parse(vectorsJson);
        if (Array.isArray(all) && all.length > 0 && all.every(isReminderWireVector)) {
          return resolve(JSON.stringify(referenceReminderOutput(all)));
        }
        return resolve(JSON.stringify(runSelfTest(parseVectors(vectorsJson), 'reference')));
      } catch (e) {
        return Promise.reject(driveSenseError('E_INVALID_INPUT', e instanceof Error ? e.message : String(e)));
      }
    },
    setTripReminder(enabled: boolean) {
      command('setTripReminder', String(enabled));
      reminder = setEnabled(reminder, enabled);
      return resolve(statusOf(reminder, reminderAvailable, reminderMissing));
    },
    getTripReminderStatus() {
      query('getTripReminderStatus');
      reminder = settle(reminder, now(), state.capturing);
      return resolve(statusOf(reminder, reminderAvailable, reminderMissing));
    },
    requestReminderLocation() {
      command('requestReminderLocation');
      return resolve(reminderLocation);
    },
    claimReminderTap(token: string) {
      command('claimReminderTap');
      const r = claim(reminder, token, now(), state.capturing, platform === 'android');
      reminder = r.state;
      return resolve(r.ok);
    },
    takeReminderTap() {
      query('takeReminderTap');
      const tap = heldTap;
      heldTap = null;
      return resolve(tap);
    },
    listInstalledApps(packages: readonly string[]) {
      query('listInstalledApps');
      // iOS finds navigation apps by URL scheme in JS: native answers none.
      if (platform !== 'android') return resolve([]);
      const found = packages.flatMap((p) => installedApps.filter((a) => a.package === p).slice(0, 1));
      return resolve(found.map((a) => ({ ...a })));
    },
    launchApp(packageName: string) {
      command('launchApp', packageName);
      return resolve(platform === 'android' && launchOk && installedApps.some((a) => a.package === packageName));
    },
    markLockProof(delayMs: number) {
      command('markLockProof', String(delayMs));
      // iOS keeps a proof of 15 s or less (LockProbe.record); Android has nothing to prove.
      if (platform === 'ios' && delayMs >= 0 && delayMs <= 15_000) state = { ...state, lockProof: true, lockDelayMs: Math.round(delayMs) };
      return resolve(undefined);
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
    get driveDisplay() {
      return driveDisplay ? { ...driveDisplay } : null;
    },
    transition(a) {
      if (!captureFeed) return false;
      // C12 round 1 (review-C12 m1): not capturing, a stale registration heals itself.
      if (!state.capturing) {
        captureFeed = false;
        return false;
      }
      emitRaw('activity', { ...a });
      return true;
    },
    strandSubscription() {
      captureFeed = true;
    },
    failCaptureSubscribe(fail) {
      captureSubscribeFails = fail;
    },
    get activitySubscribed() {
      return captureFeed;
    },
    setTripReminderEnv(env) {
      if (env.available !== undefined) reminderAvailable = env.available;
      if (env.missing !== undefined) reminderMissing = [...env.missing];
      if (env.location !== undefined) reminderLocation = env.location;
    },
    setInstalledApps(apps) {
      installedApps = apps.map((a) => ({ ...a }));
    },
    setLaunchResult(ok) {
      launchOk = ok;
    },
    get tripReminderOn() {
      return reminder.enabled;
    },
    postReminderForTest(token, at = now()) {
      const session = { ...newSession(at - 10 * 60_000, at, false), drove: true };
      reminder = posted({ ...reminder, session }, at, token);
    },
    tapReminderForTest(token) {
      if (platform !== 'android') return false;
      const r = tapDelivered(reminder, token, now());
      if (!r.delivered) return false;
      reminder = r.state;
      heldTap = { token, at: r.state.token === token && r.state.tapAt > 0 ? r.state.tapAt : now() };
      emitRaw('reminderTap', {});
      return true;
    },
  };
  return api;
}
