/** @jest-environment node */
import { uuid } from '@/data/sync/__fixtures__/drives';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { onDataChanged } from '@/data/events';
import { applyServerDrive, RESTORED_AT_KEY, RestoreAbandonedError, restoreDrives, ServerDriveSchema, toEventRows, toTripRow } from '@/data/hydrate/restore';
import { readDriveCount, readRecentDrives } from '@/data/queries/drives';

const T0 = 1_700_000_000_000;

let db: Db;
const UID = 'user-1';

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', UID);
});

const ANSWER = (n: number) => ({
  tripId: uuid(100 + n),
  clientTripId: uuid(n),
  mergedInto: null,
  scored: true,
  reason: null,
  eventIds: [uuid(500 + n)],
  rating: { safetyRating: 88, ranked: true },
  challenges: [],
  achievements: [],
});

const serverDrive = (n: number, over: Record<string, unknown> = {}) => ({
  tripId: uuid(100 + n),
  clientTripId: uuid(n),
  startedAt: T0 - n * 3_600_000,
  endedAt: T0 - n * 3_600_000 + 600_000,
  tz: 'America/Los_Angeles',
  localDay: '2023-11-14',
  leagueWeek: '2023-W46',
  miles: 5,
  safeMiles: 4.5,
  nightMiles: 0,
  durationS: 600,
  polyline: '_p~iF~ps|U',
  scored: true,
  reason: null,
  notDriving: false,
  clean: false,
  // what a server in the transition still sends for older builds: ignored
  pointsNet: null,
  origin: 'auto',
  notDrivingExpired: false,
  exposure: { slowdowns: 3, speedups: 2, turns: 4, limitS: 300, movingS: 500 },
  result: ANSWER(n),
  events: [{ id: uuid(500 + n), type: 'speeding', tier: 'minor', startedAt: T0 - n * 3_600_000 + 60_000, durationS: 8, lat: null, lng: null, measured: { speedMph: 41, overMphS: 9 }, status: 'active' }],
  ...over,
});

test('an empty device is restored page by page, newest first; events come along', async () => {
  const pages: Record<string, unknown>[][] = [[serverDrive(1), serverDrive(2)], [serverDrive(3, { notDriving: true })]];
  const calls: unknown[] = [];
  const result = await restoreDrives({
    db,
    uid: UID,
    pageSize: 2,
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      return pages.shift() ?? [];
    },
  });
  expect(result).toEqual({ skipped: false, restored: 3, complete: true });
  expect(calls[0]).toEqual(['list_my_drives', { p_limit: 2 }]);
  expect((calls[1] as [string, { p_before: string }])[1].p_before).toBe(new Date(T0 - 2 * 3_600_000).toISOString());
  const drives = await readRecentDrives(db, 10);
  expect(drives.map((d) => d.status)).toEqual(['scored', 'scored', 'not_driving']);
  expect(drives[0]).toMatchObject({
    clientTripId: uuid(1),
    origin: 'auto',
    notDrivingExpired: false,
    exposure: { slowdowns: 3, speedups: 2, turns: 4, limitS: 300, movingS: 500 },
    exposureEstimated: false,
    result: ANSWER(1),
    counts: expect.objectContaining({ speeding: 1 }),
    polyline: '_p~iF~ps|U',
  });
  expect(drives[0]).not.toHaveProperty('pointsNet');
  expect((await createEventsRepo(db).listByTrip(uuid(1)))[0]?.measured_json).toBe('{"speedMph":41,"overMphS":9}');
  expect(await createEventsRepo(db).listByTrip(uuid(1))).toHaveLength(1);
  expect(await readDriveCount(db)).toBe(2);
});

test('a drive the device already holds is kept as it is and the rest are filled in; a malformed row is skipped', async () => {
  // A drive recorded before the restore ran never stops it.
  await createTripsRepo(db).insert({ client_trip_id: uuid(1), started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  expect(await restoreDrives({ db, uid: UID, rpc: async () => [{ bogus: true }, serverDrive(1), serverDrive(2)] })).toMatchObject({ skipped: false, restored: 1 });
  expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'pending', started_at: T0 });
  expect(await createTripsRepo(db).get(uuid(2))).toMatchObject({ status: 'scored' });
});

