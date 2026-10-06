// The setup session on the real controller and the fake native module: the parked ≈20 s flow produces a record
// (the seed and the mirror zones), and a drive that starts from that record is seeded with the mirrors promoted,
// so a glance at the measured mirror direction is safe (no focus sample) where the default zones would flag it.
import type { FeatureRow } from '@/core/engine/types';
import { createFakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { recordFromFeatures } from '../../../../../modules/dms-vision/src/wire';
import type { DmsSetupRecord } from '../../engine/setupRecord';
import type { EngineFrame } from '../../engine/types';
import { EPOCH0, onRoad, rel, ROAD, synthDrive, type DriverFn } from '../../replay/synth';
import { featuresFromFrame } from '../__fixtures__/records';
import { createDmsController, type DmsController, type DmsGateInputs } from '../controller';
import { createDmsSetupSession, SETUP_TICK_MS, setupRow, type DmsSetupView, type SetupResult } from '../setup';
import type { SetupStep } from '../setupMachine';

const POWER = { batteryLevel: 80, charging: false, localMinutes: 720 };
const FPS = 15;

/** Frames for one gaze held still (the driver's eyes on one target), by time. */
function held(gaze: (r: () => number) => { yaw: number; pitch: number }, seconds: number, speedKmh: number) {
  const items = synthDrive({ fps: FPS, seconds, seed: 11, source: 'geometric', driver: (_t, r) => ({ gaze: gaze(r), speedKmh }) });
  const byT = new Map(items.map((it) => [Math.round(it.frame.tMs), it.frame]));
  return (tMs: number) => byT.get(Math.round(tMs)) ?? null;
}

/** The driver follows the prompts: the road while mounting and seeding, then each mirror as asked. */
const LEFT = rel(-40, -18); // just below the default driver-mirror rectangle (pitch −12…10), 6° from it: `other` on the default map
const RIGHT = rel(52, 0);
const REAR = rel(27, 10);

function makeController(saved: DmsSetupRecord[], setupRecord: DmsSetupRecord | null = null, fakeOpts: { permission?: 'granted' | 'denied' | 'undetermined'; permissionOnRequest?: 'granted' | 'denied' } = {}) {
  const fake = createFakeDmsVision({ epochAtZero: EPOCH0, ...fakeOpts });
  const ctl = createDmsController({
    native: fake,
    onAlert: () => {},
    onStatus: () => {},
    profileStore: { load: async () => null, save: async () => {}, clear: async () => {} },
    setupStore: { load: async () => setupRecord },
    random: () => 'nonce',
  });
  return { fake, ctl, store: { save: async (r: DmsSetupRecord) => void saved.push(r) } };
}

/** Runs a whole setup: the fake clock advances in ticks, frames flow at 15 fps between them. */
async function runSetup(o: { frames: (tMs: number, step: SetupStep | 'done' | 'failed') => EngineFrame | null; maxS?: number; onView?: (v: DmsSetupView, s: { cancel(): void }) => void }) {
  const saved: DmsSetupRecord[] = [];
  const { fake, ctl, store } = makeController(saved);
  const next: { tick: (() => void) | null } = { tick: null };
  const views: DmsSetupView[] = [];
  const session: ReturnType<typeof createDmsSetupSession> = createDmsSetupSession({
    controller: ctl,
    store,
    appActive: () => true,
    power: () => POWER,
    now: () => EPOCH0 + fake.now(),
    schedule: (fn) => {
      next.tick = fn;
      return () => {
        if (next.tick === fn) next.tick = null;
      };
    },
    onChange: (v) => {
      views.push(v);
      o.onView?.(v, session);
    },
  });
  let result: SetupResult | null = null;
  void session.run().then((r) => {
    result = r;
  });
  const maxMs = (o.maxS ?? 60) * 1000;
  const step = 1000 / FPS;
  for (let t = 0; t < maxMs && result === null; t += SETUP_TICK_MS) {
    // frames between this tick and the next
    for (let f = t; f < t + SETUP_TICK_MS; f += step) {
      if (f > fake.now()) fake.advance(f - fake.now());
      const fr = o.frames(f, session.view().state.step);
      if (fr !== null) fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...fr, tMs: f }))]);
    }
    await ctl.idle();
    const tick = next.tick;
    next.tick = null;
    tick?.();
    await ctl.idle();
    await Promise.resolve();
  }
  await ctl.idle();
  return { result: result as SetupResult | null, saved, fake, ctl, views, session };
}

