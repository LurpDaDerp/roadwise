// The host controller on the fake native module (plan Task 14; rev1 S-M1/S-M2/S-M4, R-gaze, T1r1 m1;
// security T13 M-2/M-3/M-4; T13 r1 I1 cameraOff): the fail-closed lifecycle M7 plugs into.
import type { FeatureRow } from '@/core/engine/types';
import { createFakeDmsVision, type FakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { buildFrameBatch, recordFromFeatures } from '../../../../../modules/dms-vision/src/wire';
import type { DmsVisionApi } from '../../../../../modules/dms-vision/src/types';
import type { DmsAlertCommand } from '../../engine/alerts';
import type { DmsConfigOverrides } from '../../engine/config';
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
function harness(
  o: { profile?: unknown; gazeNetAvailable?: boolean; gazeSource?: 'geometric' | 'net'; config?: DmsConfigOverrides; onAlertThrows?: boolean; random?: () => string; wrap?: (f: FakeDmsVision) => DmsVisionApi } = {}
): H {
  const fake = createFakeDmsVision({ gazeNetAvailable: o.gazeNetAvailable ?? false, epochAtZero: EPOCH0 });
  const alerts: DmsAlertCommand[] = [];
  const statuses: DmsHudStatus[] = [];
  const events: DmsEvent[] = [];
  const saved: DmsProfileV1[] = [];
  let n = 0;
  const ctl = createDmsController({
    native: o.wrap ? o.wrap(fake) : fake,
    onAlert: (c) => {
      alerts.push(c);
      if (o.onAlertThrows) throw new Error('player bug');
    },
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    profileStore: { load: async () => o.profile ?? null, save: async (p) => void saved.push(p), clear: async () => {} },
    config: o.gazeSource !== undefined || o.config !== undefined ? { ...o.config, ...(o.gazeSource !== undefined ? { gazeSource: o.gazeSource } : {}) } : undefined,
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
    // No setGate({ driveActive: false }) in between: endDrive itself closes the gate and observes the latch
    // edge (security T14 I-1).
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

// ---------------------------------------------------------------------------------------------------------
// T14 round 1 (seat 5 I1, I2, m1–m3, nit; security I-1, m-2).
// ---------------------------------------------------------------------------------------------------------

const starts = (h: H) => methods(h).filter((m) => m === 'start').length;
const lastPolicy = (h: H) => h.fake.calls.filter((c) => c.method === 'setPolicy').at(-1)!.args[0] as { fps: number; gazeNetEvery: number };
/** Eyes shut from `from` s (a microsleep at from + 1 s, then sleep) at 60 km/h, open again at `to` s. */
const eyesShut = (from: number, to: number, seconds: number) => synthFrames((t, r) => ({ gaze: onRoad(r), openness: t >= from && t < to ? 0.1 : 1, speedKmh: 60 }), seconds, 15);
const critStarted = (h: H) => h.alerts.some((c) => c.action === 'start' && c.tier === 3);
const drowsy = (xs: unknown[]) => (xs as { kind: string; glanceS: number }[]).filter((x) => x.kind === 'drowsiness' && x.glanceS < 60);

describe('T14 r1 security I-1: a drive end and a sign-out close the gate first', () => {
  test('endDrive, then rows with no setGate: the camera never starts again', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    await h.ctl.endDrive();
    const n = starts(h);
    await drive(h, 3, 9);
    expect(starts(h)).toBe(n);
    expect(h.fake.nativeState()).toBe('stopped');
    expect(h.ctl.status()).toMatchObject({ camera: 'off', reason: 'no_drive' });
  });
  test('stop is the first native call once dispose() begins, before the drive’s end is awaited', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    const n = h.fake.calls.length;
    const p = h.ctl.dispose();
    expect(h.fake.calls[n]?.method).toBe('stop');
    expect(h.fake.nativeState()).toBe('stopped');
    await p;
  });
  test('a setGate and a row while dispose() is pending never start the camera', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    const p = h.ctl.dispose();
    h.ctl.setGate(GATE);
    h.ctl.pushRow(featureRow(3000, 60), POWER);
    await p;
    await h.ctl.idle();
    expect(starts(h)).toBe(1);
    expect(h.fake.nativeState()).toBe('stopped');
  });
});

describe('T14 r1 seat I1: every open → closed gate transition stops the sound', () => {
  test('a Critical, then opt-out: its stop in the same setGate call', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 104, { frameAt: eyesShut(100, 200, 104) });
    expect(critStarted(h)).toBe(true);
    const n = h.alerts.length;
    h.ctl.setGate({ ...GATE, optedIn: false });
    expect(h.alerts.slice(n).map((c) => `${c.action}:${c.tier}`)).toEqual(['stop:3']);
  });
  test('a distraction, then the role → passenger: stop', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const stack: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(30, -20) : onRoad(r), speedKmh: 60 });
    await drive(h, 0, 104, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction']);
    h.ctl.setGate({ ...GATE, role: 'passenger' });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('a Critical, then the permission revoked (read on the next row): stop', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 104, { frameAt: eyesShut(100, 200, 104) });
    expect(critStarted(h)).toBe(true);
    const n = h.alerts.length;
    h.fake.setPermission('denied');
    await drive(h, 104, 106, { frameAt: () => null });
    expect(h.alerts.slice(n).map((c) => `${c.action}:${c.tier}`)).toEqual(['stop:3']);
    expect(h.ctl.status()).toMatchObject({ camera: 'off', reason: 'permission' });
  });
  test('a gate close with nothing running: no command', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 10);
    h.ctl.setGate({ ...GATE, optedIn: false });
    await h.ctl.idle();
    expect(h.alerts).toEqual([]);
  });
});

