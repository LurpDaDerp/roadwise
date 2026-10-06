// The database port push-sender talks to: 0005's service-role writers, called by name through the
// Data API, and nothing else — no table is read directly, so every rule about which rows are due,
// what a lease is and which token belongs to whom stays in SQL.
//
// Every answer is zod-parsed against that contract. The claim is parsed ROW BY ROW: the claim has
// already moved every row to `sending`, so one malformed row must not cost the others their push —
// it comes back in `malformed` (to be recorded `failed/bad_payload`) and the rest are decided
// normally. An answer that is not an array at all, or any other writer's answer outside its
// contract, is a `PushDbContractError` (server-side drift, answered 500). A writer's refusal is a
// `PgError` with its SQLSTATE and fixed message, which `pgFailure` maps.
//
// Every call takes the sweep's abort signal, so a slow database cannot hold a sweep past its budget.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { asPgError } from './pg.ts';
import type { PushItem } from './push_policy.ts';

/** `record_push_outcomes`' reasons (`^[a-z_]{1,32}$`), in one place. */
export type OutcomeReason =
  | 'ok'
  | 'quiet_hours'
  | 'expo_unavailable'
  | 'category_off'
  | 'no_device'
  | 'stale'
  | 'unknown_type'
  | 'bad_payload'
  | 'expo_error';

export interface Delivery {
  token?: string;
  ticket_id?: string;
  error?: string;
}

/** One `record_push_outcomes` outcome. A `deferred` one carries `push_after`. */
export interface Outcome {
  inbox_id: string;
  state: 'sent' | 'deferred' | 'skipped' | 'failed';
  reason: OutcomeReason;
  /** ISO, at most now + 7 days; required for `deferred`. */
  push_after?: string;
  deliveries?: Delivery[];
}

export interface DueReceipt {
  deliveryId: string;
  ticketId: string;
}

/** One `record_push_receipts` receipt; `status: null` means Expo had no receipt yet. */
export interface ReceiptReport {
  delivery_id: string;
  status: 'ok' | 'error' | null;
  error: string | null;
}

export interface ClaimResult {
  items: PushItem[];
  /** Inbox ids of claimed rows that broke the contract (each still `sending`, to be failed). */
  malformed: string[];
  /** Claimed rows so broken they have no inbox id; the lease expiry fails them. */
  unidentified: number;
}

export interface PushDb {
  claim(limit: number, leaseSeconds: number, signal?: AbortSignal): Promise<ClaimResult>;
  recordOutcomes(outcomes: Outcome[], signal?: AbortSignal): Promise<number>;
  receiptsDue(limit: number, signal?: AbortSignal): Promise<DueReceipt[]>;
  recordReceipts(receipts: ReceiptReport[], signal?: AbortSignal): Promise<number>;
}

/** A writer answered with something its contract does not allow. */
export class PushDbContractError extends Error {
  constructor(fn: string) {
    super(`${fn} answered outside its contract`);
    this.name = 'PushDbContractError';
  }
}

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Instant = z
  .string()
  .transform((s) => Date.parse(s))
  .refine((ms) => Number.isFinite(ms), 'not a timestamp');
const HhMm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

const ClaimRow = z
  .object({
    inbox_id: Uuid,
    user_id: Uuid,
    kind: z.string().min(1).max(64),
    payload: z.unknown(),
    created_at: Instant,
    ctx: z.object({
      tz: z.string().min(1).max(64),
      quiet: z.object({ enabled: z.boolean(), start: HhMm, end: HhMm }),
      enabled: z.boolean(),
      tokens: z.array(z.string().min(1).max(256)).max(10),
    }),
  })
  .transform(
    (r): PushItem => ({
      inboxId: r.inbox_id,
      userId: r.user_id,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.created_at,
      ctx: { tz: r.ctx.tz, quiet: r.ctx.quiet, enabled: r.ctx.enabled, tokens: r.ctx.tokens },
    })
  );

const ClaimAnswer = z.array(z.unknown());
const RowId = z.object({ inbox_id: Uuid });
const DueAnswer = z.array(
  z.object({ delivery_id: Uuid, ticket_id: z.string().min(1) }).transform((r) => ({ deliveryId: r.delivery_id, ticketId: r.ticket_id }))
);
const Count = z.number().int().min(0);

export function createPushDb(client: SupabaseClient): PushDb {
  const rpc = async <T>(fn: string, args: Record<string, unknown>, shape: z.ZodType<T>, signal: AbortSignal | undefined): Promise<T> => {
    const call = client.rpc(fn, args);
    const { data, error } = await (signal ? call.abortSignal(signal) : call);
    if (error) throw asPgError(error);
    const parsed = shape.safeParse(data);
    if (!parsed.success) throw new PushDbContractError(fn);
    return parsed.data;
  };
  return {
    async claim(limit, leaseSeconds, signal) {
      const rows = await rpc('claim_push_batch', { p_limit: limit, p_lease_seconds: leaseSeconds }, ClaimAnswer, signal);
      const out: ClaimResult = { items: [], malformed: [], unidentified: 0 };
      for (const row of rows) {
        const parsed = ClaimRow.safeParse(row);
        if (parsed.success) {
          out.items.push(parsed.data);
          continue;
        }
        const id = RowId.safeParse(row);
        if (id.success) out.malformed.push(id.data.inbox_id);
        else out.unidentified++;
      }
      return out;
    },
    recordOutcomes: (outcomes, signal) =>
      outcomes.length === 0 ? Promise.resolve(0) : rpc('record_push_outcomes', { p: { outcomes } }, Count, signal),
    receiptsDue: (limit, signal) => rpc('push_receipts_due', { p_limit: limit }, DueAnswer, signal),
    recordReceipts: (receipts, signal) =>
      receipts.length === 0 ? Promise.resolve(0) : rpc('record_push_receipts', { p: { receipts } }, Count, signal),
  };
}
