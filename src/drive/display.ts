// The background driving display (plan §6): `DriveSense.setDriveDisplay` reaches the Android
// foreground notification and, on iOS, a running Live Activity; `LiveDrive.start`/`end` bound the
// activity's life to the drive. This adapter throttles to one update per 3 s, sends only changes —
// and an unchanged state again every 60 s, so a long stop never leaves the Live Activity stale (its
// stale date is 2 min on) — and tolerates either module being absent (a missing display must never
// affect a drive). Every state goes out wearing the app's current sky (`displayLook.ts`).
import type { DriveDisplayState } from '@drive-sense';
import type { LiveDriveApi, LiveDriveState } from '@live-drive';

import { displayLook, type DisplayLook } from './displayLook';

export type { DriveDisplayState };

export interface DriveDisplay {
  start(state: DriveDisplayState): void;
  update(state: DriveDisplayState): void;
  end(): void;
}

/** The two native sinks, as far as they exist. */
export interface DisplaySinks {
  setDriveDisplay?: (state: DriveDisplayState) => Promise<unknown> | unknown;
  liveDrive?: Pick<LiveDriveApi, 'start' | 'end'>;
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
  (a.skyTop ?? null) === (b.skyTop ?? null) &&
  (a.skyMid ?? null) === (b.skyMid ?? null) &&
  (a.skyLow ?? null) === (b.skyLow ?? null) &&
  (a.accent ?? null) === (b.accent ?? null);

const toLive = ({ speed, limit, unit, points, pointsDelta, stopped, skyTop, skyMid, skyLow, accent }: DriveDisplayState): LiveDriveState => ({
  speed,
  limit,
  unit,
  points,
  pointsDelta,
  stopped,
  skyTop: skyTop ?? null,
  skyMid: skyMid ?? null,
  skyLow: skyLow ?? null,
  accent: accent ?? null,
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
      // iOS: the activity is started by the drive start and nothing else; false (unsupported, off) is fine.
      if (ios) call(live === null ? null : () => live.start(toLive(worn)), deps.onError);
      send(worn, true);
    },
    update(state) {
      send(wearing(state, look()), false);
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
