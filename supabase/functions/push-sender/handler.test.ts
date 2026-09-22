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
  SIGNATURE_WINDOW_S,
  verifySweepSignature,
  type SenderDeps,
} from './handler.ts';

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

type ExpoReply = (path: string, body: unknown) => Response;

/** Every message accepted; every receipt ok. */
const expoOk: ExpoReply = (path, body) =>
  path.endsWith('/send')
    ? Response.json({ data: (body as { to: string }[]).map((m, i) => ({ status: 'ok', id: `ticket-${i}-${m.to.slice(-4, -1)}` })) })
    : Response.json({ data: Object.fromEntries((body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }])) });

function harness(opts: Omit<FakePushDbOptions, 'now'> & { expo?: ExpoReply; now?: number } = {}) {
  const now = opts.now ?? NOW;
  const fake = fakePushDb({ ...opts, now: () => now });
  const expoCalls: ExpoCall[] = [];
  const reply = opts.expo ?? expoOk;
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = JSON.parse(String(init?.body));
    expoCalls.push({ url: String(input), headers, body });
    return Promise.resolve(reply(String(input), body));
  };
  const logs: unknown[][] = [];
  const deps: SenderDeps = {
    hmacKey: KEY,
    db: fake.db,
    expo: { fetch: fetch as typeof globalThis.fetch, url: 'http://expo.test/push', accessToken: 'expo-access' },
    now: () => now,
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
  assertEquals(await verifySweepSignature(VECTOR, KEY, NOW), true);
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
    assertEquals(await verifySweepSignature(sig, KEY, now), false, name);
  }
});

Deno.test('the window is ±120 s inclusive', async () => {
  assertEquals(SIGNATURE_WINDOW_S, 120);
  assertEquals(await verifySweepSignature(VECTOR, KEY, NOW + 120_000), true);
  assertEquals(await verifySweepSignature(VECTOR, KEY, NOW - 120_000), true);
  assertEquals(await verifySweepSignature(VECTOR, KEY, NOW + 120_999), true); // still 120 whole seconds
  assertEquals(await verifySweepSignature(VECTOR, KEY, NOW + 121_000), false);
  assertEquals(await verifySweepSignature(await sign(TS + 60), KEY, NOW), true);
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
