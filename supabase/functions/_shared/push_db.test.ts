import { assertEquals, assertRejects } from '@std/assert';
import { createPushDb, PushDbContractError } from './push_db.ts';
import { PgError } from './pg.ts';
import { fakeSupabase, type RpcError } from './testing/fake_supabase.ts';

const INBOX = '0b9c6f0e-1f4b-4c43-9a55-2d9b8f0c1a01';
const USER = '5f1e7c3a-8d2b-4e6f-a1c9-3b7d5e9f2a04';

/** One item exactly as 0007's `claim_push_batch` returns it (task-2-report §2). */
const claimRow = (overrides: Record<string, unknown> = {}) => ({
  inbox_id: INBOX,
  user_id: USER,
  type: 'permission_lapsed',
  payload: { permission: 'location', platform: 'android', deviceId: 'dev-1' },
  created_at: '2026-09-22T18:24:17.805+00:00',
  read: false,
  dismissed: false,
  subject_gone: false,
  ctx: {
    tz: 'America/New_York',
    quiet: { enabled: true, start: '22:00', end: '07:00' },
    categories: { recording: true, rewards: false },
    driving_since: '2026-09-22T17:00:00+00:00',
    recent: [
      { type: 'permission_lapsed', pushed_at: '2026-09-21T12:00:00+00:00', lapse_key: 'dev-1:location' },
      { type: 'trip_summary', pushed_at: '2026-09-20T12:00:00+00:00' },
    ],
    local_sent_today: 1,
    tokens: ['ExponentPushToken[abc]'],
  },
  ...overrides,
});

function db(reply: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: RpcError | null }) {
  const fake = fakeSupabase({ rpc: reply });
  return { pushDb: createPushDb(fake.client), fake };
}

Deno.test('claim calls claim_push_batch with the limit and lease and camel-cases each item', async () => {
  const { pushDb, fake } = db(() => ({ data: [claimRow()] }));
  const { items, malformed, unidentified } = await pushDb.claim(100, 300);
  assertEquals([malformed, unidentified], [[], 0]);
  assertEquals(fake.rpcCalls, [{ fn: 'claim_push_batch', args: { p_limit: 100, p_lease_seconds: 300 } }]);
  assertEquals(items, [
    {
      inboxId: INBOX,
      userId: USER,
      type: 'permission_lapsed',
      payload: { permission: 'location', platform: 'android', deviceId: 'dev-1' },
      createdAt: Date.parse('2026-09-22T18:24:17.805Z'),
      read: false,
      dismissed: false,
      subjectGone: false,
      ctx: {
        tz: 'America/New_York',
        quiet: { enabled: true, start: '22:00', end: '07:00' },
        categories: { recording: true, rewards: false },
        drivingSince: Date.parse('2026-09-22T17:00:00Z'),
        // lapse_key survives the parse (zod strips unlisted keys) and stays absent where it was absent.
        recent: [
          { type: 'permission_lapsed', pushedAt: Date.parse('2026-09-21T12:00:00Z'), lapseKey: 'dev-1:location' },
          { type: 'trip_summary', pushedAt: Date.parse('2026-09-20T12:00:00Z') },
        ],
        localSentToday: 1,
        tokens: ['ExponentPushToken[abc]'],
      },
    },
  ]);
});

Deno.test('claim: an empty batch, a null driving_since and an unknown type are fine', async () => {
  assertEquals(await db(() => ({ data: [] })).pushDb.claim(100, 300), { items: [], malformed: [], unidentified: 0 });
  const row = claimRow({ type: 'something_new' });
  (row.ctx as Record<string, unknown>).driving_since = null;
  const {
    items: [item],
  } = await db(() => ({ data: [row] })).pushDb.claim(100, 300);
  assertEquals(item.type, 'something_new');
  assertEquals(item.ctx.drivingSince, null);
});

Deno.test('claim refuses an answer that is not an array', async () => {
  for (const bad of [null, { not: 'an array' }, 'x']) {
    await assertRejects(() => db(() => ({ data: bad })).pushDb.claim(100, 300), PushDbContractError);
  }
});

