/**
 * The device secret: 32 random bytes, generated once and kept in SecureStore, never uploaded or
 * logged. It keys the per-drive privacy trim (`HMAC-SHA256(secret, clientTripId)`), so nobody who
 * sees an upload — the `clientTripId` is in it — can recompute where a route was cut and undo the
 * jitter (security audit). Removed with the account (`clearDeviceSecret` from the wipe).
 */
import { hmacSha256Hex, toHex } from '@/lib/sha256';

// The device has no `crypto.getRandomValues` of its own (Hermes): this file loads the polyfill
// itself rather than relying on whoever imported the Supabase client first. Node and Jest have it.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a side-effect polyfill
  require('react-native-get-random-values');
}

export const DEVICE_SECRET_KEY = 'roadwise.deviceSecret';
export const DEVICE_SECRET_BYTES = 32;

export interface SecretStoreOptions {
  keychainAccessible?: unknown;
}

/** The slice of expo-secure-store this uses (or a test's stand-in). */
export interface SecretStore {
  getItemAsync(key: string, options?: SecretStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecretStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecretStoreOptions): Promise<void>;
  /** expo-secure-store's keychain constant; a stand-in without it gets no options. */
  AFTER_FIRST_UNLOCK?: unknown;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The keychain class for the secret: readable after the first unlock since boot, so a locked-phone
 * auto-end or a background recovery can still finalize (the default, WHEN_UNLOCKED, cannot be read
 * while the screen is locked). Backed by the in-process cache, preloaded at bootstrap.
 */
const options = (store: SecretStore): SecretStoreOptions | undefined =>
  store.AFTER_FIRST_UNLOCK === undefined ? undefined : { keychainAccessible: store.AFTER_FIRST_UNLOCK };

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return toHex(out);
}

function defaultStore(): SecretStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module, loaded on first use
  return require('expo-secure-store') as SecretStore;
}

/** One at a time, so two first calls cannot mint two secrets. */
let lock: Promise<unknown> = Promise.resolve();
/** Read once per process; a wipe clears it. */
let cached: string | null = null;

/** The secret as 64 hex characters, made on first use. */
export function getDeviceSecret(store: SecretStore = defaultStore()): Promise<string> {
  const run = lock.then(async () => {
    if (cached !== null) return cached;
    const stored = await store.getItemAsync(DEVICE_SECRET_KEY, options(store));
    if (typeof stored === 'string' && HEX_64.test(stored)) {
      cached = stored;
      return stored;
    }
    const fresh = randomHex(DEVICE_SECRET_BYTES);
    await store.setItemAsync(DEVICE_SECRET_KEY, fresh, options(store));
    cached = fresh;
    return fresh;
  });
  lock = run.catch(() => {});
  return run;
}

/**
 * Bootstrap: read (or mint) the secret while the phone is in hand, so a later finalize — a
 * locked-phone auto-end, a background recovery — takes it from memory. Never throws.
 */
export async function preloadDeviceSecret(store?: SecretStore, onError?: (e: unknown) => void): Promise<void> {
  try {
    await getDeviceSecret(store);
  } catch (e) {
    onError?.(e);
  }
}

/** Account deletion / handover: the secret goes with everything else. Never throws. */
export async function clearDeviceSecret(store: SecretStore = defaultStore()): Promise<void> {
  cached = null;
  try {
    await store.deleteItemAsync(DEVICE_SECRET_KEY, options(store));
  } catch {
    // Nothing stored, or no store (Jest): nothing to clear.
  }
}

/** The per-drive trim seed: HMAC-SHA256(secret, clientTripId), hex. Never uploaded or logged. */
export async function deviceTrimSeed(clientTripId: string, store?: SecretStore): Promise<string> {
  return hmacSha256Hex(await getDeviceSecret(store), clientTripId);
}

/** Tests only. */
export function resetDeviceSecretForTests(): void {
  cached = null;
}
