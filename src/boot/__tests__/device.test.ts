import {
  DEVICE_TABLES,
  ensureDeviceOwner,
  LAST_USER_KEY,
  wipeDevice,
} from '@/boot/device';
import {
  createQueueRepo,
  createSamplesRepo,
  createSettingsRepo,
  type Db,
} from '@/data/db';
import { createTestDb, seedDay, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { SESSION_UID_KEY } from '@/data/sync/queue';

const TRIP = 'trip-1';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/** A device with something in every table the wipe is supposed to empty. */
async function seedEverything(): Promise<void> {
  await seedTrips(db, [tripRow({ client_trip_id: TRIP })]);
  await seedEvents(db, [eventRow({ id: 'e1', client_trip_id: TRIP })]);
  await createSamplesRepo(db).append(TRIP, T0, { speed: 10 });
  await createQueueRepo(db).enqueue('finalize-trip', { clientTripId: TRIP }, `key:${TRIP}`, T0);
  await seedDay(db, '2026-01-05', { day: '2026-01-05', safeDay: true }, T0);
  await createSettingsRepo(db).set('focus.weekly', { tipId: 'braking-low-new', setAt: T0 });
  // The uid the queue stamps its items with (Task 7's half of this fix).
  await createSettingsRepo(db).set(SESSION_UID_KEY, 'user-a');
  await db.execute(
    'INSERT OR REPLACE INTO speed_limit_tiles (tile_key, expires_at, segments_json) VALUES (?, ?, ?)',
    ['tile-1', T0 + 86_400_000, '[]']
  );
}

async function countOf(table: string): Promise<number> {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number((rows[0] as Record<string, unknown>).n);
}

async function totals(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of DEVICE_TABLES) out[table] = await countOf(table);
  return out;
}

const emptyTotals = Object.fromEntries(DEVICE_TABLES.map((table) => [table, 0]));

/** The traces directory, as `createExpoTraceWriter` presents it to the wipe. */
function fakeTraces() {
  const store = { cleared: 0 };
  return {
    store,
    traces: {
      clear: async () => {
        store.cleared += 1;
      },
    },
  };
}

test('a device with data in every table is emptied, traces and all — but not its schema', async () => {
  await seedEverything();
  const { store, traces } = fakeTraces();
  expect(await totals()).not.toEqual(emptyTotals);

  await wipeDevice(db, { traces });

  expect(await totals()).toEqual(emptyTotals);
  expect(store.cleared).toBe(1);
  // The schema is the app's, not the driver's: migrations must not run again on the next launch.
  expect(await countOf('schema_version')).toBe(1);
});

test('a traces directory that will not clear is reported, and the rows are gone anyway', async () => {
  await seedEverything();
  const reported: string[] = [];

  await wipeDevice(db, {
    traces: { clear: () => Promise.reject(new Error('EPERM')) },
    onError: (_error, context) => reported.push(context),
  });

  expect(await totals()).toEqual(emptyTotals);
  expect(reported).toEqual(['wipe traces']);
});

describe('the owner check', () => {
  test('the first sign-in ever keeps whatever the device already recorded', async () => {
    await seedEverything();
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-a', { traces })).toBe('first');

    expect(await countOf('trips')).toBe(1);
    expect(store.cleared).toBe(0);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('the same user signing in again changes nothing at all', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await seedEverything();
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-a', { traces })).toBe('same');

    expect(await countOf('trips')).toBe(1);
    expect(await countOf('sync_queue')).toBe(1);
    expect(store.cleared).toBe(0);
  });

  test('a different user gets a clean device: no trips, no queue, no traces', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await seedEverything();
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-b', { traces })).toBe('wiped');

    expect(await totals()).toEqual({ ...emptyTotals, settings: 1 });
    expect(store.cleared).toBe(1);
    // The one row left is the new owner: the wipe took the old one with everything else.
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
    expect(await createSettingsRepo(db).get('focus.weekly')).toBeNull();
    // The old owner's uid goes with everything else, so nothing can be stamped with it again.
    expect(await createSettingsRepo(db).get(SESSION_UID_KEY)).toBeNull();
  });

  test('signing out wipes nothing and keeps the owner, so the drives waiting to upload survive', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await seedEverything();
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, null, { traces })).toBe('signed-out');

    expect(await countOf('sync_queue')).toBe(1);
    expect(store.cleared).toBe(0);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('the wipe happens once: the second launch under the new user is a quiet one', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await seedEverything();
    const { store, traces } = fakeTraces();

    await ensureDeviceOwner(db, 'user-b', { traces });
    await seedTrips(db, [tripRow({ client_trip_id: 'b-first-drive' })]);

    expect(await ensureDeviceOwner(db, 'user-b', { traces })).toBe('same');
    expect(await countOf('trips')).toBe(1);
    expect(store.cleared).toBe(1);
  });
});
