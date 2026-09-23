import {
  attachDriveStateReporting,
  bootstrapApp,
  BootstrapError,
  flushBeforeSignOut,
  startForegroundJobs,
  type AppRuntime,
  type BootstrapDeps,
} from '@/boot/bootstrap';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions';
import { T0, counterIds, limit, mph } from '@/core/detectors/__fixtures__/rows';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { drive, TZ } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import type { DriveHost, DriveState } from '@/drive/host';
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
import { createFakeAppState, createFakeFs, createFakeSupabase, functionsFetchError } from '@/data/sync/__fixtures__/fakes';
import { finalizeIdempotencyKey, SESSION_UID_KEY, traceIdempotencyKey } from '@/data/sync/queue';
import { createFakeDriveSense } from '@drive-sense';
import { INSTALL_ID_KEY } from '@/data/devices/installId';
import { isDriveStateReported } from '@/data/devices/driveStateStore';
import type { AlertPlayer } from '@/core/alerts/player';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import type { AppConfigSupabase } from '@/data/config/appConfig';

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

/**
 * What a process that died mid-drive leaves behind: the row and its checkpointed samples.
 * Returns the checkpoint's timestamp (the last durable row).
 */
async function crashedDrive(rows = 200, id = TRIP, t0 = T0): Promise<number> {
  await migrate(db);
  const recorder = createRecorder(db, { tz: TZ, now: () => t0 });
  const session: TripSession = createSession({
    clientTripId: id,
    mode: 'mounted',
    role: 'driver',
    startSource: 'manual',
    startedAt: t0,
  });
  for (const row of drive(rows, { t0 })) appendRow(session, row, UNKNOWN_LIMIT);
  await recorder.onCheckpoint(snapshotSession(session));
  const trip = await createTripsRepo(db).get(id);
  return trip?.checkpoint_ts as number;
}

/** A limits client that never touches the network: every lookup is unknown. */
function fakeLimits(): SpeedLimitClient & { purged: number } {
  const client = {
    purged: 0,
    lookup: () => null,
    prefetch: () => {},
    lookupStored: async () => null,
    startTrip: () => {},
    resetTrip: () => {},
    async purgeExpired() {
      client.purged += 1;
      return 0;
    },
    stats: () => ({ memoryTiles: 0, requestsThisTrip: 0, pointLookupsThisTrip: 0, sqliteLoads: 0, truncatedTiles: 0 }),
    settled: async () => {},
  };
  return client;
}

const silentPlayer = (): AlertPlayer => ({
  deliver: async () => {},
  stopCurrent: async () => {},
  announce: async () => {},
});

/** The `app_config` read, counted. */
function fakeAppConfig(): AppConfigSupabase & { reads: number } {
  const seam = {
    reads: 0,
    from: () => ({
      select: async () => {
        seam.reads += 1;
        return { data: [], error: null };
      },
    }),
  };
  return seam;
}

function deps(over: Partial<BootstrapDeps> = {}) {
  const supabase = createFakeSupabase({ uid: null });
  // The app is in front unless a test says otherwise: M2's launch tests all describe a foreground.
  const appState = Object.assign(createFakeAppState(), { currentState: 'active' as string | null });
  const traces = new Map<string, Uint8Array>();
  const errors: string[] = [];
  const driveSense = createFakeDriveSense({ platform: 'ios', now: () => NOW });
  driveSense.setState({ location: 'always', motion: 'granted' });
  const limits = fakeLimits();
  const appConfig = fakeAppConfig();
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
    source: driveSense,
    limits,
    createPlayer: async () => silentPlayer(),
    // Neither the diagnostics recorder nor the summary notifier is the subject here.
    mountDiagnostics: null,
    attachSummaryNotifier: null,
    appConfig,
    tz: TZ,
    now: () => NOW,
    onError: (_error, context) => {
      errors.push(context);
    },
    ...over,
  };
  return { bootstrapDeps, supabase, appState, traces, errors, driveSense, limits, appConfig };
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
  // Two foreground listeners: the runner's and the drive host's (the L1 silent-switch rule reads it).
  expect(appState.listeners).toHaveLength(2);
  await settle();
  expect(supabase.sessions).toBeGreaterThanOrEqual(1);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
  expect(errors).toEqual([]);
});

test('with nothing to recover the launch is the same, only quieter', async () => {
  const { bootstrapDeps, appState, supabase } = deps();
  runtime = await bootstrapApp(bootstrapDeps);
  expect(runtime.recovery.recovered).toEqual([]);
  expect(appState.listeners).toHaveLength(2);
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
  expect(appState.removals).toBe(2);
  queryClient.setQueryData(key, []);
  emitDataChanged({ source: 'enqueue' });
  await settle();
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  // `afterEach` no longer holds this runtime; the cache's gc timers are this test's to drop.
  queryClient.clear();
});


/**
 * The device owner `uid` affirmed the background-location disclosure (Task 19 r1): the host arms
 * only then. Tests that expect arming start from a consented driver.
 */
async function affirm(uid: string): Promise<void> {
  const settings = createSettingsRepo(db);
  await settings.set(LAST_USER_KEY, uid);
  await settings.set(DISCLOSURE_AFFIRMED_KEY, { version: 'pd-1', at: 0, uid });
}

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
  expect(appState.listeners).toHaveLength(2);
});

test('a road with no stored tile is judged against an unknown limit: no speeding', async () => {
  await crashedDrive();
  const { bootstrapDeps } = deps();

  runtime = await bootstrapApp(bootstrapDeps);

  // The fake's `lookupStored` holds nothing: every replayed row is judged against UNKNOWN_LIMIT,
  // so none of the drive is covered and nothing can cost speeding points.
  const trip = await createTripsRepo(db).get(TRIP);
  expect(trip?.limit_coverage_pct).toBe(0);
  expect(JSON.parse(trip?.category_deductions_json ?? '{}')).toMatchObject({ speeding: 0 });
});

