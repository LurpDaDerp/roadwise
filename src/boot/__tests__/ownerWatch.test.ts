import { bootstrapApp, type AppRuntime, type BootstrapDeps } from '@/boot/bootstrap';
import { LAST_USER_KEY, readDeviceOwner } from '@/boot/device';
import { watchDeviceOwner, type AuthWatchable } from '@/boot/ownerWatch';
import { T0, counterIds } from '@/core/detectors/__fixtures__/rows';
import { TZ } from '@/core/engine/__fixtures__/drives';
import { createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { seedTrips } from '@/data/queries/__fixtures__/harness';
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';

const NOW = T0 + 36_000_000;

let db: Db;
let live: AppRuntime[] = [];

beforeEach(async () => {
  db = await createSqlJsDb();
  live = [];
});

afterEach(() => {
  for (const runtime of live) runtime.stop();
});

/**
 * The Supabase client as both halves of this see it: the runner's slice plus the auth stream the
 * watch listens to. `signIn` is the device changing hands under a running app.
 */
function authFake(uid: string | null) {
  const base = createFakeSupabase({ uid });
  const listeners = new Set<(event: string, session: { user: { id: string } } | null) => void>();
  let unsubscribes = 0;

  const supabase: AuthWatchable & typeof base = {
    ...base,
    auth: {
      getSession: base.auth.getSession,
      refreshSession: base.auth.refreshSession,
      onAuthStateChange(listener) {
        listeners.add(listener);
        return {
          data: {
            subscription: {
              unsubscribe() {
                unsubscribes += 1;
                listeners.delete(listener);
              },
            },
          },
        };
      },
    },
  };

  return {
    supabase,
    base,
    listenerCount: () => listeners.size,
    unsubscribes: () => unsubscribes,
    emit(next: string | null, event = 'SIGNED_IN') {
      base.setUid(next);
      const session = next === null ? null : { user: { id: next } };
      for (const listener of [...listeners]) listener(event, session);
    },
  };
}

function depsFor(supabase: BootstrapDeps['supabase'], over: Partial<BootstrapDeps> = {}) {
  const appState = createFakeAppState();
  const traces = new Map<string, Uint8Array>();
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
    hash: { sha256: async (text: string) => String(text.length).padStart(64, '0') },
    newId: counterIds(),
    appState,
    tz: TZ,
    now: () => NOW,
    onError: () => {},
    ...over,
  };
  return { bootstrapDeps, appState, traces };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/** What one driver leaves behind on the device. */
async function seedDriverData(id = 'a-drive'): Promise<void> {
  await seedTrips(db, [tripRow({ client_trip_id: id })]);
  await createQueueRepo(db).enqueue('dispute', { clientTripId: id }, `dispute:${id}`, T0);
}

describe('the watch alone', () => {
  beforeEach(async () => {
    await migrate(db);
    await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
  });

  function watching(uid: string | null) {
    const auth = authFake(uid);
    const handovers: number[] = [];
    const stop = watchDeviceOwner(db, {
      supabase: auth.supabase,
      onHandover: () => handovers.push(Date.now()),
    });
    return { auth, handovers, stop };
  }

  test('a different driver signing in raises a handover', async () => {
    const { auth, handovers, stop } = watching('user-a');
    auth.emit('user-b');
    await settle();
    expect(handovers).toHaveLength(1);
    stop();
  });

  test('a token refresh for the same driver changes nothing', async () => {
    const { auth, handovers, stop } = watching('user-a');
    auth.emit('user-a', 'TOKEN_REFRESHED');
    auth.emit('user-a', 'USER_UPDATED');
    await settle();
    expect(handovers).toEqual([]);
    stop();
  });

  test('a sign-out raises nothing and does not forget the owner', async () => {
    const { auth, handovers, stop } = watching('user-a');
    auth.emit(null, 'SIGNED_OUT');
    await settle();
    expect(handovers).toEqual([]);
    expect(await readDeviceOwner(db)).toBe('user-a');
    stop();
  });

  test('signing back in after a sign-out is the same driver, not a handover', async () => {
    const { auth, handovers, stop } = watching('user-a');
    auth.emit(null, 'SIGNED_OUT');
    auth.emit('user-a');
    await settle();
    expect(handovers).toEqual([]);
    stop();
  });

  test('a first sign-in on a device nobody owned records the owner instead of rebuilding', async () => {
    await createSettingsRepo(db).remove(LAST_USER_KEY);
    const { auth, handovers, stop } = watching(null);

    auth.emit('user-a');
    await settle();

    expect(handovers).toEqual([]);
    // Recorded here rather than at the next launch, so a handover that never restarts the app is
    // still detectable: without this the next driver would look like the first one.
    expect(await readDeviceOwner(db)).toBe('user-a');

    auth.emit('user-b');
    await settle();
    expect(handovers).toHaveLength(1);
    stop();
  });

  test('a stopped watch is silent, and lets go of its subscription', async () => {
    const { auth, handovers, stop } = watching('user-a');
    stop();
    expect(auth.unsubscribes()).toBe(1);
    expect(auth.listenerCount()).toBe(0);

    auth.emit('user-b');
    await settle();
    expect(handovers).toEqual([]);
  });
});

test('a handover mid-session: the old runtime goes, and the new one starts on a clean device', async () => {
  const auth = authFake('user-a');
  const { bootstrapDeps, appState, traces } = depsFor(auth.supabase);

  const first = await bootstrapApp(bootstrapDeps);
  live.push(first);
  expect(first.owner).toBe('first');

  // A's record, and a row of it already read into the cache the screens render from.
  await seedDriverData();
  traces.set('a-drive.bin.gz', new Uint8Array([1, 2, 3]));
  first.queryClient.setQueryData(['trips', {}], [{ clientTripId: 'a-drive' }]);

  // The layout's watch, bound to the runtime it belongs to.
  let handovers = 0;
  const stopWatch = watchDeviceOwner(first.db, {
    supabase: auth.supabase,
    onHandover: () => {
      handovers += 1;
    },
  });

  auth.emit('user-b');
  await settle();
  expect(handovers).toBe(1);

  // What the layout does with that: the old runtime leaves the tree and is stopped, then the
  // whole launch runs again — and it is that launch's `identity` stage that wipes.
  stopWatch();
  first.stop();
  const second = await bootstrapApp(bootstrapDeps);
  live = [second];

  expect(second.owner).toBe('wiped');
  expect(await createTripsRepo(db).get('a-drive')).toBeNull();
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
  expect([...traces.keys()]).toEqual([]);
  expect(await readDeviceOwner(db)).toBe('user-b');

  // A fresh cache, and the old one emptied rather than left holding A's rows for five minutes.
  expect(second.queryClient).not.toBe(first.queryClient);
  expect(first.queryClient.getQueryCache().getAll()).toEqual([]);
  expect(second.queryClient.getQueryData(['trips', {}])).toBeUndefined();

  // One runner, never two: the old one let go of the foreground before the new one took it.
  expect(appState.listeners).toHaveLength(1);
  expect(appState.removals).toBe(1);
});
