import { createDriveDisplay, DISPLAY_KEEPALIVE_MS, DISPLAY_MIN_INTERVAL_MS, type DriveDisplayState } from '@/drive/display';

const state = (over: Partial<DriveDisplayState> = {}): DriveDisplayState => ({ speed: 30, limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: false, ...over });

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
