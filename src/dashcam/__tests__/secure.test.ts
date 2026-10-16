// The SecureStore entries are readable after the first unlock: an iOS Bluetooth relaunch can come
// with the phone locked, before anything else of the app runs. The key entries are this device
// only. The install marker quarantines leftovers of an earlier install.
import { checkInstall, ensureInstallMarker, INSTALL_MARKER_KEY, startDashpalEarly, type MarkerStorage } from '../early';
import type { DashcamTransport } from '../transport';
import {
  AUTH_PENDING_SECURE_KEY,
  AUTH_SECURE_KEY,
  createDashpalSecrets,
  dashpalSecrets,
  ORPHAN_SECURE_KEY,
  PENDING_CODE_MAX_AGE_MS,
  PENDING_CODE_SECURE_KEY,
  readDashpalEnabled,
  readSecureTarget,
  writeDashpalEnabled,
  writeSecureTarget,
  type StoredAuth,
} from '../secure';

// `jest.mock` is hoisted above the imports.
const mockStore = new Map<string, string>();
const mockCalls: unknown[][] = [];
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
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

const AUTH: StoredAuth = { dashcamId: 'a4cf12b3c4d5', phoneId: '0102030405060708', kPair: 'ab'.repeat(32), code: '000G40R40M30E209185GR38E1W60' };
const opt = (c: unknown[]): unknown => (c[2] as { keychainAccessible?: unknown } | undefined)?.keychainAccessible;

test('the launch flag and the peripheral: after the first unlock; values round-trip; junk reads as absent', async () => {
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
  expect(mockCalls.every((c) => opt(c) === 'after-first-unlock')).toBe(true);
});

test('the key entries are this-device-only after the first unlock', async () => {
  await dashpalSecrets.writePendingAuth(AUTH);
  await dashpalSecrets.finalizeAuth();
  await dashpalSecrets.readAuth();
  await dashpalSecrets.writeOrphan(AUTH);
  await dashpalSecrets.writePendingCode({ at: 5, dashcamId: null, code: 'X' });
  await dashpalSecrets.readPendingCode(5);
  expect(mockCalls.length).toBeGreaterThan(5);
  expect(mockCalls.some((c) => c[1] === AUTH_SECURE_KEY)).toBe(true);
  expect(mockCalls.every((c) => opt(c) === 'after-first-unlock-this-device-only')).toBe(true);
});

test('a pairing key: pending until the setup finishes, then it replaces the previous one; junk reads as none', async () => {
  const old: StoredAuth = { ...AUTH, dashcamId: '0123456789ab' };
  await dashpalSecrets.writePendingAuth(old);
  expect(await dashpalSecrets.finalizeAuth()).toEqual(old);
  expect(await dashpalSecrets.readAuth()).toEqual(old);
  expect(mockStore.has(AUTH_PENDING_SECURE_KEY)).toBe(false);
  // a setup under way leaves the current pairing as it is until it finishes
  await dashpalSecrets.writePendingAuth(AUTH);
  expect(await dashpalSecrets.readAuth()).toEqual(old);
  expect(await dashpalSecrets.readPendingAuth()).toEqual(AUTH);
  await dashpalSecrets.deletePendingAuth();
  expect(await dashpalSecrets.finalizeAuth()).toBeNull();
  expect(await dashpalSecrets.readAuth()).toEqual(old);
  // a one-time-code pairing keeps no code
  await dashpalSecrets.writePendingAuth({ ...AUTH, code: null });
  expect((await dashpalSecrets.finalizeAuth())?.code).toBeNull();
  for (const junk of [
    'nope',
    '[]',
    '{"v":1}',
    JSON.stringify({ ...AUTH, v: 2, phoneId: '0000000000000000' }),
    JSON.stringify({ ...AUTH, v: 2, kPair: 'zz' }),
    JSON.stringify({ ...AUTH, v: 2, dashcamId: 'A4CF12B3C4D5' }),
    JSON.stringify({ ...AUTH, v: 3 }),
  ]) {
    mockStore.set(AUTH_SECURE_KEY, junk);
    expect(await dashpalSecrets.readAuth()).toBeNull();
  }
  mockStore.set(AUTH_SECURE_KEY, JSON.stringify({ ...AUTH, v: 2, code: 'not-a-code' }));
  expect((await dashpalSecrets.readAuth())?.code).toBeNull();
  await dashpalSecrets.deleteAuth();
  expect(mockStore.has(AUTH_SECURE_KEY)).toBe(false);
});

