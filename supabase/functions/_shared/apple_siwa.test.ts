import { assert, assertEquals } from '@std/assert';
import { b64urlText } from './apns.ts';
import { APPLE_ID_HOST, CLIENT_SECRET_TTL_S, identitySubject, revokeAppleAuthorization, signClientSecret, siwaConfigFromEnv, type SiwaConfig } from './apple_siwa.ts';

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
const SUB = '001234.abcdef0123456789.0123';

async function keyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let s = '';
  for (const b of pkcs8) s += String.fromCharCode(b);
  const body = btoa(s).replace(/(.{64})/g, '$1\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

const config = (pem: string): SiwaConfig => ({ keyId: 'KEY1234567', teamId: 'TEAM123456', privateKeyPem: pem, clientId: 'com.lurp.safedrive' });

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
const idToken = (claims: Record<string, unknown>) => `${b64urlText('{"alg":"RS256"}')}.${b64urlText(JSON.stringify(claims))}.sig`;

type Call = { url: string; form: URLSearchParams };

function apple(answers: { token?: Response | 'throw' | 'timeout'; revoke?: Response }) {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, form: new URLSearchParams(String(init?.body ?? '')) });
    if (url.endsWith('/auth/token')) {
      if (answers.token === 'throw') return Promise.reject(new TypeError('network down'));
      if (answers.token === 'timeout') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
      return Promise.resolve(answers.token ?? Response.json({ refresh_token: 'r.1', access_token: 'a.1', id_token: idToken({ sub: SUB }) }));
    }
    return Promise.resolve(answers.revoke ?? new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

Deno.test('config: the four secrets, team and client id falling back to the APNs ones; anything malformed is null', async () => {
  const { pem } = await keyPair();
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(
    siwaConfigFromEnv(env({ APPLE_SIWA_KEY_ID: 'KEY1234567', APPLE_SIWA_PRIVATE_KEY: pem, APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.lurp.safedrive' })),
    config(pem)
  );
  assertEquals(
    siwaConfigFromEnv(
      env({ APPLE_SIWA_KEY_ID: 'KEY1234567', APPLE_SIWA_PRIVATE_KEY: pem, APPLE_SIWA_TEAM_ID: 'OTHER12345', APNS_TEAM_ID: 'TEAM123456', APPLE_SIWA_CLIENT_ID: 'com.x' })
    )?.teamId,
    'OTHER12345'
  );
  assertEquals(siwaConfigFromEnv(env({ APPLE_SIWA_PRIVATE_KEY: pem, APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.x' })), null);
  assertEquals(siwaConfigFromEnv(env({ APPLE_SIWA_KEY_ID: 'short', APPLE_SIWA_PRIVATE_KEY: pem, APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.x' })), null);
  assertEquals(siwaConfigFromEnv(env({ APPLE_SIWA_KEY_ID: 'KEY1234567', APPLE_SIWA_PRIVATE_KEY: 'nope', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.x' })), null);
});

Deno.test('the client secret: ES256 with the key id, Apple audience, the team as issuer, the app as subject, 5 minutes', async () => {
  const { pem, publicKey } = await keyPair();
  const nowS = NOW / 1000;
  const jwt = await signClientSecret(config(pem), nowS);
  const [h, c, sig] = jwt.split('.');
  assertEquals(decode(h), { alg: 'ES256', kid: 'KEY1234567' });
  assertEquals(decode(c), { iss: 'TEAM123456', iat: nowS, exp: nowS + CLIENT_SECRET_TTL_S, aud: APPLE_ID_HOST, sub: 'com.lurp.safedrive' });
  const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(sig.length / 4) * 4, '=')), (ch) => ch.charCodeAt(0));
  assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBytes, new TextEncoder().encode(`${h}.${c}`)));
});

Deno.test('identitySubject reads sub; anything else is null', () => {
  assertEquals(identitySubject(idToken({ sub: SUB })), SUB);
  assertEquals(identitySubject(idToken({ sub: '' })), null);
  assertEquals(identitySubject('not-a-jwt'), null);
  assertEquals(identitySubject('a.%%%.c'), null);
  assertEquals(identitySubject(undefined), null);
});

Deno.test('the code is exchanged, then its refresh token revoked', async () => {
  const { pem } = await keyPair();
  const a = apple({});
  assertEquals(await revokeAppleAuthorization(config(pem), 'code.1', SUB, { fetch: a.fetchFn, now: () => NOW }), 'revoked');
  assertEquals(
    a.calls.map((c) => c.url),
    [`${APPLE_ID_HOST}/auth/token`, `${APPLE_ID_HOST}/auth/revoke`]
  );
  assertEquals(a.calls[0].form.get('grant_type'), 'authorization_code');
  assertEquals(a.calls[0].form.get('code'), 'code.1');
  assertEquals(a.calls[0].form.get('client_id'), 'com.lurp.safedrive');
  assert((a.calls[0].form.get('client_secret') ?? '').split('.').length === 3);
  assertEquals(a.calls[1].form.get('token'), 'r.1');
  assertEquals(a.calls[1].form.get('token_type_hint'), 'refresh_token');
  assertEquals(a.calls[1].form.get('client_secret'), a.calls[0].form.get('client_secret'));
});

Deno.test("a code for another Apple ID revokes nothing", async () => {
  const { pem } = await keyPair();
  const a = apple({ token: Response.json({ refresh_token: 'r.1', id_token: idToken({ sub: 'someone.else' }) }) });
  assertEquals(await revokeAppleAuthorization(config(pem), 'code.1', SUB, { fetch: a.fetchFn, now: () => NOW }), 'wrong_account');
  assertEquals(a.calls.length, 1);
});

Deno.test('failures are one word and never throw', async () => {
  const { pem } = await keyPair();
  const run = (answers: Parameters<typeof apple>[0], cfg = config(pem)) => revokeAppleAuthorization(cfg, 'code.1', SUB, { fetch: apple(answers).fetchFn, now: () => NOW });
  assertEquals(await run({ token: Response.json({ error: 'invalid_grant' }, { status: 400 }) }), 'exchange_failed');
  assertEquals(await run({ token: new Response('not json', { status: 200 }) }), 'exchange_failed');
  assertEquals(await run({ token: Response.json({ access_token: 'a.1' }) }), 'exchange_failed');
  assertEquals(await run({ revoke: new Response(null, { status: 400 }) }), 'revoke_failed');
  assertEquals(await run({ token: 'throw' }), 'network');
  assertEquals(await run({ token: 'timeout' }), 'timeout');
  assertEquals(await run({}, { ...config(pem), privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }), 'bad_key');
});
