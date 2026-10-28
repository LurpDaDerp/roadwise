import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  appIdHash,
  attestEnforced,
  attestSettingsFromEnv,
  decodeCbor,
  fromBase64,
  pemToDer,
  APPLE_APP_ATTESTATION_ROOT_CA,
  sha256,
  sha256Text,
  toHex,
  verifyAssertion,
  verifyAttestation,
  type VerifyConfig,
} from './appattest.ts';
import { APPLE_SAMPLE, APPLE_SAMPLE_ASSERTION, APPLE_SAMPLE_ATTESTATION } from './appattest_sample.ts';
import { encodeCbor, fakeApple, makeAssertion, makeAttestation } from './appattest_testkit.ts';

const te = new TextEncoder();
const NOW = Date.parse('2026-10-27T12:00:00Z');
const TEAM = 'ABCDE12345';
const CHALLENGE = 'q0MUbSA7m7Vx2l8vH1XHbJ6Gg3n1J1Y2jZpZQ2t2-_A';

// ---------------------------------------------------------------------------
// Apple's own: a real attestation and assertion from an iPhone, chained to the embedded root
// ---------------------------------------------------------------------------

async function sampleConfig(over: Partial<VerifyConfig> = {}): Promise<VerifyConfig> {
  return { rpIdHash: await appIdHash(APPLE_SAMPLE.teamId, APPLE_SAMPLE.bundleId), allowDevelopment: true, now: APPLE_SAMPLE.attestedAt, ...over };
}
const sampleInput = async (over: { keyId?: string; challenge?: string } = {}) => ({
  keyId: over.keyId ?? APPLE_SAMPLE.keyId,
  attestation: APPLE_SAMPLE_ATTESTATION,
  clientDataHash: await sha256Text(over.challenge ?? APPLE_SAMPLE.clientData),
});

Deno.test('the embedded root is Apple App Attestation Root CA (its published SHA-256 fingerprint)', async () => {
  assertEquals(toHex(await sha256(pemToDer(APPLE_APP_ATTESTATION_ROOT_CA))), '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932');
});

Deno.test("a real iPhone's attestation verifies against Apple's root: its key and environment come back", async () => {
  const r = await verifyAttestation(await sampleInput(), await sampleConfig());
  assert(r.ok);
  assertEquals(r.environment, 'development');
  // the key the fixture publishes: the last 65 bytes of its SubjectPublicKeyInfo
  const spki = fromBase64(APPLE_SAMPLE.publicKeySpki, 128)!;
  assertEquals(toHex(r.publicKey), toHex(spki.subarray(spki.length - 65)));
});

Deno.test("a real iPhone's attestation is refused for the wrong app, challenge, key id, time or environment", async () => {
  const refuse = async (input: Awaited<ReturnType<typeof sampleInput>>, cfg: VerifyConfig) => {
    const r = await verifyAttestation(input, cfg);
    return r.ok ? 'ok' : r.reason;
  };
  assertEquals(await refuse(await sampleInput(), await sampleConfig({ allowDevelopment: false })), 'environment');
  assertEquals(await refuse(await sampleInput(), await sampleConfig({ rpIdHash: await appIdHash(TEAM, APPLE_SAMPLE.bundleId) })), 'app_id');
  assertEquals(await refuse(await sampleInput({ challenge: 'wurzelpfropg' }), await sampleConfig()), 'nonce');
  assertEquals(await refuse(await sampleInput({ keyId: 'AmbJO4x5nEHUvncp9zdWuVZjNBEMgJn3cdSToAXQe3M=' }), await sampleConfig()), 'key_id');
  // the credential certificate lives three days
  assertEquals(await refuse(await sampleInput(), await sampleConfig({ now: Date.parse('2021-01-26T00:00:00Z') })), 'expired');
  assertEquals(await refuse(await sampleInput(), await sampleConfig({ now: NOW })), 'expired');
  // a chain that does not end at the trust anchor
  const other = await fakeApple(APPLE_SAMPLE.attestedAt);
  assertEquals(await refuse(await sampleInput(), await sampleConfig({ root: other.root })), 'chain');
});

