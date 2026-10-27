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
// Each call answers different bytes (a running seed), as real randomness would.
const mockRandom = { seed: 0 };
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => {
    mockRandom.seed += 1;
    return Uint8Array.from({ length: n }, (_, i) => (i * 7 + mockRandom.seed * 31) % 256);
  },
}));
// A failed blob write: the keychain half already happened.
const mockAsyncFailure: { write?: Error } = {};
const asyncStorage = jest.requireMock<{ setItem: jest.Mock }>('@react-native-async-storage/async-storage');

beforeEach(() => {
  mockSecure.clear();
  mockAsync.clear();
  mockKeychainOptions.length = 0;
  delete mockSecureFailure.read;
  delete mockAsyncFailure.write;
  asyncStorage.setItem.mockImplementation(async (k: string, v: string) => {
    if (mockAsyncFailure.write) throw mockAsyncFailure.write;
    mockAsync.set(k, v);
  });
});

/** A blob as a build before `v2:` wrote it: a fresh key per save, the fixed counter 1. */
function legacySave(key: string, value: string): void {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256);
  const cipher = new aesjs.ModeOfOperation.ctr(raw, new aesjs.Counter(1));
  mockSecure.set(key, aesjs.utils.hex.fromBytes(raw));
  mockAsync.set(key, aesjs.utils.hex.fromBytes(cipher.encrypt(aesjs.utils.utf8.toBytes(value))));
}

test('round-trips a value larger than 2048 bytes and keeps only ciphertext in AsyncStorage', async () => {
  const store = new LargeSecureStore();
  const big = JSON.stringify({ access_token: 'x'.repeat(5000) });
  await store.setItem('session', big);

  const stored = mockAsync.get('session');
  expect(stored).toMatch(/^v2:[0-9a-f]+$/);
  // Not merely an encoding of the plaintext: the bytes behind the stored hex differ from the
  // plaintext's own bytes, which hex or base64 of the same string would not.
  expect(Array.from(aesjs.utils.hex.toBytes((stored as string).slice(3 + 32)))).not.toEqual(
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

test('a session saved by an older build still reads, and the next save keeps its key in the new form', async () => {
  legacySave('session', 'an old session 🚗');
  const key = mockSecure.get('session');
  const store = new LargeSecureStore();
  expect(await store.getItem('session')).toBe('an old session 🚗');
  await store.setItem('session', 'refreshed');
  expect(mockSecure.get('session')).toBe(key);
  expect(mockKeychainOptions).toEqual([]);
  expect(mockAsync.get('session')).toMatch(/^v2:/);
  expect(await store.getItem('session')).toBe('refreshed');
});

test('a save cut short leaves the last session readable; every save draws a fresh counter under the one key', async () => {
  const store = new LargeSecureStore();
  await store.setItem('session', 'first');
  const key = mockSecure.get('session');
  const firstBlob = mockAsync.get('session') as string;
  await store.setItem('session', 'second');
  expect(mockSecure.get('session')).toBe(key);
  expect((mockAsync.get('session') as string).slice(0, 3 + 32)).not.toBe(firstBlob.slice(0, 3 + 32));
  // The blob write fails (a kill, a full disk): the key was not touched, so the last blob still reads.
  mockAsyncFailure.write = new Error('disk full');
  await expect(store.setItem('session', 'third')).rejects.toThrow('disk full');
  expect(await store.getItem('session')).toBe('second');
  expect(mockKeychainOptions).toEqual([SecureStore.AFTER_FIRST_UNLOCK]);
});

test('a save while the keychain cannot be read fails rather than minting a key over the one the blob needs', async () => {
  const store = new LargeSecureStore();
  await store.setItem('session', 'a session');
  mockSecureFailure.read = new Error('errSecInteractionNotAllowed');
  await expect(store.setItem('session', 'refreshed')).rejects.toThrow('errSecInteractionNotAllowed');
  delete mockSecureFailure.read;
  expect(await store.getItem('session')).toBe('a session');
});