test('the orphan keeps only the dashcam, the phone id and the key', async () => {
  await dashpalSecrets.writeOrphan(AUTH);
  expect(JSON.parse(mockStore.get(ORPHAN_SECURE_KEY)!)).toEqual({ dashcamId: AUTH.dashcamId, phoneId: AUTH.phoneId, kPair: AUTH.kPair });
  expect(await dashpalSecrets.readOrphan()).toEqual({ dashcamId: AUTH.dashcamId, phoneId: AUTH.phoneId, kPair: AUTH.kPair });
  await dashpalSecrets.deleteOrphan();
  expect(await dashpalSecrets.readOrphan()).toBeNull();
});

test('a held link code lasts 12 h: an older one, one from the future or junk is deleted and reads as none', async () => {
  const at = 1_000_000;
  await dashpalSecrets.writePendingCode({ at, dashcamId: 'a4cf12b3c4d5', code: 'C944BA9XVGR6PTJDKBQ2BR9W54RG' });
  expect(await dashpalSecrets.readPendingCode(at + PENDING_CODE_MAX_AGE_MS)).toEqual({ at, dashcamId: 'a4cf12b3c4d5', code: 'C944BA9XVGR6PTJDKBQ2BR9W54RG' });
  expect(await dashpalSecrets.readPendingCode(at + PENDING_CODE_MAX_AGE_MS + 1)).toBeNull();
  expect(mockStore.has(PENDING_CODE_SECURE_KEY)).toBe(false);
  await dashpalSecrets.writePendingCode({ at, dashcamId: null, code: 'X' });
  expect(await dashpalSecrets.readPendingCode(at - 1)).toBeNull();
  mockStore.set(PENDING_CODE_SECURE_KEY, JSON.stringify({ at, dashcamId: 'NOT', code: 'X' }));
  expect(await dashpalSecrets.readPendingCode(at)).toBeNull();
  mockStore.set(PENDING_CODE_SECURE_KEY, 'junk');
  expect(await dashpalSecrets.readPendingCode(at)).toBeNull();
});

test('a store without the accessibility constants gets no options (the platform default)', async () => {
  const calls: unknown[] = [];
  const s = createDashpalSecrets(() => ({
    getItemAsync: async (_k: string, o?: unknown) => {
      calls.push(o);
      return null;
    },
    setItemAsync: async (_k: string, _v: string, o?: unknown) => {
      calls.push(o);
    },
    deleteItemAsync: async (_k: string, o?: unknown) => {
      calls.push(o);
    },
  }));
  await s.readAuth();
  await s.writeEnabled(true);
  expect(calls).toEqual([undefined, undefined]);
});

function markers(initial: string | null = '1', o: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const store = new Map<string, string>();
  if (initial !== null) store.set(INSTALL_MARKER_KEY, initial);
  const storage: MarkerStorage = {
    getItem: async (k) => {
      if (o.throwOnGet) throw new Error('AsyncStorage unavailable');
      return store.get(k) ?? null;
    },
    setItem: async (k, v) => {
      if (o.throwOnSet) throw new Error('disk full');
      store.set(k, v);
    },
  };
  return { store, storage: () => storage };
}

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
  expect(await startDashpalEarly({ storage: markers().storage, transport: () => (made++, f.t) })).toBe(false);
  expect(made).toBe(0);
});

