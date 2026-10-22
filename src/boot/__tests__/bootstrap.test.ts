/** @jest-environment node */
import { createFakeDriveDetect, createFakeDriveSense } from '@drive-sense';

import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, type Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { bootstrapApp, endSession, flushBeforeSignOut, REMINDER_RETIRED_KEY, startForegroundJobs, type BootSupabase } from '@/boot/bootstrap';
import { createDriveHeadlessTask } from '@/boot/headless';
import { DEVICE_TABLES, ensureDeviceOwner, hasDriverData, readDeviceOwner, rememberDeviceOwner, wipeDevice, wipeForSignOut } from '@/boot/device';
import { createFakeDashcamRuntime } from '@/dashcam/__fixtures__/fakeRuntime';
import { setActiveDashcam } from '@/dashcam/registry';
import { INSTALL_ID_KEY, readInstallId } from '@/data/devices/installId';
import { DROP_NOTICE_KEY, readDropNotice } from '@/drive/dropNotice';
import type { DriveHost } from '@/drive/host';
import { DRIVE_SCREEN_ENTERED_KEY, driveScreenEnteredFor, resetDriveScreenPresence, setDriveScreenFocused } from '@/features/drive/hudPresence';
import type { PhoneReminder } from '@/features/drive/phoneReminder';
import { QueryClient } from '@tanstack/react-query';
import { subscribeInvalidation } from '@/data/queries/invalidate';
import { queryKeys } from '@/data/queries/keys';

jest.mock('expo-notifications', () => ({}));
const mockEnsureDrivePermissions = jest.fn(async (..._args: unknown[]) => ({ location: 'granted' as const, motion: 'undetermined' as const }));
jest.mock('@/features/drive/permissions', () => ({ ensureDrivePermissions: (...args: unknown[]) => mockEnsureDrivePermissions(...args) }));

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
      attachSummaryNotifier: null,
      createPhoneReminder: null,
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
  expect(rt.schemaVersion).toBe(11);
  expect(rt.owner).toBe('first');
  expect(await readDeviceOwner(db)).toBe('user-1');
  expect(rt.drive.snapshot().status).toBe('idle');
  expect(rt.adopted).toBeNull();
  // Nothing reaches the native side at launch (no capture, no motion feed) but the retired
  // forgot-to-start reminder's one switch-off per install.
  expect(d.source.calls).toEqual(['setTripReminder:false']);
  expect(await createSettingsRepo(db).get(REMINDER_RETIRED_KEY)).toBe(1);
  await rt.stop();
  const again = deps();
  const rt2 = await bootstrapApp(again.deps);
  expect(again.source.calls).toEqual([]);
  await rt2.stop();
});

test('the phone reminder follows the host from before its boot, sweeps once the host has booted, and goes with the runtime', async () => {
  const calls: string[] = [];
  const reminder: PhoneReminder = {
    pickup: (p) => void calls.push(`pickup ${p.clientTripId}`),
    attach: (host) => {
      calls.push(`attach booted=${String((host as Partial<DriveHost>).booted?.())}`);
      return () => void calls.push('detach');
    },
    sweep: () => void calls.push('sweep'),
    settled: async () => void calls.push('settled'),
  };
  const d = deps({ createPhoneReminder: () => reminder });
  const rt = await bootstrapApp(d.deps);
  expect(calls).toEqual(['attach booted=false', 'sweep']);
  await rt.stop();
  expect(calls).toEqual(['attach booted=false', 'sweep', 'settled', 'detach']);
  // One that cannot be built is reported; the launch goes on without it.
  const errors: string[] = [];
  const broken = deps({
    createPhoneReminder: () => {
      throw new Error('no notifications');
    },
    onError: (_e, ctx) => void errors.push(ctx),
  });
  const rt2 = await bootstrapApp(broken.deps);
  expect(errors).toContain('phone reminder');
  expect(rt2.drive.snapshot().status).toBe('idle');
  await rt2.stop();
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

test('an orphan that never moved is dropped at launch and Home gets the notice (cause orphan); no OS notification', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(8), started_at: clock - 300_000, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(8), rows(300, { t0: clock - 300_000, speedMps: 0 }).map((r) => ({ ts: r.ts, row: r })));
  const rt = await bootstrapApp(deps().deps);
  expect(rt.recovery).toMatchObject({ dropped: [uuid(8)], finalized: [] });
  expect(await trips.get(uuid(8))).toBeNull();
  expect(await readDropNotice(db)).toEqual({ clientTripId: uuid(8), cause: 'orphan', reason: 'no_movement', at: clock, origin: 'manual' });
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
  await rt.stop();
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
    'problem_spots',
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
  expect(started).toEqual({ ok: true, waiting: true });
  await rt.stop({ endOpenTrip: true });
});

