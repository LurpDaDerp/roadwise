import { ctr } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils';
import { sha256 } from '@noble/hashes/sha2';
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
// Each call answers different bytes (a running seed), as real randomness would, unless a test
// queues the exact bytes the next calls answer.
const mockRandom: { seed: number; next: Uint8Array[] } = { seed: 0, next: [] };
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => {
    const queued = mockRandom.next.shift();
    if (queued) return queued;
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
  mockRandom.next.length = 0;
  delete mockSecureFailure.read;
  delete mockAsyncFailure.write;
  asyncStorage.setItem.mockImplementation(async (k: string, v: string) => {
    if (mockAsyncFailure.write) throw mockAsyncFailure.write;
    mockAsync.set(k, v);
  });
});

/**
 * Blobs exactly as earlier builds wrote them with aes-js 3.1.2 (`ModeOfOperation.ctr`, `Counter`,
 * `utils.utf8.toBytes`, `utils.hex.fromBytes`), captured before the switch to @noble/ciphers. Every
 * signed-in user's session is stored in one of these two forms, so they must keep reading, and a
 * save must keep writing the same bytes for the same key and counter.
 */
const KEY_A = '05121f2c394653606d7a8794a1aebbc8d5e2effc091623303d4a5764717e8b98';
const KEY_B = 'fff8f1eae3dcd5cec7c0b9b2aba49d968f88817a736c655e575049423b342d26';
const COUNTER_1 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const SESSION = JSON.stringify({
  access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1793491200,
  refresh_token: 'r3fr3sh-t0k3n',
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'ava@example.com', user_metadata: { full_name: 'Ava Lee' } },
});
const ASTRAL = 'Ava 🚗 clef 𝄞 ok, café, 日本, 👩‍👩‍👧';
/** 5,000 short records with an emoji and an accent each: 78,890 UTF-8 bytes, over 64 KiB. */
const BIG = Array.from({ length: 5000 }, (_, i) => `${i}:ok 🚗 é;`).join('');
const ZEROS_64 = '\0'.repeat(64);