test('setupRow is a parked car: a known speed of 0, nothing handled', () => {
  const r = setupRow(EPOCH0);
  expect(r).toMatchObject({ ts: EPOCH0, speed: 0, gnssValid: true, handlingScore: 0, gravityStability: 1, appForeground: true });
});

test('the happy path: ≈ 20 s parked → a record with the seed and three mirrors; the camera ran in SETUP and stopped at the end', async () => {
  const road = held(() => ROAD, 60, 0); // a parked driver fixating the road ahead (no scanning)
  const left = held(() => LEFT, 60, 0);
  const right = held(() => RIGHT, 60, 0);
  const rear = held(() => REAR, 60, 0);
  const { result, saved, fake, views } = await runSetup({
    frames: (t, step) => (step === 'left_mirror' ? left(t) : step === 'right_mirror' ? right(t) : step === 'rear_mirror' ? rear(t) : road(t)),
  });
  expect(result).toMatchObject({ ok: true, mirrors: 3 });
  expect(saved).toHaveLength(1);
  const rec = saved[0]!;
  expect(rec.v).toBe(1);
  expect(rec.seed.gazeCentres.geometric).not.toBeNull();
  expect(rec.mirrors.map((m) => m.id).sort()).toEqual(['driver_mirror', 'passenger_mirror', 'rear_mirror']);
  const driverMirror = rec.mirrors.find((m) => m.id === 'driver_mirror')!;
  expect(Math.abs(driverMirror.yawDeg - -40)).toBeLessThan(7); // the geometric path's per-drive gain error is up to ±15 %
  expect(Math.abs(driverMirror.pitchDeg - -18)).toBeLessThan(5);
  expect(fake.calls.some((c) => c.method === 'setPolicy' && (c.args[0] as { setupMode: boolean }).setupMode)).toBe(true);
  expect(fake.calls.some((c) => c.method === 'setPolicy' && (c.args[0] as { previewAllowed: boolean }).previewAllowed)).toBe(true);
  expect(fake.nativeState()).toBe('stopped');
  expect(fake.now()).toBeLessThan(30_000); // about 20 s of parked time
  expect(views.map((v) => v.state.step)).toEqual(expect.arrayContaining(['mount', 'road', 'left_mirror', 'right_mirror', 'rear_mirror', 'done']));
  expect(views.at(-1)!.progress).toBe(1);
});

test('no face at all: the mount check never passes, the setup fails with no_face, nothing is stored, the camera stops', async () => {
  const empty = held(() => ROAD, 60, 0);
  const { result, saved, fake } = await runSetup({ frames: (t) => ({ ...empty(t)!, face: false, box: null, iod: null, head: null, eyeR: null, eyeL: null, faceLuma: null, mouth: null }), maxS: 40 });
  expect(result).toEqual({ ok: false, reason: 'no_face' });
  expect(saved).toEqual([]);
  expect(fake.nativeState()).toBe('stopped');
});

test('too dark: the face is seen but the light is below the threshold; the failure says dark', async () => {
  const road = held(() => ROAD, 60, 0); // a parked driver fixating the road ahead (no scanning)
  const { result } = await runSetup({ frames: (t) => ({ ...road(t)!, faceLuma: 20, frameLuma: 20 }), maxS: 40 });
  expect(result).toEqual({ ok: false, reason: 'dark' });
});

