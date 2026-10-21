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
  await trips.insert({ client_trip_id: 'a', started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  await trips.insert({ client_trip_id: 'b', started_at: T0 + 1, tz: 'UTC', status: 'pending' }, T0);
});

test('insert applies the defaults; listByTrip is oldest first', async () => {
  await events.insert({ id: 'e2', client_trip_id: 'a', type: 'hard_brake', tier: 'severe', started_at: T0 + 2000 });
  await events.insert({ id: 'e1', client_trip_id: 'a', type: 'speeding', tier: 'minor', started_at: T0 + 1000, duration_s: 12, measured_json: '{"overMphS":42.5}' });
  const list = await events.listByTrip('a');
  expect(list.map((e) => e.id)).toEqual(['e1', 'e2']);
  expect(list[0]).toMatchObject({ duration_s: 12, measured_json: '{"overMphS":42.5}' });
  expect(list[1]).toEqual({
    id: 'e2',
    client_trip_id: 'a',
    type: 'hard_brake',
    tier: 'severe',
    started_at: T0 + 2000,
    duration_s: 0,
    lat: null,
    lng: null,
    measured_json: null,
    status: 'active',
    dispute_status: 'none',
    dispute_reason: null,
    dispute_message: null,
  });
});

test('insertMany is all or nothing and refuses an unknown trip explicitly', async () => {
  await expect(
    events.insertMany([
      { id: 'e1', client_trip_id: 'a', type: 'speeding', tier: 'minor', started_at: T0 },
      { id: 'e2', client_trip_id: 'nope', type: 'speeding', tier: 'minor', started_at: T0 },
    ])
  ).rejects.toBeInstanceOf(MissingTripError);
  expect(await events.listByTrip('a')).toEqual([]);
});

test('update settles a dispute; reparent moves a merged drive’s events', async () => {
  await events.insert({ id: 'e1', client_trip_id: 'b', type: 'hard_corner', tier: 'severe', started_at: T0 });
  await events.update('e1', { dispute_status: 'accepted', status: 'removed' });
  expect(await events.get('e1')).toMatchObject({ dispute_status: 'accepted', status: 'removed' });
  expect(await events.reparent('b', 'a')).toBe(1);
  expect((await events.listByTrip('a')).map((e) => e.id)).toEqual(['e1']);
  await expect(events.reparent('a', 'nope')).rejects.toBeInstanceOf(MissingTripError);
});

test('removeByTrip', async () => {
  await events.insert({ id: 'e1', client_trip_id: 'a', type: 'speeding', tier: 'minor', started_at: T0 });
  expect(await events.removeByTrip('a')).toBe(1);
  expect(await events.listByTrip('a')).toEqual([]);
});