test('a crash-recovered drive is judged against the stored tiles, as an adopted one is (H2 r1)', async () => {
  await crashedDrive(); // 22 mph throughout
  const limits = fakeLimits();
  const asked: string[] = [];
  limits.lookupStored = async (lat, lng, course) => {
    asked.push(`${lat.toFixed(3)},${lng.toFixed(3)},${course}`);
    return limit(mph(15));
  };
  limits.lookup = () => {
    throw new Error('recovery must read only the stored tiles');
  };
  const { bootstrapDeps } = deps({ limits });

  runtime = await bootstrapApp(bootstrapDeps);

  expect(runtime.recovery.recovered).toEqual([TRIP]);
  expect(asked.length).toBeGreaterThan(0);
  const trip = await createTripsRepo(db).get(TRIP);
  expect(trip?.limit_coverage_pct).toBeGreaterThan(0);
  expect(JSON.parse(trip?.category_deductions_json ?? '{}').speeding).toBeGreaterThan(0);
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
    expect(appState.removals).toBe(2);
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
    // The summary went up; the megabytes never do on a network the launch could not see. (The
    // trace follows only an accepted trip — M4 final review m2 — and then waits for Wi-Fi under
    // its own item, which the runner tests cover; this fake server does not accept.)
    expect(supabase.invokes).toHaveLength(1);
    expect(supabase.uploads).toHaveLength(0);
    expect(await createQueueRepo(db).byKey(traceIdempotencyKey(TRIP))).toBeNull();
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

describe('H2: the engine stage — the drive host, adopt after a relaunch', () => {
  const automotive = (ts: number) => ({ type: 'automotive' as const, confidence: 'high' as const, ts });

  /** A launch at `clock`, with its own drive-sense fake on the same clock. */
  function relaunch(clock: number, over: Partial<BootstrapDeps> = {}) {
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const built = deps({ source: driveSense, now: () => clock, ...over });
    return { ...built, driveSense };
  }

  test('adopts the interrupted drive when native is still capturing (the iOS relaunch restart)', async () => {
    const checkpoint = await crashedDrive();
    const { bootstrapDeps, driveSense } = relaunch(checkpoint + 60_000);
    driveSense.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBe(TRIP);
    expect(runtime.recovery).toMatchObject({ recovered: [], discarded: [], skipped: [TRIP] });
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: TRIP });
    expect(await createTripsRepo(db).get(TRIP)).toMatchObject({ status: 'recording' });
    // Capturing already answered the question: the motion history was never read.
    expect(driveSense.queries).not.toContain('queryMotionHistory');
  });

  test('adopts it when not capturing but the motion history over the gap is automotive', async () => {
    // iOS relaunched the app on a wake; native had not restarted capture (no capture-open flag).
    const checkpoint = await crashedDrive();
    const clock = checkpoint + 5 * 60_000;
    const { bootstrapDeps, driveSense } = relaunch(clock);
    driveSense.setMotionHistory([automotive(checkpoint + 30_000)]);

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBe(TRIP);
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: TRIP });
    expect(driveSense.queries).toContain('queryMotionHistory');
  });

  test('a recent drive with no sign of driving since is finalized, not adopted', async () => {
    const checkpoint = await crashedDrive();
    const { bootstrapDeps, driveSense } = relaunch(checkpoint + 5 * 60_000);
    driveSense.setMotionHistory([{ type: 'walking', confidence: 'high', ts: checkpoint + 30_000 }]);

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBeNull();
    expect(runtime.recovery.recovered).toEqual([TRIP]);
    expect(runtime.drive.snapshot().status).not.toBe('recording');
  });

  test('a checkpoint 20 minutes old is past the gap window: finalized incomplete, even while capturing', async () => {
    const checkpoint = await crashedDrive();
    const { bootstrapDeps, driveSense } = relaunch(checkpoint + 20 * 60_000);
    driveSense.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBeNull();
    expect(runtime.recovery).toMatchObject({ recovered: [TRIP], skipped: [] });
    expect(await createTripsRepo(db).get(TRIP)).toMatchObject({ status: 'provisional', incomplete: 1 });
  });

  test('a buffered wake plus an adoptable trip make exactly one recording trip', async () => {
    const checkpoint = await crashedDrive();
    const clock = checkpoint + 60_000;
    const { bootstrapDeps, driveSense } = relaunch(clock);
    driveSense.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    driveSense.setMotionHistory([automotive(clock - 30_000)]);
    await createSettingsRepo(db).set('drive.autoDetect', true);
    // Delivered before any listener exists: native buffers it for the first subscriber.
    driveSense.emit('wake', { reason: 'significantChange', ts: clock });

    runtime = await bootstrapApp(bootstrapDeps);
    await runtime.drive.settled();

    expect(runtime.drive.snapshot()).toMatchObject({ status: 'recording', clientTripId: TRIP });
    expect(await createTripsRepo(db).list({ status: 'recording' })).toHaveLength(1);
    // The wake met a recording engine: no second trip, no history query, and the claim was sent.
    expect(driveSense.queries).not.toContain('queryMotionHistory');
    expect(driveSense.calls).toContain('startCapture:mounted');
    expect(driveSense.calls).not.toContain('stopCapture');
  });

  test('of two recent orphans the newest is adopted and the older finalized at once', async () => {
    const older = await crashedDrive(100, 'trip-old', T0);
    const newer = await crashedDrive(100, 'trip-new', older + 120_000);
    const { bootstrapDeps, driveSense } = relaunch(newer + 60_000);
    driveSense.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBe('trip-new');
    expect(runtime.recovery.recovered).toEqual(['trip-old']);
    // Finalized (as incomplete; 100 s of driving is too short to score, which is beside the point).
    expect(await createTripsRepo(db).get('trip-old')).toMatchObject({ status: 'unscored', incomplete: 1 });
    expect(await createTripsRepo(db).get('trip-new')).toMatchObject({ status: 'recording' });
  });

  test('a skipped trip the host does not adopt is recovered at once (E1 adopt protocol)', async () => {
    // A recording row with no samples: recent, capture open, but nothing to rebuild.
    await migrate(db);
    const clock = NOW;
    await createTripsRepo(db).insert(
      { client_trip_id: 'empty', started_at: clock - 60_000, tz: TZ, status: 'recording' },
      clock - 60_000
    );
    await db.execute('UPDATE trips SET checkpoint_ts = ? WHERE client_trip_id = ?', [clock - 30_000, 'empty']);
    const { bootstrapDeps, driveSense } = relaunch(clock);
    driveSense.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.adopted).toBeNull();
    expect(runtime.recovery.discarded).toEqual(['empty']);
    expect(await createTripsRepo(db).list({ status: 'recording' })).toEqual([]);
  });

  test("the host reads the remote flag, but only the driver's own opt-in arms auto-detect", async () => {
    await migrate(db);
    await affirm('user-1');
    // The flag is available (nothing fetched yet), and the driver never opted in: not armed.
    // Signed in: with nobody signed in nothing arms at all (§8.2, tested below).
    const signedIn = () => ({ supabase: createFakeSupabase({ uid: 'user-1' }) });
    const off = relaunch(NOW, signedIn());
    runtime = await bootstrapApp(off.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('off');
    expect(off.driveSense.calls).not.toContain('arm');
    await runtime.stop();
    runtime.queryClient.clear();

    // Opted in, but the server switched the feature off: still not armed.
    await createSettingsRepo(db).set('drive.autoDetect', true);
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: false } });
    const killed = relaunch(NOW, signedIn());
    runtime = await bootstrapApp(killed.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('off');
    expect(killed.driveSense.calls).not.toContain('arm');
    await runtime.stop();
    runtime.queryClient.clear();

    // Opted in and available: armed.
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: true } });
    const on = relaunch(NOW, signedIn());
    runtime = await bootstrapApp(on.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('armed');
    expect(on.driveSense.calls).toContain('arm');
  });
});

describe('H2: the diagnostics battery recorder (U5)', () => {
  test('is mounted on the started host, in a background launch too, and let go at stop', async () => {
    const checkpoint = await crashedDrive();
    const clock = checkpoint + 60_000;
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock });
    driveSense.setState({ location: 'always', motion: 'granted', capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    const mounted: string[] = [];
    const { bootstrapDeps, appState } = deps({
      source: driveSense,
      now: () => clock,
      mountDiagnostics: (host, settingsDb) => {
        // After start: an adopted drive is already recording, so it is not read as a new start.
        mounted.push(`mount ${host.snapshot().status} ${settingsDb === db}`);
        return () => mounted.push('unmount');
      },
    });
    appState.currentState = 'background';

    runtime = await bootstrapApp(bootstrapDeps);
    expect(mounted).toEqual(['mount recording true']);

    await runtime.stop({ endOpenTrip: false });
    expect(mounted).toEqual(['mount recording true', 'unmount']);
    runtime.queryClient.clear();
    runtime = null;
  });
});