test('the camera permission is asked at the start, in context; a refusal ends the setup with no native start and nothing stored', async () => {
  const saved: DmsSetupRecord[] = [];
  const { fake, ctl, store } = makeController(saved, null, { permission: 'undetermined', permissionOnRequest: 'denied' });
  const session = createDmsSetupSession({ controller: ctl, store, appActive: () => true, power: () => POWER, now: () => EPOCH0 + fake.now(), schedule: () => () => {} });
  const r = await session.run();
  expect(r).toEqual({ ok: false, reason: 'permission' });
  expect(fake.calls.map((c) => c.method)).toContain('requestPermission');
  expect(fake.calls.map((c) => c.method)).not.toContain('start');
  expect(saved).toEqual([]);
  await ctl.dispose();
});

test('a granted prompt lets the setup go on: the camera starts in SETUP; cancel then stops it with nothing stored', async () => {
  const saved: DmsSetupRecord[] = [];
  const { fake, ctl, store } = makeController(saved, null, { permission: 'undetermined', permissionOnRequest: 'granted' });
  let tick: (() => void) | null = null;
  const session: ReturnType<typeof createDmsSetupSession> = createDmsSetupSession({
    controller: ctl,
    store,
    appActive: () => true,
    power: () => POWER,
    now: () => EPOCH0 + fake.now(),
    schedule: (fn) => {
      tick = fn;
      return () => {};
    },
  });
  const run = session.run();
  for (let i = 0; i < 50 && tick === null; i++) await new Promise((res) => setTimeout(res, 0));
  await ctl.idle();
  expect(fake.calls.map((c) => c.method)).toContain('requestPermission');
  expect(fake.nativeState()).toBe('running');
  session.cancel();
  (tick as unknown as () => void)();
  expect(await run).toEqual({ ok: false, reason: 'cancelled' });
  expect(fake.nativeState()).toBe('stopped');
  expect(saved).toEqual([]);
});

test('cancel from the screen mid-flow ends the setup on the next tick: nothing stored, the camera stopped', async () => {
  const road = held(() => ROAD, 60, 0); // a parked driver fixating the road ahead (no scanning)
  let cancelled = false;
  const out = await runSetup({
    frames: (t) => road(t),
    maxS: 20,
    onView: (v, s) => {
      if (v.state.step === 'road' && !cancelled) {
        cancelled = true;
        s.cancel();
      }
    },
  });
  expect(out.result).toEqual({ ok: false, reason: 'cancelled' });
  expect(out.saved).toEqual([]);
  expect(out.fake.nativeState()).toBe('stopped');
});

