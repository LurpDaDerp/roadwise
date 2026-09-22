/** @jest-environment node */
import {
  readRolePrior,
  recordRoleAnswer,
  roleAnswerKey,
  ROLE_ROUTES_KEY,
} from '@/core/engine/rolePrior';
import { createQueueRepo, createSettingsRepo, createTripsRepo } from '@/data/db';
import { readTombstones } from '@/data/db/tombstones';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { tripRow } from '@/data/queries/__fixtures__/rows';
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
