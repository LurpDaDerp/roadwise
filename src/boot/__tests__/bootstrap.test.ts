/** @jest-environment node */
import { createFakeDriveSense } from '@drive-sense';

import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, type Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { bootstrapApp, flushBeforeSignOut, type BootSupabase } from '@/boot/bootstrap';
import { createDriveHeadlessTask } from '@/boot/headless';
import { DEVICE_TABLES, ensureDeviceOwner, hasDriverData, readDeviceOwner, wipeDevice, wipeForSignOut } from '@/boot/device';
import { createFakeDashcamRuntime } from '@/dashcam/__fixtures__/fakeRuntime';
import { setActiveDashcam } from '@/dashcam/registry';
import { INSTALL_ID_KEY, readInstallId } from '@/data/devices/installId';

jest.mock('expo-notifications', () => ({}));

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeLimits(): SpeedLimitClient {
  const sample: LimitSample = { limitMps: 35 * 0.44704, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
  return {
    lookup: () => sample,
    lookupStored: async () => sample,
    startTrip: () => {},
    prefetch: () => {},
    resetTrip: jest.fn(),
    purgeExpired: async () => 0,
  } as unknown as SpeedLimitClient;
}

const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };

let db: Db;
let clock: number;
beforeEach(async () => {
  db = await createSqlJsDb();
  clock = T0 + 10_000_000;
});

function deps(over: Partial<Parameters<typeof bootstrapApp>[0]> = {}) {
  const source = createFakeDriveSense({ platform: 'android', now: () => clock });
  source.setState({ location: 'whenInUse', motion: 'granted' });
  const supabase = createFakeSupabase({ uid: 'user-1', invoke: () => invokeOk({}), rpc: () => ({ data: [], error: null }) });
  const appState = createFakeAppState('active');
  return {
    source,
    supabase,
    appState,
    deps: {
      openDb: async () => db,
      supabase: supabase as unknown as BootSupabase,
      source,
      limits: fakeLimits(),
      createPlayer: async () => player,
      display: null,
      appState,
      now: () => clock,
      tz: TZ,
      appVersion: '2.0.0',
      permissions: async () => ({ location: 'granted' as const }),
      speedProbe: async () => 0,
      attachSummaryNotifier: null,
      mountDiagnostics: null,
      mayDrain: () => false,
      onError: () => {},
      ...over,
    },
  };
}

test('a cold launch: migrates, records the owner, boots the host idle, starts the runner; nothing is armed or started', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  expect(rt.schemaVersion).toBe(5);
  expect(rt.owner).toBe('first');
  expect(await readDeviceOwner(db)).toBe('user-1');
  expect(rt.drive.snapshot().status).toBe('idle');
  expect(rt.adopted).toBeNull();
  // Nothing reaches the native side at launch: no capture, no arming, no motion feed.
  expect(d.source.calls).toEqual([]);
  await rt.stop();
});

test('a drive the previous process was recording is continued when the capture still runs, else finalized as an orphan', async () => {
  // Left behind: a `recording` row with 300 s of samples ending just now.
  const left = deps();
  const seed = await bootstrapApp(left.deps);
  await seed.stop();
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(5), started_at: clock - 300_000, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(5), rows(300, { t0: clock - 300_000 }).map((r) => ({ ts: r.ts, row: r })));
  await trips.checkpoint(uuid(5), clock - 1000);

  const live = deps();
  live.source.setState({ capturing: true, mode: 'mounted', rate: 'full' });
  const rt = await bootstrapApp(live.deps);
  expect(rt.adopted).toBe(uuid(5));
  expect(rt.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(5) });
  await rt.stop({ endOpenTrip: true });
  expect((await trips.get(uuid(5)))?.status).toBe('pending');

  await trips.insert({ client_trip_id: uuid(6), started_at: clock - 300_000, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(6), rows(300, { t0: clock - 300_000 }).map((r) => ({ ts: r.ts, row: r })));
  const dead = deps();
  const rt2 = await bootstrapApp(dead.deps);
  expect(rt2.adopted).toBeNull();
  expect(rt2.recovery.finalized).toEqual([uuid(6)]);
  expect((await trips.get(uuid(6)))?.status).toBe('pending');
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(2);
  await rt2.stop();
});

