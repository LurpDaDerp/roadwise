/** @jest-environment node */
import { createDetectors } from '@/core/detectors';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import { recoverRecordingTrips } from '@/core/engine/recovery';
import { rebuildFromSamples } from '@/core/engine/replay';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSamplesRepo, createTripsRepo, migrate, type Db } from '@/data/db';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

async function recording(id: string, n: number, t0 = T0): Promise<void> {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: id, started_at: t0, tz: TZ, status: 'recording' }, t0);
  if (n > 0) {
    await createSamplesRepo(db).appendMany(id, rows(n, { t0 }).map((r) => ({ ts: r.ts, row: r })));
    await trips.checkpoint(id, t0 + (n - 1) * 1000);
  }
}

const base = () => ({
  createDetectors: () => createDetectors(() => 'x'),
  limits: { lookup: () => null },
  now: () => T0 + 600_000,
});

test('rebuildFromSamples replays the durable rows into a session with no pending rows; null without samples', async () => {
  await recording(uuid(1), 100);
  const trip = (await createTripsRepo(db).get(uuid(1)))!;
  const rebuilt = (await rebuildFromSamples(db, trip, base()))!;
  expect(rebuilt.session).toMatchObject({ clientTripId: uuid(1), rowsCount: 100, lastRowTs: T0 + 99_000, pending: [], checkpointTs: T0 + 99_000 });
  expect(rebuilt.session.distanceM).toBeCloseTo(1485, 0);
  await recording(uuid(2), 0);
  expect(await rebuildFromSamples(db, (await createTripsRepo(db).get(uuid(2)))!, base())).toBeNull();
});

test('the newest recording drive is adopted when the capture still runs; older ones are finalized as orphans; empty ones removed', async () => {
  await recording(uuid(1), 50, T0 - 3_600_000);
  await recording(uuid(2), 0, T0 - 1_800_000);
  await recording(uuid(3), 120, T0);
  const finalized: Readonly<TripSession>[] = [];
  const result = await recoverRecordingTrips(db, {
    ...base(),
    adoptable: async (trip) => trip.client_trip_id === uuid(3),
    finalize: async (s) => {
      finalized.push(s);
      await createTripsRepo(db).update(s.clientTripId, { status: 'pending' });
    },
  });
  expect(result.adopt?.session.clientTripId).toBe(uuid(3));
  expect(result.finalized).toEqual([uuid(1)]);
  expect(result.removed).toEqual([uuid(2)]);
  expect(result.failed).toEqual([]);
  expect(finalized[0]).toMatchObject({ endCause: 'orphan', endedAt: T0 - 3_600_000 + 50_000 });
  expect(await createTripsRepo(db).get(uuid(2))).toBeNull();
});

test('with no capture running, the newest drive is finalized too; a failing finalize is reported, not thrown', async () => {
  await recording(uuid(3), 120);
  const result = await recoverRecordingTrips(db, {
    ...base(),
    adoptable: async () => false,
    finalize: async () => {
      throw new Error('db locked');
    },
  });
  expect(result.adopt).toBeNull();
  expect(result.failed.map((f) => f.clientTripId)).toEqual([uuid(3)]);
});

test('a rebuilt drive decides its warm-up as the live engine did: a stored restart has none, a moving start ends it at its first row', async () => {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(1), started_at: T0, tz: TZ, status: 'recording', continues: 1 }, T0);
  await createSamplesRepo(db).appendMany(uuid(1), rows(10, { speedMps: 0 }).map((r) => ({ ts: r.ts, row: r })));
  const restart = (await rebuildFromSamples(db, (await trips.get(uuid(1)))!, base()))!;
  expect(restart.session.warmup).toEqual({ continues: true, decided: true, endsAt: T0 });

  await recording(uuid(2), 10, T0 - 2000);
  const moving = (await rebuildFromSamples(db, (await trips.get(uuid(2)))!, base()))!;
  expect(moving.session.warmup).toEqual({ continues: false, decided: true, endsAt: T0 - 2000 });

  await trips.insert({ client_trip_id: uuid(3), started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(uuid(3), rows(10, { speedMps: 0 }).map((r) => ({ ts: r.ts, row: r })));
  const stopped = (await rebuildFromSamples(db, (await trips.get(uuid(3)))!, base()))!;
  expect(stopped.session.warmup).toEqual({ continues: false, decided: true, endsAt: T0 + 30_000 });
});
