import { assert, assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { PushDbContractError } from '../_shared/push_db.ts';
import type { PushItem } from '../_shared/push_policy.ts';
import { fakePushDb, pushItem, type FakePushDbOptions } from '../_shared/testing/fake_push_db.ts';
import {
  CLAIM_LIMIT,
  createPushSender,
  EXPO_RETRY_MS,
  LEASE_SECONDS,
  RECEIPT_LIMIT,
  OUTCOME_RESERVE_MS,
  RECEIPTS_MIN_MS,
  SWEEP_BUDGET_MS,
  SWEEP_PURPOSE,
  type SenderDeps,
} from './handler.ts';
import { SWEEP_WINDOW_S, verifySweepSignature } from '../_shared/sweep_auth.ts';
import { EXPO_TIMEOUT_MAX_MS } from '../_shared/expo_push.ts';

/** push-sender's check, through the shared contract: its purpose, the key, whole seconds. */
const verify = (sig: string | null, key: string, nowMs: number) =>
  verifySweepSignature(sig, SWEEP_PURPOSE, key, Math.floor(nowMs / 1000));

// The test vector from task-2-report.md "fix round 1", computed there independently with Python.
const KEY = 'rw-test-vector-key-0123456789abcdef';
const TS = 1790000000;
const VECTOR = '1790000000.c1ba00cabb1bd464447aaa98eb43cd7fffaaee9cf3809292c15c696632ca752f';
/** 07:13:20 in Los Angeles: outside the default quiet hours. */
const NOW = TS * 1000;
const MIN = 60_000;
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const USER_2 = '22222222-2222-4222-8222-222222222222';

/** An independent signer for timestamps other than the vector's. */
async function sign(ts: number | string, key = KEY): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`push-sender-sweep:${ts}`)));
  return `${ts}.${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface ExpoCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type ExpoReply = (path: string, body: unknown, signal?: AbortSignal | null) => Response | Promise<Response>;

/** An Expo that never answers: the request hangs until its timeout aborts it. */
const hang: ExpoReply = (_path, _body, signal) =>
  new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

/** Every message accepted; every receipt ok. */
const expoOk: ExpoReply = (path, body) =>
  path.endsWith('/send')
    ? Response.json({ data: (body as { to: string }[]).map((m, i) => ({ status: 'ok', id: `ticket-${i}-${m.to.slice(-4, -1)}` })) })
    : Response.json({ data: Object.fromEntries((body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }])) });

function harness(
  opts: Omit<FakePushDbOptions, 'now'> & { expo?: ExpoReply; now?: number; budgetMs?: number } = {}
) {
  const now = opts.now ?? NOW;
  const fake = fakePushDb({ ...opts, now: () => now });
  const expoCalls: ExpoCall[] = [];
  const reply = opts.expo ?? expoOk;
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = JSON.parse(String(init?.body));
    expoCalls.push({ url: String(input), headers, body });
    return Promise.resolve().then(() => reply(String(input), body, init?.signal));
  };
  const logs: unknown[][] = [];
  const deps: SenderDeps = {
    hmacKey: KEY,
    db: fake.db,
    expo: { fetch: fetch as typeof globalThis.fetch, url: 'http://expo.test/push', accessToken: 'expo-access' },
    now: () => now,
    budgetMs: opts.budgetMs,
    log: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
  };
  return { handle: createPushSender(deps), fake, expoCalls, logs };
}

const sweep = (sig: string | null, init: RequestInit = {}) =>
  new Request('http://local/functions/v1/push-sender', {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(sig === null ? {} : { 'x-sweep-signature': sig }),
    },
    body: init.method === 'GET' ? undefined : (init.body ?? '{"reason":"sweep"}'),
  });

const item = (overrides: Partial<PushItem> = {}, ctx: Partial<PushItem['ctx']> = {}) =>
  pushItem({ createdAt: NOW - 10 * MIN, ...overrides }, ctx);

const iso = (ms: number) => new Date(ms).toISOString();

/** Nothing secret, personal or rendered may reach a log line. */
function assertCleanLogs(logs: unknown[][], secrets: string[]) {
  const text = JSON.stringify(logs);
  for (const s of secrets) assert(!text.includes(s), `a log line carries ${s}`);
}

const SECRETS = [
  KEY,
  VECTOR,
  VECTOR.split('.')[1],
  TOKEN_A,
  TOKEN_B,
  'aaaaaaaaaaaaaaaaaaaaaa',
  'phone-a',
  'Automatic recording is off',
  "RoadWise can't start drives",
  'expo-access',
];

// ——— authentication ———

Deno.test('the test vector is accepted', async () => {
  assertEquals(await verify(VECTOR, KEY, NOW), true);
  const h = harness();
  const res = await h.handle(sweep(VECTOR));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0, receipts: 0 });
  assertEquals(h.fake.calls.map((c) => c.fn), ['claim', 'receiptsDue']);
  assertEquals(h.fake.calls[0].args, { limit: CLAIM_LIMIT, leaseSeconds: LEASE_SECONDS });
  assertEquals([CLAIM_LIMIT, LEASE_SECONDS, RECEIPT_LIMIT], [100, 300, 300]);
  assertEquals(h.fake.calls[1].args, { limit: 300 });
  assertCleanLogs(h.logs, SECRETS);
});

Deno.test('401 before any database call: missing, malformed, 121 s stale either way, one wrong digit, another key', async () => {
  const hex = VECTOR.split('.')[1];
  const flipped = `${TS}.${hex.slice(0, 10)}${hex[10] === '0' ? '1' : '0'}${hex.slice(11)}`;
  const cases: [string, string | null, number][] = [
    ['missing', null, NOW],
    ['empty', '', NOW],
    ['no dot', `${TS}${hex}`, NOW],
    ['no signature', `${TS}.`, NOW],
    ['not a number', `abc.${hex}`, NOW],
    ['signed ts', `+${TS}.${hex}`, NOW],
    ['13 digits', `1${'0'.repeat(12)}.${hex}`, NOW],
    ['upper-case hex', `${TS}.${hex.toUpperCase()}`, NOW],
    ['short hex', `${TS}.${hex.slice(0, 63)}`, NOW],
    ['long hex', `${TS}.${hex}0`, NOW],
    ['extra part', `${VECTOR}.1`, NOW],
    ['121 s stale', VECTOR, NOW + 121_000],
    ['121 s ahead', VECTOR, NOW - 121_000],
    ['one wrong digit', flipped, NOW],
    ['another key', await sign(TS, 'another-key-of-at-least-32-bytes-xx'), NOW],
  ];
  for (const [name, sig, now] of cases) {
    const h = harness({ now, items: [item()] });
    const res = await h.handle(sweep(sig));
    assertEquals(res.status, 401, name);
    assertEquals(await res.json(), { code: 'unauthorized' }, name);
    assertEquals(h.fake.calls, [], `${name}: no database call`);
    assertEquals(h.expoCalls, [], `${name}: no Expo call`);
    assertCleanLogs(h.logs, [...SECRETS, ...(sig ? [sig.trim()] : [])]);
    assertEquals(await verify(sig, KEY, now), false, name);
  }
});

Deno.test('the window is ±120 s inclusive', async () => {
  assertEquals(SWEEP_WINDOW_S, 120);
  assertEquals(await verify(VECTOR, KEY, NOW + 120_000), true);
  assertEquals(await verify(VECTOR, KEY, NOW - 120_000), true);
  assertEquals(await verify(VECTOR, KEY, NOW + 120_999), true); // still 120 whole seconds
  assertEquals(await verify(VECTOR, KEY, NOW + 121_000), false);
  assertEquals(await verify(await sign(TS + 60), KEY, NOW), true);
});

Deno.test('405 for any method but POST, after the signature and before any database call', async () => {
  const h = harness({ items: [item()] });
  const res = await h.handle(sweep(VECTOR, { method: 'GET' }));
  assertEquals(res.status, 405);
  assertEquals(await res.json(), { code: 'method_not_allowed' });
  assertEquals(h.fake.calls, []);
  const unsigned = await harness().handle(sweep(null, { method: 'GET' }));
  assertEquals(unsigned.status, 401);
});

Deno.test('the body is ignored: any body, or none, runs the same sweep', async () => {
  for (const body of ['not json', '{"reason":"steal","inbox_ids":["x"],"tokens":["y"]}', 'x'.repeat(100_000)]) {
    const h = harness({ items: [item()] });
    const res = await h.handle(sweep(VECTOR, { body }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).sent, 1);
  }
});

Deno.test('every response carries a fresh x-request-id', async () => {
  const res = await harness().handle(sweep(null));
  assert(/^[0-9a-f-]{36}$/.test(res.headers.get('x-request-id') ?? ''));
});

// ——— the sweep ———

Deno.test('happy path: every token gets the rendered message, outcomes record the tickets, the response is counts only', async () => {
  const a = item({}, { tokens: [TOKEN_A] });
  const b = item({ userId: USER_2, payload: { permission: 'motion', platform: 'android', deviceId: 'phone-b' } }, { tokens: [TOKEN_B] });
  const h = harness({ items: [a, b] });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 2, sent: 2, deferred: 0, skipped: 0, failed: 0, receipts: 0 });

  assertEquals(h.expoCalls.length, 1);
  assertEquals(h.expoCalls[0].url, 'http://expo.test/push/send');
  assertEquals(h.expoCalls[0].headers['authorization'], 'Bearer expo-access');
  assertEquals(h.expoCalls[0].body, [
    {
      to: TOKEN_A,
      title: 'Automatic recording is off',
      body: "RoadWise can't start drives on its own right now. Tap to fix it.",
      data: { inboxId: a.inboxId, url: '/permissions' },
      sound: 'default',
      priority: 'default',
      channelId: 'recording_problems',
    },
    {
      to: TOKEN_B,
      title: 'Drive detection needs attention',
      body: 'Motion access is off, so drives are harder to detect. Tap to fix it.',
      data: { inboxId: b.inboxId, url: '/permissions' },
      sound: 'default',
      priority: 'default',
      channelId: 'recording_problems',
    },
  ]);
  assertEquals(h.fake.outcomes, [
    { inbox_id: a.inboxId, state: 'sent', reason: 'ok', deliveries: [{ token: TOKEN_A, ticket_id: 'ticket-0-aaa' }] },
    { inbox_id: b.inboxId, state: 'sent', reason: 'ok', deliveries: [{ token: TOKEN_B, ticket_id: 'ticket-1-bbb' }] },
  ]);
  assertEquals(h.fake.calls.map((c) => c.fn), ['claim', 'recordOutcomes', 'receiptsDue']);
  // The log names the inbox ids and reason codes, never a token, title, body or payload.
  const text = JSON.stringify(h.logs);
  assert(text.includes(a.inboxId) && text.includes('"ok"'));
  assertCleanLogs(h.logs, [...SECRETS, 'phone-b', 'Motion access']);
});

Deno.test('a deferral is recorded with push_after (never deliver_after) and nothing is sent', async () => {
  const driving = item({}, { drivingSince: NOW - 5 * 3_600_000 });
  const h = harness({ items: [driving] });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(await res.json(), { claimed: 1, sent: 0, deferred: 1, skipped: 0, failed: 0, receipts: 0 });
  assertEquals(h.fake.outcomes, [{ inbox_id: driving.inboxId, state: 'deferred', reason: 'driving', push_after: iso(NOW + 5 * MIN) }]);
  assert(!JSON.stringify(h.fake.calls).includes('deliver_after'));
  assertEquals(h.expoCalls, []);
});

Deno.test('skips are recorded with their reason: a local trip summary, a read item, a lapse that was fixed', async () => {
  const local = item({ type: 'trip_summary', payload: {} });
  const read = item({ read: true });
  const fixed = item({ subjectGone: true });
  const h = harness({ items: [local, read, fixed] });
  assertEquals(await (await h.handle(sweep(VECTOR))).json(), {
    claimed: 3,
    sent: 0,
    deferred: 0,
    skipped: 3,
    failed: 0,
    receipts: 0,
  });
  assertEquals(
    h.fake.outcomes.map((o) => [o.inbox_id, o.state, o.reason]),
    [
      [local.inboxId, 'skipped', 'local'],
      [read.inboxId, 'skipped', 'already_read'],
      [fixed.inboxId, 'skipped', 'subject_gone'],
    ]
  );
});

Deno.test('the daily cap defers a lapse to the next local day, across the batch', async () => {
  const first = item({ payload: { permission: 'location', platform: 'ios', deviceId: 'phone-a' } }, { localSentToday: 1 });
  const second = item({ payload: { permission: 'motion', platform: 'ios', deviceId: 'phone-a' } }, { localSentToday: 1 });
  const h = harness({ items: [first, second] });
  assertEquals((await (await h.handle(sweep(VECTOR))).json()).sent, 1);
  // Midnight Sep 22 is in quiet hours: the first slot is 07:00 PDT, 14:00Z.
  assertEquals(h.fake.outcomes[1], {
    inbox_id: second.inboxId,
    state: 'deferred',
    reason: 'capped',
    push_after: '2026-09-22T14:00:00.000Z',
  });
});

Deno.test('DeviceNotRegistered is recorded per token; the item is sent while one token took it', async () => {
  const both = item({}, { tokens: [TOKEN_A, TOKEN_B] });
  const h = harness({
    items: [both],
    expo: () =>
      Response.json({
        data: [
          { status: 'error', message: `"${TOKEN_A}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } },
          { status: 'ok', id: 'ticket-b' },
        ],
      }),
  });
  assertEquals((await (await h.handle(sweep(VECTOR))).json()).sent, 1);
  assertEquals(h.fake.outcomes, [
    {
      inbox_id: both.inboxId,
      state: 'sent',
      reason: 'ok',
      deliveries: [
        { token: TOKEN_A, error: 'DeviceNotRegistered' },
        { token: TOKEN_B, ticket_id: 'ticket-b' },
      ],
    },
  ]);
  assertCleanLogs(h.logs, SECRETS);
});