describe('T14 r1 seat I2: nothing of one drive leaks into the next', () => {
  test('a drowsiness sample still queued at drive end is returned in pendingFocus; the next drive’s first row returns null', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 104, { frameAt: eyesShut(100, 200, 104) }); // still shut at the end: the episode is open
    const s = await h.ctl.endDrive();
    expect(drowsy(s!.pendingFocus)).toHaveLength(1);
    h.ctl.setGate(GATE);
    expect(h.ctl.pushRow(featureRow(200_000, 60), POWER)).toBeNull();
  });
  test('a drive that ended in LOST: the next drive does not start in SEARCH (15 fps at 60 km/h, not 5)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 10);
    await drive(h, 10, 16, { frameAt: (t) => frame({ tMs: t, face: false }) });
    expect(lastPolicy(h).fps).toBe(5); // SEARCH in drive 1
    await h.ctl.endDrive();
    h.ctl.setGate(GATE);
    await drive(h, 16, 20, { frameAt: () => null });
    expect(lastPolicy(h).fps).toBe(15);
  });
  test('the last frame does not outlive its drive (setupCheck is unknown again)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    await h.ctl.endDrive();
    expect(h.ctl.setupCheck().faceVisible).toBe('unknown');
  });
  test('an F episode in each of two back-to-back drives: one sample each, none carried or merged across', async () => {
    // (F1 needs the open-eye baseline, so drive 2 runs past its own calibration before its episode.)
    const h = harness();
    h.ctl.setGate(GATE);
    const one = await drive(h, 0, 106, { frameAt: eyesShut(100, 103, 106) });
    const s = await h.ctl.endDrive();
    h.ctl.setGate(GATE);
    const two = await drive(h, 106, 212, { frameAt: eyesShut(206, 209, 212) });
    expect(drowsy([...one, ...s!.pendingFocus])).toHaveLength(1);
    expect(drowsy(two)).toHaveLength(1);
  });
});

describe('T14 r1 seat m1: a late gate open replays the drive’s last rows into the new engine', () => {
  test('30 s of rows at 72 km/h with the gate closed, then it opens as GNSS is lost: 72 is held on the first frame', async () => {
    const h = harness();
    h.ctl.setGate({ ...GATE, appActive: false });
    await drive(h, 0, 30, { speed: () => 72, frameAt: () => null });
    h.ctl.setGate(GATE);
    await drive(h, 30, 32, { speed: () => null });
    expect(h.ctl.diagnostics().ruleSpeedKmh).toBe(72);
  });
});

describe('T14 r1 seat m2: a drowsiness sample carries the episode’s measured length', () => {
  test('F1, then 8 s closed: one sample, glanceS about 8', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const d = drowsy(await drive(h, 0, 112, { frameAt: eyesShut(100, 108, 112) }));
    expect(d).toHaveLength(1);
    expect(d[0]!.glanceS).toBeGreaterThan(7.5);
    expect(d[0]!.glanceS).toBeLessThan(8.6);
  });
});

