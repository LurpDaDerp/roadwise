// The known parking spots a drive may end at: the ends of the latest kept drives and the saved places.
import { PARK_SPOTS_MAX } from '@/core/engine/motion';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db, type TripStatus } from '@/data/db';
import { readDriveEnds, readParkingSpots } from '@/drive/parkingSpots';
import { PLACES_KEY } from '@/features/places/model';

const T0 = 1_700_000_000_000;
let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

async function trip(i: number, status: TripStatus, end: { lat: number; lng: number } | null = { lat: 47 + i / 1000, lng: -122 }): Promise<void> {
  await createTripsRepo(db).insert(
    {
      client_trip_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      started_at: T0 + i * 60_000,
      ended_at: T0 + i * 60_000 + 30_000,
      tz: 'UTC',
      status,
      end_lat: end?.lat ?? null,
      end_lng: end?.lng ?? null,
    },
    T0
  );
}

test('the ends of the latest kept drives, newest first, never one recording, a passenger ride or one with no end', async () => {
  await trip(1, 'scored');
  await trip(2, 'unscored');
  await trip(3, 'pending');
  await trip(4, 'failed');
  await trip(5, 'not_driving');
  await trip(6, 'recording');
  await trip(7, 'scored', null);
  expect(await readDriveEnds(db)).toEqual([4, 3, 2, 1].map((i) => ({ lat: 47 + i / 1000, lng: -122 })));
});

test(`at most ${PARK_SPOTS_MAX}`, async () => {
  for (let i = 1; i <= PARK_SPOTS_MAX + 5; i += 1) await trip(i, 'scored');
  const ends = await readDriveEnds(db);
  expect(ends).toHaveLength(PARK_SPOTS_MAX);
  expect(ends[0]).toEqual({ lat: 47 + (PARK_SPOTS_MAX + 5) / 1000, lng: -122 });
});

test('the saved places too; a failing read leaves the other', async () => {
  await trip(1, 'scored');
  await createSettingsRepo(db).set(PLACES_KEY, [{ id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.5, lng: -122.2 }]);
  expect(await readParkingSpots(db)).toEqual([
    { lat: 47.001, lng: -122 },
    { lat: 47.5, lng: -122.2 },
  ]);
  const errors: unknown[] = [];
  const broken = { ...db, execute: async () => Promise.reject(new Error('locked')) } as unknown as Db;
  expect(await readParkingSpots(broken, (e) => errors.push(e))).toEqual([]);
  expect(errors).toHaveLength(2);
});