Deno.test("a real iPhone's assertion verifies with its key; replays, other bodies and other apps are refused", async () => {
  const attested = await verifyAttestation(await sampleInput(), await sampleConfig());
  assert(attested.ok);
  const cfg = await sampleConfig();
  const check = (counter: number, body: string = APPLE_SAMPLE.clientData, rpIdHash = cfg.rpIdHash) =>
    verifyAssertion({ assertion: APPLE_SAMPLE_ASSERTION, clientData: te.encode(body), publicKey: attested.publicKey, counter }, { rpIdHash });
  assertEquals(await check(0), { ok: true, counter: 1 });
  assertEquals(await check(1), { ok: false, reason: 'counter' });
  assertEquals(await check(0, 'wurzelpfropg'), { ok: false, reason: 'signature' });
  assertEquals(await check(0, APPLE_SAMPLE.clientData, await appIdHash(TEAM)), { ok: false, reason: 'app_id' });
});

// ---------------------------------------------------------------------------
// a chain of our own (testkit): every check, one at a time
// ---------------------------------------------------------------------------

const apple = await fakeApple(NOW);
const ownConfig = async (over: Partial<VerifyConfig> = {}): Promise<VerifyConfig> => ({
  rpIdHash: await appIdHash(TEAM),
  allowDevelopment: false,
  now: NOW,
  root: apple.root,
  ...over,
});
type Spec = Parameters<typeof makeAttestation>[0];
async function attestWith(over: Partial<Spec> = {}, cfg: Partial<VerifyConfig> = {}, keyId?: string) {
  const made = await makeAttestation({ apple, teamId: TEAM, challenge: CHALLENGE, now: NOW, ...over });
  const r = await verifyAttestation({ keyId: keyId ?? made.keyId, attestation: made.attestation, clientDataHash: await sha256Text(CHALLENGE) }, await ownConfig(cfg));
  return { made, r, reason: r.ok ? 'ok' : r.reason };
}

Deno.test('a production attestation for this app verifies; its key is the credential key', async () => {
  const { made, r } = await attestWith();
  assert(r.ok);
  assertEquals(r.environment, 'production');
  assertEquals(toHex(r.publicKey), toHex(made.point));
});

Deno.test("the sandbox is accepted only when allowed", async () => {
  assertEquals((await attestWith({ environment: 'development' })).reason, 'environment');
  assertEquals((await attestWith({ environment: 'development' }, { allowDevelopment: true })).reason, 'ok');
});

Deno.test('each of Apple’s attestation checks refuses on its own', async () => {
  assertEquals((await attestWith({ counter: 1 })).reason, 'counter');
  assertEquals((await attestWith({ credentialId: new Uint8Array(32).fill(7) })).reason, 'credential_id');
  assertEquals((await attestWith({ nonce: new Uint8Array(32) })).reason, 'nonce');
  assertEquals((await attestWith({ bundleId: 'com.example.other' })).reason, 'app_id');
  assertEquals((await attestWith({ teamId: 'ZZZZZ99999' })).reason, 'app_id');
  assertEquals((await attestWith({ fmt: 'packed' })).reason, 'format');
  assertEquals((await attestWith({ leafOnly: true })).reason, 'format');
  const other = await attestWith();
  assertEquals((await attestWith({}, {}, other.made.keyId)).reason, 'key_id');
  // another root, and an intermediate that is no CA, break the chain
  assertEquals((await attestWith({}, { root: (await fakeApple(NOW)).root })).reason, 'chain');
  const noCa = await fakeApple(NOW, { intermediateCa: false });
  const made = await makeAttestation({ apple: noCa, teamId: TEAM, challenge: CHALLENGE, now: NOW });
  const r = await verifyAttestation({ keyId: made.keyId, attestation: made.attestation, clientDataHash: await sha256Text(CHALLENGE) }, await ownConfig({ root: noCa.root }));
  assertEquals(r.ok ? 'ok' : r.reason, 'chain');
  // outside the certificates' validity
  assertEquals((await attestWith({}, { now: NOW + 4 * 86_400_000 })).reason, 'expired');
});

