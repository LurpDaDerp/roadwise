/**
 * App Attest (iPhone): proof that a drive upload comes from RoadWise on a real iPhone.
 *
 * Once per install and account, the app makes a key in the Secure Enclave (`generateKeyAsync`),
 * fetches a one-time challenge from `app-attest`, has Apple attest the key against
 * SHA256(challenge) (`attestKeyAsync`) and sends the attestation back; the server keeps the key.
 * After that, every `finalize-trip` upload carries the key id and an assertion over SHA256 of the
 * exact request body (`generateAssertionAsync(keyId, body)`), which the server checks before the
 * drive counts.
 *
 * All of it is silent: nothing is shown, asked or waited for on screen. A phone without App Attest
 * (a simulator) says so in a header; a key that could not be attested yet leaves the upload marked
 * `unattested`; Android sends nothing. When the server answers `attest_required`, `recover` drops a
 * key it refused and attests a fresh one, and the runner sends the drive again. Attestations are
 * capped at 3 an install in a rolling day, so nothing can loop.
 *
 * What is kept (SecureStore, this device only): the account the key was made for, its id (Apple's
 * hash of the public key, not a secret), whether the server accepted it, and when this install last
 * attested. Nothing here throws.
 */
export const APP_ATTEST_FUNCTION = 'app-attest';
export const APP_ATTEST_STORE_KEY = 'roadwise.appAttest';
/** At most this many attestations an install makes in a rolling day. */
export const MAX_ATTESTATIONS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The headers `finalize-trip` reads (`supabase/functions/finalize-trip/attest.ts`). */
export const ATTEST_HEADER = 'x-app-attest';
export const ATTEST_KEY_HEADER = 'x-app-attest-key';
export const ATTEST_ASSERTION_HEADER = 'x-app-attest-assertion';

/** `@expo/app-integrity`'s error code for a key the Secure Enclave no longer holds. */
export const INVALID_KEY_CODE = 'ERR_APP_INTEGRITY_INVALID_KEY';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9+/]{43}=$/;

/** The slice of `@expo/app-integrity` this uses (iOS). Each call hashes its string argument's UTF-8 with SHA-256. */
export interface AppIntegrityNative {
  isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
}

/** The slice of expo-secure-store this uses (or a test's stand-in). */
export interface AttestKeyStore {
  getItemAsync(key: string, options?: { keychainAccessible?: unknown }): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: unknown }): Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown;
}

