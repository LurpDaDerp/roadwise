// The background driving display (modes plan §3.10): `DriveSense.setDriveDisplay` reaches the
// Android foreground notification and, on iOS, a running Live Activity; `LiveDrive.start`/`end`
// bound the activity's life to the drive. This adapter throttles to one update per 3 s, sends only
// changes — and an unchanged state again every 60 s, so a long stop never leaves the Live Activity
// stale (its stale date is 2 min on) — and tolerates either module being absent (a missing display
// must never affect a drive). `refresh` sends at once, outside the throttle (the weather line, the
// "Not driving?" hint running out). Every state goes out wearing the app's current sky
// (`displayLook.ts`).
//
// iOS: `start` starts a local activity, or adopts one already running (a push-started one); it is
// called as a drive opens with RoadWise in front and again on every return to the front while it
// records. With RoadWise behind, the host asks the server for a push-to-start instead
// (`isRunning` says whether one runs). Android: the notification, as before (it ignores the new keys).
import type { DriveDisplayState } from '@drive-sense';
import type { LiveDriveApi, LiveDriveState } from '@live-drive';

import { displayLook, type DisplayLook } from './displayLook';

export type { DriveDisplayState };

export interface DriveDisplay {
  start(state: DriveDisplayState): void;
  update(state: DriveDisplayState): void;
  /** Send `state` now, whatever the throttle (an unchanged state is not sent again). */
  refresh?(state: DriveDisplayState): void;
  end(): void;
  /** iOS: a Live Activity is running (a pushed or local one); false where none can run. */
  isRunning?(): Promise<boolean>;
}

/** The two native sinks, as far as they exist. */
export interface DisplaySinks {
  setDriveDisplay?: (state: DriveDisplayState) => Promise<unknown> | unknown;
  liveDrive?: Pick<LiveDriveApi, 'start' | 'end'> & Partial<Pick<LiveDriveApi, 'isRunning'>>;
}

export const DISPLAY_MIN_INTERVAL_MS = 3000;
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

/** `state` in the given look (null for all four without one). */
const wearing = (state: DriveDisplayState, look: DisplayLook | null): DriveDisplayState => ({
  ...state,
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
  }
): DriveDisplay {
  const ios = deps.platform === 'ios';
  const look = deps.look ?? displayLook;
  const minInterval = deps.minIntervalMs ?? DISPLAY_MIN_INTERVAL_MS;
  const set = typeof sinks.setDriveDisplay === 'function' ? sinks.setDriveDisplay : null;
  const live = sinks.liveDrive && typeof sinks.liveDrive.start === 'function' && typeof sinks.liveDrive.end === 'function' ? sinks.liveDrive : null;
  let last: DriveDisplayState | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  /** The drive's unit, from its start call, for an end before any update went out. */
  let unit: DriveDisplayState['unit'] = 'mph';

  function send(state: DriveDisplayState, force: boolean): void {
    const now = deps.now();
    if (!force && (now - lastAt < minInterval || (same(last, state) && now - lastAt < DISPLAY_KEEPALIVE_MS))) return;
    last = state;
    lastAt = now;
    call(set === null ? null : () => set(state), deps.onError);
  }

  return {
    start(state) {
      last = null;
      unit = state.unit;
      const worn = wearing(state, look());
      // iOS: starts the activity, or adopts the one running (pushed, or started earlier); false is fine.
      if (ios) call(live === null ? null : () => live.start(toLive(worn)), deps.onError);
      send(worn, true);
    },
    update(state) {
      send(wearing(state, look()), false);
    },
    refresh(state) {
      const worn = wearing(state, look());
      if (same(last, worn)) return;
      send(worn, true);
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
