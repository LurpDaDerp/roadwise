/** @jest-environment node */
// The in-memory drive-sense the rest of the app tests against. It must behave like the native
// contract in README.md, or every host test built on it proves the wrong thing.
import { createFakeDriveSense, driveSenseError } from '../src/fake';
import { parseRow } from '../src/rowSchema';
import { VECTOR_BUILDERS } from '../scripts/scenarios';
import type { ExtractVector } from '../src/extract/vectors';
import { DRIVE_SENSE_METHODS, isDriveSenseError, type FeatureRow } from '../src/types';
import { sampleRows } from '../scripts/sampleRows';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const rows = sampleRows(160);

/** A fake with the permissions a drive needs, already capturing. */
async function capturing(opts: Parameters<typeof createFakeDriveSense>[0] = {}) {
  const fake = createFakeDriveSense(opts);
  fake.setState({ location: 'whenInUse', motion: 'granted' });
  await fake.startCapture('mounted');
  return fake;
}

test('replays a trace row for row through a row listener', async () => {
  const fake = await capturing();
  const got: FeatureRow[] = [];
  fake.addListener('row', (raw) => {
    const row = parseRow(raw);
    if (row) got.push(row);
  });
  fake.loadTrace(rows);
  fake.drain();
  // Row for row, as the bridge keeps them (rounded to ROW_DECIMALS — ruling D2 concern 1).
  expect(got).toEqual(rows.map((r) => parseRow(r)));
  expect(fake.step()).toBe(false);
});

test('step emits one row at a time and tracks lastRowTs', async () => {
  const fake = await capturing();
  const seen: unknown[] = [];
  fake.addListener('row', (r) => seen.push(r));
  fake.loadTrace(rows.slice(0, 2));
  expect(fake.step()).toBe(true);
  expect(seen).toHaveLength(1);
  expect((await fake.getState()).lastRowTs).toBe(rows[0]!.ts);
  expect(fake.step()).toBe(true);
  expect(fake.step()).toBe(false);
  expect((await fake.getState()).lastRowTs).toBe(rows[1]!.ts);
});

test('emitted rows are copies — a listener mutating one cannot change the trace', async () => {
  const fake = await capturing();
  fake.addListener('row', (r) => {
    (r as FeatureRow).speed = 999;
  });
  const input = rows.slice(0, 1);
  fake.loadTrace(input);
  fake.drain();
  expect(input[0]!.speed).toBe(rows[0]!.speed);
});

describe('rows only while capturing (review I5)', () => {
  test('a host that never starts capture sees no rows', () => {
    const fake = createFakeDriveSense();
    const got = jest.fn();
    fake.addListener('row', got);
    fake.loadTrace(rows.slice(0, 3));
    expect(fake.step()).toBe(false);
    fake.drain();
    expect(got).not.toHaveBeenCalled();
    expect(fake.pendingRows()).toBe(3);
  });

  test('stopCapture mid-trace stops the rows; the rest stay queued', async () => {
    const fake = await capturing();
    const got = jest.fn();
    fake.addListener('row', got);
    fake.loadTrace(rows.slice(0, 5));
    fake.step();
    fake.step();
    await fake.stopCapture();
    fake.drain();
    expect(got).toHaveBeenCalledTimes(2);
    expect(fake.pendingRows()).toBe(3);
  });

  test('{ force: true } emits regardless, for tests of that edge', () => {
    const fake = createFakeDriveSense();
    const got = jest.fn();
    fake.addListener('row', got);
    fake.loadTrace(rows.slice(0, 2));
    fake.drain({ force: true });
    expect(got).toHaveBeenCalledTimes(2);
  });
});

