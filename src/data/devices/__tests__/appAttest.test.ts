/** @jest-environment node */
import {
  APP_ATTEST_FUNCTION,
  APP_ATTEST_STORE_KEY,
  ATTEST_ASSERTION_HEADER,
  ATTEST_HEADER,
  ATTEST_KEY_HEADER,
  createAppAttest,
  INVALID_KEY_CODE,
  MAX_ATTESTATIONS_PER_DAY,
  type AppIntegrityNative,
  type AttestKeyStore,
} from '@/data/devices/appAttest';

const T0 = Date.UTC(2026, 9, 27, 15, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CHALLENGE = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';
const keyIdOf = (n: number) => `${String(n).padStart(43, 'K')}=`;
/** The short name the fake writes for a key: k1, k2, ... */
const label = (keyId: string) => `k${Number(keyId.replace(/[K=]/g, ''))}`;

/** A Secure Enclave stand-in: numbered keys, an assertion names its key, body and counter. */
function fakeNative(opts: { supported?: boolean } = {}) {
  const calls: string[] = [];
  let made = 0;
  const lost = new Set<string>();
  const counters = new Map<string, number>();
  let attestFails = false;
  const native: AppIntegrityNative = {
    isSupported: opts.supported ?? true,
    async generateKeyAsync() {
      made += 1;
      calls.push(`generate ${made}`);
      return keyIdOf(made);
    },
    async attestKeyAsync(keyId, challenge) {
      calls.push(`attest ${label(keyId)} ${challenge === CHALLENGE ? 'challenge' : challenge}`);
      if (attestFails) throw Object.assign(new Error('Server unavailable'), { code: 'ERR_APP_INTEGRITY_SERVER_UNAVAILABLE' });
      return `attestation-of-${keyId}`;
    },
    async generateAssertionAsync(keyId, body) {
      if (lost.has(keyId)) throw Object.assign(new Error('Invalid key provided'), { code: INVALID_KEY_CODE });
      const n = (counters.get(keyId) ?? 0) + 1;
      counters.set(keyId, n);
      calls.push(`assert ${label(keyId)} ${n}`);
      return `assertion(${label(keyId)},${n},${body})`;
    },
  };
  return {
    native,
    calls,
    lose: (keyId: string) => lost.add(keyId),
    failAttest: (v: boolean) => {
      attestFails = v;
    },
  };
}

function fakeStore(): AttestKeyStore & { items: Map<string, string>; options: unknown[] } {
  const items = new Map<string, string>();
  const options: unknown[] = [];
  return {
    items,
    options,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    async getItemAsync(key, o) {
      options.push(o);
      return items.get(key) ?? null;
    },
    async setItemAsync(key, value, o) {
      options.push(o);
      items.set(key, value);
    },
  };
}

/** The app-attest function: a challenge, then `attested` (or what `answer` says). */
function fakeServer() {
  const asked: { action: string; keyId?: string }[] = [];
  let answer: 'attested' | 'refused' | 'down' = 'attested';
  const invoke = async (name: string, { body }: { body: unknown }) => {
    expect(name).toBe(APP_ATTEST_FUNCTION);
    const b = body as { action: string; keyId?: string; attestation?: string; challenge?: string };
    asked.push({ action: b.action, ...(b.keyId ? { keyId: b.keyId } : {}) });
    if (answer === 'down') return { data: null, error: { name: 'FunctionsFetchError' } };
    if (b.action === 'challenge') return { data: { challenge: CHALLENGE }, error: null };
    expect(b).toEqual({ action: 'attest', keyId: b.keyId, attestation: `attestation-of-${b.keyId}`, challenge: CHALLENGE });
    return answer === 'attested' ? { data: { status: 'attested' }, error: null } : { data: null, error: { name: 'FunctionsHttpError', context: { status: 400 } } };
  };
  return {
    invoke,
    asked,
    answer: (a: typeof answer) => {
      answer = a;
    },
  };
}

function setup(opts: { platform?: string; supported?: boolean; native?: 'missing' } = {}) {
  const native = fakeNative({ supported: opts.supported });
  const store = fakeStore();
  const server = fakeServer();
  let clock = T0;
  const errors: string[] = [];
  const attest = createAppAttest({
    platform: opts.platform ?? 'ios',
    native: () => (opts.native === 'missing' ? null : native.native),
    store,
    invoke: server.invoke,
    now: () => clock,
    onError: (_e, context) => errors.push(context),
  });
  return { attest, native, store, server, errors, advance: (ms: number) => (clock += ms) };
}

const BODY = '{"v":5,"clientTripId":"x"}';

test('the first upload attests a key (challenge, Apple, the server) and signs its exact body; later ones only sign', async () => {
  const s = setup();
  const first = await s.attest.prove('user-1', BODY);
  expect(first).toEqual({ keyId: keyIdOf(1), headers: { [ATTEST_KEY_HEADER]: keyIdOf(1), [ATTEST_ASSERTION_HEADER]: `assertion(k1,1,${BODY})` } });
  expect(s.server.asked).toEqual([{ action: 'challenge' }, { action: 'attest', keyId: keyIdOf(1) }]);
  expect(s.native.calls).toEqual(['generate 1', 'attest k1 challenge', 'assert k1 1']);
  const second = await s.attest.prove('user-1', '{"v":5,"clientTripId":"y"}');
  expect(second.headers[ATTEST_ASSERTION_HEADER]).toBe('assertion(k1,2,{"v":5,"clientTripId":"y"})');
  expect(s.server.asked).toHaveLength(2);
  // kept in the keychain for this device only
  expect(JSON.parse(s.store.items.get(APP_ATTEST_STORE_KEY)!)).toEqual({ owner: 'user-1', keyId: keyIdOf(1), attested: true, tries: [T0] });
  expect(new Set(s.store.options.map((o) => JSON.stringify(o)))).toEqual(new Set([JSON.stringify({ keychainAccessible: 'afterFirstUnlockThisDeviceOnly' })]));
  expect(s.errors).toEqual([]);
});

test('another account on the same install gets its own key', async () => {
  const s = setup();
  await s.attest.prove('user-1', BODY);
  const other = await s.attest.prove('user-2', BODY);
  expect(other.keyId).toBe(keyIdOf(2));
  expect(JSON.parse(s.store.items.get(APP_ATTEST_STORE_KEY)!)).toMatchObject({ owner: 'user-2', keyId: keyIdOf(2), attested: true });
});

test('Android, and a binary without the module, send no header; a phone without App Attest says so', async () => {
  for (const s of [setup({ platform: 'android' }), setup({ native: 'missing' })]) {
    expect(await s.attest.prove('user-1', BODY)).toEqual({ headers: {}, keyId: null });
    expect(await s.attest.recover('user-1', { headers: {}, keyId: null })).toBe(false);
    expect(s.server.asked).toEqual([]);
  }
  const sim = setup({ supported: false });
  expect(await sim.attest.prove('user-1', BODY)).toEqual({ headers: { [ATTEST_HEADER]: 'unsupported' }, keyId: null });
  expect(sim.server.asked).toEqual([]);
  expect(sim.native.calls).toEqual([]);
});

test('a key that cannot be attested now leaves the upload unattested, silently; a server with no challenge costs no attestation', async () => {
  const s = setup();
  s.server.answer('down');
  expect(await s.attest.prove('user-1', BODY)).toEqual({ headers: { [ATTEST_HEADER]: 'unattested' }, keyId: null });
  expect(s.native.calls).toEqual([]);
  s.server.answer('refused');
  expect(await s.attest.prove('user-1', BODY)).toEqual({ headers: { [ATTEST_HEADER]: 'unattested' }, keyId: null });
  s.server.answer('attested');
  s.native.failAttest(true);
  expect((await s.attest.prove('user-1', BODY)).keyId).toBeNull();
  expect(s.errors).toEqual(['app attest']);
  s.native.failAttest(false);
  expect((await s.attest.prove('user-1', BODY)).keyId).toBe(keyIdOf(3));
});

test('attestations are capped at 3 a rolling day: nothing loops', async () => {
  const s = setup();
  s.server.answer('refused');
  for (let n = 0; n < 6; n += 1) await s.attest.prove('user-1', BODY);
  expect(s.native.calls.filter((c) => c.startsWith('attest'))).toHaveLength(MAX_ATTESTATIONS_PER_DAY);
  s.server.answer('attested');
  expect((await s.attest.prove('user-1', BODY)).headers).toEqual({ [ATTEST_HEADER]: 'unattested' });
  s.advance(DAY);
  expect((await s.attest.prove('user-1', BODY)).keyId).toBe(keyIdOf(4));
});

test('a key the phone no longer holds (a reinstall) is replaced at once and the upload still signed', async () => {
  const s = setup();
  await s.attest.prove('user-1', BODY);
  s.native.lose(keyIdOf(1));
  const proof = await s.attest.prove('user-1', BODY);
  expect(proof).toEqual({ keyId: keyIdOf(2), headers: { [ATTEST_KEY_HEADER]: keyIdOf(2), [ATTEST_ASSERTION_HEADER]: `assertion(k2,1,${BODY})` } });
  expect(s.errors).toEqual([]);
});

test('recover: a key the server refused is dropped and a fresh one attested, within the budget', async () => {
  const s = setup();
  const refused = await s.attest.prove('user-1', BODY);
  expect(await s.attest.recover('user-1', refused)).toBe(true);
  const again = await s.attest.prove('user-1', BODY);
  expect(again.keyId).toBe(keyIdOf(2));
  // a refused unattested upload: attest now
  const t = setup();
  t.server.answer('down');
  const unattested = await t.attest.prove('user-1', BODY);
  t.server.answer('attested');
  expect(await t.attest.recover('user-1', unattested)).toBe(true);
  // the budget spent: no fresh key, no retry now
  const u = setup();
  let proof = await u.attest.prove('user-1', BODY);
  for (let n = 1; n < MAX_ATTESTATIONS_PER_DAY; n += 1) {
    expect(await u.attest.recover('user-1', proof)).toBe(true);
    proof = await u.attest.prove('user-1', BODY);
  }
  expect(await u.attest.recover('user-1', proof)).toBe(false);
  expect(u.native.calls.filter((c) => c.startsWith('attest'))).toHaveLength(MAX_ATTESTATIONS_PER_DAY);
});

test('two uploads at once attest one key, and sign in turn', async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.attest.prove('user-1', 'a'), s.attest.prove('user-1', 'b')]);
  expect([a.keyId, b.keyId]).toEqual([keyIdOf(1), keyIdOf(1)]);
  expect(s.native.calls).toEqual(['generate 1', 'attest k1 challenge', 'assert k1 1', 'assert k1 2']);
});

test('a kept record that does not parse is no key', async () => {
  const s = setup();
  s.store.items.set(APP_ATTEST_STORE_KEY, '{not json');
  expect((await s.attest.prove('user-1', BODY)).keyId).toBe(keyIdOf(1));
  s.store.items.set(APP_ATTEST_STORE_KEY, JSON.stringify({ owner: 'user-1', keyId: 'bad', attested: true, tries: ['x'] }));
  expect((await s.attest.prove('user-1', BODY)).keyId).toBe(keyIdOf(2));
});