test('the headless task keeps a continued drive alive and stops a capture with no drive behind it', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  const stopped: string[] = [];
  const task = createDriveHeadlessTask({
    ensureRuntime: async () => rt,
    stopCapture: async () => void stopped.push('stop'),
    report: () => {},
  });
  await task({});
  expect(stopped).toEqual(['stop']);
  await rt.stop();
});

test('device ownership: a different user wipes every table but the schema’s; an empty device is adopted', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await rt.stop();
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'scored' }, T0);
  expect(await hasDriverData(db)).toBe(true);
  expect(await ensureDeviceOwner(db, 'user-1')).toBe('same');
  await createSettingsRepo(db).set(INSTALL_ID_KEY, 'install-keeps-1234');
  await createSettingsRepo(db).set('privacy.zones', []);
  expect(await ensureDeviceOwner(db, 'user-2')).toBe('wiped');
  expect(await createTripsRepo(db).count()).toBe(0);
  expect(await readDeviceOwner(db)).toBe('user-2');
  // The install id is the one setting the wipe keeps: one phone, one device id, whoever signs in.
  expect(await readInstallId(createSettingsRepo(db))).toBe('install-keeps-1234');
  expect(await createSettingsRepo(db).get('privacy.zones')).toBeNull();
  expect(DEVICE_TABLES).toEqual([
    'trip_events',
    'samples',
    'sync_queue',
    'settings',
    'speed_limit_tiles',
    'dashcam_events',
    'dashcam_boots',
    'dashcam_coverage',
    'trips',
  ]);
  expect(await ensureDeviceOwner(db, null)).toBe('signed-out');
  await createSettingsRepo(db).remove('device.lastUserId');
  expect(await ensureDeviceOwner(db, 'user-3')).toBe('first');
});

test('a launch signed out, then the owner signs in: Start Drive works without a relaunch', async () => {
  const d = deps({ newId: () => uuid(7) });
  d.supabase.setUid(null);
  const rt = await bootstrapApp(d.deps);
  expect(rt.owner).toBe('signed-out');
  expect(await rt.drive.start()).toEqual({ ok: false, reason: 'error' });
  // What the root layout does on SIGNED_IN for the device owner (or an empty device).
  await rt.drive.signedInAgain();
  const started = await rt.drive.start();
  expect(started).toEqual({ ok: true, clientTripId: uuid(7) });
  await rt.stop({ endOpenTrip: true });
});

test('a plain sign-out with nothing owed wipes the drives and zones but keeps the owner and the install id', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'scored', from_label: 'Home' }, T0);
  await createSettingsRepo(db).set('privacy.zones', [{ id: 'h', name: 'Home', lat: 1, lng: 1, radiusM: 300 }]);
  await createSettingsRepo(db).set(INSTALL_ID_KEY, 'install-keeps-1234');
  for (const [status, key] of [['done', 'a'], ['failed', 'b'], ['pending', 'c']] as const) {
    await db.execute(
      "INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, next_attempt_at, created_at) VALUES ('trip.finalize', '{}', ?, ?, 0, 0)",
      [key, status]
    );
  }
  await wipeForSignOut(db);
  expect(await createTripsRepo(db).count()).toBe(0);
  // Finished and failed queue rows (they hold the payloads) go; the one still owed stays.
  expect(await createQueueRepo(db).countByStatus('done')).toBe(0);
  expect(await createQueueRepo(db).countByStatus('failed')).toBe(0);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
  expect(await createSettingsRepo(db).get('privacy.zones')).toBeNull();
  expect(await readDeviceOwner(db)).toBe('user-1');
  expect(await readInstallId(createSettingsRepo(db))).toBe('install-keeps-1234');
  await rt.stop();
});

