// Final review I2: the production player (not an injected one) probes each tone at launch, so a
// tone that will not load marks alerts unavailable on a real device.
import { createFakeDriveSense } from '@drive-sense';

import { bootstrapApp, type AppRuntime, type BootstrapDeps } from '@/boot/bootstrap';
import { counterIds, T0 } from '@/core/detectors/__fixtures__/rows';
import { TZ } from '@/core/engine/__fixtures__/drives';
import { migrate, type Db } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createFakeAppState, createFakeFs, createFakeSupabase } from '@/data/sync/__fixtures__/fakes';

const mockAudio = { fail: false, created: 0 };
jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(async () => {}),
  setIsAudioActiveAsync: jest.fn(async () => {}),
  createAudioPlayer: jest.fn(() => {
    if (mockAudio.fail) throw new Error('tone asset missing');
    mockAudio.created += 1;
    return { remove: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })), play: jest.fn() };
  }),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }));
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Heavy: 'heavy' },
  NotificationFeedbackType: { Warning: 'warning' },
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
}));

let db: Db;
let runtime: AppRuntime | null = null;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockAudio.fail = false;
  mockAudio.created = 0;
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

test('a tone that will not load: the drive records silently, and says so', async () => {
  mockAudio.fail = true;
  const errors: string[] = [];
  runtime = await bootstrapApp(deps(errors));
  expect(runtime.drive.snapshot().alertsAvailable).toBe(false);
  expect(errors).toContain('alert ports');
});

test('negative control: every tone loads, and alerts are available', async () => {
  const errors: string[] = [];
  runtime = await bootstrapApp(deps(errors));
  expect(mockAudio.created).toBe(3);
  expect(runtime.drive.snapshot().alertsAvailable).toBe(true);
  expect(errors).not.toContain('alert ports');
});