describe('H2: the drive-summary notifier (U3)', () => {
  test('is attached to the started host in every launch, and let go only after stop() ends the drive', async () => {
    await migrate(db);
    const log: string[] = [];
    const { bootstrapDeps, appState } = deps({
      attachSummaryNotifier: (host) => {
        log.push(`attach ${typeof host.subscribe}`);
        return { detach: () => log.push('detach') };
      },
    });
    appState.currentState = 'background';
    runtime = await bootstrapApp(bootstrapDeps);
    expect(log).toEqual(['attach function']);
    const stop = runtime.drive.stop.bind(runtime.drive);
    runtime.drive.stop = async (opts) => {
      log.push('drive stop');
      await stop(opts);
    };
    await runtime.stop();
    expect(log).toEqual(['attach function', 'drive stop', 'detach']);
    runtime.queryClient.clear();
    runtime = null;
  });
});

describe('H2 r1: a config refresh that changes auto_detect re-applies the arming', () => {
  function serverFlag() {
    const flag = { on: true };
    const appConfig: AppConfigSupabase = {
      from: () => ({
        select: async () => ({
          data: [{ key: 'feature_flags', value: { auto_detect: flag.on } }],
          error: null,
        }),
      }),
    };
    return { flag, appConfig };
  }

  test('a withdrawn flag disarms; a restored one re-arms the driver who opted in', async () => {
    await migrate(db);
    await affirm('user-1');
    await createSettingsRepo(db).set('drive.autoDetect', true);
    const { flag, appConfig } = serverFlag();
    const built = deps({ appConfig, supabase: createFakeSupabase({ uid: 'user-1' }) });
    runtime = await bootstrapApp(built.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('armed');

    flag.on = false;
    await runtime.refreshConfig();
    await runtime.drive.settled();
    expect(runtime.drive.snapshot().status).toBe('off');
    expect(built.driveSense.calls).toContain('disarm');
    // The driver's own choice is untouched: the flag only withdrew availability.
    expect(runtime.drive.autoDetectEnabled()).toBe(true);

    flag.on = true;
    await runtime.refreshConfig();
    await runtime.drive.settled();
    expect(runtime.drive.snapshot().status).toBe('armed');
  });

  test('a restored flag does not arm a driver who never opted in', async () => {
    await migrate(db);
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: false } });
    const { flag, appConfig } = serverFlag();
    const built = deps({ appConfig });
    runtime = await bootstrapApp(built.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('off');

    flag.on = true;
    await runtime.refreshConfig();
    await runtime.drive.settled();
    expect(runtime.drive.snapshot().status).toBe('off');
    expect(built.driveSense.calls).not.toContain('arm');
    expect(runtime.drive.autoDetectEnabled()).toBe(false);
  });

  test('an unchanged flag touches nothing', async () => {
    await migrate(db);
    await createSettingsRepo(db).set('drive.autoDetect', true);
    const { appConfig } = serverFlag();
    const built = deps({ appConfig });
    runtime = await bootstrapApp(built.bootstrapDeps);
    const calls = built.driveSense.calls.length;
    await runtime.refreshConfig();
    await runtime.drive.settled();
    expect(built.driveSense.calls.length).toBe(calls);
  });
});

describe('H2 I-1: a handover whose session read is slow', () => {
  /** The first `getSession` answers after `ms`; later ones at once (the storage lock has cleared). */
  function slowFirstSession(supabase: ReturnType<typeof createFakeSupabase>, ms: number) {
    const real = supabase.auth.getSession.bind(supabase.auth);
    let first = true;
    supabase.auth.getSession = () => {
      if (!first) return real();
      first = false;
      return new Promise((resolve) => setTimeout(() => resolve(real()), ms));
    };
  }

  test('a rebuild given the new uid wipes on it, with no session read at all (a)', async () => {
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const supabase = createFakeSupabase({ uid: 'user-b' });
    supabase.auth.getSession = () => new Promise(() => {});
    const { bootstrapDeps } = deps({ supabase, expectedUid: 'user-b', timeoutMs: 1_000 });

    runtime = await bootstrapApp(bootstrapDeps);

    expect(runtime.owner).toBe('wiped');
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-b');
  });

  test('a session that answers late, while the session uid says the owner changed, is waited for and wipes — nothing of A goes up under B (b, c, d)', async () => {
    // A's drive, interrupted; the old runner had already read B's session (session.uid = B).
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await createSettingsRepo(db).set(SESSION_UID_KEY, 'user-b');
    const supabase = createFakeSupabase({ uid: 'user-b' });
    slowFirstSession(supabase, 1_800);
    // On Wi-Fi, so the trace would go with the summary: the widest path out of the phone.
    const { bootstrapDeps } = deps({ supabase, net: { isWifi: () => true } });

    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    // Nothing of A's left the phone under B's session (with the old code: A's finalize-trip and
    // trace went up — the negative control in the H2 report).
    expect(supabase.invokes).toEqual([]);
    expect(supabase.uploads).toEqual([]);
    // Not `same` on a timeout: the launch waited for the answer, and B's answer wiped A's device.
    expect(runtime.owner).toBe('wiped');
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createQueueRepo(db).byKey(finalizeIdempotencyKey(TRIP))).toBeNull();
  });

  test('B signed in and the app died before the rebuild: a cold launch that times out waits, then wipes (R1-M1)', async () => {
    // No runner ever read B's session (no session.uid); only the owner watch's marker remains.
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await createSettingsRepo(db).set(PENDING_OWNER_KEY, 'user-b');
    const supabase = createFakeSupabase({ uid: 'user-b' });
    slowFirstSession(supabase, 1_800);
    const { bootstrapDeps } = deps({ supabase, net: { isWifi: () => true } });

    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    expect(supabase.invokes).toEqual([]);
    expect(runtime.owner).toBe('wiped');
    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    // The wipe took the marker with everything else.
    expect(await createSettingsRepo(db).get(PENDING_OWNER_KEY)).toBeNull();
  });

  test('a marker left by a handover the same owner then undid is cleared, and no longer holds a launch', async () => {
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await createSettingsRepo(db).set(PENDING_OWNER_KEY, 'user-b');
    const { bootstrapDeps } = deps({ supabase: createFakeSupabase({ uid: 'user-a' }) });
    runtime = await bootstrapApp(bootstrapDeps);
    expect(runtime.owner).toBe('same');
    expect(await createSettingsRepo(db).get(PENDING_OWNER_KEY)).toBeNull();
  });

  test('if that session never answers, nothing is mounted: the launch fails at identity', async () => {
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await createSettingsRepo(db).set(SESSION_UID_KEY, 'user-b');
    const supabase = createFakeSupabase({ uid: 'user-b' });
    supabase.auth.getSession = () => new Promise(() => {});
    const { bootstrapDeps } = deps({ supabase, timeoutMs: 2_500 });

    const failure = await bootstrapApp(bootstrapDeps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BootstrapError);
    expect(failure).toMatchObject({ stage: 'identity' });
    // A's drive was neither recovered nor shown: it waits, `recording`, for a launch that knows.
    expect(await createTripsRepo(db).get(TRIP)).toMatchObject({ status: 'recording' });
    expect(supabase.invokes).toEqual([]);
  });
});