test('the default Start Drive permissions ask only for location, never for motion', async () => {
  const d = deps({ newId: () => uuid(8), permissions: undefined });
  const rt = await bootstrapApp(d.deps);
  mockEnsureDrivePermissions.mockClear();
  expect(await rt.drive.start()).toEqual({ ok: true, waiting: true });
  expect(mockEnsureDrivePermissions).toHaveBeenCalledTimes(1);
  expect(mockEnsureDrivePermissions.mock.calls[0]?.[1]).toEqual({ askMotion: false });
  await rt.stop({ endOpenTrip: true });
});

test('a plain sign-out with nothing owed wipes the drives and zones but keeps the owner and the install id', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'scored', from_label: 'Home' }, T0);
  await createSettingsRepo(db).set('privacy.zones', [{ id: 'h', name: 'Home', lat: 1, lng: 1, radiusM: 300 }]);
  await createSettingsRepo(db).set(INSTALL_ID_KEY, 'install-keeps-1234');
  await createSettingsRepo(db).set(DROP_NOTICE_KEY, { clientTripId: uuid(2), cause: 'stopped', reason: 'no_movement', at: T0 });
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
  expect(await createSettingsRepo(db).get(DROP_NOTICE_KEY)).toBeNull();
  expect(await readDeviceOwner(db)).toBe('user-1');
  expect(await readInstallId(createSettingsRepo(db))).toBe('install-keeps-1234');
  await rt.stop();
});

const serverDrive = (n: number) => ({
  tripId: uuid(100 + n),
  clientTripId: uuid(n),
  startedAt: T0 - n * 3_600_000,
  endedAt: T0 - n * 3_600_000 + 600_000,
  tz: TZ,
  localDay: null,
  miles: 5,
  safeMiles: 5,
  nightMiles: 0,
  durationS: 600,
  polyline: null,
  scored: true,
  reason: null,
  notDriving: false,
  clean: true,
  pointsNet: 50,
  breakdown: null,
  result: null,
  events: [],
});

test('restore: the owner’s drives come from the server under the owner’s session; a stopped runtime or another session writes nothing', async () => {
  const supabase = createFakeSupabase({ uid: 'user-1', rpc: () => ({ data: [serverDrive(1)], error: null }) });
  const rt = await bootstrapApp(deps({ supabase: supabase as unknown as BootSupabase }).deps);
  expect(await rt.restore()).toMatchObject({ restored: 1 });
  expect(supabase.rpcs[0]).toEqual({ fn: 'list_my_drives', args: { p_limit: 50 } });
  await db.execute('DELETE FROM trips');
  await db.execute("DELETE FROM settings WHERE key = 'restore.completedAt'");
  supabase.setUid('user-2');
  await expect(rt.restore()).rejects.toThrow('restore abandoned');
  supabase.setUid('user-1');
  await rt.stop();
  await expect(rt.restore()).rejects.toThrow('restore abandoned');
  expect(await createTripsRepo(db).count()).toBe(0);
});

test('a phone first opened signed out restores the driver’s drives at their sign-in, not at the next relaunch; a sign-out that emptied the phone restores again', async () => {
  const supabase = createFakeSupabase({ uid: null, rpc: () => ({ data: [serverDrive(1)], error: null }) });
  const rt = await bootstrapApp(deps({ supabase: supabase as unknown as BootSupabase }).deps);
  expect(rt.owner).toBe('signed-out');
  const errors: string[] = [];
  const jobs = await startForegroundJobs(rt, { appState: createFakeAppState('active'), onError: (_e, context) => errors.push(context) });
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  // Signed out on a phone nobody owns: nothing restored, nothing marked done, no request.
  expect(supabase.rpcs).toHaveLength(0);
  expect(errors).toContain('foreground job restore');

  // The sign-in: the owner watch records the owner, then the layout runs the restore now.
  supabase.setUid('user-1');
  await rememberDeviceOwner(db, 'user-1');
  expect(await jobs.runNow()).toBe(true);
  expect(await createTripsRepo(db).get(uuid(1))).not.toBeNull();

  // Sign out (nothing owed: the drives leave the phone), then the same driver signs back in.
  await wipeForSignOut(db);
  expect(await createTripsRepo(db).count()).toBe(0);
  expect(await jobs.runNow()).toBe(true);
  expect(await createTripsRepo(db).get(uuid(1))).not.toBeNull();
  await jobs.stop();
  await rt.stop();
});