describe('the activity feed during every capture (WK-m1; NC-W4)', () => {
  const walk = (ts: number, exit?: true) => ({ type: 'walking' as const, confidence: 'high' as const, ts, ...(exit ? { exit } : {}) });

  test('a capture subscribes: activity reaches JS while capturing, and stops with the capture', async () => {
    const fake = await capturing({ platform: 'android' });
    expect(fake.activitySubscribed).toBe(true);
    const got = jest.fn();
    fake.addListener('activity', got);
    expect(fake.transition(walk(1))).toBe(true);
    expect(fake.transition(walk(2, true))).toBe(true);
    expect(got.mock.calls.map((c) => c[0])).toEqual([walk(1), walk(2, true)]);
    await fake.stopCapture();
    expect(fake.activitySubscribed).toBe(false);
    expect(fake.transition(walk(3))).toBe(false);
    expect(got).toHaveBeenCalledTimes(2);
  });

  test('a throwing subscribe still captures: the start resolves and rows flow, without the feed', async () => {
    const fake = createFakeDriveSense({ platform: 'android' });
    fake.setState({ location: 'whenInUse', motion: 'granted' });
    fake.failCaptureSubscribe(true);
    await expect(fake.startCapture('mounted')).resolves.toBeUndefined();
    expect((await fake.getState()).capturing).toBe(true);
    expect(fake.activitySubscribed).toBe(false);
    const got = jest.fn();
    fake.addListener('row', got);
    fake.loadTrace(rows.slice(0, 2));
    fake.drain();
    expect(got).toHaveBeenCalledTimes(2);
    expect(fake.transition(walk(1))).toBe(false);
  });

  test('without motion access a capture does not subscribe; nothing is subscribed between captures', async () => {
    const fake = createFakeDriveSense({ platform: 'android' });
    fake.setState({ location: 'whenInUse', motion: 'denied' });
    await fake.startCapture('mounted');
    expect(fake.activitySubscribed).toBe(false);
    await fake.stopCapture();
    fake.setState({ motion: 'granted' });
    await fake.startCapture('mounted');
    expect(fake.activitySubscribed).toBe(true);
    await fake.stopCapture();
    expect(fake.activitySubscribed).toBe(false);
    expect(fake.transition(walk(1))).toBe(false);
  });
});

describe('a stale registration heals itself (C12 round 1, review-C12 m1; NC-C12-1)', () => {
  test('left behind by an abnormal end: its first transition, not capturing, removes it and delivers nothing', async () => {
    const fake = await capturing({ platform: 'android' });
    await fake.stopCapture();
    fake.strandSubscription();
    expect(fake.activitySubscribed).toBe(true);
    const got = jest.fn();
    fake.addListener('activity', got);
    expect(fake.transition({ type: 'walking', confidence: 'high', ts: 1 })).toBe(false);
    expect(fake.activitySubscribed).toBe(false);
    expect(got).not.toHaveBeenCalled();
  });
});

describe('errors and permissions (review I4, README §2 "Errors")', () => {
  const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code);

  test('startCapture needs some location permission (While Using is enough), not motion', async () => {
    const fake = createFakeDriveSense();
    await expect(codeOf(fake.startCapture('mounted'))).resolves.toBe('E_PERMISSION');
    expect((await fake.getState()).capturing).toBe(false);
    expect(fake.calls).toEqual(['startCapture:mounted']);
    fake.setState({ location: 'whenInUse', motion: 'denied' });
    await expect(fake.startCapture('mounted')).resolves.toBeUndefined();
    expect((await fake.getState()).capturing).toBe(true);
  });

  test('isDriveSenseError recognises the codes', async () => {
    const fake = createFakeDriveSense();
    const e = await fake.startCapture('mounted').catch((x: unknown) => x);
    expect(isDriveSenseError(e)).toBe(true);
    expect(isDriveSenseError(e, 'E_PERMISSION')).toBe(true);
    expect(isDriveSenseError(e, 'E_FGS_REFUSED')).toBe(false);
    expect(isDriveSenseError(new Error('x'))).toBe(false);
    expect(isDriveSenseError(driveSenseError('E_NOT_FOUND', 'x'), 'E_NOT_FOUND')).toBe(true);
  });

  test('selfTest rejects E_INVALID_INPUT on unparseable vectors', async () => {
    const fake = createFakeDriveSense();
    await expect(codeOf(fake.selfTest('not json'))).resolves.toBe('E_INVALID_INPUT');
  });
});