test('a restore that ran to the end is not run again for that driver; another driver’s record does not count', async () => {
  const rpc = jest.fn(async () => [serverDrive(1)]);
  await restoreDrives({ db, uid: UID, rpc });
  expect(await createSettingsRepo(db).get(RESTORED_AT_KEY)).toMatchObject({ uid: UID });
  expect(await restoreDrives({ db, uid: UID, rpc })).toMatchObject({ skipped: true, restored: 0 });
  expect(rpc).toHaveBeenCalledTimes(1);
  await createSettingsRepo(db).set(RESTORED_AT_KEY, { uid: 'someone-else', at: T0 });
  expect(await restoreDrives({ db, uid: UID, rpc })).toMatchObject({ skipped: false });
});

test('a restore cut short keeps what it wrote, shows it, and the next run picks up the older pages', async () => {
  const changes: string[] = [];
  const off = onDataChanged((c) => changes.push(c.source));
  let fail = true;
  const rpc = async (_fn: string, args?: Record<string, unknown>) => {
    if (args?.p_before === undefined) return [serverDrive(1), serverDrive(2)];
    if (fail) throw new Error('offline');
    return [serverDrive(3)];
  };
  await expect(restoreDrives({ db, uid: UID, pageSize: 2, rpc })).rejects.toThrow('offline');
  expect(await createTripsRepo(db).count()).toBe(2);
  expect(await createSettingsRepo(db).get(RESTORED_AT_KEY)).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(changes).toContain('hydrate');
  fail = false;
  expect(await restoreDrives({ db, uid: UID, pageSize: 2, rpc })).toMatchObject({ restored: 1, complete: true });
  expect(await createTripsRepo(db).get(uuid(3))).not.toBeNull();
  off();
});

test('a restore that outlives its driver writes nothing more: another owner on the device, or the run no longer wanted', async () => {
  let page = 0;
  const rpc = async () => {
    page += 1;
    // A handover lands while the first page is out.
    if (page === 1) await createSettingsRepo(db).set('device.lastUserId', 'user-2');
    return [serverDrive(page)];
  };
  await expect(restoreDrives({ db, uid: UID, rpc })).rejects.toBeInstanceOf(RestoreAbandonedError);
  expect(await createTripsRepo(db).count()).toBe(0);
  expect(await createSettingsRepo(db).get(RESTORED_AT_KEY)).toBeNull();

  await createSettingsRepo(db).set('device.lastUserId', UID);
  let wanted = true;
  const later = async () => {
    wanted = false; // the session changed while the page was read
    return [serverDrive(5)];
  };
  await expect(restoreDrives({ db, uid: UID, rpc: later, isCurrent: () => wanted })).rejects.toBeInstanceOf(RestoreAbandonedError);
  expect(await createTripsRepo(db).count()).toBe(0);
});

test('a restored removed event keeps its accepted report, so Report is not offered again', () => {
  const e = { id: uuid(900), type: 'speeding' as const, tier: 'minor' as const, startedAt: T0, durationS: 8 };
  const d = { clientTripId: uuid(901), events: [{ ...e, status: 'removed' as const }, { ...e, id: uuid(902), status: 'active' as const }, { ...e, id: uuid(903), status: 'active' as const, disputeStatus: 'rejected' as const }] };
  const rows = toEventRows(d as unknown as Parameters<typeof toEventRows>[0]);
  expect(rows.map((r) => r.dispute_status)).toEqual(['accepted', 'none', 'rejected']);
});

test('a restored drive takes its watched miles from its DashPal seconds (0 from a server that sends none)', () => {
  expect(toTripRow({ ...ServerDriveSchema.parse(serverDrive(1)), miles: 20, dashcamMovingS: 1000, dashcamCoveredS: 250 }).watched_miles).toBe(5);
  expect(toTripRow(ServerDriveSchema.parse(serverDrive(1))).watched_miles).toBe(0);
});

