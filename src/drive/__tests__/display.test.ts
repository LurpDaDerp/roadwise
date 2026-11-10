import { act, renderHook } from '@testing-library/react-native';

import { MPS_PER_MPH } from '@/core/detectors/common';
import {
  createDriveDisplay,
  DISPLAY_KEEPALIVE_MS,
  DISPLAY_MIN_INTERVAL_MS,
  LIVE_CONFIRM_MS,
  LIVE_MIN_INTERVAL_MS,
  LIVE_PACE_MS,
  LIVE_TINT_ONLY_MS,
  toLive,
  type DriveDisplay,
  type DriveDisplayState,
} from '@/drive/display';
import { displayLook, setDisplayLook, type DisplayLook } from '@/drive/displayLook';
import type { ShownSpeed } from '@/drive/useDrive';
import { useCarriedSpeed } from '@/features/drive/HaloReadout';

// The host always sends the tint, the hint and the weather (values or null), as native's contract asks.
const state = (over: Partial<DriveDisplayState> = {}): DriveDisplayState => ({
  speed: 30,
  limit: 35,
  unit: 'mph',
  points: null,
  pointsDelta: null,
  stopped: false,
  speedTint: null,
  speeding: false,
  notDrivingAvailable: false,
  weatherKind: null,
  weatherText: null,
  ...over,
});

test('an Android end right after the start keeps the start call\'s unit', () => {
  const sent: DriveDisplayState[] = [];
  const d = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => 0, platform: 'android' });
  d.start(state({ speed: null, limit: null, unit: 'km/h', stopped: true }));
  d.end();
  expect(sent.at(-1)).toMatchObject({ unit: 'km/h', ended: true, speed: null, points: null });
});

function sinks() {
  const set = jest.fn(async () => {});
  const live = { start: jest.fn(async () => true), end: jest.fn(async () => {}) };
  return { set, live };
}

test('iOS: the Live Activity is started by the drive start and ended once by LiveDrive.end(); updates go through setDriveDisplay', () => {
  let now = 0;
  const { set, live } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
  d.start(state({ speed: null }));
  expect(live.start).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenCalledTimes(1);
  now = 4000;
  d.update(state({ speed: 31 }));
  expect(set).toHaveBeenCalledTimes(2);
  d.end();
  expect(live.end).toHaveBeenCalledTimes(1);
  // No `ended` display call on iOS: that would end the activity a second time through the bridge.
  expect(set).toHaveBeenCalledTimes(2);
});

test('Android: no Live Activity; the end goes through the display call with `ended`', () => {
  const { set, live } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => 0, platform: 'android' });
  d.start(state());
  d.end();
  expect(live.start).not.toHaveBeenCalled();
  expect(live.end).not.toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ ended: true, speed: 30 }));
});

test('updates are throttled to one per 3 s and sent only on change', () => {
  let now = 0;
  const { set } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set }, { now: () => now, platform: 'android' });
  d.start(state());
  for (let i = 1; i <= 10; i += 1) {
    now = i * 1000;
    d.update(state({ speed: 30 + i }));
  }
  // t=0 (start), then 3 s, 6 s, 9 s.
  expect(set).toHaveBeenCalledTimes(4);
  now = 20_000;
  d.update(state({ speed: 40 }));
  d.update(state({ speed: 40 }));
  now = 30_000;
  d.update(state({ speed: 40 }));
  expect(set).toHaveBeenCalledTimes(5);
  expect(DISPLAY_MIN_INTERVAL_MS).toBe(3000);
});

test('tolerates missing sinks and a rejecting sink', () => {
  const errors: unknown[] = [];
  const d = createDriveDisplay({}, { now: () => 0, platform: 'ios', onError: (e) => errors.push(e) });
  expect(() => {
    d.start(state());
    d.update(state());
    d.end();
  }).not.toThrow();
  const bad = createDriveDisplay({ setDriveDisplay: () => Promise.reject(new Error('x')) }, { now: () => 0, platform: 'android', onError: (e) => errors.push(e) });
  bad.start(state());
  return new Promise((r) => setTimeout(r, 0)).then(() => expect(errors).toHaveLength(1));
});

test('an unchanged display is re-sent every 60 s (a long stop never goes stale); a change keeps the 3 s minimum; end resets', () => {
  expect(DISPLAY_KEEPALIVE_MS).toBe(60_000);
  let now = 0;
  const { set } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set }, { now: () => now, platform: 'android' });
  const stopped = state({ speed: 0, stopped: true, points: 40, pointsDelta: 2 });
  d.start(stopped);
  expect(set).toHaveBeenCalledTimes(1);
  now = 59_999;
  d.update(stopped);
  expect(set).toHaveBeenCalledTimes(1);
  now = 60_000;
  d.update(stopped);
  expect(set).toHaveBeenCalledTimes(2);
  now = 61_000;
  d.update(state({ speed: 3, stopped: true, points: 40, pointsDelta: 2 }));
  expect(set).toHaveBeenCalledTimes(2); // a change inside 3 s still waits
  now = 63_000;
  d.update(state({ speed: 3, stopped: true, points: 40, pointsDelta: 2 }));
  expect(set).toHaveBeenCalledTimes(3);
  d.end();
  expect(set).toHaveBeenCalledTimes(4); // Android's final `ended` state
  d.start(stopped);
  now = 64_000;
  d.update(stopped);
  expect(set).toHaveBeenCalledTimes(5); // the new drive's start; the unchanged update waits
});