Deno.test('claim parses row by row: a malformed row is set aside by its inbox id and the rest proceed', async () => {
  const id = (n: number) => `0b9c6f0e-1f4b-4c43-9a55-2d9b8f0c1a${String(n).padStart(2, '0')}`;
  const good = claimRow({ inbox_id: id(10) });
  const rows = [
    claimRow({ inbox_id: id(11), created_at: 'yesterday' }),
    good,
    claimRow({ inbox_id: id(12), ctx: { ...claimRow().ctx, quiet: { enabled: true, start: '25:00', end: '07:00' } } }),
    claimRow({ inbox_id: id(13), ctx: { ...claimRow().ctx, tokens: 'ExponentPushToken[abc]' } }),
    claimRow({ inbox_id: 'nope' }),
    42,
  ];
  const out = await db(() => ({ data: rows })).pushDb.claim(100, 300);
  assertEquals(out.items.map((i) => i.inboxId), [id(10)]);
  assertEquals(out.malformed, [id(11), id(12), id(13)]);
  assertEquals(out.unidentified, 2);
});

Deno.test('every call carries the sweep abort signal when one is given', async () => {
  const seen: [string, AbortSignal | null][] = [];
  const client = {
    rpc(fn: string) {
      const settled = Promise.resolve({ data: fn === 'claim_push_batch' || fn === 'push_receipts_due' ? [] : 1, error: null });
      return Object.assign(settled, {
        abortSignal: (s: AbortSignal) => {
          seen.push([fn, s]);
          return settled;
        },
      });
    },
  } as unknown as Parameters<typeof createPushDb>[0];
  const pushDb = createPushDb(client);
  const signal = new AbortController().signal;
  await pushDb.claim(1, 30, signal);
  await pushDb.recordOutcomes([{ inbox_id: INBOX, state: 'skipped', reason: 'stale' }], signal);
  await pushDb.receiptsDue(1, signal);
  await pushDb.recordReceipts([{ delivery_id: INBOX, status: null, error: null }], signal);
  assertEquals(
    seen.map(([fn, s]) => [fn, s === signal]),
    [
      ['claim_push_batch', true],
      ['record_push_outcomes', true],
      ['push_receipts_due', true],
      ['record_push_receipts', true],
    ]
  );
});

Deno.test('a writer error becomes a PgError with its code and message', async () => {
  const { pushDb } = db(() => ({ error: { code: '22023', message: 'lease must be between 30 and 3600 seconds' } }));
  const err = await assertRejects(() => pushDb.claim(100, 10), PgError);
  assertEquals([err.code, err.message], ['22023', 'lease must be between 30 and 3600 seconds']);
});

Deno.test('recordOutcomes sends { outcomes } to record_push_outcomes and returns the count', async () => {
  const { pushDb, fake } = db(() => ({ data: 2 }));
  const outcomes = [
    { inbox_id: INBOX, state: 'deferred' as const, reason: 'driving' as const, push_after: '2026-09-22T19:05:00.000Z' },
    {
      inbox_id: USER,
      state: 'sent' as const,
      reason: 'ok' as const,
      deliveries: [{ token: 'ExponentPushToken[abc]', ticket_id: 't-1' }],
    },
  ];
  assertEquals(await pushDb.recordOutcomes(outcomes), 2);
  assertEquals(fake.rpcCalls, [{ fn: 'record_push_outcomes', args: { p: { outcomes } } }]);
});

Deno.test('recordOutcomes with nothing to record makes no call', async () => {
  const { pushDb, fake } = db(() => ({ data: 0 }));
  assertEquals(await pushDb.recordOutcomes([]), 0);
  assertEquals(fake.rpcCalls.length, 0);
});

Deno.test('receiptsDue and recordReceipts map to their writers', async () => {
  const { pushDb, fake } = db((fn) =>
    fn === 'push_receipts_due'
      ? { data: [{ delivery_id: INBOX, ticket_id: 'ticket-1' }] }
      : { data: 1 }
  );
  assertEquals(await pushDb.receiptsDue(300), [{ deliveryId: INBOX, ticketId: 'ticket-1' }]);
  const receipts = [{ delivery_id: INBOX, status: null, error: null }];
  assertEquals(await pushDb.recordReceipts(receipts), 1);
  assertEquals(fake.rpcCalls, [
    { fn: 'push_receipts_due', args: { p_limit: 300 } },
    { fn: 'record_push_receipts', args: { p: { receipts } } },
  ]);
  assertEquals(await pushDb.recordReceipts([]), 0);
  assertEquals(fake.rpcCalls.length, 2);
});

Deno.test('receiptsDue refuses a malformed answer', async () => {
  await assertRejects(() => db(() => ({ data: [{ delivery_id: INBOX }] })).pushDb.receiptsDue(300), PushDbContractError);
  await assertRejects(() => db(() => ({ data: 'x' })).pushDb.recordReceipts([{ delivery_id: INBOX, status: 'ok', error: null }]), PushDbContractError);
});
