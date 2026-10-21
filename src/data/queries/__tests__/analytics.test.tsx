/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { readScoredDrives, readWindowEvents, SCORED_TRIP, toDriveEvent } from '@/data/queries/analytics';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';
import { isScoredDrive, toLocalDrive } from '@/data/queries/rows';
import { createTripsRepo } from '@/data/db/trips';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    { client_trip_id: uuid(1), started_at: T0 - DAY, tz: 'UTC', status: 'scored', miles: 10 },
    { client_trip_id: uuid(2), started_at: T0 - 2 * DAY, tz: 'UTC', status: 'pending', miles: 4 },
    { client_trip_id: uuid(3), started_at: T0 - 3 * DAY, tz: 'UTC', status: 'pending', miles: 0.2, reason: 'too_short' },
    { client_trip_id: uuid(4), started_at: T0 - 4 * DAY, tz: 'UTC', status: 'not_driving', miles: 3 },
    { client_trip_id: uuid(5), started_at: T0 - 40 * DAY, tz: 'UTC', status: 'scored', miles: 20 },
    { client_trip_id: uuid(6), started_at: T0 - 5 * DAY, tz: 'UTC', status: 'unscored', miles: 0.1, reason: 'too_short' },
    { client_trip_id: uuid(7), started_at: T0 - 6 * DAY, tz: 'UTC', status: 'recording', miles: 2 },
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(1), type: 'speeding', tier: 'moderate', started_at: T0 - DAY + 10, duration_s: 40, measured_json: '{"speedMph":50,"limitMph":40,"overMphS":120}' },
    { id: uuid(22), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: T0 - DAY + 20, status: 'removed' },
    { id: uuid(23), client_trip_id: uuid(2), type: 'hard_brake', tier: 'severe', started_at: T0 - 2 * DAY, measured_json: '{"peakG":0.5}' },
    { id: uuid(24), client_trip_id: uuid(2), type: 'drowsy', tier: 'severe', started_at: T0 - 2 * DAY + 5, duration_s: 4, measured_json: '{"source":"dashcam"}' },
    { id: uuid(25), client_trip_id: uuid(3), type: 'hard_accel', tier: 'minor', started_at: T0 - 3 * DAY },
    { id: uuid(26), client_trip_id: uuid(4), type: 'hard_corner', tier: 'minor', started_at: T0 - 4 * DAY },
    { id: uuid(27), client_trip_id: uuid(5), type: 'speeding', tier: 'minor', started_at: T0 - 40 * DAY },
  ]);
});

test('window events: active events of scored drives in the window, oldest first, as scoring events with what they measured', async () => {
  const week = await readWindowEvents(db, T0 - 7 * DAY);
  expect(week.map((e) => e.id)).toEqual([uuid(23), uuid(24), uuid(21)]);
  expect(week[0]).toEqual({ id: uuid(23), type: 'hard_brake', tier: 'severe', startedAt: T0 - 2 * DAY, durationS: 0, status: 'active', measured: { peakG: 0.5 } });
  expect(week[1]).toMatchObject({ type: 'drowsy', measured: { source: 'dashcam' } });
  expect(week[2]).toMatchObject({ type: 'speeding', measured: { speedMph: 50, limitMph: 40, overMphS: 120 } });
  expect((await readWindowEvents(db, null)).map((e) => e.id)).toEqual([uuid(27), uuid(23), uuid(24), uuid(21)]);
});

test('scored drives: the window, newest first, the same drives isScoredDrive counts; a too-short pending drive is out', async () => {
  const week = await readScoredDrives(db, T0 - 7 * DAY);
  expect(week.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect(week.every(isScoredDrive)).toBe(true);
  expect((await readScoredDrives(db, null)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(5)]);
});

test('SCORED_TRIP and isScoredDrive agree on every stored drive', async () => {
  const { rows } = await db.execute(`SELECT t.client_trip_id FROM trips t WHERE ${SCORED_TRIP} ORDER BY t.client_trip_id`);
  const sql = rows.map((r) => String(r.client_trip_id));
  const js = (await createTripsRepo(db).list()).map(toLocalDrive).filter(isScoredDrive).map((d) => d.clientTripId).sort();
  expect(sql).toEqual(js);
  expect(sql).toEqual([uuid(1), uuid(2), uuid(5)].sort());
});

test('the event reader keeps exactly the scored drives the drive reader keeps', async () => {
  const drives = new Set((await readScoredDrives(db, null)).map((d) => d.clientTripId));
  const tripOf: Record<string, string> = { [uuid(21)]: uuid(1), [uuid(23)]: uuid(2), [uuid(24)]: uuid(2), [uuid(27)]: uuid(5) };
  for (const e of await readWindowEvents(db, null)) expect(drives.has(tripOf[e.id]!)).toBe(true);
});

test('toDriveEvent passes the measured block (with overMphS) and the status, nothing about points or phone use', () => {
  const base = {
    id: 'x', client_trip_id: 'y', type: 'speeding' as const, tier: 'moderate' as const, started_at: 1, duration_s: 20,
    lat: null, lng: null, measured_json: '{"overMphS":33.5,"mounted":true}', status: 'removed' as const,
    dispute_status: 'accepted' as const, dispute_reason: 'hazard', dispute_message: null,
  };
  expect(toDriveEvent(base)).toEqual({ id: 'x', type: 'speeding', tier: 'moderate', startedAt: 1, durationS: 20, status: 'removed', measured: { overMphS: 33.5 } });
  expect(toDriveEvent({ ...base, measured_json: null }).measured).toEqual({});
});

test('the analytics keys sit under the stats root, so every sync refreshes them', () => {
  expect(queryKeys.windowEvents(5)[0]).toBe('stats');
  expect(queryKeys.scoredDrives(null)[0]).toBe('stats');
  expect(QUERY_ROOTS).toContain('stats');
  expect(queryKeys.windowEvents(5)).not.toEqual(queryKeys.statSums(5));
});
