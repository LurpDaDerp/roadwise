// The known parking spots a drive may end at: the ends of the latest kept drives and the saved places.
import { PARK_SPOTS_MAX } from '@/core/engine/motion';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db, type TripStatus } from '@/data/db';
import { readDriveEnds, readParkingSpots, readPlaceSpots } from '@/drive/parkingSpots';
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

test('the saved places with who they are, for the place-arrival end; a failing read is none', async () => {
  await createSettingsRepo(db).set(PLACES_KEY, [
    { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.5, lng: -122.2 },
    { id: 'place-1', kind: 'custom', name: 'Gym', address: '2 Main St', area: '', lat: 47.6, lng: -122.3 },
  ]);
  expect(await readPlaceSpots(db)).toEqual([
    { id: 'home', kind: 'home', name: 'Home', lat: 47.5, lng: -122.2, anchor: null },
    { id: 'place-1', kind: 'custom', name: 'Gym', lat: 47.6, lng: -122.3, anchor: null },
  ]);
  const errors: unknown[] = [];
  const broken = { ...db, execute: async () => Promise.reject(new Error('locked')) } as unknown as Db;
  expect(await readPlaceSpots(broken, (e) => errors.push(e))).toEqual([]);
  expect(errors).toHaveLength(1);
});

test('each saved place carries where the driver usually parks there, from the kept drive ends of the last 183 days', async () => {
  const DAY = 86_400_000;
  // Home's pin is on the house; the driveway is about 25 m east of it.
  const home = { lat: 47.5, lng: -122.2 };
  const drive = { lat: 47.5, lng: -122.2 + 25 / 75_200 };
  await createSettingsRepo(db).set(PLACES_KEY, [
    { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', ...home },
    { id: 'school', kind: 'school', name: 'School', address: 'Roosevelt High School', area: '', lat: 47.6, lng: -122.3 },
  ]);
  const at = async (i: number, endedAt: number, status: TripStatus = 'scored') =>
    createTripsRepo(db).insert(
      { client_trip_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, started_at: endedAt - 600_000, ended_at: endedAt, tz: 'UTC', status, end_lat: drive.lat, end_lng: drive.lng },
      T0
    );
  const now = T0 + 200 * DAY;
  // Three recent ends, a passenger ride and one 190 days old: not yet enough.
  for (let i = 1; i <= 3; i += 1) await at(i, now - i * DAY);
  await at(4, now - 5 * DAY, 'not_driving');
  await at(5, now - 190 * DAY);
  expect((await readPlaceSpots(db, undefined, now)).map((p) => p.anchor)).toEqual([null, null]);
  // A fourth recent end: Home has its anchor; School (no house number) never has one.
  await at(6, now - 4 * DAY);
  const [h, s] = await readPlaceSpots(db, undefined, now);
  expect(h?.anchor?.lat).toBeCloseTo(drive.lat, 6);
  expect(h?.anchor?.lng).toBeCloseTo(drive.lng, 6);
  expect(s?.anchor).toBeNull();
});
