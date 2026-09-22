import { createFakeDriveSense } from '@drive-sense';

import { bootstrapApp, startForegroundJobs, type AppRuntime, type BootstrapDeps } from '@/boot/bootstrap';
import { createRuntimeController, type RuntimeState } from '@/boot/controller';
import { LAST_USER_KEY } from '@/boot/device';
import type { LaunchProfile } from '@/boot/launchProfile';
import { T0, counterIds } from '@/core/detectors/__fixtures__/rows';
import { drive, TZ } from '@/core/engine/__fixtures__/drives';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { finalizeIdempotencyKey } from '@/data/sync/queue';
import { HYDRATE_RESTORED_AT_KEY } from '@/data/hydrate/hydrate';
import { setHydrationStatus } from '@/data/hydrate/status';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

// ——— a unit harness: the controller over a scripted bootstrap ———

interface FakeRuntime {
  runtime: AppRuntime;
  stops: { endOpenTrip?: boolean }[];
}

function fakeRuntime(id: number, log: string[]): FakeRuntime {
  const stops: { endOpenTrip?: boolean }[] = [];
  const runtime = {
    id,
    async stop(opts: { endOpenTrip?: boolean } = {}) {
      log.push(`stop ${id}`);
      stops.push(opts);
    },
  } as unknown as AppRuntime;
  return { runtime, stops };
}

