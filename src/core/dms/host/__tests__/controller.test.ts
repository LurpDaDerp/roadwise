// The host controller on the fake native module (plan Task 14; rev1 S-M1/S-M2/S-M4, R-gaze, T1r1 m1;
// security T13 M-2/M-3/M-4; T13 r1 I1 cameraOff): the fail-closed lifecycle M7 plugs into.
import type { FeatureRow } from '@/core/engine/types';
import { createFakeDmsVision, type FakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { recordFromFeatures } from '../../../../../modules/dms-vision/src/wire';
import type { DmsAlertCommand } from '../../engine/alerts';
import type { DmsEvent } from '../../engine/engine';
import type { DmsProfileV1 } from '../../engine/profile';
import type { EngineFrame } from '../../engine/types';
import { frame } from '../../engine/__fixtures__/synth';
import { EPOCH0, onRoad, rel, synthDrive, type DriverFn } from '../../replay/synth';
import { featuresFromFrame } from '../__fixtures__/records';
import { createDmsController, type DmsController, type DmsGateInputs, type DmsHudStatus } from '../controller';

const GATE: DmsGateInputs = {
  optedIn: true,
  cameraBeta: true,
  ageBand: '18_plus',
  driveActive: true,
  mode: 'mounted',
  role: 'driver',
  appActive: true,
  driverSide: 'left',
  sensitivity: 'normal',
  alerts: 'live',
};
const POWER = { batteryLevel: 80, charging: false, localMinutes: 720 };

function featureRow(tMs: number, speedKmh: number | null, over: Partial<FeatureRow> = {}): FeatureRow {
  return {
    ts: EPOCH0 + tMs,
    lat: 51.5,
    lng: -0.1,
    hAcc: 5,
    speed: speedKmh === null ? -1 : speedKmh / 3.6,
    speedAcc: 0.5,
    course: 90,
    alt: 0,
    gnssValid: speedKmh !== null,
    aLonMax: 0.3,
    aLonMin: -0.3,
    aLatMax: 0.2,
    aLatMin: -0.2,
    yawRateMax: 0.01,
    jerkMax: 0.5,
    gravityStability: 0.98,
    orientationDelta: 0.01,
    handlingScore: 0.05,
    locked: true,
    screenOn: true,
    appForeground: true,
    ...over,
  };
}

interface H {
  fake: FakeDmsVision;
  ctl: DmsController;
  alerts: DmsAlertCommand[];
  statuses: DmsHudStatus[];
  events: DmsEvent[];
  saved: DmsProfileV1[];
}
function harness(o: { profile?: unknown; gazeNetAvailable?: boolean; gazeSource?: 'geometric' | 'net'; onAlertThrows?: boolean; random?: () => string } = {}): H {
  const fake = createFakeDmsVision({ gazeNetAvailable: o.gazeNetAvailable ?? false, epochAtZero: EPOCH0 });
  const alerts: DmsAlertCommand[] = [];
  const statuses: DmsHudStatus[] = [];
  const events: DmsEvent[] = [];
  const saved: DmsProfileV1[] = [];
  let n = 0;
  const ctl = createDmsController({
    native: fake,
    onAlert: (c) => {
      alerts.push(c);
      if (o.onAlertThrows) throw new Error('player bug');
    },
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    profileStore: { load: async () => o.profile ?? null, save: async (p) => void saved.push(p), clear: async () => {} },
    config: o.gazeSource !== undefined ? { gazeSource: o.gazeSource } : undefined,
    random: o.random ?? (() => `nonce-${++n}`),
  });
  return { fake, ctl, alerts, statuses, events, saved };
}

/** Drive the controller: a row each second, frames at `fps` from `frameAt(t)` while native runs. */
async function drive(h: H, fromS: number, toS: number, o: { fps?: number; speed?: (t: number) => number | null; frameAt?: (tMs: number) => EngineFrame | null; row?: (t: number) => Partial<FeatureRow> } = {}) {
  const fps = o.fps ?? 15;
  const step = 1000 / fps;
  const focus: unknown[] = [];
  for (let i = Math.round(fromS * fps); i < Math.round(toS * fps); i++) {
    const tMs = i * step;
    if (tMs > h.fake.now()) h.fake.advance(tMs - h.fake.now());
    if (i % fps === 0) {
      const f = h.ctl.pushRow(featureRow(tMs, (o.speed ?? (() => 60))(tMs / 1000), o.row?.(tMs / 1000)), POWER);
      if (f !== null) focus.push(f);
      await h.ctl.idle();
    }
    const fr = (o.frameAt ?? ((t) => frame({ tMs: t })))(tMs);
    if (fr !== null) h.fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...fr, tMs }))]);
  }
  await h.ctl.idle();
  return focus;
}
/** The replay driver model's frames (seeded), on the fake clock. */
const synthFrames = (driver: DriverFn, seconds: number, fps: number, source: 'geometric' | 'net' = 'geometric') => {
  const items = synthDrive({ fps, seconds, seed: 21, source, driver });
  const byT = new Map(items.map((it) => [Math.round(it.frame.tMs), it.frame]));
  return (tMs: number) => byT.get(Math.round(tMs)) ?? null;
};
const methods = (h: H) => h.fake.calls.map((c) => c.method);

