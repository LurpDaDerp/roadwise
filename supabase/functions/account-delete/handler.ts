// account-delete: "Delete account" (both app stores require it in-app). One POST from the
// signed-in device after the driver typed DELETE; the body repeats that word so no stray call can
// delete anything.
//
//   1. The caller is proved from the JWT. The account deleted is always the caller's own.
//   2. The auth user is deleted (`auth.admin.deleteUser`, a hard delete). Every public table
//      follows through ON DELETE CASCADE (0009's header and test): profile, progress, drives,
//      achievements, weekly goals, friendships, blocks, reports, devices (with their push and
//      Live Activity tokens), notifications.
//      There is no storage.
//   3. GoTrue's own audit log is purged of the account (0009 `purge_auth_audit`): that table has no
//      foreign key. The email is read before the delete, while the user still exists. A purge that
//      fails never undoes a deletion; the daily `purge-auth-audit` job removes every row after 30 days.
//
// A retry after a lost 200 finds no user behind the token and answers 401, which the device treats
// as signed out. Logs carry the request id and counts only, never an id or an email.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bearerToken, invalidPayload, json, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';

export const MAX_BODY_BYTES = 1024;

export const DeleteBodySchema = z.object({ confirm: z.literal('DELETE') }).strict();

export interface DeletePorts {
  /** The account's email, read before the delete for the audit purge; null when it can't be read. */
  userEmail(userId: string): Promise<string | null>;
  /** The hard delete. Throws on failure (an error carrying `status` when GoTrue answered). */
  deleteUser(userId: string): Promise<void>;
  /** 0009 `purge_auth_audit`, after the delete: the count of audit rows removed. */
  purgeAuthAudit(userId: string, email: string | null): Promise<number>;
}

export interface DeleteDeps {
  verifyJwt(token: string): Promise<string | null>;
  ports: DeletePorts;
  log?: Logger;
}

export interface DeleteResponse {
  deleted: true;
}

export async function handleAccountDelete(req: Request, deps: DeleteDeps): Promise<Response> {
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
      log.error('account-delete token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = DeleteBodySchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));

  // Read while the user exists; without it the purge still matches the id.
  const email = await deps.ports.userEmail(userId).catch(() => null);

  try {
    await deps.ports.deleteUser(userId);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
    log.error('account-delete auth delete failed', { requestId: id, status });
    if (status === null || status >= 500) return reply(json(503, { code: 'retry' }, { 'retry-after': '5' }));
    return reply(json(500, { code: 'internal' }));
  }

  try {
    await deps.ports.purgeAuthAudit(userId, email);
  } catch {
    log.warn('account-delete audit purge failed; the 30-day job removes the rows', { requestId: id });
  }

  const response: DeleteResponse = { deleted: true };
  return reply(json(200, response, { 'cache-control': 'no-store' }));
}

/** The service-role client as the handler's ports. */
export function createDeletePorts(client: SupabaseClient): DeletePorts {
  return {
    async userEmail(userId) {
      const { data, error } = await client.auth.admin.getUserById(userId);
      if (error) throw error;
      return data.user?.email ?? null;
    },
    async deleteUser(userId) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error) throw error;
    },
    async purgeAuthAudit(userId, email) {
      const { data, error } = await client.rpc('purge_auth_audit', { p_user: userId, p_email: email });
      if (error) throw asPgError(error);
      return typeof data === 'number' ? data : 0;
    },
  };
}
