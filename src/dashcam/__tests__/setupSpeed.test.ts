// The setup's speed: a location watch only with foreground location already allowed, a sample
// counted only while fresh (2 s) and accurate (2 m/s, or not rated), never a remembered value.
import { createSetupSpeed, SPEED_FRESH_MS, type SetupSpeedDeps, type SpeedSample } from '../setupSpeed';

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

test('a fresh, accurate sample is the speed in cm/s; an old one, a bad accuracy or none is no speed', async () => {
  const f = deps();
  const s = createSetupSpeed(f.d);
  await s.start();
  expect(f.calls).toEqual(['permission', 'watch:1000:0:4']);
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 1.234, speedAccuracy: 0.5 } });
  expect(s.speedCms()).toBe(123);
  f.clock.t += SPEED_FRESH_MS;
  expect(s.speedCms()).toBe(123);
  f.clock.t += 1;
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 3, speedAccuracy: 2.5 } });
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: 3 } });
  expect(s.speedCms()).toBe(300);
  f.emit({ timestamp: f.clock.t, coords: { speed: -1, speedAccuracy: null } });
  expect(s.speedCms()).toBeNull();
  f.emit({ timestamp: f.clock.t, coords: { speed: null } });
  expect(s.speedCms()).toBeNull();
  s.stop();
  expect(f.removed()).toBe(1);
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
  f.emit({ timestamp: f.clock.t, coords: { speed: 2 } });
  s.stop();
  expect(s.speedCms()).toBeNull();
});