describe('T14 r1 seat m3: the status says what is monitored', () => {
  /** HEAD_ONLY: a face and a head pose, the eyes unreadable (a blurred crop) */
  const headOnly = (t: number) => frame({ tMs: t, blur: 5 });
  test('HEAD_ONLY under 10 s stays active; at 11 s it is limited / eyes_not_visible', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 20);
    await drive(h, 20, 25, { frameAt: headOnly });
    expect(h.ctl.status()).toMatchObject({ camera: 'active', reason: null });
    await drive(h, 25, 31, { frameAt: headOnly });
    expect(h.ctl.status()).toMatchObject({ camera: 'limited', reason: 'eyes_not_visible' });
  });
  test('LOST in the dark: limited / low_light; LOST in the light: limited / face_lost', async () => {
    const dark = harness();
    dark.ctl.setGate(GATE);
    await drive(dark, 0, 5);
    await drive(dark, 5, 8, { frameAt: (t) => frame({ tMs: t, face: false, frameLuma: 5 }) });
    expect(dark.ctl.status()).toMatchObject({ camera: 'limited', reason: 'low_light' });
    const lit = harness();
    lit.ctl.setGate(GATE);
    await drive(lit, 0, 5);
    await drive(lit, 5, 8, { frameAt: (t) => frame({ tMs: t, face: false, frameLuma: 110 }) });
    expect(lit.ctl.status()).toMatchObject({ camera: 'limited', reason: 'face_lost' });
  });
});

describe('T14 r1 seat nit: gazeNetEvery from config (default 2)', () => {
  test('a net build sends the net every other frame by default; an override of 1 is sent as 1', async () => {
    const two = harness({ gazeSource: 'net', gazeNetAvailable: true });
    two.ctl.setGate(GATE);
    await drive(two, 0, 5);
    expect(lastPolicy(two).gazeNetEvery).toBe(2);
    const one = harness({ gazeSource: 'net', gazeNetAvailable: true, config: { gazeNetEvery: 1 } });
    one.ctl.setGate(GATE);
    await drive(one, 0, 5);
    expect(lastPolicy(one).gazeNetEvery).toBe(1);
  });
});

describe('T14 r1 security m-2: a stop never queues', () => {
  test('a native call that never settles does not hold the stop', async () => {
    let hang = false;
    const h = harness({ wrap: (f) => ({ ...f, getPermission: () => (hang ? new Promise<never>(() => {}) : f.getPermission()) }) });
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    hang = true;
    h.ctl.pushRow(featureRow(3000, 60), POWER); // its permission read hangs, and the queue with it
    h.ctl.setGate({ ...GATE, optedIn: false });
    expect(methods(h).at(-1)).toBe('stop');
    expect(h.fake.nativeState()).toBe('stopped');
  });
  test('a permission read that rejects while running counts as closed: native stops', async () => {
    let reject = false;
    const h = harness({ wrap: (f) => ({ ...f, getPermission: () => (reject ? Promise.reject(new Error('bridge')) : f.getPermission()) }) });
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    reject = true;
    await drive(h, 3, 4);
    expect(h.fake.nativeState()).toBe('stopped');
    expect(h.ctl.status()).toMatchObject({ camera: 'off', reason: 'permission' });
  });
  test('a stop while a start is still pending: the camera is stopped once the start settles', async () => {
    let release: (() => void) | null = null;
    const h = harness({
      wrap: (f) => ({
        ...f,
        start: (o) =>
          new Promise<void>((res) => {
            release = () => void f.start(o).then(res);
          }),
      }),
    });
    h.ctl.setGate(GATE); // one queued open, and no row: nothing else is queued that could stop it later
    for (let i = 0; i < 50 && release === null; i++) await Promise.resolve();
    expect(release).not.toBeNull();
    h.ctl.setGate({ ...GATE, optedIn: false });
    (release as unknown as () => void)();
    await h.ctl.idle();
    expect(h.fake.nativeState()).toBe('stopped');
  });
});

