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

test('the saved places at each end and the car are written and read back; null until set', async () => {
  expect(await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0)).toMatchObject({ from_place: null, to_place: null, car_uid: null, car_name: null, end_lat_full: null, end_lng_full: null });
  expect(await trips.update('a', { from_place: 'home', to_place: 'place-k3x-ab12', car_uid: 'AA:BB', car_name: 'Civic', end_lat_full: 47.60012, end_lng_full: -122.30034 }, T0 + 1)).toMatchObject({
    from_place: 'home',
    to_place: 'place-k3x-ab12',
    car_uid: 'AA:BB',
    car_name: 'Civic',
  });
  expect(await trips.get('a')).toMatchObject({ from_place: 'home', to_place: 'place-k3x-ab12', car_uid: 'AA:BB', car_name: 'Civic', end_lat_full: 47.60012, end_lng_full: -122.30034 });
});

test('the speed trace, limit buckets, weather and supervisor are written and read back; null until set', async () => {
  const none = { speed_trace_json: null, limit_buckets_json: null, weather: null, practice_supervisor: null };
  expect(await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0)).toMatchObject(none);
  const set = {
    speed_trace_json: '{"w":5,"p":[[0,12.5,25]]}',
    limit_buckets_json: '{"low":{"s":1,"m":9},"mid":{"s":0,"m":0},"high":{"s":0,"m":0}}',
    weather: 'snow' as const,
    practice_supervisor: 'Dad',
  };
  expect(await trips.update('a', set, T0 + 1)).toMatchObject(set);
  expect(await trips.get('a')).toMatchObject(set);
  // A supervisor reads back trimmed and clipped to 60 characters; a blank one is none.
  await trips.update('a', { practice_supervisor: `  ${'x'.repeat(80)} ` }, T0 + 2);
  expect((await trips.get('a'))?.practice_supervisor).toBe('x'.repeat(60));
  await trips.update('a', { practice_supervisor: '   ' }, T0 + 3);
  expect((await trips.get('a'))?.practice_supervisor).toBeNull();
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