test('every wipe tells the cache: drive lists and stats cached before a sign-out or a deleted account are read again from the empty phone', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  const qc = new QueryClient();
  const off = subscribeInvalidation(qc);
  for (const wipe of [() => wipeForSignOut(db), () => wipeDevice(db)]) {
    qc.setQueryData(queryKeys.recentDrives(5), [{ clientTripId: uuid(1) }]);
    expect(qc.getQueryState(queryKeys.recentDrives(5))?.isInvalidated).toBe(false);
    await wipe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(qc.getQueryState(queryKeys.recentDrives(5))?.isInvalidated).toBe(true);
  }
  off();
  await rt.stop();
});

test('a handover keeps the incoming driver’s unsent Terms tick through the wipe, and drops the previous driver’s', async () => {
  const settings = createSettingsRepo(db);
  await bootstrapApp(deps().deps).then((rt) => rt.stop());
  await settings.set('auth.pendingTerms', { version: 'v1', at: T0, uid: 'user-2' });
  expect(await ensureDeviceOwner(db, 'user-2')).toBe('wiped');
  expect(await settings.get('auth.pendingTerms')).toEqual({ version: 'v1', at: T0, uid: 'user-2' });

  await settings.set('auth.pendingTerms', { version: 'v1', at: T0, uid: 'user-2' });
  expect(await ensureDeviceOwner(db, 'user-3')).toBe('wiped');
  expect(await settings.get('auth.pendingTerms')).toBeNull();

  await settings.set('auth.pendingTerms', { version: 'v1', at: T0, uid: 'user-3', sent: true });
  expect(await ensureDeviceOwner(db, 'user-4')).toBe('wiped');
  expect(await settings.get('auth.pendingTerms')).toBeNull();
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
  await settings.set('dashcam.paired', { dashcamId: 'a4cf12b3c4d5', peripheralId: 'p', name: 'DashPal-C4D5', pairedAt: 1, secure: true });
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
  expect(await settings.get('dashcam.paired')).toEqual({ dashcamId: 'a4cf12b3c4d5', peripheralId: 'p', name: 'DashPal-C4D5', pairedAt: 1, secure: true });
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

test('flushBeforeSignOut first makes a held upload due: no drive continues after a sign-out', async () => {
  const d = deps();
  const rt = await bootstrapApp(d.deps);
  await db.execute(
    "INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at) VALUES ('finalize-trip', '{}', 'trip:x', 'pending', 0, ?, 0)",
    [clock + 300_000]
  );
  await flushBeforeSignOut(rt);
  const item = await createQueueRepo(db).byKey('trip:x');
  expect(item!.next_attempt_at).toBeLessThanOrEqual(clock);
  await rt.stop();
});

test('iOS: every session end disarms automatic drives, then ends an open drive under the owner; drives that start after it are refused', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const d = deps();
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  const rt = await bootstrapApp({ ...d.deps, detect });
  // A revoked session: no sign-out flow ran, no wipe (uploads may be owed), only the session's end.
  d.supabase.setUid(null);
  await endSession(rt);
  expect(detect.snapshot.armed).toBe(false);
  expect(rt.drive.signedIn()).toBe(false);
  // Native was already sensing a candidate and confirms: nothing is recorded with nobody signed in.
  detect.wake('region');
  detect.confirm({ driveId: uuid(13), startedAt: clock, rows: rows(30, { t0: clock }).map((r) => ({ ...r })) });
  await new Promise((r) => setTimeout(r, 0));
  await rt.drive.settled();
  expect(rt.drive.snapshot().status).toBe('idle');
  expect(await createTripsRepo(db).get(uuid(13))).toBeNull();
  await rt.stop();
});

test('iOS: a launch whose session cannot be read (an expired token, no network) keeps the owner signed in and automatic drives armed', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const d = deps();
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  // auth-js answers no session and the refresh's error when the stored token expired offline.
  const supabase = {
    ...d.supabase,
    auth: { ...d.supabase.auth, getSession: async () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Network request failed' } }) },
  } as unknown as BootSupabase;
  const rt = await bootstrapApp({ ...d.deps, supabase, detect });
  expect(rt.owner).toBe('same');
  expect(rt.drive.signedIn()).toBe(true);
  const jobs = await startForegroundJobs(rt, { appState: d.appState, onError: () => {} });
  await new Promise((r) => setTimeout(r, 0));
  expect(detect.snapshot).toMatchObject({ armed: true, ownerId: 'user-1' });
  expect(detect.calls).not.toContain('setArmed:false');
  await jobs.stop();
  await rt.stop();
});

test('iOS: a launch for a different driver wipes native’s journals before the host looks: the last driver’s drive is never stored for the new one', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  expect(await readDeviceOwner(db)).toBe('user-1');
  // user-1's drive, ended by native while JS was away and never taken in.
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  detect.wake();
  detect.confirm({ driveId: uuid(12), startedAt: clock - 120_000, rows: rows(100, { t0: clock - 120_000 }).map((r) => ({ ...r })) });
  detect.endFor('still', clock - 10_000);
  const wipe = jest.fn(async () => {
    for (const j of await detect.listDrives()) await detect.discardDrive(j.driveId);
  });
  Object.assign(detect, { wipe });
  const other = deps();
  other.supabase.setUid('user-2');
  const rt = await bootstrapApp({ ...other.deps, detect });
  expect(rt.owner).toBe('wiped');
  expect(wipe).toHaveBeenCalledTimes(1);
  expect(detect.snapshot.armed).toBe(false);
  expect(await createTripsRepo(db).get(uuid(12))).toBeNull();
  expect(await createTripsRepo(db).count()).toBe(0);
  await rt.stop();
});

