/**
 * B3's server calls: read the caller's inbox, mark rows read, dismiss them (migration 0007).
 *
 * - **Columns are listed, never `*`.** The `inbox` SELECT grant is per column (0007): `push_state`,
 *   `push_reason`, `push_attempts`, `push_claimed_at`, `push_after` and `dedupe_key` are the
 *   sender's own bookkeeping and are not readable, so `select=*` is refused outright.
 * - **RLS decides what is visible.** A row appears once `deliver_after <= now()`, so nothing here
 *   filters by time.
 * - **Rows are validated strictly.** A row carrying a column this build did not ask for is refused
 *   rather than cached; a row the schema refuses is dropped, not the whole inbox.
 * - **A transport failure is not a server error.** supabase-js reports a fetch that never reached
 *   the server as `status: 0`; that becomes `InboxOfflineError`, which the hook answers from the
 *   phone's cache. Anything the server itself refused is rethrown for the screen's error + retry.
 */
import { z } from 'zod';

import { supabase } from '@/data/supabase/client';

/** Exactly the columns 0007 grants to `authenticated`. */
export const INBOX_COLUMNS =
  'id,user_id,type,payload,ref_id,deliver_after,read_at,dismissed_at,pushed_at,created_at';

/** The most rows one `mark_inbox_read` / `dismiss_inbox` call accepts (0007: 1 to 100 ids). */
export const RPC_CHUNK = 100;

const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp');

export const InboxRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()),
    ref_id: z.string().nullable(),
    deliver_after: timestamp,
    read_at: timestamp.nullable(),
    dismissed_at: timestamp.nullable(),
    pushed_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .strict();

export type InboxRow = z.infer<typeof InboxRowSchema>;

/** The request never reached the server (no connection, DNS, a dropped socket). */
export class InboxOfflineError extends Error {
  override readonly name = 'InboxOfflineError';
  constructor(readonly cause?: unknown) {
    super('inbox: the server could not be reached');
  }
}

/** The slice of the Supabase client these calls use; a test passes a fake. */
export type InboxClient = Pick<typeof supabase, 'from' | 'rpc'>;

interface Reply {
  error: unknown;
  status: number;
}

function check(reply: Reply): void {
  if (!reply.error) return;
  if (reply.status === 0) throw new InboxOfflineError(reply.error);
  throw reply.error;
}

/** Postgres/PostgREST refusal codes from an error value, or null. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The caller's newest `limit` rows (RLS: own and due), newest first, dismissed ones included — the
 * cap count (`countServerPushesToday`) needs every row that was pushed today. Rows the schema
 * refuses are dropped.
 */
export async function fetchInbox(
  limit = 100,
  client: InboxClient = supabase
): Promise<InboxRow[]> {
  const reply = await client
    .from('inbox')
    .select(INBOX_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  check(reply);
  const data: unknown = reply.data;
  if (!Array.isArray(data)) return [];
  const rows: InboxRow[] = [];
  for (const raw of data) {
    const parsed = InboxRowSchema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/** Split `ids` (deduplicated, order kept) into the RPC's 100-id chunks. */
export function chunk(ids: readonly string[], size: number = RPC_CHUNK): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

async function callInChunks(
  fn: 'mark_inbox_read' | 'dismiss_inbox',
  ids: readonly string[],
  client: InboxClient
): Promise<number> {
  let total = 0;
  for (const part of chunk(ids)) {
    const reply = await client.rpc(fn, { p_ids: part });
    check(reply);
    total += typeof reply.data === 'number' ? reply.data : 0;
  }
  return total;
}

/** Mark rows read. Returns how many of the caller's due rows matched; a replay is harmless. */
export function markInboxRead(ids: readonly string[], client: InboxClient = supabase): Promise<number> {
  return callInChunks('mark_inbox_read', ids, client);
}

/** Dismiss rows. Returns how many of the caller's due rows matched; a replay is harmless. */
export function dismissInbox(ids: readonly string[], client: InboxClient = supabase): Promise<number> {
  return callInChunks('dismiss_inbox', ids, client);
}

/** The calls the hook and the flush make, as one injectable object. */
export interface InboxApi {
  fetchInbox(limit?: number): Promise<InboxRow[]>;
  markInboxRead(ids: readonly string[]): Promise<number>;
  dismissInbox(ids: readonly string[]): Promise<number>;
}

export const defaultInboxApi: InboxApi = {
  fetchInbox: (limit) => fetchInbox(limit),
  markInboxRead: (ids) => markInboxRead(ids),
  dismissInbox: (ids) => dismissInbox(ids),
};
