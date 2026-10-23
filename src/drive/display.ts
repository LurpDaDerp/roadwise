// The background driving display (modes plan §3.10): `DriveSense.setDriveDisplay` reaches the
// Android foreground notification and, on iOS, a running Live Activity; `LiveDrive.start`/`end`
// bound the activity's life to the drive. This adapter sends only changes (and an unchanged state
// again every 60 s, so a long stop never leaves the Live Activity stale: its stale date is 2 min
// on), at most one per 3 s on Android and one per 200 ms on iOS (the drive's first known speed and
// first known limit go out at once, outside either), and tolerates either module being absent (a
// missing display must never affect a drive). `refresh` sends at once, outside the throttle (the
// weather line, the "Not driving?" hint running out). Every state goes out wearing the app's
// current sky (`displayLook.ts`).
//
// iOS, the lock screen's number: given the halo's speed (`SpeedCarry`: the engine's estimate, its
// acceleration and the time it stands for), the Live Activity shows the halo's own number, the
// estimate carried on from its time along its acceleration (`carriedSpeed`) and rounded with the
// halo's hysteresis (`wholeSpeed`). It is re-read every `SPEED_TICK_MS` (4 a second) while it is
// carried (up to `CARRY_MAX_MS` after each fix) and while a change still waits behind the
// throttle, and each whole-number change goes out as it comes. A cruise or a stop sends nothing
// between fixes: there is nothing new to show. Android's notification never carries.
//
// iOS: `start` starts a local activity, or adopts one already running (a push-started one); it is
// called as a drive opens with RoadWise in front and again on every return to the front while it
// records. With RoadWise behind, the host asks the server for a push-to-start instead
// (`isRunning` says whether one runs). Android: the notification, as before (it ignores the new keys).
import type { DriveDisplayState } from '@drive-sense';
import type { LiveDriveApi, LiveDriveState } from '@live-drive';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { CARRY_MAX_MS, carriedSpeed, SPEED_TICK_MS, wholeSpeed } from '@/core/engine/displaySpeed';
import { KMH_PER_MPH } from '@/lib/units';

import { displayLook, type DisplayLook } from './displayLook';

export type { DriveDisplayState };

/**
 * The halo's speed (`EngineSnapshot.speedMps`, `speedAccelMps2`, `speedAt`), for the Live Activity
 * to carry on between fixes as the halo does; null before the drive's first fix.
 */
export interface SpeedCarry {
  /** m/s at `at` */
  mps: number;
  /** m/s² to carry it on with; 0: not carried */
  accel: number;
  /** the time `mps` stands for (host clock, as `now`) */
  at: number;
}

export interface DriveDisplay {
  start(state: DriveDisplayState): void;
  /** `carry`: the halo's speed, which the Live Activity's number follows (iOS; ignored elsewhere). */
  update(state: DriveDisplayState, carry?: SpeedCarry | null): void;
  /**
   * Send `state` now, whatever the throttle (an unchanged state is not sent again); `carry` as for
   * `update`, the last one kept when left out.
   */
  refresh?(state: DriveDisplayState, carry?: SpeedCarry | null): void;
  end(): void;
  /** iOS: a Live Activity is running (a pushed or local one); false where none can run. */
  isRunning?(): Promise<boolean>;
}

/** The two native sinks, as far as they exist. */
export interface DisplaySinks {
  setDriveDisplay?: (state: DriveDisplayState) => Promise<unknown> | unknown;
  liveDrive?: Pick<LiveDriveApi, 'start' | 'end'> & Partial<Pick<LiveDriveApi, 'isRunning'>>;
}

/** Android: the notification takes a change this often at most. */
export const DISPLAY_MIN_INTERVAL_MS = 3000;
/** iOS: the Live Activity takes a change this often at most (5 a second; its number is re-read 4 a second). */
export const LIVE_MIN_INTERVAL_MS = 200;
/** An unchanged display is re-sent this often (one update a minute at a stop). */
export const DISPLAY_KEEPALIVE_MS = 60_000;

