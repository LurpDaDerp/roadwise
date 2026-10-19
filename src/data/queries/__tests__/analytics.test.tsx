/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { readScoredDrives, readWindowEvents, toDriveEvent } from '@/data/queries/analytics';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';
import { isScoredDrive } from '@/data/queries/rows';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    { client_trip_id: uuid(1), started_at: T0 - DAY, tz: 'UTC', status: 'scored', miles: 10, points_net: 80 },
    { client_trip_id: uuid(2), started_at: T0 - 2 * DAY, tz: 'UTC', status: 'pending', miles: 4, points_net: -20, estimate: 1 },
    { client_trip_id: uuid(3), started_at: T0 - 3 * DAY, tz: 'UTC', status: 'pending', miles: 4, points_net: null },
    { client_trip_id: uuid(4), started_at: T0 - 4 * DAY, tz: 'UTC', status: 'not_driving', miles: 3, points_net: 0 },
    { client_trip_id: uuid(5), started_at: T0 - 40 * DAY, tz: 'UTC', status: 'scored', miles: 20, points_net: 50 },
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(1), type: 'speeding', tier: 'moderate', started_at: T0 - DAY + 10, duration_s: 40 },
    { id: uuid(22), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: T0 - DAY + 20, status: 'removed' },
    { id: uuid(23), client_trip_id: uuid(2), type: 'phone_pickup', tier: 'severe', started_at: T0 - 2 * DAY, stopped_in_traffic: 1 },
    { id: uuid(24), client_trip_id: uuid(2), type: 'phone_handling', tier: 'severe', started_at: T0 - 2 * DAY + 5, duration_s: 45, units: 2 },
    { id: uuid(25), client_trip_id: uuid(3), type: 'hard_accel', tier: 'minor', started_at: T0 - 3 * DAY },
    { id: uuid(26), client_trip_id: uuid(4), type: 'hard_corner', tier: 'minor', started_at: T0 - 4 * DAY },
    { id: uuid(27), client_trip_id: uuid(5), type: 'speeding', tier: 'minor', started_at: T0 - 40 * DAY },
  ]);
});

test('window events: active events of scored drives in the window, oldest first, as scoring events', async () => {
  const week = await readWindowEvents(db, T0 - 7 * DAY);
  expect(week.map((e) => e.id)).toEqual([uuid(23), uuid(24), uuid(21)]);
  expect(week[0]).toEqual({ id: uuid(23), type: 'phone_pickup', tier: 'severe', startedAt: T0 - 2 * DAY, durationS: 0, stoppedInTraffic: true, status: 'active' });
  expect(week[1]).toMatchObject({ type: 'phone_handling', units: 2, durationS: 45 });
  expect(week[2]).not.toHaveProperty('units');
  expect((await readWindowEvents(db, null)).map((e) => e.id)).toEqual([uuid(27), uuid(23), uuid(24), uuid(21)]);
});

test('scored drives: the window, newest first, the same drives isScoredDrive counts', async () => {
  const week = await readScoredDrives(db, T0 - 7 * DAY);
  expect(week.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect(week.every(isScoredDrive)).toBe(true);
  expect((await readScoredDrives(db, null)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(5)]);
});

test('the event reader keeps exactly the scored drives the drive reader keeps', async () => {
  const drives = new Set((await readScoredDrives(db, null)).map((d) => d.clientTripId));
  const tripOf: Record<string, string> = { [uuid(21)]: uuid(1), [uuid(23)]: uuid(2), [uuid(24)]: uuid(2), [uuid(27)]: uuid(5) };
  for (const e of await readWindowEvents(db, null)) expect(drives.has(tripOf[e.id]!)).toBe(true);
});

test('toDriveEvent carries units only when stored', () => {
  const base = {
    id: 'x', client_trip_id: 'y', type: 'phone_handling' as const, tier: 'moderate' as const, started_at: 1, duration_s: 20, units: null,
    stopped_in_traffic: 0 as const, lat: null, lng: null, measured_json: null, penalty: null, status: 'active' as const,
    dispute_status: 'none' as const, dispute_reason: null, dispute_message: null,
  };
  expect(toDriveEvent(base)).toEqual({ id: 'x', type: 'phone_handling', tier: 'moderate', startedAt: 1, durationS: 20, stoppedInTraffic: false, status: 'active' });
  expect(toDriveEvent({ ...base, units: 3 }).units).toBe(3);
});

test('the analytics keys sit under the stats root, so every sync refreshes them', () => {
  expect(queryKeys.windowEvents(5)[0]).toBe('stats');
  expect(queryKeys.scoredDrives(null)[0]).toBe('stats');
  expect(QUERY_ROOTS).toContain('stats');
  expect(queryKeys.windowEvents(5)).not.toEqual(queryKeys.statSums(5));
});
