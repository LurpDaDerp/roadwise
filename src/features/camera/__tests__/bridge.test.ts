// The camera bridge: the gate follows the drive (`dmsOn` + recording + the app in front), rows feed the controller
// and the focus samples wait for the drive's detector, the permission prompt never comes mid-drive, and a setup
// session owns the gate while it runs.
import type { DmsController, DmsFocusSample, DmsGateInputs, DmsHudStatus, DmsSetupRecord } from '@/core/dms';
import type { FeatureRow } from '@/core/engine/types';
import type { DriveState } from '@/drive/host';

import { createCameraBridge, type CameraBridgeDeps } from '../bridge';

const STATUS = (over: Partial<DmsHudStatus> = {}): DmsHudStatus => ({
  camera: 'active',
  reason: null,
  calibration: 'seeded',
  fatigueLevel: 'none' as DmsHudStatus['fatigueLevel'],
  dimAdvised: false,
  monitoring: { distraction: 'full', drowsiness: 'full', reason: null, why: { distraction: null, drowsiness: null } },
  ...over,
});

const row = (ts: number): FeatureRow => ({
  ts,
  lat: 0,
  lng: 0,
  hAcc: 5,
  speed: 15,
  speedAcc: 0.5,
  course: 90,
  alt: 0,
  gnssValid: true,
  aLonMax: 0,
  aLonMin: 0,
  aLatMax: 0,
  aLatMin: 0,
  yawRateMax: 0,
  jerkMax: 0,
  gravityStability: 1,
  orientationDelta: 0,
  handlingScore: 0,
  locked: true,
  screenOn: true,
  appForeground: true,
});

const glance = (endT: number): DmsFocusSample => ({ kind: 'glance', glanceS: 2.5, q: 0.95, endT, wideTurn: false, lowLight: false });

function fakeController() {
  const gates: DmsGateInputs[] = [];
  const rows: FeatureRow[] = [];
  const c = {
    gates,
    rows,
    ended: 0,
    disposed: 0,
    permissionAsks: 0,
    permissionReads: 0,
    /** what pushRow hands back on the next row, then takeFocus drains */
    queue: [] as DmsFocusSample[],
    status: STATUS(),
    setGate: (g: DmsGateInputs) => void gates.push(g),
    pushRow: (r: FeatureRow) => {
      rows.push(r);
      return c.queue.shift() ?? null;
    },
    takeFocus: () => c.queue.shift() ?? null,
    presence: () => ({ lastFaceT: 123, absent: false, exitEvidence: false }),
    endDrive: async () => {
      c.ended += 1;
      return null;
    },
    dispose: async () => void (c.disposed += 1),
    requestPermission: async () => {
      c.permissionAsks += 1;
      return 'granted' as const;
    },
    permissionStatus: async () => {
      c.permissionReads += 1;
      return 'granted' as const;
    },
    beginSetup: () => {},
    endSetup: () => {},
    setupCheck: () => ({ faceVisible: true, bothEyesTracked: true, lightingOk: true, angleOk: true, phoneSteady: true }) as const,
    setupGaze: () => ({ rel: { yaw: 0, pitch: 0 }, tracking: true }),
    seedFromSetup: () => ({ ok: false, reason: 'no_tracking' }) as const,
    idle: async () => {},
  };
  return c;
}

function fakeHost(initial: Partial<DriveState> = {}) {
  let s = { status: 'idle', clientTripId: null, dmsOn: false, callActive: false, lockedOut: false } as DriveState;
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
    ...initial,
  };
}

function world(opts: { uid?: string | null } = {}) {
  const controllers: ReturnType<typeof fakeController>[] = [];
  const saved: DmsSetupRecord[] = [];
  let cleared = 0;
  let app = true;
  const appSubs = new Set<() => void>();
  let n = 0;
  const deps: CameraBridgeDeps = {
    readUid: async () => (opts.uid === undefined ? 'u1' : opts.uid),
    createController: () => {
      const c = fakeController();
      controllers.push(c);
      return c as unknown as DmsController;
    },
    setupStore: () => ({ save: async (r) => void saved.push(r) }),
    appActive: () => app,
    subscribeAppState: (fn) => {
      appSubs.add(fn);
      return () => appSubs.delete(fn);
    },
    power: () => ({ batteryLevel: 80, charging: false, localMinutes: 600 }),
    newId: () => `e${++n}`,
    clearStores: async () => void (cleared += 1),
  };
  const bridge = createCameraBridge(deps);
  const host = fakeHost();
  bridge.attach(host);
  return {
    bridge,
    host,
    controllers,
    saved,
    cleared: () => cleared,
    appSubs,
    setApp(on: boolean) {
      app = on;
      for (const f of [...appSubs]) f();
    },
    last: () => controllers.at(-1)!,
  };
}

const lastGate = (c: ReturnType<typeof fakeController>) => c.gates.at(-1)!;

test('a drive with DMS on: the controller is built for the uid and the gate opens (enabled, drive active, app active, the engine muted); the end closes it and ends the drive', async () => {
  const w = world();
  expect(w.controllers).toHaveLength(0);
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  expect(w.controllers).toHaveLength(1);
  expect(lastGate(w.last())).toEqual({ enabled: true, driveActive: true, appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'shadow' });
  w.host.set({ status: 'finalizing', clientTripId: 't1' });
  expect(lastGate(w.last())).toMatchObject({ enabled: false, driveActive: false });
  await w.bridge.settled();
  expect(w.last().ended).toBe(1);
  w.host.set({ status: 'idle', clientTripId: null });
  await w.bridge.settled();
  expect(w.last().ended).toBe(1);
});