test('a drive from the record starts seeded with the mirrors promoted: a 3 s glance at the measured left mirror is safe; without the record it is a non-driving glance', async () => {
  const record = await (async () => {
    const road = held(() => ROAD, 60, 0); // a parked driver fixating the road ahead (no scanning)
    const left = held(() => LEFT, 60, 0);
    const right = held(() => RIGHT, 60, 0);
    const rear = held(() => REAR, 60, 0);
    const { saved } = await runSetup({ frames: (t, step) => (step === 'left_mirror' ? left(t) : step === 'right_mirror' ? right(t) : step === 'rear_mirror' ? rear(t) : road(t)) });
    return saved[0]!;
  })();
  expect(record.mirrors.some((m) => m.id === 'driver_mirror')).toBe(true);

  const GATE: DmsGateInputs = { enabled: true, driveActive: true, appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' };
  // The glance comes after Stage 1 (≈ 60 s of driving): the engine counts glances only once it has a road centre.
  const glanceDriver: DriverFn = (t, r) => ({ gaze: t >= 100 && t < 103 ? LEFT : onRoad(r), speedKmh: 60 });
  const row = (tMs: number): FeatureRow => ({ ...setupRow(EPOCH0 + tMs), speed: 60 / 3.6, course: 90, aLonMax: 0.1, aLonMin: -0.1, locked: true });

  async function driveWith(setup: DmsSetupRecord | null) {
    const { fake, ctl } = makeController([], setup);
    const items = synthDrive({ fps: FPS, seconds: 110, seed: 5, source: 'geometric', driver: glanceDriver });
    const byT = new Map(items.map((it) => [Math.round(it.frame.tMs), it.frame]));
    ctl.setGate(GATE);
    const focus: unknown[] = [];
    const states: string[] = [];
    const step = 1000 / FPS;
    for (let i = 0; i < 110 * FPS; i++) {
      const tMs = i * step;
      if (tMs > fake.now()) fake.advance(tMs - fake.now());
      if (i % FPS === 0) {
        const f = ctl.pushRow(row(tMs), POWER);
        if (f !== null) focus.push(f);
        for (let s = ctl.takeFocus(); s !== null; s = ctl.takeFocus()) focus.push(s);
        await ctl.idle();
        states.push(ctl.status().calibration ?? 'null');
      }
      const fr = byT.get(Math.round(tMs));
      if (fr !== undefined) fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...fr, tMs }))]);
    }
    await ctl.idle();
    await ctl.endDrive();
    return { focus, states };
  }

  const seeded = await driveWith(record);
  expect(seeded.states.slice(2, 20)).toContain('seeded'); // seeded from the first rows, before any pass
  expect(seeded.focus).toEqual([]);

  const scratch = await driveWith(null);
  expect(scratch.focus.length).toBeGreaterThanOrEqual(1);
  expect(scratch.focus[0]).toMatchObject({ kind: 'glance', glanceS: expect.closeTo(3, 0) });
}, 60_000);

test('the controller’s setupGaze follows the frames: tracking with a relative gaze, else null', async () => {
  const { fake, ctl } = makeController([]);
  expect(ctl.setupGaze()).toEqual({ rel: null, tracking: false });
  ctl.setGate({ enabled: true, driveActive: true, appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  ctl.beginSetup();
  ctl.pushRow(setupRow(EPOCH0), POWER);
  await ctl.idle();
  const road = held(() => ROAD, 5, 0);
  for (let t = 0; t < 4000; t += 1000 / FPS) {
    if (t > fake.now()) fake.advance(t - fake.now());
    fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...road(t)!, tMs: t }))]);
  }
  expect(ctl.setupGaze()).toEqual({ rel: null, tracking: true }); // tracked, but no road centre yet
  const check = ctl.setupCheck();
  expect(check).toMatchObject({ faceVisible: true, bothEyesTracked: true, lightingOk: true, angleOk: true });
  expect(check.phoneSteady).toBe(true);
  const seed = ctl.seedFromSetup();
  expect(seed.ok).toBe(true);
  fake.advance(1000 / FPS);
  fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...road(4000)!, tMs: fake.now() }))]);
  const g = ctl.setupGaze();
  expect(g.tracking).toBe(true);
  expect(g.rel).not.toBeNull(); // relative to the seeded centre now
  await ctl.dispose();
});

test('permission reads and prompts are allowed while DMS is enabled and the app in front, drive or not; never otherwise', async () => {
  const { fake, ctl } = makeController([]);
  expect(await ctl.permissionStatus()).toBeNull(); // no inputs yet
  ctl.setGate({ enabled: true, driveActive: false, appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  expect(await ctl.permissionStatus()).toBe('granted');
  fake.setPermission('undetermined');
  expect(await ctl.requestPermission()).toBe('granted'); // the fake grants on request
  expect(fake.calls.filter((c) => c.method === 'start')).toEqual([]); // a prompt never starts the camera without a drive
  ctl.setGate({ enabled: false, driveActive: false, appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  expect(await ctl.permissionStatus()).toBeNull();
  ctl.setGate({ enabled: true, driveActive: false, appActive: false, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  expect(await ctl.requestPermission()).toBeNull();
  await ctl.dispose();
});

export type { DmsController };
