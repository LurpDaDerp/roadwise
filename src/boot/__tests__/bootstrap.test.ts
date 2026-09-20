import { bootstrapApp, BootstrapError, type AppRuntime, type BootstrapDeps } from '@/boot/bootstrap';
import { LAST_USER_KEY } from '@/boot/device';
import { T0, counterIds } from '@/core/detectors/__fixtures__/rows';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { drive, TZ } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import { createRecorder } from '@/core/engine/recorder';
import { appendRow, createSession, snapshotSession } from '@/core/engine/session';
import {
  CURRENT_SCHEMA_VERSION,
  createQueueRepo,
  createSettingsRepo,
  createTripsRepo,
  migrate,
  type Db,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueryClient } from '@/data/queries';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';
import { emitQueueChanged } from '@/data/sync/queue';

/** Wall clock at launch: the morning after the drive. */
const NOW = T0 + 36_000_000;
const TRIP = 'trip-1';

let db: Db;
let runtime: AppRuntime | null;

beforeEach(async () => {
  db = await createSqlJsDb();
  runtime = null;
});

afterEach(() => {
  runtime?.stop();
  // The client's 5-minute gc timers would otherwise hold the worker open.
  runtime?.queryClient.clear();
});

/** Lowercase hex of the right length — the payload schema checks the shape, not the digest. */
const fakeSha256 = async (text: string): Promise<string> =>
  String(text.length).padStart(64, '0');

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** What a process that died mid-drive leaves behind: the row and its checkpointed samples. */
async function crashedDrive(rows = 200): Promise<void> {
  await migrate(db);
  const recorder = createRecorder(db, { tz: TZ, now: () => T0 });
  const session: TripSession = createSession({
    clientTripId: TRIP,
    mode: 'mounted',
    role: 'driver',
    startSource: 'manual',
    startedAt: T0,
  });
  for (const row of drive(rows)) appendRow(session, row, UNKNOWN_LIMIT);
  await recorder.onCheckpoint(snapshotSession(session));
}

function deps(over: Partial<BootstrapDeps> = {}) {
  const supabase = createFakeSupabase({ uid: null });
  const appState = createFakeAppState();
  const traces = new Map<string, Uint8Array>();
  const errors: string[] = [];
  const bootstrapDeps: BootstrapDeps = {
    openDb: async () => db,
    supabase,
    traceFs: createFakeFs(),
    traceWriter: {
      async writeGzip(path, bytes) {
        traces.set(path, bytes);
      },
      async clear() {
        traces.clear();
      },
    },
    hash: { sha256: fakeSha256 },
    newId: counterIds(),
    appState,
    tz: TZ,
    now: () => NOW,
    onError: (_error, context) => {
      errors.push(context);
    },
    ...over,
  };
  return { bootstrapDeps, supabase, appState, traces, errors };
}