test('early start: with the flag, the stored peripheral becomes the target and the manager starts', async () => {
  await writeDashpalEnabled(true);
  await writeSecureTarget({ peripheralId: 'P-1', dashcamId: 'a4cf12b3c4d5' });
  const f = fakeTransport();
  expect(await startDashpalEarly({ storage: markers().storage, transport: () => f.t })).toBe(true);
  expect(f.log).toEqual(['target:P-1', 'start']);
});

test('early start: a failure is reported, never thrown', async () => {
  await writeDashpalEnabled(true);
  const errors: unknown[] = [];
  const ok = await startDashpalEarly({
    storage: markers().storage,
    transport: () => {
      throw new Error('BleManagerModule not found');
    },
    onError: (e) => errors.push(e),
  });
  expect(ok).toBe(false);
  expect(errors).toHaveLength(1);
});

test('early start, no install marker (a fresh install, an iOS reinstall with Keychain leftovers): the leftovers are quarantined and nothing starts', async () => {
  await writeDashpalEnabled(true);
  await writeSecureTarget({ peripheralId: 'P-1', dashcamId: 'a4cf12b3c4d5' });
  await dashpalSecrets.writePendingAuth(AUTH);
  await dashpalSecrets.finalizeAuth();
  await dashpalSecrets.writePendingCode({ at: 1, dashcamId: null, code: 'X' });
  const m = markers(null);
  const f = fakeTransport();
  let made = 0;
  expect(await startDashpalEarly({ storage: m.storage, transport: () => (made++, f.t) })).toBe(false);
  expect(made).toBe(0);
  expect(await readDashpalEnabled()).toBe(false);
  expect(await readSecureTarget()).toBeNull();
  expect(await dashpalSecrets.readAuth()).toBeNull();
  expect(await dashpalSecrets.readOrphan()).toEqual({ dashcamId: AUTH.dashcamId, phoneId: AUTH.phoneId, kPair: AUTH.kPair });
  expect(mockStore.has(PENDING_CODE_SECURE_KEY)).toBe(false);
  expect(m.store.get(INSTALL_MARKER_KEY)).toBe('1');
  // the next launch finds the marker: the early start runs again once the driver opted in again
  await writeDashpalEnabled(true);
  expect(await startDashpalEarly({ storage: m.storage, transport: () => f.t })).toBe(true);
});

test('quarantine: a pending key (an interrupted setup) is kept as the orphan when there is no pairing key', async () => {
  await dashpalSecrets.writePendingAuth(AUTH);
  expect(await checkInstall({ storage: markers(null).storage })).toBe('quarantined');
  expect(await dashpalSecrets.readOrphan()).toEqual({ dashcamId: AUTH.dashcamId, phoneId: AUTH.phoneId, kPair: AUTH.kPair });
  expect(await dashpalSecrets.readPendingAuth()).toBeNull();
});

test('early start, AsyncStorage unreadable: nothing starts and nothing is touched', async () => {
  await writeDashpalEnabled(true);
  await dashpalSecrets.writePendingAuth(AUTH);
  await dashpalSecrets.finalizeAuth();
  const f = fakeTransport();
  let made = 0;
  expect(await startDashpalEarly({ storage: markers('1', { throwOnGet: true }).storage, transport: () => (made++, f.t) })).toBe(false);
  expect(made).toBe(0);
  expect(await readDashpalEnabled()).toBe(true);
  expect(await dashpalSecrets.readAuth()).toEqual(AUTH);
});

test('a marker write that fails quarantines anyway; ensureInstallMarker writes a missing marker and never throws', async () => {
  const failing = markers(null, { throwOnSet: true });
  expect(await checkInstall({ storage: failing.storage })).toBe('quarantined');
  await expect(ensureInstallMarker(failing.storage)).resolves.toBeUndefined();
  const m = markers(null);
  await ensureInstallMarker(m.storage);
  expect(m.store.get(INSTALL_MARKER_KEY)).toBe('1');
  await expect(ensureInstallMarker(markers(null, { throwOnGet: true }).storage)).resolves.toBeUndefined();
});
