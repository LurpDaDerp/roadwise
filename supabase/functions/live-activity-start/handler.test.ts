import { assert, assertEquals } from '@std/assert';
import type { ApnsClient, ApnsResult, LiveActivityContentState } from '../_shared/apns.ts';
import { PgError } from '../_shared/pg.ts';
import { handleLiveActivityStart, type LiveActivityDeps } from './handler.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'device-0001-abcd';
const PUSH_TOKEN = 'a1'.repeat(32);
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);

const state = {
  speed: 34,
  limit: 35,
  unit: 'mph',
  speedTint: '#FFB020',
  speeding: true,
  notDrivingAvailable: true,
  weatherKind: 'heavy_rain',
  weatherText: 'Heavy rain',
  skyTop: '#0B2A5C',
  skyMid: '#123B7A',
  skyLow: '#1A4C94',
  accent: '#93A9FF',
};
const body = (over: Record<string, unknown> = {}) => ({ deviceId: DEVICE, clientTripId: TRIP, startedAt: NOW - 60_000, state, ...over });

interface Calls {
  claims: { userToken: string; deviceId: string; clientTripId: string; leg: number }[];
  releases: { userToken: string; deviceId: string; clientTripId: string; leg: number }[];
  sends: { token: string; startedAt: number; state: LiveActivityContentState }[];
  logs: unknown[][];
}

function harness(opts: { claim?: unknown | Error; release?: unknown | Error; apns?: ApnsResult | null | Error; auth?: 'good' | 'down' } = {}) {
  const calls: Calls = { claims: [], releases: [], sends: [], logs: [] };
  const apns: ApnsClient | null =
    opts.apns === null
      ? null
      : {
          sendLiveActivityStart(token, args) {
            calls.sends.push({ token, ...args });
            if (opts.apns instanceof Error) return Promise.reject(opts.apns);
            return Promise.resolve(opts.apns ?? { ok: true, status: 200, reason: null, host: 'production' });
          },
        };
  const deps: LiveActivityDeps = {
    verifyJwt: (token) => (opts.auth === 'down' ? Promise.reject(new Error('auth down')) : Promise.resolve(token === 'good' ? USER : null)),
    claim: (userToken, deviceId, clientTripId, leg) => {
      calls.claims.push({ userToken, deviceId, clientTripId, leg });
      const c = opts.claim ?? { token: PUSH_TOKEN, duplicate: false };
      return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
    },
    release: (userToken, deviceId, clientTripId, leg) => {
      calls.releases.push({ userToken, deviceId, clientTripId, leg });
      const r = opts.release === undefined ? true : opts.release;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    apns,
    now: () => NOW,
    log: { warn: (...a: unknown[]) => calls.logs.push(a), error: (...a: unknown[]) => calls.logs.push(a) },
  };
  return { calls, deps };
}

const post = (b: unknown, token = 'good', method = 'POST') =>
  new Request('http://local/functions/v1/live-activity-start', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : typeof b === 'string' ? b : JSON.stringify(b),
  });

Deno.test("sent: the caller's own token is claimed as the caller for this drive and one push goes out, without the weather line", async () => {
  const h = harness();
  const res = await handleLiveActivityStart(post(body()), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { sent: true });
  assert(res.headers.get('x-request-id'));
  assertEquals(h.calls.claims, [{ userToken: 'good', deviceId: DEVICE, clientTripId: TRIP, leg: 0 }]);
  assertEquals(h.calls.sends.length, 1);
  assertEquals(h.calls.sends[0].token, PUSH_TOKEN);
  assertEquals(h.calls.sends[0].startedAt, NOW - 60_000);
  assertEquals(h.calls.sends[0].state, { ...state, unit: 'mph', weatherKind: null, weatherText: null } as LiveActivityContentState);
});

