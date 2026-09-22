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
import { currentOwnerUid, enqueueTraceUpload, SESSION_UID_KEY } from '@/data/sync/queue';

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

test('every table the schema creates is one the wipe empties, except the schema version', async () => {
  // The guard M2 lacked: a table added by a later migration and not listed in DEVICE_TABLES would
  // survive a handover with the previous driver's rows in it. SQLite's own bookkeeping
  // (`sqlite_sequence`, the AUTOINCREMENT counter) holds no driver data and is not the app's.
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const tables = rows.map((row) => String(row.name)).filter((name) => name !== 'schema_version');
  expect(tables.length).toBeGreaterThan(0);
  expect([...DEVICE_TABLES].sort()).toEqual(tables);
});

describe('the owner check', () => {
  test('the first sign-in on an empty device adopts it', async () => {
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-a', { traces })).toBe('first');

    expect(store.cleared).toBe(0);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('an unowned device with a trip on it is wiped, not adopted', async () => {
    // No owner recorded is not the same as new: every database written before this branch has
    // none, including one full of the last driver's drives (security review C-1).
    await seedEverything();
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-b', { traces })).toBe('wiped');

    // Two settings rows survive: the new owner, written in both places the app asks who owns
    // this device (`LAST_USER_KEY`) and whose work is being queued (`SESSION_UID_KEY`).
    expect(await totals()).toEqual({ ...emptyTotals, settings: 2 });
    expect(store.cleared).toBe(1);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
  });

  test('an unowned device with only queued work on it is wiped too', async () => {
    await createQueueRepo(db).enqueue('dispute', { clientTripId: 'gone' }, 'dispute:1', T0);
    const { store, traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-b', { traces })).toBe('wiped');

    expect(await countOf('sync_queue')).toBe(0);
    expect(store.cleared).toBe(1);
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

    // The only rows left are the new owner's, in both places: the wipe took the old owner's
    // `session.uid` with everything else, and it was rewritten as B rather than left as A.
    expect(await totals()).toEqual({ ...emptyTotals, settings: 2 });
    expect(store.cleared).toBe(1);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
    expect(await createSettingsRepo(db).get(SESSION_UID_KEY)).toBe('user-b');
    expect(await createSettingsRepo(db).get('focus.weekly')).toBeNull();
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

  test('the owner is stamped where the queue reads it, before anything can be queued', async () => {
    const { traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-a', { traces })).toBe('first');

    // The runner writes `session.uid` on its first pass, which can be after a drive has been
    // recorded and queued. Writing it here is what makes the stamp true rather than likely.
    expect(await createSettingsRepo(db).get(SESSION_UID_KEY)).toBe('user-a');

    // Not the fallback doing the work: with the device-owner key gone, the queue still knows.
    await createSettingsRepo(db).remove(LAST_USER_KEY);
    expect(await currentOwnerUid(db)).toBe('user-a');

    // And a real enqueue site takes it, straight after the sign-in and before any drain.
    await seedTrips(db, [tripRow({ client_trip_id: TRIP })]);
    const item = await enqueueTraceUpload(
      db,
      { clientTripId: TRIP, tracePath: `${TRIP}.bin.gz` },
      T0
    );
    expect(item.owner_uid).toBe('user-a');
  });

  test('a launch by the owner re-stamps the queue key, whatever state it was left in', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const { traces } = fakeTraces();

    expect(await ensureDeviceOwner(db, 'user-a', { traces })).toBe('same');

    expect(await createSettingsRepo(db).get(SESSION_UID_KEY)).toBe('user-a');
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
