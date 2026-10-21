import { assert, assertEquals } from '@std/assert';
import {
  apnsConfigFromEnv,
  createApnsClient,
  JWT_REUSE_S,
  liveActivityStartPayload,
  START_ALERT,
  type ApnsConfig,
  type LiveActivityContentState,
} from './apns.ts';

const TOKEN = 'a1'.repeat(32);
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);
const STARTED = NOW - 90_000;

const STATE: LiveActivityContentState = {
  speed: 34,
  limit: 35,
  unit: 'mph',
  speedTint: null,
  speeding: false,
  notDrivingAvailable: true,
  weatherKind: null,
  weatherText: null,
  skyTop: '#0B2A5C',
  skyMid: '#123B7A',
  skyLow: '#1A4C94',
  accent: '#93A9FF',
};

async function keyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let s = '';
  for (const b of pkcs8) s += String.fromCharCode(b);
  const body = btoa(s).replace(/(.{64})/g, '$1\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

const config = (pem: string): ApnsConfig => ({ keyId: 'ABC123DEFG', teamId: 'TEAM123456', privateKeyPem: pem, bundleId: 'com.lurp.safedrive' });

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that answers from a list, recording each request. */
function fakeFetch(answers: (Response | Error)[]) {
  const sent: Sent[] = [];
  const f = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
    const a = answers.shift() ?? new Response(null, { status: 200 });
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { sent, fetch: f as typeof fetch };
}

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

Deno.test('a push-to-start goes to the production host with the liveactivity headers, the start payload and an ES256 provider token WebCrypto verifies', async () => {
  const { pem, publicKey } = await keyPair();
  const f = fakeFetch([new Response(null, { status: 200 })]);
  const client = createApnsClient(config(pem), { fetch: f.fetch, now: () => NOW });
  const r = await client.sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: { ...STATE, weatherKind: 'heavy_rain', weatherText: 'Heavy rain' } });
  assertEquals(r, { ok: true, status: 200, reason: null, host: 'production' });
  assertEquals(f.sent.length, 1);
  const s = f.sent[0];
  assertEquals(s.url, `https://api.push.apple.com/3/device/${TOKEN}`);
  assertEquals([s.headers['apns-push-type'], s.headers['apns-topic'], s.headers['apns-priority'], s.headers['apns-expiration']], [
    'liveactivity',
    'com.lurp.safedrive.push-type.liveactivity',
    '10',
    String(NOW / 1000 + 600),
  ]);
  assertEquals(s.body, {
    aps: {
      timestamp: NOW / 1000,
      event: 'start',
      // the weather line is the driving screen's to set: never in the start
      'content-state': { ...STATE, weatherKind: null, weatherText: null },
      'attributes-type': 'LiveDriveAttributes',
      attributes: { startedAt: STARTED },
      alert: { title: 'Recording your drive', body: 'Tap to open it. Not driving? You can stop it there.' },
      'input-push-token': 1,
    },
  });
  // the provider token: header, claims, and a signature the public key verifies
  const auth = s.headers['authorization'];
  assert(auth.startsWith('bearer '));
  const [h, c, sig] = auth.slice('bearer '.length).split('.');
  assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(h))), { alg: 'ES256', kid: 'ABC123DEFG' });
  assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(c))), { iss: 'TEAM123456', iat: NOW / 1000 });
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(sig), new TextEncoder().encode(`${h}.${c}`));
  assertEquals(ok, true);
});

Deno.test('the provider token is reused for 50 minutes, then signed again', async () => {
  const { pem } = await keyPair();
  let t = NOW;
  const f = fakeFetch([]);
  const client = createApnsClient(config(pem), { fetch: f.fetch, now: () => t });
  await client.sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  t += (JWT_REUSE_S - 1) * 1000;
  await client.sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  t += 2000;
  await client.sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  const tokens = f.sent.map((s) => s.headers['authorization']);
  assertEquals(tokens[0], tokens[1]);
  assert(tokens[2] !== tokens[0]);
});

