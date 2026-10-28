/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { archiveCutoff, archiveDue, countDue, createRoutePoolRepo, isRecording, RETENTION_DAYS, RETENTION_MS } from '@/data/db/archive';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo, FUNCTION_MISSING, REFUSED_NEVER } from '@/data/db/queue';
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

const queueRow = (key: string, clientTripId: string, status: string, nextAttemptAt: number, lastError: string | null = null, kind = 'finalize-trip') =>
  db.execute(
    'INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, last_error, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1)',
    [kind, JSON.stringify({ clientTripId, polyline: 'x' }), key, status, nextAttemptAt, lastError]
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
  await queueRow('finalize:old-failed', 'old-failed', 'failed', REFUSED_NEVER, 'http_422');
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

test('a recording drive is seen; a recording row older than a drive can last (12 h) is stale and is not', async () => {
  expect(await isRecording(db, NOW)).toBe(false);
  await createTripsRepo(db).insert({ client_trip_id: 'stale', started_at: NOW - 13 * 3_600_000, tz: 'UTC', status: 'recording' }, NOW);
  expect(await isRecording(db, NOW)).toBe(false);
  await createTripsRepo(db).insert({ client_trip_id: 'live', started_at: NOW - 60_000, tz: 'UTC', status: 'recording' }, NOW);
  expect(await isRecording(db, NOW)).toBe(true);
});

test('a "Wasn’t driving" drive whose upload is still owed waits, however old, until the upload is done', async () => {
  const trips = createTripsRepo(db);
  await trips.insert(drive('passenger-owed', 300, { status: 'not_driving' }), NOW);
  await queueRow('trip:passenger-owed', 'passenger-owed', 'pending', NOW);
  // and a queued "Wasn't driving" action for another old drive holds that one too
  await trips.insert(drive('action-owed', 300, { status: 'not_driving' }), NOW);
  await queueRow('not_driving:action-owed', 'action-owed', 'pending', NOW, null, 'trip-actions');
  await archiveDue(db, NOW);
  expect(await trips.get('passenger-owed')).toMatchObject({ archived_at: null, polyline: 'route-passenger-owed' });
  expect(await trips.get('action-owed')).toMatchObject({ archived_at: null });
  await db.execute("UPDATE sync_queue SET status = 'done' WHERE idempotency_key IN ('trip:passenger-owed', 'not_driving:action-owed')");
  expect(await archiveDue(db, NOW)).toBe(2);
  expect(await trips.get('passenger-owed')).toMatchObject({ archived_at: NOW, polyline: null });
});

test('a failed drive whose upload was refused on a missing function waits: the queue sends it again, so its item is kept', async () => {
  const trips = createTripsRepo(db);
  await trips.insert(drive('reopens', 300, { status: 'failed', sync_error: FUNCTION_MISSING }), NOW);
  await queueRow('trip:reopens', 'reopens', 'failed', REFUSED_NEVER, FUNCTION_MISSING);
  await archiveDue(db, NOW);
  expect(await trips.get('reopens')).toMatchObject({ archived_at: null, polyline: 'route-reopens' });
  expect(await createQueueRepo(db).byKey('trip:reopens')).not.toBeNull();
  // The queue reopens it at the next launch, as before.
  expect(await createQueueRepo(db).reopenRetryable(NOW)).toBeGreaterThanOrEqual(1);
  expect((await createQueueRepo(db).byKey('trip:reopens'))?.status).toBe('pending');
});

test('what holds a drive back is the queue’s own "owed" (and a missing-function refusal): item by item, archiving agrees with queue.owes', async () => {
  const trips = createTripsRepo(db);
  const queue = createQueueRepo(db);
  const cases: [string, string, number, string | null][] = [
    ['pending', 'pending', NOW, null],
    ['inflight', 'inflight', NOW, null],
    ['backoff', 'failed', NOW + 60_000, 'http_500'],
    ['ranout', 'failed', NOW - 1, 'network'],
    ['refused', 'failed', REFUSED_NEVER, 'http_422'],
    ['missing', 'failed', REFUSED_NEVER, FUNCTION_MISSING],
    ['done', 'done', NOW, null],
  ];
  for (const [id, status, next, error] of cases) {
    await trips.insert(drive(`case-${id}`, 300), NOW);
    await queueRow(`trip:case-${id}`, `case-${id}`, status, next, error);
  }
  const owed = new Map<string, boolean>();
  for (const [id] of cases) owed.set(id, await queue.owes(`trip:case-${id}`));
  await archiveDue(db, NOW);
  for (const [id, , , error] of cases) {
    const held = (await trips.get(`case-${id}`))?.archived_at === null;
    expect([id, held]).toEqual([id, owed.get(id) === true || error === FUNCTION_MISSING]);
  }
});