test('opens, migrates, recovers the crashed drive and starts the runner on what it queued', async () => {
  await crashedDrive();
  const { bootstrapDeps, supabase, appState, traces, errors } = deps();

  runtime = await bootstrapApp(bootstrapDeps);

  expect(runtime.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(runtime.recovery).toEqual({ recovered: [TRIP], discarded: [], failed: [] });
  // Finalized from its checkpoint, scored, flagged, and queued for upload.
  const trip = await createTripsRepo(db).get(TRIP);
  expect(trip).toMatchObject({ status: 'provisional', incomplete: 1, sync_state: 'queued' });
  expect(trip?.score).not.toBeNull();
  expect([...traces.keys()]).toEqual([`${TRIP}.bin.gz`]);

  // The runner is live: it listens to the foreground, and its first drain already met the
  // recovered trip's item — signed out, so it asked for a session and handed the claim back.
  expect(appState.listeners).toHaveLength(1);
  await settle();
  expect(supabase.sessions).toBeGreaterThanOrEqual(1);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
  expect(errors).toEqual([]);
});

test('with nothing to recover the launch is the same, only quieter', async () => {
  const { bootstrapDeps, appState, supabase } = deps();
  runtime = await bootstrapApp(bootstrapDeps);
  expect(runtime.recovery.recovered).toEqual([]);
  expect(appState.listeners).toHaveLength(1);
  await settle();
  // Nothing was queued, so nothing was uploaded — but the session is read twice: once by the
  // owner check, and once by the drain, which is how the enqueue sites learn whose device they
  // are queueing on (`SESSION_UID_KEY`).
  expect(supabase.uploads).toEqual([]);
  expect(supabase.invokes).toEqual([]);
  expect(supabase.sessions).toBe(2);
});

test('the cache is wired to the queue, and stop() detaches everything', async () => {
  const { bootstrapDeps, appState } = deps();
  runtime = await bootstrapApp(bootstrapDeps);
  const { queryClient } = runtime;
  const key = ['trips', {}];

  queryClient.setQueryData(key, []);
  emitQueueChanged();
  await settle();
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);

  runtime.stop();
  runtime = null;
  expect(appState.removals).toBe(1);
  queryClient.setQueryData(key, []);
  emitQueueChanged();
  await settle();
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  // `afterEach` no longer holds this runtime; the cache's gc timers are this test's to drop.
  queryClient.clear();
});

