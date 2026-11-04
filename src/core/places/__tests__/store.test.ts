/** @jest-environment node */
import { readAnchoredPlaces, readPlaceEnds } from '@/core/places/store';
import { PLACES_KEY } from '@/core/places/saved';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db, type NewTrip } from '@/data/db';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

const trip = (n: number, daysAgo: number, over: Partial<NewTrip> = {}) =>
  createTripsRepo(db).insert(
    { client_trip_id: `t${n}`, started_at: NOW - daysAgo * DAY - 600_000, ended_at: NOW - daysAgo * DAY, tz: 'UTC', status: 'scored', end_lat: 47.6, end_lng: -122.3, ...over },
    NOW
  );

test('the ends of the kept drives of the last 183 days only', async () => {
  await trip(1, 1);
  await trip(2, 2, { status: 'pending' });
  await trip(3, 3, { status: 'not_driving' });
  await trip(4, 4, { status: 'recording' });
  await trip(5, 184);
  await trip(6, 5, { archived_at: NOW });
  await trip(7, 6, { end_lat: null });
  await trip(8, 7, { status: 'failed', end_lat: 47.61 });
  expect((await readPlaceEnds(db, NOW)).sort((a, b) => a.lat - b.lat)).toEqual([
    { lat: 47.6, lng: -122.3 },
    { lat: 47.6, lng: -122.3 },
    { lat: 47.61, lng: -122.3 },
  ]);
});

test('the saved places with their anchors; none saved reads no ends', async () => {
  expect(await readAnchoredPlaces(db, NOW)).toEqual([]);
  await createSettingsRepo(db).set(PLACES_KEY, [
    { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.6001, lng: -122.3 },
    { id: 'work', kind: 'work', name: 'Work', address: '9 Pine St', area: '', lat: 47.7, lng: -122.3 },
  ]);
  for (let i = 1; i <= 4; i += 1) await trip(i, i);
  const places = await readAnchoredPlaces(db, NOW);
  expect(places.map((p) => [p.id, p.anchor])).toEqual([
    ['home', { lat: 47.6, lng: -122.3 }],
    ['work', null],
  ]);
});

test('the 5 dp end when the drive has one, else the 4 dp one', async () => {
  await trip(1, 1, { end_lat: 47.6001, end_lng: -122.3001, end_lat_full: 47.60006, end_lng_full: -122.30006 });
  await trip(2, 2);
  expect((await readPlaceEnds(db, NOW)).sort((a, b) => a.lat - b.lat)).toEqual([
    { lat: 47.6, lng: -122.3 },
    { lat: 47.60006, lng: -122.30006 },
  ]);
});

test('ends on both sides of a 4 dp grid line still make an anchor (the 5 dp ends are read)', async () => {
  await createSettingsRepo(db).set(PLACES_KEY, [{ id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.6, lng: -122.3 }]);
  // The car stands at the same spot each time, right on a 4 dp corner: its 4 dp ends fall into
  // diagonal cells about 14 m apart (3 in one, 2 in the other), which alone make no anchor.
  const spots = [47.60004, 47.60004, 47.60004, 47.60006, 47.60006];
  for (const [i, lat] of spots.entries()) {
    const lng = lat === 47.60004 ? -122.30004 : -122.30006;
    await trip(i + 1, i + 1, { end_lat: Math.round(lat * 1e4) / 1e4, end_lng: Math.round(lng * 1e4) / 1e4, end_lat_full: lat, end_lng_full: lng });
  }
  const [home] = await readAnchoredPlaces(db, NOW);
  expect(home?.anchor).not.toBeNull();
  expect(home?.anchor?.lat).toBeCloseTo(47.60004, 5);
  // The same ends at 4 dp alone: no anchor.
  await db.execute('UPDATE trips SET end_lat_full = NULL, end_lng_full = NULL');
  expect((await readAnchoredPlaces(db, NOW))[0]?.anchor).toBeNull();
});
