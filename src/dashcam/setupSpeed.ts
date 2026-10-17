// The car's speed for a DashPal setup's STATE (docs/BLE_PROTOCOL.md §4: `speed_valid` only from a
// fresh location sample). While the setup sheet is open, and only when foreground location is
// already allowed (a read, never a prompt), it watches the phone's position once a second; a
// sample counts while it is at most 2 s old and its speed accuracy is 2 m/s or better (or not
// rated: expo-location does not report one on every platform). Never a remembered value: no sample, an old one or a refused permission is no speed, and
// the DashPal then takes the car as stopped while it is being set up.

export const SPEED_FRESH_MS = 2000;
export const SPEED_ACC_MAX_MPS = 2;

export interface SpeedSample {
  timestamp: number;
  coords: { speed: number | null; speedAccuracy?: number | null };
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
  /** The speed of a fresh, accurate sample in cm/s, or null. */
  speedCms(): number | null;
  stop(): void;
}

function defaultDeps(): SetupSpeedDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const Location = require('expo-location') as typeof import('expo-location');
  return {
    getForegroundPermissionsAsync: () => Location.getForegroundPermissionsAsync(),
    watchPositionAsync: (opts, cb) => Location.watchPositionAsync(opts, (l) => cb({ timestamp: l.timestamp, coords: { speed: l.coords.speed, speedAccuracy: (l.coords as { speedAccuracy?: number | null }).speedAccuracy ?? null } })),
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
      const acc = s.coords.speedAccuracy;
      if (age < 0 || age > SPEED_FRESH_MS) return null;
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return null;
      if (typeof acc === 'number' && Number.isFinite(acc) && acc > SPEED_ACC_MAX_MPS) return null;
      return Math.round(speed * 100);
    },
    stop() {
      stopped = true;
      sub?.remove();
      sub = null;
      last = null;
    },
  };
}