Deno.test('anything that is not an attestation is malformed, never a throw', async () => {
  const cfg = await ownConfig();
  const hash = await sha256Text(CHALLENGE);
  const { made } = await attestWith();
  const bytes = fromBase64(made.attestation, 16_384)!;
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  for (const attestation of ['', 'not base64!', b64(bytes.subarray(0, bytes.length - 1)), b64(new Uint8Array([0xbf, 0xff])), b64(encodeCbor(7))]) {
    const r = await verifyAttestation({ keyId: made.keyId, attestation, clientDataHash: hash }, cfg);
    assert(!r.ok && (r.reason === 'malformed' || r.reason === 'format'), attestation);
  }
  const r = await verifyAttestation({ keyId: 'short', attestation: made.attestation, clientDataHash: hash }, cfg);
  assertEquals(r.ok ? 'ok' : r.reason, 'malformed');
});

Deno.test('an assertion verifies over the exact body bytes with a counter above the stored one', async () => {
  const { made } = await attestWith();
  const body = '{"v":5,"clientTripId":"x"}';
  const cfg = await ownConfig();
  const assertion = await makeAssertion({ key: made.key, teamId: TEAM, counter: 3, body });
  const check = (b: string, counter: number, a = assertion) => verifyAssertion({ assertion: a, clientData: te.encode(b), publicKey: made.point, counter }, cfg);
  assertEquals(await check(body, 2), { ok: true, counter: 3 });
  assertEquals(await check(body, 3), { ok: false, reason: 'counter' });
  // one byte of the body changed (a space added) is another body
  assertEquals(await check('{"v":5, "clientTripId":"x"}', 2), { ok: false, reason: 'signature' });
  // another key's signature
  const stranger = await attestWith();
  assertEquals(await check(body, 0, await makeAssertion({ key: stranger.made.key, teamId: TEAM, counter: 1, body })), { ok: false, reason: 'signature' });
  // another app's
  assertEquals(await check(body, 0, await makeAssertion({ key: made.key, teamId: TEAM, bundleId: 'com.example.other', counter: 1, body })), { ok: false, reason: 'app_id' });
  assertEquals(await check(body, 0, 'AAAA'), { ok: false, reason: 'malformed' });
  assertEquals((await verifyAssertion({ assertion, clientData: te.encode(body), publicKey: new Uint8Array(65), counter: 0 }, cfg)).ok, false);
});

// ---------------------------------------------------------------------------
// CBOR and the settings
// ---------------------------------------------------------------------------

Deno.test('the CBOR reader takes only the definite, untagged subset, filling the input exactly', () => {
  assertEquals(decodeCbor(new Uint8Array([0xa1, 0x61, 0x61, 0x01])), new Map([['a', 1]]));
  assertThrows(() => decodeCbor(new Uint8Array([0x01, 0x02]))); // trailing bytes
  assertThrows(() => decodeCbor(new Uint8Array([0x5f, 0x40, 0xff]))); // indefinite length
  assertThrows(() => decodeCbor(new Uint8Array([0xc2, 0x40]))); // a tag
  assertThrows(() => decodeCbor(new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]))); // a key twice
  assertThrows(() => decodeCbor(new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff]))); // longer than the input
  assertThrows(() => decodeCbor(new Uint8Array(20).fill(0x81))); // too deep
});

Deno.test('the settings: nothing without a team id, a bad one is said and off, the sandbox only when allowed', async () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const said: unknown[] = [];
  const log = { error: (...a: unknown[]) => said.push(a) };
  assertEquals(await attestSettingsFromEnv(env({}), log), null);
  assertEquals(await attestSettingsFromEnv(env({ APP_ATTEST_TEAM_ID: 'abc' }), log), null);
  assertEquals(said.length, 1);
  const s = await attestSettingsFromEnv(env({ APP_ATTEST_TEAM_ID: TEAM }));
  assertEquals(s && toHex(s.rpIdHash), toHex(await sha256Text(`${TEAM}.com.lurp.safedrive`)));
  assertEquals(s?.allowDevelopment, false);
  assertEquals((await attestSettingsFromEnv(env({ APP_ATTEST_TEAM_ID: TEAM, APP_ATTEST_ALLOW_DEVELOPMENT: 'true' })))?.allowDevelopment, true);
  assertEquals(attestEnforced(env({ APP_ATTEST_ENFORCE: 'true' })), true);
  assertEquals(attestEnforced(env({ APP_ATTEST_ENFORCE: '1' })), false);
  assertEquals(attestEnforced(env({})), false);
});