describe('T14 r1: the permission prompt and the diagnostics the dev panel reads', () => {
  test('requestPermission asks native only when the permission is the one input closing the gate', async () => {
    const h = harness();
    h.ctl.setGate({ ...GATE, optedIn: false });
    expect(await h.ctl.requestPermission()).toBeNull();
    expect(methods(h)).not.toContain('requestPermission');
    const u = harness();
    u.fake.setPermission('undetermined');
    u.ctl.setGate(GATE);
    await drive(u, 0, 2);
    expect(u.ctl.status().reason).toBe('permission');
    expect(await u.ctl.requestPermission()).toBe('granted');
    await drive(u, 2, 4);
    expect(u.fake.nativeState()).toBe('running');
  });
  test('diagnostics carry native’s rates and thermal state (counts and states only)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitStatus();
    expect(h.ctl.diagnostics().native).toEqual({ fpsActual: expect.any(Number), fpsTarget: expect.any(Number), thermal: 'nominal', gazeNetAvailable: false, gazeNetOn: false });
  });
});

// ---------------------------------------------------------------------------------------------------------
// T14/T15 round 2 (seat 5 R1-m1..m3).
// ---------------------------------------------------------------------------------------------------------

describe('T14 r2 R1-m1: a native fault mid-drive is the camera going off (cause fault)', () => {
  test('a distraction running, then native stopped/error: its stop at once', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const stack: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(30, -20) : onRoad(r), speedKmh: 60 });
    await drive(h, 0, 104, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction']);
    h.fake.emitRaw('state', { state: 'stopped', reason: 'error' });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('a Critical running, then a fault and 60 s of rows at 60 km/h with no frame: blind_cap, then monitoring_paused (fault)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 104, { frameAt: eyesShut(100, 400, 104) });
    expect(critStarted(h)).toBe(true);
    const n = h.alerts.length;
    h.fake.failNext('start', 'E_CAMERA'); // the retry fails too: off for the drive, no frame ever again
    h.fake.emitRaw('state', { state: 'stopped', reason: 'error' });
    await drive(h, 104, 166, { frameAt: () => null });
    const after = h.alerts.slice(n);
    expect(after.map((c) => `${c.action}:${c.tier}`)).toEqual(['stop:3', 'once:1']);
    expect(after[1]).toMatchObject({ kind: 'monitoring_paused', cause: 'fault' });
  });
});

describe('T14 r2 R1-m2: a microsleep_nod is a drowsiness sample of its deep-lid time', () => {
  test('one microsleep_nod: one drowsiness sample, 0.5 s or more', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    // At 100 s the head drops 20° over 0.5 s, holds 0.3 s and recovers over 0.3 s; the lids are shut
    // (0.1) from 100.3 s to 100.95 s: a deep-lid hold of 0.65 s, too short for F1 (1.0 s).
    const nod: DriverFn = (t, r) => {
      const k = t - 100;
      if (k < 0 || k >= 1.1) return { gaze: onRoad(r), speedKmh: 60 };
      const pitch = k < 0.5 ? (-20 * k) / 0.5 : k < 0.8 ? -20 : -20 + (20 * (k - 0.8)) / 0.3;
      return { head: { yaw: 0.8, pitch: -1.2 + pitch }, gaze: rel(0, pitch), openness: k >= 0.3 && k < 0.95 ? 0.1 : 0.35, speedKmh: 60 };
    };
    const focus = await drive(h, 0, 106, { frameAt: synthFrames(nod, 106, 15) });
    expect(h.events.filter((e) => e.kind === 'microsleep_nod')).toHaveLength(1);
    expect(h.events.map((e) => e.kind)).not.toContain('microsleep');
    const d = drowsy(focus);
    expect(d).toHaveLength(1);
    expect(d[0]!.glanceS).toBeGreaterThanOrEqual(0.5);
    expect(d[0]!.glanceS).toBeLessThan(1);
  });
});

describe('T14 r2 R1-m3: a native fault during the permission read is not restarted at once', () => {
  test('an error while getPermission is pending: no start until a row 5 s later', async () => {
    let hold: (() => void) | null = null;
    let holding = false;
    const h = harness({
      wrap: (f) => ({
        ...f,
        getPermission: () =>
          holding
            ? new Promise((res) => {
                hold = () => void f.getPermission().then(res);
              })
            : f.getPermission(),
      }),
    });
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    expect(starts(h)).toBe(1);
    holding = true;
    h.ctl.pushRow(featureRow(3000, 60), POWER); // its permission read is held
    for (let i = 0; i < 20 && hold === null; i++) await Promise.resolve();
    expect(hold).not.toBeNull();
    h.fake.emitRaw('state', { state: 'stopped', reason: 'error' }); // native faults meanwhile
    holding = false;
    (hold as unknown as () => void)();
    await h.ctl.idle();
    expect(starts(h)).toBe(1); // not restarted by the op that was waiting on the read
    await drive(h, 4, 7.5, { frameAt: () => null });
    expect(starts(h)).toBe(1); // rows under 5 s after the fault: still waiting
    await drive(h, 8, 9, { frameAt: () => null });
    expect(starts(h)).toBe(2); // the one retry
  });
});

