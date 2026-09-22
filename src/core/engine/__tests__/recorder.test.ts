/** @jest-environment node */
import { CONSTANTS } from '@scoring';
import { createArbiter } from '@/core/alerts/arbiter';
import type { ArbiterState } from '@/core/alerts/types';
import { createDetectors } from '@/core/detectors';
import { T0, counterIds, limit, mph } from '@/core/detectors/__fixtures__/rows';
import { drive, finalizeDeps, TZ } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import { finalizeTrip, tracePathFor, type FinalizeResult } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import { arbiterStateKey, createRecorder } from '@/core/engine/recorder';
import { appendRow, closeSession, createSession, snapshotSession } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';
import {
  createQueueRepo,
  createSamplesRepo,
  createSettingsRepo,
  createTripsRepo,
  migrate,
  type Db,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';

const { CHECKPOINT_S, LEARNING_PERIOD_TRIPS } = CONSTANTS;
const TRIP = 'trip-1';
const L35 = limit(mph(35));
const at = (s: number) => T0 + s * 1000;

let db: Db;
let now: number;
let samples: ReturnType<typeof createSamplesRepo>;
let trips: ReturnType<typeof createTripsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  samples = createSamplesRepo(db);
  trips = createTripsRepo(db);
  now = at(0);
});

const only = <T>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
};

