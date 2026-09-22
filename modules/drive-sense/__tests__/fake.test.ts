/** @jest-environment node */
// The in-memory drive-sense the rest of the app tests against. It must behave like the native
// contract in README.md, or every host test built on it proves the wrong thing.
import trace from '../../../src/core/__fixtures__/traces/speeding-corrected.json';
import { parseTrace } from '../../../src/core/replay/trace';
import { createFakeDriveSense } from '../src/fake';
import { parseRow } from '../src/rowSchema';
import { VECTOR_BUILDERS } from '../scripts/scenarios';
import type { ExtractVector } from '../src/extract/vectors';
import { DRIVE_SENSE_METHODS, type FeatureRow } from '../src/types';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const rows = parseTrace(trace).rows;

test('replays speeding-corrected.json row for row through a row listener', () => {
  const fake = createFakeDriveSense();
  const got: FeatureRow[] = [];
  fake.addListener('row', (raw) => {
    const row = parseRow(raw);
    if (row) got.push(row);
  });
  fake.loadTrace(rows);
  fake.drain();
  expect(got).toEqual(rows);
  expect(fake.step()).toBe(false);
});

test('step emits one row at a time and tracks lastRowTs', async () => {
  const fake = createFakeDriveSense();
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

test('emitted rows are copies — a listener mutating one cannot change the trace', () => {
  const fake = createFakeDriveSense();
  fake.addListener('row', (r) => {
    (r as FeatureRow).speed = 999;
  });
  const input = rows.slice(0, 1);
  fake.loadTrace(input);
  fake.drain();
  expect(input[0]!.speed).toBe(rows[0]!.speed);
});

test('capture lifecycle and the calls log', async () => {
  let now = 1_700_000_000_000;
  const fake = createFakeDriveSense({ platform: 'android', now: () => now });
  await fake.arm();
  await fake.startCapture('mounted');
  let s = await fake.getState();
  expect(s).toMatchObject({
    armed: true,
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
  await fake.disarm();
  expect((await fake.getState()).armed).toBe(false);
  await fake.excludeFromBackup('file:///x');
  expect(fake.calls).toEqual([
    'arm',
    'startCapture:mounted',
    'getState',
    'startCapture:pocket',
    'setCaptureRate:low',
    'getState',
    'stopCapture',
    'setCaptureRate:full',
    'getState',
    'disarm',
    'getState',
    'excludeFromBackup:file:///x',
  ]);
});

test('every bridged method is implemented and logged', async () => {
  const fake = createFakeDriveSense();
  for (const m of DRIVE_SENSE_METHODS) expect(typeof fake[m]).toBe('function');
  await fake.getState();
  await fake.getScreenState();
  await fake.getThermalState();
  await fake.getLastExitInfo();
  await fake.isIgnoringBatteryOptimizations();
  await fake.queryMotionHistory(0, 1);
  await fake.requestMotionPermission();
  await fake.setNotificationState({ stationary: false, startedAt: null });
  await fake.selfTest('[]');
  expect(fake.calls).toEqual([
    'getState',
    'getScreenState',
    'getThermalState',
    'getLastExitInfo',
    'isIgnoringBatteryOptimizations',
    'queryMotionHistory',
    'requestMotionPermission',
    'setNotificationState',
    'selfTest',
  ]);
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
  fake.setState({ location: 'always', motion: 'granted', captureWasOpen: true });
  const s = await fake.getState();
  expect(s).toMatchObject({ location: 'always', motion: 'granted', captureWasOpen: true });
  s.armed = true;
  expect((await fake.getState()).armed).toBe(false);
});

test('motion history is filtered to [from, to]', async () => {
  const fake = createFakeDriveSense();
  fake.setMotionHistory([
    { type: 'walking', confidence: 'high', ts: 100 },
    { type: 'automotive', confidence: 'medium', ts: 200 },
    { type: 'stationary', confidence: 'low', ts: 300 },
  ]);
  await expect(fake.queryMotionHistory(150, 300)).resolves.toEqual([
    { type: 'automotive', confidence: 'medium', ts: 200 },
    { type: 'stationary', confidence: 'low', ts: 300 },
  ]);
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

test('exit info and notification state are settable and observable', async () => {
  const fake = createFakeDriveSense({ platform: 'android' });
  await expect(fake.getLastExitInfo()).resolves.toBeNull();
  fake.setLastExitInfo({ ts: 5, reason: 'watchdog', whileCapturing: true });
  await expect(fake.getLastExitInfo()).resolves.toEqual({ ts: 5, reason: 'watchdog', whileCapturing: true });
  expect(fake.notificationState).toBeNull();
  await fake.setNotificationState({ stationary: true, startedAt: 10 });
  expect(fake.notificationState).toEqual({ stationary: true, startedAt: 10 });
});

describe('listeners and buffering (README §Buffering)', () => {
  test('listeners get their own event only, and remove() detaches', () => {
    const fake = createFakeDriveSense();
    const wakes = jest.fn();
    const acts = jest.fn();
    const sub = fake.addListener('wake', wakes);
    fake.addListener('activity', acts);
    expect(fake.listenerCount('wake')).toBe(1);
    fake.emit('wake', { reason: 'significantChange', ts: 1 });
    expect(wakes).toHaveBeenCalledWith({ reason: 'significantChange', ts: 1 });
    expect(acts).not.toHaveBeenCalled();
    sub.remove();
    sub.remove(); // idempotent
    expect(fake.listenerCount('wake')).toBe(0);
  });

  test('an event with no listener is buffered and delivered, in order, on a microtask after the first listener attaches', async () => {
    const fake = createFakeDriveSense();
    fake.emit('wake', { reason: 'activityTransition', ts: 1 });
    fake.emit('wake', { reason: 'boot', ts: 2 });
    const got: unknown[] = [];
    fake.addListener('wake', (p) => got.push(p));
    expect(got).toEqual([]); // not synchronously inside addListener
    await flush();
    expect(got).toEqual([
      { reason: 'activityTransition', ts: 1 },
      { reason: 'boot', ts: 2 },
    ]);
    // delivered once only
    fake.addListener('wake', (p) => got.push(p));
    await flush();
    expect(got).toHaveLength(2);
  });

  test('the buffer holds 300 events and drops the oldest row first', async () => {
    const fake = createFakeDriveSense();
    fake.emit('wake', { reason: 'boot', ts: 0 });
    fake.loadTrace(rows.slice(0, 150));
    fake.drain(); // 150 rows buffered (no row listener)
    for (let i = 0; i < 150; i++) fake.emit('activity', { type: 'automotive', confidence: 'high', ts: i });
    // 301 buffered: the oldest row goes
    const wakes: unknown[] = [];
    const got: unknown[] = [];
    const acts: unknown[] = [];
    fake.addListener('wake', (p) => wakes.push(p));
    fake.addListener('row', (p) => got.push(p));
    fake.addListener('activity', (p) => acts.push(p));
    await flush();
    expect(wakes).toHaveLength(1);
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