Deno.test('every token errored → failed/expo_error, with each error recorded', async () => {
  const it = item({}, { tokens: [TOKEN_A, TOKEN_B] });
  const h = harness({
    items: [it],
    expo: () =>
      Response.json({
        data: [
          { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
          { status: 'error', message: 'y', details: { error: 'MessageRateExceeded' } },
        ],
      }),
  });
  assertEquals(await (await h.handle(sweep(VECTOR))).json(), {
    claimed: 1,
    sent: 0,
    deferred: 0,
    skipped: 0,
    failed: 1,
    receipts: 0,
  });
  assertEquals(h.fake.outcomes, [
    {
      inbox_id: it.inboxId,
      state: 'failed',
      reason: 'expo_error',
      deliveries: [
        { token: TOKEN_A, error: 'DeviceNotRegistered' },
        { token: TOKEN_B, error: 'MessageRateExceeded' },
      ],
    },
  ]);
});

Deno.test('Expo 503 → every would-be send is deferred 2 minutes as expo_unavailable; other outcomes stand', async () => {
  const would = item();
  const skipped = item({ dismissed: true });
  const h = harness({ items: [would, skipped], expo: () => new Response('unavailable', { status: 503 }) });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 2, sent: 0, deferred: 1, skipped: 1, failed: 0, receipts: 0 });
  assertEquals(EXPO_RETRY_MS, 2 * MIN);
  assertEquals(h.fake.outcomes, [
    { inbox_id: would.inboxId, state: 'deferred', reason: 'expo_unavailable', push_after: iso(NOW + 2 * MIN) },
    { inbox_id: skipped.inboxId, state: 'skipped', reason: 'dismissed' },
  ]);
});

