// The setup's speed: a location watch only with foreground location already allowed, a sample
// counted only while fresh (2 s) with a fix within 20 m, a speed under 2 m/s read as a stop, never
// a remembered value.
import { createSetupSpeed, SPEED_FRESH_MS, SPEED_H_ACC_MAX_M, SPEED_STOP_FLOOR_MPS, type SetupSpeedDeps, type SpeedSample } from '../setupSpeed';

// Jest runs this suite as CommonJS: `__dirname` and `require` are real at run time.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's own modules in a test
const { readFileSync } = require('fs') as { readFileSync(p: string, enc: string): string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's own modules in a test
const { join } = require('path') as { join(...p: string[]): string };

function deps(o: { granted?: boolean } = {}) {
  const clock = { t: 10_000 };
  const calls: string[] = [];
  let cb: ((s: SpeedSample) => void) | null = null;
  let removed = 0;
  const d: SetupSpeedDeps = {
    getForegroundPermissionsAsync: async () => {
      calls.push('permission');
      return { granted: o.granted ?? true };
    },
    watchPositionAsync: async (opts, fn) => {
      calls.push(`watch:${opts.timeInterval}:${opts.distanceInterval}:${opts.accuracy}`);
      cb = fn;
      return { remove: () => void (removed += 1) };
    },
    accuracyHigh: 4,
    now: () => clock.t,
  };
  return { d, clock, calls, emit: (s: SpeedSample) => cb?.(s), removed: () => removed };
}

test('a fresh sample with a good fix is the speed in cm/s; an old one, a poor or unrated fix, or none is no speed', async () => {
  const f = deps();
  const s = createSetupSpeed(f.d);
  await s.start();
  expect(f.calls).toEqual(['permission', 'watch:1000:0:4']);
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 3.456, accuracy: 5 } });
  expect(s.speedCms()).toBe(346);
  f.clock.t += SPEED_FRESH_MS;
  expect(s.speedCms()).toBe(346);
  f.clock.t += 1;
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 3, accuracy: SPEED_H_ACC_MAX_M } });
  expect(s.speedCms()).toBe(300);
  f.emit({ timestamp: f.clock.t, coords: { speed: 3, accuracy: SPEED_H_ACC_MAX_M + 0.5 } });
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 3, accuracy: null } });
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: -1, accuracy: 5 } });
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: null, accuracy: 5 } });
  expect(s.speedCms()).toBeNull();
  s.stop();
  expect(f.removed()).toBe(1);
});

test('the location API rates no speed accuracy, so a speed under 2 m/s (a phone standing still reads a little) is a stop, never a creep', async () => {
  const f = deps();
  const s = createSetupSpeed(f.d);
  await s.start();
  for (const speed of [0, 0.4, 1.4, 1.99]) {
    f.emit({ timestamp: f.clock.t, coords: { speed, accuracy: 4 } });
    expect(s.speedCms()).toBe(0);
  }
  f.emit({ timestamp: f.clock.t, coords: { speed: SPEED_STOP_FLOOR_MPS, accuracy: 4 } });
  expect(s.speedCms()).toBe(200);
});

test('the real location API: its fix accuracy is what the sample carries (expo-location has no speed accuracy)', () => {
  const src = readFileSync(join(__dirname, '..', 'setupSpeed.ts'), 'utf8');
  expect(src).not.toMatch(/speedAccuracy/);
  expect(src).toMatch(/accuracy: l\.coords\.accuracy/);
});

test('without foreground location allowed it never watches (and never asks)', async () => {
  const f = deps({ granted: false });
  const s = createSetupSpeed(f.d);
  await s.start();
  expect(f.calls).toEqual(['permission']);
  expect(s.speedCms()).toBeNull();
});

test('stopped: the last sample is forgotten, so a later start never reports it', async () => {
  const f = deps();
  const s = createSetupSpeed(f.d);
  await s.start();
  f.emit({ timestamp: f.clock.t, coords: { speed: 2, accuracy: 4 } });
  s.stop();
  expect(s.speedCms()).toBeNull();
});
