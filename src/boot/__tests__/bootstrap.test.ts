import {
  bootstrapApp,
  BootstrapError,
  flushBeforeSignOut,
  startForegroundJobs,
  type AppRuntime,
  type BootstrapDeps,
} from '@/boot/bootstrap';
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
import { emitDataChanged } from '@/data/events';
import { foregroundStampKey } from '@/data/foreground';
import {
  HYDRATE_CURSOR_KEY,
  HYDRATE_INTERVAL_MS,
  HYDRATE_RESTORED_AT_KEY,
} from '@/data/hydrate/hydrate';
import { getHydrationStatus, setHydrationStatus } from '@/data/hydrate/status';
import { createQueryClient } from '@/data/queries';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';
import { traceIdempotencyKey } from '@/data/sync/queue';

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
    // The device adapters default to native modules Jest does not have; the D2 tests below
    // replace these to exercise them.
    net: { isWifi: () => false },
    excludeFromBackup: async () => {},
    databaseDirectory: '/data/SQLite',
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
  expect(runtime.recovery).toMatchObject({ recovered: [TRIP], discarded: [], failed: [] });
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

test('the cache is wired to the change event, and stop() detaches everything', async () => {
  const { bootstrapDeps, appState } = deps();
  runtime = await bootstrapApp(bootstrapDeps);
  const { queryClient } = runtime;
  const key = ['trips', {}];

  queryClient.setQueryData(key, []);
  emitDataChanged({ source: 'enqueue' });
  await settle();
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);

  // `stop()` is awaitable so a host rebuilding the runtime can let a pass in flight finish; the
  // teardown it performs (detach, cache clear) is done when it settles.
  await runtime.stop();
  runtime = null;
  expect(appState.removals).toBe(1);
  queryClient.setQueryData(key, []);
  emitDataChanged({ source: 'enqueue' });
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
    expect(runtime.recovery).toMatchObject({ recovered: [], discarded: [], failed: [] });
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect([...traces.keys()]).toEqual([]);
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
  });

  test('a first-ever sign-in on an empty device adopts it', async () => {
    await migrate(db);
    const { bootstrapDeps } = deps({ supabase: createFakeSupabase({ uid: 'user-a' }) });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('first');
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('a first-ever sign-in on a device that already holds drives wipes them', async () => {
    // The pre-branch database (security review C-1): no owner was ever recorded, and the drives
    // on it are somebody's — just not necessarily the person signing in. Nothing of theirs is
    // lost by clearing it, and everything of the last driver's would be leaked by keeping it.
    await crashedDrive();
    const { bootstrapDeps } = deps({ supabase: createFakeSupabase({ uid: 'user-a' }) });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('wiped');
    expect(runtime.recovery).toMatchObject({ recovered: [], discarded: [], failed: [] });
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
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
    emitDataChanged({ source: 'enqueue' });
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

describe('hydration runs only in the foreground (R10, R13)', () => {
  const UID = '0b9f7a52-7a8e-4a4f-8f38-3f1c1f5a9d10';
  const serverTrip = {
    id: '00000000-0000-4000-8000-000000000001',
    user_id: UID,
    client_trip_id: 'restored-1',
    started_at: '2026-09-01T08:00:00+00:00',
    ended_at: '2026-09-01T08:30:00+00:00',
    tz: 'UTC',
    distance_m: 16093.44,
    duration_s: 1800,
    role: 'driver',
    role_confidence: null,
    role_source: 'manual',
    mode: 'mounted',
    camera_session: false,
    score: 88,
    scoring_version: 1,
    category_deductions: { phone: 0, speeding: 6, braking: 0, accel: 0, cornering: 0, focus: 0 },
    exposure: 1,
    data_quality: 'A',
    conditions: { night: false, precipitation: false },
    had_severe_event: false,
    limit_coverage_pct: 80,
    start_label: null,
    end_label: null,
    start_geohash5: null,
    end_geohash5: null,
    polyline: '',
    status: 'provisional',
    incomplete: false,
    deleted_at: null,
    updated_at: '2026-09-21T10:00:00.123456+00:00',
  };

  afterEach(() => {
    setHydrationStatus({ state: 'idle' });
  });

  async function launch(uid: string, owner?: string) {
    await migrate(db);
    if (owner !== undefined) await createSettingsRepo(db).set(LAST_USER_KEY, owner);
    const supabase = createFakeSupabase({ uid, tables: { trips: [serverTrip] } });
    const built = deps({ supabase });
    runtime = await bootstrapApp(built.bootstrapDeps);
    await settle();
    return { ...built, supabase };
  }

  test('the launch sequence itself reads nothing from the server', async () => {
    const { supabase } = await launch(UID);
    expect(runtime?.owner).toBe('first');
    expect(supabase.selects).toEqual([]);
    expect(await createTripsRepo(db).get('restored-1')).toBeNull();
  });

  test('a first sign-in owes a full restore: "restoring" at once, the run on the next foreground', async () => {
    const { supabase } = await launch(UID);
    const appState = createFakeAppState();
    const off = await startForegroundJobs(runtime!, { appState });
    expect(getHydrationStatus()).toEqual({ state: 'restoring', restored: 0 });
    // Not active yet (a background wake): nothing is read.
    appState.emit('background');
    await settle();
    expect(supabase.selects).toEqual([]);

    appState.emit('active');
    await settle();
    expect(await createTripsRepo(db).get('restored-1')).toMatchObject({ sync_state: 'synced' });
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    const days = supabase.selects.find((s) => s.table === 'score_daily');
    // Full: the newest days, not a top-up since a cursor.
    expect(days?.calls).toContain('order day desc');
    off.stop();
  });

  test('a restored device tops up at most every six hours, from its cursor', async () => {
    let clock = NOW;
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, UID);
    await createSettingsRepo(db).set(HYDRATE_CURSOR_KEY, {
      updatedAt: '2026-09-21T09:00:00+00:00',
      id: '00000000-0000-4000-8000-000000000000',
    });
    await createSettingsRepo(db).set(foregroundStampKey('hydrate'), NOW - 60_000);
    await createSettingsRepo(db).set(HYDRATE_RESTORED_AT_KEY, NOW - 60_000);
    const supabase = createFakeSupabase({ uid: UID, tables: { trips: [serverTrip] } });
    runtime = await bootstrapApp(deps({ supabase, now: () => clock }).bootstrapDeps);
    expect(runtime.owner).toBe('same');

    const appState = createFakeAppState();
    const off = await startForegroundJobs(runtime, { appState });
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    appState.emit('active');
    await settle();
    expect(supabase.selects).toEqual([]);

    clock = NOW + HYDRATE_INTERVAL_MS;
    appState.emit('active');
    await settle();
    const tripsRead = supabase.selects.find((s) => s.table === 'trips');
    expect(tripsRead?.calls.some((c) => c.startsWith('or updated_at.gt.2026-09-21T09:00:00+00:00'))).toBe(true);
    expect(await createTripsRepo(db).get('restored-1')).not.toBeNull();
    off.stop();
  });

  test('a restore that completed is not owed again, even when the server held no trips', async () => {
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, UID);
    const supabase = createFakeSupabase({ uid: UID, tables: {} });
    runtime = await bootstrapApp(deps({ supabase }).bootstrapDeps);
    const appState = createFakeAppState();
    const off = await startForegroundJobs(runtime, { appState });
    // Never restored (an M2 install): owed, even though the owner is the same.
    expect(getHydrationStatus()).toEqual({ state: 'restoring', restored: 0 });
    appState.emit('active');
    await settle();
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    off.stop();
    await runtime.stop();
    runtime.queryClient.clear();

    // The next launch: nothing owed, nothing claimed.
    runtime = await bootstrapApp(deps({ supabase }).bootstrapDeps);
    const again = await startForegroundJobs(runtime, { appState: createFakeAppState() });
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    again.stop();
  });

  test('runNow restores at once, throttle or not — the Retry a failed restore offers', async () => {
    const { supabase } = await launch(UID);
    const jobs = await startForegroundJobs(runtime!, { appState: createFakeAppState() });
    // No foreground transition at all: only the button.
    await expect(jobs.runNow()).resolves.toBe(true);
    expect(await createTripsRepo(db).get('restored-1')).not.toBeNull();
    expect(supabase.selects.length).toBeGreaterThan(0);

    const errors: string[] = [];
    await runtime!.stop();
    const stopped = runtime!;
    runtime = null;
    const late = await startForegroundJobs(stopped, { appState: createFakeAppState(), onError: (_e, ctx) => errors.push(ctx) });
    await expect(late.runNow()).resolves.toBe(false);
    expect(errors).toEqual(['foreground job hydrate (run now)']);
    late.stop();
    stopped.queryClient.clear();
  });

  test('sign-out flushes the deletes still owed, while the session can send them', async () => {
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, UID);
    const supabase = createFakeSupabase({
      uid: UID,
      invoke: () => ({
        data: {
          tripId: '00000000-0000-4000-8000-000000000009',
          deleted: true,
          days: [
            {
              day: '2026-09-21', longTermScore: null, band: null, provisional: true, safeDay: false,
              goodDay: false, phoneFreeDay: false, cameraDay: false, exposure: 0, drivingS: 0,
              tripsScored: 0, severeEvents: 0,
            },
          ],
          replayed: false,
        },
        error: null,
      }),
    });
    runtime = await bootstrapApp(deps({ supabase }).bootstrapDeps);
    await settle();
    // A delete in backoff, due an hour from now: sign-out is its last chance.
    await createQueueRepo(db).enqueue('delete-trip', { action: 'delete', clientTripId: 'gone' }, 'delete:gone', NOW + 3_600_000, undefined, UID);
    await expect(flushBeforeSignOut(runtime)).resolves.toEqual({ sent: 1, left: 0 });
    expect(supabase.invokes.map((call) => call.body)).toEqual([{ action: 'delete', clientTripId: 'gone' }]);
  });

  test('stop() stops the hydrator: a foreground after teardown restores nothing', async () => {
    const { supabase } = await launch(UID);
    const appState = createFakeAppState();
    const errors: string[] = [];
    await startForegroundJobs(runtime!, { appState, onError: (_e, ctx) => errors.push(ctx) });
    await runtime!.stop();
    const stopped = runtime!;
    runtime = null;
    appState.emit('active');
    await settle();
    expect(supabase.selects).toEqual([]);
    expect(await createTripsRepo(db).get('restored-1')).toBeNull();
    // An incomplete run stamps nothing: said so, and tried again at the next foreground.
    expect(errors).toEqual(['foreground job hydrate']);
    stopped.queryClient.clear();
  });
});

describe('D2: backup exclusion, the network adapter and the drain policy', () => {
  test('the open stage excludes the database directory from backup, once the database is open', async () => {
    const order: string[] = [];
    const { bootstrapDeps, errors } = deps({
      openDb: async () => {
        order.push('open');
        return db;
      },
      databaseDirectory: '/var/mobile/Documents/SQLite',
      excludeFromBackup: async (uri) => {
        order.push(`exclude ${uri}`);
      },
    });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(order).toEqual(['open', 'exclude /var/mobile/Documents/SQLite']);
    expect(errors).toEqual([]);
  });

  test('an exclusion that fails is reported and the launch carries on', async () => {
    const { bootstrapDeps, errors } = deps({
      excludeFromBackup: async () => {
        throw Object.assign(new Error('attribute could not be set'), { code: 'E_IO' });
      },
    });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(errors).toEqual(['exclude database from backup']);
  });

  test('an exclusion that never answers does not hold the launch', async () => {
    const { bootstrapDeps } = deps({ excludeFromBackup: () => new Promise<void>(() => {}) });
    runtime = await bootstrapApp({ ...bootstrapDeps, timeoutMs: 2_000 });
    expect(runtime.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('without an injected network the launch creates the adapter and the runner uses it', async () => {
    await crashedDrive();
    const created = jest.fn(async () => ({
      isWifi: () => true,
      isOnline: () => true,
      subscribe: () => () => {},
    }));
    const { bootstrapDeps, supabase, errors } = deps({ net: undefined, createNet: created });
    supabase.setUid('user-1');
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');

    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    expect(created).toHaveBeenCalledTimes(1);
    // On Wi-Fi, per the adapter: the trace goes with the summary, so no trace waits in the queue.
    expect(supabase.invokes).toHaveLength(1);
    expect(await createQueueRepo(db).byKey(traceIdempotencyKey(TRIP))).toBeNull();
    expect(errors).not.toContain('network adapter');
  });

  test('a network adapter that cannot be created is reported, and traces wait (never on Wi-Fi)', async () => {
    await crashedDrive();
    const { bootstrapDeps, supabase, errors } = deps({
      net: undefined,
      createNet: async () => {
        throw new Error('Cannot find native module ExpoNetwork');
      },
    });
    supabase.setUid('user-1');
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');

    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    expect(errors).toContain('network adapter');
    // The summary went up; the megabytes wait for a Wi-Fi the launch could not see.
    expect(supabase.invokes).toHaveLength(1);
    expect(supabase.uploads).toHaveLength(0);
    expect(await createQueueRepo(db).byKey(traceIdempotencyKey(TRIP))).toMatchObject({
      status: 'pending',
    });
  });

  test('the host drain policy reaches the runner', async () => {
    await crashedDrive();
    const { bootstrapDeps, supabase } = deps({ mayDrain: () => false });
    supabase.setUid('user-1');
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');

    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    expect(supabase.invokes).toHaveLength(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
  });
});
