/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { MissingTripError } from '@/data/db/errors';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createTripsRepo } from '@/data/db/trips';

const T0 = 1_700_000_000_000;

let db: Db;
let events: ReturnType<typeof createEventsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  events = createEventsRepo(db);
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: 'trip-1', started_at: T0, tz: 'UTC', status: 'final' }, T0);
  await trips.insert({ client_trip_id: 'trip-2', started_at: T0, tz: 'UTC', status: 'final' }, T0);
});

test('insert returns the stored row with the schema defaults filled in', async () => {
  const row = await events.insert({
    id: 'e1',
    client_trip_id: 'trip-1',
    category: 'hard_brake',
    started_at: T0 + 1000,
  });

  expect(row).toEqual({
    id: 'e1',
    client_trip_id: 'trip-1',
    category: 'hard_brake',
    started_at: T0 + 1000,
    duration_s: 0,
    lat: null,
    lng: null,
    measured_json: null,
    severity: null,
    confidence: null,
    context_json: null,
    deduction: null,
    alert_shown: 0,
    corrected: 0,
    status: null,
    source: null,
  });
});

test('insert stores the measured and context payloads verbatim', async () => {
  const row = await events.insert({
    id: 'e1',
    client_trip_id: 'trip-1',
    category: 'speeding',
    started_at: T0,
    duration_s: 12.5,
    lat: 47.606,
    lng: -122.332,
    measured_json: JSON.stringify({ overMph: 11 }),
    severity: 'major',
    confidence: 0.82,
    context_json: JSON.stringify({ night: true }),
    deduction: 3.5,
    alert_shown: 1,
    source: 'gps',
  });

  expect(JSON.parse(row.measured_json ?? 'null')).toEqual({ overMph: 11 });
  expect(JSON.parse(row.context_json ?? 'null')).toEqual({ night: true });
  expect(row.alert_shown).toBe(1);
  expect(row.severity).toBe('major');
  expect(row.source).toBe('gps');
});

test('insertMany writes the whole batch', async () => {
  const rows = await events.insertMany([
    { id: 'e2', client_trip_id: 'trip-1', category: 'phone', started_at: T0 + 2000 },
    { id: 'e1', client_trip_id: 'trip-1', category: 'hard_brake', started_at: T0 + 1000 },
  ]);

  expect(rows.map((r) => r.id)).toEqual(['e2', 'e1']);
  await expect(events.countByTrip('trip-1')).resolves.toBe(2);
});

test('insertMany is all-or-nothing when one row names a trip that is not there', async () => {
  const batch = [
    { id: 'e1', client_trip_id: 'trip-1', category: 'phone', started_at: T0 },
    { id: 'e2', client_trip_id: 'ghost', category: 'phone', started_at: T0 },
  ];

  // The parent check runs before any row is written, so this holds on a driver that does not
  // enforce foreign keys inside a transaction as well as on one that does.
  await expect(events.insertMany(batch)).rejects.toThrow(MissingTripError);
  await expect(events.insertMany(batch)).rejects.toThrow(/ghost/);

  await expect(events.countByTrip('trip-1')).resolves.toBe(0);
  const all = await db.execute('SELECT count(*) AS n FROM trip_events');
  expect(all.rows).toEqual([{ n: 0 }]);
});

test('an event cannot reference a trip that is not there', async () => {
  await expect(
    events.insert({ id: 'e1', client_trip_id: 'ghost', category: 'phone', started_at: T0 })
  ).rejects.toThrow(MissingTripError);

  const all = await db.execute('SELECT count(*) AS n FROM trip_events');
  expect(all.rows).toEqual([{ n: 0 }]);
});

test('MissingTripError names the trip that was missing', async () => {
  expect.assertions(3);
  try {
    await events.insert({ id: 'e1', client_trip_id: 'ghost', category: 'phone', started_at: T0 });
  } catch (error) {
    expect(error).toBeInstanceOf(MissingTripError);
    expect((error as MissingTripError).clientTripId).toBe('ghost');
    expect((error as MissingTripError).name).toBe('MissingTripError');
  }
});

test('listByTrip is oldest first and scoped to the one trip', async () => {
  await events.insert({
    id: 'b',
    client_trip_id: 'trip-1',
    category: 'phone',
    started_at: T0 + 2000,
  });
  await events.insert({
    id: 'a',
    client_trip_id: 'trip-1',
    category: 'hard_brake',
    started_at: T0 + 1000,
  });
  await events.insert({ id: 'c', client_trip_id: 'trip-2', category: 'phone', started_at: T0 });

  const rows = await events.listByTrip('trip-1');
  expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
});

test('get returns null for an event that is not there', async () => {
  await expect(events.get('nope')).resolves.toBeNull();
});

test('update marks an event corrected after a dispute', async () => {
  await events.insert({
    id: 'e1',
    client_trip_id: 'trip-1',
    category: 'speeding',
    started_at: T0,
    deduction: 4,
  });

  const updated = await events.update('e1', { corrected: 1, deduction: 0, status: 'dismissed' });

  expect(updated).toMatchObject({ corrected: 1, deduction: 0, status: 'dismissed' });
});

test('update returns null for an event that is not there', async () => {
  await expect(events.update('nope', { corrected: 1 })).resolves.toBeNull();
});

test('removeByTrip clears one trip and leaves the others alone', async () => {
  await events.insert({ id: 'a', client_trip_id: 'trip-1', category: 'phone', started_at: T0 });
  await events.insert({ id: 'b', client_trip_id: 'trip-1', category: 'phone', started_at: T0 + 1 });
  await events.insert({ id: 'c', client_trip_id: 'trip-2', category: 'phone', started_at: T0 });

  await expect(events.removeByTrip('trip-1')).resolves.toBe(2);
  await expect(events.countByTrip('trip-1')).resolves.toBe(0);
  await expect(events.countByTrip('trip-2')).resolves.toBe(1);
});