describe('H2 r1: alert sound that will not load', () => {
  test('the drive still records, the failure is reported, and the host says alerts are unavailable', async () => {
    await migrate(db);
    const reported: { message: string; context: string }[] = [];
    const { bootstrapDeps, errors } = deps({
      // Signed in: nobody records a drive while signed out (§8.2).
      supabase: createFakeSupabase({ uid: 'user-1' }),
      createPlayer: async () => {
        throw new Error('Cannot find native module ExpoAudio at 47.6062,-122.3321 for trip-1');
      },
      onError: (error, context) => {
        errors.push(context);
        reported.push({ message: error instanceof Error ? error.message : String(error), context });
      },
    });
    runtime = await bootstrapApp(bootstrapDeps);
    expect(errors).toContain('alert ports');
    // M-3: the report carries the error's kind and the context, never what its message held.
    expect(reported.find((r) => r.context === 'alert ports')?.message).toBe(
      'alert sound could not be loaded (Error)'
    );
    expect(runtime.drive.snapshot().alertsAvailable).toBe(false);
    // Recording is unaffected.
    await runtime.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await runtime.drive.settled();
    expect(runtime.drive.isBusy()).toBe(true);
    expect(runtime.drive.snapshot().alertsAvailable).toBe(false);
  });

  test('with the player loaded, alerts are available', async () => {
    await migrate(db);
    runtime = await bootstrapApp(deps().bootstrapDeps);
    expect(runtime.drive.snapshot().alertsAvailable).toBe(true);
  });
});

describe('H2: a background launch', () => {
  test('a hanging getSession costs 1.5 s at most: the engine starts with the persisted owner, nothing wiped', async () => {
    const checkpoint = await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    const clock = checkpoint + 60_000;
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock });
    driveSense.setState({
      location: 'always',
      motion: 'granted',
      capturing: true,
      captureWasOpen: true,
      mode: 'mounted',
      rate: 'full',
    });
    const { bootstrapDeps, supabase, appState } = deps({ source: driveSense, now: () => clock });
    appState.currentState = 'background';
    // A token refresh with no network: it never answers.
    supabase.auth.getSession = () => new Promise(() => {});

    const started = Date.now();
    runtime = await bootstrapApp(bootstrapDeps);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(runtime.profile).toBe('background');
    expect(runtime.owner).toBe('same');
    expect(runtime.adopted).toBe(TRIP);
    expect(runtime.drive.snapshot().status).toBe('recording');
    expect(await createSettingsRepo(db).get(LAST_USER_KEY)).toBe('user-a');
  });

  test('a hanging getSession on a device nobody owns yet is signed-out: nothing wiped on a guess', async () => {
    await crashedDrive();
    const { bootstrapDeps, supabase } = deps();
    supabase.auth.getSession = () => new Promise(() => {});
    runtime = await bootstrapApp(bootstrapDeps);
    expect(runtime.owner).toBe('signed-out');
    expect(runtime.recovery.recovered).toEqual([TRIP]);
  });

  test('uploads nothing and reads nothing from the server while in the background', async () => {
    await crashedDrive();
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    const supabase = createFakeSupabase({ uid: 'user-1' });
    const { bootstrapDeps, appState, appConfig } = deps({ supabase });
    appState.currentState = 'background';

    runtime = await bootstrapApp(bootstrapDeps);
    expect(runtime.profile).toBe('background');
    await settle();
    emitDataChanged({ source: 'enqueue' });
    await settle();

    // The recovered drive is queued, and stays queued: no drain from a background wake (§3.5).
    expect(supabase.invokes).toEqual([]);
    expect(supabase.uploads).toEqual([]);
    expect(supabase.selects).toEqual([]);
    expect(appConfig.reads).toBe(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);

    // The driver opens the app: the same runtime drains, no rebuild.
    appState.currentState = 'active';
    appState.emit('active');
    await settle();
    expect(supabase.invokes.length).toBeGreaterThan(0);
  });

  test('a wake while in the background reports permissions (M4 seam); one in front does not', async () => {
    await migrate(db);
    const reported: string[] = [];
    const built = deps({
      reportPermissionsFromBackground: async () => {
        reported.push(built.appState.currentState ?? 'null');
      },
    });
    built.appState.currentState = 'background';
    runtime = await bootstrapApp(built.bootstrapDeps);

    built.driveSense.emit('wake', { reason: 'significantChange', ts: NOW });
    await runtime.drive.settled();
    await settle();
    expect(reported).toEqual(['background']);

    built.appState.currentState = 'active';
    built.driveSense.emit('wake', { reason: 'significantChange', ts: NOW });
    await runtime.drive.settled();
    await settle();
    expect(reported).toEqual(['background']);
  });

  test('a failing permission report is reported and changes nothing else', async () => {
    await migrate(db);
    const { bootstrapDeps, appState, driveSense, errors } = deps({
      reportPermissionsFromBackground: async () => {
        throw new Error('no permission API');
      },
    });
    appState.currentState = 'background';
    runtime = await bootstrapApp(bootstrapDeps);
    driveSense.emit('wake', { reason: 'significantChange', ts: NOW });
    await runtime.drive.settled();
    await settle();
    expect(errors).toContain('report permissions from background');
  });
});

describe('H2: the runner stays off the database for the whole drive', () => {
  test('an enqueue while the drive finalizes does not drain; the finalize change does', async () => {
    let clock = NOW;
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const statusAtInvoke: string[] = [];
    const supabase = createFakeSupabase({
      uid: 'user-1',
      invoke: () => {
        statusAtInvoke.push(runtime?.drive.snapshot().status ?? 'none');
        return { data: null, error: { message: 'not now', context: { status: 503 } } };
      },
    });
    // The trace is written inside finalize (before its transaction), while the host says
    // `finalizing`: hold it there, and wake the runner meanwhile.
    let duringFinalize: string[] | null = null;
    const traceWriter = {
      async writeGzip() {
        emitDataChanged({ source: 'enqueue' });
        await settle();
        await settle();
        duringFinalize = [...statusAtInvoke];
      },
      clear: async () => {},
    };
    const { bootstrapDeps } = deps({ supabase, source: driveSense, now: () => clock, traceWriter });
    runtime = await bootstrapApp(bootstrapDeps);
    await settle();

    await runtime.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await runtime.drive.settled();
    for (const row of drive(200, { t0: clock + 1000 })) {
      clock = row.ts + 200;
      driveSense.loadTrace([row]);
      driveSense.step();
      await runtime.drive.settled();
    }
    expect(runtime.drive.snapshot().status).toBe('recording');
    // Work owed from earlier, written without a change event: any drain would send it.
    await createQueueRepo(db).enqueue(
      'delete-trip',
      { action: 'delete', clientTripId: 'gone' },
      'delete:gone',
      clock,
      undefined,
      'user-1'
    );
    expect(supabase.invokes).toEqual([]);

    await runtime.drive.end();
    await runtime.drive.untilIdle();
    await settle();

    // A wake while the host said `finalizing` sent nothing; the finalize change afterwards did.
    expect(duringFinalize).toEqual([]);
    expect(statusAtInvoke.length).toBeGreaterThan(0);
    expect(statusAtInvoke.every((s) => s === 'off' || s === 'armed')).toBe(true);
  });
});