// ---------------------------------------------------------------------------------------------------------
// The final whole-DMS review, integration half (final-review-integration.md): I-1..I-4, M-1..M-3, M-5.
// ---------------------------------------------------------------------------------------------------------

describe('final review I-1: native pauses and stops itself', () => {
  test('paused/interrupted during a Critical at 60 km/h: blind_cap + monitoring_paused (fault) at 60 s, an honest HUD', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 104, { frameAt: eyesShut(100, 400, 104) });
    expect(critStarted(h)).toBe(true);
    const n = h.alerts.length;
    h.fake.emitRaw('state', { state: 'paused', reason: 'interrupted' });
    await drive(h, 104, 106, { frameAt: () => null });
    expect(h.ctl.status().camera).not.toBe('starting');
    expect(h.ctl.status()).toMatchObject({ reason: 'interrupted' });
    await drive(h, 106, 166, { frameAt: () => null });
    const after = h.alerts.slice(n);
    expect(after.filter((c) => c.kind === 'monitoring_paused').map((c) => c.cause)).toEqual(['fault']);
    expect(after.some((c) => c.action === 'stop' && c.tier === 3)).toBe(true);
  });
  test('a running distraction, then paused/interrupted: its stop is dispatched at once', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const stack: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(30, -20) : onRoad(r), speedKmh: 60 });
    await drive(h, 0, 104, { frameAt: synthFrames(stack, 106, 15) });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction']);
    h.fake.emitRaw('state', { state: 'paused', reason: 'interrupted' });
    expect(h.alerts.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('a paused/error that persists: stop(), one start() 5 s later, then off for the drive after the second failure', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    expect(starts(h)).toBe(1);
    h.fake.emitRaw('state', { state: 'paused', reason: 'error' });
    await drive(h, 3, 4, { frameAt: () => null });
    expect(methods(h)).toContain('stop');
    expect(starts(h)).toBe(1);
    await drive(h, 4, 9, { frameAt: () => null });
    expect(starts(h)).toBe(2); // the one retry
    h.fake.emitRaw('state', { state: 'paused', reason: 'error' });
    await drive(h, 9, 30, { frameAt: () => null });
    expect(starts(h)).toBe(2);
    expect(h.ctl.status()).toMatchObject({ camera: 'off', reason: 'error' });
  });
  test('an interruption longer than 5 s is recovered by stop() then start()', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitRaw('state', { state: 'paused', reason: 'interrupted' });
    await drive(h, 3, 8, { frameAt: () => null });
    expect(starts(h)).toBe(1); // under 5 s: native may still end the interruption itself
    await drive(h, 8, 9, { frameAt: () => null });
    expect(methods(h).filter((m) => m === 'stop').length).toBeGreaterThanOrEqual(1); // at 5 s: stop()
    await drive(h, 9, 15, { frameAt: () => null });
    expect(starts(h)).toBe(2); // and one start() 5 s later
  });
  test('native paused/thermal: the HUD says paused / thermal, never starting', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitRaw('state', { state: 'paused', reason: 'thermal' });
    expect(h.ctl.status()).toMatchObject({ camera: 'paused', reason: 'thermal' });
  });
});

