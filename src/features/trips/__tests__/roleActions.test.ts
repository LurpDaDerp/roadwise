import {
  createQueueRepo,
  createSettingsRepo,
  createTripsRepo,
  MissingTripError,
  type Db,
} from '@/data/db';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { onDataChanged } from '@/data/events';
import {
  isHabitualDriverRoute,
  readRolePrior,
  ROLE_PRIOR_KEY,
  ROLE_ROUTES_KEY,
  routeKey,
} from '@/core/engine/rolePrior';

import { setRoleIdempotencyKey, setTripRole } from '@/features/trips/roleActions';

const NOW = T0 + 3_600_000;

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    tripRow({ client_trip_id: 'unknown', role: 'unknown', score: null, status: 'unscored' }),
    tripRow({ client_trip_id: 'scored', role: 'driver', score: 90, status: 'provisional' }),
    tripRow({ client_trip_id: 'school', role: 'unknown', score: null, status: 'unscored', start_geohash5: '9q8yy', end_geohash5: 'c23nb' }),
    tripRow({ client_trip_id: 'home', role: 'unknown', score: null, status: 'unscored', start_geohash5: 'c23nb', end_geohash5: '9q8yy' }),
  ]);
});

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('a passenger answer clears the score locally and queues the trip-actions request verbatim', async () => {
  const row = await setTripRole(db, 'unknown', 'passenger', NOW);
  expect(row).toMatchObject({ role: 'passenger', role_source: 'manual', status: 'unscored', score: null, updated_at: NOW });

  const item = await createQueueRepo(db).byKey(setRoleIdempotencyKey('unknown', NOW));
  expect(item).toMatchObject({ kind: 'set-role', status: 'pending' });
  expect(JSON.parse(item?.payload_json ?? '{}')).toEqual({
    action: 'set-role',
    clientTripId: 'unknown',
    role: 'passenger',
  });
});

test('the answer carries the driver who gave it, so no other session can send it', async () => {
  await createSettingsRepo(db).set('session.uid', 'user-a');

  await setTripRole(db, 'unknown', 'passenger', NOW);

  // `roleStamp` keeps the key strictly increasing, so the item is read by what is due, not by a
  // key rebuilt from `NOW`.
  const [item] = await createQueueRepo(db).nextDue(NOW + 1000, 10);
  expect(item).toMatchObject({ kind: 'set-role', owner_uid: 'user-a' });
});

test('a driver answer keeps the row as it is, so the server scores it', async () => {
  const row = await setTripRole(db, 'unknown', 'driver', NOW);
  expect(row).toMatchObject({ role: 'driver', role_source: 'manual', status: 'unscored', score: null });
});

test('a scored trip marked as transit loses its score on the spot', async () => {
  const row = await setTripRole(db, 'scored', 'other', NOW);
  expect(row).toMatchObject({ role: 'other', status: 'unscored', score: null });
});

test('every answer is its own queue item, in order, so the last one is what the server keeps', async () => {
  await setTripRole(db, 'unknown', 'passenger', NOW);
  await setTripRole(db, 'unknown', 'driver', NOW + 1);
  const queue = createQueueRepo(db);
  const items = await queue.nextDue(NOW + 10, 10);
  expect(items.map((item) => JSON.parse(item.payload_json).role)).toEqual(['passenger', 'driver']);
});

test('wakes the sync runner after the write has committed', async () => {
  const wakes: string[] = [];
  const off = onDataChanged((e) => wakes.push(e.source));
  try {
    await setTripRole(db, 'unknown', 'passenger', NOW);
    expect(wakes).toHaveLength(0);
    await nextMacrotask();
    expect(wakes).toEqual(['enqueue']);
  } finally {
    off();
  }
});

test('a trip that is not there is refused, and nothing is queued', async () => {
  await expect(setTripRole(db, 'ghost', 'driver', NOW)).rejects.toBeInstanceOf(MissingTripError);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
  expect(await createTripsRepo(db).get('unknown')).toMatchObject({ role: 'unknown' });
});

describe('an answer trains the per-user prior and the route (spec 9.7: answers train a prior on device)', () => {
  test('a driver answer counts toward the prior and the route the trip took', async () => {
    await setTripRole(db, 'school', 'driver', NOW);
    const settings = createSettingsRepo(db);
    await expect(settings.get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings.get(ROLE_ROUTES_KEY)).resolves.toEqual({
      [routeKey('9q8yy', 'c23nb')]: { driver: 1, other: 0 },
    });
  });

  test('two driver answers on the same route, either way, make it habitual and raise the prior', async () => {
    await setTripRole(db, 'school', 'driver', NOW);
    await setTripRole(db, 'home', 'driver', NOW + 1);
    await expect(isHabitualDriverRoute(db, '9q8yy', 'c23nb')).resolves.toBe(true);
    await expect(readRolePrior(db)).resolves.toBeCloseTo(0.75);
  });

  test('passenger and transit answers count as not driving', async () => {
    await setTripRole(db, 'school', 'passenger', NOW);
    await setTripRole(db, 'home', 'other', NOW + 1);
    await expect(createSettingsRepo(db).get(ROLE_ROUTES_KEY)).resolves.toEqual({
      [routeKey('9q8yy', 'c23nb')]: { driver: 0, other: 2 },
    });
    await expect(readRolePrior(db)).resolves.toBeCloseTo(0.25);
  });

  test('a trip with no stored geohashes trains the prior only', async () => {
    await setTripRole(db, 'unknown', 'driver', NOW);
    const settings = createSettingsRepo(db);
    await expect(settings.get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings.get(ROLE_ROUTES_KEY)).resolves.toBeNull();
  });

  test('a refused answer trains nothing', async () => {
    await expect(setTripRole(db, 'ghost', 'driver', NOW)).rejects.toBeInstanceOf(MissingTripError);
    await expect(createSettingsRepo(db).get(ROLE_PRIOR_KEY)).resolves.toBeNull();
  });
});
