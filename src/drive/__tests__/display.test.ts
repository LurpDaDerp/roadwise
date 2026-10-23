import { MPS_PER_MPH } from '@/core/detectors/common';
import { CARRY_MAX_MS, SPEED_TICK_MS } from '@/core/engine/displaySpeed';
import { createDriveDisplay, DISPLAY_KEEPALIVE_MS, DISPLAY_MIN_INTERVAL_MS, LIVE_MIN_INTERVAL_MS, toLive, type DriveDisplayState } from '@/drive/display';
import { displayLook, setDisplayLook, type DisplayLook } from '@/drive/displayLook';

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

/** A manual clock and interval for the iOS ticks. */
function clock() {
  let now = 0;
  const ticks: { ms: number; fn: () => void }[] = [];
  const every = jest.fn((ms: number, fn: () => void) => {
    const t = { ms, fn };
    ticks.push(t);
    return () => {
      ticks.splice(ticks.indexOf(t), 1);
    };
  });
  return {
    every,
    now: () => now,
    running: () => ticks.length,
    /** Moves the clock on by whole ticks, running each tick as it falls due. */
    advance(ms: number) {
      for (let left = ms; left > 0; left -= SPEED_TICK_MS) {
        now += Math.min(SPEED_TICK_MS, left);
        for (const t of [...ticks]) t.fn();
      }
    },
    set(t: number) {
      now = t;
    },
  };
}

const mph = (n: number) => n * MPS_PER_MPH;

describe('iOS: the Live Activity at the halo’s pace', () => {
  test('a change goes out 200 ms after the last (5 a second at most); Android keeps its 3 s', () => {
    expect(LIVE_MIN_INTERVAL_MS).toBe(200);
    const c = clock();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: c.now, platform: 'ios', every: c.every });
    d.start(state());
    c.set(200);
    d.update(state({ speed: 31 }));
    c.set(400);
    d.update(state({ speed: 32 }));
    expect(set).toHaveBeenCalledTimes(3);
    c.set(500);
    d.update(state({ speed: 33 }));
    // inside the 200 ms: it waits, and a tick sends it once due
    expect(set).toHaveBeenCalledTimes(3);
    expect(c.running()).toBe(1);
    c.advance(SPEED_TICK_MS);
    expect(set).toHaveBeenCalledTimes(4);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 33 }));
    // nothing moves and nothing waits: the ticks stop
    expect(c.running()).toBe(0);
  });

  test("with the halo's speed the number is the halo's: carried on along its acceleration, 4 a second, with its hysteresis, for at most 1.5 s after the fix", () => {
    const c = clock();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: c.now, platform: 'ios', every: c.every });
    d.start(state({ speed: 30 }));
    c.set(1000);
    // a fix at t = 900 ms: 30 mph and gaining 2 mph a second (0.894 m/s²); the host rounds 30
    d.update(state({ speed: 30 }), { mps: mph(30), accel: mph(2), at: 900 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 30 }));
    expect(c.running()).toBe(1);
    const shown: number[] = [];
    set.mockImplementation(async (...args: unknown[]) => {
      shown.push((args[0] as DriveDisplayState).speed!);
    });
    c.advance(1500);
    // 30.6 mph at 1.25 s … 33 at 2.4 s, held there (1.5 s of carry): each whole number once, 0.8 past the last
    expect(shown).toEqual([31, 32, 33]);
    expect(c.running()).toBe(0);
    expect(c.now() - 900).toBeGreaterThanOrEqual(CARRY_MAX_MS);
  });

  test('a slowing car is carried down too, and 0 (never below) once under 1 mph; a cruise sends nothing between fixes', () => {
    const c = clock();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: c.now, platform: 'ios', every: c.every });
    d.start(state({ speed: 3 }));
    c.set(1000);
    d.update(state({ speed: 3 }), { mps: mph(3), accel: -mph(4), at: 1000 });
    c.advance(CARRY_MAX_MS);
    expect(set.mock.calls.map((a) => (a as unknown as [DriveDisplayState])[0].speed)).toEqual([3, 2, 1, 0]);
    expect(c.running()).toBe(0);
    set.mockClear();
    c.set(5000);
    d.update(state({ speed: 40 }), { mps: mph(40), accel: 0, at: 4900 });
    expect(set).toHaveBeenCalledTimes(1);
    expect(c.running()).toBe(0);
  });

  test('km/h is carried in km/h; an unknown speed stays "-"; Android never carries or ticks', () => {
    const c = clock();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: c.now, platform: 'ios', every: c.every });
    d.start(state({ unit: 'km/h', speed: null }));
    c.set(1000);
    d.update(state({ unit: 'km/h', speed: 80 }), { mps: 22.5, accel: 0, at: 1000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 81 }));
    c.set(2000);
    d.update(state({ unit: 'km/h', speed: null }), { mps: 22.5, accel: 1, at: 2000 });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: null }));

    const a = clock();
    const sent: DriveDisplayState[] = [];
    const android = createDriveDisplay({ setDriveDisplay: (s) => void sent.push(s) }, { now: a.now, platform: 'android', every: a.every });
    android.start(state());
    a.set(5000);
    android.update(state({ speed: 30 }), { mps: mph(30), accel: mph(3), at: 5000 });
    a.set(5500);
    android.update(state({ speed: 34 }), { mps: mph(30), accel: mph(3), at: 5000 });
    // the host's own speed, at the 3 s pace (carried, it would read 32)
    expect(sent.map((s) => s.speed)).toEqual([30, 34]);
    expect(a.every).not.toHaveBeenCalled();
  });

  test('the end and the next start stop the ticks and forget the carried number', () => {
    const c = clock();
    const { set, live } = sinks();
    const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: c.now, platform: 'ios', every: c.every });
    d.start(state());
    c.set(1000);
    d.update(state({ speed: 30 }), { mps: mph(30), accel: mph(3), at: 1000 });
    expect(c.running()).toBe(1);
    d.end();
    expect(c.running()).toBe(0);
    d.start(state({ speed: 50 }));
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 50 }));
    expect(c.running()).toBe(0);
  });
});