describe('final review I-2: no frame reaches the engine after the gate closes', () => {
  test('role → passenger while a D1 sounds, then a flushed batch that would cross D2/D4: no start after the close', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const phone: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(0, -40) : onRoad(r), speedKmh: 70 });
    const frames = synthFrames(phone, 110, 15);
    await drive(h, 0, 103, { frameAt: frames, speed: () => 70 });
    expect(h.alerts.some((c) => c.action === 'start')).toBe(true);
    h.ctl.setGate({ ...GATE, role: 'passenger' });
    const n = h.alerts.length;
    const framesBefore = h.ctl.diagnostics().frames;
    // native's teardown flushes what it held: 4 s of the same head-down frames
    const recs = [];
    for (let t = 103_000; t < 107_000; t += 1000 / 15) recs.push(recordFromFeatures(featuresFromFrame({ ...(frames(t) ?? frame({ tMs: t })), tMs: t })));
    h.fake.emitRaw('frames', buildFrameBatch(recs, EPOCH0 + 103_000));
    expect(h.alerts.slice(n).filter((c) => c.action !== 'stop')).toEqual([]);
    expect(h.ctl.diagnostics().frames).toBe(framesBefore);
  });
  test('the same for sign-out (dispose)', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    const phone: DriverFn = (t, r) => ({ gaze: t >= 100 ? rel(0, -40) : onRoad(r), speedKmh: 70 });
    const frames = synthFrames(phone, 110, 15);
    await drive(h, 0, 103, { frameAt: frames, speed: () => 70 });
    const p = h.ctl.dispose();
    const framesBefore = h.ctl.diagnostics().frames;
    const recs = [];
    for (let t = 103_000; t < 107_000; t += 1000 / 15) recs.push(recordFromFeatures(featuresFromFrame({ ...(frames(t) ?? frame({ tMs: t })), tMs: t })));
    h.fake.emitRaw('frames', buildFrameBatch(recs, EPOCH0 + 103_000));
    await p;
    expect(h.ctl.diagnostics().frames).toBe(framesBefore);
    expect(h.alerts.filter((c) => c.action === 'start' && c.tMs >= EPOCH0 + 103_000)).toEqual([]);
  });
});

describe('final review I-3: native is never started while the policy says PAUSED', () => {
  test('a long stop: native releases itself at 5 min and is not restarted until the car moves again', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 5);
    expect(starts(h)).toBe(1);
    await drive(h, 5, 400, { speed: () => 0, frameAt: () => null });
    expect(h.fake.nativeState()).toBe('stopped'); // released by native
    expect(starts(h)).toBe(1);
    expect(h.ctl.status()).toMatchObject({ camera: 'paused', reason: 'stopped' });
    await drive(h, 400, 406, { speed: () => 40 });
    expect(starts(h)).toBe(2);
  });
  test('thermal critical: no start while critical (thermal read fresh while stopped); one start after the cool dwell', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 5);
    h.fake.setThermal('critical');
    h.fake.emitStatus();
    await drive(h, 5, 400, { frameAt: () => null });
    expect(h.fake.nativeState()).toBe('stopped');
    expect(starts(h)).toBe(1);
    h.fake.setThermal('nominal');
    await drive(h, 400, 480, { frameAt: () => null });
    expect(starts(h)).toBe(2);
  });
});

describe('final review M-1: late state events never overwrite the controller’s own state', () => {
  test('a setPolicy refused with E_STATE (native stopped itself) is not a native failure', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.failNext('setPolicy', 'E_STATE');
    await drive(h, 3, 20);
    h.fake.failNext('setPolicy', 'E_STATE');
    await drive(h, 20, 40);
    expect(h.ctl.status()).toMatchObject({ camera: 'active' });
    expect(h.ctl.summary()!.camera).toMatchObject({ retries: 0, gaveUp: false });
  });
  test('close, reopen and close within one stop’s latency (async delivery): native is stopped after the last close', async () => {
    const fake = createFakeDmsVision({ epochAtZero: EPOCH0, asyncDelivery: true });
    const ctl = createDmsController({ native: fake, onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} }, random: () => 'n' });
    ctl.setGate(GATE);
    ctl.pushRow(featureRow(0, 60), POWER);
    await ctl.idle();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    ctl.setGate({ ...GATE, appActive: false });
    ctl.setGate(GATE);
    ctl.setGate({ ...GATE, appActive: false });
    await ctl.idle();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await ctl.idle();
    expect(fake.nativeState()).toBe('stopped');
    expect(fake.calls.at(-1)!.method).toBe('stop');
  });
});