describe('with the real engine: createEngine → recorder → finalizeTrip', () => {
  /** The host as M3 wires it: the recorder on `onCheckpoint`, the finalizer on `onFinalize`. */
  function host() {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const { deps, files } = finalizeDeps(db, () => now);
    const results: FinalizeResult[] = [];
    const errors: unknown[] = [];
    /** How many samples were durable when the trace was written: after the tail append, before the purge. */
    let durableAtTrace = -1;
    const engine = createEngine({
      now: () => now,
      newId: () => TRIP,
      limits: { lookup: () => L35, prefetch: () => {} },
      createDetectors: () => createDetectors(counterIds()),
      createArbiter: () => createArbiter({ tripIndex: LEARNING_PERIOD_TRIPS }),
      onAlert: () => {},
      onCheckpoint: recorder.onCheckpoint,
      onFinalize: async (session) => {
        results.push(
          await finalizeTrip(session, {
            ...deps,
            fs: {
              writeGzip: async (path, bytes) => {
                durableAtTrace = await samples.count(TRIP);
                files.set(path, bytes);
              },
            },
          })
        );
      },
      onError: (err) => {
        errors.push(err);
      },
      ctx: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
    });
    async function feed(rows: readonly FeatureRow[]): Promise<void> {
      for (const row of rows) {
        now = row.ts;
        await engine.dispatch({ type: 'row', row });
      }
    }
    return { engine, feed, results, errors, files, durableAtTrace: () => durableAtTrace };
  }

  test('the cadence checkpoints land in SQLite and End finalizes from them: every row durable once, one queued scored trip, incomplete false', async () => {
    const h = host();
    const n = CHECKPOINT_S * 5 + 5;
    const rows = drive(n);
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });

    // Mid-drive: one checkpoint so far, the row created with it.
    await h.feed(rows.slice(0, 45));
    await expect(samples.count(TRIP)).resolves.toBe(CHECKPOINT_S);
    expect(await trips.get(TRIP)).toMatchObject({
      status: 'recording',
      sync_state: 'local',
      started_at: at(0),
      tz: TZ,
      role: 'driver',
      mode: 'mounted',
      role_source: 'manual',
      checkpoint_ts: at(CHECKPOINT_S - 1),
      incomplete: 0,
      created_at: at(CHECKPOINT_S - 1),
    });

    // Five cadence checkpoints; the last five rows are only in the ring until End.
    await h.feed(rows.slice(45));
    await expect(samples.count(TRIP)).resolves.toBe(CHECKPOINT_S * 5);
    expect((await trips.get(TRIP))?.checkpoint_ts).toBe(at(CHECKPOINT_S * 5 - 1));

    await h.engine.dispatch({ type: 'end', ts: at(n) });
    expect(h.errors).toEqual([]);
    expect(h.engine.snapshot().status).toBe('off');
    const { trip, scored, payload } = only(h.results);

    // The tail checkpoint made rows 150..154 durable before the finalizer ran; its own safety-net
    // append then found nothing new and nothing to conflict with.
    expect(h.durableAtTrace()).toBe(n);
    expect(payload.rowsDigest.count).toBe(n);
    const trace = JSON.parse(new TextDecoder().decode(h.files.get(tracePathFor(TRIP)))) as FeatureRow[];
    expect(trace.map((r) => r.ts)).toEqual(rows.map((r) => r.ts));

    expect(scored.status).toBe('final');
    expect(scored.score).not.toBeNull();
    expect(trip).toMatchObject({
      status: 'provisional',
      sync_state: 'queued',
      score: scored.score,
      incomplete: 0,
      checkpoint_ts: at(n - 1),
      ended_at: at(n),
      duration_s: n,
    });
    expect(payload.incomplete).toBe(false);
    await expect(trips.list()).resolves.toHaveLength(1);
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
    await expect(samples.count(TRIP)).resolves.toBe(0);
  });

  test('a role change mid-trip reaches the row at the next checkpoint', async () => {
    const h = host();
    const rows = drive(CHECKPOINT_S * 2);
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });
    await h.feed(rows.slice(0, CHECKPOINT_S));
    expect((await trips.get(TRIP))?.role).toBe('driver');

    await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(CHECKPOINT_S) });
    await h.feed(rows.slice(CHECKPOINT_S));
    expect(await trips.get(TRIP)).toMatchObject({ role: 'passenger', checkpoint_ts: at(CHECKPOINT_S * 2 - 1) });
  });

  test('a checkpoint that fails is reported, leaves nothing half-written, and the next cadence carries the rows', async () => {
    const failing: Db = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            execute: (sql, params) =>
              sql.includes('INTO samples') && breakSamples
                ? Promise.reject(new Error('disk full'))
                : tx.execute(sql, params),
          })
        ),
    };
    let breakSamples = true;
    const recorder = createRecorder(failing, { tz: TZ, now: () => now });
    const errors: unknown[] = [];
    const engine = createEngine({
      now: () => now,
      newId: () => TRIP,
      limits: { lookup: () => L35, prefetch: () => {} },
      createDetectors: () => createDetectors(counterIds()),
      createArbiter: () => createArbiter({ tripIndex: LEARNING_PERIOD_TRIPS }),
      onAlert: () => {},
      onCheckpoint: recorder.onCheckpoint,
      onFinalize: async () => {},
      onError: (err) => {
        errors.push(err);
      },
      ctx: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
    });
    const rows = drive(CHECKPOINT_S * 2);
    await engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });
    for (const row of rows.slice(0, CHECKPOINT_S - 1)) await engine.dispatch({ type: 'row', row });

    // The row that completes the cadence: its dispatch rejects, the transaction rolled back.
    await expect(engine.dispatch({ type: 'row', row: rows[CHECKPOINT_S - 1] as FeatureRow })).rejects.toThrow(
      'disk full'
    );
    expect(errors).toEqual([]);
    await expect(trips.get(TRIP)).resolves.toBeNull();
    await expect(samples.count(TRIP)).resolves.toBe(0);
    expect(engine.snapshot().status).toBe('recording');

    // The ring still holds every row; the next cadence writes all sixty.
    breakSamples = false;
    for (const row of rows.slice(CHECKPOINT_S)) await engine.dispatch({ type: 'row', row });
    await expect(samples.count(TRIP)).resolves.toBe(CHECKPOINT_S * 2);
    expect((await trips.get(TRIP))?.checkpoint_ts).toBe(at(CHECKPOINT_S * 2 - 1));
  });
});

