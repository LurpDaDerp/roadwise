/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createTripsRepo } from '@/data/db/trips';

const T0 = 1_700_000_000_000;

let db: Db;
let trips: ReturnType<typeof createTripsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  trips = createTripsRepo(db);
});

test('insert applies the defaults and stamps created_at/updated_at', async () => {
  const row = await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  expect(row).toMatchObject({
    client_trip_id: 'a',
    status: 'recording',
    miles: 0,
    safe_miles: 0,
    night_miles: 0,
    estimate: 1,
    points_net: null,
    clean: null,
    counts_json: null,
    created_at: T0,
    updated_at: T0,
  });
});

test('update changes the named columns, moves updated_at and answers null for an unknown trip', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  const after = await trips.update('a', { status: 'pending', miles: 12.5, points_net: 167, estimate: 1, clean: 0 }, T0 + 5);
  expect(after).toMatchObject({ status: 'pending', miles: 12.5, points_net: 167, clean: 0, updated_at: T0 + 5 });
  expect(await trips.update('nope', { status: 'pending' })).toBeNull();
});

test('list is newest first; listRecording and latestFinished pick the right rows', async () => {
  await trips.insert({ client_trip_id: 'old', started_at: T0, tz: 'UTC', status: 'scored' }, T0);
  await trips.insert({ client_trip_id: 'mid', started_at: T0 + 1000, tz: 'UTC', status: 'merged' }, T0);
  await trips.insert({ client_trip_id: 'new', started_at: T0 + 2000, tz: 'UTC', status: 'recording' }, T0);
  expect((await trips.list()).map((t) => t.client_trip_id)).toEqual(['new', 'mid', 'old']);
  expect((await trips.listRecording()).map((t) => t.client_trip_id)).toEqual(['new']);
  expect((await trips.latestFinished())?.client_trip_id).toBe('old');
  expect(await trips.count()).toBe(3);
});

test('remove takes the trip with its events and samples', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at) VALUES ('e1', 'a', 'speeding', 'minor', 1)");
  await db.execute("INSERT INTO samples (client_trip_id, ts, row_json) VALUES ('a', 1, '{}')");
  expect(await trips.remove('a')).toBe(true);
  expect((await db.execute('SELECT * FROM trip_events')).rows).toEqual([]);
  expect((await db.execute('SELECT * FROM samples')).rows).toEqual([]);
  expect(await trips.remove('a')).toBe(false);
});