Deno.test('a drive re-opened after a stop claims its next leg, so its Live Activity comes back; a leg left out is 0', async () => {
  const h = harness();
  assertEquals(await (await handleLiveActivityStart(post(body({ leg: 1 })), h.deps)).json(), { sent: true });
  assertEquals(await (await handleLiveActivityStart(post(body({ leg: 0 })), h.deps)).json(), { sent: true });
  assertEquals(await (await handleLiveActivityStart(post(body()), h.deps)).json(), { sent: true });
  assertEquals(h.calls.claims.map((c) => [c.clientTripId, c.leg]), [[TRIP, 1], [TRIP, 0], [TRIP, 0]]);
  // the claim decides what repeats: the same leg again within 15 minutes is its duplicate
  const dup = harness({ claim: { token: PUSH_TOKEN, duplicate: true } });
  assertEquals(await (await handleLiveActivityStart(post(body({ leg: 1 })), dup.deps)).json(), { sent: false, reason: 'duplicate' });
  assertEquals([dup.calls.claims[0].leg, dup.calls.sends.length], [1, 0]);
});

Deno.test('the optional sky colours may be left out; they go as null', async () => {
  const h = harness();
  const { skyTop: _a, skyMid: _b, skyLow: _c, accent: _d, ...plain } = state;
  assertEquals((await handleLiveActivityStart(post(body({ state: plain })), h.deps)).status, 200);
  const s = h.calls.sends[0].state;
  assertEquals([s.skyTop, s.skyMid, s.skyLow, s.accent], [null, null, null, null]);
});

Deno.test('no token, a duplicate, an Apple refusal, no APNs secrets: a plain answer, never a 5xx', async () => {
  const none = harness({ claim: { token: null, duplicate: false } });
  assertEquals(await (await handleLiveActivityStart(post(body()), none.deps)).json(), { sent: false, reason: 'no_token' });
  assertEquals(none.calls.sends, []);
  const dup = harness({ claim: { token: PUSH_TOKEN, duplicate: true } });
  assertEquals(await (await handleLiveActivityStart(post(body()), dup.deps)).json(), { sent: false, reason: 'duplicate' });
  assertEquals(dup.calls.sends, []);
  const refused = harness({ apns: { ok: false, status: 410, reason: 'Unregistered', host: 'production' } });
  const r = await handleLiveActivityStart(post(body()), refused.deps);
  assertEquals([r.status, await r.json()], [200, { sent: false, reason: 'apns_error', detail: 'Unregistered', retry: false }]);
  // nothing is claimed when there is no way to send
  const off = harness({ apns: null });
  assertEquals(await (await handleLiveActivityStart(post(body()), off.deps)).json(), { sent: false, reason: 'unconfigured' });
  assertEquals(off.calls.claims, []);
});

Deno.test("the first content state carries the drive's speed and limit as the phone sent them, and unknown ones as null (\"-\")", async () => {
  const h = harness();
  await handleLiveActivityStart(post(body({ state: { ...state, speed: 27.4, limit: 30 } })), h.deps);
  assertEquals([h.calls.sends[0].state.speed, h.calls.sends[0].state.limit], [27.4, 30]);
  await handleLiveActivityStart(post(body({ state: { ...state, speed: 0, limit: null, unit: 'km/h' } })), h.deps);
  assertEquals([h.calls.sends[1].state.speed, h.calls.sends[1].state.limit, h.calls.sends[1].state.unit], [0, null, 'km/h']);
  await handleLiveActivityStart(post(body({ state: { ...state, speed: null, limit: 120, unit: 'km/h' } })), h.deps);
  assertEquals([h.calls.sends[2].state.speed, h.calls.sends[2].state.limit], [null, 120]);
});