Deno.test("a development build's token (BadDeviceToken) is tried once more on the sandbox host; other refusals are not retried", async () => {
  const { pem } = await keyPair();
  const bad = () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
  const f = fakeFetch([bad(), new Response(null, { status: 200 })]);
  const r = await createApnsClient(config(pem), { fetch: f.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals(r, { ok: true, status: 200, reason: null, host: 'sandbox' });
  assertEquals(f.sent.map((s) => s.url), [`https://api.push.apple.com/3/device/${TOKEN}`, `https://api.sandbox.push.apple.com/3/device/${TOKEN}`]);
  const both = fakeFetch([bad(), bad()]);
  const r2 = await createApnsClient(config(pem), { fetch: both.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals(r2, { ok: false, status: 400, reason: 'BadDeviceToken', host: 'sandbox' });
  const other = fakeFetch([new Response(JSON.stringify({ reason: 'TooManyRequests' }), { status: 429 })]);
  const r3 = await createApnsClient(config(pem), { fetch: other.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals([r3, other.sent.length], [{ ok: false, status: 429, reason: 'TooManyRequests', host: 'production' }, 1]);
});

Deno.test('a network failure, a timeout or a junk body never throws and never carries anything but a code', async () => {
  const { pem } = await keyPair();
  const net = fakeFetch([new TypeError('connection reset')]);
  const r = await createApnsClient(config(pem), { fetch: net.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals(r, { ok: false, status: 0, reason: 'network', host: 'production' });
  const slow = fakeFetch([new DOMException('timed out', 'TimeoutError')]);
  const r2 = await createApnsClient(config(pem), { fetch: slow.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals(r2.reason, 'timeout');
  const junk = fakeFetch([new Response('<html>' + 'x'.repeat(5000), { status: 500 })]);
  const r3 = await createApnsClient(config(pem), { fetch: junk.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals(r3, { ok: false, status: 500, reason: null, host: 'production' });
  // a token that is not one is refused without a request; a key that is not one is a code, not a throw
  const none = fakeFetch([]);
  assertEquals((await createApnsClient(config(pem), { fetch: none.fetch }).sendLiveActivityStart('nope', { startedAt: STARTED, state: STATE })).ok, false);
  const broken = await createApnsClient(config('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), { fetch: none.fetch }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE });
  assertEquals([broken.ok, broken.reason, none.sent.length], [false, 'bad_key', 0]);
});

Deno.test('the configuration comes from the four secrets, or is null when one is missing or malformed; a PEM with literal \\n works', async () => {
  const { pem } = await keyPair();
  const env = (o: Record<string, string>) => (n: string) => o[n];
  const full = { APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: pem, APNS_BUNDLE_ID: 'com.lurp.safedrive' };
  assertEquals(apnsConfigFromEnv(env(full)), config(pem));
  for (const k of Object.keys(full)) {
    const { [k as keyof typeof full]: _gone, ...rest } = full;
    assertEquals(apnsConfigFromEnv(env(rest)), null, k);
  }
  assertEquals(apnsConfigFromEnv(env({ ...full, APNS_KEY_ID: 'short' })), null);
  assertEquals(apnsConfigFromEnv(env({ ...full, APNS_PRIVATE_KEY: 'not a key' })), null);
  const escaped = apnsConfigFromEnv(env({ ...full, APNS_PRIVATE_KEY: pem.replace(/\n/g, '\\n') }))!;
  const f = fakeFetch([]);
  assertEquals((await createApnsClient(escaped, { fetch: f.fetch, now: () => NOW }).sendLiveActivityStart(TOKEN, { startedAt: STARTED, state: STATE })).ok, true);
});

Deno.test('the start payload carries the alert the fallback notification uses, word for word', () => {
  const p = liveActivityStartPayload({ startedAt: STARTED, state: STATE, nowS: NOW / 1000 }) as { aps: { alert: unknown } };
  assertEquals(p.aps.alert, START_ALERT);
  assertEquals(/!|—/.test(JSON.stringify(START_ALERT)), false);
});