export type Invoke = (name: string, options: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;

export interface AppAttestDeps {
  /** `Platform.OS`: only 'ios' attests. */
  platform: string;
  /** The native module, or null in a binary without it. */
  native: () => AppIntegrityNative | null;
  store: AttestKeyStore;
  /** `supabase.functions.invoke`. */
  invoke: Invoke;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

/** What an upload carries. */
export interface UploadProof {
  headers: Readonly<Record<string, string>>;
  /** The key the assertion was made with; null when there is none. */
  keyId: string | null;
}

export interface AppAttest {
  /** The App Attest headers for an upload of exactly `body` by `owner` (attesting a key first when there is none). */
  prove(owner: string, body: string): Promise<UploadProof>;
  /**
   * The server answered `attest_required` to an upload sent with `proof`: a key it refused is dropped
   * and a fresh one attested, within the day's budget. True when an attested key other than the
   * refused upload's is now in hand, so sending again now can pass.
   */
  recover(owner: string, proof: UploadProof): Promise<boolean>;
}

const NO_PROOF: UploadProof = { headers: {}, keyId: null };
const UNSUPPORTED: UploadProof = { headers: { [ATTEST_HEADER]: 'unsupported' }, keyId: null };
const UNATTESTED: UploadProof = { headers: { [ATTEST_HEADER]: 'unattested' }, keyId: null };

interface Kept {
  owner: string | null;
  keyId: string | null;
  attested: boolean;
  /** When this install asked Apple to attest a key, epoch ms (the last day's only). */
  tries: number[];
}

const EMPTY: Kept = { owner: null, keyId: null, attested: false, tries: [] };

function parseKept(raw: string | null): Kept {
  if (raw === null) return EMPTY;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      owner: typeof v.owner === 'string' ? v.owner : null,
      keyId: typeof v.keyId === 'string' && KEY_ID.test(v.keyId) ? v.keyId : null,
      attested: v.attested === true,
      tries: Array.isArray(v.tries) ? v.tries.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)) : [],
    };
  } catch {
    return EMPTY;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInvalidKey = (error: unknown): boolean => isRecord(error) && error.code === INVALID_KEY_CODE;

export function createAppAttest(deps: AppAttestDeps): AppAttest {
  const now = deps.now ?? Date.now;
  const report = (error: unknown, context: string): void => {
    try {
      deps.onError?.(error, context);
    } catch {
      // nobody left to tell
    }
  };
  const options = deps.store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY === undefined ? undefined : { keychainAccessible: deps.store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  const load = async (): Promise<Kept> => parseKept(await deps.store.getItemAsync(APP_ATTEST_STORE_KEY, options));
  const save = (kept: Kept): Promise<void> => deps.store.setItemAsync(APP_ATTEST_STORE_KEY, JSON.stringify(kept), options);

  /** One at a time, so two uploads never attest two keys or sign out of order. */
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn);
    lock = run.catch(() => {});
    return run;
  };

  function nativeModule(): AppIntegrityNative | null {
    if (deps.platform !== 'ios') return null;
    try {
      return deps.native();
    } catch (error) {
      report(error, 'app attest module');
      return null;
    }
  }

  async function challenge(): Promise<string | null> {
    const { data, error } = await deps.invoke(APP_ATTEST_FUNCTION, { body: { action: 'challenge' } });
    if (error || !isRecord(data) || typeof data.challenge !== 'string' || !CHALLENGE.test(data.challenge)) return null;
    return data.challenge;
  }

  /**
   * An attested key for `owner`: the kept one, or a fresh one attested now (the challenge first, so a
   * server that cannot give one costs no attestation; then Apple; then the server). Null when none
   * can be had now: the day's budget is spent, or a step failed.
   */
  async function attestedKey(native: AppIntegrityNative, owner: string): Promise<string | null> {
    const kept = await load();
    if (kept.owner === owner && kept.attested && kept.keyId !== null) return kept.keyId;
    const at = now();
    const tries = kept.tries.filter((t) => t <= at && at - t < DAY_MS);
    if (tries.length >= MAX_ATTESTATIONS_PER_DAY) return null;
    const fresh = await challenge();
    if (fresh === null) return null;
    const keyId = await native.generateKeyAsync();
    await save({ owner, keyId, attested: false, tries: [...tries, at] });
    const attestation = await native.attestKeyAsync(keyId, fresh);
    const { data, error } = await deps.invoke(APP_ATTEST_FUNCTION, { body: { action: 'attest', keyId, attestation, challenge: fresh } });
    if (error || !isRecord(data) || data.status !== 'attested') return null;
    await save({ owner, keyId, attested: true, tries: [...tries, at] });
    return keyId;
  }

  /** The kept key is no good (the Secure Enclave lost it, or the server refused it): the next upload attests a fresh one. */
  async function forget(keyId: string): Promise<void> {
    const kept = await load();
    if (kept.keyId === keyId) await save({ ...kept, keyId: null, attested: false });
  }

  async function assert(native: AppIntegrityNative, keyId: string, body: string): Promise<UploadProof> {
    const assertion = await native.generateAssertionAsync(keyId, body);
    return { headers: { [ATTEST_KEY_HEADER]: keyId, [ATTEST_ASSERTION_HEADER]: assertion }, keyId };
  }

  return {
    async prove(owner, body) {
      const native = nativeModule();
      if (native === null) return NO_PROOF;
      if (!native.isSupported) return UNSUPPORTED;
      return serial(async () => {
        try {
          const keyId = await attestedKey(native, owner);
          if (keyId === null) return UNATTESTED;
          try {
            return await assert(native, keyId, body);
          } catch (error) {
            if (!isInvalidKey(error)) throw error;
            // a reinstall or a restored backup: the kept id names a key this phone no longer holds
            await forget(keyId);
            const next = await attestedKey(native, owner);
            return next === null ? UNATTESTED : await assert(native, next, body);
          }
        } catch (error) {
          report(error, 'app attest');
          return UNATTESTED;
        }
      });
    },

    async recover(owner, proof) {
      const native = nativeModule();
      if (native === null || !native.isSupported) return false;
      return serial(async () => {
        try {
          if (proof.keyId !== null) await forget(proof.keyId);
          const keyId = await attestedKey(native, owner);
          return keyId !== null && keyId !== proof.keyId;
        } catch (error) {
          report(error, 'app attest');
          return false;
        }
      });
    },
  };
}

/** The app's App Attest, over the given client's functions. */
export function createDefaultAppAttest(invoke: Invoke, onError?: (error: unknown, context: string) => void): AppAttest {
  /* eslint-disable @typescript-eslint/no-require-imports -- native modules, loaded on first use */
  return createAppAttest({
    platform: (require('react-native') as typeof import('react-native')).Platform.OS,
    native: () => require('@expo/app-integrity') as AppIntegrityNative,
    store: require('expo-secure-store') as AttestKeyStore,
    invoke,
    onError,
  });
  /* eslint-enable @typescript-eslint/no-require-imports */
}