Deno.test('a send Apple refused or never answered hands its claim back as the caller, and says why and whether a retry can help', async () => {
  // a passing failure (no answer, Apple busy or failing): released, so a retry can send
  for (const apns of [
    { ok: false, status: 0, reason: 'timeout', host: 'production' },
    { ok: false, status: 0, reason: 'network', host: 'production' },
    { ok: false, status: 429, reason: 'TooManyRequests', host: 'production' },
    { ok: false, status: 503, reason: 'ServiceUnavailable', host: 'sandbox' },
    { ok: false, status: 500, reason: null, host: 'production' },
  ] as ApnsResult[]) {
    const h = harness({ apns });
    const res = await handleLiveActivityStart(post(body({ leg: 2 })), h.deps);
    assertEquals([res.status, await res.json()], [200, { sent: false, reason: 'apns_error', detail: apns.reason, retry: true }], JSON.stringify(apns));
    assertEquals(h.calls.releases, [{ userToken: 'good', deviceId: DEVICE, clientTripId: TRIP, leg: 2 }]);
  }
  // a refusal that will repeat (a dead token, a wrong topic, a bad key): released all the same, but no retry is worth it
  for (const apns of [
    { ok: false, status: 400, reason: 'BadDeviceToken', host: 'sandbox' },
    { ok: false, status: 400, reason: 'TopicDisallowed', host: 'production' },
    { ok: false, status: 403, reason: 'InvalidProviderToken', host: 'production' },
    { ok: false, status: 0, reason: 'bad_key', host: 'production' },
  ] as ApnsResult[]) {
    const h = harness({ apns });
    assertEquals(await (await handleLiveActivityStart(post(body()), h.deps)).json(), { sent: false, reason: 'apns_error', detail: apns.reason, retry: false });
    assertEquals(h.calls.releases.length, 1);
  }
  // a client that throws counts as nothing sent
  const threw = harness({ apns: new Error('boom') });
  assertEquals(await (await handleLiveActivityStart(post(body()), threw.deps)).json(), { sent: false, reason: 'apns_error', detail: 'network', retry: true });
  assertEquals(threw.calls.releases.length, 1);
});

Deno.test('a release that hands nothing back, or fails (0027 not applied), leaves the claim: no retry, never a 5xx, its code logged', async () => {
  const none = harness({ apns: { ok: false, status: 0, reason: 'timeout', host: 'production' }, release: false });
  assertEquals(await (await handleLiveActivityStart(post(body()), none.deps)).json(), { sent: false, reason: 'apns_error', detail: 'timeout', retry: false });
  const missing = harness({ apns: { ok: false, status: 0, reason: 'network', host: 'production' }, release: new PgError('PGRST202', 'Could not find the function') });
  const res = await handleLiveActivityStart(post(body()), missing.deps);
  assertEquals([res.status, await res.json()], [200, { sent: false, reason: 'apns_error', detail: 'network', retry: false }]);
  const text = JSON.stringify(missing.calls.logs);
  assert(text.includes('PGRST202'));
  assertEquals([text.includes(PUSH_TOKEN), text.includes(DEVICE), text.includes('good')], [false, false, false]);
});

Deno.test('nothing is released when the push went, nor when nothing was claimed', async () => {
  const sent = harness();
  await handleLiveActivityStart(post(body()), sent.deps);
  const dup = harness({ claim: { token: PUSH_TOKEN, duplicate: true } });
  await handleLiveActivityStart(post(body()), dup.deps);
  const none = harness({ claim: { token: null, duplicate: false } });
  await handleLiveActivityStart(post(body()), none.deps);
  const off = harness({ apns: null });
  await handleLiveActivityStart(post(body()), off.deps);
  assertEquals([sent.calls.releases, dup.calls.releases, none.calls.releases, off.calls.releases], [[], [], [], []]);
});

Deno.test('a detail that is not a plain code is left out', async () => {
  const h = harness({ apns: { ok: false, status: 400, reason: 'Bad Device Token!', host: 'production' } });
  assertEquals(await (await handleLiveActivityStart(post(body()), h.deps)).json(), { sent: false, reason: 'apns_error', detail: null, retry: false });
});