Deno.test('Expo down on the second chunk: the first chunk is recorded as sent and never re-sent', async () => {
  // 60 users with two tokens each: 120 messages, two /send chunks (items 0–49, then 50–59).
  const items = Array.from({ length: 60 }, (_, i) =>
    item({ userId: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` }, { tokens: [TOKEN_A, TOKEN_B] })
  );
  let n = 0;
  const h = harness({
    items,
    expo: (path, body) => (path.endsWith('/send') && n++ === 1 ? new Response('', { status: 502 }) : expoOk(path, body)),
  });
  assertEquals(await (await h.handle(sweep(VECTOR))).json(), {
    claimed: 60,
    sent: 50,
    deferred: 10,
    skipped: 0,
    failed: 0,
    receipts: 0,
  });
  assertEquals(h.expoCalls.length, 2);
  assertEquals(h.fake.outcomes[49].state, 'sent');
  assertEquals(h.fake.outcomes[49].deliveries?.length, 2);
  assertEquals(h.fake.outcomes[50], {
    inbox_id: items[50].inboxId,
    state: 'deferred',
    reason: 'expo_unavailable',
    push_after: iso(NOW + 2 * MIN),
  });
});

Deno.test('a writer refusal (22023) answers 400 invalid_envelope', async () => {
  const h = harness({
    items: [item()],
    fail: { recordOutcomes: new PgError('22023', 'deferred outcome needs push_after within 7 days') },
  });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { code: 'invalid_envelope' });
  assertCleanLogs(h.logs, SECRETS);
});

Deno.test('claim output outside the contract answers 500 internal; a retryable failure 503', async () => {
  const drift = harness({ fail: { claim: new PushDbContractError('claim_push_batch') } });
  const res = await drift.handle(sweep(VECTOR));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { code: 'internal' });
  const busy = harness({ fail: { claim: new PgError('40001', 'could not serialize access') } });
  assertEquals((await busy.handle(sweep(VECTOR))).status, 503);
});

// ——— receipts ———

Deno.test('receipts: every due id is reported, found or not', async () => {
  const due = [
    { deliveryId: 'aaaaaaaa-0000-4000-8000-000000000001', ticketId: 'ticket-ok' },
    { deliveryId: 'aaaaaaaa-0000-4000-8000-000000000002', ticketId: 'ticket-gone' },
    { deliveryId: 'aaaaaaaa-0000-4000-8000-000000000003', ticketId: 'ticket-not-ready' },
  ];
  const h = harness({
    due,
    expo: (path) =>
      path.endsWith('/getReceipts')
        ? Response.json({
            data: {
              'ticket-ok': { status: 'ok' },
              'ticket-gone': { status: 'error', message: 'quotes a token', details: { error: 'DeviceNotRegistered' } },
            },
          })
        : Response.json({ data: [] }),
  });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(await res.json(), { claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0, receipts: 3 });
  assertEquals(h.expoCalls.map((c) => c.body), [{ ids: ['ticket-ok', 'ticket-gone', 'ticket-not-ready'] }]);
  assertEquals(h.fake.receipts, [
    { delivery_id: due[0].deliveryId, status: 'ok', error: null },
    { delivery_id: due[1].deliveryId, status: 'error', error: 'DeviceNotRegistered' },
    { delivery_id: due[2].deliveryId, status: null, error: null },
  ]);
  assertEquals(h.fake.calls.map((c) => c.fn), ['claim', 'receiptsDue', 'recordReceipts']);
});

Deno.test('receipts while Expo is down are reported as not ready (null), so they back off', async () => {
  const due = [{ deliveryId: 'aaaaaaaa-0000-4000-8000-000000000001', ticketId: 'ticket-1' }];
  const h = harness({ due, expo: () => new Response('', { status: 503 }) });
  assertEquals((await h.handle(sweep(VECTOR))).status, 200);
  assertEquals(h.fake.receipts, [{ delivery_id: due[0].deliveryId, status: null, error: null }]);
});

// ——— no overlap ———

Deno.test('a sweep that arrives while one is running returns at once without touching the database', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const h = harness({ items: [item()], claimGate: gate });
  const first = h.handle(sweep(VECTOR));
  await new Promise((r) => setTimeout(r, 0));
  const second = await h.handle(sweep(VECTOR));
  assertEquals(second.status, 409);
  assertEquals(await second.json(), { code: 'sweep_running' });
  assertEquals(h.fake.calls.filter((c) => c.fn === 'claim').length, 1);
  open();
  assertEquals((await first).status, 200);
  // Released afterwards.
  assertEquals((await h.handle(sweep(VECTOR))).status, 200);
});

// ——— fix round 1 ———

Deno.test('m1: an Expo timeout after the request went out is ambiguous — recorded sent with no ticket, never re-sent', async () => {
  const it = item({}, { tokens: [TOKEN_A, TOKEN_B] });
  // A 3.2 s budget leaves 1.2 s for Expo after the outcome reserve: the request times out.
  const h = harness({ items: [it], expo: hang, budgetMs: OUTCOME_RESERVE_MS + 1_200 });
  const t0 = performance.now();
  const res = await h.handle(sweep(VECTOR));
  assert(performance.now() - t0 < OUTCOME_RESERVE_MS + 1_200, 'the sweep stays inside its budget');
  assertEquals(await res.json(), { claimed: 1, sent: 1, deferred: 0, skipped: 0, failed: 0, receipts: 0 });
  assertEquals(h.fake.outcomes, [
    { inbox_id: it.inboxId, state: 'sent', reason: 'ok', deliveries: [{ token: TOKEN_A }, { token: TOKEN_B }] },
  ]);
  assertCleanLogs(h.logs, SECRETS);
});

Deno.test('m1: a reset after the request went out is ambiguous; a later chunk never attempted is deferred', async () => {
  // 60 users × 2 tokens = two /send chunks. The first is reset mid-request, the second never starts.
  const items = Array.from({ length: 60 }, (_, i) =>
    item({ userId: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}` }, { tokens: [TOKEN_A, TOKEN_B] })
  );
  const h = harness({
    items,
    expo: () => {
      throw new TypeError('fetch failed', {
        cause: new Error(
          'error sending request for url (https://exp.host/--/api/v2/push/send): client error (SendRequest): connection closed before message completed'
        ),
      });
    },
  });
  assertEquals(await (await h.handle(sweep(VECTOR))).json(), {
    claimed: 60,
    sent: 50,
    deferred: 10,
    skipped: 0,
    failed: 0,
    receipts: 0,
  });
  assertEquals(h.expoCalls.length, 1);
  assertEquals(h.fake.outcomes[0].deliveries, [{ token: TOKEN_A }, { token: TOKEN_B }]);
  assertEquals(h.fake.outcomes[50], {
    inbox_id: items[50].inboxId,
    state: 'deferred',
    reason: 'expo_unavailable',
    push_after: iso(NOW + 2 * MIN),
  });
});