describe('H2: foreground jobs', () => {
  test('the config fetch runs on the foreground, at most daily, and tiles are purged after a restore', async () => {
    let clock = NOW;
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    await createSettingsRepo(db).set(HYDRATE_RESTORED_AT_KEY, NOW - 60_000);
    const { bootstrapDeps, appConfig, limits } = deps({
      supabase: createFakeSupabase({ uid: 'user-1', tables: {} }),
      now: () => clock,
    });
    runtime = await bootstrapApp(bootstrapDeps);
    const appState = Object.assign(createFakeAppState(), { currentState: 'background' as string | null });
    const jobs = await startForegroundJobs(runtime, { appState });
    await settle();
    expect(appConfig.reads).toBe(0);
    expect(limits.purged).toBe(0);

    appState.currentState = 'active';
    appState.emit('active');
    await settle();
    expect(appConfig.reads).toBe(1);
    expect(limits.purged).toBe(1);

    clock += 60 * 60_000;
    appState.emit('active');
    await settle();
    expect(appConfig.reads).toBe(1);

    clock = NOW + 24 * 60 * 60_000;
    appState.emit('active');
    await settle();
    expect(appConfig.reads).toBe(2);
    await jobs.stop();
  });
});

describe('M3 final review: the launch wiring', () => {
  test('I3: a launch with nobody signed in never arms, whatever the stored opt-in (§8.2)', async () => {
    await migrate(db);
    await affirm('user-1');
    await createSettingsRepo(db).set('drive.autoDetect', true);
    const built = deps(); // signed out
    runtime = await bootstrapApp(built.bootstrapDeps);
    expect(runtime.owner).toBe('signed-out');
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    expect(built.driveSense.calls).not.toContain('arm');
    // The same driver signs back in: armed again.
    await runtime.drive.resumeAfterSignIn();
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });

  test('M1: stop lets the summary notifier finish scheduling before it detaches', async () => {
    await migrate(db);
    const log: string[] = [];
    let finish: () => void = () => {};
    const { bootstrapDeps } = deps({
      attachSummaryNotifier: () => ({
        settled: () =>
          new Promise<void>((resolve) => {
            log.push('settling');
            finish = () => {
              log.push('settled');
              resolve();
            };
          }),
        detach: () => log.push('detach'),
      }),
    });
    runtime = await bootstrapApp(bootstrapDeps);
    const stopping = runtime.stop();
    await settle();
    expect(log).toEqual(['settling']);
    finish();
    await stopping;
    expect(log).toEqual(['settling', 'settled', 'detach']);
    runtime.queryClient.clear();
    runtime = null;
  });

  test('M2: the zone is re-read after a minute, so a zone change reaches the drive', async () => {
    await migrate(db);
    let clock = NOW;
    const { bootstrapDeps } = deps({ tz: undefined, now: () => clock });
    const spy = jest.spyOn(Intl, 'DateTimeFormat');
    runtime = await bootstrapApp(bootstrapDeps);
    const before = spy.mock.calls.length;
    runtime.drive.detectorContext();
    clock += 59_000;
    runtime.drive.detectorContext();
    const withinMinute = spy.mock.calls.length - before;
    clock += 61_000;
    runtime.drive.detectorContext();
    expect(spy.mock.calls.length - before).toBeGreaterThan(withinMinute);
    spy.mockRestore();
  });

  test('M7: tiles decoded by recovery are freed once the launch is idle', async () => {
    await crashedDrive();
    const { bootstrapDeps, limits } = deps();
    const resets: number[] = [];
    limits.resetTrip = () => {
      resets.push(1);
    };
    runtime = await bootstrapApp(bootstrapDeps);
    expect(runtime.recovery.recovered).toEqual([TRIP]);
    expect(resets.length).toBeGreaterThanOrEqual(1);
  });

  test('M7: an adopted drive keeps its tiles', async () => {
    const checkpoint = await crashedDrive();
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => checkpoint + 60_000 });
    driveSense.setState({ location: 'always', motion: 'granted', capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    const { bootstrapDeps, limits } = deps({ source: driveSense, now: () => checkpoint + 60_000 });
    let resets = 0;
    limits.resetTrip = () => {
      resets += 1;
    };
    runtime = await bootstrapApp(bootstrapDeps);
    expect(runtime.adopted).toBe(TRIP);
    expect(resets).toBe(0);
  });
});

describe('final re-review n4, n5', () => {
  test('n4: a restore a drive paused resumes when that drive is finalized, so "Restoring…" is never left idle', async () => {
    let clock = NOW;
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const supabase = createFakeSupabase({ uid: 'user-1', tables: {} });
    // No drain here: sql.js is one connection, and the runner's finalize drain would overlap the
    // restore's transactions (on a device, expo-sqlite serialises them on separate connections).
    const { bootstrapDeps } = deps({ supabase, source: driveSense, now: () => clock, mayDrain: () => false });
    runtime = await bootstrapApp(bootstrapDeps);
    await runtime.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await runtime.drive.settled();
    for (const row of drive(200, { t0: clock + 1000 })) {
      clock = row.ts + 200;
      driveSense.loadTrace([row]);
      driveSense.step();
      await runtime.drive.settled();
    }
    expect(runtime.drive.isBusy()).toBe(true);

    // Never restored: a full restore is owed, and the app is in front — but a drive is recording.
    const appState = Object.assign(createFakeAppState(), { currentState: 'active' as string | null });
    const jobs = await startForegroundJobs(runtime, { appState, onError: () => {} });
    await settle();
    expect(getHydrationStatus()).toEqual({ state: 'restoring', restored: 0 });

    // The drive ends: the host's finalize change resumes the restore, with no new foreground.
    await runtime.drive.end();
    await runtime.drive.untilIdle();
    await settle();
    await settle();
    expect(getHydrationStatus()).toEqual({ state: 'idle' });
    await jobs.stop();
    setHydrationStatus({ state: 'idle' });
  });

  test('n5: a notifier that never settles holds a teardown for 2 s at most', async () => {
    await migrate(db);
    const { bootstrapDeps } = deps({
      attachSummaryNotifier: () => ({ settled: () => new Promise<void>(() => {}), detach: () => {} }),
    });
    runtime = await bootstrapApp(bootstrapDeps);
    const started = Date.now();
    await runtime.stop();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_000);
    runtime.queryClient.clear();
    runtime = null;
  });
});