Deno.test('the logs never carry the push token, the device id or a position', async () => {
  const refused = harness({ apns: { ok: false, status: 400, reason: 'BadDeviceToken', host: 'sandbox' } });
  await handleLiveActivityStart(post(body()), refused.deps);
  const text = JSON.stringify(refused.calls.logs);
  assert(text.includes('BadDeviceToken'));
  assertEquals([text.includes(PUSH_TOKEN), text.includes(DEVICE)], [false, false]);
});

Deno.test('the claim\'s refusals: its hourly budget is a 429, a bad device id a 400, a rejected token a 401, drift a 500', async () => {
  const limited = await handleLiveActivityStart(post(body()), harness({ claim: new PgError('42501', 'too many requests') }).deps);
  assertEquals([limited.status, (await limited.json()).code], [429, 'too_many_requests']);
  const bad = await handleLiveActivityStart(post(body()), harness({ claim: new PgError('22023', 'device_id must be 8 to 128 characters') }).deps);
  assertEquals(bad.status, 400);
  const jwt = await handleLiveActivityStart(post(body()), harness({ claim: new PgError('PGRST301', 'JWT expired') }).deps);
  assertEquals(jwt.status, 401);
  const drift = await handleLiveActivityStart(post(body()), harness({ claim: { token: 'NOT-HEX', duplicate: false } }).deps);
  assertEquals([drift.status, (await drift.json()).code], [500, 'internal']);
  const retry = await handleLiveActivityStart(post(body()), harness({ claim: new PgError('55P03', 'lock timeout') }).deps);
  assertEquals(retry.status, 503);
});

Deno.test('refusals before any claim: method, token, size, JSON, the strict contract, a start that is not a drive in progress', async () => {
  const h = harness();
  assertEquals((await handleLiveActivityStart(post(body(), 'good', 'GET'), h.deps)).status, 405);
  assertEquals((await handleLiveActivityStart(post(body(), ''), h.deps)).status, 401);
  assertEquals((await handleLiveActivityStart(post(body(), 'bad'), h.deps)).status, 401);
  assertEquals((await handleLiveActivityStart(post(body()), harness({ auth: 'down' }).deps)).status, 503);
  assertEquals((await handleLiveActivityStart(post({ ...body(), pad: 'x'.repeat(5000) }), h.deps)).status, 413);
  assertEquals((await handleLiveActivityStart(post('{nope'), h.deps)).status, 400);
  for (const bad of [
    body({ userId: USER }),
    body({ deviceId: 'short' }),
    body({ clientTripId: 'trip' }),
    body({ startedAt: 1.5 }),
    body({ state: { ...state, unit: 'knots' } }),
    body({ state: { ...state, speedTint: 'red' } }),
    body({ state: { ...state, speed: 900 } }),
    body({ state: { ...state, speed: -1 } }),
    body({ state: { ...state, speed: '34' } }),
    body({ state: { ...state, limit: 250 } }),
    body({ state: { ...state, limit: -5 } }),
    body({ state: { ...state, limit: '35' } }),
    body({ state: { ...state, limit: undefined } }),
    body({ state: { ...state, speed: undefined } }),
    body({ state: { ...state, extra: 1 } }),
    body({ state: { ...state, weatherText: 'x'.repeat(65) } }),
    body({ startedAt: NOW - 13 * 3_600_000 }),
    body({ startedAt: NOW + 11 * 60_000 }),
    body({ leg: -1 }),
    body({ leg: 51 }),
    body({ leg: 1.5 }),
    body({ leg: '1' }),
    body({ leg: null }),
  ]) {
    assertEquals((await handleLiveActivityStart(post(bad), h.deps)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  // a number JSON reads as infinite (1e999) is not a speed or a limit
  for (const key of ['speed', 'limit']) {
    const raw = JSON.stringify(body({ state: { ...state, [key]: 7777 } })).replace('7777', '1e999');
    assertEquals((await handleLiveActivityStart(post(raw), h.deps)).status, 400, key);
  }
  assertEquals(h.calls.claims, []);
});
