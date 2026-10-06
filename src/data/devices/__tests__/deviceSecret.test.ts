import { clearDeviceSecret, DEVICE_SECRET_KEY, deviceTrimSeed, getDeviceSecret, resetDeviceSecretForTests, type SecretStore } from '@/data/devices/deviceSecret';
import { trimPlan } from '@/core/engine/privacy';
import { hmacSha256Hex, sha256Hex } from '@/lib/sha256';

function memoryStore(): SecretStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => void items.set(k, v),
    deleteItemAsync: async (k) => void items.delete(k),
  };
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