describe('final review M-2: a drive end is atomic', () => {
  test('endDrive() and dispose() together, with a slow save: the engine ends once, and the save lands before dispose resolves', async () => {
    const saved: unknown[] = [];
    let release: (() => void) | null = null;
    const fake = createFakeDmsVision({ epochAtZero: EPOCH0 });
    const endCalls: number[] = [];
    const ctl = createDmsController({
      native: fake,
      onAlert: () => {},
      onStatus: () => {},
      onEvent: () => {},
      profileStore: { load: async () => null, save: (p) => new Promise<void>((res) => (release = () => (saved.push(p), res()))), clear: async () => {} },
      random: () => 'n',
    });
    const h: H = { fake, ctl, alerts: [], statuses: [], events: [], saved: [] };
    ctl.setGate(GATE);
    await drive(h, 0, 90, { frameAt: synthFrames((t, r) => ({ gaze: onRoad(r), speedKmh: 60 }), 90, 15) });
    const a = ctl.endDrive().then((s) => endCalls.push(s === null ? 0 : 1));
    const b = ctl.dispose();
    for (let i = 0; i < 20 && release === null; i++) await Promise.resolve();
    let disposed = false;
    void b.then(() => (disposed = true));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(disposed).toBe(false); // dispose waits for the save
    (release as unknown as () => void)();
    await a;
    await b;
    expect(saved).toHaveLength(1);
    expect(endCalls).toEqual([1]);
    expect(ctl.summary()!.calibration.state).toBe('calibrated'); // not overwritten by a second, empty end
  });
});

describe('final review M-3: setup does not outlive its drive', () => {
  test('beginSetup without endSetup, the drive ends: the next drive does not start in SETUP', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    h.ctl.beginSetup();
    await drive(h, 0, 3, { speed: () => 0 });
    await h.ctl.endDrive();
    h.ctl.setGate(GATE);
    await drive(h, 3, 6, { speed: () => 0 });
    const last = h.fake.calls.filter((c) => c.method === 'setPolicy').at(-1)!.args[0] as { setupMode: boolean };
    expect(last.setupMode).toBe(false);
  });
});

