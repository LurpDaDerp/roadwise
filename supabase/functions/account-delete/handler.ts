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
//   3. Sign in with Apple: when the account has an Apple identity and the phone sent a fresh Apple
//      authorization code (`apple_code`, from the Apple sheet at Delete account), the app's Apple
//      authorization is revoked (`_shared/apple_siwa.ts`), so the Apple ID no longer lists RoadWise
//      as signed in. Best effort: a missing code, missing secrets or an Apple failure is logged as
//      one word and never stops or undoes the deletion.
//   4. GoTrue's own audit log is purged of the account (0009 `purge_auth_audit`): that table has no
//      foreign key. The email and the Apple user id are read before the delete, while the user
//      still exists. A purge that fails never undoes a deletion; the daily `purge-auth-audit` job
//      removes every row after 30 days.
//
// A retry after a lost 200 finds no user behind the token and answers 401, which the device treats
// as signed out. Logs carry the request id and counts only, never an id or an email.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bearerToken, invalidPayload, json, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import type { RevokeOutcome } from '../_shared/apple_siwa.ts';
import { asPgError } from '../_shared/pg.ts';

export const MAX_BODY_BYTES = 1024;

export const DeleteBodySchema = z
  .object({
    confirm: z.literal('DELETE'),
    /** A fresh Sign in with Apple authorization code (single use, valid for 5 minutes). */
    apple_code: z.string().min(1).max(512).regex(/^[!-~]+$/).optional(),
  })
  .strict();

export interface UserFacts {
  /** For the audit purge; null when it can't be read. */
  email: string | null;
  /** The account's Apple user id (its Apple identity's `sub`); null without one. */
  appleSubject: string | null;
}

export interface DeletePorts {
  /** Read before the delete, while the user exists. */
  userFacts(userId: string): Promise<UserFacts>;
  /** The hard delete. Throws on failure (an error carrying `status` when GoTrue answered). */
  deleteUser(userId: string): Promise<void>;
  /** 0009 `purge_auth_audit`, after the delete: the count of audit rows removed. */
  purgeAuthAudit(userId: string, email: string | null): Promise<number>;
}

export interface DeleteDeps {
  verifyJwt(token: string): Promise<string | null>;
  ports: DeletePorts;
  /** Revokes the app's Apple authorization (`revokeAppleAuthorization`); null when the secrets are not set. Never throws. */
  revokeApple?: ((code: string, appleSubject: string) => Promise<RevokeOutcome>) | null;
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

  // Read while the user exists; without the email the purge still matches the id.
  const facts = await deps.ports.userFacts(userId).catch((): UserFacts => ({ email: null, appleSubject: null }));

  try {
    await deps.ports.deleteUser(userId);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
    log.error('account-delete auth delete failed', { requestId: id, status });
    if (status === null || status >= 500) return reply(json(503, { code: 'retry' }, { 'retry-after': '5' }));
    return reply(json(500, { code: 'internal' }));
  }

  const appleCode = parsed.data.apple_code;
  if (appleCode !== undefined && facts.appleSubject !== null) {
    if (!deps.revokeApple) {
      log.warn('account-delete apple revoke skipped: not configured', { requestId: id });
    } else {
      const outcome = await deps.revokeApple(appleCode, facts.appleSubject).catch((): RevokeOutcome => 'network');
      if (outcome !== 'revoked') log.warn('account-delete apple revoke failed', { requestId: id, outcome });
    }
  }

  try {
    await deps.ports.purgeAuthAudit(userId, facts.email);
  } catch {
    log.warn('account-delete audit purge failed; the 30-day job removes the rows', { requestId: id });
  }

  const response: DeleteResponse = { deleted: true };
  return reply(json(200, response, { 'cache-control': 'no-store' }));
}

/** The service-role client as the handler's ports. */
export function createDeletePorts(client: SupabaseClient): DeletePorts {
  return {
    async userFacts(userId) {
      const { data, error } = await client.auth.admin.getUserById(userId);
      if (error) throw error;
      const apple = data.user?.identities?.find((identity) => identity.provider === 'apple');
      const sub = apple?.identity_data?.sub ?? apple?.id;
      return { email: data.user?.email ?? null, appleSubject: typeof sub === 'string' && sub.length > 0 ? sub : null };
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
