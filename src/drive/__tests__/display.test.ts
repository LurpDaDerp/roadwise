import { createDriveDisplay, DISPLAY_KEEPALIVE_MS, DISPLAY_MIN_INTERVAL_MS, toLive, type DriveDisplayState } from '@/drive/display';
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
  const d = createDriveDisplay({ setDriveDisplay: set, liveDrive: live }, { now: () => now, platform: 'ios' });
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
  // The next drive's start, then its own first speed.
  expect(set).toHaveBeenCalledTimes(5);
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