test('capture lifecycle and the calls log', async () => {
  let now = 1_700_000_000_000;
  const fake = createFakeDriveSense({ platform: 'android', now: () => now });
  fake.setState({ location: 'whenInUse', motion: 'granted' });
  await fake.startCapture('mounted');
  let s = await fake.getState();
  expect(s).toMatchObject({
    capturing: true,
    mode: 'mounted',
    rate: 'full',
    captureStartedAt: now,
    platform: 'android',
    lockSignal: 'reliable',
  });
  now += 5000;
  await fake.startCapture('pocket'); // the claim: mode changes, start time stays
  await fake.setCaptureRate('low');
  s = await fake.getState();
  expect(s).toMatchObject({ mode: 'pocket', rate: 'low', captureStartedAt: now - 5000 });
  await fake.stopCapture();
  await fake.setCaptureRate('full'); // ignored while not capturing
  s = await fake.getState();
  expect(s).toMatchObject({ capturing: false, mode: null, rate: null, captureStartedAt: null });
  await fake.excludeFromBackup('file:///x');
  // commands and queries are logged apart (review M6), so hosts can assert command order
  expect(fake.calls).toEqual([
    'startCapture:mounted',
    'startCapture:pocket',
    'setCaptureRate:low',
    'stopCapture',
    'setCaptureRate:full',
    'excludeFromBackup:file:///x',
  ]);
  expect(fake.queries).toEqual(['getState', 'getState', 'getState']);
});

test('every bridged method is implemented and logged', async () => {
  const fake = createFakeDriveSense();
  for (const m of DRIVE_SENSE_METHODS) expect(typeof fake[m]).toBe('function');
  await fake.getState();
  await fake.getScreenState();
  await fake.getThermalState();
  await fake.getLastExitInfo();
  await fake.isIgnoringBatteryOptimizations();
  await fake.requestMotionPermission();
  await fake.setDriveDisplay({ speed: null, limit: null, unit: 'mph', points: null, pointsDelta: null, stopped: true });
  await fake.selfTest('[]');
  expect(fake.queries).toEqual([
    'getState',
    'getScreenState',
    'getThermalState',
    'getLastExitInfo',
    'isIgnoringBatteryOptimizations',
  ]);
  expect(fake.calls).toEqual(['requestMotionPermission', 'setDriveDisplay', 'selfTest']);
});

test('platform defaults: iOS lagged lock signal and battery-optimisation true; Android reliable and false', async () => {
  const ios = createFakeDriveSense();
  expect((await ios.getState()).platform).toBe('ios');
  expect((await ios.getState()).lockSignal).toBe('lagged');
  await expect(ios.isIgnoringBatteryOptimizations()).resolves.toBe(true);
  const android = createFakeDriveSense({ platform: 'android' });
  expect((await android.getState()).lockSignal).toBe('reliable');
  await expect(android.isIgnoringBatteryOptimizations()).resolves.toBe(false);
  android.setIgnoringBatteryOptimizations(true);
  await expect(android.isIgnoringBatteryOptimizations()).resolves.toBe(true);
});

test('setState overrides, getState returns a copy', async () => {
  const fake = createFakeDriveSense();
  fake.setState({ location: 'whenInUse', motion: 'granted', captureWasOpen: true });
  const s = await fake.getState();
  expect(s).toMatchObject({ location: 'whenInUse', motion: 'granted', captureWasOpen: true });
  s.capturing = true;
  expect((await fake.getState()).capturing).toBe(false);
});

test('motion permission follows the state', async () => {
  const fake = createFakeDriveSense();
  await expect(fake.requestMotionPermission()).resolves.toBe('granted');
  expect((await fake.getState()).motion).toBe('granted');
  fake.setState({ motion: 'denied' });
  await expect(fake.requestMotionPermission()).resolves.toBe('denied');
  fake.setState({ motion: 'unavailable' });
  await expect(fake.requestMotionPermission()).resolves.toBe('unavailable');
});