describe('fail closed (plan Privacy 5)', () => {
  test.each([
    ['not opted in', { optedIn: false }],
    ['the flag off', { cameraBeta: false }],
    ['not 18_plus', { ageBand: 'other' as const }],
    ['an unknown age', { ageBand: 'unknown' as const }],
    ['no drive', { driveActive: false }],
    ['pocket mode', { mode: 'pocket' as const }],
    ['auto mode', { mode: 'auto' as const }],
    ['a passenger', { role: 'passenger' as const }],
    ['the app inactive', { appActive: false }],
  ])('%s: zero native calls, getPermission included', async (_n, change) => {
    const h = harness();
    h.ctl.setGate({ ...GATE, ...change });
    await drive(h, 0, 5);
    expect(h.fake.calls).toEqual([]);
    expect(h.fake.queries).toEqual([]);
    expect(h.ctl.status().camera).toBe('off');
  });
  test('the permission not granted: only the permission read, never a start', async () => {
    const h = harness();
    h.fake.setPermission('denied');
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    expect(h.fake.calls).toEqual([]);
    expect(h.fake.queries.every((q) => q === 'getPermission')).toBe(true);
  });
  test('a gate that throws (an empty nonce, security M-3) is closed: no start', async () => {
    const h = harness({ random: () => '' });
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    expect(methods(h)).not.toContain('start');
  });
});

describe('the lifecycle', () => {
  test('starts on gate open with the gate token; every row sends the policy (the heartbeat); the watchdog never fires', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 25);
    expect(methods(h)[0]).toBe('start');
    expect(methods(h).filter((m) => m === 'setPolicy').length).toBeGreaterThanOrEqual(24);
    expect(h.fake.calls.every((c) => (c.args[0] as { gateToken?: string } | undefined)?.gateToken === undefined || (c.args[0] as { gateToken: string }).gateToken === 'nonce-1')).toBe(true);
    expect(h.fake.nativeState()).toBe('running');
  });
  test('pause when stopped (a known speed < 10 km/h for 5 s), resume when moving', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 5);
    await drive(h, 5, 12, { speed: () => 0 });
    expect(h.fake.nativeState()).toBe('paused');
    await drive(h, 12, 15, { speed: () => 30 });
    expect(h.fake.nativeState()).toBe('running');
  });
  test.each([
    ['opt-out', { optedIn: false }],
    ['a passenger', { role: 'passenger' as const }],
    ['pocket mode', { mode: 'pocket' as const }],
    ['the app backgrounded', { appActive: false }],
  ])('%s stops native at once (rev1 S-M4)', async (_n, change) => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.ctl.setGate({ ...GATE, ...change });
    await h.ctl.idle();
    expect(h.fake.nativeState()).toBe('stopped');
    expect(methods(h).at(-1)).toBe('stop');
  });
  test('a permission revoked is re-read on the next row, and stops native', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.setPermission('denied');
    await drive(h, 3, 4);
    expect(h.fake.nativeState()).toBe('stopped');
  });
  test('a native permission error stops it (and nothing restarts it while denied)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.setPermission('denied');
    h.fake.failNext('setPolicy', 'E_PERMISSION');
    await drive(h, 3, 6);
    expect(h.fake.nativeState()).toBe('stopped');
    expect(methods(h).filter((m) => m === 'start')).toHaveLength(1);
  });
  test('backgrounded → stopped; back in the foreground → started again', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.setForeground(false);
    h.ctl.setGate({ ...GATE, appActive: false });
    await drive(h, 3, 5);
    expect(h.fake.nativeState()).toBe('stopped');
    h.fake.setForeground(true);
    h.ctl.setGate(GATE);
    await drive(h, 5, 7);
    expect(h.fake.nativeState()).toBe('running');
    expect(methods(h).filter((m) => m === 'start')).toHaveLength(2);
  });
  test('a native error: one retry after 5 s, then off for the drive, silently', async () => {
    const h = harness();
    h.fake.failNext('start', 'E_CAMERA');
    h.ctl.setGate(GATE);
    await drive(h, 0, 4);
    expect(methods(h).filter((m) => m === 'start')).toHaveLength(1);
    await drive(h, 4, 7);
    expect(methods(h).filter((m) => m === 'start')).toHaveLength(2); // the retry, 5 s after
    expect(h.fake.nativeState()).toBe('running');
    const again = harness();
    again.fake.failNext('start', 'E_CAMERA');
    again.ctl.setGate(GATE);
    await drive(again, 0, 4.5);
    again.fake.failNext('start', 'E_CAMERA'); // the retry at 5 s fails too
    await drive(again, 4.5, 20);
    expect(methods(again).filter((m) => m === 'start')).toHaveLength(2);
    expect(again.fake.nativeState()).toBe('stopped');
    expect(again.alerts).toEqual([]);
    expect(again.ctl.status()).toMatchObject({ camera: 'off', reason: 'error' });
  });
});

