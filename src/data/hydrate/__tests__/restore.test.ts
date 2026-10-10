/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { restoreDrives, toEventRows } from '@/data/hydrate/restore';
import { readDriveCount, readRecentDrives } from '@/data/queries/drives';

const T0 = 1_700_000_000_000;

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
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

test('a device that holds drives is left alone; a malformed row is skipped', async () => {
  await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: 'UTC', status: 'scored' }, T0);
  expect(await restoreDrives({ db, rpc: async () => [serverDrive(1)] })).toMatchObject({ skipped: true, restored: 0 });
  await db.execute('DELETE FROM trips');
  expect(await restoreDrives({ db, rpc: async () => [{ bogus: true }, serverDrive(1)] })).toMatchObject({ restored: 1 });
});

test('a restored removed event keeps its accepted report, so Report is not offered again', () => {
  const e = { id: uuid(900), type: 'speeding' as const, tier: 'minor' as const, startedAt: T0, durationS: 8, penalty: 0 };
  const d = { clientTripId: uuid(901), events: [{ ...e, status: 'removed' as const }, { ...e, id: uuid(902), status: 'active' as const }, { ...e, id: uuid(903), status: 'active' as const, disputeStatus: 'rejected' as const }] };
  const rows = toEventRows(d as unknown as Parameters<typeof toEventRows>[0]);
  expect(rows.map((r) => r.dispute_status)).toEqual(['accepted', 'none', 'rejected']);
});
