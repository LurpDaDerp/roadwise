// The in-memory DmsVision follows the README's native contract where host tests depend on it:
// it rejects what native rejects, emits frames only while running, stops on backgrounding, obeys
// the thermal floor with its dwells, and runs the heartbeat watchdog and the model-release timer.
import {
  MODEL_RELEASE_AFTER_PAUSE_MS,
  THERMAL_COOL_DWELL_MS,
  THERMAL_L1_ENTRY_DWELL_MS,
  WATCHDOG_PAUSE_MS,
  WATCHDOG_STOP_MS,
} from '../src/constants';
import { createFakeDmsVision } from '../src/fake';
import type { CapturePolicy, StartOptions, StateEvent } from '../src/types';
import { decodeFrameBatch, faceAbsentRecord } from '../src/wire';

const START: StartOptions = {
  gateToken: 'tok',
  fps: 15,
  gazeNet: true,
  gazeNetEvery: 1,
  delegate: 'cpu',
  rotationOffsetDegrees: 0,
};
const RUN: CapturePolicy = {
  gateToken: 'tok',
  capture: 'run',
  fps: 15,
  gazeNet: true,
  gazeNetEvery: 1,
  setupMode: false,
  previewAllowed: false,
};
const rec = (t: number) => faceAbsentRecord(t, 40, 90, 10, 12);

function setup(opts: Parameters<typeof createFakeDmsVision>[0] = {}) {
  const fake = createFakeDmsVision(opts);
  const states: StateEvent[] = [];
  const frames: unknown[] = [];
  fake.addListener('state', (s) => states.push(s));
  fake.addListener('frames', (f) => frames.push(f));
  return { fake, states, frames };
}

describe('start is refused exactly where native refuses it', () => {
  test('bad arguments → E_BAD_ARGS', async () => {
    const { fake } = setup();
    await expect(fake.start({ ...START, fps: 12 as 15 })).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
    await expect(fake.start({ ...START, gateToken: '' })).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
  });
  test('no permission → E_PERMISSION', async () => {
    const { fake } = setup({ permission: 'denied' });
    await expect(fake.start(START)).rejects.toMatchObject({ code: 'E_PERMISSION' });
    expect(fake.nativeState()).toBe('stopped');
  });
  test('not in the foreground → E_NOT_FOREGROUND', async () => {
    const { fake } = setup();
    fake.setForeground(false);
    await expect(fake.start(START)).rejects.toMatchObject({ code: 'E_NOT_FOREGROUND' });
  });
  test('failNext injects a native failure once', async () => {
    const { fake } = setup();
    fake.failNext('start', 'E_CAMERA');
    await expect(fake.start(START)).rejects.toMatchObject({ code: 'E_CAMERA' });
    await expect(fake.start(START)).resolves.toBeUndefined();
  });
  test('while running, a different token is refused and the same one is idempotent', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    await fake.start(START);
    await expect(fake.start({ ...START, gateToken: 'other' })).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
    expect(states).toEqual([
      { state: 'starting', reason: 'user' },
      { state: 'running', reason: 'user' },
    ]);
  });
});

describe('setPolicy and the gate token', () => {
  test('refused while stopped (E_STATE) and with a mismatched token (E_BAD_ARGS)', async () => {
    const { fake } = setup();
    await expect(fake.setPolicy(RUN)).rejects.toMatchObject({ code: 'E_STATE' });
    await fake.start(START);
    await expect(fake.setPolicy({ ...RUN, gateToken: 'nope' })).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
  });
  test('pause and run', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    await fake.setPolicy({ ...RUN, capture: 'pause' });
    expect(fake.nativeState()).toBe('paused');
    await fake.setPolicy(RUN);
    expect(fake.nativeState()).toBe('running');
    expect(states.slice(2)).toEqual([
      { state: 'paused', reason: 'policy' },
      { state: 'running', reason: 'policy' },
    ]);
  });
  test('stop clears the token', async () => {
    const { fake } = setup();
    await fake.start(START);
    await fake.stop();
    await expect(fake.setPolicy(RUN)).rejects.toMatchObject({ code: 'E_STATE' });
    await fake.stop(); // idempotent
  });
});

describe('frames flow only while running', () => {
  test('nothing before start, nothing while paused, nothing after stop', async () => {
    const { fake, frames } = setup();
    expect(fake.pushRecords([rec(1)])).toBe(false);
    await fake.start(START);
    expect(fake.pushRecords([rec(2), rec(3)])).toBe(true);
    await fake.setPolicy({ ...RUN, capture: 'pause' });
    expect(fake.pushRecords([rec(4)])).toBe(false);
    await fake.setPolicy(RUN);
    await fake.stop();
    expect(fake.pushRecords([rec(5)])).toBe(false);
    expect(frames).toHaveLength(1);
    const out = decodeFrameBatch(frames[0]);
    expect(out.batch!.frames.map((f) => f.tMs)).toEqual([2, 3]);
  });
});