describe('final review M-5: malformed native events are dropped and counted', () => {
  test('a state with an unknown value and a status without fields change nothing and are counted', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitRaw('state', { state: 'exploded', reason: 'x' });
    h.fake.emitRaw('status', { nope: true });
    expect(h.ctl.status().camera).toBe('active');
    expect(h.ctl.diagnostics().droppedEvents).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Final review, round 2 (integration re-review): R-1, R-2, R-3.
// ---------------------------------------------------------------------------------------------------------

describe('final review round 2 R-1: a failed resume is never silent', () => {
  /** Stopped at a light (the policy pauses native), then moving again: native's resume fails. */
  async function resumeFails(h: H, withEvent: boolean) {
    h.ctl.setGate(GATE);
    await drive(h, 0, 5);
    await drive(h, 5, 12, { speed: () => 0 });
    expect(h.fake.nativeState()).toBe('paused');
    // native answers `run` without touching the camera (a failed re-bind / startRunning)
    const realSetPolicy = h.fake.setPolicy.bind(h.fake);
    h.fake.setPolicy = async (p) => {
      if (p.capture === 'run' && h.fake.nativeState() === 'paused') {
        h.fake.calls.push({ method: 'setPolicy', args: [p] });
        if (withEvent) h.fake.emitRaw('state', { state: 'paused', reason: 'error' });
        return;
      }
      return realSetPolicy(p);
    };
    const startsBefore = starts(h);
    await drive(h, 12, 14, { speed: () => 60, frameAt: () => null });
    return startsBefore;
  }
  test('native reports paused/error on the failed resume: the HUD is honest, then stop() and one start() after 5 s', async () => {
    const h = harness();
    const before = await resumeFails(h, true);
    expect(h.ctl.status().camera).not.toBe('starting');
    expect(h.ctl.status().reason).toBe('error');
    await drive(h, 14, 22, { speed: () => 60, frameAt: () => null });
    expect(methods(h)).toContain('stop');
    expect(starts(h)).toBe(before + 1);
  });
  test('no event at all: after 5 s of `run` with native not running, the guard recovers it the same way', async () => {
    const h = harness();
    const before = await resumeFails(h, false);
    await drive(h, 14, 25, { speed: () => 60, frameAt: () => null });
    expect(methods(h)).toContain('stop');
    expect(starts(h)).toBe(before + 1);
    expect(h.ctl.status().camera).not.toBe('starting');
  });
});

describe('final review round 2 R-2: an interruption that ends by itself costs no retry', () => {
  test('interrupted, then running again 2 s later: no stop, no retry; a second short interruption later recovers too', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitRaw('state', { state: 'paused', reason: 'interrupted' });
    const before = methods(h).filter((m) => m === 'setPolicy').length;
    await drive(h, 3, 5, { frameAt: () => null });
    // `run` keeps reaching native during a young interruption, so native can resume once it ends
    expect(methods(h).filter((m) => m === 'setPolicy').length).toBeGreaterThan(before);
    h.fake.emitRaw('state', { state: 'running', reason: 'policy' });
    await drive(h, 5, 30);
    expect(methods(h).filter((m) => m === 'stop')).toEqual([]);
    expect(h.ctl.summary()!.camera.retries).toBe(0);
    h.fake.emitRaw('state', { state: 'paused', reason: 'interrupted' });
    await drive(h, 30, 32, { frameAt: () => null });
    h.fake.emitRaw('state', { state: 'running', reason: 'policy' });
    await drive(h, 32, 40);
    expect(h.ctl.status()).toMatchObject({ camera: 'active' });
    expect(h.ctl.summary()!.camera.gaveUp).toBe(false);
  });
  test('during the 5 s retry wait the HUD says limited / error, never off with no reason', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    h.fake.emitRaw('state', { state: 'paused', reason: 'error' });
    await drive(h, 3, 5, { frameAt: () => null });
    expect(h.ctl.status()).toMatchObject({ camera: 'limited', reason: 'error' });
  });
  test('retries reset after 10 min of healthy running', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3, { fps: 5 });
    h.fake.emitRaw('state', { state: 'paused', reason: 'error' });
    await drive(h, 3, 12, { fps: 5 });
    expect(h.ctl.summary()!.camera.retries).toBe(1);
    await drive(h, 12, 620, { fps: 5 });
    expect(h.ctl.summary()!.camera.retries).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Final review, round 3 (integration re-review 2): R2-1, R2-m1.
// ---------------------------------------------------------------------------------------------------------

describe('final review round 3 R2-1: a native thermal self-pause is not a fault', () => {
  test('native pauses itself for heat while the host policy still says run: no stop, no retry; `run` keeps flowing and native resumes by itself after the cool dwell', async () => {
    const h = harness();
    h.ctl.setGate(GATE);
    await drive(h, 0, 3);
    // no emitStatus: the host has not read the heat yet, so its policy still says run
    h.fake.setThermal('critical');
    expect(h.fake.nativeState()).toBe('paused');
    const before = methods(h).filter((m) => m === 'setPolicy').length;
    await drive(h, 3, 12, { frameAt: () => null });
    expect(methods(h)).not.toContain('stop');
    expect(methods(h).filter((m) => m === 'setPolicy').length).toBeGreaterThan(before);
    expect(h.ctl.status()).toMatchObject({ camera: 'paused', reason: 'thermal' });
    h.fake.setThermal('nominal');
    await drive(h, 12, 80);
    expect(h.fake.nativeState()).toBe('running');
    expect(h.ctl.status()).toMatchObject({ camera: 'active' });
    expect(methods(h)).not.toContain('stop');
    expect(starts(h)).toBe(1);
    expect(h.ctl.summary()!.camera).toMatchObject({ retries: 0, gaveUp: false });
  });
});

describe('final review round 3 R2-m1: a slow cold start is not a failed resume', () => {
  test('native.start takes 7 s (a slow Android cold start): the not-running guard waits for it; no stop, no second start', async () => {
    let release: () => void = () => undefined;
    let slow = true; // only the first start is slow
    const h = harness({
      wrap: (f) => ({
        ...f,
        start: async (o) => {
          if (slow) {
            slow = false;
            await new Promise<void>((r) => (release = r));
          }
          return f.start(o);
        },
      }),
    });
    h.ctl.setGate(GATE);
    for (let s = 0; s <= 7; s++) {
      if (s * 1000 > h.fake.now()) h.fake.advance(s * 1000 - h.fake.now());
      h.ctl.pushRow(featureRow(s * 1000, 60), POWER);
      await new Promise<void>((r) => setImmediate(r)); // let the queued permission read reach native.start
    }
    release();
    await h.ctl.idle();
    await drive(h, 8, 12);
    expect(methods(h)).not.toContain('stop');
    expect(starts(h)).toBe(1);
    expect(h.ctl.summary()!.camera).toMatchObject({ starts: 1, retries: 0, gaveUp: false });
    expect(h.fake.nativeState()).toBe('running');
  });
});
