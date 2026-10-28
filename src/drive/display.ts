// The background driving display (modes plan §3.10): `DriveSense.setDriveDisplay` reaches the
// Android foreground notification and, on iOS, a running Live Activity; `LiveDrive.start`/`end`
// bound the activity's life to the drive. This adapter sends only changes (and an unchanged state
// again every 60 s, so a long stop never leaves the Live Activity stale: its stale date is 2 min
// on), at most one per 3 s on Android and one a second on iOS (the drive's first known speed and
// first known limit go out at once, outside either), and tolerates either module being absent (a
// missing display must never affect a drive). On iOS a change the throttle holds goes out when the
// second is up (one timer, armed only while something new waits), with the newest state and the
// halo's number at that moment, so no fix waits for the next row or fix to carry it; Android's held
// change goes out with the first `update` past its 3 s. `refresh` sends at once, outside the
// throttle (the weather line, the "Not driving?" hint running out). Every state goes out wearing the
// app's current sky (`displayLook.ts`).
//
// iOS, the lock screen's number: given the halo's speed (`SpeedCarry`: the engine's estimate, its
// acceleration and the time it stands for), each update shows the halo's number at that moment,
// the estimate carried on from its time along its acceleration (`carriedSpeed`) and rounded with
// the halo's hysteresis (`wholeSpeed`). The hysteresis depends on the path, so each update first
// walks the carry through the halo's own re-reads (every `SPEED_TICK_MS` from when the carry came,
// until `CARRY_MAX_MS` after its time) without any timer, and the number lands where the halo's
// does. The Live Activity holds its number until the next update (at most a second later).
// Android's notification never carries.
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
 * to show the halo's number at each update; null before the drive's first fix.
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
/**
 * iOS: the Live Activity takes a change at most once a second (about once per GPS fix, the most
 * iOS keeps applying on a locked screen). A change that comes sooner is sent when the second is up.
 */