test('a "Not driving?" the last process was killed in the middle of is finished at launch: the drive is never recovered or recorded again', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  detect.wake();
  const list = rows(60, { t0: clock - 60_000 });
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(14), started_at: clock - 60_000, tz: TZ, status: 'recording', origin: 'auto', last_seq: 30 }, clock);
  await createSamplesRepo(db).appendMany(uuid(14), list.slice(0, 30).map((r) => ({ ts: r.ts, row: r })));
  detect.confirm({ driveId: uuid(14), startedAt: clock - 60_000, rows: list.map((r) => ({ ...r })) });
  await createSettingsRepo(db).set('drive.cancelling', { clientTripId: uuid(14), driveId: uuid(14) });
  const rt = await bootstrapApp({ ...deps().deps, detect });
  expect(rt.adopted).toBeNull();
  expect(rt.drive.snapshot().status).toBe('idle');
  expect(await trips.get(uuid(14))).toBeNull();
  expect(detect.calls).toContain('notDriving');
  expect(detect.journal.has(uuid(14))).toBe(false);
  expect(await createSettingsRepo(db).get('drive.cancelling')).toBeNull();
  await rt.stop();
});

test('iOS: a drive native journals is continued at launch whatever the capture says, and taken in from the journal', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const ios = deps();
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  detect.wake();
  // The trip and 60 s of samples are stored; native kept journaling 120 s.
  const list = rows(120, { t0: clock - 120_000 });
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(9), started_at: clock - 120_000, tz: TZ, status: 'recording', origin: 'auto', last_seq: 60 }, clock);
  await createSamplesRepo(db).appendMany(uuid(9), list.slice(0, 60).map((r) => ({ ts: r.ts, row: { ...r, seq: list.indexOf(r) + 1 } })));
  detect.confirm({ driveId: uuid(9), startedAt: clock - 120_000, rows: list.map((r) => ({ ...r })) });
  const rt = await bootstrapApp({ ...ios.deps, detect });
  expect(rt.adopted).toBe(uuid(9));
  expect(rt.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(9), origin: 'auto', lastRowTs: list.at(-1)!.ts });
  expect(detect.calls).toContain(`readRows:${uuid(9)}:60:300`);
  await rt.stop({ endOpenTrip: false });
});