test("every state wears the app's sky (null for all four without one) and goes out again when only the sky changes", () => {
  let now = 0;
  let look: DisplayLook | null = null;
  const { set, live } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', look: () => look });
  d.start(state());
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ skyTop: null, skyMid: null, skyLow: null, accent: null }));
  expect(live.start).toHaveBeenLastCalledWith(expect.objectContaining({ skyTop: null, skyMid: null, skyLow: null, accent: null }));
  look = { skyTop: '#0B2A5C', skyMid: '#123B7A', skyLow: '#1A4C94', accent: '#93A9FF' };
  now = 4000;
  d.update(state());
  expect(set).toHaveBeenCalledTimes(2); // the same drive state, a new sky
  expect(set).toHaveBeenLastCalledWith({ ...state(), ...look });
  now = 8000;
  d.update(state());
  expect(set).toHaveBeenCalledTimes(2); // nothing changed
  d.end();
  // The Live Activity starts in the sky of its moment, with no points or stopped flag.
  d.start(state());
  expect(live.start).toHaveBeenLastCalledWith({ speed: 30, limit: 35, unit: 'mph', speedTint: null, speeding: false, notDrivingAvailable: false, weatherKind: null, weatherText: null, ...look });
});

test('by default the display wears the look the app set', () => {
  const { set } = sinks();
  const look: DisplayLook = { skyTop: '#000001', skyMid: '#000002', skyLow: '#000003', accent: '#000004' };
  setDisplayLook(look);
  try {
    const d = createDriveDisplay({ setDriveDisplay: set }, { now: () => 0, platform: 'android' });
    d.start(state());
    d.end();
    expect(set).toHaveBeenNthCalledWith(1, { ...state(), ...look });
    expect(set).toHaveBeenLastCalledWith({ ...state(), ...look, ended: true });
  } finally {
    setDisplayLook(null);
  }
  expect(displayLook()).toBeNull();
});

test('the Live Activity state carries the tint, the speeding flag, the hint and the weather line, and never points', () => {
  expect(toLive(state({ speedTint: '#E0884F', speeding: true, notDrivingAvailable: true, weatherKind: 'heavy_rain', weatherText: 'Heavy rain', points: 5 } as Partial<DriveDisplayState>))).toEqual({
    speed: 30,
    limit: 35,
    unit: 'mph',
    speedTint: '#E0884F',
    speeding: true,
    notDrivingAvailable: true,
    weatherKind: 'heavy_rain',
    weatherText: 'Heavy rain',
    skyTop: null,
    skyMid: null,
    skyLow: null,
    accent: null,
  });
});

test('a change in the tint, the hint or the weather is a change; refresh sends it at once, outside the 3 s throttle, once', () => {
  let now = 0;
  const { set } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set }, { now: () => now, platform: 'ios' });
  d.start(state({ notDrivingAvailable: true }));
  now = 500;
  d.refresh!(state({ notDrivingAvailable: false }));
  expect(set).toHaveBeenCalledTimes(2);
  d.refresh!(state({ notDrivingAvailable: false }));
  expect(set).toHaveBeenCalledTimes(2);
  now = 1000;
  d.refresh!(state({ notDrivingAvailable: false, weatherKind: 'dense_fog', weatherText: 'Dense fog' }));
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ weatherKind: 'dense_fog', weatherText: 'Dense fog' }));
  // the tint alone, once its 15 s since the last update are up
  now = 1000 + LIVE_TINT_ONLY_MS;
  d.update(state({ notDrivingAvailable: false, weatherKind: 'dense_fog', weatherText: 'Dense fog', speedTint: '#FFCC00' }));
  expect(set).toHaveBeenCalledTimes(4);
});

test('iOS: the first known speed, the first known limit and a refresh go out at once, inside the pace; the next number waits its 5 s', () => {
  let now = 0;
  const clock = manual();
  const { set, live } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later });
  d.start(state({ speed: null, limit: null }));
  now = 200;
  d.update(state({ speed: 12, limit: null }));
  expect(set).toHaveBeenCalledTimes(2);
  now = 400;
  d.update(state({ speed: 12, limit: 25 }));
  expect(set).toHaveBeenCalledTimes(3);
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 12, limit: 25 }));
  now = 600;
  d.update(state({ speed: 14, limit: 25 }));
  expect(set).toHaveBeenCalledTimes(3);
  expect(clock.armed()).toEqual([4800]);
  now = 700;
  d.refresh!(state({ speed: 14, limit: 25, weatherKind: 'dense_fog', weatherText: 'Dense fog' }));
  expect(set).toHaveBeenCalledTimes(4);
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 14, weatherKind: 'dense_fog' }));
  // what waited went with it
  expect(clock.armed()).toEqual([]);
});

