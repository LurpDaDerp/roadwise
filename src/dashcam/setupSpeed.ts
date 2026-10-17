// The car's speed for a DashPal setup's STATE (docs/BLE_PROTOCOL.md §4: `speed_valid` only from a
// fresh location sample). While the setup sheet is open, and only when foreground location is
// already allowed (a read, never a prompt), it watches the phone's position once a second. A sample
// counts while it is at most 2 s old and its fix is rated within 20 m (a drive's fix limit).
// expo-location reports no speed accuracy on any platform, so a speed is never known to be better
// than the 2 m/s a phone standing still can read: under 2 m/s it is a stop (0). Never a remembered
// value: no sample, an old one, a poor or unrated fix or a refused permission is no speed, and the
// DashPal then takes the car as stopped while it is being set up.

export const SPEED_FRESH_MS = 2000;
/** The fix's horizontal accuracy (m) a sample needs: `MAX_H_ACC_M`, a drive's valid fix. */
export const SPEED_H_ACC_MAX_M = 20;
/** A speed under this (m/s) is read as a stop: an unrated GPS speed this low can't be told from standing still. */
export const SPEED_STOP_FLOOR_MPS = 2;

export interface SpeedSample {
  timestamp: number;
  /** `accuracy`: the fix's horizontal accuracy in metres (null: not rated) */
  coords: { speed: number | null; accuracy: number | null };
}

export interface SetupSpeedDeps {
  getForegroundPermissionsAsync(): Promise<{ granted: boolean }>;
  watchPositionAsync(opts: { accuracy: number; timeInterval: number; distanceInterval: number }, cb: (s: SpeedSample) => void): Promise<{ remove(): void }>;
  /** `Location.Accuracy.High` */
  accuracyHigh: number;
  now(): number;
}

export interface SetupSpeed {
  /** Start watching (only with foreground location already allowed). Never throws. */
  start(): Promise<void>;
  /** The speed of a fresh sample with a good fix in cm/s (0 under 2 m/s), or null. */
  speedCms(): number | null;
  stop(): void;
}

function defaultDeps(): SetupSpeedDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const Location = require('expo-location') as typeof import('expo-location');
  return {
    getForegroundPermissionsAsync: () => Location.getForegroundPermissionsAsync(),
    watchPositionAsync: (opts, cb) => Location.watchPositionAsync(opts, (l) => cb({ timestamp: l.timestamp, coords: { speed: l.coords.speed, accuracy: l.coords.accuracy } })),
    accuracyHigh: Location.Accuracy.High,
    now: () => Date.now(),
  };
}

export function createSetupSpeed(depsIn?: SetupSpeedDeps): SetupSpeed {
  let deps: SetupSpeedDeps | null = depsIn ?? null;
  let sub: { remove(): void } | null = null;
  let last: SpeedSample | null = null;
  let stopped = false;

  return {
    async start() {
      stopped = false;
      try {
        deps ??= defaultDeps();
        if (sub || !(await deps.getForegroundPermissionsAsync()).granted || stopped) return;
        const s = await deps.watchPositionAsync({ accuracy: deps.accuracyHigh, timeInterval: 1000, distanceInterval: 0 }, (sample) => {
          last = sample;
        });
        if (stopped) s.remove();
        else sub = s;
      } catch {
        // no location: no speed
      }
    },
    speedCms() {
      const s = last;
      if (!s || !deps) return null;
      const age = deps.now() - s.timestamp;
      const speed = s.coords.speed;
      const acc = s.coords.accuracy;
      if (age < 0 || age > SPEED_FRESH_MS) return null;
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return null;
      if (typeof acc !== 'number' || !Number.isFinite(acc) || acc < 0 || acc > SPEED_H_ACC_MAX_M) return null;
      return speed < SPEED_STOP_FLOOR_MPS ? 0 : Math.round(speed * 100);
    },
    stop() {
      stopped = true;
      sub?.remove();
      sub = null;
      last = null;
    },
  };
}