describe('onCheckpoint on its own', () => {
  /** A session as the engine would hand it over, with `rows` appended and `checkpoints` as given. */
  function sessionOver(rows: readonly FeatureRow[], checkpoints: number[] = []): Readonly<TripSession> {
    const s = createSession({
      clientTripId: TRIP,
      mode: 'pocket',
      role: 'driver',
      startSource: 'auto',
      startedAt: rows[0]?.ts ?? at(0),
    });
    for (const row of rows) appendRow(s, row, L35);
    s.checkpoints = checkpoints;
    return snapshotSession(s);
  }

  test('the same checkpoint delivered twice: each row once, one trip row, the mark unchanged', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const rows = drive(CHECKPOINT_S);
    const first = sessionOver(rows);

    await recorder.onCheckpoint(first);
    now = at(31);
    await recorder.onCheckpoint(first);

    await expect(samples.count(TRIP)).resolves.toBe(CHECKPOINT_S);
    await expect(trips.list()).resolves.toHaveLength(1);
    expect(await trips.get(TRIP)).toMatchObject({
      checkpoint_ts: at(CHECKPOINT_S - 1),
      mode: 'pocket',
      role_source: 'auto',
      updated_at: at(0),
    });
  });

  test('a later checkpoint appends only the rows past the durable mark, whatever the ring or the session remembers', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const rows = drive(CHECKPOINT_S * 2);
    await recorder.onCheckpoint(sessionOver(rows.slice(0, CHECKPOINT_S)));

    // The engine's ring holds all sixty rows and — the first checkpoint having committed without
    // the engine seeing it resolve — its `checkpoints` says none of them is durable. The row's
    // mark says otherwise, and the mark wins: only rows 30..59 are written.
    const stored = jest.fn();
    const counting: Db = {
      execute: (sql, params) => {
        if (sql.includes('INTO samples')) stored(params?.[1]);
        return db.execute(sql, params);
      },
      transaction: (fn) => db.transaction((tx) => fn({ ...tx, execute: counting.execute })),
    };
    await createRecorder(counting, { tz: TZ, now: () => now }).onCheckpoint(sessionOver(rows, []));

    expect(stored.mock.calls.map(([ts]) => ts)).toEqual(
      rows.slice(CHECKPOINT_S).map((r) => r.ts)
    );
    await expect(samples.count(TRIP)).resolves.toBe(CHECKPOINT_S * 2);
    expect((await trips.get(TRIP))?.checkpoint_ts).toBe(at(CHECKPOINT_S * 2 - 1));
  });

  test('a fractional last row ts is rounded before it becomes the mark', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const rows = drive(3).map((r, i) => (i === 2 ? { ...r, ts: r.ts + 0.4 } : r));
    await recorder.onCheckpoint(sessionOver(rows));
    const trip = await trips.get(TRIP);
    expect(trip?.checkpoint_ts).toBe(at(2));
    expect(Number.isInteger(trip?.checkpoint_ts)).toBe(true);
  });

  test('never throws synchronously: a driver that throws on contact rejects instead', async () => {
    const broken: Db = {
      execute: () => {
        throw new Error('closed');
      },
      transaction: () => {
        throw new Error('closed');
      },
    };
    const recorder = createRecorder(broken, { tz: TZ, now: () => now });
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = recorder.onCheckpoint(sessionOver(drive(2)));
    }).not.toThrow();
    await expect(pending).rejects.toThrow('closed');
  });
});

