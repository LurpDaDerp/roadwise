import { LargeSecureStore } from '@/data/supabase/largeSecureStore';

// `jest.mock` is hoisted above these imports, and the maps are only read from inside the mocked
// functions, so they are initialised by the time any of them runs.
const mockSecure = new Map<string, string>();
const mockAsync = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockSecure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockSecure.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockSecure.delete(k); }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockAsync.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => { mockAsync.set(k, v); }),
  removeItem: jest.fn(async (k: string) => { mockAsync.delete(k); }),
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => i) }));

test('round-trips a value larger than 2048 bytes and stores ciphertext', async () => {
  const store = new LargeSecureStore();
  const big = 'x'.repeat(5000);
  await store.setItem('session', big);
  expect(mockAsync.get('session')).not.toContain('xxxx');
  expect(await store.getItem('session')).toBe(big);
  await store.removeItem('session');
  expect(await store.getItem('session')).toBeNull();
});
