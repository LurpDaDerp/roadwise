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

test('insert returns the stored row with the schema defaults filled in', async () => {
  const row = await trips.insert(
    { client_trip_id: 'a', started_at: T0, tz: 'America/Los_Angeles', status: 'recording' },
    T0
  );

  expect(row).toMatchObject({
    client_trip_id: 'a',
    started_at: T0,
    ended_at: null,
    tz: 'America/Los_Angeles',
    distance_m: 0,
    duration_s: 0,
    camera_session: 0,
    status: 'recording',
    sync_state: 'local',
    checkpoint_ts: null,
    incomplete: 0,
    server_id: null,
    created_at: T0,
    updated_at: T0,
  });
});

test('insert stores the incomplete flag when given', async () => {
  const row = await trips.insert(
    { client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'provisional', incomplete: 1 },
    T0
  );
  expect(row.incomplete).toBe(1);
});

test('insert keeps the JSON columns as given', async () => {
  const row = await trips.insert(
    {
      client_trip_id: 'a',
      started_at: T0,
      tz: 'UTC',
      status: 'final',
      score: 87.5,
      scoring_version: '2.0.0',
      category_deductions_json: JSON.stringify({ speeding: 4 }),
      conditions_json: JSON.stringify({ night: true }),
      limit_coverage_pct: 92,
      start_geohash5: 'c23nb',
      polyline: 'abc',
    },
    T0
  );

  expect(row.score).toBe(87.5);
  expect(JSON.parse(row.category_deductions_json ?? 'null')).toEqual({ speeding: 4 });
  expect(JSON.parse(row.conditions_json ?? 'null')).toEqual({ night: true });
  expect(row.limit_coverage_pct).toBe(92);
  expect(row.start_geohash5).toBe('c23nb');
});

test('get returns null for a trip that is not there', async () => {
  await expect(trips.get('nope')).resolves.toBeNull();
});

test('list is newest first and honours limit and offset', async () => {
  await trips.insert({ client_trip_id: 'old', started_at: T0, tz: 'UTC', status: 'final' }, T0);
  await trips.insert({ client_trip_id: 'mid', started_at: T0 + 2000, tz: 'UTC', status: 'final' }, T0);
  await trips.insert({ client_trip_id: 'new', started_at: T0 + 4000, tz: 'UTC', status: 'final' }, T0);

  const all = await trips.list();
  expect(all.map((t) => t.client_trip_id)).toEqual(['new', 'mid', 'old']);

  const page = await trips.list({ limit: 1, offset: 1 });
  expect(page.map((t) => t.client_trip_id)).toEqual(['mid']);
});

test('list can filter by status', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'final' }, T0);
  await trips.insert({ client_trip_id: 'b', started_at: T0 + 1, tz: 'UTC', status: 'discarded' }, T0);

  const finals = await trips.list({ status: 'final' });
  expect(finals.map((t) => t.client_trip_id)).toEqual(['a']);
});

test('update patches only the named columns and bumps updated_at', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);

  const updated = await trips.update(
    'a',
    { ended_at: T0 + 60_000, distance_m: 1234.5, duration_s: 60, status: 'provisional' },
    T0 + 60_000
  );

  expect(updated).toMatchObject({
    client_trip_id: 'a',
    started_at: T0,
    tz: 'UTC',
    ended_at: T0 + 60_000,
    distance_m: 1234.5,
    duration_s: 60,
    status: 'provisional',
    created_at: T0,
    updated_at: T0 + 60_000,
  });
});

test('update with an empty patch still bumps updated_at', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  const updated = await trips.update('a', {}, T0 + 5);
  expect(updated?.updated_at).toBe(T0 + 5);
});

test('update returns null when the trip is not there', async () => {
  await expect(trips.update('nope', { distance_m: 1 }, T0)).resolves.toBeNull();
});

test('setStatus, setSyncState and checkpoint move the recorder state forward', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);

  await trips.checkpoint('a', T0 + 30_000, T0 + 30_000);
  expect((await trips.get('a'))?.checkpoint_ts).toBe(T0 + 30_000);

  await trips.setStatus('a', 'final', T0 + 60_000);
  expect((await trips.get('a'))?.status).toBe('final');

  await trips.setSyncState('a', 'queued', T0 + 61_000);
  const row = await trips.get('a');
  expect(row?.sync_state).toBe('queued');
  expect(row?.updated_at).toBe(T0 + 61_000);
});

test('findRecording returns the trip the engine is writing to, else null', async () => {
  await expect(trips.findRecording()).resolves.toBeNull();

  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'final' }, T0);
  await trips.insert({ client_trip_id: 'b', started_at: T0 + 1, tz: 'UTC', status: 'recording' }, T0);

  expect((await trips.findRecording())?.client_trip_id).toBe('b');
});

test('remove deletes the trip and everything hanging off it', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'final' }, T0);
  await db.execute(
    'INSERT INTO trip_events (id, client_trip_id, category, started_at) VALUES (?, ?, ?, ?)',
    ['e1', 'a', 'hard_brake', T0]
  );
  await db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [
    'a',
    T0,
    '{}',
  ]);

  await expect(trips.remove('a')).resolves.toBe(true);
  await expect(trips.remove('a')).resolves.toBe(false);
  await expect(trips.get('a')).resolves.toBeNull();

  const events = await db.execute('SELECT count(*) AS n FROM trip_events');
  const samples = await db.execute('SELECT count(*) AS n FROM samples');
  expect(events.rows).toEqual([{ n: 0 }]);
  expect(samples.rows).toEqual([{ n: 0 }]);
});

test('update on a transaction handle is undone when that transaction rolls back', async () => {
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  await expect(
    db.transaction(async (tx) => {
      await trips.update('a', { status: 'provisional', score: 74 }, T0 + 1, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  expect(await trips.get('a')).toMatchObject({ status: 'recording', score: null, updated_at: T0 });

  const updated = await db.transaction((tx) => trips.update('a', { status: 'provisional' }, T0 + 2, tx));
  expect(updated).toMatchObject({ status: 'provisional', updated_at: T0 + 2 });
});

test('insert and checkpoint on a transaction handle are undone when that transaction rolls back', async () => {
  await expect(
    db.transaction(async (tx) => {
      await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0, tx);
      await trips.checkpoint('a', T0 + 30_000, T0 + 30_000, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  await expect(trips.get('a')).resolves.toBeNull();

  const inserted = await db.transaction(async (tx) => {
    const row = await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'recording' }, T0, tx);
    await trips.checkpoint('a', T0 + 30_000, T0 + 30_000, tx);
    return row;
  });
  expect(inserted).toMatchObject({ client_trip_id: 'a', status: 'recording', checkpoint_ts: null });
  expect(await trips.get('a')).toMatchObject({ checkpoint_ts: T0 + 30_000, updated_at: T0 + 30_000 });
});
