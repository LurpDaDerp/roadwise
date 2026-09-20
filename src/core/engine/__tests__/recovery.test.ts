/** @jest-environment node */
import * as scoring from '@scoring';
import { CONSTANTS } from '@scoring';
import { createDetectors } from '@/core/detectors';
import { T0, counterIds, limit, mph } from '@/core/detectors/__fixtures__/rows';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { drive, finalizeDeps, TZ } from '@/core/engine/__fixtures__/drives';
import type { TripRole, TripSession } from '@/core/engine/engine.types';
import { tracePathFor } from '@/core/engine/finalize';
import { createRecorder } from '@/core/engine/recorder';
import { recoverRecordingTrips, type RecoveryDeps } from '@/core/engine/recovery';
import { appendRow, createSession, snapshotSession } from '@/core/engine/session';
import type { DriveMode, FeatureRow } from '@/core/engine/types';
import {
  createEventsRepo,
  createQueueRepo,
  createSamplesRepo,
  createTripsRepo,
  migrate,
  type Db,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { findFinalize } from '@/data/sync/queue';

const { CHECKPOINT_S } = CONSTANTS;
const TRIP = 'trip-1';
/** Wall clock at recovery: the next morning. */
const NOW = T0 + 36_000_000;
const L35 = limit(mph(35));

let db: Db;
let samples: ReturnType<typeof createSamplesRepo>;
let trips: ReturnType<typeof createTripsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  samples = createSamplesRepo(db);
  trips = createTripsRepo(db);
});

interface OrphanOptions {
  mode?: DriveMode;
  role?: TripRole;
  /** Deliver the rows past the last cadence checkpoint too, as `ending` or a finalize would. */
  tail?: boolean;
}

/**
 * What the recorder leaves behind when the process dies: the trip row and the rows delivered at
 * the engine's cadence (plus, with `tail`, the ones after the last cadence mark). No engine exists.
 */
async function orphan(id: string, rows: readonly FeatureRow[], opts: OrphanOptions = {}): Promise<void> {
  const recorder = createRecorder(db, { tz: TZ, now: () => rows[0]?.ts ?? T0 });
  const s: TripSession = createSession({
    clientTripId: id,
    mode: opts.mode ?? 'mounted',
    role: opts.role ?? 'driver',
    startSource: 'manual',
    startedAt: rows[0]?.ts ?? T0,
  });
  const checkpoint = async (): Promise<void> => {
    const last = s.checkpoints[s.checkpoints.length - 1] ?? null;
    if (s.lastRowTs === null || (last !== null && s.lastRowTs <= last)) return;
    await recorder.onCheckpoint(snapshotSession(s));
    s.checkpoints.push(s.lastRowTs);
  };
  for (const row of rows) {
    appendRow(s, row, UNKNOWN_LIMIT);
    if (s.rowsCount % CHECKPOINT_S === 0) await checkpoint();
  }
  if (opts.tail !== false) await checkpoint();
}

function recoveryDeps(overrides: Partial<RecoveryDeps> = {}) {
  const { deps: fin, files } = finalizeDeps(db, () => NOW);
  const deps: RecoveryDeps = {
    scoring,
    tz: TZ,
    fs: fin.fs,
    hash: fin.hash,
    now: () => NOW,
    createDetectors: () => createDetectors(counterIds()),
    ...overrides,
  };
  return { deps, files };
}

test('an orphaned 200-row recording with a hard brake is finalized from its checkpoints, incomplete, with the brake scored', async () => {
  const rows = drive(200, { brakeAt: 100 });
  await orphan(TRIP, rows);
  await expect(samples.count(TRIP)).resolves.toBe(200);
  const last = rows[199] as FeatureRow;
  const { deps, files } = recoveryDeps();

  const result = await recoverRecordingTrips(db, deps);

  expect(result).toEqual({ recovered: [TRIP], discarded: [], failed: [] });
  const trip = await trips.get(TRIP);
  expect(trip).toMatchObject({
    status: 'provisional',
    sync_state: 'queued',
    incomplete: 1,
    started_at: rows[0]?.ts,
    ended_at: last.ts + 1000,
    checkpoint_ts: last.ts,
    role: 'driver',
    mode: 'mounted',
    role_source: 'manual',
    tz: TZ,
    updated_at: NOW,
  });
  expect(trip?.score).not.toBeNull();
  expect(Math.abs((trip?.duration_s ?? 0) - 200)).toBeLessThanOrEqual(2);

  const events = await createEventsRepo(db).listByTrip(TRIP);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    category: 'braking',
    started_at: (rows[100] as FeatureRow).ts,
    status: 'scored',
    source: 'both',
    confidence: 0.95,
    // No arbiter ran: nothing was said.
    alert_shown: 0,
  });

  const payload = await findFinalize(db, TRIP);
  expect(payload).toMatchObject({
    clientTripId: TRIP,
    incomplete: true,
    endedAt: last.ts + 1000,
    hadSevereEvent: false,
    rowsDigest: expect.objectContaining({ count: 200 }),
  });
  expect(payload?.provisional.score).toBe(trip?.score);
  expect(Math.abs((payload?.durationS ?? 0) - 200)).toBeLessThanOrEqual(2);
  expect(payload?.events.map((e) => e.category)).toEqual(['braking']);

  await expect(samples.count(TRIP)).resolves.toBe(0);
  expect(files.has(tracePathFor(TRIP))).toBe(true);
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
});

