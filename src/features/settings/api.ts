/**
 * H13 and H14 on the device: the two account edge functions, and what a deletion does to this phone.
 *
 * Both calls are one request made only on a tap, never queued or retried in the background: an
 * export is wanted now or not at all, and a deletion must be seen to succeed by the person asking.
 * Offline, neither makes a request.
 */
import { getSharedOnline } from '@/data/net/net';
import { supabase } from '@/data/supabase/client';
import { classifyInvokeError } from '@/data/sync/response';

export const ACCOUNT_EXPORT_FUNCTION = 'account-export';
export const ACCOUNT_DELETE_FUNCTION = 'account-delete';

/** The slice of the Supabase client these use. */
export interface AccountClient {
  functions: { invoke(name: string, opts: { body: unknown }): Promise<{ data: unknown; error: unknown }> };
}

export interface AccountDeps {
  client?: AccountClient;
  online?: () => boolean;
}

export type ExportResult = { ok: true; json: string } | { ok: false; reason: 'offline' | 'too_many' | 'failed' };
export type DeleteResult = { ok: true } | { ok: false; reason: 'offline' | 'session_gone' | 'failed' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function call(name: string, body: unknown, deps: AccountDeps): Promise<{ data: unknown } | { status: number | null }> {
  const client = deps.client ?? (supabase as unknown as AccountClient);
  try {
    const { data, error } = await client.functions.invoke(name, { body });
    if (!error) return { data };
    const failure = await classifyInvokeError(error, Date.now());
    return { status: failure.status };
  } catch {
    return { status: -1 };
  }
}

/** The caller's own data, pretty-printed, ready to hand to the share sheet. */
export async function exportMyData(deps: AccountDeps = {}): Promise<ExportResult> {
  if (!(deps.online ?? getSharedOnline)()) return { ok: false, reason: 'offline' };
  const r = await call(ACCOUNT_EXPORT_FUNCTION, {}, deps);
  if ('status' in r) {
    if (r.status === null) return { ok: false, reason: 'offline' };
    return { ok: false, reason: r.status === 429 ? 'too_many' : 'failed' };
  }
  if (!isRecord(r.data) || !isRecord(r.data.account)) return { ok: false, reason: 'failed' };
  return { ok: true, json: JSON.stringify(r.data, null, 2) };
}

/** Deletes the caller's account on the server. Only `{ ok: true }` means it is gone. */
export async function deleteMyAccount(deps: AccountDeps = {}): Promise<DeleteResult> {
  if (!(deps.online ?? getSharedOnline)()) return { ok: false, reason: 'offline' };
  const r = await call(ACCOUNT_DELETE_FUNCTION, { confirm: 'DELETE' }, deps);
  if ('status' in r) {
    if (r.status === null) return { ok: false, reason: 'offline' };
    return { ok: false, reason: r.status === 401 ? 'session_gone' : 'failed' };
  }
  return isRecord(r.data) && r.data.deleted === true ? { ok: true } : { ok: false, reason: 'failed' };
}

export interface DeletionDeps {
  remove: () => Promise<DeleteResult>;
  /** The session's own sign-out, forced: there are no deletes left to send for an account that is gone. */
  signOut: () => Promise<unknown>;
  /** Empties this phone's database and traces (`wipeDevice`). */
  wipe: () => Promise<void>;
}

/**
 * The whole deletion as the device sees it. Deleted: this phone signs out and is emptied, so nothing
 * of the account is left here either. A 401 means the session no longer proves an account (the
 * deletion may have happened on an earlier try whose answer was lost): the phone signs out, and
 * says so without claiming a deletion, and keeps its data until the next sign-in decides (a new
 * account is a new owner, and the handover wipes). Any other failure changes nothing.
 */
export async function runAccountDeletion(deps: DeletionDeps): Promise<DeleteResult> {
  const result = await deps.remove();
  if (result.ok || result.reason === 'session_gone') {
    await deps.signOut().catch(() => undefined);
  }
  if (result.ok) await deps.wipe().catch(() => undefined);
  return result;
}