describe('ruling T12 (1): the launch reads the cached age band', () => {
  test("an under-13 account's cached profile keeps a launch disarmed; an adult's arms", async () => {
    await migrate(db);
    const settings = createSettingsRepo(db);
    await affirm('user-1');
    await settings.set('drive.autoDetect', true);
    await settings.set('profile.cache', { userId: 'user-1', profile: { id: 'user-1', age_band: 'u13' } });
    runtime = await bootstrapApp(deps({ supabase: createFakeSupabase({ uid: 'user-1' }) }).bootstrapDeps);
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    await runtime.stop();
    runtime.queryClient.clear();

    await settings.set('profile.cache', { userId: 'user-1', profile: { id: 'user-1', age_band: '18_plus' } });
    runtime = await bootstrapApp(deps({ supabase: createFakeSupabase({ uid: 'user-1' }) }).bootstrapDeps);
    expect(runtime.drive.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });
});

// The permission reporter's module reads native permission adapters; here only its wiring is tested.
const mockBackgroundReports: string[] = [];
jest.mock('@/data/devices/permissionsReport', () => ({
  createBackgroundPermissionReporter: () => async () => {
    mockBackgroundReports.push('report');
  },
}));

describe('ruling T10 (4): the runtime reports the drive state and background permissions', () => {
  const INSTALL = 'install-0001';

  /** The `devices` table as the drive-state reporter writes it, under the signed-in owner. */
  function devicesClient(opts: { failRecording?: number; failIdle?: boolean } = {}) {
    const writes: string[] = [];
    let failures = opts.failRecording ?? 0;
    const control = { failIdle: opts.failIdle === true };
    const client = {
      from: (table: string) => ({
        update: (row: { drive_state: string }) => {
          const q = {
            eq: () => q,
            select: async () => {
              if (row.drive_state === 'recording' && failures > 0) {
                failures -= 1;
                writes.push(`${table}:${row.drive_state}(failed)`);
                return { data: null, error: { message: 'offline' } };
              }
              if (row.drive_state === 'idle' && control.failIdle) {
                writes.push(`${table}:idle(failed)`);
                return { data: null, error: { message: 'refused' } };
              }
              writes.push(`${table}:${row.drive_state}`);
              return { data: [{ id: INSTALL }], error: null };
            },
          };
          return q;
        },
      }),
    };
    return { client, writes, control };
  }

  async function recordAndEnd(run: AppRuntime, driveSense: ReturnType<typeof createFakeDriveSense>, clock: { t: number }) {
    await run.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await run.drive.settled();
    for (const row of drive(200, { t0: clock.t + 1000 })) {
      clock.t = row.ts + 200;
      driveSense.loadTrace([row]);
      driveSense.step();
      await run.drive.settled();
    }
    await run.drive.end();
    await run.drive.untilIdle();
    await settle();
  }

  async function launch(opts: { uid: string | null; owner?: string; pending?: string; installId?: boolean; failRecording?: number }) {
    await migrate(db);
    const settings = createSettingsRepo(db);
    if (opts.owner) await settings.set(LAST_USER_KEY, opts.owner);
    if (opts.pending) await settings.set('device.pendingOwner', opts.pending);
    if (opts.installId !== false) await settings.set(INSTALL_ID_KEY, INSTALL);
    const clock = { t: NOW };
    const driveSense = createFakeDriveSense({ platform: 'android', now: () => clock.t });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const devices = devicesClient({ failRecording: opts.failRecording });
    const built = deps({
      supabase: createFakeSupabase({ uid: opts.uid }),
      source: driveSense,
      now: () => clock.t,
      profile: 'background',
      mayDrain: () => false,
      devicesClient: devices.client as never,
    });
    built.appState.currentState = 'background';
    runtime = await bootstrapApp(built.bootstrapDeps);
    return { driveSense, clock, devices, built };
  }

  test('a drive recorded with no screen (the headless task) reports recording, then idle', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    expect(isDriveStateReported()).toBe(true);
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    expect(l.devices.writes).toEqual(['devices:recording', 'devices:idle']);
  });

  test('a recording write that fails at drive start is sent again on the host publishes, after 30 s (T10 review I1)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1', failRecording: 1 });
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    // 200 rows at 1 Hz: the retry rides a publish 30 s after the failure, then the idle at the end.
    expect(l.devices.writes).toEqual(['devices:recording(failed)', 'devices:recording', 'devices:idle']);
  });

  test('the backoff grows: 30 s, then 2 min — no retry sooner', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1', failRecording: 2 });
    await recordAndEnd(runtime!, l.driveSense, l.clock); // a 200 s drive
    // Fails at start, retried at 30 s (fails), next due at 30 s + 2 min = 150 s: within the drive.
    expect(l.devices.writes).toEqual([
      'devices:recording(failed)',
      'devices:recording(failed)',
      'devices:recording',
      'devices:idle',
    ]);
  });

  test('a drive adopted at launch is reported recording at once (the current state is seeded)', async () => {
    await crashedDrive();
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL);
    const checkpoint = (await createTripsRepo(db).get(TRIP))?.checkpoint_ts as number;
    const driveSense = createFakeDriveSense({ platform: 'android', now: () => checkpoint + 60_000 });
    driveSense.setState({ location: 'always', motion: 'granted', capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    const devices = devicesClient();
    runtime = await bootstrapApp(
      deps({
        supabase: createFakeSupabase({ uid: 'user-1' }),
        source: driveSense,
        now: () => checkpoint + 60_000,
        mayDrain: () => false,
        devicesClient: devices.client as never,
      }).bootstrapDeps
    );
    expect(runtime.adopted).toBe(TRIP);
    await settle();
    expect(devices.writes).toEqual(['devices:recording']);
  });

  test('armed and idle, nothing is written (state changes only, never a timer)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await settle();
    expect(l.devices.writes).toEqual([]);
  });

  test('signed out: nothing is reported (and nothing records)', async () => {
    const l = await launch({ uid: null, owner: 'user-1' });
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    expect(l.devices.writes).toEqual([]);
  });

  test('another driver pending (the owner watch saw them sign in): nothing is reported', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await createSettingsRepo(db).set('device.pendingOwner', 'user-2');
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    expect(l.devices.writes).toEqual([]);
  });

  test('no install registered yet: nothing is reported', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1', installId: false });
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    expect(l.devices.writes).toEqual([]);
  });

  test('the runtime registers a drive-state source for A8, and stop releases it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('@/data/devices/driveStateStore') as typeof import('@/data/devices/driveStateStore');
    let released = 0;
    const real = store.registerDriveStateSource;
    const spy = jest.spyOn(store, 'registerDriveStateSource').mockImplementation(() => {
      const release = real();
      return () => {
        released += 1;
        release();
      };
    });
    await launch({ uid: 'user-1', owner: 'user-1' });
    expect(spy).toHaveBeenCalledTimes(1);
    await runtime!.stop({ endOpenTrip: false });
    expect(released).toBe(1);
    spy.mockRestore();
    runtime!.queryClient.clear();
    runtime = null;
  });

  async function recordOnly(l: Awaited<ReturnType<typeof launch>>) {
    await runtime!.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await runtime!.drive.settled();
    for (const row of drive(200, { t0: l.clock.t + 1000 })) {
      l.clock.t = row.ts + 200;
      l.driveSense.loadTrace([row]);
      l.driveSense.step();
      await runtime!.drive.settled();
    }
    await settle();
  }

  test('sign-out: the idle is written before the session ends (T10 security)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await recordOnly(l);
    expect(l.devices.writes).toEqual(['devices:recording']);
    // What the layout's sign-out hook does before the session ends: stop recording, then settle.
    await runtime!.drive.suspendForSignOut();
    await runtime!.driveStateSettled();
    expect(l.devices.writes).toEqual(['devices:recording', 'devices:idle']);
  });

  test('handover: nothing is written under the next driver (the owner fence)', async () => {
    const supabase = createFakeSupabase({ uid: 'user-1' });
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    await createSettingsRepo(db).set(INSTALL_ID_KEY, INSTALL);
    const clock = { t: NOW };
    const driveSense = createFakeDriveSense({ platform: 'android', now: () => clock.t });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const devices = devicesClient();
    const built = deps({ supabase, source: driveSense, now: () => clock.t, mayDrain: () => false, devicesClient: devices.client as never });
    runtime = await bootstrapApp(built.bootstrapDeps);
    await recordOnly({ driveSense, clock, devices, built });
    expect(devices.writes).toEqual(['devices:recording']);
    // B signs in on this phone: the owner watch marks the handover before the rebuild, whose
    // teardown ends A's drive under B's session.
    supabase.setUid('user-2');
    await createSettingsRepo(db).set('device.pendingOwner', 'user-2');
    await runtime.stop();
    await settle();
    expect(devices.writes).toEqual(['devices:recording']);
    runtime.queryClient.clear();
    runtime = null;
  });

  test('offline at drive start (no local identity yet): recording reaches the server later on the backoff', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    // The stored session is unreadable at the start (a phone parked overnight, a garage).
    const settings = createSettingsRepo(db);
    await settings.remove('session.uid');
    await runtime!.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await runtime!.drive.settled();
    const rows = drive(200, { t0: l.clock.t + 1000 });
    for (const [i, row] of rows.entries()) {
      l.clock.t = row.ts + 200;
      if (i === 20) await settings.set('session.uid', 'user-1'); // the identity is back
      l.driveSense.loadTrace([row]);
      l.driveSense.step();
      await runtime!.drive.settled();
    }
    await settle();
    expect(l.devices.writes).toEqual(['devices:recording']);
  });

  test('offline at drive end: the idle is kept and sent at the next foreground', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await recordOnly(l);
    expect(l.devices.writes).toEqual(['devices:recording']);
    const settings = createSettingsRepo(db);
    await settings.remove('session.uid');
    await runtime!.drive.end();
    await runtime!.drive.untilIdle();
    await settle();
    expect(l.devices.writes).toEqual(['devices:recording']);
    // Back: the driver opens the app.
    await settings.set('session.uid', 'user-1');
    l.built.appState.emit('active');
    await settle();
    await settle();
    expect(l.devices.writes).toEqual(['devices:recording', 'devices:idle']);
  });

  test('an idle launch tells the server nothing (review m2: only an open or finalizing trip is news)', async () => {
    await migrate(db);
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL);
    const devices = devicesClient();
    const built = deps({ supabase: createFakeSupabase({ uid: 'user-1' }), mayDrain: () => false, devicesClient: devices.client as never });
    runtime = await bootstrapApp(built.bootstrapDeps);
    await settle();
    expect(devices.writes).toEqual([]);
  });

  test('the background permission hook is never awaited: a hook that never answers does not hold the wake (review m3)', async () => {
    await migrate(db);
    await affirm('user-1');
    await createSettingsRepo(db).set('drive.autoDetect', true);
    const clock = { t: NOW };
    const driveSense = createFakeDriveSense({ platform: 'ios', now: () => clock.t });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const built = deps({
      supabase: createFakeSupabase({ uid: 'user-1' }),
      source: driveSense,
      now: () => clock.t,
      reportPermissionsFromBackground: () => new Promise<void>(() => {}),
    });
    built.appState.currentState = 'background';
    runtime = await bootstrapApp(built.bootstrapDeps);
    expect(runtime.drive.snapshot().status).toBe('armed');
    driveSense.setMotionHistory([{ type: 'automotive', confidence: 'high', ts: clock.t - 10_000 }]);
    driveSense.emit('wake', { reason: 'significantChange', ts: clock.t });
    await runtime.drive.settled();
    expect(runtime.drive.snapshot().status).toBe('candidate');
  });

  test('after sign-out, an idle the settle could not deliver is dropped: no retry at each foreground (r2 n1)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await recordOnly(l);
    l.devices.control.failIdle = true;
    // The sign-out: stop recording, settle (the idle fails), the session ends, then abandon.
    await runtime!.drive.suspendForSignOut();
    await runtime!.driveStateSettled();
    const listenersBefore = l.built.appState.listeners.length;
    await runtime!.driveStateAbandon();
    const attempts = l.devices.writes.length;
    expect(l.devices.writes.filter((w) => w === 'devices:idle(failed)').length).toBeGreaterThan(0);
    expect(l.built.appState.listeners.length).toBe(listenersBefore - 1);

    l.built.appState.emit('active');
    l.built.appState.emit('active');
    await settle();
    expect(l.devices.writes.length).toBe(attempts);
  });

  test('negative control: without the abandon, the failed idle is tried again at the foreground', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await recordOnly(l);
    l.devices.control.failIdle = true;
    await runtime!.drive.suspendForSignOut();
    await runtime!.driveStateSettled();
    const attempts = l.devices.writes.length;
    l.built.appState.emit('active');
    await settle();
    await settle();
    expect(l.devices.writes.length).toBeGreaterThan(attempts);
  });

  test('launched signed out, then signed in: the first drive is reported (M4 final review I1)', async () => {
    const l = await launch({ uid: null });
    expect(runtime!.owner).toBe('signed-out');
    // The first sign-in on this device: the owner watch records the owner (as rememberDeviceOwner
    // does), and the layout tells the host.
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set('session.uid', 'user-1');
    await runtime!.drive.signedInAgain();
    await recordAndEnd(runtime!, l.driveSense, l.clock);
    expect(l.devices.writes).toEqual(['devices:recording', 'devices:idle']);
  });

  test('a discarded candidate writes nothing (M4 final review I2)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: true } });
    await affirm('user-1');
    await runtime!.drive.setAutoDetect(true);
    expect(runtime!.drive.snapshot().status).toBe('armed');
    l.driveSense.setMotionHistory([{ type: 'automotive', confidence: 'high', ts: l.clock.t - 10_000 }]);
    l.driveSense.emit('wake', { reason: 'activityTransition', ts: l.clock.t });
    await runtime!.drive.settled();
    expect(runtime!.drive.snapshot().status).toBe('candidate');
    // Walking: the candidate is discarded, back to armed.
    l.driveSense.emit('activity', { type: 'walking', confidence: 'high', ts: l.clock.t + 5_000 });
    await runtime!.drive.settled();
    l.clock.t += 5 * 60_000;
    await runtime!.drive.end();
    await runtime!.drive.settled();
    await settle();
    expect(runtime!.drive.snapshot().status).not.toBe('recording');
    expect(l.devices.writes).toEqual([]);
  });

  test('turning auto-record on, then off, while idle writes nothing (I2)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: true } });
    await affirm('user-1');
    await runtime!.drive.setAutoDetect(true);
    expect(runtime!.drive.snapshot().status).toBe('armed');
    await runtime!.drive.setAutoDetect(false);
    expect(runtime!.drive.snapshot().status).toBe('off');
    await settle();
    expect(l.devices.writes).toEqual([]);
  });

  test('a sign-out with no drive in this process writes nothing (I2)', async () => {
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    await createSettingsRepo(db).set('config.app', { fetchedAt: NOW, flags: { auto_detect: true } });
    await affirm('user-1');
    await runtime!.drive.setAutoDetect(true);
    expect(runtime!.drive.snapshot().status).toBe('armed');
    await runtime!.drive.suspendForSignOut();
    await runtime!.driveStateSettled();
    expect(l.devices.writes).toEqual([]);
  });

  test('the default background wake hook is T10\'s permission reporter', async () => {
    mockBackgroundReports.length = 0;
    const l = await launch({ uid: 'user-1', owner: 'user-1' });
    l.driveSense.emit('wake', { reason: 'significantChange', ts: NOW });
    await runtime!.drive.settled();
    await settle();
    expect(mockBackgroundReports).toEqual(['report']);
  });
});

