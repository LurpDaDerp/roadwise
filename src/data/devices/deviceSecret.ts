/**
 * The device secret: 32 random bytes, generated once and kept in SecureStore, never uploaded or
 * logged. It keys the per-drive privacy trim (`HMAC-SHA256(secret, clientTripId)`), so nobody who
 * sees an upload — the `clientTripId` is in it — can recompute where a route was cut and undo the
 * jitter (security audit). Removed with the account (`clearDeviceSecret` from the wipe).
 */
import { hmacSha256Hex, toHex } from '@/lib/sha256';

export const DEVICE_SECRET_KEY = 'roadwise.deviceSecret';
export const DEVICE_SECRET_BYTES = 32;

/** The slice of expo-secure-store this uses (or a test's stand-in). */
export interface SecretStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  // `react-native-get-random-values` polyfills this on the device; Node and Jest have it natively.
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
    const stored = await store.getItemAsync(DEVICE_SECRET_KEY);
    if (typeof stored === 'string' && HEX_64.test(stored)) {
      cached = stored;
      return stored;
    }
    const fresh = randomHex(DEVICE_SECRET_BYTES);
    await store.setItemAsync(DEVICE_SECRET_KEY, fresh);
    cached = fresh;
    return fresh;
  });
  lock = run.catch(() => {});
  return run;
}

/** Account deletion / handover: the secret goes with everything else. Never throws. */
export async function clearDeviceSecret(store: SecretStore = defaultStore()): Promise<void> {
  cached = null;
  try {
    await store.deleteItemAsync(DEVICE_SECRET_KEY);
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
