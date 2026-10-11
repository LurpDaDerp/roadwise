// The SecureStore entries are readable after the first unlock: an iOS Bluetooth relaunch can come
// with the phone locked, before anything else of the app runs.
import { startDashpalEarly } from '../early';
import type { DashcamTransport } from '../transport';
import { readDashpalEnabled, readSecureTarget, writeDashpalEnabled, writeSecureTarget } from '../secure';

// `jest.mock` is hoisted above the imports.
const mockStore = new Map<string, string>();
const mockCalls: unknown[][] = [];
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: async (k: string, o: unknown) => {
    mockCalls.push(['get', k, o]);
    return mockStore.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, o: unknown) => {
    mockCalls.push(['set', k, o]);
    mockStore.set(k, v);
  },
  deleteItemAsync: async (k: string, o: unknown) => {
    mockCalls.push(['delete', k, o]);
    mockStore.delete(k);
  },
}));


beforeEach(() => {
  mockStore.clear();
  mockCalls.length = 0;
});

test('every read and write uses AFTER_FIRST_UNLOCK; values round-trip; junk reads as absent', async () => {
  expect(await readDashpalEnabled()).toBe(false);
  await writeDashpalEnabled(true);
  expect(await readDashpalEnabled()).toBe(true);
  await writeSecureTarget({ peripheralId: 'P-1', dashcamId: 'a4cf12b3c4d5' });
  expect(await readSecureTarget()).toEqual({ peripheralId: 'P-1', dashcamId: 'a4cf12b3c4d5' });
  mockStore.set('dashpal.peripheral', '{"peripheralId":"P","dashcamId":"NOT-HEX"}');
  expect(await readSecureTarget()).toBeNull();
  mockStore.set('dashpal.peripheral', 'not json');
  expect(await readSecureTarget()).toBeNull();
  await writeSecureTarget(null);
  await writeDashpalEnabled(false);
  expect(mockStore.size).toBe(0);
  expect(mockCalls.every((c) => (c[2] as { keychainAccessible?: unknown })?.keychainAccessible === 'after-first-unlock')).toBe(true);
});

function fakeTransport() {
  const log: string[] = [];
  let target: { peripheralId: string; dashcamId: string } | null = null;
  const t = {
    target: () => target,
    setTarget: (x: { peripheralId: string; dashcamId: string } | null) => {
      target = x;
      log.push(`target:${x?.peripheralId ?? 'null'}`);
    },
    start: async () => void log.push('start'),
  } as unknown as DashcamTransport;
  return { t, log };
}

test('early start: nothing at all without the opt-in flag (no BLE manager, no prompt)', async () => {
  const f = fakeTransport();
  let made = 0;
  expect(await startDashpalEarly({ transport: () => (made++, f.t) })).toBe(false);
  expect(made).toBe(0);
});

test('early start: with the flag, the stored peripheral becomes the target and the manager starts', async () => {
  await writeDashpalEnabled(true);
  await writeSecureTarget({ peripheralId: 'P-1', dashcamId: 'a4cf12b3c4d5' });
  const f = fakeTransport();
  expect(await startDashpalEarly({ transport: () => f.t })).toBe(true);
  expect(f.log).toEqual(['target:P-1', 'start']);
});

test('early start: a failure is reported, never thrown', async () => {
  await writeDashpalEnabled(true);
  const errors: unknown[] = [];
  const ok = await startDashpalEarly({
    transport: () => {
      throw new Error('BleManagerModule not found');
    },
    onError: (e) => errors.push(e),
  });
  expect(ok).toBe(false);
  expect(errors).toHaveLength(1);
});