describe('native owners: background, watchdog, release', () => {
  test('backgrounding stops the session and clears the token', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    fake.setForeground(false);
    expect(states.at(-1)).toEqual({ state: 'stopped', reason: 'background' });
    fake.setForeground(true);
    await expect(fake.setPolicy(RUN)).rejects.toMatchObject({ code: 'E_STATE' });
  });

  test('no heartbeat for 10 s → paused (watchdog); 60 s more → stopped (watchdog)', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    fake.advance(WATCHDOG_PAUSE_MS - 1);
    expect(fake.nativeState()).toBe('running');
    fake.advance(1);
    expect(states.at(-1)).toEqual({ state: 'paused', reason: 'watchdog' });
    fake.advance(WATCHDOG_STOP_MS - 1);
    expect(fake.nativeState()).toBe('paused');
    fake.advance(1);
    expect(states.at(-1)).toEqual({ state: 'stopped', reason: 'watchdog' });
  });

  test('a heartbeat resets the watchdog, and a run policy resumes after a watchdog pause', async () => {
    const { fake } = setup();
    await fake.start(START);
    fake.advance(WATCHDOG_PAUSE_MS - 1);
    await fake.setPolicy(RUN);
    fake.advance(WATCHDOG_PAUSE_MS - 1);
    expect(fake.nativeState()).toBe('running');
    fake.advance(1);
    expect(fake.nativeState()).toBe('paused');
    await fake.setPolicy(RUN);
    expect(fake.nativeState()).toBe('running');
  });

  test('a policy pause releases the models after 5 min (stopped, released)', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    await fake.setPolicy({ ...RUN, capture: 'pause' });
    // keep the heartbeat alive while paused
    for (let t = 0; t < MODEL_RELEASE_AFTER_PAUSE_MS - 5000; t += 5000) {
      fake.advance(5000);
      await fake.setPolicy({ ...RUN, capture: 'pause' });
    }
    expect(fake.nativeState()).toBe('paused');
    fake.advance(5000);
    expect(states.at(-1)).toEqual({ state: 'stopped', reason: 'released' });
  });
});

describe('the thermal floor', () => {
  test('critical pauses at once; a run policy cannot resume it while critical', async () => {
    const { fake, states } = setup();
    await fake.start(START);
    fake.setThermal('critical');
    expect(states.at(-1)).toEqual({ state: 'paused', reason: 'thermal' });
    await fake.setPolicy(RUN);
    expect(fake.nativeState()).toBe('paused');
  });

  test('serious caps at 8 fps with the net off, at once', async () => {
    const { fake } = setup({ gazeNetAvailable: true });
    await fake.start(START);
    fake.setThermal('serious');
    const s = await fake.getStatus();
    expect(s.thermalLevel).toBe(2);
    expect(s.fpsTarget).toBe(8);
    expect(s.gazeNetOn).toBe(false);
  });

  test('fair applies only after 60 s held; cooling applies only after 60 s held', async () => {
    const { fake } = setup({ gazeNetAvailable: true });
    await fake.start(START);
    fake.setThermal('fair');
    fake.advance(THERMAL_L1_ENTRY_DWELL_MS - 1);
    await fake.setPolicy(RUN);
    expect((await fake.getStatus()).fpsTarget).toBe(15);
    fake.advance(1);
    await fake.setPolicy(RUN);
    let s = await fake.getStatus();
    expect(s.thermalLevel).toBe(1);
    expect(s.fpsTarget).toBe(8);
    expect(s.gazeNetOn).toBe(true);
    fake.setThermal('nominal');
    fake.advance(THERMAL_COOL_DWELL_MS - 1);
    await fake.setPolicy(RUN);
    expect((await fake.getStatus()).thermalLevel).toBe(1);
    fake.advance(1);
    await fake.setPolicy(RUN);
    s = await fake.getStatus();
    expect(s.thermalLevel).toBe(0);
    expect(s.fpsTarget).toBe(15);
  });
});

describe('the gaze net switch', () => {
  test('a build without the net never reports it on, and start with gazeNet is not an error', async () => {
    const { fake } = setup({ gazeNetAvailable: false });
    await fake.start(START);
    const s = await fake.getStatus();
    expect(s.gazeNetAvailable).toBe(false);
    expect(s.gazeNetOn).toBe(false);
    const m = await fake.getModelInfo();
    expect(m.gazeSha256).toBeNull();
    expect(m.onnxruntime).toBeNull();
  });
  test('a build with the net reports it', async () => {
    const { fake } = setup({ gazeNetAvailable: true });
    await fake.start(START);
    expect((await fake.getStatus()).gazeNetOn).toBe(true);
    expect((await fake.getModelInfo()).gazeSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

test('calls and queries are logged in order', async () => {
  const { fake } = setup();
  await fake.getPermission();
  await fake.start(START);
  await fake.setPolicy(RUN);
  await fake.getStatus();
  await fake.stop();
  expect(fake.calls.map((c) => c.method)).toEqual(['start', 'setPolicy', 'stop']);
  expect(fake.queries).toEqual(['getPermission', 'getStatus']);
});

test('requestPermission follows the configured answer', async () => {
  const { fake } = setup({ permission: 'undetermined', permissionOnRequest: 'granted' });
  await expect(fake.getPermission()).resolves.toEqual({ status: 'undetermined', canAskAgain: true });
  await expect(fake.requestPermission()).resolves.toEqual({ status: 'granted', canAskAgain: false });
  await expect(fake.start(START)).resolves.toBeUndefined();
});
