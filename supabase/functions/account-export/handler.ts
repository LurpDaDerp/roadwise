// account-export: H14, "Export my data" (lean M8). One POST from the signed-in device; the answer is
// the caller's own rows as one JSON document (0013 `export_account`), which the device hands to the
// OS share sheet. Nothing is stored, queued or emailed: the export exists only in this response.
//
// Whose data: the user id the JWT proves, and only that. The body carries nothing (any body is
// ignored after a size bound), so no request can name another account. The document is built by
// the service-role-only `export_account`, which never includes another person (0013's header), and
// this function checks that the document it got back is the caller's before sending it.
//
// Budget: EXPORT_MAX exports per EXPORT_WINDOW per user (0004's `take_rate_limit`, key
// `account_export`), taken before the export runs, so a loop can't make the database build the
// document again and again. Order of refusal, cheapest first: method, JWT, size, budget. Logs carry
// the request id and codes only, never a row (§4.7).
import type { SupabaseClient } from '@supabase/supabase-js';
import { bearerToken, json, pgFailure, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';

/** The request has no body to speak of; anything larger is refused unread. */
export const MAX_BODY_BYTES = 1024;
export const EXPORT_KEY = 'account_export';
export const EXPORT_WINDOW = '1 day';
export const EXPORT_MAX = 5;
/** What the 429 tells the device: the window is a day, so an hour is an honest first retry. */
export const RETRY_AFTER_S = 3600;

export interface ExportDb {
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  /** 0013 `export_account` verbatim. */
  exportAccount(userId: string): Promise<unknown>;
}

export interface ExportDeps {
  /** The user id the token proves, or null when it proves nothing. Throws when Auth is unreachable. */
  verifyJwt(token: string): Promise<string | null>;
  db: ExportDb;
  log?: Logger;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function handleAccountExport(req: Request, deps: ExportDeps): Promise<Response> {
  const log = deps.log ?? console;
  const id = requestId();
  const reply = (res: Response) => withRequestId(res, id);

  const wrongMethod = requirePost(req);
  if (wrongMethod) return reply(wrongMethod);

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyJwt(token);
    } catch (err) {
      log.error('account-export token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok && body.response.status === 413) return reply(body.response);

  try {
    if (!(await deps.db.takeRateLimit(userId, EXPORT_KEY, EXPORT_WINDOW, EXPORT_MAX))) {
      return reply(json(429, { code: 'too_many_requests' }, { 'retry-after': String(RETRY_AFTER_S) }));
    }
    const doc = await deps.db.exportAccount(userId);
    // Our own contract: a document for any other account is never sent (and says the database drifted).
    const account = isRecord(doc) ? doc.account : null;
    if (!isRecord(doc) || !isRecord(account) || account.user_id !== userId) {
      log.error('account-export document refused', { requestId: id });
      return reply(json(500, { code: 'internal' }));
    }
    return reply(json(200, doc, { 'cache-control': 'no-store' }));
  } catch (err) {
    return reply(pgFailure(err, log, { requestId: id }, 'account-export'));
  }
}

/** The service-role client as the handler's database port. */
export function createExportDb(client: SupabaseClient): ExportDb {
  return {
    async takeRateLimit(userId, key, window, max) {
      const { data, error } = await client.rpc('take_rate_limit', { p_user: userId, p_key: key, p_window: window, p_max: max });
      if (error) throw asPgError(error);
      return data === true;
    },
    async exportAccount(userId) {
      const { data, error } = await client.rpc('export_account', { p_user: userId });
      if (error) throw asPgError(error);
      return data;
    },
  };
}