test('isRunning asks LiveDrive on iOS only; false where none can run or it fails', async () => {
  const running = jest.fn(async () => true);
  const ios = createDriveDisplay({ liveDrive: { start: jest.fn(async () => true), end: jest.fn(async () => {}), isRunning: running } }, { now: () => 0, platform: 'ios' });
  expect(await ios.isRunning!()).toBe(true);
  const android = createDriveDisplay({ liveDrive: { start: jest.fn(async () => true), end: jest.fn(async () => {}), isRunning: running } }, { now: () => 0, platform: 'android' });
  expect(await android.isRunning!()).toBe(false);
  const failing = createDriveDisplay({ liveDrive: { start: jest.fn(async () => true), end: jest.fn(async () => {}), isRunning: async () => Promise.reject(new Error('x')) } }, { now: () => 0, platform: 'ios', onError: () => {} });
  expect(await failing.isRunning!()).toBe(false);
});

test('the first known speed and the first known limit go out at once after a start; later changes keep the 3 s throttle', () => {
  let now = 0;
  const { set, live } = sinks();
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'android' });
  d.start(state({ speed: null, limit: null }));
  expect(set).toHaveBeenCalledTimes(1);
  now = 200;
  d.update(state({ speed: 12, limit: null }));
  // The first speed, inside the 3 s.
  expect(set).toHaveBeenCalledTimes(2);
  now = 900;
  d.update(state({ speed: 14, limit: null }));
  // Throttled.
  expect(set).toHaveBeenCalledTimes(2);
  now = 1500;
  d.update(state({ speed: 15, limit: 25 }));
  // The first limit, inside the 3 s.
  expect(set).toHaveBeenCalledTimes(3);
  expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 15, limit: 25 }));
  now = 2000;
  d.update(state({ speed: null, limit: null }));
  now = 2500;
  d.update(state({ speed: 16, limit: 25 }));
  // Known again: no second bypass.
  expect(set).toHaveBeenCalledTimes(3);
  d.end();
  d.start(state({ speed: null, limit: null }));
  now = 2600;
  d.update(state({ speed: 9, limit: null }));
  // Android's final state, the next drive's start, then its own first speed.
  expect(set).toHaveBeenCalledTimes(6);
});

test('a start that already carries a speed and a limit spends both bypasses (the next change waits for the throttle)', () => {
  let now = 0;
  const sent: DriveDisplayState[] = [];
  const d = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => now, platform: 'android' });
  d.start(state({ speed: 30, limit: 35 }));
  now = 500;
  d.update(state({ speed: 31, limit: 35 }));
  expect(sent).toHaveLength(1);
  now = DISPLAY_MIN_INTERVAL_MS;
  d.update(state({ speed: 32, limit: 35 }));
  expect(sent).toHaveLength(2);
});

const mph = (n: number) => n * MPS_PER_MPH;
const speeds = (set: jest.Mock) => set.mock.calls.map((a) => (a as unknown as [DriveDisplayState])[0].speed);

/** A hand-run clock for iOS's held change: `later` records each timer, `run` fires the live ones. */
function manual() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    later: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    armed: () => timers.filter((t) => t.live).map((t) => t.ms),
    run: () => {
      for (const t of timers.splice(0)) if (t.live) t.fn();
    },
  };
}

/**
 * A clock that runs iOS's held change by itself: `to` moves the time on, firing on the way each
 * timer that came due, at its own time.
 */
function ticking() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    later: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    to: (at: number) => {
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= at).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = Math.max(now, due.at);
        due.fn();
      }
      now = at;
    },
  };
}

