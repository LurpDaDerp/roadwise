import { assert, assertEquals } from '@std/assert';
import { appIdHash, toHex, type AttestSettings } from '../_shared/appattest.ts';
import { fakeApple, makeAssertion, makeAttestation, type MadeAttestation } from '../_shared/appattest_testkit.ts';
import type { ApplyDriveEnvelope, AttestContext } from '../_shared/engine.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import { EVENT, payload, response, USER } from '../_shared/testing/v5_fixtures.ts';
import { ATTEST_ASSERTION_HEADER, ATTEST_HEADER, ATTEST_KEY_HEADER, readProof } from './attest.ts';
import { ATTEST_RETRY_AFTER_S, handleFinalizeTrip } from './handler.ts';

const TEAM = 'ABCDE12345';
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const apple = await fakeApple(NOW);
const settings: AttestSettings = { rpIdHash: await appIdHash(TEAM), allowDevelopment: false, root: apple.root };
const freshContext = { version: 23, phoneUse: true, existing: null, merge: null };

/** A key the user attested, as app_attest_context hands it back. */
const attested: MadeAttestation = await makeAttestation({ apple, teamId: TEAM, challenge: 'c'.repeat(43), now: NOW });
const keyRow = (over: Partial<NonNullable<AttestContext['key']>> = {}): AttestContext => ({
  key: { publicKey: toHex(attested.point), counter: 4, environment: 'production', ...over },
  android: false,
});

function harness(script: FakeEngineScript = {}, attest: { settings?: AttestSettings | null; enforce: boolean } = { enforce: true }) {
  const logs: unknown[][] = [];
  const fake = fakeEngine({
    context: freshContext,
    apply: (e: ApplyDriveEnvelope) => response({ scored: e.scored, reason: e.reason, eventIds: e.events.map((x) => x.id) }),
    ...script,
  });
  const deps = {
    verifyJwt: (token: string) => Promise.resolve(token === 'good' ? USER : null),
    engine: fake.engine,
    attest: { settings: attest.settings === undefined ? settings : attest.settings, enforce: attest.enforce },
    log: { warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) },
  };
  return { fake, deps, logs };
}

/** The exact bytes the phone sends, and its headers. */
const BODY = JSON.stringify(payload());
const post = (headers: Record<string, string> = {}, body = BODY) =>
  new Request('http://local/functions/v1/finalize-trip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good', ...headers },
    body,
  });
const signed = async (counter: number, body = BODY, key = attested) => ({
  [ATTEST_KEY_HEADER]: key.keyId,
  [ATTEST_ASSERTION_HEADER]: await makeAssertion({ key: key.key, teamId: TEAM, counter, body }),
});
const fns = (h: ReturnType<typeof harness>) => h.fake.calls.map((c) => c.fn);
const envelopeOf = (h: ReturnType<typeof harness>) => h.fake.calls.find((c) => c.fn === 'applyDrive')!.args as ApplyDriveEnvelope;

Deno.test('the headers: an assertion, unsupported, unattested, or none at all', () => {
  const h = (o: Record<string, string>) => readProof(new Headers(o));
  assertEquals(h({}), { kind: 'none' });
  assertEquals(h({ [ATTEST_HEADER]: 'unsupported' }), { kind: 'unsupported' });
  assertEquals(h({ [ATTEST_HEADER]: 'unattested' }), { kind: 'unattested' });
  assertEquals(h({ [ATTEST_KEY_HEADER]: attested.keyId, [ATTEST_ASSERTION_HEADER]: 'AAAA' }), { kind: 'assertion', keyId: attested.keyId, assertion: 'AAAA' });
  // half an assertion, or one that is not one, is an attesting build without a usable key
  assertEquals(h({ [ATTEST_KEY_HEADER]: attested.keyId }), { kind: 'unattested' });
  assertEquals(h({ [ATTEST_KEY_HEADER]: 'nope', [ATTEST_ASSERTION_HEADER]: 'AAAA' }), { kind: 'unattested' });
  assertEquals(h({ [ATTEST_KEY_HEADER]: attested.keyId, [ATTEST_ASSERTION_HEADER]: 'A'.repeat(2000) }), { kind: 'unattested' });
});

Deno.test('enforced: a valid assertion over the exact body scores the drive, and its counter is stored in the same transaction', async () => {
  const h = harness({ attest: keyRow() });
  const res = await handleFinalizeTrip(post(await signed(5)), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), response({ eventIds: [EVENT] }));
  assertEquals(fns(h), ['driveContext', 'attestContext', 'advanceAttestCounter', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
  assertEquals(h.fake.calls[1].args, { userId: USER, keyId: attested.keyId });
  assertEquals(h.fake.calls[2].args, { userId: USER, keyId: attested.keyId, counter: 5 });
  assertEquals(h.fake.transactions, { opened: 1, failed: 0 });
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [true, null]);
});

