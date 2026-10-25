import { act, renderHook } from '@testing-library/react-native';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { createDriveDisplay, DISPLAY_KEEPALIVE_MS, DISPLAY_MIN_INTERVAL_MS, LIVE_MIN_INTERVAL_MS, toLive, type DriveDisplayState } from '@/drive/display';
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
  now = 4500;
  d.update(state({ notDrivingAvailable: false, weatherKind: 'dense_fog', weatherText: 'Dense fog', speedTint: '#FFCC00' }));
  expect(set).toHaveBeenCalledTimes(4);
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

describe('iOS: the Live Activity about once a second, with the halo’s number', () => {
  test('a change goes out about 1 s after the last (a row or fix a few ms early included) and no timer ever runs; Android keeps its 3 s', () => {
    expect(LIVE_MIN_INTERVAL_MS).toBe(900);
    expect(DISPLAY_MIN_INTERVAL_MS).toBe(3000);
    jest.useFakeTimers();
    try {
      let now = 0;
      const { set, live } = sinks();
      const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
      d.start(state());
      now = 200;
      d.update(state({ speed: 31 }));
      now = 600;
      d.update(state({ speed: 32 }));
      // inside the second: dropped, and nothing is scheduled to send them later
      expect(set).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      now = 995;
      d.update(state({ speed: 33 }));
      // the next row or fix on the one-second beat sends the newest state, even a few ms early
      expect(set).toHaveBeenCalledTimes(2);
      expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 33 }));
      now = 1850;
      d.update(state({ speed: 34 }));
      expect(set).toHaveBeenCalledTimes(2);
      now = 2400;
      d.update(state({ speed: 35 }), { mps: mph(35), accel: mph(3), at: 2400 });
      expect(speeds(set)).toEqual([30, 33, 35]);
      // a carried number is not re-read between updates either
      jest.advanceTimersByTime(5000);
      expect(set).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("with the halo's speed, each update shows the halo's number at that moment: carried along its acceleration, with its hysteresis", () => {
    let now = 0;
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
    d.start(state({ speed: 28 }));
    // a fix at t = 900 ms: 30 mph and gaining 2 mph a second; the host rounds 30
    const fix = { mps: mph(30), accel: mph(2), at: 900 };
    now = 1000;
    d.update(state({ speed: 30 }), fix);
    now = 2000;
    // 32.2 mph, 1.1 s on
    d.update(state({ speed: 30 }), fix);
    now = 2600;
    // 33.4 mph: inside the second, dropped
    d.update(state({ speed: 30 }), fix);
    now = 3000;
    // held at 1.5 s of carry: 33
    d.update(state({ speed: 30 }), fix);
    expect(speeds(set)).toEqual([28, 30, 32, 33]);
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
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
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
      const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => Date.now(), platform: 'ios' });
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

  test('the end and the next start forget the carried number', () => {
    let now = 0;
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
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