// The carry tests pace the speed at a second (`paceMs: 1000`), so the halo's re-reads show from one
// update to the next; the 5 s pace has its own tests.
describe('iOS: the Live Activity at its pace, with the halo’s number', () => {
  test('a new number inside 5 s is held and goes out, the newest one, when the 5 s are up; never two inside 5 s; one after 5 s without an update goes at once; Android keeps its 3 s', () => {
    expect(LIVE_MIN_INTERVAL_MS).toBe(1000);
    expect(LIVE_PACE_MS).toBe(5000);
    expect(DISPLAY_MIN_INTERVAL_MS).toBe(3000);
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const at: number[] = [];
    set.mockImplementation(async () => void at.push(now));
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later });
    d.start(state());
    now = 200;
    d.update(state({ speed: 31 }));
    // inside the 5 s: held, with one send waiting for their end
    expect(set).toHaveBeenCalledTimes(1);
    expect(clock.armed()).toEqual([4800]);
    now = 600;
    d.update(state({ speed: 32 }));
    // a large move waits like a small one
    now = 2000;
    d.update(state({ speed: 40 }));
    now = 4000;
    d.update(state({ speed: 41 }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(clock.armed()).toEqual([4800]);
    now = 5000;
    clock.run();
    expect(speeds(set)).toEqual([30, 41]);
    // a row or fix a few ms early on the beat goes out on the beat, not with the next one
    now = 9995;
    d.update(state({ speed: 42 }));
    expect(clock.armed()).toEqual([5]);
    now = 10_000;
    clock.run();
    expect(speeds(set)).toEqual([30, 41, 42]);
    // nothing new: nothing waits
    now = 10_500;
    d.update(state({ speed: 42 }));
    expect(clock.armed()).toEqual([]);
    // a number that comes when 5 s have passed since the last update goes at once
    now = 16_000;
    d.update(state({ speed: 43 }));
    expect(speeds(set)).toEqual([30, 41, 42, 43]);
    expect(clock.armed()).toEqual([]);
    // a change on time goes at once and takes the place of what waited
    now = 17_000;
    d.update(state({ speed: 44 }));
    expect(clock.armed()).toEqual([4000]);
    now = 21_000;
    d.update(state({ speed: 45 }));
    expect(speeds(set)).toEqual([30, 41, 42, 43, 45]);
    expect(clock.armed()).toEqual([]);
    // a number that comes and goes inside its 5 s never goes out late
    now = 22_000;
    d.update(state({ speed: 46 }));
    expect(clock.armed()).toEqual([4000]);
    now = 23_000;
    d.update(state({ speed: 45 }));
    expect(clock.armed()).toEqual([]);
    now = 26_000;
    clock.run();
    expect(set).toHaveBeenCalledTimes(5);
    // the end drops a held change
    now = 26_200;
    d.update(state({ speed: 46 }));
    expect(set).toHaveBeenCalledTimes(6);
    now = 27_000;
    d.update(state({ speed: 47 }));
    now = 28_000;
    d.update(state({ speed: 48 }));
    expect(clock.armed()).toEqual([4200]);
    d.end();
    expect(clock.armed()).toEqual([]);
    expect(speeds(set)).toEqual([30, 41, 42, 43, 45, 46]);
    expect(at).toEqual([0, 5000, 10_000, 16_000, 21_000, 26_200]);

    // Android never holds: its change goes out with the first update past its 3 s
    const android = manual();
    const sent: DriveDisplayState[] = [];
    const a = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => now, platform: 'android', later: android.later });
    a.start(state());
    now += 500;
    a.update(state({ speed: 31 }));
    expect(android.armed()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("a held change goes out with the halo's number at that moment: a row with nothing new yet still waits while the number is carried", () => {
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later, paceMs: 1000 });
    d.start(state({ speed: 28 }));
    // a fix at t = 900 ms: 30 mph and gaining 2 mph a second
    const fix = { mps: mph(30), accel: mph(2), at: 900 };
    now = 1000;
    d.update(state({ speed: 30 }), fix);
    // a row 100 ms on: the halo still reads 30, but its number is being carried, so it waits
    now = 1100;
    d.update(state({ speed: 30 }), fix);
    expect(speeds(set)).toEqual([28, 30]);
    expect(clock.armed()).toEqual([900]);
    // the second's end: the halo's re-reads at 1250, 1500, 1750 and 2000 ms took it to 32 (32.2 mph)
    now = 2000;
    clock.run();
    expect(speeds(set)).toEqual([28, 30, 32]);
    // a row at 2.9 s: the halo reads 33 (33 mph, its carry capped at 1.5 s), held to the second's end
    now = 2900;
    d.update(state({ speed: 30 }), fix);
    expect(clock.armed()).toEqual([100]);
    now = 3000;
    clock.run();
    expect(speeds(set)).toEqual([28, 30, 32, 33]);
    // the carry over, a row with nothing new waits for nothing
    now = 3500;
    d.update(state({ speed: 30 }), fix);
    expect(clock.armed()).toEqual([]);
    expect(speeds(set)).toEqual([28, 30, 32, 33]);
  });

  test("with the halo's speed, each update shows the halo's number at that moment: carried along its acceleration, with its hysteresis", () => {
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later, paceMs: 1000 });
    d.start(state({ speed: 28 }));
    // a fix at t = 900 ms: 30 mph and gaining 2 mph a second; the host rounds 30
    const fix = { mps: mph(30), accel: mph(2), at: 900 };
    now = 1000;
    d.update(state({ speed: 30 }), fix);
    now = 2000;
    // 32.2 mph, 1.1 s on
    d.update(state({ speed: 30 }), fix);
    now = 2600;
    // 33.4 mph: inside the second, held
    d.update(state({ speed: 30 }), fix);
    now = 3000;
    // held at 1.5 s of carry: 33 (the update on the second's end sends it; nothing else waits)
    d.update(state({ speed: 30 }), fix);
    expect(speeds(set)).toEqual([28, 30, 32, 33]);
    expect(clock.armed()).toEqual([]);
    now = 4000;
    // a new fix of 33.6 mph, not carried: the host rounds 34, the halo still reads 33 (0.6 past it)
    d.update(state({ speed: 34, limit: 40 }), { mps: mph(33.6), accel: 0, at: 4000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 33, limit: 40 }));
    now = 5000;
    d.update(state({ speed: 34, limit: 40 }), { mps: mph(33.9), accel: 0, at: 5000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 34 }));
  });

  test('km/h is carried in km/h; a slowing car reads 0 (never below) under 1 mph; an unknown speed stays "-"; Android never carries', () => {
    let now = 0;
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', paceMs: 1000 });
    d.start(state({ unit: 'km/h', speed: null }));
    now = 1000;
    d.update(state({ unit: 'km/h', speed: 80 }), { mps: 22.5, accel: 0, at: 1000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 81 }));

    set.mockClear();
    d.end();
    now = 2000;
    d.start(state({ speed: 5 }));
    now = 3000;
    // 3 mph and losing 4 mph a second
    const slowing = { mps: mph(3), accel: -mph(4), at: 3000 };
    d.update(state({ speed: 3 }), slowing);
    now = 4000;
    d.update(state({ speed: 3 }), slowing);
    expect(speeds(set)).toEqual([5, 3, 0]);
    now = 5000;
    d.update(state({ speed: null }), { mps: mph(20), accel: 1, at: 5000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: null }));

    let at = 0;
    const sent: DriveDisplayState[] = [];
    const android = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => at, platform: 'android' });
    android.start(state());
    at = 5000;
    android.update(state({ speed: 30 }), { mps: mph(30), accel: mph(3), at: 4000 });
    // the host's own speed (carried, it would read 33)
    expect(sent.map((s) => s.speed)).toEqual([30]);
    at = 8000;
    android.update(state({ speed: 34 }), { mps: mph(30), accel: mph(3), at: 4000 });
    expect(sent.map((s) => s.speed)).toEqual([30, 34]);
  });

  test("the halo's re-reads between updates are walked through, so its number and the Live Activity's agree through the hysteresis", async () => {
    // A fix at 10 s reads 30.2 mph gaining 0.6 m/s²; its speed event lands 200 ms later and a row
    // 100 ms after that. The halo re-reads at 10.45 s (30.8: past the band, 31). The next fix reads
    // 30.6 with no acceleration: inside the band of 31 (the halo keeps 31), of 30 too.
    jest.useFakeTimers();
    try {
      jest.setSystemTime(9200);
      const { set, live } = sinks();
      const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => Date.now(), platform: 'ios', paceMs: 1000 });
      const cruise = { mps: mph(29.9), accel: 0, at: 9000 };
      const halo = await renderHook((shown: ShownSpeed) => useCarriedSpeed(shown, 'mi'), { initialProps: cruise });
      d.start(state({ speed: 30 }));
      d.update(state({ speed: 30 }), cruise);
      expect(halo.result.current).toBe(30);
      expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 30 }));

      const pulling = { mps: mph(30.2), accel: 0.6, at: 10_000 };
      const step = async (ms: number) => act(() => void jest.advanceTimersByTime(ms));
      await step(1000);
      await halo.rerender(pulling);
      d.update(state({ speed: 30 }), pulling);
      await step(100);
      d.update(state({ speed: 30 }), pulling);
      await step(900);
      const level = { mps: mph(30.6), accel: 0, at: 11_000 };
      await halo.rerender(level);
      d.update(state({ speed: 31 }), level);
      await step(100);
      d.update(state({ speed: 31 }), level);
      await step(1000);
      d.update(state({ speed: 31 }), level);
      expect(halo.result.current).toBe(31);
      expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 31 }));
      // read only at the update instants (10.2, 10.3, 11.2 s), the same carries would leave it on 30
      expect(speeds(set)).toEqual([30, 31]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('RoadWise in front: nobody sees the Live Activity, so it takes only the minute keepalive; going behind sends the newest state at once', () => {
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later });
    d.setFront!(true);
    d.start(state({ speed: null, limit: null }));
    expect(live.start).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    // in front: no first-speed or first-limit bypass, no paced changes, no re-send of the start, nothing held
    for (let i = 1; i <= 30; i += 1) {
      now = i * 1000;
      d.update(state({ speed: 30 + i, limit: 35 }), { mps: mph(30 + i), accel: 0, at: now });
      now += 400;
      d.update(state({ speed: 30 + i, limit: 35, speedTint: '#E0884F' }));
    }
    d.refresh!(state({ speed: 60, limit: 35, notDrivingAvailable: true }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(clock.armed()).toEqual([]);
    // the keepalive, so the stale date never runs out while RoadWise is in front
    now = 60_000;
    d.update(state({ speed: 61, limit: 35 }), { mps: mph(61), accel: 0, at: now });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 61, limit: 35 }));
    now = 60_500;
    d.update(state({ speed: 62, limit: 35, notDrivingAvailable: true }), { mps: mph(62), accel: 0, at: now });
    expect(set).toHaveBeenCalledTimes(2);
    // behind (the lock button, another app, the notification shade): the newest goes at once,
    // inside the 5 s, with the halo's number
    now = 60_700;
    d.setFront!(false);
    expect(set).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 62, limit: 35, notDrivingAvailable: true }));
    // behind, at the pace again
    now = 61_000;
    d.update(state({ speed: 63, limit: 35, notDrivingAvailable: true }), { mps: mph(63), accel: 0, at: now });
    expect(set).toHaveBeenCalledTimes(3);
    expect(clock.armed()).toEqual([4700]);
    now = 65_700;
    clock.run();
    expect(speeds(set)).toEqual([null, 61, 62, 63]);
    // telling it the same twice changes nothing; going behind with nothing new sends nothing
    d.setFront!(false);
    expect(set).toHaveBeenCalledTimes(4);
    d.setFront!(true);
    d.setFront!(false);
    expect(set).toHaveBeenCalledTimes(4);
    // back in front, a change held for its 5 s is dropped (it waits for going behind)
    now = 66_000;
    d.update(state({ speed: 64, limit: 35, notDrivingAvailable: true }), { mps: mph(64), accel: 0, at: now });
    expect(clock.armed()).toEqual([4700]);
    d.setFront!(true);
    expect(clock.armed()).toEqual([]);
    now = 67_000;
    d.end();
    // after the end nothing waits to go out
    d.setFront!(false);
    expect(set).toHaveBeenCalledTimes(4);
    expect(live.end).toHaveBeenCalledTimes(1);
  });

  test('behind, the tint alone waits until 15 s after the last update; a new number brings the send forward to 5 s; the limit, the hint and a speed becoming known or unknown keep the second; a change that reverts is dropped', () => {
    expect(LIVE_TINT_ONLY_MS).toBe(15_000);
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later });
    const at = (over: Partial<DriveDisplayState> = {}) => state({ speed: 65, limit: 65, ...over });
    d.start(at());
    // the tint coming on under the same number: held until 15 s after the last update
    now = 1000;
    d.update(at({ speedTint: '#F1E9D2' }));
    expect(clock.armed()).toEqual([14_000]);
    // shifting on, the same; the newest tint goes
    now = 2000;
    d.update(at({ speedTint: '#E9D9A8' }));
    expect(clock.armed()).toEqual([14_000]);
    expect(set).toHaveBeenCalledTimes(1);
    now = 15_000;
    clock.run();
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 65, speedTint: '#E9D9A8' }));
    // a new number while a tint waits brings the send forward to 5 s after the last update
    now = 16_000;
    d.update(at({ speedTint: '#E0884F' }));
    expect(clock.armed()).toEqual([14_000]);
    now = 17_000;
    d.update(at({ speed: 66, speedTint: '#E0884F' }));
    expect(clock.armed()).toEqual([3000]);
    now = 20_000;
    clock.run();
    expect(set).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 66, speedTint: '#E0884F' }));
    // the number back where it was, with only the tint left to show: the tint's 15 s
    now = 21_000;
    d.update(at({ speed: 67, speedTint: '#D9734A' }));
    expect(clock.armed()).toEqual([4000]);
    now = 22_000;
    d.update(at({ speed: 66, speedTint: '#D9734A' }));
    now = 25_000;
    clock.run();
    expect(set).toHaveBeenCalledTimes(3);
    expect(clock.armed()).toEqual([10_000]);
    now = 35_000;
    clock.run();
    expect(set).toHaveBeenCalledTimes(4);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 66, speedTint: '#D9734A' }));
    // the speeding flag under the same number is paced like a number, not like the tint
    const over = { speed: 66, speedTint: '#D9734A', speeding: true };
    now = 36_000;
    d.update(at(over));
    expect(clock.armed()).toEqual([4000]);
    // the limit goes out a second after the last update, and what waited goes with it
    now = 36_500;
    d.update(at({ ...over, limit: 55 }));
    expect(set).toHaveBeenCalledTimes(5);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 55, speeding: true }));
    expect(clock.armed()).toEqual([]);
    // inside that second it is held to the second's end, and a new number goes with it
    now = 37_000;
    d.update(at({ ...over, limit: 45 }));
    expect(clock.armed()).toEqual([500]);
    now = 37_200;
    d.update(at({ ...over, limit: 45, speed: 68 }));
    expect(clock.armed()).toEqual([500]);
    now = 37_500;
    clock.run();
    expect(set).toHaveBeenCalledTimes(6);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 68, limit: 45 }));
    // the hint keeps the second
    now = 38_000;
    d.update(at({ ...over, limit: 45, speed: 68, notDrivingAvailable: true }));
    expect(clock.armed()).toEqual([500]);
    now = 38_500;
    clock.run();
    expect(set).toHaveBeenCalledTimes(7);
    // and so does the speed becoming unknown, or known again
    now = 39_000;
    d.update(at({ limit: 45, speed: null, notDrivingAvailable: true }));
    expect(clock.armed()).toEqual([500]);
    now = 39_500;
    clock.run();
    now = 40_000;
    const cruise = at({ limit: 45, speed: 60, notDrivingAvailable: true });
    d.update(cruise);
    expect(clock.armed()).toEqual([500]);
    now = 40_500;
    clock.run();
    expect(speeds(set)).toEqual([65, 65, 66, 66, 66, 68, 68, null, 60]);
    // a number that comes back, and a tint that does, never go out
    now = 41_000;
    d.update({ ...cruise, speed: 61 });
    expect(clock.armed()).toEqual([4500]);
    now = 42_000;
    d.update(cruise);
    expect(clock.armed()).toEqual([]);
    now = 43_000;
    d.update({ ...cruise, speedTint: '#F1E9D2' });
    expect(clock.armed()).toEqual([12_500]);
    now = 44_000;
    d.update(cruise);
    expect(clock.armed()).toEqual([]);
    expect(set).toHaveBeenCalledTimes(9);
  });

  /** An update every half second (the rows and the fixes) until `to`. */
  const drive = (d: DriveDisplay, clock: ReturnType<typeof ticking>, s: DriveDisplayState, to: number): void => {
    for (let t = clock.now() + 500; t <= to; t += 500) {
      clock.to(t);
      d.update(s);
    }
  };

  test('a changed state that went out is sent once more 10 s later if nothing changed since, then every 60 s; Android only every 60 s', () => {
    expect(LIVE_CONFIRM_MS).toBe(10_000);
    const clock = ticking();
    const at: number[] = [];
    const d = createDriveDisplay({ setDriveDisplay: () => void at.push(clock.now()) }, { now: clock.now, platform: 'ios', later: clock.later });
    d.start(state());
    drive(d, clock, state(), 200_000);
    expect(at).toEqual([0, 10_000, 70_000, 130_000, 190_000]);
    // a change that another follows inside its 10 s is not sent again; the newer one is
    clock.to(201_000);
    d.update(state({ limit: 40 }));
    clock.to(205_000);
    d.update(state({ limit: 45 }));
    drive(d, clock, state({ limit: 45 }), 276_000);
    expect(at.slice(5)).toEqual([201_000, 205_000, 215_000, 275_000]);
    // a number held for its 5 s is sent again 10 s after it went out
    clock.to(277_000);
    d.update(state({ limit: 45, speed: 31 }));
    drive(d, clock, state({ limit: 45, speed: 31 }), 349_500);
    expect(at.slice(9)).toEqual([280_000, 290_000]);
    drive(d, clock, state({ limit: 45, speed: 31 }), 350_000);
    expect(at.slice(9)).toEqual([280_000, 290_000, 350_000]);

    // going behind: its send is a change, sent again 10 s later
    const fc = ticking();
    const fAt: number[] = [];
    const f = createDriveDisplay({ setDriveDisplay: () => void fAt.push(fc.now()) }, { now: fc.now, platform: 'ios', later: fc.later });
    f.setFront!(true);
    f.start(state());
    drive(f, fc, state({ speed: 40 }), 30_000);
    fc.to(30_200);
    f.setFront!(false);
    drive(f, fc, state({ speed: 40 }), 101_000);
    expect(fAt).toEqual([0, 30_200, 40_200, 100_200]);

    const ac = ticking();
    const aAt: number[] = [];
    const a = createDriveDisplay({ setDriveDisplay: () => void aAt.push(ac.now()) }, { now: ac.now, platform: 'android', later: ac.later });
    a.start(state());
    drive(a, ac, state(), 200_000);
    expect(aAt).toEqual([0, 60_000, 120_000, 180_000]);
  });

  test('a change the Live Activity cannot show (the stopped flag, the points) sends nothing on iOS; Android still takes it', () => {
    let now = 0;
    const clock = manual();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', later: clock.later });
    d.start(state({ speed: 0 }));
    now = 4000;
    d.update(state({ speed: 0, stopped: true }));
    // nothing waits to go out either
    expect(clock.armed()).toEqual([]);
    now = 5000;
    d.update(state({ speed: 0, stopped: true, points: 11, pointsDelta: 1 }));
    expect(clock.armed()).toEqual([]);
    // a refresh and going behind with only those to show send nothing
    d.refresh!(state({ speed: 0, stopped: true, points: 12, pointsDelta: 1 }));
    d.setFront!(true);
    d.setFront!(false);
    expect(set).toHaveBeenCalledTimes(1);
    expect(clock.armed()).toEqual([]);
    // both still go out, as they are, with the next state that shows something new
    now = 6000;
    d.update(state({ speed: 3, stopped: true, points: 12, pointsDelta: 1 }));
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 3, stopped: true, points: 12, pointsDelta: 1 }));

    const sent: DriveDisplayState[] = [];
    const a = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => now, platform: 'android' });
    now = 0;
    a.start(state({ speed: 0 }));
    now = 3000;
    a.update(state({ speed: 0, stopped: true }));
    expect(sent.map((s) => s.stopped)).toEqual([false, true]);
    now = 6000;
    a.update(state({ speed: 0, stopped: true, points: 12, pointsDelta: 1 }));
    expect(sent.map((s) => s.points)).toEqual([null, null, 12]);
  });

  // Ten minutes of each, in a 35 mph limit, an update at every fix and every row (two a second).
  const LIMIT = 35;
  const drives: [string, (t: number) => number][] = [
    [
      'city stop-and-go',
      (t) => {
        const p = t % 75;
        if (p < 12) return (p / 12) * LIMIT;
        if (p < 40) return LIMIT + 1.2 * Math.sin(p);
        if (p < 50) return LIMIT * (1 - (p - 40) / 10);
        return 0;
      },
    ],
    ['cruising on the limit', (t) => LIMIT + 0.6 * Math.sin(2.1 * t)],
    ['a little over the limit', (t) => LIMIT + 3 + 0.4 * Math.sin(1.3 * t)],
    [
      'a slow ramp up and down',
      (t) => {
        const p = t % 120;
        return p < 60 ? 30 + p * 0.5 : 60 - (p - 60) * 0.5;
      },
    ],
  ];

  test.each(drives)('%s: never two speed sends inside 5 s, never more than 12 sends in a minute, and the number never 3 mph off for longer than 5 s', (_name, mphAt) => {
    const clock = ticking();
    const sends: { t: number; s: DriveDisplayState }[] = [];
    const d = createDriveDisplay({ setDriveDisplay: (s) => void sends.push({ t: clock.now(), s }) }, { now: clock.now, platform: 'ios', later: clock.later });
    const at = (t: number): DriveDisplayState => {
      const v = Math.max(0, mphAt(t));
      // the tint shifts with every quarter mph over the limit, as the halo's does
      const tint = v > LIMIT ? `#E0${(0x40 + Math.min(63, Math.round((v - LIMIT) * 4))).toString(16)}4F` : null;
      return state({ speed: Math.round(v), limit: LIMIT, speedTint: tint, speeding: v > LIMIT + 5, stopped: v <= 5 });
    };
    d.start(at(0));
    let offSince: number | null = null;
    let longestOff = 0;
    for (let k = 0; k < 600; k += 1) {
      for (const ms of [250, 850]) {
        clock.to(k * 1000 + ms);
        const s = at(k + ms / 1000);
        d.update(s);
        const off = Math.abs((sends.at(-1)!.s.speed ?? 0) - (s.speed ?? 0)) >= 3;
        if (off && offSince === null) offSince = clock.now();
        if (!off) offSince = null;
        if (offSince !== null) longestOff = Math.max(longestOff, clock.now() - offSince);
      }
    }
    for (let i = 1; i < sends.length; i += 1) {
      const p = sends[i - 1]!;
      const c = sends[i]!;
      const gap = c.t - p.t;
      const number = c.s.speed !== p.s.speed || c.s.speeding !== p.s.speeding;
      const tint = c.s.speedTint !== p.s.speedTint;
      // a new number or the speeding flag; the tint alone; nothing new (the re-send, the keepalive)
      expect(gap).toBeGreaterThanOrEqual(number ? LIVE_PACE_MS : tint ? LIVE_TINT_ONLY_MS : LIVE_CONFIRM_MS);
    }
    const busiest = Math.max(...sends.map((a) => sends.filter((b) => b.t >= a.t && b.t - a.t < 60_000).length));
    expect(busiest).toBeLessThanOrEqual(12);
    expect(longestOff).toBeLessThanOrEqual(LIVE_PACE_MS);
    // at least the minute keepalive
    expect(sends.length).toBeGreaterThanOrEqual(10);
  });

  test('Android ignores whether RoadWise is in front (its notification shows in the shade)', () => {
    let now = 0;
    const sent: DriveDisplayState[] = [];
    const a = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: () => now, platform: 'android' });
    a.setFront!(true);
    a.start(state());
    now = 3000;
    a.update(state({ speed: 31 }));
    expect(sent.map((s) => s.speed)).toEqual([30, 31]);
    a.setFront!(false);
    expect(sent).toHaveLength(2);
  });

  test('the end and the next start forget the carried number', () => {
    let now = 0;
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios', paceMs: 1000 });
    d.start(state());
    now = 1000;
    d.update(state({ speed: 30 }), { mps: mph(30.6), accel: 0, at: 1000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 31 }));
    d.end();
    d.start(state({ speed: 50 }));
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 50 }));
    // no carry kept: a refresh without one shows the host's speed
    d.refresh!(state({ speed: 44 }));
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 44 }));
    now = 2000;
    // no hysteresis kept either: 30.4 mph reads 30 (with 31 still remembered, it would hold 31)
    d.update(state({ speed: 30 }), { mps: mph(30.4), accel: 0, at: 2000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 30 }));
  });
});
