// The database port push-sender talks to: 0007's four service-role writers, called by name, and
// nothing else — no table is read directly, so every rule about which rows are due, what a lease
// is and which token belongs to whom stays in SQL (task-2-report §2).
//
// Every answer is zod-parsed against that contract; output that breaks it is a
// `PushDbContractError` (server-side drift, answered 500), and a writer's refusal is a `PgError`
// with its SQLSTATE and fixed message, which `pgFailure` maps.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { asPgError } from './pg.ts';
import type { PushItem } from './push_policy.ts';

/** `record_push_outcomes`' reason list (0007), in one place. */
export type OutcomeReason =
  | 'ok'
  | 'driving'
  | 'quiet_hours'
  | 'window'
  | 'expo_unavailable'
  | 'local'
  | 'inbox_only'
  | 'category_off'
  | 'capped'
  | 'weekly_limit'
  | 'no_device'
  | 'stale'
  | 'already_read'
  | 'dismissed'
  | 'subject_gone'
  | 'unknown_type'
  | 'bad_payload'
  | 'expo_error';

export interface Delivery {
  token?: string;
  ticket_id?: string;
  error?: string;
}

/** One `record_push_outcomes` outcome. A `deferred` one carries `push_after` (never `deliver_after`). */
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

export interface PushDb {
  claim(limit: number, leaseSeconds: number): Promise<PushItem[]>;
  recordOutcomes(outcomes: Outcome[]): Promise<number>;
  receiptsDue(limit: number): Promise<DueReceipt[]>;
  recordReceipts(receipts: ReceiptReport[]): Promise<number>;
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
    type: z.string().min(1).max(64),
    payload: z.unknown(),
    created_at: Instant,
    read: z.boolean(),
    dismissed: z.boolean(),
    subject_gone: z.boolean(),
    ctx: z.object({
      tz: z.string().min(1).max(64),
      quiet: z.object({ enabled: z.boolean(), start: HhMm, end: HhMm }),
      categories: z.record(z.string(), z.boolean()),
      driving_since: Instant.nullable(),
      recent: z.array(z.object({ type: z.string(), pushed_at: Instant })),
      local_sent_today: z.number().int().min(0),
      tokens: z.array(z.string().min(1).max(256)).max(10),
    }),
  })
  .transform(
    (r): PushItem => ({
      inboxId: r.inbox_id,
      userId: r.user_id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at,
      read: r.read,
      dismissed: r.dismissed,
      subjectGone: r.subject_gone,
      ctx: {
        tz: r.ctx.tz,
        quiet: r.ctx.quiet,
        categories: r.ctx.categories,
        drivingSince: r.ctx.driving_since,
        recent: r.ctx.recent.map((x) => ({ type: x.type, pushedAt: x.pushed_at })),
        localSentToday: r.ctx.local_sent_today,
        tokens: r.ctx.tokens,
      },
    })
  );

const ClaimAnswer = z.array(ClaimRow);
const DueAnswer = z.array(
  z.object({ delivery_id: Uuid, ticket_id: z.string().min(1) }).transform((r) => ({ deliveryId: r.delivery_id, ticketId: r.ticket_id }))
);
const Count = z.number().int().min(0);

export function createPushDb(client: SupabaseClient): PushDb {
  const rpc = async <T>(fn: string, args: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw asPgError(error);
    const parsed = shape.safeParse(data);
    if (!parsed.success) throw new PushDbContractError(fn);
    return parsed.data;
  };
  return {
    claim: (limit, leaseSeconds) =>
      rpc('claim_push_batch', { p_limit: limit, p_lease_seconds: leaseSeconds }, ClaimAnswer),
    recordOutcomes: (outcomes) =>
      outcomes.length === 0 ? Promise.resolve(0) : rpc('record_push_outcomes', { p: { outcomes } }, Count),
    receiptsDue: (limit) => rpc('push_receipts_due', { p_limit: limit }, DueAnswer),
    recordReceipts: (receipts) =>
      receipts.length === 0 ? Promise.resolve(0) : rpc('record_push_receipts', { p: { receipts } }, Count),
  };
}
