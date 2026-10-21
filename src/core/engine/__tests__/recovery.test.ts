/** @jest-environment node */
import { createDetectors } from '@/core/detectors';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import { closeDrive, isDropped } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { recoverRecordingTrips } from '@/core/engine/recovery';
import { rebuildFromSamples } from '@/core/engine/replay';
import { appendRow, createSession } from '@/core/engine/session';
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

test('a rebuilt session equals the live one on droveAt, lastDroveAt, lastSpeed, marks, moved and the movement state', async () => {
  // 40 rows parked, then 200 driving: the live engine's appendRow over the same rows.
  const list = rows(240, { over: (i) => (i < 40 ? { speed: 0 } : {}) });
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(uuid(9), list.map((r) => ({ ts: r.ts, row: r })));
  const rebuilt = (await rebuildFromSamples(db, (await trips.get(uuid(9)))!, base()))!.session;
  const live = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
  for (const r of list) appendRow(live, r, { unsafe: false, limitUsable: false });
  expect(rebuilt.droveAt).toBe(T0 + 41_000);
  expect(rebuilt.droveAt).toBe(live.droveAt);
  expect(rebuilt.lastDroveAt).toBe(T0 + 239_000);
  expect(rebuilt.lastDroveAt).toBe(live.lastDroveAt);
  expect(rebuilt.lastSpeed).toEqual(live.lastSpeed);
  expect(rebuilt.marks).toEqual(live.marks);
  expect(rebuilt.moved).toEqual(live.moved);
  expect(rebuilt.motion).toEqual(live.motion);
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
      return 'finalized' as const;
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

test('a rebuilt drive agrees with the live engine on movement: the mark (bar safe miles and limit time, which follow the tiles), the hold and the warm-up, despite missing tiles', async () => {
  // Driving, a tunnel (vehicle-like fix-less rows), more driving with handling, then parked.
  const list = [
    ...rows(60, { speedMps: 15 }),
    ...rows(40, { t0: T0 + 60_000, speedMps: 15, over: () => ({ gnssValid: false, speed: -1, gravityStability: 0.9, yawRateMax: 0.1 }) }),
    ...rows(60, { t0: T0 + 100_000, speedMps: 15, over: (i) => (i >= 20 && i < 30 ? { handlingScore: 0.9, gravityStability: 0.5 } : {}) }),
    ...rows(120, { t0: T0 + 160_000, speedMps: 0 }),
  ];
  let live: Readonly<TripSession> | null = null;
  const engine = createEngine({
    now: () => T0,
    newId: () => uuid(7),
    limits: { lookup: () => ({ limitMps: 35 * 0.44704, source: 'posted', matchConfidence: 1, parallelRoads: false }), prefetch: () => {} },
    createDetectors: () => createDetectors(() => 'x'),
    ctx: () => ({}),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async () => {},
    onCancel: async () => {},
  });
  await engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  for (const r of list) await engine.dispatch({ type: 'row', row: r });
  live = engine.session();

  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(7), started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(uuid(7), list.map((r) => ({ ts: r.ts, row: r })));
  const rebuilt = (await rebuildFromSamples(db, (await trips.get(uuid(7)))!, base()))!.session;

  const { safeDistanceM: _a, exposure: liveExposure, ...liveMark } = live!.moved!;
  const { safeDistanceM: _b, exposure: rebuiltExposure, ...rebuiltMark } = rebuilt.moved!;
  expect(rebuiltMark).toEqual(liveMark);
  expect({ ...rebuiltExposure, limitS: 0 }).toEqual({ ...liveExposure, limitS: 0 });
  expect(liveExposure.limitS).toBeGreaterThan(0);
  expect(rebuilt.motion).toEqual(live!.motion);
  expect(rebuilt.warmup).toEqual(live!.warmup);
  expect(live!.moved!.rowTs).toBe(T0 + 159_000);
});

test('an orphan is closed where the car last moved: at its last row + 1 s when killed at speed, at the stop when parked; rows past 12 h are not replayed', async () => {
  const trips = createTripsRepo(db);
  const finalized: Readonly<TripSession>[] = [];
  const finalize = async (s: Readonly<TripSession>) => {
    finalized.push(s);
    await trips.update(s.clientTripId, { status: 'pending' });
    return 'finalized' as const;
  };
  // Killed at speed.
  await recording(uuid(1), 50, T0 - 7_200_000);
  // Parked for 10 min after 60 s of driving.
  await trips.insert({ client_trip_id: uuid(2), started_at: T0 - 3_600_000, tz: TZ, status: 'recording' }, T0);
  const parked = [...rows(60, { t0: T0 - 3_600_000 }), ...rows(600, { t0: T0 - 3_540_000, speedMps: 0 })];
  await createSamplesRepo(db).appendMany(uuid(2), parked.map((r) => ({ ts: r.ts, row: r })));
  // Samples past 12 h (a clock jump): ignored by the replay.
  await trips.insert({ client_trip_id: uuid(3), started_at: T0 - 50_000_000, tz: TZ, status: 'recording' }, T0);
  const long = [...rows(30, { t0: T0 - 50_000_000 }), ...rows(30, { t0: T0 - 50_000_000 + 43_200_000 })];
  await createSamplesRepo(db).appendMany(uuid(3), long.map((r) => ({ ts: r.ts, row: r })));

  const result = await recoverRecordingTrips(db, { ...base(), adoptable: async () => false, finalize });
  expect(result.failed).toEqual([]);
  const byId = new Map(finalized.map((s) => [s.clientTripId, s]));
  expect(byId.get(uuid(1))).toMatchObject({ endCause: 'orphan', endedAt: T0 - 7_200_000 + 50_000, cut: true });
  expect(byId.get(uuid(2))).toMatchObject({ endCause: 'orphan', endedAt: T0 - 3_540_000, cut: true, rowsCount: 60 });
  expect(byId.get(uuid(3))).toMatchObject({ endCause: 'orphan', endedAt: T0 - 50_000_000 + 30_000, cut: true, rowsCount: 30 });
});

test('an orphan that never moved is dropped with closeDrive: trip, samples, events and coverage gone, nothing queued', async () => {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(4), started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(uuid(4), rows(120, { speedMps: 0 }).map((r) => ({ ts: r.ts, row: r })));
  await db.execute('INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES (?, 0, 0)', [uuid(4)]);
  const reasons: string[] = [];
  const result = await recoverRecordingTrips(db, {
    ...base(),
    adoptable: async () => false,
    finalize: async (s) => {
      const r = await closeDrive(s, { db, tz: TZ, appVersion: '2.0.0', geocode: null, trimSeed: async () => '0'.repeat(64) });
      if (!isDropped(r)) return 'finalized';
      reasons.push(r.dropped);
      return 'dropped';
    },
  });
  expect(result).toMatchObject({ dropped: [uuid(4)], finalized: [], failed: [] });
  expect(reasons).toEqual(['no_movement']);
  expect(await trips.get(uuid(4))).toBeNull();
  expect(await createSamplesRepo(db).count(uuid(4))).toBe(0);
  expect((await db.execute('SELECT * FROM dashcam_coverage')).rows).toEqual([]);
  expect((await db.execute('SELECT * FROM sync_queue')).rows).toEqual([]);
});
