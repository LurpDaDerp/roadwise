/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { archiveCutoff, archiveDue, countDue, createRoutePoolRepo, isRecording, RETENTION_DAYS, RETENTION_MS } from '@/data/db/archive';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { REFUSED_NEVER } from '@/data/db/queue';
import { createTripsRepo } from '@/data/db/trips';
import type { NewTrip } from '@/data/db/types';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let db: Db;

/** A finished drive that ended `daysAgo` days before NOW, with a route, both ends and labels. */
const drive = (id: string, daysAgo: number, over: Partial<NewTrip> = {}): NewTrip => ({
  client_trip_id: id,
  started_at: NOW - daysAgo * DAY - 1_800_000,
  ended_at: NOW - daysAgo * DAY,
  tz: 'UTC',
  status: 'scored',
  miles: 12,
  duration_s: 1800,
  clean: 1,
  polyline: `route-${id}`,
  from_label: 'Home',
  to_label: 'School',
  start_lat: 47.6,
  start_lng: -122.3,
  end_lat: 47.7,
  end_lng: -122.4,
  ...over,
});

const queueRow = (key: string, clientTripId: string, status: string, nextAttemptAt: number) =>
  db.execute(
    "INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at) VALUES ('finalize-trip', ?, ?, ?, 1, ?, 1)",
    [JSON.stringify({ clientTripId, polyline: 'x' }), key, status, nextAttemptAt]
  );

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  const trips = createTripsRepo(db);
  for (const t of [
    drive('old-scored', 200),
    drive('old-unscored', 190, { status: 'unscored', reason: 'too_short', clean: null }),
    drive('old-passenger', 300, { status: 'not_driving' }),
    drive('old-failed', 250, { status: 'failed', sync_error: 'http_422' }),
    // Still owed to the server: never touched, however old.
    drive('old-pending', 400, { status: 'pending' }),
    // One ended exactly 183 days ago is not past them yet.
    drive('edge', RETENTION_DAYS),
    drive('recent', 10),
  ]) {
    await trips.insert(t, NOW);
  }
  await createEventsRepo(db).insertMany([
    { id: 'e1', client_trip_id: 'old-scored', type: 'speeding', tier: 'minor', started_at: NOW - 200 * DAY - 600_000, duration_s: 8, lat: 47.61, lng: -122.31, measured_json: '{"speedMph":41,"limitMph":35,"overMphS":9}' },
    { id: 'e2', client_trip_id: 'old-scored', type: 'eyes_off', tier: 'severe', started_at: NOW - 200 * DAY - 500_000, duration_s: 3, lat: 47.62, lng: -122.32 },
    { id: 'e3', client_trip_id: 'old-pending', type: 'hard_brake', tier: 'minor', started_at: NOW - 400 * DAY - 600_000, duration_s: 1, lat: 47.63, lng: -122.33 },
    { id: 'e4', client_trip_id: 'recent', type: 'hard_brake', tier: 'minor', started_at: NOW - 10 * DAY - 600_000, duration_s: 1, lat: 47.64, lng: -122.34 },
  ]);
  await db.execute("INSERT INTO samples (client_trip_id, ts, row_json) VALUES ('old-failed', 1, '{}'), ('old-pending', 1, '{}')");
  // The refused upload of the failed drive holds its route; the pending drive's upload is still owed.
  await queueRow('finalize:old-failed', 'old-failed', 'failed', REFUSED_NEVER);
  await queueRow('finalize:old-pending', 'old-pending', 'failed', NOW + 1);
});

test('183 days, the same on the server (private.route_retention)', () => {
  expect(RETENTION_DAYS).toBe(183);
  expect(RETENTION_MS).toBe(183 * DAY);
  expect(archiveCutoff(NOW)).toBe(NOW - 183 * DAY);
});

test('a settled drive past the 183 days loses its route, ends, labels and event places, keeps its numbers and is stamped; a scored one pools its route', async () => {
  expect(await countDue(db, NOW)).toBe(4);
  expect(await archiveDue(db, NOW)).toBe(4);
  const trips = createTripsRepo(db);
  for (const id of ['old-scored', 'old-unscored', 'old-passenger', 'old-failed']) {
    expect(await trips.get(id)).toMatchObject({
      polyline: null, from_label: null, to_label: null, start_lat: null, start_lng: null, end_lat: null, end_lng: null, archived_at: NOW, miles: 12, duration_s: 1800,
    });
  }
  expect(await trips.get('old-scored')).toMatchObject({ status: 'scored', clean: 1 });
  // Only a scored drive's route is drawn on the All trips map, so only it is pooled.
  expect(await createRoutePoolRepo(db).list()).toEqual(['route-old-scored']);
  const events = await createEventsRepo(db).listByTrip('old-scored');
  expect(events.map((e) => [e.id, e.type, e.tier, e.lat, e.lng, e.measured_json])).toEqual([
    ['e1', 'speeding', 'minor', null, null, '{"speedMph":41,"limitMph":35,"overMphS":9}'],
    ['e2', 'eyes_off', 'severe', null, null, null],
  ]);
  expect((await db.execute("SELECT client_trip_id FROM samples")).rows).toEqual([{ client_trip_id: 'old-pending' }]);
  expect((await db.execute('SELECT idempotency_key FROM sync_queue')).rows).toEqual([{ idempotency_key: 'finalize:old-pending' }]);
});

test('a drive still owed, one at exactly 183 days and a recent one are left as they are', async () => {
  const trips = createTripsRepo(db);
  const before = await Promise.all(['old-pending', 'edge', 'recent'].map((id) => trips.get(id)));
  await archiveDue(db, NOW);
  expect(await Promise.all(['old-pending', 'edge', 'recent'].map((id) => trips.get(id)))).toEqual(before);
  expect((await createEventsRepo(db).get('e3'))?.lat).toBe(47.63);
  expect((await createEventsRepo(db).get('e4'))?.lat).toBe(47.64);
});

test('idempotent: a second run archives nothing and pools nothing twice; the 183 days are then crossed by the edge drive alone', async () => {
  await archiveDue(db, NOW);
  expect(await archiveDue(db, NOW)).toBe(0);
  expect(await countDue(db, NOW)).toBe(0);
  expect(await createRoutePoolRepo(db).count()).toBe(1);
  expect(await archiveDue(db, NOW + 1)).toBe(1);
  expect(await createTripsRepo(db).get('edge')).toMatchObject({ archived_at: NOW + 1, polyline: null });
  expect((await createRoutePoolRepo(db).list()).sort()).toEqual(['route-edge', 'route-old-scored']);
});

test('the pool holds a line once, and never an empty one', async () => {
  const pool = createRoutePoolRepo(db);
  expect(await pool.insertMany(['a', 'b', 'a', ''])).toBe(2);
  expect(await pool.insertMany(['b', 'c'])).toBe(1);
  expect((await pool.list()).sort()).toEqual(['a', 'b', 'c']);
});

test('a recording drive is seen', async () => {
  expect(await isRecording(db)).toBe(false);
  await createTripsRepo(db).insert({ client_trip_id: 'live', started_at: NOW, tz: 'UTC', status: 'recording' }, NOW);
  expect(await isRecording(db)).toBe(true);
});
