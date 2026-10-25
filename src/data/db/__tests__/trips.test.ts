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
    night_miles: 0,
    clean: null,
    counts_json: null,
    origin: 'manual',
    not_driving_expired: 0,
    finalized_at: null,
    start_source: null,
    last_seq: null,
    slowdowns: null,
    speedups: null,
    turns: null,
    limit_s: null,
    moving_s: null,
    created_at: T0,
    updated_at: T0,
  });
  expect(row).not.toHaveProperty('points_net');
  expect(row).not.toHaveProperty('safe_miles');
});

test('update changes the named columns, moves updated_at and answers null for an unknown trip', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording', origin: 'auto', start_source: 'motion', start_lat: 47.6, start_lng: -122.3 }, T0);
  const after = await trips.update(
    'a',
    { status: 'pending', miles: 12.5, clean: 0, not_driving_expired: 1, slowdowns: 4, speedups: 3, turns: 6, limit_s: 500, moving_s: 900, last_seq: 812 },
    T0 + 5
  );
  expect(after).toMatchObject({
    status: 'pending',
    miles: 12.5,
    clean: 0,
    origin: 'auto',
    start_source: 'motion',
    start_lat: 47.6,
    start_lng: -122.3,
    not_driving_expired: 1,
    slowdowns: 4,
    speedups: 3,
    turns: 6,
    limit_s: 500,
    moving_s: 900,
    last_seq: 812,
    updated_at: T0 + 5,
  });
  expect(await trips.update('nope', { status: 'pending' })).toBeNull();
});

test('list is newest first; listRecording picks the drives still recording', async () => {
  await trips.insert({ client_trip_id: 'old', started_at: T0, tz: 'UTC', status: 'scored' }, T0);
  await trips.insert({ client_trip_id: 'mid', started_at: T0 + 1000, tz: 'UTC', status: 'not_driving' }, T0);
  await trips.insert({ client_trip_id: 'new', started_at: T0 + 2000, tz: 'UTC', status: 'recording' }, T0);
  expect((await trips.list()).map((t) => t.client_trip_id)).toEqual(['new', 'mid', 'old']);
  expect((await trips.listRecording()).map((t) => t.client_trip_id)).toEqual(['new']);
  expect(await trips.count()).toBe(3);
});

test('remove takes the trip with its events, samples and DashPal coverage', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at) VALUES ('e1', 'a', 'speeding', 'minor', 1)");
  await db.execute("INSERT INTO samples (client_trip_id, ts, row_json) VALUES ('a', 1, '{}')");
  await db.execute("INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES ('a', 3, 2)");
  // Foreign keys may be off in a device transaction: the coverage goes by hand, not by cascade.
  await db.execute('PRAGMA foreign_keys = OFF');
  expect(await trips.remove('a')).toBe(true);
  expect((await db.execute('SELECT * FROM trip_events')).rows).toEqual([]);
  expect((await db.execute('SELECT * FROM samples')).rows).toEqual([]);
  expect((await db.execute('SELECT * FROM dashcam_coverage')).rows).toEqual([]);
  expect(await trips.remove('a')).toBe(false);
});
