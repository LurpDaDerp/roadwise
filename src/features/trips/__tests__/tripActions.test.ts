/** @jest-environment node */
import {
  readRolePrior,
  recordRoleAnswer,
  roleAnswerKey,
  ROLE_ROUTES_KEY,
} from '@/core/engine/rolePrior';
import { createQueueRepo, createSettingsRepo, createTripsRepo } from '@/data/db';
import { readTombstones } from '@/data/db/tombstones';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { eventRow, tripRow } from '@/data/queries/__fixtures__/rows';
import { DEVICE_OWNER_KEY } from '@/data/sync/queue';
import { createFakeFs } from '@/data/sync/__fixtures__/fakes';
import { deleteTrip } from '@/features/trips/tripActions';

test('a delete leaves a tombstone that outlives its queue item (security review D1 M-2)', async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-1');
  await seedTrips(db, [tripRow({ client_trip_id: 'trip-1' })]);

  await deleteTrip(db, 'trip-1', 1_000, { fs: createFakeFs() });

  await expect(readTombstones(db)).resolves.toEqual(new Set(['trip-1']));
  await expect(createQueueRepo(db).byKey('delete:trip-1')).resolves.toMatchObject({ status: 'pending' });
  // The husk, then the row itself, may go; the tombstone stays.
  await createTripsRepo(db).remove('trip-1');
  await db.execute('DELETE FROM sync_queue');
  await expect(readTombstones(db)).resolves.toEqual(new Set(['trip-1']));
});

test("a deleted drive's role answer stops counting, and its route key goes with it (E2 delete hook)", async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-1');
  await seedTrips(db, [tripRow({ client_trip_id: 'trip-1' })]);
  const neutral = await readRolePrior(db);
  await recordRoleAnswer(db, 'passenger', { start: '9q8yy', end: '9q8yz' }, 'trip-1');
  expect(await readRolePrior(db)).not.toBe(neutral);

  await deleteTrip(db, 'trip-1', 1_000, { fs: createFakeFs() });

  expect(await readRolePrior(db)).toBe(neutral);
  await expect(createSettingsRepo(db).get(roleAnswerKey('trip-1'))).resolves.toBeNull();
  expect(JSON.stringify(await createSettingsRepo(db).get(ROLE_ROUTES_KEY))).not.toContain('9q8yy');
});

test('a delete drops the drive reports and role answers from the queue, notes and all (security review D2 I-1)', async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-1');
  await seedTrips(db, [tripRow({ client_trip_id: 'trip-1' }), tripRow({ client_trip_id: 'trip-2' })]);
  await seedEvents(db, [
    eventRow({ id: 'e1', client_trip_id: 'trip-1' }),
    eventRow({ id: 'e2', client_trip_id: 'trip-1' }),
    eventRow({ id: 'other', client_trip_id: 'trip-2' }),
  ]);
  const queue = createQueueRepo(db);
  const note = 'I was avoiding a cyclist near school';
  await queue.enqueue('dispute', { action: 'dispute', clientEventId: 'e1', reason: 'hazard', note }, 'dispute:e1', 1, undefined, 'user-1');
  // One that already gave up: a failed row is never purged, so it must go too.
  const failed = await queue.enqueue('dispute', { action: 'dispute', clientEventId: 'e2', reason: 'hazard', note }, 'dispute:e2', 1, undefined, 'user-1');
  await db.execute("UPDATE sync_queue SET status = 'failed', attempts = 20 WHERE id = ?", [failed.id]);
  await queue.enqueue('set-role', { action: 'set-role', clientTripId: 'trip-1', role: 'passenger' }, 'role:trip-1:5', 1, undefined, 'user-1');
  // Another drive's work is not touched.
  await queue.enqueue('dispute', { action: 'dispute', clientEventId: 'other', reason: 'hazard' }, 'dispute:other', 1, undefined, 'user-1');
  await queue.enqueue('set-role', { action: 'set-role', clientTripId: 'trip-2', role: 'driver' }, 'role:trip-2:6', 1, undefined, 'user-1');

  await deleteTrip(db, 'trip-1', 1_000, { fs: createFakeFs() });

  const { rows } = await db.execute('SELECT idempotency_key, payload_json FROM sync_queue ORDER BY idempotency_key');
  expect(rows.map((r) => r.idempotency_key)).toEqual(['delete:trip-1', 'dispute:other', 'role:trip-2:6']);
  expect(JSON.stringify(rows)).not.toContain('cyclist');
});