Deno.test('m1: a failure proven before sending (connection refused, DNS) defers 2 minutes', async () => {
  for (const cause of [
    'error sending request for url (https://exp.host/--/api/v2/push/send): client error (Connect): tcp connect error: No connection could be made because the target machine actively refused it. (os error 10061)',
    'error sending request for url (https://exp.host/--/api/v2/push/send): client error (Connect): dns error: No such host is known. (os error 11001)',
  ]) {
    const it = item();
    const h = harness({
      items: [it],
      expo: () => {
        throw new TypeError('fetch failed', { cause: new Error(cause) });
      },
    });
    assertEquals((await (await h.handle(sweep(VECTOR))).json()).deferred, 1);
    assertEquals(h.fake.outcomes, [
      { inbox_id: it.inboxId, state: 'deferred', reason: 'expo_unavailable', push_after: iso(NOW + 2 * MIN) },
    ]);
  }
});

Deno.test('m2: a malformed claimed row is failed on its own and the rest of the batch proceeds', async () => {
  const good = item();
  const badId = '55555555-5555-4555-8555-555555555555';
  const h = harness({ items: [good], malformed: [badId], unidentified: 1 });
  assertEquals(await (await h.handle(sweep(VECTOR))).json(), {
    claimed: 3,
    sent: 1,
    deferred: 0,
    skipped: 0,
    failed: 2,
    receipts: 0,
  });
  assertEquals(
    h.fake.outcomes.map((o) => [o.inbox_id, o.state, o.reason]),
    [
      [good.inboxId, 'sent', 'ok'],
      [badId, 'failed', 'bad_payload'],
    ]
  );
});