test('flushBeforeSignOut drains once and reports what is still owed', async () => {
  const d = deps({ mayDrain: () => true });
  const rt = await bootstrapApp(d.deps);
  expect(await flushBeforeSignOut(rt)).toEqual({ sent: 0, left: 0 });
  await rt.stop();
});

test('a handover wipe takes the DashPal events, boots and coverage but keeps the phone’s pairing and preferences (dashcam.*)', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await rt.stop();
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'scored' }, T0);
  const settings = createSettingsRepo(db);
  await settings.set('dashcam.paired', { dashcamId: 'a4cf12b3c4d5', peripheralId: 'p', name: 'DashPal-C4D5', pairedAt: 1 });
  await settings.set('dashcam.buzzerToo', true);
  await settings.set('dashcam.btOptIn', true);
  await settings.set('dashcam.snoozes', { x: 1 });
  // Lookalikes are not kept: only the `dashcam.` prefix, literally.
  await settings.set('dashcamXpaired', 1);
  await settings.set('xdashcam.paired', 1);
  await db.execute(
    `INSERT INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms, client_trip_id)
     VALUES ('a4cf12b3c4d5', 1, 0, 'e', 0, 'MICROSLEEP', 3, 1, 0, 1, 1, 0, 1, ?)`,
    [uuid(1)]
  );
  await db.execute("INSERT INTO dashcam_boots (dashcam_id, boot_id) VALUES ('a4cf12b3c4d5', 1)");
  await db.execute('INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES (?, 5, 5)', [uuid(1)]);

  expect(await ensureDeviceOwner(db, 'user-2')).toBe('wiped');
  for (const table of ['dashcam_events', 'dashcam_boots', 'dashcam_coverage']) {
    expect((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  }
  expect(await settings.get('dashcam.paired')).toEqual({ dashcamId: 'a4cf12b3c4d5', peripheralId: 'p', name: 'DashPal-C4D5', pairedAt: 1 });
  expect(await settings.get('dashcam.buzzerToo')).toBe(true);
  expect(await settings.get('dashcam.btOptIn')).toBe(true);
  expect(await settings.get('dashcam.snoozes')).toEqual({ x: 1 });
  expect(await settings.get('dashcamXpaired')).toBeNull();
  expect(await settings.get('xdashcam.paired')).toBeNull();
});

test('a wipe under a live app restarts the DashPal link, so it handshakes again and the boot row comes back', async () => {
  const d = deps({ createDashcam: null });
  const rt = await bootstrapApp(d.deps);
  const fake = createFakeDashcamRuntime();
  setActiveDashcam(fake);
  try {
    await wipeForSignOut(db);
    expect(fake.log).toEqual(['restartLink']);
    await wipeDevice(db);
    expect(fake.log).toEqual(['restartLink', 'restartLink']);
  } finally {
    setActiveDashcam(null);
  }
  // No DashPal runtime: the wipe is unchanged.
  await expect(wipeForSignOut(db)).resolves.toBeUndefined();
  await rt.stop();
});

test('a plain sign-out takes the DashPal events, boots and coverage with the drives; the pairing stays', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'scored' }, T0);
  await createSettingsRepo(db).set('dashcam.paired', { dashcamId: 'a4cf12b3c4d5' });
  await db.execute(
    `INSERT INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms)
     VALUES ('a4cf12b3c4d5', 1, 0, 'e', 0, 'MICROSLEEP', 3, 1, 0, 1, 1, 0, 1)`
  );
  await db.execute("INSERT INTO dashcam_boots (dashcam_id, boot_id) VALUES ('a4cf12b3c4d5', 1)");
  await db.execute('INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES (?, 5, 5)', [uuid(1)]);
  await wipeForSignOut(db);
  for (const table of ['dashcam_events', 'dashcam_boots', 'dashcam_coverage']) {
    expect((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  }
  expect(await createSettingsRepo(db).get('dashcam.paired')).toEqual({ dashcamId: 'a4cf12b3c4d5' });
  await rt.stop();
});
