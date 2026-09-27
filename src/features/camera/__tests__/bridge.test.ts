import type { DmsController, DmsGateInputs, DmsHostSummary, DmsHudStatus } from '@/core/dms';
import type { FeatureRow } from '@/core/engine/types';
import type { DriveState } from '@/drive/host';

import { createCameraBridge, DRIVER_SIDE_KEY, mergeCoaching, type CameraBridgeDeps } from '../bridge';
import { readCoaching } from '../coaching';
import { CAMERA_CONSENT_VERSION, CAMERA_OPT_IN_KEY, turnCameraOff } from '../optIn';

function memorySettings(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    map: m,
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))),
    remove: async (k: string) => m.delete(k),
  };
}

const STATUS = (over: Partial<DmsHudStatus> = {}): DmsHudStatus => ({
  camera: 'active',
  reason: null,
  calibration: 'calibrated',
  fatigueLevel: 'alert' as DmsHudStatus['fatigueLevel'],
  dimAdvised: false,
  monitoring: { distraction: 'full', drowsiness: 'full', reason: null, why: { distraction: null, drowsiness: null } },
  ...over,
});

const SUMMARY = (over: Record<string, unknown> = {}) =>
  ({
    trackingCoverage: 0.9,
    cameraSession: 'good',
    tier0: { nonDrivingGlancesOver2s: 2 },
    longestNonDrivingGlance: { durS: 2.6 },
    alerts: { distraction: { delivered: 1 }, sleep: { delivered: 0 }, microsleep: { delivered: 1 } },
    ...over,
  }) as unknown as DmsHostSummary;

function fakeController() {
  const gates: DmsGateInputs[] = [];
  const rows: FeatureRow[] = [];
  const c = {
    gates,
    rows,
    ended: 0,
    disposed: 0,
    permissionAsks: 0,
    summary: SUMMARY() as DmsHostSummary | null,
    setGate: (g: DmsGateInputs) => void gates.push(g),
    pushRow: (r: FeatureRow) => {
      rows.push(r);
      return null;
    },
    presence: () => ({ lastFaceT: 123, absent: false, exitEvidence: false }),
    endDrive: async () => {
      c.ended += 1;
      return c.summary;
    },
    dispose: async () => void (c.disposed += 1),
    requestPermission: async () => {
      c.permissionAsks += 1;
      return 'granted' as const;
    },
  };
  return c;
}

function fakeHost(initial: Partial<DriveState> = {}) {
  let s = { status: 'off', clientTripId: null, mode: 'mounted', role: 'driver', callActive: false, lockedOut: false, ...initial } as DriveState;
  const subs = new Set<(s: DriveState) => void>();
  return {
    snapshot: () => s,
    subscribe: (fn: (s: DriveState) => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(over: Partial<DriveState>) {
      s = { ...s, ...over };
      for (const f of [...subs]) f(s);
    },
  };
}

function world(opts: { optIn?: boolean; ageBand?: string | null; flag?: boolean; uid?: string | null } = {}) {
  const settings = memorySettings(
    opts.optIn === false ? {} : { [CAMERA_OPT_IN_KEY]: { uid: 'u1', version: CAMERA_CONSENT_VERSION, on: true } }
  );
  const controllers: ReturnType<typeof fakeController>[] = [];
  const cleared: string[] = [];
  let onStatus: ((s: DmsHudStatus) => void) | null = null;
  let app = true;
  const appSubs = new Set<() => void>();
  const deps: CameraBridgeDeps = {
    settings,
    readUid: async () => (opts.uid === undefined ? 'u1' : opts.uid),
    readAgeBand: async () => (opts.ageBand === undefined ? '18_plus' : opts.ageBand),
    readCameraBeta: async () => opts.flag ?? true,
    createController: (d) => {
      const c = fakeController();
      controllers.push(c);
      onStatus = d.onStatus;
      return c as unknown as DmsController;
    },
    createPorts: async () => ({
      audio: { activate: async () => {}, play: async () => {}, stop: async () => {}, deactivate: async () => {} },
      voice: { speak: async () => {}, stop: async () => {} },
      haptics: { pattern: async () => {} },
    }),
    voiceEnabled: () => true,
    appActive: () => app,
    subscribeAppState: (fn) => {
      appSubs.add(fn);
      return () => appSubs.delete(fn);
    },
    power: () => ({ batteryLevel: 0.8, charging: false, localMinutes: 600 }),
    clearProfile: async () => {
      cleared.push('profile');
    },
  };
  const bridge = createCameraBridge(deps);
  const host = fakeHost();
  bridge.attach(host);
  return {
    bridge,
    host,
    settings,
    controllers,
    cleared,
    status: (s: DmsHudStatus) => onStatus?.(s),
    setApp(on: boolean) {
      app = on;
      for (const f of [...appSubs]) f();
    },
  };
}

const row = (ts: number) => ({ ts }) as FeatureRow;

test('not opted in: no controller is ever built; no presence', async () => {
  const w = world({ optIn: false });
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  w.bridge.onRow(row(1), null);
  expect(w.controllers).toHaveLength(0);
  expect(w.bridge.presence()).toBeNull();
});

test('opted in: the drive opens the gate with the inputs; rows and presence pass through', async () => {
  const w = world();
  await w.settings.set(DRIVER_SIDE_KEY, 'right');
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  const c = w.controllers[0]!;
  expect(c.gates.at(-1)).toEqual({
    optedIn: true,
    cameraBeta: true,
    ageBand: '18_plus',
    driveActive: true,
    mode: 'mounted',
    role: 'driver',
    appActive: true,
    driverSide: 'right',
    sensitivity: 'normal',
    alerts: 'live',
  });
  w.bridge.onRow(row(5), null);
  expect(c.rows.map((r) => r.ts)).toEqual([5]);
  expect(w.bridge.presence()).toEqual({ lastFaceT: 123, absent: false, exitEvidence: false });
});

test('the flag off or a minor: the gate carries it (the controller keeps the camera closed)', async () => {
  const w = world({ flag: false, ageBand: '13_17' });
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  expect(w.controllers[0]!.gates.at(-1)).toMatchObject({ cameraBeta: false, ageBand: 'unknown' });
});

test('T15 endDrive at ending: the gate closes at once, the drive ends, the coaching is kept for the trip', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  const c = w.controllers[0]!;
  w.host.set({ status: 'ending' });
  expect(c.gates.at(-1)).toMatchObject({ driveActive: false });
  await w.bridge.settled();
  expect(c.ended).toBe(1);
  expect(w.bridge.presence()).toBeNull();
  await expect(readCoaching(w.settings, 't1')).resolves.toEqual({
    v: 1,
    seenPct: 90,
    cameraSession: 'good',
    glancesOver2s: 2,
    longestGlanceS: 2.6,
    distractionAlerts: 1,
    sleepAlerts: 1,
  });
  // the same trip resumed (within the gap): the second leg adds to the card
  w.host.set({ status: 'recording' });
  await w.bridge.settled();
  expect(c.gates.at(-1)).toMatchObject({ driveActive: true });
  w.host.set({ status: 'finalizing' });
  await w.bridge.settled();
  expect(c.ended).toBe(2);
  expect((await readCoaching(w.settings, 't1'))!.glancesOver2s).toBe(4);
});

