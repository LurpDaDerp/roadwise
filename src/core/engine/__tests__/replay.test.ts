/** @jest-environment node */
import * as scoring from '@scoring';
import { CONSTANTS } from '@scoring';
import { createDetectors, mergeEvents } from '@/core/detectors';
import { T0, counterIds } from '@/core/detectors/__fixtures__/rows';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { drive, finalizeDeps, TZ } from '@/core/engine/__fixtures__/drives';
import type { StartEvidence, TripSession } from '@/core/engine/engine.types';
import { arbiterStateKey, createRecorder } from '@/core/engine/recorder';
import { recoverRecordingTrips } from '@/core/engine/recovery';
import { rebuildFromSamples, type ReplayDeps } from '@/core/engine/replay';
import { appendRow, closeSession, createSession, snapshotSession } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';
import {
  createEventsRepo,
  createSettingsRepo,
  createTripsRepo,
  migrate,
  type Db,
  type TripRow,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';

const { CHECKPOINT_S } = CONSTANTS;
const TRIP = 'trip-1';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

const replayDeps = (): ReplayDeps => ({
  createDetectors: () => createDetectors(counterIds()),
  tz: TZ,
  constants: CONSTANTS,
});

/** A recording the recorder checkpointed at its cadence, then the process died. */
async function orphan(
  rows: readonly FeatureRow[],
  opts: { evidence?: StartEvidence; arbiter?: TripSession['arbiterState'] } = {}
): Promise<TripRow> {
  const recorder = createRecorder(db, { tz: TZ, now: () => T0 });
  const evidence = opts.evidence ?? 'tap';
  const s = createSession({
    clientTripId: TRIP,
    mode: 'mounted',
    role: 'driver',
    startSource: evidence === 'auto' ? 'auto' : 'manual',
    startEvidence: evidence,
    startedAt: rows[0]?.ts ?? T0,
  });
  s.arbiterState = opts.arbiter ?? null;
  for (const row of rows) {
    appendRow(s, row, UNKNOWN_LIMIT);
    if (s.rowsCount % CHECKPOINT_S === 0) {
      await recorder.onCheckpoint(snapshotSession(s));
      s.checkpoints.push(s.lastRowTs as number);
    }
  }
  return (await createTripsRepo(db).get(TRIP)) as TripRow;
}

test('no samples: null, nothing to rebuild', async () => {
  const trip = await orphan(drive(10)); // under one cadence: the row was never written…
  expect(trip).toBeNull();
  await createTripsRepo(db).insert(
    { client_trip_id: TRIP, started_at: T0, tz: TZ, status: 'recording' },
    T0
  );
  const row = (await createTripsRepo(db).get(TRIP)) as TripRow;
  await expect(rebuildFromSamples(db, row, replayDeps())).resolves.toBeNull();
});

test('the open session: the trip itself, every durable row, the checkpoint, detectors not flushed, the stored arbiter state', async () => {
  const stored = { tripIndex: 5, l1Window: [T0 + 1000], mutedAll: true };
  const trip = await orphan(drive(200, { brakeAt: 100 }), { arbiter: stored });
  const rebuilt = await rebuildFromSamples(db, trip, replayDeps());
  expect(rebuilt).not.toBeNull();
  const { session, detectors, rows, arbiterState } = rebuilt!;
  expect(rows).toBe(180); // six cadence checkpoints; the 20-row tail died with the process
  expect(session).toMatchObject({
    clientTripId: TRIP,
    mode: 'mounted',
    role: 'driver',
    startSource: 'manual',
    startEvidence: 'tap',
    startedAt: T0,
    rowsCount: 180,
    lastRowTs: T0 + 179_000,
    checkpoints: [T0 + 179_000],
    endedAt: null,
    arbiterState: stored,
  });
  expect(arbiterState).toEqual(stored);
  expect(session.rows).toHaveLength(120); // the ring, as the engine keeps it
  // The brake closed during the replay; nothing is open at row 179, and flush adds nothing.
  expect(session.events.map((e) => e.category)).toEqual(['braking']);
  expect(detectors.flush()).toEqual([]);
});

test.each([
  ['tap', 'manual', 'tap'],
  ['movingStart', 'manual', 'movingStart'],
  ['auto', 'auto', 'auto'],
] as const)('a trip started by %s comes back as startSource %s, evidence %s', async (evidence, source, back) => {
  const trip = await orphan(drive(60), { evidence });
  const rebuilt = await rebuildFromSamples(db, trip, replayDeps());
  expect(rebuilt?.session).toMatchObject({ startSource: source, startEvidence: back });
});

test('a role_source the recorder never writes comes back as the start that claims least: auto', async () => {
  const trip = await orphan(drive(60));
  const rebuilt = await rebuildFromSamples(db, { ...trip, role_source: null }, replayDeps());
  expect(rebuilt?.session).toMatchObject({ startSource: 'auto', startEvidence: 'auto' });
});

test('the replay cannot vouch for the lock signal: a backgrounded app on a mount is no evidence', async () => {
  const switched = drive(90).map((r, i) =>
    i >= 40 && i < 60 ? { ...r, appForeground: false, locked: false, screenOn: true } : r
  );
  const trip = await orphan(switched);
  const rebuilt = await rebuildFromSamples(db, trip, replayDeps());
  expect([...rebuilt!.session.events, ...rebuilt!.detectors.flush()]).toEqual([]);
});

test('equals what recovery finalizes: the same rows, metrics and events', async () => {
  const trip = await orphan(drive(200, { brakeAt: 100 }), { arbiter: { tripIndex: 2 } });
  const rebuilt = (await rebuildFromSamples(db, trip, replayDeps()))!;
  const events = mergeEvents([...rebuilt.session.events, ...rebuilt.detectors.flush()]);
  const closed = closeSession(rebuilt.session, (rebuilt.session.lastRowTs as number) + 1000);

  const { deps } = finalizeDeps(db, () => T0);
  const result = await recoverRecordingTrips(db, {
    scoring,
    tz: TZ,
    fs: deps.fs,
    hash: deps.hash,
    now: () => T0,
    createDetectors: () => createDetectors(counterIds()),
  });
  expect(result.recovered).toEqual([TRIP]);
  const stored = await createTripsRepo(db).get(TRIP);
  expect(stored).toMatchObject({
    started_at: closed.startedAt,
    ended_at: closed.endedAt,
    duration_s: closed.durationS,
    role_source: 'manual',
    incomplete: 1,
  });
  expect(stored?.distance_m).toBeCloseTo(closed.distanceM, 6);
  const storedEvents = await createEventsRepo(db).listByTrip(TRIP);
  expect(storedEvents.map((e) => [e.id, e.category, e.started_at, e.duration_s])).toEqual(
    events.map((e) => [e.id, e.category, e.startedAt, e.durationS])
  );
  // The recovered trip took its arbiter state with it.
  await expect(createSettingsRepo(db).get(arbiterStateKey(TRIP))).resolves.toBeNull();
});