const same = (a: DriveDisplayState | null, b: DriveDisplayState): boolean =>
  a !== null &&
  a.speed === b.speed &&
  a.limit === b.limit &&
  a.unit === b.unit &&
  a.points === b.points &&
  a.pointsDelta === b.pointsDelta &&
  a.stopped === b.stopped &&
  (a.ended ?? false) === (b.ended ?? false) &&
  (a.speedTint ?? null) === (b.speedTint ?? null) &&
  (a.speeding ?? false) === (b.speeding ?? false) &&
  (a.notDrivingAvailable ?? false) === (b.notDrivingAvailable ?? false) &&
  (a.weatherKind ?? null) === (b.weatherKind ?? null) &&
  (a.weatherText ?? null) === (b.weatherText ?? null) &&
  (a.skyTop ?? null) === (b.skyTop ?? null) &&
  (a.skyMid ?? null) === (b.skyMid ?? null) &&
  (a.skyLow ?? null) === (b.skyLow ?? null) &&
  (a.accent ?? null) === (b.accent ?? null);

/** The Live Activity's content (`LiveDriveAttributes.ContentState`): no points, no stopped flag. */
export const toLive = (s: DriveDisplayState): LiveDriveState => ({
  speed: s.speed,
  limit: s.limit,
  unit: s.unit,
  speedTint: s.speedTint ?? null,
  speeding: s.speeding ?? false,
  notDrivingAvailable: s.notDrivingAvailable ?? false,
  weatherKind: s.weatherKind ?? null,
  weatherText: s.weatherText ?? null,
  skyTop: s.skyTop ?? null,
  skyMid: s.skyMid ?? null,
  skyLow: s.skyLow ?? null,
  accent: s.accent ?? null,
});

/**
 * `state` in the given look (null for all four without one). The tint, the hint and the weather
 * line always go out, as values or null (native's display contract).
 */
const wearing = (state: DriveDisplayState, look: DisplayLook | null): DriveDisplayState => ({
  ...state,
  speedTint: state.speedTint ?? null,
  speeding: state.speeding ?? false,
  notDrivingAvailable: state.notDrivingAvailable ?? false,
  weatherKind: state.weatherKind ?? null,
  weatherText: state.weatherText ?? null,
  skyTop: look?.skyTop ?? null,
  skyMid: look?.skyMid ?? null,
  skyLow: look?.skyLow ?? null,
  accent: look?.accent ?? null,
});

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

const call = (fn: (() => Promise<unknown> | unknown) | null, onError?: (e: unknown) => void): void => {
  if (fn === null) return;
  try {
    const out = fn();
    if (out instanceof Promise) out.catch((e: unknown) => onError?.(e));
  } catch (e) {
    onError?.(e);
  }
};

