import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PgError } from './pg.ts';
import { createPushDb, PushDbContractError } from './push_db.ts';

/** A client whose `rpc` answers from a script, recording every call. */
function client(answers: Record<string, { data?: unknown; error?: { code: string; message: string } }>) {
  const calls: { fn: string; args: unknown }[] = [];
  const rpc = (fn: string, args: unknown) => {
    calls.push({ fn, args });
    const a = answers[fn] ?? { data: null };
    const result = Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
    return Object.assign(result, { abortSignal: () => result });
  };
  return { calls, db: createPushDb({ rpc } as unknown as SupabaseClient) };
}

const ROW = {
  inbox_id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  kind: 'league_result',
  payload: { week: '2026-W40' },
  created_at: '2026-10-05T12:00:00.000Z',
  ctx: { tz: 'America/New_York', quiet: { enabled: true, start: '22:00', end: '07:00' }, enabled: true, tokens: ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'] },
};

Deno.test('claim: rows are camel-cased; a malformed row is set aside; one without an id is counted', async () => {
  const c = client({ claim_push_batch: { data: [ROW, { inbox_id: '33333333-3333-4333-8333-333333333333', kind: 'x' }, { nothing: true }] } });
  const r = await c.db.claim(100, 300);
  assertEquals(c.calls, [{ fn: 'claim_push_batch', args: { p_limit: 100, p_lease_seconds: 300 } }]);
  assertEquals(r.items, [
    {
      inboxId: ROW.inbox_id,
      userId: ROW.user_id,
      kind: 'league_result',
      payload: { week: '2026-W40' },
      createdAt: Date.parse(ROW.created_at),
      ctx: { tz: 'America/New_York', quiet: { enabled: true, start: '22:00', end: '07:00' }, enabled: true, tokens: ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'] },
    },
  ]);
  assertEquals(r.malformed, ['33333333-3333-4333-8333-333333333333']);
  assertEquals(r.unidentified, 1);
});

Deno.test('a non-array claim is a contract error; a writer refusal is a PgError; empty lists skip the call', async () => {
  await assertRejects(() => client({ claim_push_batch: { data: { not: 'array' } } }).db.claim(10, 60), PushDbContractError);
  await assertRejects(() => client({ claim_push_batch: { error: { code: '42501', message: 'claim_push_batch requires the service role' } } }).db.claim(10, 60), PgError);
  const c = client({});
  assertEquals(await c.db.recordOutcomes([]), 0);
  assertEquals(await c.db.recordReceipts([]), 0);
  assertEquals(c.calls, []);
  const d = client({ record_push_outcomes: { data: 2 }, push_receipts_due: { data: [{ delivery_id: ROW.inbox_id, ticket_id: 't1' }] } });
  assertEquals(await d.db.recordOutcomes([{ inbox_id: ROW.inbox_id, state: 'skipped', reason: 'stale' }]), 2);
  assertEquals(await d.db.receiptsDue(300), [{ deliveryId: ROW.inbox_id, ticketId: 't1' }]);
});