describe('whose device this is', () => {
  test('a launch by the same user leaves the record alone', async () => {
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const { bootstrapDeps } = deps({ supabase: createFakeSupabase({ uid: 'user-a' }) });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('same');
    expect(runtime.recovery.recovered).toEqual([TRIP]);
  });

  test('a launch by a different user empties the device before anything reads it', async () => {
    // What user A left behind: a drive the process died in, and an action owed to the server.
    await crashedDrive();
    await createQueueRepo(db).enqueue('dispute', { clientTripId: TRIP }, 'dispute:1', T0);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const { bootstrapDeps, traces } = deps({ supabase: createFakeSupabase({ uid: 'user-b' }) });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('wiped');
    // The wipe runs before recovery, so A's interrupted drive is never finalized into B's account.
    expect(runtime.recovery).toEqual({ recovered: [], discarded: [], failed: [] });
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect([...traces.keys()]).toEqual([]);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
  });

  test('a first-ever sign-in keeps the drives the device recorded before it', async () => {
    await crashedDrive();
    const { bootstrapDeps } = deps({ supabase: createFakeSupabase({ uid: 'user-a' }) });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('first');
    expect(runtime.recovery.recovered).toEqual([TRIP]);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('a signed-out launch keeps everything, and does not forget who it belongs to', async () => {
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const { bootstrapDeps } = deps();

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('signed-out');
    expect(runtime.recovery.recovered).toEqual([TRIP]);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });
});

test('recovery finishes before the runner starts, so nothing races the row it queued', async () => {
  await crashedDrive();
  const { bootstrapDeps, appState } = deps();
  // The trace is written inside `finalizeTrip`, the last thing recovery does. If the runner were
  // already live at that moment, it would be listening to the foreground.
  let listenersWhenRecovered = -1;
  bootstrapDeps.traceWriter = {
    async writeGzip() {
      listenersWhenRecovered = appState.listeners.length;
    },
    clear: () => Promise.resolve(),
  };

  runtime = await bootstrapApp(bootstrapDeps);

  expect(listenersWhenRecovered).toBe(0);
  expect(appState.listeners).toHaveLength(1);
});

test('no limit cache exists at launch, so a recovered drive is never judged for speeding', async () => {
  await crashedDrive();
  const { bootstrapDeps } = deps();

  runtime = await bootstrapApp(bootstrapDeps);

  // `limits` is deliberately not passed to `recoverRecordingTrips`: every replayed row is judged
  // against UNKNOWN_LIMIT, so none of the drive is covered and nothing can cost speeding points.
  const trip = await createTripsRepo(db).get(TRIP);
  expect(trip?.limit_coverage_pct).toBe(0);
  expect(JSON.parse(trip?.category_deductions_json ?? '{}')).toMatchObject({ speeding: 0 });
});

describe('a launch that fails', () => {
  /** A handle that opens and then refuses every statement — a file that is there but corrupt. */
  const corruptDb = (): Db => {
    const fail = () => Promise.reject(new Error('SQLITE_CORRUPT'));
    return { execute: fail, transaction: fail };
  };

  test('a database that will not open is tagged open, with the cause kept', async () => {
    const { bootstrapDeps } = deps({
      openDb: () => Promise.reject(new Error('disk I/O error')),
    });
    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootstrapError);
    expect(failure).toMatchObject({
      stage: 'open',
      message: 'bootstrap failed at open: disk I/O error',
    });
    expect((failure as BootstrapError).reason).toBeInstanceOf(Error);
  });

  test('a schema that will not migrate is tagged migrate', async () => {
    const { bootstrapDeps } = deps({ openDb: async () => corruptDb() });
    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'migrate' });
  });

  test('a recovery that cannot even read the trips is tagged recover', async () => {
    // Not the per-trip failure the launch survives: the sweep itself cannot run. Migration only
    // writes the schema, so failing every read of the table lets `migrate` through and stops the
    // first thing recovery does.
    const unreadableTrips: Db = {
      execute: (sql, params) =>
        /from\s+trips/i.test(sql)
          ? Promise.reject(new Error('SQLITE_CORRUPT'))
          : db.execute(sql, params),
      transaction: (fn) => db.transaction(fn),
    };
    const { bootstrapDeps } = deps({ openDb: async () => unreadableTrips });
    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootstrapError);
    expect(failure).toMatchObject({ stage: 'recover' });
  });

  test('a runner that will not start is tagged sync, and takes its own listeners with it', async () => {
    const queryClient = createQueryClient();
    const { bootstrapDeps, supabase } = deps({
      queryClient,
      appState: {
        addEventListener() {
          throw new Error('AppState is unavailable');
        },
      },
    });

    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'sync' });

    // Nothing the failed launch attached is still listening: neither the cache's subscription to
    // the queue, nor the runner's own — a retry must not stack a second of each.
    const key = ['trips', {}];
    queryClient.setQueryData(key, []);
    emitQueueChanged();
    await settle();
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    // The one read is the owner check, which ran before the failure; no drain ever started.
    expect(supabase.sessions).toBe(1);
    expect(supabase.invokes).toEqual([]);
    queryClient.clear();
  });

  test('a launch that hangs past its deadline is reported, and the late runtime is shut down', async () => {
    const queryClient = createQueryClient();
    const { bootstrapDeps, appState } = deps({
      queryClient,
      timeoutMs: 10,
      openDb: () => new Promise<Db>((resolve) => setTimeout(() => resolve(db), 60)),
    });

    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootstrapError);
    expect(failure).toMatchObject({ stage: 'open' });
    expect((failure as BootstrapError).message).toContain('timed out after 10 ms');

    // The sequence still finishes; what it built belongs to nobody, so it is stopped.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(appState.listeners).toHaveLength(0);
    expect(appState.removals).toBe(1);
    queryClient.clear();
  });
});

test('a drive recovery cannot finalize is reported, and the launch goes on without it', async () => {
  await crashedDrive();
  const { bootstrapDeps, errors } = deps({
    traceWriter: {
      writeGzip: () => Promise.reject(new Error('ENOSPC')),
      clear: () => Promise.resolve(),
    },
  });
  runtime = await bootstrapApp(bootstrapDeps);
  expect(runtime.recovery.failed.map((f) => f.clientTripId)).toEqual([TRIP]);
  expect(errors).toEqual([`recover ${TRIP}`]);
  // Left exactly as found, for the next launch to retry.
  expect(await createTripsRepo(db).get(TRIP)).toMatchObject({ status: 'recording' });
});