describe('frames, events and the status', () => {
  test('a broken batch is dropped and counted; the controller carries on', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 2);
    h.fake.emitRaw('frames', { junk: true });
    await drive(h, 2, 3);
    expect(h.ctl.diagnostics().droppedBatches).toBe(1);
    expect(h.ctl.diagnostics().frames).toBeGreaterThan(40);
  });
  test('events are on the epoch clock (the batch anchors)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 90, { frameAt: synthFrames((t, r) => ({ gaze: onRoad(r), speedKmh: 60 }), 90, 15) });
    const cal = h.events.find((e) => e.kind === 'calibrated')!;
    expect(cal.tMs).toBeGreaterThan(EPOCH0 + 55_000);
    expect(cal.tMs).toBeLessThan(EPOCH0 + 70_000);
  });
  test('T1r1 m1: a new native session accepts records with a lower clock than the last one', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.pushRecords([recordFromFeatures(featuresFromFrame(frame({ tMs: 900_000 })))]);
    h.ctl.setGate({ ...GATE, appActive: false });
    await h.ctl.idle();
    h.ctl.setGate(GATE);
    await drive(h, 3, 5);
    const before = h.ctl.diagnostics().droppedRecords;
    expect(before).toBe(0);
    expect(h.ctl.diagnostics().frames).toBeGreaterThan(50);
  });
  test('the HUD never says active without TRACKING or HEAD_ONLY in the last 1 s', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    expect(h.ctl.status().camera).toBe('active');
    await drive(h, 3, 6, { frameAt: (t) => frame({ tMs: t, face: false }) });
    expect(h.ctl.status().camera).not.toBe('active');
    expect(h.statuses.at(-1)!.camera).not.toBe('active');
  });
  test('onAlert throwing never breaks the controller', async () => {
    const h = harness({ onAlertThrows: true });
    h.ctl.setGate(GATE);
    const stack: DriverFn = (t, r) => ({ gaze: t >= 100 && t < 103.5 ? rel(30, -20) : onRoad(r), speedKmh: 60 });
    await drive(h, 0, 106, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction', 'stop:distraction']);
  });
});

