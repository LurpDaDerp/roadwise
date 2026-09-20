import * as aesjs from 'aes-js';
import * as SecureStore from 'expo-secure-store';

import { LargeSecureStore } from '@/data/supabase/largeSecureStore';

// `jest.mock` is hoisted above these imports, and the maps are only read from inside the mocked
// functions, so they are initialised by the time any of them runs.
const mockSecure = new Map<string, string>();
const mockAsync = new Map<string, string>();
// Injects a keychain read failure - a locked device, a busy Keystore - without deleting anything.
const mockSecureFailure: { read?: Error } = {};
const mockKeychainOptions: unknown[] = [];
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async (k: string) => {
    if (mockSecureFailure.read) throw mockSecureFailure.read;
    return mockSecure.get(k) ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string, options?: { keychainAccessible?: unknown }) => {
    mockKeychainOptions.push(options?.keychainAccessible);
    mockSecure.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => { mockSecure.delete(k); }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockAsync.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => { mockAsync.set(k, v); }),
  removeItem: jest.fn(async (k: string) => { mockAsync.delete(k); }),
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => i) }));

beforeEach(() => {
  mockSecure.clear();
  mockAsync.clear();
  mockKeychainOptions.length = 0;
  delete mockSecureFailure.read;
});

test('round-trips a value larger than 2048 bytes and keeps only ciphertext in AsyncStorage', async () => {
  const store = new LargeSecureStore();
  const big = JSON.stringify({ access_token: 'x'.repeat(5000) });
  await store.setItem('session', big);

  const stored = mockAsync.get('session');
  expect(stored).toBeDefined();
  // Not merely an encoding of the plaintext: the bytes behind the stored hex differ from the
  // plaintext's own bytes, which hex or base64 of the same string would not.
  expect(Array.from(aesjs.utils.hex.toBytes(stored as string))).not.toEqual(
    Array.from(aesjs.utils.utf8.toBytes(big))
  );

  // The key lives in SecureStore only - a 32-byte AES key as 64 hex chars, never in AsyncStorage.
  const key = mockSecure.get('session');
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(stored).not.toContain(key as string);
  // Readable after the first unlock, so a background drive-detection launch can still open it.
  expect(mockKeychainOptions).toEqual([SecureStore.AFTER_FIRST_UNLOCK]);

  expect(await store.getItem('session')).toBe(big);

  await store.removeItem('session');
  expect(mockAsync.has('session')).toBe(false);
  expect(mockSecure.has('session')).toBe(false);
  expect(await store.getItem('session')).toBeNull();
});

test('round-trips non-BMP characters, so an emoji display name survives a cold start', async () => {
  const store = new LargeSecureStore();
  // aes-js decodes at most 3 bytes per character, which mangles any astral-plane codepoint and
  // would corrupt the session JSON of anyone whose Google display name carries an emoji.
  const value = JSON.stringify({ user: { display_name: 'Ava 🚗', note: 'clef 𝄞 ok' } });
  await store.setItem('session', value);

  expect(await store.getItem('session')).toBe(value);
});

test('keeps both halves when the keychain read fails, and recovers on the next read', async () => {
  const store = new LargeSecureStore();
  await store.setItem('session', 'a session');
  const blob = mockAsync.get('session');
  const key = mockSecure.get('session');

  // errSecInteractionNotAllowed: the JS runtime started while the device was locked, which happens
  // on a background drive-detection launch. That is transient, not corruption.
  mockSecureFailure.read = new Error('errSecInteractionNotAllowed');
  await expect(store.getItem('session')).resolves.toBeNull();
  expect(mockAsync.get('session')).toBe(blob);
  expect(mockSecure.get('session')).toBe(key);

  // Nothing was thrown away, so the next unlocked read still has the user signed in.
  delete mockSecureFailure.read;
  expect(await store.getItem('session')).toBe('a session');
});

test('self-heals when the encryption key is gone, rather than throwing', async () => {
  const store = new LargeSecureStore();
  await store.setItem('session', 'a session');
  // A reinstall or a Keychain reset drops the key while the ciphertext survives.
  mockSecure.delete('session');

  await expect(store.getItem('session')).resolves.toBeNull();
  expect(mockAsync.has('session')).toBe(false);
});

test('self-heals when the stored blob is corrupt, rather than throwing', async () => {
  const store = new LargeSecureStore();
  await store.setItem('session', 'a session');
  mockAsync.set('session', 'not hex at all');

  await expect(store.getItem('session')).resolves.toBeNull();
  expect(mockAsync.has('session')).toBe(false);
  expect(mockSecure.has('session')).toBe(false);
});