test('a drive the camera never saw keeps no card', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  w.controllers[0]!.summary = SUMMARY({ cameraSession: 'none' });
  w.host.set({ status: 'ending' });
  await w.bridge.settled();
  await expect(readCoaching(w.settings, 't1')).resolves.toBeNull();
});

test('opting out mid-drive closes the gate; the app going to the background closes it too', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  const c = w.controllers[0]!;
  w.setApp(false);
  expect(c.gates.at(-1)).toMatchObject({ appActive: false });
  w.setApp(true);
  await turnCameraOff(w.settings, 'u1');
  await w.bridge.settled();
  expect(c.gates.at(-1)).toMatchObject({ optedIn: false });
});

test('pocket mode or a passenger: the gate says so', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  w.host.set({ mode: 'pocket' });
  expect(w.controllers[0]!.gates.at(-1)).toMatchObject({ mode: 'pocket' });
  w.host.set({ mode: 'mounted', role: 'passenger' });
  expect(w.controllers[0]!.gates.at(-1)).toMatchObject({ role: 'passenger' });
});

test('the camera prompt: once per trip, only when the permission is what keeps it off, never while locked out', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', lockedOut: true });
  await w.bridge.settled();
  const c = w.controllers[0]!;
  w.status(STATUS({ camera: 'off', reason: 'permission' }));
  expect(c.permissionAsks).toBe(0);
  w.host.set({ lockedOut: false });
  w.status(STATUS({ camera: 'off', reason: 'permission' }));
  w.status(STATUS({ camera: 'off', reason: 'permission' }));
  expect(c.permissionAsks).toBe(1);
  w.status(STATUS({ camera: 'off', reason: 'flag_off' }));
  expect(c.permissionAsks).toBe(1);
});

test('the status reaches the chip store; dispose stops the controller, clears the status, ignores later calls', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  const c = w.controllers[0]!;
  expect(w.bridge.status()).toBeNull();
  w.status(STATUS());
  expect(w.bridge.status()).toEqual(STATUS());
  await w.bridge.dispose();
  expect(c.disposed).toBe(1);
  expect(w.bridge.status()).toBeNull();
  w.bridge.onRow(row(9), null);
  expect(c.rows).toEqual([]);
});

test('the session ends: after the drive, the controller is disposed and the face profile removed; the next drive builds anew', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1' });
  await w.bridge.settled();
  w.host.set({ status: 'finalizing' });
  await w.bridge.sessionEnded();
  expect(w.controllers[0]!.ended).toBe(1);
  expect(w.controllers[0]!.disposed).toBe(1);
  expect(w.cleared).toEqual(['profile']);
  expect(w.bridge.presence()).toBeNull();
  w.host.set({ status: 'recording', clientTripId: 't2' });
  await w.bridge.settled();
  expect(w.controllers).toHaveLength(2);
});

test('mergeCoaching: counts add, the longest is the max, the seen share the lower', () => {
  const a = { v: 1 as const, seenPct: 90, cameraSession: 'good' as const, glancesOver2s: 1, longestGlanceS: 2.1, distractionAlerts: 0, sleepAlerts: 1 };
  const b = { ...a, seenPct: 70, cameraSession: 'limited' as const, glancesOver2s: 3, longestGlanceS: 4, distractionAlerts: 2 };
  expect(mergeCoaching(a, b)).toEqual({ v: 1, seenPct: 70, cameraSession: 'limited', glancesOver2s: 4, longestGlanceS: 4, distractionAlerts: 2, sleepAlerts: 2 });
});