test('iOS: a relaunch in the middle of an automatic drive the driving screen was shown for keeps it entered; another drive does not', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const relaunch = async (id: string, written: string) => {
    resetDriveScreenPresence();
    await createSettingsRepo(db).set(DRIVE_SCREEN_ENTERED_KEY, written);
    const detect = createFakeDriveDetect({ now: () => clock });
    await detect.setArmed(true, 'user-1');
    detect.wake();
    const list = rows(120, { t0: clock - 120_000 });
    await createTripsRepo(db).insert({ client_trip_id: id, started_at: clock - 120_000, tz: TZ, status: 'recording', origin: 'auto', last_seq: 0 }, clock);
    detect.confirm({ driveId: id, startedAt: clock - 120_000, rows: list.map((r) => ({ ...r })) });
    const rt = await bootstrapApp({ ...deps().deps, detect });
    expect(rt.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: id, origin: 'auto' });
    return rt;
  };
  const rt = await relaunch(uuid(18), uuid(18));
  const entered = driveScreenEnteredFor(uuid(18));
  await rt.stop({ endOpenTrip: false });
  expect(entered).toBe(true);

  const rt2 = await relaunch(uuid(19), uuid(18));
  const other = driveScreenEnteredFor(uuid(19));
  // Shown now: written down for the next relaunch.
  setDriveScreenFocused(true, uuid(19));
  setDriveScreenFocused(false, uuid(19));
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  const written = await createSettingsRepo(db).get(DRIVE_SCREEN_ENTERED_KEY);
  await rt2.stop({ endOpenTrip: false });
  resetDriveScreenPresence();
  expect(other).toBe(false);
  expect(written).toBe(uuid(19));
});

test('iOS: the recap notifier is attached before the boot, so a drive native ended while no process ran, stored by the boot, reaches it', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  // A drive native ended while JS was away (the process was gone), never taken in.
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  detect.wake();
  detect.confirm({ driveId: uuid(15), startedAt: clock - 600_000, rows: rows(590, { t0: clock - 600_000 }).map((r) => ({ ...r })) });
  detect.endFor('still', clock - 10_000);
  const seen: { booted: boolean | undefined; first: unknown; finalized: string[] } = { booted: undefined, first: undefined, finalized: [] };
  const detach = jest.fn();
  const attachSummaryNotifier = (host: DriveHost) => {
    seen.booted = host.booted?.();
    seen.first = host.snapshot().lastFinalized;
    host.subscribe((s) => {
      const f = s.lastFinalized;
      if (f !== null && f.ok && !seen.finalized.includes(f.clientTripId)) seen.finalized.push(f.clientTripId);
    });
    return { detach, settled: async () => {} };
  };
  const rt = await bootstrapApp({ ...deps().deps, detect, attachSummaryNotifier });
  expect(seen.booted).toBe(false);
  expect(seen.first).toBeNull();
  expect(seen.finalized).toEqual([uuid(15)]);
  expect(await createTripsRepo(db).get(uuid(15))).not.toBeNull();
  await rt.stop();
  expect(detach).toHaveBeenCalledTimes(1);
});

test('an orphan crash recovery stores at launch is handed to the recap notifier after the boot; one it drops is not', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  const trips = createTripsRepo(db);
  // Kept: 300 s of driving that ended just now, its capture gone.
  await trips.insert({ client_trip_id: uuid(16), started_at: clock - 300_000, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(16), rows(300, { t0: clock - 300_000 }).map((r) => ({ ts: r.ts, row: r })));
  // Dropped: it never moved.
  await trips.insert({ client_trip_id: uuid(17), started_at: clock - 600_000, tz: TZ, status: 'recording' }, clock);
  await createSamplesRepo(db).appendMany(uuid(17), rows(300, { t0: clock - 600_000, speedMps: 0 }).map((r) => ({ ts: r.ts, row: r })));
  const handed: { booted: boolean | undefined; drives: unknown[] }[] = [];
  const attachSummaryNotifier = (host: DriveHost) => ({
    detach: () => {},
    announceStored: (drives: readonly unknown[]) => void handed.push({ booted: host.booted?.(), drives: [...drives] }),
  });
  const rt = await bootstrapApp({ ...deps().deps, attachSummaryNotifier });
  expect(rt.recovery).toMatchObject({ finalized: [uuid(16)], dropped: [uuid(17)] });
  const stored = await trips.get(uuid(16));
  expect(handed).toEqual([
    {
      booted: true,
      drives: [
        {
          clientTripId: uuid(16),
          ok: true,
          status: 'pending',
          dropped: null,
          endCause: 'orphan',
          at: clock,
          durationS: stored!.duration_s,
          miles: stored!.miles,
          endedAt: stored!.ended_at,
        },
      ],
    },
  ]);
  expect(stored!.ended_at).toEqual(expect.any(Number));
  await rt.stop();
});