describe('scoring, the profile and the gaze source', () => {
  test('a CameraFocusSample for a non-driving glance > 2 s, returned from pushRow; never for a mirror', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const glances: DriverFn = (t, r) => ({ gaze: t >= 100 && t < 102.6 ? rel(0, -40) : t >= 110 && t < 113 ? rel(27, 10) : onRoad(r), speedKmh: 60 });
    const focus = await drive(h, 0, 120, { frameAt: synthFrames(glances, 120, 15) });
    expect(focus).toHaveLength(1);
    expect(focus[0]).toMatchObject({ kind: 'glance', glanceS: expect.closeTo(2.6, 0) });
  });
  test('endDrive saves the profile only when calibrated; a short drive saves nothing', async () => {
    const long = harness();
    long.ctl.setGate(GATE);
    await drive(long, 0, 90, { frameAt: synthFrames((t, r) => ({ gaze: onRoad(r), speedKmh: 60 }), 90, 15) });
    const s = await long.ctl.endDrive();
    expect(s!.calibration.state).toBe('calibrated');
    expect(long.saved).toHaveLength(1);
    expect(long.fake.nativeState()).toBe('stopped');
    const short = harness();
    short.ctl.setGate(GATE);
    await drive(short, 0, 10);
    await short.ctl.endDrive();
    expect(short.saved).toEqual([]);
  });
  test('a stored profile that fails to parse is ignored', async () => {
    const h = harness({ profile: { v: 99 } });
    h.ctl.setGate(GATE);
    await drive(h, 0, 5);
    expect(h.fake.nativeState()).toBe('running');
  });
  test('rev1 R-gaze: net requested but not in this build → geometric, and the summary says so', async () => {
    const without = harness({ gazeSource: 'net', gazeNetAvailable: false });
    without.ctl.setGate(GATE);
    await drive(without, 0, 3);
    expect(without.ctl.summary()!.gazeSource).toBe('geometric');
    const withNet = harness({ gazeSource: 'net', gazeNetAvailable: true });
    withNet.ctl.setGate(GATE);
    await drive(withNet, 0, 3);
    expect(withNet.ctl.summary()!.gazeSource).toBe('net');
  });
});

describe('the gate’s lifetime (security M-2, M-4)', () => {
  test('two drives with the flag withdrawn between: the second stays closed', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.ctl.setGate({ ...GATE, driveActive: false });
    await h.ctl.endDrive();
    h.ctl.setGate({ ...GATE, cameraBeta: false });
    await drive(h, 3, 6);
    expect(methods(h).filter((m) => m === 'start')).toHaveLength(1);
    expect(h.fake.nativeState()).toBe('stopped');
  });
  test('sign-out (dispose) stops native at once, and nothing runs afterwards', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    await h.ctl.dispose();
    expect(h.fake.nativeState()).toBe('stopped');
    const n = h.fake.calls.length;
    h.ctl.setGate(GATE);
    h.ctl.pushRow(featureRow(4000, 60), POWER);
    await h.ctl.idle();
    expect(h.fake.calls.length).toBe(n);
  });
});

describe('setup (C2) and the thermal camera-off edge', () => {
  test('parked in setup with a good face: the checks pass and the C2 seed succeeds', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    h.ctl.beginSetup();
    await drive(h, 0, 5, { speed: () => 0, frameAt: synthFrames((t, r) => ({ gaze: onRoad(r), speedKmh: 0 }), 5, 15, 'net') });
    expect(h.ctl.setupCheck()).toEqual({ faceVisible: true, bothEyesTracked: true, lightingOk: true, angleOk: true, phoneSteady: true });
    expect(h.fake.calls.some((c) => c.method === 'setPolicy' && (c.args[0] as { setupMode: boolean }).setupMode)).toBe(true);
    h.ctl.endSetup();
  });
  test('no frames yet: every check is unknown', () => {
    const h = harness();
    expect(h.ctl.setupCheck()).toEqual({ faceVisible: 'unknown', bothEyesTracked: 'unknown', lightingOk: 'unknown', angleOk: 'unknown', phoneSteady: 'unknown' });
  });
  test('thermal L3 at speed: the running distraction stops (cameraOff), native pauses', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const stack: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(30, -20) : onRoad(r), speedKmh: 60 });
    await drive(h, 0, 104, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction']);
    h.fake.setThermal('critical');
    h.fake.emitStatus();
    await drive(h, 104, 106, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction', 'stop:distraction']);
    expect(h.fake.nativeState()).toBe('paused');
  });
});
