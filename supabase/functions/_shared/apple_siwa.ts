// Sign in with Apple, for one thing only: revoking the app's Apple authorization when an account is
// deleted (Apple's account-deletion guidance for apps that offer Sign in with Apple).
//
// The phone sends a fresh authorization code from the Apple sheet it shows at Delete account. Apple
// gives refresh tokens only through a code exchange, and RoadWise keeps no Apple tokens, so the
// code is exchanged here (`/auth/token`) and the refresh token it returns is revoked at once
// (`/auth/revoke`). Both calls authenticate with a client secret: an ES256 JWT
// `{ alg: ES256, kid: <key id> }.{ iss: <team id>, iat, exp, aud: https://appleid.apple.com,
// sub: <client id> }` signed with a Sign in with Apple key (.p8).
//
// The secrets (APPLE_SIWA_KEY_ID, APPLE_SIWA_PRIVATE_KEY, and APPLE_SIWA_TEAM_ID and
// APPLE_SIWA_CLIENT_ID, which fall back to APNS_TEAM_ID and APNS_BUNDLE_ID), the code and the tokens
// never reach a log or a response: the outcome is one word.

import { b64url, b64urlText, pemToPkcs8 } from './apns.ts';

export const APPLE_ID_HOST = 'https://appleid.apple.com';
/** How long a client secret lives: it is signed for one deletion and used at once. */
export const CLIENT_SECRET_TTL_S = 300;
/** One request's budget. */
export const REQUEST_TIMEOUT_MS = 8000;

export interface SiwaConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key: PKCS#8 PEM (a secret set with literal `\n` sequences is read as newlines). */
  privateKeyPem: string;
  /** The native app's client id: its bundle id. */
  clientId: string;
}

const TEN = /^[A-Z0-9]{10}$/;
const CLIENT_ID = /^[A-Za-z0-9.-]{1,155}$/;

/** The configuration from the function's secrets, or null when any is missing or malformed. */
export function siwaConfigFromEnv(get: (name: string) => string | undefined): SiwaConfig | null {
  const keyId = get('APPLE_SIWA_KEY_ID')?.trim();
  const teamId = (get('APPLE_SIWA_TEAM_ID') ?? get('APNS_TEAM_ID'))?.trim();
  const clientId = (get('APPLE_SIWA_CLIENT_ID') ?? get('APNS_BUNDLE_ID'))?.trim();
  const privateKeyPem = get('APPLE_SIWA_PRIVATE_KEY');
  if (!keyId || !TEN.test(keyId) || !teamId || !TEN.test(teamId) || !clientId || !CLIENT_ID.test(clientId)) return null;
  if (!privateKeyPem || !privateKeyPem.includes('PRIVATE KEY')) return null;
  return { keyId, teamId, privateKeyPem, clientId };
}

/** The client secret both endpoints take. */
export async function signClientSecret(config: SiwaConfig, nowS: number): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(config.privateKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = { alg: 'ES256', kid: config.keyId };
  const claims = { iss: config.teamId, iat: nowS, exp: nowS + CLIENT_SECRET_TTL_S, aud: APPLE_ID_HOST, sub: config.clientId };
  const input = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

/** The `sub` claim of an Apple identity token, read without a signature check: it came straight from Apple over TLS. */
export function identitySubject(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * What became of a revocation: `revoked`; `bad_key` (the secret could not be signed);
 * `exchange_failed` (Apple refused the code: expired, used, or for another app); `wrong_account`
 * (the code is for a different Apple ID than the account's, so nothing is revoked);
 * `revoke_failed`; `timeout` / `network`.
 */
export type RevokeOutcome = 'revoked' | 'bad_key' | 'exchange_failed' | 'wrong_account' | 'revoke_failed' | 'timeout' | 'network';

export interface SiwaDeps {
  fetch?: typeof fetch;
  /** epoch ms */
  now?: () => number;
}

/**
 * Exchanges `code` and revokes the refresh token it yields, when the code is for `appleSubject`
 * (the deleted account's Apple user id). Never throws.
 */
export async function revokeAppleAuthorization(config: SiwaConfig, code: string, appleSubject: string, deps: SiwaDeps = {}): Promise<RevokeOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000);
  let secret: string;
  try {
    secret = await signClientSecret(config, nowS);
  } catch {
    return 'bad_key';
  }
  const post = (path: string, form: Record<string, string>) =>
    doFetch(`${APPLE_ID_HOST}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  try {
    const exchanged = await post('/auth/token', { client_id: config.clientId, client_secret: secret, code, grant_type: 'authorization_code' });
    if (!exchanged.ok) {
      await exchanged.body?.cancel();
      return 'exchange_failed';
    }
    const tokens = (await exchanged.json().catch(() => ({}))) as { refresh_token?: unknown; id_token?: unknown };
    if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) return 'exchange_failed';
    if (identitySubject(tokens.id_token) !== appleSubject) return 'wrong_account';

    const revoked = await post('/auth/revoke', {
      client_id: config.clientId,
      client_secret: secret,
      token: tokens.refresh_token,
      token_type_hint: 'refresh_token',
    });
    await revoked.body?.cancel();
    return revoked.ok ? 'revoked' : 'revoke_failed';
  } catch (err) {
    const timeout = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return timeout ? 'timeout' : 'network';
  }
}
