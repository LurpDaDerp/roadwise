import { assert, assertEquals } from '@std/assert';
import { appIdHash, sha256Text, toHex, type AttestSettings } from '../_shared/appattest.ts';
import type { AttestStore, SaveKey, TakeChallenge } from '../_shared/appattest_store.ts';
import { fakeApple, makeAttestation } from '../_shared/appattest_testkit.ts';
import { PgError } from '../_shared/pg.ts';
import { CHALLENGE_PATTERN, handleAppAttest } from './handler.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const TEAM = 'ABCDE12345';
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const apple = await fakeApple(NOW);
const settings: AttestSettings = { rpIdHash: await appIdHash(TEAM), allowDevelopment: false, root: apple.root };

interface StoreCalls {
  issued: { userId: string; hash: string }[];
  taken: { userId: string; hash: string }[];
  saved: { userId: string; keyId: string; publicKey: string; environment: string }[];
}

function harness(opts: { issue?: boolean | Error; take?: TakeChallenge; save?: SaveKey; settings?: AttestSettings | null; auth?: 'down' } = {}) {
  const calls: StoreCalls = { issued: [], taken: [], saved: [] };
  const logs: unknown[][] = [];
  const store: AttestStore = {
    issueChallenge(userId, hash) {
      calls.issued.push({ userId, hash: toHex(hash) });
      return opts.issue instanceof Error ? Promise.reject(opts.issue) : Promise.resolve(opts.issue ?? true);
    },
    takeChallenge(userId, hash) {
      calls.taken.push({ userId, hash: toHex(hash) });
      return Promise.resolve(opts.take ?? 'taken');
    },
    saveKey(userId, keyId, publicKey, environment) {
      calls.saved.push({ userId, keyId, publicKey: toHex(publicKey), environment });
      return Promise.resolve(opts.save ?? 'saved');
    },
  };
  const deps = {
    verifyJwt: (token: string) => (opts.auth === 'down' ? Promise.reject(new Error('auth down')) : Promise.resolve(token === 'good' ? USER : null)),
    store,
    settings: opts.settings === undefined ? settings : opts.settings,
    now: () => NOW,
    random: (b: Uint8Array) => b.fill(0xab),
    log: { warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) },
  };
  return { calls, logs, deps };
}

const post = (body: unknown, token = 'good', method = 'POST') =>
  new Request('http://local/functions/v1/app-attest', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

Deno.test('a challenge: 32 random bytes in base64url, its SHA-256 kept for the caller', async () => {
  const h = harness();
  const res = await handleAppAttest(post({ action: 'challenge' }), h.deps);
  assertEquals(res.status, 200);
  const { challenge } = await res.json();
  assert(CHALLENGE_PATTERN.test(challenge));
  assertEquals(challenge, 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s');
  assertEquals(h.calls.issued, [{ userId: USER, hash: toHex(await sha256Text(challenge)) }]);
});

Deno.test('a challenge over the hourly budget is a 429 with Retry-After', async () => {
  const res = await handleAppAttest(post({ action: 'challenge' }), harness({ issue: false }).deps);
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { code: 'too_many_challenges' });
  assertEquals(res.headers.get('retry-after'), '3600');
});

const CHALLENGE = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';

Deno.test('an attestation: the challenge used up, Apple verified, the key stored for the caller', async () => {
  const h = harness();
  const made = await makeAttestation({ apple, teamId: TEAM, challenge: CHALLENGE, now: NOW });
  const res = await handleAppAttest(post({ action: 'attest', keyId: made.keyId, attestation: made.attestation, challenge: CHALLENGE }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: 'attested' });
  assertEquals(h.calls.taken, [{ userId: USER, hash: toHex(await sha256Text(CHALLENGE)) }]);
  assertEquals(h.calls.saved, [{ userId: USER, keyId: made.keyId, publicKey: toHex(made.point), environment: 'production' }]);
});

Deno.test('the same key again is attested (kept as it was); another account’s key is a 409', async () => {
  const made = await makeAttestation({ apple, teamId: TEAM, challenge: CHALLENGE, now: NOW });
  const body = { action: 'attest', keyId: made.keyId, attestation: made.attestation, challenge: CHALLENGE };
  assertEquals((await handleAppAttest(post(body), harness({ save: 'known' }).deps)).status, 200);
  const taken = await handleAppAttest(post(body), harness({ save: 'taken' }).deps);
  assertEquals(taken.status, 409);
  assertEquals(await taken.json(), { code: 'key_taken' });
});

Deno.test('an unknown, used or expired challenge is refused before anything is verified', async () => {
  const h = harness({ take: 'unknown' });
  const made = await makeAttestation({ apple, teamId: TEAM, challenge: CHALLENGE, now: NOW });
  const res = await handleAppAttest(post({ action: 'attest', keyId: made.keyId, attestation: made.attestation, challenge: CHALLENGE }), h.deps);
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { code: 'challenge_invalid' });
  assertEquals(h.calls.saved, []);
  const limited = await handleAppAttest(post({ action: 'attest', keyId: made.keyId, attestation: made.attestation, challenge: CHALLENGE }), harness({ take: 'limited' }).deps);
  assertEquals(limited.status, 429);
  assertEquals(await limited.json(), { code: 'too_many_attestations' });
});