export const LIVE_MIN_INTERVAL_MS = 1000;
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
    /** Runs `fn` once after `ms` (iOS's held change); returns the cancel. Default: `setTimeout`. */
    later?: (fn: () => void, ms: number) => () => void;
  }
): DriveDisplay {
  const ios = deps.platform === 'ios';
  const look = deps.look ?? displayLook;
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
  /**
   * iOS: the halo's speed, the number carried last (its hysteresis), when this carry came (the
   * halo's re-reads run from then) and the instant `whole` has walked it to.
   */
  let carry: SpeedCarry | null = null;
  let whole: number | null = null;
  let cameAt = 0;
  let walkedTo = 0;
  /** iOS: the newest state the throttle holds (as the host gave it), and the timer that sends it. */
  let held: DriveDisplayState | null = null;
  let cancelHeld: (() => void) | null = null;
  const later =
    deps.later ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  function dropHeld(): void {
    cancelHeld?.();
    cancelHeld = null;
    held = null;
  }

  /** True when `state` went out. */
  function send(state: DriveDisplayState, force: boolean): boolean {
    const now = deps.now();
    const first = (!speedShown && state.speed !== null) || (!limitShown && state.limit !== null);
    if (!force && !first && (now - lastAt < minInterval || (same(last, state) && now - lastAt < DISPLAY_KEEPALIVE_MS))) return false;
    // Whatever waited is older than this.
    dropHeld();
    last = state;
    lastAt = now;
    if (state.speed !== null) speedShown = true;
    if (state.limit !== null) limitShown = true;
    call(set === null ? null : () => set(state), deps.onError);
    return true;
  }

  /**
   * The carried number may still move by the time the second is up (the halo re-reads it every
   * `SPEED_TICK_MS` until `CARRY_MAX_MS` after its fix).
   */
  const stillCarrying = (at: number): boolean => carry !== null && carry.mps > 0 && carry.accel !== 0 && at < carry.at + CARRY_MAX_MS + SPEED_TICK_MS;

  /**
   * iOS: `state` came inside the second. It is held (the newest wins) and sent when the second is
   * up, with the halo's number then, if it shows something new by then: a change now, or a number
   * still being carried. One that shows nothing new also drops what waited (a tint that came and
   * went inside the second never goes out late).
   */
  function hold(state: DriveDisplayState, shown: DriveDisplayState, now: number): void {
    const due = lastAt + minInterval;
    if (same(last, shown) && !stillCarrying(due)) {
      dropHeld();
      return;
    }
    held = state;
    if (cancelHeld !== null) return;
    cancelHeld = later(
      () => {
        cancelHeld = null;
        const h = held;
        held = null;
        if (h !== null) sendNow(h);
      },
      Math.max(0, due - now)
    );
  }

  /** `state` in the current sky with the halo's number at this moment, through the throttle. */
  function sendNow(state: DriveDisplayState): void {
    const now = deps.now();
    const shown = carried(wearing(state, look()), now);
    if (!send(shown, false) && ios && now - lastAt < minInterval) hold(state, shown, now);
  }

  /**
   * `whole` through the halo's re-reads of the carry up to `to`: every `SPEED_TICK_MS` from when it
   * came, while the one before fell short of `CARRY_MAX_MS` after its time (the halo's own ticker).
   */
  function walk(to: number, perMps: number): void {
    if (carry === null || !(carry.mps > 0) || carry.accel === 0) return;
    const end = carry.at + CARRY_MAX_MS;
    for (let t = cameAt + SPEED_TICK_MS; t <= to && t - SPEED_TICK_MS < end; t += SPEED_TICK_MS) {
      if (t > walkedTo) whole = wholeSpeed(whole, carriedSpeed(carry.mps, carry.accel, t - carry.at) * perMps);
    }
    walkedTo = Math.max(walkedTo, to);
  }

  /**
   * Takes `c` as the halo's speed at `now` (iOS). A different one is what the halo re-renders on:
   * the old one is walked up to `now` first, and the new one read at once.
   */
  function take(c: SpeedCarry | null, state: DriveDisplayState, now: number): void {
    const changed = c === null || carry === null || c.at !== carry.at || c.mps !== carry.mps || c.accel !== carry.accel;
    if (!changed) return;
    const perMps = (state.unit === 'km/h' ? KMH_PER_MPH : 1) / MPS_PER_MPH;
    walk(now, perMps);
    carry = c;
    cameAt = now;
    walkedTo = now;
    if (c !== null) whole = wholeSpeed(whole, carriedSpeed(c.mps, c.accel, now - c.at) * perMps);
  }

  /** `state` with the halo's number at `now` in place of the host's (iOS, with a carry and a known speed). */
  function carried(state: DriveDisplayState, now: number): DriveDisplayState {
    if (!ios || carry === null || state.speed === null) return state;
    walk(now, (state.unit === 'km/h' ? KMH_PER_MPH : 1) / MPS_PER_MPH);
    if (whole === null) return state;
    return whole === state.speed ? state : { ...state, speed: whole };
  }

  return {
    start(state) {
      dropHeld();
      last = null;
      speedShown = false;
      limitShown = false;
      carry = null;
      whole = null;
      unit = state.unit;
      const worn = wearing(state, look());
      // iOS: starts the activity, or adopts the one running (pushed, or started earlier); false is fine.
      if (ios) call(live === null ? null : () => live.start(toLive(worn)), deps.onError);
      send(worn, true);
    },
    update(state, c) {
      if (ios) take(c ?? null, state, deps.now());
      sendNow(state);
    },
    refresh(state, c) {
      const now = deps.now();
      if (ios && c !== undefined) take(c, state, now);
      const s = carried(wearing(state, look()), now);
      if (same(last, s)) return;
      send(s, true);
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
      dropHeld();
      last = null;
      lastAt = Number.NEGATIVE_INFINITY;
      speedShown = false;
      limitShown = false;
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