Deno.test('m4: recordOutcomes is retried once on a retryable code, and only once', async () => {
  const it = item();
  const once = harness({ items: [it], failOnce: { recordOutcomes: new PgError('40001', 'could not serialize access') } });
  assertEquals((await once.handle(sweep(VECTOR))).status, 200);
  assertEquals(once.fake.calls.filter((c) => c.fn === 'recordOutcomes').length, 2);
  assertEquals(once.fake.outcomes.map((o) => o.state), ['sent']);
  assertEquals(once.expoCalls.length, 1); // the push itself is not repeated

  const always = harness({ items: [item()], fail: { recordOutcomes: new PgError('40P01', 'deadlock detected') } });
  assertEquals((await always.handle(sweep(VECTOR))).status, 503);
  assertEquals(always.fake.calls.filter((c) => c.fn === 'recordOutcomes').length, 2);

  const refused = harness({ items: [item()], failOnce: { recordOutcomes: new PgError('22023', 'unknown outcome reason') } });
  assertEquals((await refused.handle(sweep(VECTOR))).status, 400);
  assertEquals(refused.fake.calls.filter((c) => c.fn === 'recordOutcomes').length, 1); // no retry of a refusal
});

Deno.test('budget: the sweep stays under 8 s with the Expo timeout sized inside it', () => {
  assertEquals(SWEEP_BUDGET_MS, 8_000);
  assert(EXPO_TIMEOUT_MAX_MS + OUTCOME_RESERVE_MS <= SWEEP_BUDGET_MS);
  assert(SWEEP_BUDGET_MS < 10_000, "under pg_net's 10 s client timeout");
});

