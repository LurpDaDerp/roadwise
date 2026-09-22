// Final review I2: the production player (not an injected one) marks alerts unavailable when the
// audio ports cannot load.
import { createFakeDriveSense } from '@drive-sense';

import { bootstrapApp, type AppRuntime, type BootstrapDeps } from '@/boot/bootstrap';
import { counterIds, T0 } from '@/core/detectors/__fixtures__/rows';
import { TZ } from '@/core/engine/__fixtures__/drives';
import { migrate, type Db } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';

// The production player path (no `createPlayer` injected), with the audio ports scripted: they load,
// or they cannot (a build whose audio modules are missing). There is no launch tone probe any more
// (final re-review n2): creating a player does not load the asset, so it proved nothing; a tone that
// never loads is caught at its first alert instead (adapters and player tests).
const mockPorts = { fail: false, loads: 0 };
jest.mock('@/core/alerts/adapters', () => ({
  ...jest.requireActual('@/core/alerts/adapters'),
  createExpoAlertPorts: jest.fn(async () => {
    mockPorts.loads += 1;
    if (mockPorts.fail) throw new Error('Cannot find native module ExpoAudio');
    return {
      audio: { activate: async () => {}, play: async () => {}, stop: async () => {}, deactivate: async () => {} },
      voice: { speak: async () => {}, stop: async () => {} },
      haptics: { pattern: async () => {} },
    };
  }),
}));

let db: Db;
let runtime: AppRuntime | null = null;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockPorts.fail = false;
  mockPorts.loads = 0;
});

afterEach(async () => {
  await runtime?.stop({ endOpenTrip: false });
  runtime?.queryClient.clear();
  runtime = null;
});

function deps(errors: string[]): BootstrapDeps {
  const driveSense = createFakeDriveSense({ platform: 'ios', now: () => T0 });
  driveSense.setState({ location: 'always', motion: 'granted' });
  return {
    openDb: async () => db,
    supabase: createFakeSupabase({ uid: null }),
    traceFs: createFakeFs(),
    traceWriter: { writeGzip: async () => {}, clear: async () => {} },
    hash: { sha256: async (t: string) => String(t.length).padStart(64, '0') },
    newId: counterIds(),
    appState: Object.assign(createFakeAppState(), { currentState: 'active' as string | null }),
    net: { isWifi: () => false },
    excludeFromBackup: async () => {},
    databaseDirectory: '/data/SQLite',
    source: driveSense,
    limits: {
      lookup: () => null,
      prefetch: () => {},
      lookupStored: async () => null,
      startTrip: () => {},
      resetTrip: () => {},
      purgeExpired: async () => 0,
      stats: () => ({ memoryTiles: 0, requestsThisTrip: 0, pointLookupsThisTrip: 0, sqliteLoads: 0, truncatedTiles: 0 }),
      settled: async () => {},
    },
    // No createPlayer: the production player, over the mocked native modules.
    mountDiagnostics: null,
    attachSummaryNotifier: null,
    tz: TZ,
    now: () => T0,
    onError: (_e, ctx) => {
      errors.push(ctx);
    },
  };
}

test('audio that will not load: the drive records silently, and says so', async () => {
  mockPorts.fail = true;
  const errors: string[] = [];
  runtime = await bootstrapApp(deps(errors));
  expect(runtime.drive.snapshot().alertsAvailable).toBe(false);
  expect(errors).toContain('alert ports');
});

test('negative control: the ports load, and alerts are available', async () => {
  const errors: string[] = [];
  runtime = await bootstrapApp(deps(errors));
  expect(mockPorts.loads).toBe(1);
  expect(runtime.drive.snapshot().alertsAvailable).toBe(true);
  expect(errors).not.toContain('alert ports');
});