test('without a limit cache nothing is speeding; with one, the cached limit is applied per fix', async () => {
  // 20 m/s (about 45 mph) the whole way: 10 mph over a 35.
  const rows = drive(200, { speed: 20 });
  await orphan(TRIP, rows);

  const blind = await recoverRecordingTrips(db, recoveryDeps().deps);
  expect(blind.recovered).toEqual([TRIP]);
  await expect(createEventsRepo(db).listByTrip(TRIP)).resolves.toEqual([]);
  expect((await trips.get(TRIP))?.limit_coverage_pct).toBe(0);

  await db.execute('DELETE FROM sync_queue');
  await db.execute('DELETE FROM trips');
  await orphan(TRIP, rows);
  const lookup = jest.fn(async () => L35);
  const cached = await recoverRecordingTrips(db, recoveryDeps({ limits: { lookup } }).deps);
  expect(cached.recovered).toEqual([TRIP]);
  expect(lookup).toHaveBeenCalledTimes(200);
  expect(lookup).toHaveBeenCalledWith(rows[0]?.lat, rows[0]?.lng);
  // One episode per stretch between the four lost fixes: an unknown speed closes an episode.
  const events = await createEventsRepo(db).listByTrip(TRIP);
  expect(events).toHaveLength(5);
  for (const e of events) expect(e).toMatchObject({ category: 'speeding', status: 'scored', alert_shown: 0 });
  expect((await trips.get(TRIP))?.limit_coverage_pct).toBe(100);
});

test('the role stored on the row is honoured: a passenger orphan recovers unscored', async () => {
  await orphan(TRIP, drive(200), { role: 'passenger', mode: 'pocket' });
  const result = await recoverRecordingTrips(db, recoveryDeps().deps);
  expect(result.recovered).toEqual([TRIP]);
  expect(await trips.get(TRIP)).toMatchObject({
    status: 'unscored',
    sync_state: 'queued',
    incomplete: 1,
    role: 'passenger',
    mode: 'pocket',
    score: null,
  });
  expect((await findFinalize(db, TRIP))?.provisional).toMatchObject({ status: 'unscored', reason: 'passenger' });
});

test('a recording with no samples is removed and reported as discarded; settled trips are untouched', async () => {
  await trips.insert({ client_trip_id: 'empty', started_at: T0, tz: TZ, status: 'recording' }, T0);
  await trips.insert(
    { client_trip_id: 'done', started_at: T0 - 1000, tz: TZ, status: 'provisional', sync_state: 'queued', score: 88 },
    T0
  );

  const result = await recoverRecordingTrips(db, recoveryDeps().deps);

  expect(result).toEqual({ recovered: [], discarded: ['empty'], failed: [] });
  await expect(trips.get('empty')).resolves.toBeNull();
  expect(await trips.get('done')).toMatchObject({ status: 'provisional', score: 88, updated_at: T0 });
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(0);
});

test('one trip whose finalize throws lands in failed, untouched, while its sibling recovers; the next start retries it', async () => {
  const BAD = 'trip-bad';
  await orphan(TRIP, drive(200));
  await orphan(BAD, drive(200, { t0: T0 + 3_600_000 }));
  // The queue insert for the bad trip alone fails; everything rolls back with it.
  const failing: Db = {
    execute: (sql, params) => db.execute(sql, params),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          execute: (sql, params) =>
            sql.includes('sync_queue') && (params ?? []).some((p) => String(p).includes(BAD))
              ? Promise.reject(new Error('disk full'))
              : tx.execute(sql, params),
        })
      ),
  };
  const { deps } = recoveryDeps();

  const result = await recoverRecordingTrips(failing, deps);

  expect(result.recovered).toEqual([TRIP]);
  expect(result.discarded).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]).toMatchObject({ clientTripId: BAD, error: expect.any(Error) });
  expect((result.failed[0]?.error as Error).message).toBe('disk full');
  expect(await trips.get(TRIP)).toMatchObject({ status: 'provisional', sync_state: 'queued', incomplete: 1 });
  expect(await trips.get(BAD)).toMatchObject({ status: 'recording', sync_state: 'local', score: null, incomplete: 0 });
  await expect(samples.count(BAD)).resolves.toBe(200);
  await expect(createEventsRepo(db).countByTrip(BAD)).resolves.toBe(0);

  const retry = await recoverRecordingTrips(db, deps);
  expect(retry).toEqual({ recovered: [BAD], discarded: [], failed: [] });
  expect(await trips.get(BAD)).toMatchObject({ status: 'provisional', sync_state: 'queued', incomplete: 1 });
  await expect(samples.count(BAD)).resolves.toBe(0);
});

test('only the checkpointed rows exist after a crash: the trip ends one row-length after the last durable row', async () => {
  // 200 rows driven, but the process died before the tail past row 179 was checkpointed.
  const rows = drive(200);
  await orphan(TRIP, rows, { tail: false });
  await expect(samples.count(TRIP)).resolves.toBe(180);

  const result = await recoverRecordingTrips(db, recoveryDeps().deps);

  expect(result.recovered).toEqual([TRIP]);
  const last = rows[179] as FeatureRow;
  expect(await trips.get(TRIP)).toMatchObject({
    incomplete: 1,
    ended_at: last.ts + 1000,
    checkpoint_ts: last.ts,
    duration_s: 180,
  });
  expect((await findFinalize(db, TRIP))?.rowsDigest.count).toBe(180);
});