describe('client re-review R1 and R3: the drive-state reporter', () => {
  const INSTALL2 = 'install-0002';

  function devices() {
    const writes: string[] = [];
    const client = {
      from: (table: string) => ({
        update: (row: { drive_state: string }) => {
          const q = {
            eq: () => q,
            select: async () => {
              writes.push(`${table}:${row.drive_state}`);
              return { data: [{ id: INSTALL2 }], error: null };
            },
          };
          return q;
        },
      }),
    };
    return { client, writes };
  }

  test('R1: a signed-out launch that adopts an open trip writes nothing and leaves no foreground retry', async () => {
    const checkpoint = await crashedDrive();
    const settings = createSettingsRepo(db);
    // The owner and `session.uid` are left from before the sign-out (never cleared there).
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set('session.uid', 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL2);
    const driveSense = createFakeDriveSense({ platform: 'android', now: () => checkpoint + 60_000 });
    driveSense.setState({ location: 'always', motion: 'granted', capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    const d = devices();
    const built = deps({ source: driveSense, now: () => checkpoint + 60_000, mayDrain: () => false, devicesClient: d.client as never });
    runtime = await bootstrapApp(built.bootstrapDeps);
    expect(runtime.owner).toBe('signed-out');
    expect(runtime.adopted).toBe(TRIP);
    await settle();
    const listeners = built.appState.listeners.length;
    built.appState.emit('active');
    await settle();
    expect(d.writes).toEqual([]);
    // Only the runner's and the host's own listeners: no drive-state foreground retry.
    expect(built.appState.listeners.length).toBe(listeners);
    expect(listeners).toBe(2);
  });

  /** A host at a given status, publishing on demand. */
  function fakeHost(status: string, signedIn = true) {
    let current = { status } as DriveState;
    const listeners = new Set<(s: DriveState) => void>();
    return {
      host: {
        snapshot: () => current,
        subscribe: (fn: (s: DriveState) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        signedIn: () => signedIn,
      } as unknown as DriveHost,
      publish(next: string) {
        current = { ...current, status: next } as DriveState;
        for (const fn of [...listeners]) fn(current);
      },
    };
  }

  test('R3: a relaunch seeded as finalizing sends the owed idle', async () => {
    await migrate(db);
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set('session.uid', 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL2);
    const d = devices();
    const h = fakeHost('finalizing');
    const reporting = attachDriveStateReporting({
      db,
      drive: h.host,
      appState: createFakeAppState(),
      client: d.client as never,
      now: () => NOW,
      onError: () => {},
    });
    await reporting.settled();
    h.publish('armed');
    await reporting.settled();
    // T10's reporter sends `idle` only after `recording`, so the owed idle is walked through both.
    expect(d.writes).toContain('devices:idle');
    expect(d.writes[d.writes.length - 1]).toBe('devices:idle');
    reporting.release();
  });
});

describe('M5 R-A: the sync watermark rides the runner, and the sign-out releases the phone', () => {
  const INSTALL = 'install-0003';

  /** The `devices` table as the watermark writer updates it. */
  function watermarkDevices(opts: { fail?: boolean } = {}) {
    const writes: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
    const client = {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => {
          const write = { patch, filters: [] as [string, unknown][] };
          const reply = () => {
            writes.push(write);
            return opts.fail
              ? Promise.resolve({ data: null, error: { message: 'offline' } })
              : Promise.resolve({ data: [{ id: INSTALL, table }], error: null });
          };
          const q = {
            eq: (column: string, value: unknown) => {
              write.filters.push([column, value]);
              return q;
            },
            select: () => q,
            abortSignal: () => reply(),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => reply().then(resolve, reject),
          };
          return q;
        },
      }),
    };
    return { client, writes };
  }

  async function signedInLaunch(opts: { uid?: string | null; installId?: boolean } = {}) {
    await migrate(db);
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    if (opts.installId !== false) await settings.set(INSTALL_ID_KEY, INSTALL);
    const devices = watermarkDevices();
    const built = deps({
      supabase: createFakeSupabase({ uid: opts.uid === undefined ? 'user-1' : opts.uid }),
      devicesClient: devices.client as never,
    });
    runtime = await bootstrapApp(built.bootstrapDeps);
    await runtime.runner.idle();
    await settle();
    return { devices, built };
  }

  const watermarkWrites = (d: ReturnType<typeof watermarkDevices>) =>
    d.writes.filter((w) => 'synced_through' in w.patch);

  test("launch's first drain, clean: synced_through = the drain's start, on the owner's own row", async () => {
    const { devices } = await signedInLaunch();
    expect(watermarkWrites(devices)).toEqual([
      {
        patch: { synced_through: new Date(NOW).toISOString() },
        filters: [
          ['user_id', 'user-1'],
          ['id', INSTALL],
        ],
      },
    ]);
  });

  test('a recovered drive still queued (signed in, but its upload failed): no watermark', async () => {
    const devices = watermarkDevices();
    await crashedDrive();
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL);
    const supabase = createFakeSupabase({ uid: 'user-1', invoke: () => functionsFetchError() });
    runtime = await bootstrapApp(deps({ supabase, devicesClient: devices.client as never }).bootstrapDeps);
    await runtime.runner.idle();
    await settle();
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
    expect(watermarkWrites(devices)).toEqual([]);
  });

  test('signed out: nothing is written', async () => {
    const { devices } = await signedInLaunch({ uid: null });
    expect(devices.writes).toEqual([]);
  });

  test('another driver pending (a handover not yet rebuilt): nothing is written; once settled, it is', async () => {
    const { devices } = await signedInLaunch({ installId: false });
    const settings = createSettingsRepo(db);
    await settings.set(INSTALL_ID_KEY, INSTALL);
    // The owner watch saw user-2 sign in; the rebuild has not run yet.
    await settings.set(PENDING_OWNER_KEY, 'user-2');
    await runtime!.runner.drainOnce(NOW);
    expect(devices.writes).toEqual([]);
    await settings.remove(PENDING_OWNER_KEY);
    await runtime!.runner.drainOnce(NOW);
    expect(watermarkWrites(devices)).toHaveLength(1);
  });

  test('no install id yet: nothing is written', async () => {
    const { devices } = await signedInLaunch({ installId: false });
    expect(devices.writes).toEqual([]);
  });

  test('armed and idle: no timer — nothing more is written without a drain', async () => {
    const { devices } = await signedInLaunch();
    for (let i = 0; i < 5; i += 1) await settle();
    expect(watermarkWrites(devices)).toHaveLength(1);
  });

  test('before sign-out with nothing pending: signed_out_at = now on the owner\'s row', async () => {
    const { devices } = await signedInLaunch();
    await runtime!.syncWatermarkBeforeSignOut();
    expect(devices.writes.at(-1)).toEqual({
      patch: { signed_out_at: new Date(NOW).toISOString() },
      filters: [
        ['user_id', 'user-1'],
        ['id', INSTALL],
      ],
    });
  });

  test('before sign-out with a drive still to upload: nothing is written (rev2: m1a)', async () => {
    const devices = watermarkDevices();
    await crashedDrive();
    const settings = createSettingsRepo(db);
    await settings.set(LAST_USER_KEY, 'user-1');
    await settings.set(INSTALL_ID_KEY, INSTALL);
    runtime = await bootstrapApp(deps({ supabase: createFakeSupabase({ uid: 'user-1' }), devicesClient: devices.client as never, mayDrain: () => false }).bootstrapDeps);
    await runtime.syncWatermarkBeforeSignOut();
    expect(devices.writes).toEqual([]);
  });
});
