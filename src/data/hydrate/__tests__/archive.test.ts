/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createRoutePoolRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { onDataChanged } from '@/data/events';
import { archiveOldDrives } from '@/data/hydrate/archive';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createTripsRepo(db).insert(
    { client_trip_id: 'old', started_at: NOW - 200 * DAY - 600_000, ended_at: NOW - 200 * DAY, tz: 'UTC', status: 'scored', miles: 5, polyline: 'route-old' },
    NOW
  );
});

const settle = () => new Promise((r) => setTimeout(r, 0));

test('archives what is due, and tells the screens', async () => {
  const changes: string[] = [];
  const off = onDataChanged((c) => changes.push(c.source));
  expect(await archiveOldDrives(db, NOW)).toBe(1);
  await settle();
  expect(changes).toEqual(['hydrate']);
  expect(await createTripsRepo(db).get('old')).toMatchObject({ archived_at: NOW, polyline: null });
  expect(await createRoutePoolRepo(db).list()).toEqual(['route-old']);
  off();
});

test('with nothing due it writes nothing and says nothing', async () => {
  const changes: string[] = [];
  const off = onDataChanged((c) => changes.push(c.source));
  expect(await archiveOldDrives(db, NOW - 30 * DAY)).toBe(0);
  await settle();
  expect(changes).toEqual([]);
  expect(await createTripsRepo(db).get('old')).toMatchObject({ archived_at: null, polyline: 'route-old' });
  off();
});

test('a drive under way keeps the database: nothing is archived and the job says so (null)', async () => {
  await createTripsRepo(db).insert({ client_trip_id: 'live', started_at: NOW - 60_000, tz: 'UTC', status: 'recording' }, NOW);
  expect(await archiveOldDrives(db, NOW)).toBeNull();
  expect(await createTripsRepo(db).get('old')).toMatchObject({ archived_at: null, polyline: 'route-old' });
  await createTripsRepo(db).update('live', { status: 'pending', ended_at: NOW }, NOW);
  expect(await archiveOldDrives(db, NOW)).toBe(1);
});
