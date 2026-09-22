/** @jest-environment node */
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