test('a boot that fails takes the recap notifier down with it', async () => {
  const detach = jest.fn();
  const failing = deps({
    attachSummaryNotifier: (host: DriveHost) => {
      Object.assign(host, {
        boot: async () => {
          throw new Error('boot failed');
        },
      });
      return { detach };
    },
    timeoutMs: 5_000,
  });
  await expect(bootstrapApp(failing.deps)).rejects.toThrow();
  expect(detach).toHaveBeenCalledTimes(1);
});

test('the default speed-limit client hands its options to the network: a re-ask for a tile that came back filling misses every HTTP cache', async () => {
  const asked: { name: string; headers: Record<string, string> | undefined }[] = [];
  const speedLimitsSupabase = {
    functions: {
      invoke: async (name: string, options: { headers?: Record<string, string> }) => {
        asked.push({ name, headers: options.headers });
        const keys = new URLSearchParams(name.slice(name.indexOf('?') + 1)).get('tiles')!.split(',');
        return { data: { tiles: keys.map((tile) => ({ tile, expiresAt: clock + 60_000, truncated: false, filling: true, segments: [] })), fallback: null }, error: null };
      },
    },
  };
  const rt = await bootstrapApp({ ...deps().deps, limits: undefined, speedLimitsSupabase });
  rt.limits.startTrip(47.6062, -122.3321, 90);
  await rt.limits.settled();
  expect(asked.length).toBeGreaterThan(0);
  // An ordinary batch: cacheable (no one-off value, no Cache-Control).
  expect(asked.every((a) => !a.name.includes('fresh=') && a.headers === undefined)).toBe(true);
  const before = asked.length;
  // The filling tiles expire after 5 s; the kilometre prefetch over them asks past the cache.
  clock += 5_000;
  rt.limits.prefetch(47.6062, -122.3321, 90);
  await rt.limits.settled();
  const again = asked.slice(before);
  expect(again.length).toBeGreaterThan(0);
  expect(again[0]!.name).toMatch(/^speed-limits\?tiles=[^&]+&fresh=[0-9a-z]+$/);
  expect(again[0]!.headers).toEqual({ 'Cache-Control': 'no-cache' });
  await rt.stop();
});

test('iOS: the default push-to-start asks the server over the launch’s client with this install’s id, and a refusal reaches the host with its reason', async () => {
  const seed = await bootstrapApp(deps().deps);
  await seed.stop();
  await createSettingsRepo(db).set(INSTALL_ID_KEY, 'install-0001');
  const background = deps();
  background.appState.set('background');
  const detect = createFakeDriveDetect({ now: () => clock });
  await detect.setArmed(true, 'user-1');
  detect.wake();
  // An automatic drive native confirmed while RoadWise was behind, 30 s of it journaled.
  const list = rows(30, { t0: clock - 30_000 });
  detect.confirm({ driveId: uuid(21), startedAt: clock - 30_000, rows: list.map((r) => ({ ...r })) });
  const supabase = createFakeSupabase({
    uid: 'user-1',
    invoke: (call) => (call.name === 'live-activity-start' ? invokeOk({ sent: false, reason: 'no_token' }) : invokeOk({})),
    rpc: () => ({ data: [], error: null }),
  });
  const display = { start: jest.fn(), update: jest.fn(), refresh: jest.fn(), end: jest.fn(), isRunning: async () => false };
  const errors: string[] = [];
  const source = createFakeDriveSense({ platform: 'ios', now: () => clock });
  source.setState({ location: 'always', motion: 'granted' });
  const rt = await bootstrapApp({
    ...background.deps,
    supabase: supabase as unknown as BootSupabase,
    source,
    detect,
    display,
    onError: (e, ctx) => void errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
  });
  expect(rt.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(21) });
  await rt.drive.settled();
  await new Promise((r) => setTimeout(r, 0));
  await rt.drive.settled();
  const asks = supabase.invokes.filter((c) => c.name === 'live-activity-start');
  expect(asks).toHaveLength(1);
  expect(asks[0]!.body).toMatchObject({ deviceId: 'install-0001', clientTripId: uuid(21), leg: 0, startedAt: clock - 30_000 });
  // The server's own reason, not a bare false: no token is not worth a retry.
  expect(errors).toContain('drive pushToStart: push-to-start not sent: no_token');
  await rt.stop({ endOpenTrip: false });
});
