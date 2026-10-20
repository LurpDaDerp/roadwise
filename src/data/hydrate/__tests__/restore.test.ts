/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { onDataChanged } from '@/data/events';
import { RESTORED_AT_KEY, RestoreAbandonedError, restoreDrives, toEventRows } from '@/data/hydrate/restore';
import { readDriveCount, readRecentDrives } from '@/data/queries/drives';

const T0 = 1_700_000_000_000;

let db: Db;
const UID = 'user-1';

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', UID);
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
  pointsNet: 30,
  breakdown: null,
  result: { net: 30 },
  events: [{ id: uuid(500 + n), type: 'speeding', tier: 'minor', startedAt: T0 - n * 3_600_000 + 60_000, durationS: 8, units: null, stoppedInTraffic: null, lat: null, lng: null, measured: { speedMph: 41 }, penalty: 15, status: 'active' }],
  ...over,
});

test('an empty device is restored page by page, newest first; events come along', async () => {
  const pages: Record<string, unknown>[][] = [[serverDrive(1), serverDrive(2)], [serverDrive(3, { notDriving: true, pointsNet: 0 })]];
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
  expect(drives[0]).toMatchObject({ clientTripId: uuid(1), pointsNet: 30, estimate: false, counts: expect.objectContaining({ speeding: 1 }), polyline: '_p~iF~ps|U' });
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
  const e = { id: uuid(900), type: 'speeding' as const, tier: 'minor' as const, startedAt: T0, durationS: 8, penalty: 0 };
  const d = { clientTripId: uuid(901), events: [{ ...e, status: 'removed' as const }, { ...e, id: uuid(902), status: 'active' as const }, { ...e, id: uuid(903), status: 'active' as const, disputeStatus: 'rejected' as const }] };
  const rows = toEventRows(d as unknown as Parameters<typeof toEventRows>[0]);
  expect(rows.map((r) => r.dispute_status)).toEqual(['accepted', 'none', 'rejected']);
});
