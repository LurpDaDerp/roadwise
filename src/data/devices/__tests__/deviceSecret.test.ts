import { clearDeviceSecret, DEVICE_SECRET_KEY, deviceTrimSeed, getDeviceSecret, preloadDeviceSecret, resetDeviceSecretForTests, type SecretStore, type SecretStoreOptions } from '@/data/devices/deviceSecret';
import { trimPlan } from '@/core/engine/privacy';
import { hmacSha256Hex, sha256Hex } from '@/lib/sha256';

function memoryStore(): SecretStore & { items: Map<string, string>; options: (SecretStoreOptions | undefined)[]; locked: boolean } {
  const items = new Map<string, string>();
  const store = {
    items,
    options: [] as (SecretStoreOptions | undefined)[],
    locked: false,
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    getItemAsync: async (k: string, o?: SecretStoreOptions) => {
      if (store.locked) throw new Error('keychain locked');
      store.options.push(o);
      return items.get(k) ?? null;
    },
    setItemAsync: async (k: string, v: string, o?: SecretStoreOptions) => {
      store.options.push(o);
      items.set(k, v);
    },
    deleteItemAsync: async (k: string, o?: SecretStoreOptions) => {
      store.options.push(o);
      items.delete(k);
    },
  };
  return store;
}

beforeEach(() => resetDeviceSecretForTests());

test('SHA-256 and HMAC-SHA256 match the published vectors', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
  expect(hmacSha256Hex('4a656665', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('the device secret is 32 random bytes, minted once, kept in the store, and cleared with the account', async () => {
  const store = memoryStore();
  const a = await getDeviceSecret(store);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(store.items.get(DEVICE_SECRET_KEY)).toBe(a);
  expect(await getDeviceSecret(store)).toBe(a);
  resetDeviceSecretForTests();
  expect(await getDeviceSecret(store)).toBe(a); // read back from the store
  await clearDeviceSecret(store);
  expect(store.items.has(DEVICE_SECRET_KEY)).toBe(false);
  const b = await getDeviceSecret(store);
  expect(b).not.toBe(a);
});

test('the secret is stored and read with AFTER_FIRST_UNLOCK; a store without the constant gets no options', async () => {
  const store = memoryStore();
  await getDeviceSecret(store);
  await clearDeviceSecret(store);
  expect(store.options).toEqual([{ keychainAccessible: 'afterFirstUnlock' }, { keychainAccessible: 'afterFirstUnlock' }, { keychainAccessible: 'afterFirstUnlock' }]);
  resetDeviceSecretForTests();
  const plain = memoryStore();
  delete (plain as { AFTER_FIRST_UNLOCK?: unknown }).AFTER_FIRST_UNLOCK;
  await getDeviceSecret(plain);
  expect(plain.options).toEqual([undefined, undefined]);
});

test('preloaded at bootstrap, the secret serves a finalize from memory while the keychain is unreadable', async () => {
  const store = memoryStore();
  await preloadDeviceSecret(store);
  const secret = store.items.get(DEVICE_SECRET_KEY)!;
  store.locked = true; // the phone locked itself before an auto-end
  const unlocked: SecretStore = { ...store, getItemAsync: async () => secret };
  expect(await deviceTrimSeed('trip-1', store)).toBe(await deviceTrimSeed('trip-1', unlocked));
  // Without the preload the same locked store fails — the cache is what carries the finalize.
  resetDeviceSecretForTests();
  await expect(deviceTrimSeed('trip-1', store)).rejects.toThrow('keychain locked');
  const errors: unknown[] = [];
  await preloadDeviceSecret(store, (e) => errors.push(e));
  expect(errors).toHaveLength(1); // never throws, reports
});

test('the trim seed is deterministic on one device and differs between devices for the same clientTripId', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const one = memoryStore();
  const s1 = await deviceTrimSeed(id, one);
  expect(await deviceTrimSeed(id, one)).toBe(s1);
  resetDeviceSecretForTests();
  const two = memoryStore();
  const s2 = await deviceTrimSeed(id, two);
  expect(s2).not.toBe(s1);
  expect(trimPlan(s1, [])).toEqual(trimPlan(s1, []));
  expect(trimPlan(s1, [])).not.toEqual(trimPlan(s2, []));
  // The seed is not the clientTripId or anything computable from the upload alone.
  expect(s1).not.toContain(id);
});