type Vector = { name: string; key: string; plaintext: string; blob: string };
const V2_VECTORS: Vector[] = [
  { name: 'ASCII', key: KEY_A, plaintext: 'a session', blob: `v2:${COUNTER_1}690eb594e1d282bf8b` },
  {
    name: 'a JSON session',
    key: KEY_B,
    plaintext: SESSION,
    blob:
      `v2:${COUNTER_1}` +
      'c056c6332f6efa738b987bd530fac01e71b7fd2f2fa74d84610372fce1237b448b16dbe14053cf0ee32b288c3f91b3526b95b643a9cdd5dd759d06fafc4a032518bee772107b0e902276449ed1070668bf68430e2bc31fca28b859959e79bd8764a87a457049ee92e8b3b91728d3dfcc26b29621068c9c60fa36775ee9155a4d3cdc48bfdf441686e8382fc2f63b004bcdfa52ec7273feed5e5dc41b2976e5acab3345a863e9b11d7db1091449e1801f75c5c0557e859c1d372463e71f754fe2aa0bc7912d8ca117dd12e229e3c92c643454a88e61b798d380682168a14644fb2aea8e7285c962cc7269bed0751ec26ab452d6169ce170a0981a2a5648f99e5d7cdd681a7cbb85229c521f9683c9d6bae42218288ac2d0193194a8c3e4fc257a1933',
  },
  {
    name: 'astral-plane text',
    key: KEY_A,
    plaintext: ASTRAL,
    blob: 'v2:00112233445566778899aabbccddeeff0e09318a66cd1ac04efb72daa319efad8c0c7a35d8f294c643f9de08b5f7aa336f568831867b9604a2e09eacad522d2cdde62df7a4dd63ae',
  },
  { name: 'the empty string', key: KEY_A, plaintext: '', blob: `v2:${COUNTER_1}` },
  // Four blocks of keystream from counters that carry across the 32-bit, the 64-bit and the full
  // 128-bit boundary (...fffe, ...ffff, then the carry): the counter is one 128-bit big-endian
  // number, not a 32- or 64-bit word.
  {
    name: 'a counter carrying past 2^32',
    key: KEY_A,
    plaintext: ZEROS_64,
    blob: 'v2:000000000000000000000000fffffffe70c850d4b1afbbac716398459b904914870cd7fc66ac6cdcb0ad99aea4b3c42552a527934a8390ac030a47c0f7e8458cc092f712e594b8686035c4ef1adfd9f1',
  },
  {
    name: 'a counter carrying past 2^64',
    key: KEY_A,
    plaintext: ZEROS_64,
    blob: 'v2:0000000000000000fffffffffffffffe28c26962f4f99a0ee8be0b733ead36230d1ef8f0b1e3ee965af3ee1d8293163e4073dea692f31cd56a1fe0aa6b1f27a588aaa180a28cd908aadd2a6a5458545a',
  },
  {
    name: 'a counter wrapping past 2^128',
    key: KEY_A,
    plaintext: ZEROS_64,
    blob: 'v2:fffffffffffffffffffffffffffffffe78f6e518d6350b336479ec242a5d8e4a83439b639450f0469e4955dab506f56be9c6078cde32bf88de9c10c341145bdc23b7d458d9258d0c7e74079a6c9665b4',
  },
];
/** The pre-`v2:` form: the ciphertext hex alone, from the fixed counter 1. */
const LEGACY_VECTORS: Vector[] = [
  { name: 'ASCII', key: KEY_A, plaintext: 'a session', blob: '4297a73daa56e46310' },
  {
    name: 'a JSON session',
    key: KEY_B,
    plaintext: SESSION,
    blob: 'eca9e4737dfbaed05c88cc566edce6352c1de2025bcf41354bbb43844abad4c26e32c74164830503b0a0a762cbca78affc02d61dbff8e7c193237d7a9d0dfca838fec45e1c1ed4113f919638f72ae495cb94d36ae6989743ac4cd7303c939546357b25eb954c577822adb2ea93f526d9be7200695c81e37076d77dd941ee7c69ec31adef359e4491dbd100d5a678ccaf7086a4868a3a9de6afb53984b0db4d171350847d6df056c74238a3aa98267c34fc823af45112e502af8ef4380bc3b299767d48707859687f1b54027d607cfa6f9ccc41128da5f10bf83e0829d565cfd11be74082ced16077a744239b3a670a5f067fbbd8e722f9964db4ea871d52ac11953c7012eb0b8c17555d9389a88773360bb5eeb1b95f0c33b0549f2542dece2ac9a2',
  },
  {
    name: 'astral-plane text',
    key: KEY_A,
    plaintext: ASTRAL,
    blob: '62c1b57829ba179b5e176bff0ab695297e9b91d6aa7cbe8154199fc6de3071947e3807c2d7163bac2d60001e38e15bc7249a318583f612be',
  },
];
/** The over-64-KiB value's blobs from aes-js, as SHA-256 of the stored string (v2 from BIG_COUNTER; pre-v2). */
const BIG_COUNTER = 'a5a5a5a5a5a5a5a5a5a5a5a5ffffff00';
const BIG_V2_SHA256 = '5ecdf42bbc7f73b48265f730c1fc470f102662850808588e6f192ab1a8908a9d';
const BIG_LEGACY_SHA256 = '5a0770e31605377c57e3230496b222787d4f3571c947546dbd9de9fa9de738dd';
const sha256Hex = (blob: string): string => bytesToHex(sha256(Uint8Array.from(blob, (c) => c.charCodeAt(0))));
/** The fixed counter of the pre-`v2:` form: 128-bit big-endian 1 (15 zero bytes, then 1). */
const COUNTER_ONE = Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? 1 : 0));
/** UTF-8 written out by codepoint, independent of the store's own encoder. */
function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** A blob as a build before `v2:` wrote it: a fresh key per save, the fixed counter 1. */
function legacySave(key: string, value: string): void {
  mockSecure.set(key, KEY_A);
  mockAsync.set(key, bytesToHex(ctr(hexToBytes(KEY_A), COUNTER_ONE).encrypt(utf8(value))));
}

