// Apple Push Notification service, for one thing only: starting a drive's Live Activity on the lock
// screen with an ActivityKit push-to-start (iOS 17.2 and later).
//
// Token auth (an APNs auth key, .p8): an ES256 JWT `{ alg: ES256, kid: <key id> }.{ iss: <team id>,
// iat }` signed with WebCrypto, reused for 50 minutes (Apple refuses a token older than an hour and
// throttles one renewed more than every 20 minutes). The request goes to the production host and,
// when it answers BadDeviceToken (a development build's token), once more to the sandbox host.
//
// The secrets (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID) and the device token
// never reach a log or a response: errors carry the HTTP status and Apple's reason code only.

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;
export type ApnsHost = keyof typeof APNS_HOSTS;

/** How long a signed provider token is reused (Apple: refresh between 20 and 60 minutes). */
export const JWT_REUSE_S = 50 * 60;
/** How long Apple may hold a start it cannot deliver yet: a start that late is no use. */
export const START_EXPIRATION_S = 600;
/** One request's budget; the edge function answers well inside its own limit. */
export const REQUEST_TIMEOUT_MS = 8000;

/** What the start push says on the lock screen while the activity appears (ActivityKit requires an alert). */
export const START_ALERT = { title: 'Recording your drive', body: 'Tap to open it. Not driving? You can stop it there.' } as const;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key: PKCS#8 PEM (a secret set with literal `\n` sequences is read as newlines). */
  privateKeyPem: string;
  /** The app's bundle id; the push topic is `<bundleId>.push-type.liveactivity`. */
  bundleId: string;
}

const KEY_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/;

/** The APNs configuration from the function's secrets, or null when any is missing or malformed. */
export function apnsConfigFromEnv(get: (name: string) => string | undefined): ApnsConfig | null {
  const keyId = get('APNS_KEY_ID')?.trim();
  const teamId = get('APNS_TEAM_ID')?.trim();
  const privateKeyPem = get('APNS_PRIVATE_KEY');
  const bundleId = get('APNS_BUNDLE_ID')?.trim();
  if (!keyId || !KEY_ID.test(keyId) || !teamId || !KEY_ID.test(teamId) || !bundleId || !BUNDLE_ID.test(bundleId)) return null;
  if (!privateKeyPem || !privateKeyPem.includes('PRIVATE KEY')) return null;
  return { keyId, teamId, privateKeyPem, bundleId };
}

/** The Live Activity's content state as the widget decodes it (`LiveDriveAttributes.ContentState`). */
export interface LiveActivityContentState {
  speed: number | null;
  limit: number | null;
  unit: 'mph' | 'km/h';
  speedTint: string | null;
  speeding: boolean;
  notDrivingAvailable: boolean;
  weatherKind: string | null;
  weatherText: string | null;
  skyTop: string | null;
  skyMid: string | null;
  skyLow: string | null;
  accent: string | null;
}

/**
 * The push-to-start payload: `event: start`, the content state (no weather line: the driving
 * screen sets it once it is open), the attributes (`startedAt`, epoch ms), the alert, and
 * `input-push-token` so the started activity hands its update token to the app.
 */
export function liveActivityStartPayload(args: { startedAt: number; state: LiveActivityContentState; nowS: number }): Record<string, unknown> {
  return {
    aps: {
      timestamp: args.nowS,
      event: 'start',
      'content-state': { ...args.state, weatherKind: null, weatherText: null },
      'attributes-type': 'LiveDriveAttributes',
      attributes: { startedAt: args.startedAt },
      alert: { ...START_ALERT },
      'input-push-token': 1,
    },
  };
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlText = (text: string): string => b64url(new TextEncoder().encode(text));

/** The PKCS#8 bytes of a PEM private key. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The provider token: ES256 over `header.claims`, the signature in JOSE (r || s) form as WebCrypto gives it. */
export async function signApnsJwt(config: ApnsConfig, nowS: number, key?: CryptoKey): Promise<string> {
  const signingKey =
    key ?? (await crypto.subtle.importKey('pkcs8', pemToPkcs8(config.privateKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']));
  const input = `${b64urlText(JSON.stringify({ alg: 'ES256', kid: config.keyId }))}.${b64urlText(JSON.stringify({ iss: config.teamId, iat: nowS }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

export interface ApnsResult {
  ok: boolean;
  /** The HTTP status of the last answer (0 when no answer came). */
  status: number;
  /** Apple's reason code (`BadDeviceToken`, ...), `timeout` / `network`, or null when it went. */
  reason: string | null;
  host: ApnsHost;
}

export interface ApnsClient {
  /** Sends one push-to-start to one device token; never throws. */
  sendLiveActivityStart(deviceToken: string, args: { startedAt: number; state: LiveActivityContentState }): Promise<ApnsResult>;
}

export interface ApnsDeps {
  fetch?: typeof fetch;
  /** epoch ms */
  now?: () => number;
}

const DEVICE_TOKEN = /^[0-9a-f]{32,200}$/;

/** The reason code from Apple's error body (`{ "reason": "BadDeviceToken" }`), bounded. */
async function reasonOf(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 512);
    const reason = (JSON.parse(text) as { reason?: unknown }).reason;
    return typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason) ? reason : null;
  } catch {
    return null;
  }
}

export function createApnsClient(config: ApnsConfig, deps: ApnsDeps = {}): ApnsClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let key: CryptoKey | null = null;
  let cached: { jwt: string; iat: number } | null = null;

  const providerToken = async (nowS: number): Promise<string> => {
    if (cached && nowS - cached.iat < JWT_REUSE_S && nowS >= cached.iat) return cached.jwt;
    key ??= await crypto.subtle.importKey('pkcs8', pemToPkcs8(config.privateKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    cached = { jwt: await signApnsJwt(config, nowS, key), iat: nowS };
    return cached.jwt;
  };

  const send = async (host: ApnsHost, deviceToken: string, body: string, jwt: string, nowS: number): Promise<ApnsResult> => {
    try {
      const res = await doFetch(`${APNS_HOSTS[host]}/3/device/${deviceToken}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-push-type': 'liveactivity',
          'apns-topic': `${config.bundleId}.push-type.liveactivity`,
          'apns-priority': '10',
          'apns-expiration': String(nowS + START_EXPIRATION_S),
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true, status: res.status, reason: null, host };
      }
      return { ok: false, status: res.status, reason: await reasonOf(res), host };
    } catch (err) {
      const timeout = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { ok: false, status: 0, reason: timeout ? 'timeout' : 'network', host };
    }
  };

  return {
    async sendLiveActivityStart(deviceToken, args) {
      if (!DEVICE_TOKEN.test(deviceToken)) return { ok: false, status: 0, reason: 'BadDeviceToken', host: 'production' };
      const nowS = Math.floor(now() / 1000);
      let jwt: string;
      try {
        jwt = await providerToken(nowS);
      } catch {
        return { ok: false, status: 0, reason: 'bad_key', host: 'production' };
      }
      const body = JSON.stringify(liveActivityStartPayload({ startedAt: args.startedAt, state: args.state, nowS }));
      const first = await send('production', deviceToken, body, jwt, nowS);
      // a development build's token is the sandbox's
      if (!first.ok && first.status === 400 && first.reason === 'BadDeviceToken') return send('sandbox', deviceToken, body, jwt, nowS);
      return first;
    },
  };
}