test('screen and thermal events update what the getters report', async () => {
  const fake = createFakeDriveSense();
  await expect(fake.getScreenState()).resolves.toEqual({ locked: false, on: true });
  await expect(fake.getThermalState()).resolves.toBe('nominal');
  fake.emit('screen', { locked: true, on: false, ts: 1 });
  fake.emit('thermal', { level: 'serious', ts: 2 });
  await expect(fake.getScreenState()).resolves.toEqual({ locked: true, on: false });
  await expect(fake.getThermalState()).resolves.toBe('serious');
});

test('exit info is settable and observable', async () => {
  const fake = createFakeDriveSense({ platform: 'android' });
  await expect(fake.getLastExitInfo()).resolves.toBeNull();
  fake.setLastExitInfo({ ts: 5, reason: 'watchdog', whileCapturing: true });
  await expect(fake.getLastExitInfo()).resolves.toEqual({ ts: 5, reason: 'watchdog', whileCapturing: true });
});

describe('the background surface (plan §6)', () => {
  const display = { speed: 34, limit: 35, unit: 'mph', points: 1240, pointsDelta: 18, stopped: true } as const;

  test('setDriveDisplay is kept only while capturing and goes with the capture, like the notification', async () => {
    const fake = createFakeDriveSense({ platform: 'android' });
    expect(fake.driveDisplay).toBeNull();
    await fake.setDriveDisplay(display); // nothing to show on: ignored, resolves
    expect(fake.driveDisplay).toBeNull();
    fake.setState({ location: 'whenInUse' });
    await fake.startCapture('mounted');
    await fake.setDriveDisplay(display);
    expect(fake.driveDisplay).toEqual(display);
    await fake.stopCapture();
    expect(fake.driveDisplay).toBeNull();
  });

});

describe('listeners and buffering (README §Buffering)', () => {
  test('listeners get their own event only, and remove() detaches', () => {
    const fake = createFakeDriveSense();
    const calls = jest.fn();
    const acts = jest.fn();
    const sub = fake.addListener('call', calls);
    fake.addListener('activity', acts);
    expect(fake.listenerCount('call')).toBe(1);
    fake.emit('call', { active: true, ts: 1 });
    expect(calls).toHaveBeenCalledWith({ active: true, ts: 1 });
    expect(acts).not.toHaveBeenCalled();
    sub.remove();
    sub.remove(); // idempotent
    expect(fake.listenerCount('call')).toBe(0);
  });

  test('an event with no listener is buffered and delivered, in order, on a microtask after the first listener attaches', async () => {
    const fake = createFakeDriveSense();
    fake.emit('call', { active: true, ts: 1 });
    fake.emit('call', { active: false, ts: 2 });
    const got: unknown[] = [];
    fake.addListener('call', (p) => got.push(p));
    expect(got).toEqual([]); // not synchronously inside addListener
    await flush();
    expect(got).toEqual([
      { active: true, ts: 1 },
      { active: false, ts: 2 },
    ]);
    // delivered once only
    fake.addListener('call', (p) => got.push(p));
    await flush();
    expect(got).toHaveLength(2);
  });

  test('the buffer holds 300 events and drops the oldest row first', async () => {
    const fake = await capturing();
    fake.emit('call', { active: true, ts: 0 });
    fake.loadTrace(rows.slice(0, 150));
    fake.drain(); // 150 rows buffered (no row listener)
    for (let i = 0; i < 150; i++) fake.emit('activity', { type: 'automotive', confidence: 'high', ts: i });
    // 301 buffered: the oldest row goes
    const calls: unknown[] = [];
    const got: unknown[] = [];
    const acts: unknown[] = [];
    fake.addListener('call', (p) => calls.push(p));
    fake.addListener('row', (p) => got.push(p));
    fake.addListener('activity', (p) => acts.push(p));
    await flush();
    expect(calls).toHaveLength(1);
    expect(acts).toHaveLength(150);
    expect(got).toHaveLength(149);
    expect((got[0] as FeatureRow).ts).toBe(rows[1]!.ts);
  });

  test('with no rows buffered, the oldest event of any kind is dropped', async () => {
    const fake = createFakeDriveSense();
    for (let i = 0; i < 301; i++) fake.emit('activity', { type: 'automotive', confidence: 'high', ts: i });
    const acts: { ts: number }[] = [];
    fake.addListener('activity', (p) => acts.push(p));
    await flush();
    expect(acts).toHaveLength(300);
    expect(acts[0]!.ts).toBe(1);
  });

  test('asyncDelivery: listeners run on a microtask, after emit/step return — as on a device (review M4)', async () => {
    const fake = await capturing({ asyncDelivery: true });
    const order: string[] = [];
    fake.addListener('row', () => order.push('row'));
    fake.addListener('call', () => order.push('call'));
    fake.loadTrace(rows.slice(0, 1));
    fake.step();
    fake.emit('call', { active: true, ts: 1 });
    order.push('returned');
    await flush();
    expect(order).toEqual(['returned', 'row', 'call']);
    // lastRowTs is updated at emission, as native updates it when it emits
    expect((await fake.getState()).lastRowTs).toBe(rows[0]!.ts);
  });

  test('default delivery is synchronous', () => {
    const fake = createFakeDriveSense();
    const got = jest.fn();
    fake.addListener('screen', got);
    fake.emit('screen', { locked: false, on: true, ts: 1 });
    expect(got).toHaveBeenCalledTimes(1);
  });

  test('a listener removed during delivery does not break the others', () => {
    const fake = createFakeDriveSense();
    const b = jest.fn();
    const sub = fake.addListener('screen', () => sub.remove());
    fake.addListener('screen', b);
    fake.emit('screen', { locked: false, on: true, ts: 1 });
    expect(b).toHaveBeenCalledTimes(1);
  });
});