describe.each(V2_VECTORS)('a v2 blob written by aes-js: $name', ({ key, plaintext, blob }) => {
  test('reads back', async () => {
    mockSecure.set('session', key);
    mockAsync.set('session', blob);
    expect(await new LargeSecureStore().getItem('session')).toBe(plaintext);
  });

  test('is byte for byte what a save writes for the same key and counter', async () => {
    mockSecure.set('session', key);
    mockRandom.next.push(hexToBytes(blob.slice(3, 3 + 32)));
    await new LargeSecureStore().setItem('session', plaintext);
    expect(mockAsync.get('session')).toBe(blob);
    expect(mockSecure.get('session')).toBe(key);
    expect(mockKeychainOptions).toEqual([]);
  });
});

describe.each(LEGACY_VECTORS)('a pre-v2 blob written by aes-js: $name', ({ key, plaintext, blob }) => {
  test('reads back', async () => {
    mockSecure.set('session', key);
    mockAsync.set('session', blob);
    expect(await new LargeSecureStore().getItem('session')).toBe(plaintext);
  });

  test('is AES-256-CTR from the counter of 15 zero bytes then 1', () => {
    expect(bytesToHex(ctr(hexToBytes(key), COUNTER_ONE).encrypt(utf8(plaintext)))).toBe(blob);
  });
});

test('the 2^128 wrap lands on counter 0 then 1, so its fourth keystream block is the pre-v2 first block', () => {
  const wrap = V2_VECTORS.find((v) => v.name === 'a counter wrapping past 2^128') as Vector;
  const keystream = hexToBytes(wrap.blob.slice(3 + 32));
  const legacy = hexToBytes((LEGACY_VECTORS[0] as Vector).blob);
  expect(Array.from(legacy, (b, i) => b ^ (keystream[48 + i] as number))).toEqual(Array.from(utf8('a session')));
});

test('a value over 64 KiB is written as aes-js wrote it and reads back, in both forms', async () => {
  expect(utf8(BIG).length).toBe(78890);
  const store = new LargeSecureStore();
  mockSecure.set('session', KEY_B);
  mockRandom.next.push(hexToBytes(BIG_COUNTER));
  await store.setItem('session', BIG);
  const blob = mockAsync.get('session') as string;
  expect(blob.slice(0, 3 + 32)).toBe(`v2:${BIG_COUNTER}`);
  expect(sha256Hex(blob)).toBe(BIG_V2_SHA256);
  expect(await store.getItem('session')).toBe(BIG);

  const legacy = bytesToHex(ctr(hexToBytes(KEY_B), COUNTER_ONE).encrypt(utf8(BIG)));
  expect(sha256Hex(legacy)).toBe(BIG_LEGACY_SHA256);
  mockAsync.set('session', legacy);
  expect(await store.getItem('session')).toBe(BIG);
});

test('a string that is not valid Unicode fails the save rather than being stored altered', async () => {
  await expect(new LargeSecureStore().setItem('session', 'half a pair \ud83d')).rejects.toThrow(URIError);
  expect(mockAsync.has('session')).toBe(false);
});

test('round-trips a value larger than 2048 bytes and keeps only ciphertext in AsyncStorage', async () => {
  const store = new LargeSecureStore();
  const big = JSON.stringify({ access_token: 'x'.repeat(5000) });
  await store.setItem('session', big);

  const stored = mockAsync.get('session');
  expect(stored).toMatch(/^v2:[0-9a-f]+$/);
  // Not merely an encoding of the plaintext: the bytes behind the stored hex differ from the
  // plaintext's own bytes, which hex or base64 of the same string would not.
  expect(Array.from(hexToBytes((stored as string).slice(3 + 32)))).not.toEqual(Array.from(utf8(big)));

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
  // A decoder that reads at most 3 bytes per character mangles any astral-plane codepoint and
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