describe('M3: the arbiter state and the start evidence on the row', () => {
  const KEY = arbiterStateKey(TRIP);

  test('the key is engine.arbiter.<clientTripId>', () => {
    expect(arbiterStateKey('abc')).toBe('engine.arbiter.abc');
  });

  test('each checkpoint persists the arbiter state with its rows, and finalize removes it in its transaction', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const { deps } = finalizeDeps(db, () => now);
    const engine = createEngine({
      now: () => now,
      newId: () => TRIP,
      limits: { lookup: () => L35, prefetch: () => {} },
      createDetectors: () => createDetectors(counterIds()),
      createArbiter: (resume) => createArbiter(resume ?? { tripIndex: 0 }),
      onAlert: () => {},
      onCheckpoint: recorder.onCheckpoint,
      onFinalize: async (session) => {
        // Still there when the finalizer starts: it goes inside the finalize write.
        await expect(createSettingsRepo(db).get(KEY)).resolves.not.toBeNull();
        await finalizeTrip(session, deps);
      },
      ctx: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
    });
    await engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });
    const rows = drive(CHECKPOINT_S * 5, { speed: mph(50) }); // 15 over a 35: an L1 on an L1-only trip
    for (const row of rows.slice(0, CHECKPOINT_S)) {
      now = row.ts;
      await engine.dispatch({ type: 'row', row });
    }
    const first = await createSettingsRepo(db).get<ArbiterState>(KEY);
    expect(first).toMatchObject({ tripIndex: 0 });
    expect(first?.l1Window).toHaveLength(1);

    await engine.dispatch({ type: 'muteForDrive', ts: now });
    for (const row of rows.slice(CHECKPOINT_S)) {
      now = row.ts;
      await engine.dispatch({ type: 'row', row });
    }
    await expect(createSettingsRepo(db).get<ArbiterState>(KEY)).resolves.toMatchObject({
      mutedAll: true,
    });

    await engine.dispatch({ type: 'end', ts: at(rows.length) });
    expect((await trips.get(TRIP))?.status).toBe('provisional');
    await expect(createSettingsRepo(db).get(KEY)).resolves.toBeNull();
  });

  test('a checkpoint that fails writes no arbiter state either', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const s = createSession({
      clientTripId: TRIP,
      mode: 'mounted',
      role: 'driver',
      startSource: 'manual',
      startedAt: at(0),
    });
    for (const row of drive(CHECKPOINT_S)) appendRow(s, row, L35);
    s.arbiterState = { tripIndex: 4, mutedAll: true };
    const failing: Db = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            execute: (sql, params) =>
              sql.includes('INSERT OR REPLACE INTO settings')
                ? Promise.reject(new Error('disk full'))
                : tx.execute(sql, params),
            transaction: tx.transaction,
          })
        ),
    };
    await expect(createRecorder(failing, { tz: TZ, now: () => now }).onCheckpoint(snapshotSession(s))).rejects.toThrow(
      'disk full'
    );
    await expect(trips.get(TRIP)).resolves.toBeNull();
    await expect(createSettingsRepo(db).get(KEY)).resolves.toBeNull();
    // And the same checkpoint on a healthy handle writes both.
    await recorder.onCheckpoint(snapshotSession(s));
    await expect(createSettingsRepo(db).get(KEY)).resolves.toEqual({ tripIndex: 4, mutedAll: true });
  });

  test('a session with no arbiter state yet stores none', async () => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const s = createSession({
      clientTripId: TRIP,
      mode: 'mounted',
      role: 'driver',
      startSource: 'manual',
      startedAt: at(0),
    });
    for (const row of drive(CHECKPOINT_S)) appendRow(s, row, L35);
    await recorder.onCheckpoint(snapshotSession(s));
    await expect(createSettingsRepo(db).get(KEY)).resolves.toBeNull();
  });

  test.each([
    ['tap', 'manual'],
    ['movingStart', 'moving_start'],
    ['auto', 'auto'],
  ] as const)('start evidence %s is stored as role_source %s, on the row and in the payload', async (evidence, stored) => {
    const recorder = createRecorder(db, { tz: TZ, now: () => now });
    const s = createSession({
      clientTripId: TRIP,
      mode: 'pocket',
      role: 'driver',
      startSource: evidence === 'auto' ? 'auto' : 'manual',
      startEvidence: evidence,
      startedAt: at(0),
    });
    const rows = drive(150);
    for (const row of rows) appendRow(s, row, L35);
    await recorder.onCheckpoint(snapshotSession(s));
    expect((await trips.get(TRIP))?.role_source).toBe(stored);
    s.checkpoints.push(s.lastRowTs as number);
    const { deps } = finalizeDeps(db, () => now);
    const { trip, payload } = await finalizeTrip(closeSession(s, at(150)), deps);
    expect(trip.role_source).toBe(stored);
    expect(payload.roleSource).toBe(stored);
  });
});