Deno.test('an attestation that fails is a 400 with no detail; the reason goes to the log only', async () => {
  const h = harness();
  // attested against another challenge: the nonce does not match
  const made = await makeAttestation({ apple, teamId: TEAM, challenge: 'x'.repeat(43), now: NOW });
  const res = await handleAppAttest(post({ action: 'attest', keyId: made.keyId, attestation: made.attestation, challenge: CHALLENGE }), h.deps);
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { code: 'attestation_invalid' });
  assertEquals(h.calls.saved, []);
  assertEquals(h.logs.length, 1);
  assertEquals((h.logs[0][1] as { reason: string }).reason, 'nonce');
  // another app's
  const other = await makeAttestation({ apple, teamId: 'ZZZZZ99999', challenge: CHALLENGE, now: NOW });
  assertEquals((await handleAppAttest(post({ action: 'attest', keyId: other.keyId, attestation: other.attestation, challenge: CHALLENGE }), harness().deps)).status, 400);
  // the sandbox, not allowed here
  const sandbox = await makeAttestation({ apple, teamId: TEAM, challenge: CHALLENGE, now: NOW, environment: 'development' });
  assertEquals((await handleAppAttest(post({ action: 'attest', keyId: sandbox.keyId, attestation: sandbox.attestation, challenge: CHALLENGE }), harness().deps)).status, 400);
  const allowed = harness({ settings: { ...settings, allowDevelopment: true } });
  assertEquals((await handleAppAttest(post({ action: 'attest', keyId: sandbox.keyId, attestation: sandbox.attestation, challenge: CHALLENGE }), allowed.deps)).status, 200);
  assertEquals(allowed.calls.saved[0].environment, 'development');
});

Deno.test('the contract, the token and the configuration are checked first', async () => {
  const h = harness();
  assertEquals((await handleAppAttest(post({ action: 'challenge' }, 'good', 'GET'), h.deps)).status, 405);
  assertEquals((await handleAppAttest(post({ action: 'challenge' }, ''), h.deps)).status, 401);
  assertEquals((await handleAppAttest(post({ action: 'challenge' }, 'bad'), h.deps)).status, 401);
  assertEquals((await handleAppAttest(post({ action: 'challenge' }), harness({ auth: 'down' }).deps)).status, 503);
  assertEquals((await handleAppAttest(post({ action: 'challenge', extra: 1 }), h.deps)).status, 400);
  assertEquals((await handleAppAttest(post({ action: 'attest', keyId: 'short', attestation: 'AAAA', challenge: CHALLENGE }), h.deps)).status, 400);
  assertEquals((await handleAppAttest(post({ action: 'attest', keyId: 'A'.repeat(43) + '=', attestation: 'AAAA', challenge: 'short' }), h.deps)).status, 400);
  assertEquals(h.calls, { issued: [], taken: [], saved: [] });
  const off = await handleAppAttest(post({ action: 'challenge' }), harness({ settings: null }).deps);
  assertEquals(off.status, 503);
  assertEquals(await off.json(), { code: 'unconfigured' });
});

Deno.test('a database refusal maps through pgFailure: a lock timeout is a retryable 503', async () => {
  const res = await handleAppAttest(post({ action: 'challenge' }), harness({ issue: new PgError('55P03', 'lock timeout') }).deps);
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { code: 'retry' });
});