export function createDriveDisplay(
  sinks: DisplaySinks,
  deps: {
    now: () => number;
    platform: 'ios' | 'android' | string;
    minIntervalMs?: number;
    onError?: (e: unknown) => void;
    /** The sky to wear (default: the app's, from `displayLook.ts`). */
    look?: () => DisplayLook | null;
    /** Runs `fn` every `ms` until the returned stop is called (default: setInterval). */
    every?: (ms: number, fn: () => void) => () => void;
  }
): DriveDisplay {
  const ios = deps.platform === 'ios';
  const look = deps.look ?? displayLook;
  const every = deps.every ?? defaultEvery;
  const minInterval = deps.minIntervalMs ?? (ios ? LIVE_MIN_INTERVAL_MS : DISPLAY_MIN_INTERVAL_MS);
  const set = typeof sinks.setDriveDisplay === 'function' ? sinks.setDriveDisplay : null;
  const live = sinks.liveDrive && typeof sinks.liveDrive.start === 'function' && typeof sinks.liveDrive.end === 'function' ? sinks.liveDrive : null;
  let last: DriveDisplayState | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  /** The drive's unit, from its start call, for an end before any update went out. */
  let unit: DriveDisplayState['unit'] = 'mph';
  /**
   * This drive's display has shown a speed / a limit: the first of each goes out at once, whatever
   * the throttle, so the lock screen never keeps "-" after the drive knows better.
   */
  let speedShown = false;
  let limitShown = false;
  /** iOS: the newest state given (with the host's own speed), the halo's speed, the number carried last, the ticks. */
  let given: DriveDisplayState | null = null;
  let carry: SpeedCarry | null = null;
  let whole: number | null = null;
  let stopTicks: (() => void) | null = null;

  function send(state: DriveDisplayState, force: boolean): void {
    const now = deps.now();
    const first = (!speedShown && state.speed !== null) || (!limitShown && state.limit !== null);
    if (!force && !first && (now - lastAt < minInterval || (same(last, state) && now - lastAt < DISPLAY_KEEPALIVE_MS))) return;
    last = state;
    lastAt = now;
    if (state.speed !== null) speedShown = true;
    if (state.limit !== null) limitShown = true;
    call(set === null ? null : () => set(state), deps.onError);
  }

  /** `state` with the halo's number at `now` in place of the host's (iOS, with a carry and a known speed). */
  function carried(state: DriveDisplayState, now: number): DriveDisplayState {
    if (!ios || carry === null || state.speed === null) return state;
    const perMps = (state.unit === 'km/h' ? KMH_PER_MPH : 1) / MPS_PER_MPH;
    whole = wholeSpeed(whole, carriedSpeed(carry.mps, carry.accel, now - carry.at) * perMps);
    return whole === state.speed ? state : { ...state, speed: whole };
  }

  /** The halo moves its number on between fixes at `now`. */
  const carrying = (now: number): boolean => carry !== null && carry.mps > 0 && carry.accel !== 0 && now - carry.at < CARRY_MAX_MS;

  function stop(): void {
    stopTicks?.();
    stopTicks = null;
  }

  /** A tick re-reads the number and sends a change; the ticks stop once nothing moves and nothing waits. */
  function tick(): void {
    if (given === null) {
      stop();
      return;
    }
    const now = deps.now();
    const s = carried(given, now);
    send(s, false);
    if (!carrying(now) && same(last, s)) stop();
  }

  /** iOS: the ticks run while the number is carried or a change waits behind the throttle. */
  function tickWhileNeeded(now: number, s: DriveDisplayState): void {
    if (!ios || stopTicks !== null) return;
    if (carrying(now) || !same(last, s)) stopTicks = every(SPEED_TICK_MS, tick);
  }

  return {
    start(state) {
      last = null;
      speedShown = false;
      limitShown = false;
      stop();
      carry = null;
      whole = null;
      unit = state.unit;
      const worn = wearing(state, look());
      given = worn;
      // iOS: starts the activity, or adopts the one running (pushed, or started earlier); false is fine.
      if (ios) call(live === null ? null : () => live.start(toLive(worn)), deps.onError);
      send(worn, true);
    },
    update(state, c) {
      const now = deps.now();
      given = wearing(state, look());
      carry = ios ? (c ?? null) : null;
      const s = carried(given, now);
      send(s, false);
      tickWhileNeeded(now, s);
    },
    refresh(state, c) {
      const now = deps.now();
      given = wearing(state, look());
      if (c !== undefined) carry = ios ? c : null;
      const s = carried(given, now);
      if (same(last, s)) return;
      send(s, true);
      tickWhileNeeded(now, s);
    },
    end() {
      // Exactly one end path: iOS ends the Live Activity through `LiveDrive.end()` (a `setDriveDisplay`
      // with `ended` would end it a second time through the bridge); Android's notification takes
      // its final state from the display call.
      if (ios && live !== null) {
        call(() => live.end(), deps.onError);
      } else {
        const final = last ?? { speed: null, limit: null, unit, points: null, pointsDelta: null, stopped: true };
        const ended: DriveDisplayState = { ...wearing(final, look()), ended: true };
        call(set === null ? null : () => set(ended), deps.onError);
      }
      last = null;
      lastAt = Number.NEGATIVE_INFINITY;
      speedShown = false;
      limitShown = false;
      stop();
      given = null;
      carry = null;
      whole = null;
    },
    async isRunning() {
      if (!ios || live === null || typeof live.isRunning !== 'function') return false;
      try {
        return (await live.isRunning()) === true;
      } catch (e) {
        deps.onError?.(e);
        return false;
      }
    },
  };
}

/** The device's sinks: drive-sense and live-drive as the app has them. */
export function nativeDisplaySinks(): DisplaySinks {
  /* eslint-disable @typescript-eslint/no-require-imports -- loaded on first use */
  const DriveSense = (require('@drive-sense') as typeof import('@drive-sense')).default;
  const LiveDrive = (require('@live-drive') as typeof import('@live-drive')).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { setDriveDisplay: (state) => DriveSense.setDriveDisplay(state), liveDrive: LiveDrive };
}