Deno.test('budget: a slow claim leaves no time to send — the sends wait for the next sweep, unsent', async () => {
  const it = item();
  // Budget 2.6 s; the claim takes 1 s, leaving 1.6 s − the 2 s reserve: no send can start.
  const h = harness({ items: [it], delayMs: { claim: 1_000 }, budgetMs: OUTCOME_RESERVE_MS + 600 });
  const res = await h.handle(sweep(VECTOR));
  assertEquals(await res.json(), { claimed: 1, sent: 0, deferred: 1, skipped: 0, failed: 0, receipts: 0 });
  assertEquals(h.expoCalls, []);
  assertEquals(h.fake.outcomes, [
    { inbox_id: it.inboxId, state: 'deferred', reason: 'expo_unavailable', push_after: iso(NOW) },
  ]);
  // Receipts are not read with under RECEIPTS_MIN_MS left.
  assertEquals(h.fake.calls.map((c) => c.fn), ['claim', 'recordOutcomes']);
  assert(RECEIPTS_MIN_MS > 0);
});

Deno.test('budget: a database call that outlives the budget is aborted and the sweep answers inside it', async () => {
  const h = harness({ items: [item()], delayMs: { claim: 5_000 }, budgetMs: 300 });
  const t0 = performance.now();
  const res = await h.handle(sweep(VECTOR));
  assert(performance.now() - t0 < 1_000, 'aborted at the budget, not after the slow call');
  assertEquals(res.status, 500);
  assertEquals(h.expoCalls, []);
});

Deno.test('budget: slow receipts are cut at the budget and reported as not ready', async () => {
  const due = [{ deliveryId: 'aaaaaaaa-0000-4000-8000-000000000009', ticketId: 'ticket-9' }];
  const budgetMs = RECEIPTS_MIN_MS + 1_000;
  const h = harness({ due, expo: hang, budgetMs });
  const t0 = performance.now();
  assertEquals((await h.handle(sweep(VECTOR))).status, 200);
  assert(performance.now() - t0 < budgetMs, 'the sweep stays inside its budget');
  assertEquals(h.fake.receipts, [{ delivery_id: due[0].deliveryId, status: null, error: null }]);
});
