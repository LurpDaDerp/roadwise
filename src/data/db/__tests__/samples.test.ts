/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { MissingTripError } from '@/data/db/errors';
import { migrate } from '@/data/db/migrate';
import { createSamplesRepo } from '@/data/db/samples';
import { createTripsRepo } from '@/data/db/trips';

const T0 = 1_700_000_000_000;

/** A trimmed stand-in for the native module's 1 Hz feature row. */
const featureRow = (ts: number) => ({ ts, lat: 47.606, lng: -122.332, speed: 20.5, locked: false });

let db: Db;
let samples: ReturnType<typeof createSamplesRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  samples = createSamplesRepo(db);
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: 'trip-1', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  await trips.insert({ client_trip_id: 'trip-2', started_at: T0, tz: 'UTC', status: 'recording' }, T0);
});

test('append stores one row and count reports it', async () => {
  await samples.append('trip-1', T0, featureRow(T0));
  await expect(samples.count('trip-1')).resolves.toBe(1);
});

test('appended rows read back as the JSON that went in', async () => {
  await samples.append('trip-1', T0, featureRow(T0));
  const [row] = await samples.range('trip-1', T0, T0);
  expect(row?.client_trip_id).toBe('trip-1');
  expect(row?.ts).toBe(T0);
  expect(JSON.parse(row?.row_json ?? 'null')).toEqual(featureRow(T0));
});

test('appending the same timestamp twice replaces rather than throwing', async () => {
  await samples.append('trip-1', T0, { speed: 1 });
  await samples.append('trip-1', T0, { speed: 2 });

  const rows = await samples.range('trip-1', T0, T0);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]?.row_json ?? 'null')).toEqual({ speed: 2 });
});

test('appendMany writes a whole 1 Hz batch in one transaction', async () => {
  await samples.appendMany(
    'trip-1',
    [0, 1000, 2000, 3000].map((offset) => ({ ts: T0 + offset, row: featureRow(T0 + offset) }))
  );
  await expect(samples.count('trip-1')).resolves.toBe(4);
});

test('append refuses to orphan a row on a trip that is not there', async () => {
  await expect(samples.append('ghost', T0, featureRow(T0))).rejects.toThrow(MissingTripError);
  await expect(samples.count('ghost')).resolves.toBe(0);
});

test('appendMany writes nothing when the trip is not there', async () => {
  const batch = [0, 1000, 2000].map((offset) => ({ ts: T0 + offset, row: featureRow(T0) }));

  // Checked inside the transaction, before any row is written, so the batch rolls back even on
  // a driver that does not enforce foreign keys there.
  await expect(samples.appendMany('ghost', batch)).rejects.toThrow(MissingTripError);

  await expect(samples.count('ghost')).resolves.toBe(0);
  const all = await db.execute('SELECT count(*) AS n FROM samples');
  expect(all.rows).toEqual([{ n: 0 }]);
});

test('MissingTripError from a batch names the trip that was missing', async () => {
  expect.assertions(2);
  try {
    await samples.appendMany('ghost', [{ ts: T0, row: {} }]);
  } catch (error) {
    expect(error).toBeInstanceOf(MissingTripError);
    expect((error as MissingTripError).clientTripId).toBe('ghost');
  }
});

test('range is inclusive at both ends and ordered oldest first', async () => {
  await samples.appendMany(
    'trip-1',
    [0, 1000, 2000, 3000, 4000].map((offset) => ({ ts: T0 + offset, row: { offset } }))
  );

  const rows = await samples.range('trip-1', T0 + 1000, T0 + 3000);
  expect(rows.map((r) => r.ts)).toEqual([T0 + 1000, T0 + 2000, T0 + 3000]);
});

test('range never leaks another trip rows', async () => {
  await samples.append('trip-1', T0, { a: 1 });
  await samples.append('trip-2', T0, { a: 2 });

  const rows = await samples.range('trip-1', T0 - 1, T0 + 1);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]?.row_json ?? 'null')).toEqual({ a: 1 });
});

test('purgeByTrip reports how many rows it dropped and spares the other trips', async () => {
  await samples.appendMany('trip-1', [
    { ts: T0, row: {} },
    { ts: T0 + 1000, row: {} },
  ]);
  await samples.append('trip-2', T0, {});

  await expect(samples.purgeByTrip('trip-1')).resolves.toBe(2);
  await expect(samples.count('trip-1')).resolves.toBe(0);
  await expect(samples.count('trip-2')).resolves.toBe(1);
});

test('latest returns the newest row for a trip, else null', async () => {
  await expect(samples.latest('trip-1')).resolves.toBeNull();

  await samples.appendMany('trip-1', [
    { ts: T0, row: { n: 1 } },
    { ts: T0 + 2000, row: { n: 3 } },
    { ts: T0 + 1000, row: { n: 2 } },
  ]);

  const row = await samples.latest('trip-1');
  expect(row?.ts).toBe(T0 + 2000);
});

test('purgeByTrip on a transaction handle is undone when that transaction rolls back', async () => {
  await samples.appendMany('trip-1', [{ ts: T0, row: { n: 1 } }, { ts: T0 + 1000, row: { n: 2 } }]);
  await expect(
    db.transaction(async (tx) => {
      await samples.purgeByTrip('trip-1', tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  await expect(samples.count('trip-1')).resolves.toBe(2);

  await expect(db.transaction((tx) => samples.purgeByTrip('trip-1', tx))).resolves.toBe(2);
  await expect(samples.count('trip-1')).resolves.toBe(0);
});

test('appendMany on a transaction handle joins it: undone on rollback, and still refuses a missing trip', async () => {
  const batch = [{ ts: T0, row: { n: 1 } }, { ts: T0 + 1000, row: { n: 2 } }];
  await expect(
    db.transaction(async (tx) => {
      await samples.appendMany('trip-1', batch, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  await expect(samples.count('trip-1')).resolves.toBe(0);

  await expect(
    db.transaction((tx) => samples.appendMany('ghost', batch, tx))
  ).rejects.toThrow(MissingTripError);

  await db.transaction((tx) => samples.appendMany('trip-1', batch, tx));
  await expect(samples.count('trip-1')).resolves.toBe(2);
});