function unitHarness(opts: { currentState?: string } = {}) {
  const log: string[] = [];
  const appState = Object.assign(createFakeAppState(), {
    currentState: (opts.currentState ?? 'active') as string | null,
  });
  const built: FakeRuntime[] = [];
  const profiles: LaunchProfile[] = [];
  const expectedUids: (string | null)[] = [];
  let failNext: Error | null = null;
  let gate: Promise<void> | null = null;
  const jobsStops: number[] = [];
  const controller = createRuntimeController({
    appState,
    async bootstrap(profile, opts) {
      profiles.push(profile);
      expectedUids.push(opts?.expectedUid ?? null);
      log.push(`boot ${built.length + 1}`);
      if (gate) await gate;
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const next = fakeRuntime(built.length + 1, log);
      built.push(next);
      return next.runtime;
    },
    async startForegroundJobs(runtime) {
      const id = (runtime as unknown as { id: number }).id;
      log.push(`jobs ${id}`);
      return {
        async stop() {
          log.push(`jobs stop ${id}`);
          jobsStops.push(id);
        },
        runNow: async () => true,
      };
    },
    onError: () => {},
  });
  return {
    controller,
    appState,
    built,
    profiles,
    expectedUids,
    log,
    jobsStops,
    failNextBoot(error: Error) {
      failNext = error;
    },
    hold() {
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

describe('ensureRuntime', () => {
  test('boots once per generation, whoever asks and however often', async () => {
    const h = unitHarness();
    const [a, b] = await Promise.all([h.controller.ensureRuntime(), h.controller.ensureRuntime('background')]);
    const c = await h.controller.ensureRuntime();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(h.built).toHaveLength(1);
    // The first caller's profile is the launch's: index.ts boots eagerly, the layout joins it.
    expect(h.profiles).toEqual(['foreground']);
  });

  test('the default profile is read from AppState at boot', async () => {
    const h = unitHarness({ currentState: 'background' });
    await h.controller.ensureRuntime();
    expect(h.profiles).toEqual(['background']);
  });

  test('a failed boot is reported in the state, and the next call tries again', async () => {
    const h = unitHarness();
    const states: RuntimeState['status'][] = [];
    h.controller.subscribe((s) => states.push(s.status));
    h.failNextBoot(new Error('disk I/O error'));
    await expect(h.controller.ensureRuntime()).rejects.toThrow('disk I/O error');
    expect(h.controller.state()).toMatchObject({ status: 'failed', runtime: null });
    expect(h.controller.state().error?.message).toBe('disk I/O error');

    const runtime = await h.controller.ensureRuntime();
    expect(h.built).toHaveLength(1);
    expect(h.controller.state()).toMatchObject({ status: 'ready', runtime, error: null });
    // The retry is visible as a boot that still carries the last failure (the layout's "retrying").
    expect(states).toEqual(['booting', 'failed', 'booting', 'ready']);
  });
});

describe('foreground jobs start only on the foreground path', () => {
  test('a foreground launch starts them once the runtime is ready', async () => {
    const h = unitHarness();
    await h.controller.ensureRuntime();
    await settle();
    expect(h.log).toEqual(['boot 1', 'jobs 1']);
    expect(h.controller.foregroundJobs()).not.toBeNull();
  });

  test('a background launch starts none — until the driver opens the app', async () => {
    const h = unitHarness({ currentState: 'background' });
    await h.controller.ensureRuntime('background');
    await settle();
    expect(h.log).toEqual(['boot 1']);
    expect(h.controller.foregroundJobs()).toBeNull();

    h.appState.emit('inactive');
    await settle();
    expect(h.log).toEqual(['boot 1']);

    h.appState.currentState = 'active';
    h.appState.emit('active');
    h.appState.emit('active');
    await settle();
    expect(h.log).toEqual(['boot 1', 'jobs 1']);
    // Started once; the controller's own listener is gone again.
    expect(h.appState.listeners).toHaveLength(0);
  });
});

describe('rebuild', () => {
  test('awaits the old runtime (jobs, then the drive-ending stop) before the new launch starts', async () => {
    const h = unitHarness();
    const first = await h.controller.ensureRuntime();
    await settle();
    const states: RuntimeState['status'][] = [];
    h.controller.subscribe((s) => states.push(s.status));

    const second = await h.controller.rebuild();

    expect(second).not.toBe(first);
    expect(h.log).toEqual(['boot 1', 'jobs 1', 'jobs stop 1', 'stop 1', 'boot 2', 'jobs 2']);
    // A handover ends the open drive (the M2 trade): `endOpenTrip` defaults on.
    expect(h.built[0]?.stops).toEqual([{}]);
    expect(states).toEqual(['switching', 'booting', 'ready']);
    expect(await h.controller.ensureRuntime()).toBe(second);
  });

  test('a handover rebuild carries the new driver\'s uid into the launch (H2 I-1 a)', async () => {
    const h = unitHarness();
    await h.controller.ensureRuntime();
    await h.controller.rebuild({ expectedUid: 'user-b' });
    expect(h.expectedUids).toEqual([null, 'user-b']);
  });

  test('callers during a rebuild get the new runtime, not the old one', async () => {
    const h = unitHarness();
    await h.controller.ensureRuntime();
    const release = h.hold();
    const rebuilding = h.controller.rebuild();
    const joined = h.controller.ensureRuntime();
    const again = h.controller.rebuild();
    await settle();
    release();
    const [a, b, c] = await Promise.all([rebuilding, joined, again]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(h.built).toHaveLength(2);
  });

  test('a rebuild while the first launch is still booting stops that one when it lands', async () => {
    const h = unitHarness();
    const release = h.hold();
    const first = h.controller.ensureRuntime();
    const rebuilt = h.controller.rebuild();
    await settle();
    release();
    await first;
    const second = await rebuilt;
    expect(h.log.filter((l) => l.startsWith('stop'))).toEqual(['stop 1']);
    expect(h.controller.state().runtime).toBe(second);
  });
});

// ——— the integration: the real launch under the controller ———

describe('with the real launch', () => {
  let db: Db;
  let controller: ReturnType<typeof createRuntimeController> | null = null;

  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db);
  });

  afterEach(async () => {
    const runtime = controller?.state().runtime;
    if (runtime) {
      await runtime.stop({ endOpenTrip: false });
      runtime.queryClient.clear();
    }
    controller = null;
    setHydrationStatus({ state: 'idle' });
  });

  const limits = (): SpeedLimitClient & { purged: number } => {
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
  };

  function launchDeps(opts: { uid: string; currentState: string; clock: () => number }) {
    const supabase = createFakeSupabase({ uid: opts.uid, tables: {} });
    const appState = Object.assign(createFakeAppState(), { currentState: opts.currentState as string | null });
    const driveSense = createFakeDriveSense({ platform: 'ios', now: opts.clock });
    driveSense.setState({ location: 'always', motion: 'granted' });
    const config = { reads: 0 };
    const tiles = limits();
    const base: BootstrapDeps = {
      openDb: async () => db,
      supabase,
      traceFs: createFakeFs(),
      traceWriter: { writeGzip: async () => {}, clear: async () => {} },
      hash: { sha256: async (text: string) => String(text.length).padStart(64, '0') },
      newId: counterIds(),
      appState,
      net: { isWifi: () => false },
      excludeFromBackup: async () => {},
      databaseDirectory: '/data/SQLite',
      source: driveSense,
      limits: tiles,
      createPlayer: async () => ({ deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} }),
      mountDiagnostics: null,
      attachSummaryNotifier: null,
      appConfig: {
        from: () => ({
          select: async () => {
            config.reads += 1;
            return { data: [], error: null };
          },
        }),
      },
      tz: TZ,
      now: opts.clock,
      onError: () => {},
    };
    return { base, supabase, appState, driveSense, config, tiles };
  }

  test('a background launch hydrates nothing, fetches no config and drains nothing — the foreground does all three', async () => {
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-1');
    const d = launchDeps({ uid: 'user-1', currentState: 'background', clock: () => T0 });
    controller = createRuntimeController({
      appState: d.appState,
      bootstrap: (profile) => bootstrapApp({ ...d.base, profile }),
      startForegroundJobs: (runtime) => startForegroundJobs(runtime, { appState: d.appState }),
    });
    // A drive that went up under the queue while nobody was looking: work a drain would send.
    await createQueueRepo(db).enqueue('delete-trip', { action: 'delete', clientTripId: 'x' }, 'delete:x', T0, undefined, 'user-1');

    const runtime = await controller.ensureRuntime('background');
    await settle();
    expect(runtime.profile).toBe('background');
    expect(d.supabase.selects).toEqual([]);
    expect(d.config.reads).toBe(0);
    expect(d.supabase.invokes).toEqual([]);
    expect(d.tiles.purged).toBe(0);

    d.appState.currentState = 'active';
    d.appState.emit('active');
    await settle();
    await settle();
    expect(d.supabase.selects.some((s) => s.table === 'trips')).toBe(true);
    expect(d.config.reads).toBe(1);
    expect(d.supabase.invokes.length).toBeGreaterThan(0);
    expect(d.tiles.purged).toBe(1);
  });

  test('handover mid-drive: the open drive is queued under the previous owner, then removed by the new launch’s wipe', async () => {
    // Documents the known M2 trade (open decision 2) — not a rescue.
    let clock = T0;
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
    await createSettingsRepo(db).set(HYDRATE_RESTORED_AT_KEY, T0);
    const d = launchDeps({ uid: 'user-a', currentState: 'active', clock: () => clock });
    controller = createRuntimeController({
      appState: d.appState,
      bootstrap: (profile, opts) => bootstrapApp({ ...d.base, profile, ...opts }),
      startForegroundJobs: (runtime) => startForegroundJobs(runtime, { appState: d.appState }),
    });
    const first = await controller.ensureRuntime();
    await first.drive.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await first.drive.settled();
    for (const row of drive(200, { t0: clock + 1000 })) {
      clock = row.ts + 200;
      d.driveSense.loadTrace([row]);
      d.driveSense.step();
      await first.drive.settled();
    }
    const tripId = first.drive.snapshot().clientTripId as string;
    expect(await createTripsRepo(db).get(tripId)).toMatchObject({ status: 'recording' });

    // What the stop leaves between the two launches, seen from inside the old runtime's stop.
    const trips = createTripsRepo(db);
    const queue = createQueueRepo(db);
    let between: { status: string | undefined; owner: string | null | undefined } | null = null;
    const stop = first.stop.bind(first);
    first.stop = async (opts) => {
      await stop(opts);
      const item = await queue.byKey(finalizeIdempotencyKey(tripId));
      between = { status: (await trips.get(tripId))?.status, owner: item?.owner_uid };
    };

    // User B signs in on this phone: the layout's owner watch calls rebuild() with B's uid. B's
    // session read is slow (it never answers here): the launch wipes on the uid it was given.
    d.supabase.setUid('user-b');
    const realSession = d.supabase.auth.getSession.bind(d.supabase.auth);
    let answerSession: () => void = () => {};
    const sessionGate = new Promise<void>((resolve) => {
      answerSession = resolve;
    });
    d.supabase.auth.getSession = async () => {
      await sessionGate;
      return realSession();
    };
    const second = await controller.rebuild({ expectedUid: 'user-b' });

    expect(between).toEqual({ status: 'provisional', owner: 'user-a' });
    expect(second.owner).toBe('wiped');
    answerSession();
    await settle();
    expect(await trips.get(tripId)).toBeNull();
    expect(await queue.countByStatus('pending')).toBe(0);
    // Nothing of A's went up under B's session.
    expect(d.supabase.invokes).toEqual([]);
  });
});