Deno.test('enforced: whatever an attesting phone can fix by attesting is a retryable 429 attest_required, and nothing is stored', async () => {
  const cases: [string, FakeEngineScript, () => Promise<Record<string, string>>][] = [
    ['no header, no Android device', {}, () => Promise.resolve({})],
    ['no key yet', {}, () => Promise.resolve({ [ATTEST_HEADER]: 'unattested' })],
    ['a key the user does not have', { attest: { key: null, android: false } }, () => signed(5)],
    ['a replayed counter', { attest: keyRow({ counter: 5 }) }, () => signed(5)],
    ['another body', { attest: keyRow() }, () => signed(5, BODY.replace('"v":5', '"v":5 '))],
    ['another key', { attest: keyRow() }, async () => ({ ...(await signed(5, BODY, await makeAttestation({ apple, teamId: TEAM, challenge: 'c'.repeat(43), now: NOW }))), [ATTEST_KEY_HEADER]: attested.keyId })],
    ['a counter another upload moved first', { attest: keyRow(), advance: false }, () => signed(5)],
    ['a sandbox key, no longer allowed', { attest: keyRow({ environment: 'development' }) }, () => signed(5)],
  ];
  for (const [name, script, headers] of cases) {
    const h = harness(script);
    const res = await handleFinalizeTrip(post(await headers()), h.deps);
    assertEquals(res.status, 429, name);
    assertEquals(await res.json(), { code: 'attest_required' }, name);
    assertEquals(res.headers.get('retry-after'), String(ATTEST_RETRY_AFTER_S), name);
    // the upload's daily budget is not spent and nothing is written
    assert(!fns(h).includes('takeRateLimit') && !fns(h).includes('applyDrive'), name);
    assertEquals(h.logs.length, 1, name);
  }
});

Deno.test('enforced: no App Attest header from a user with an Android device is scored as today', async () => {
  const h = harness({ attest: { key: null, android: true } });
  const res = await handleFinalizeTrip(post(), h.deps);
  assertEquals(res.status, 200);
  assertEquals(fns(h), ['driveContext', 'attestContext', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
  assertEquals(h.fake.calls[1].args, { userId: USER, keyId: null });
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [true, null]);
});

Deno.test('enforced: a phone without App Attest (a simulator) is stored unscored as implausible', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post({ [ATTEST_HEADER]: 'unsupported' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [false, 'implausible']);
  assert(!fns(h).includes('attestContext'));
  // the integrity flags' own reason still stands first
  const spoofed = harness();
  await handleFinalizeTrip(post({ [ATTEST_HEADER]: 'unsupported' }, JSON.stringify(payload({ integrity: { mockLocation: true, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 50 } }))), spoofed.deps);
  assertEquals(envelopeOf(spoofed).reason, 'spoofed');
});

Deno.test('a replay is answered before the check: an upload stored once is never asked to attest', async () => {
  const h = harness({ context: { ...freshContext, existing: response() } });
  const res = await handleFinalizeTrip(post(), h.deps);
  assertEquals(res.status, 200);
  assertEquals(fns(h), ['driveContext']);
});

Deno.test('enforcement off: nothing is refused; a valid assertion still moves the counter, a bad one only goes to the log', async () => {
  const off = { enforce: false };
  // no header: the calls are exactly as before App Attest
  const plain = harness({}, off);
  assertEquals((await handleFinalizeTrip(post(), plain.deps)).status, 200);
  assertEquals(fns(plain), ['driveContext', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
  const good = harness({ attest: keyRow() }, off);
  assertEquals((await handleFinalizeTrip(post(await signed(5)), good.deps)).status, 200);
  assertEquals(fns(good), ['driveContext', 'attestContext', 'advanceAttestCounter', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
  assertEquals(good.logs, []);
  const bad = harness({ attest: keyRow({ counter: 9 }) }, off);
  assertEquals((await handleFinalizeTrip(post(await signed(5)), bad.deps)).status, 200);
  assertEquals([envelopeOf(bad).scored, envelopeOf(bad).reason], [true, null]);
  assertEquals((bad.logs[0][1] as { verdict: string; reason: string }).verdict, 'invalid');
  assertEquals((bad.logs[0][1] as { verdict: string; reason: string }).reason, 'counter');
  for (const headers of [{ [ATTEST_HEADER]: 'unsupported' }, { [ATTEST_HEADER]: 'unattested' }]) {
    const h = harness({}, off);
    assertEquals((await handleFinalizeTrip(post(headers), h.deps)).status, 200);
    assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [true, null]);
  }
  // not configured at all (no team id): an assertion is not even read
  const unconfigured = harness({}, { settings: null, enforce: false });
  assertEquals((await handleFinalizeTrip(post(await signed(5)), unconfigured.deps)).status, 200);
  assertEquals(fns(unconfigured), ['driveContext', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
});

Deno.test('a failing key read is the transaction’s failure: retried, nothing stored', async () => {
  const h = harness({ attest: new Error('connection reset') });
  const res = await handleFinalizeTrip(post(await signed(5)), h.deps);
  assertEquals(res.status, 500);
  assertEquals(h.fake.transactions, { opened: 1, failed: 1 });
  assert(!fns(h).includes('applyDrive'));
});