test('selfTest runs the TypeScript reference, so a fake diff is clean', async () => {
  const fake = createFakeDriveSense();
  const vector = VECTOR_BUILDERS['no-imu']() as ExtractVector;
  const out = JSON.parse(await fake.selfTest(JSON.stringify([vector])));
  expect(out.version).toBe(1);
  expect(out.platform).toBe('reference');
  expect(out.results).toEqual([{ name: 'no-imu', kind: 'extract', rows: vector.expected.rows }]);
});

describe('the forgot-to-start reminder (README "Forgot-to-start reminder")', () => {
  test('off by default; on and off through the switch, logged; the status follows the phone', async () => {
    let now = 1_700_000_000_000;
    const fake = createFakeDriveSense({ platform: 'ios', now: () => now });
    await expect(fake.getTripReminderStatus()).resolves.toEqual({ enabled: false, state: 'off', missing: [] });
    fake.setTripReminderEnv({ missing: ['locationAlways'] });
    await expect(fake.setTripReminder(true)).resolves.toMatchObject({ enabled: true, state: 'needs', missing: ['locationAlways'] });
    expect(fake.tripReminderOn).toBe(true);
    fake.setTripReminderEnv({ missing: [] });
    now += 1000;
    await expect(fake.getTripReminderStatus()).resolves.toMatchObject({ state: 'on' });
    await expect(fake.setTripReminder(false)).resolves.toMatchObject({ enabled: false, state: 'off' });
    fake.setTripReminderEnv({ available: false });
    await expect(fake.getTripReminderStatus()).resolves.toMatchObject({ state: 'unavailable' });
    expect(fake.calls).toEqual(['setTripReminder:true', 'setTripReminder:false']);
    expect(fake.queries).toEqual(['getTripReminderStatus', 'getTripReminderStatus', 'getTripReminderStatus']);
  });

  test('the location answer: iOS always by default, Android notNeeded; settable', async () => {
    await expect(createFakeDriveSense({ platform: 'ios' }).requestReminderLocation()).resolves.toBe('always');
    const android = createFakeDriveSense({ platform: 'android' });
    await expect(android.requestReminderLocation()).resolves.toBe('notNeeded');
    android.setTripReminderEnv({ location: 'whenInUse' });
    await expect(android.requestReminderLocation()).resolves.toBe('whenInUse');
    expect(android.calls).toEqual(['requestReminderLocation', 'requestReminderLocation']);
  });
});