test('a drive with DMS off loads nothing: no controller, nothing runs, rows go nowhere', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: false });
  await w.bridge.settled();
  expect(w.controllers).toHaveLength(0);
  w.bridge.onRow(row(1000), null);
  expect(w.bridge.presence()).toBeNull();
  expect(w.bridge.detectors()).toHaveLength(1); // the detector exists but never sees a sample
});

test('signed out: no controller, no gate', async () => {
  const w = world({ uid: null });
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  expect(w.controllers).toHaveLength(0);
});

test('the app leaving the front closes the gate in the same tick; back in front reopens it', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  w.setApp(false);
  expect(lastGate(w.last())).toMatchObject({ appActive: false, driveActive: true });
  w.setApp(true);
  expect(lastGate(w.last())).toMatchObject({ appActive: true, driveActive: true });
});

test('rows reach pushRow with the motion evidence, and the focus samples wait for the drive’s detector, which consumes them on the same row', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  const c = w.last();
  const [det] = w.bridge.detectors();
  const T = 1_760_000_000_000;
  // Ten rows at 15 m/s give the detector its speed history.
  for (let i = 0; i < 10; i++) {
    w.bridge.onRow(row(T + i * 1000), null);
    det!.push(row(T + i * 1000), { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, { tripStartedAt: T - 3_600_000, callActive: false, lockReliable: true, lockLagged: false });
  }
  c.queue.push(glance(T + 10_000), glance(T + 10_000)); // one from pushRow, one from takeFocus
  w.bridge.onRow(row(T + 10_000), null);
  expect(c.rows).toHaveLength(11);
  const events = det!.push(row(T + 10_000), { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, { tripStartedAt: T - 3_600_000, callActive: false, lockReliable: true, lockLagged: false });
  expect(events.map((e) => e.type)).toEqual(['eyes_off', 'eyes_off']);
  expect(events[0]!.id).toBe('e1');
  // Consumed: a second push on the same row has nothing.
  expect(det!.push(row(T + 11_000), { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, { tripStartedAt: T - 3_600_000, callActive: false, lockReliable: true, lockLagged: false })).toEqual([]);
});

test('presence is the controller’s while a drive is followed, null otherwise', async () => {
  const w = world();
  expect(w.bridge.presence()).toBeNull();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  expect(w.bridge.presence()).toEqual({ lastFaceT: 123, absent: false, exitEvidence: false });
  w.host.set({ status: 'idle', clientTripId: null });
  await w.bridge.settled();
  expect(w.bridge.presence()).toBeNull();
});

test('the permission prompt: for the settings switch, outside a drive, under a parked gate (enabled, no drive); never while a drive records', async () => {
  const w = world();
  expect(await w.bridge.requestPermission()).toBe('granted');
  const c = w.last();
  expect(c.permissionAsks).toBe(1);
  expect(c.gates[0]).toMatchObject({ enabled: true, driveActive: false, appActive: true });
  expect(lastGate(c)).toMatchObject({ enabled: false, driveActive: false }); // restored afterwards
  expect(await w.bridge.permissionStatus()).toBe('granted');
  expect(c.permissionReads).toBe(1);
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  expect(await w.bridge.requestPermission()).toBe('unavailable');
  expect(c.permissionAsks).toBe(1);
  expect(w.controllers).toHaveLength(1); // the same controller, reused for the drive
});

test('signed out: the permission and the setup are unavailable', async () => {
  const w = world({ uid: null });
  expect(await w.bridge.requestPermission()).toBe('unavailable');
  expect(await w.bridge.startSetup(() => {})).toBeNull();
  expect(w.controllers).toHaveLength(0);
});

test('a setup session owns the gate while it runs; the drive gate comes back after it; none during a drive', async () => {
  const w = world();
  const session = await w.bridge.startSetup(() => {});
  expect(session).not.toBeNull();
  const c = w.last();
  const before = c.gates.length;
  w.host.set({ status: 'idle', clientTripId: null }); // a host snapshot during the setup does not touch the gate
  expect(c.gates.length).toBe(before);
  expect(await w.bridge.startSetup(() => {})).toBeNull(); // one at a time
  session!.cancel();
  const r = await session!.run();
  expect(r).toEqual({ ok: false, reason: 'cancelled' });
  expect(lastGate(c)).toMatchObject({ enabled: false, driveActive: false }); // the drive gate again
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  expect(await w.bridge.startSetup(() => {})).toBeNull();
});

test('sessionEnded disposes the controller and clears the stores; the next drive builds a new one', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  w.host.set({ status: 'idle', clientTripId: null });
  await w.bridge.sessionEnded();
  expect(w.last().disposed).toBe(1);
  expect(w.cleared()).toBe(1);
  w.host.set({ status: 'recording', clientTripId: 't2', dmsOn: true });
  await w.bridge.settled();
  expect(w.controllers).toHaveLength(2);
});

test('dispose stops everything and ignores later calls', async () => {
  const w = world();
  w.host.set({ status: 'recording', clientTripId: 't1', dmsOn: true });
  await w.bridge.settled();
  await w.bridge.dispose();
  expect(w.last().disposed).toBe(1);
  expect(w.bridge.status()).toBeNull();
  w.bridge.onRow(row(1), null);
  expect(w.last().rows).toHaveLength(0);
  expect(await w.bridge.requestPermission()).toBe('unavailable');
});