test('an older server: no origin (a Start tap), no "Not driving?" verdict (never ran out), no counters (estimated at read)', () => {
  const { origin: _o, notDrivingExpired: _n, exposure: _e, ...old } = serverDrive(1);
  const parsed = ServerDriveSchema.parse(old);
  expect(parsed).toMatchObject({ origin: 'manual', notDrivingExpired: false });
  expect(toTripRow(parsed)).toMatchObject({ origin: 'manual', not_driving_expired: 0, slowdowns: null, speedups: null, turns: null, limit_s: null, moving_s: null, phone_s: 0 });
  expect(toTripRow(ServerDriveSchema.parse(serverDrive(1, { notDrivingExpired: true, exposure: { slowdowns: 1e9, speedups: 2.7, turns: -1, limitS: 900, movingS: 600 } })))).toMatchObject({
    not_driving_expired: 1,
    slowdowns: 20_000,
    speedups: 2,
    turns: 0,
    limit_s: 600,
    moving_s: 600,
    // a server before phone tracking sends no phone seconds: 0, never watched
    phone_s: 0,
  });
});

test('a drive restored from a server that tracks phone use reads its phone seconds (held within its moving time)', async () => {
  const exposure = { slowdowns: 3, speedups: 2, turns: 4, limitS: 300, movingS: 500 };
  expect(toTripRow(ServerDriveSchema.parse(serverDrive(1, { exposure: { ...exposure, phoneS: 420 } })))).toMatchObject({ moving_s: 500, phone_s: 420 });
  expect(toTripRow(ServerDriveSchema.parse(serverDrive(1, { exposure: { ...exposure, phoneS: 9000 } }))).phone_s).toBe(500);
  expect(toTripRow(ServerDriveSchema.parse(serverDrive(1, { exposure: { ...exposure, phoneS: null } }))).phone_s).toBe(0);
  expect(await restoreDrives({ db, uid: UID, rpc: async () => [serverDrive(1, { exposure: { ...exposure, phoneS: 420 } })] })).toMatchObject({ restored: 1 });
  expect((await readRecentDrives(db, 1))[0]).toMatchObject({ exposure: { ...exposure, phoneS: 420 }, exposureEstimated: false });
});

test('a phone pickup comes back with its seconds in hand and speeds; an event of a type this build does not know (an older phone event) is skipped and the drive is kept', async () => {
  const drive = serverDrive(1, {
    events: [
      { id: uuid(601), type: 'phone_pickup', tier: 'moderate', startedAt: T0 - 3_000_000, durationS: 12, measured: { speedMph: 35, maxSpeedMph: 41.5 }, status: 'active' },
      { id: uuid(602), type: 'hard_brake', tier: 'minor', startedAt: T0 - 3_100_000, durationS: 0, status: 'active' },
      { id: uuid(603), type: 'phone_handling', tier: 'moderate', startedAt: T0 - 3_050_000, durationS: 20, status: 'active' },
    ],
  });
  expect(await restoreDrives({ db, uid: UID, rpc: async () => [drive] })).toMatchObject({ restored: 1 });
  const events = await createEventsRepo(db).listByTrip(uuid(1));
  expect(events.map((e) => e.id).sort()).toEqual([uuid(601), uuid(602)]);
  expect(events.find((e) => e.id === uuid(601))).toMatchObject({ type: 'phone_pickup', tier: 'moderate', duration_s: 12, measured_json: '{"speedMph":35,"maxSpeedMph":41.5}' });
  expect(JSON.parse((await createTripsRepo(db).get(uuid(1)))!.counts_json!)).toMatchObject({ hardBrake: 1, pickups: 1 });
});

test('bringing a held drive in line with the server keeps the counters this phone counted and its origin; fills counters it lacks; a ran-out "Not driving?" sticks', async () => {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(1), started_at: T0, tz: 'UTC', status: 'pending', origin: 'manual', slowdowns: 9, speedups: 9, turns: 9, limit_s: 9, moving_s: 9 }, T0);
  await trips.insert({ client_trip_id: uuid(2), started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  await db.transaction(async (tx) => {
    await applyServerDrive(tx, ServerDriveSchema.parse(serverDrive(1, { notDrivingExpired: true })), T0 + 1);
    await applyServerDrive(tx, ServerDriveSchema.parse(serverDrive(2)), T0 + 1);
  });
  expect(await trips.get(uuid(1))).toMatchObject({ status: 'scored', origin: 'manual', not_driving_expired: 1, slowdowns: 9, moving_s: 9, server_id: uuid(101) });
  expect(await trips.get(uuid(2))).toMatchObject({ status: 'scored', not_driving_expired: 0, slowdowns: 3, speedups: 2, turns: 4, limit_s: 300, moving_s: 500 });
});
