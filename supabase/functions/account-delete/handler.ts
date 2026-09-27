// account-delete: H13, "Delete account" (lean M8; both app stores require it in-app). One POST from
// the signed-in device, after the driver has read what goes and typed DELETE; the body repeats that
// word so no stray call can delete anything.
//
// What it does, in order:
//   1. Proves the caller from the JWT. The account deleted is always the caller's own: the body
//      carries only the confirmation word, never an id.
//   2. Removes the caller's storage objects through the Storage API, every bucket, listed by 0013's
//      `account_object_keys` (the raw GPS traces today). SQL cannot delete object bytes, so this has
//      to come before the auth delete, while the id still names a prefix. A batch the Storage API
//      refuses is counted and passed over, never retried in a loop: an object left behind is an
//      orphan that 0008's purge-trace-objects sweep deletes within 14 days of its upload.
//   3. Deletes the auth user (`auth.admin.deleteUser`, a hard delete). Every public table follows
//      through its ON DELETE CASCADE (0013's header and test): profile, drives, rewards and any
//      pending settlement, notifications, devices, family membership (0012's trigger hands the family
//      to its longest-standing member, or ends it with its last one), and a linked minor is left with
//      no guardian link (0013's trigger).
//   4. Purges GoTrue's own audit log of the account (0013 `purge_auth_audit`, review I1): that table
//      has no foreign key, so its sign-up, login, refresh and user_deleted rows would otherwise keep
//      the id and email. The email is read before the delete, while the user still exists. A purge
//      that fails does not undo a deletion that happened: it is logged (as a count of none) and the
//      daily `purge-auth-audit` job removes every audit row after 30 days anyway.
//
// A delete that fails at step 3 answers 500/503 and nothing about the account has changed except
// its stored traces; the device says the account was not deleted and the driver can try again. A retry after
// a lost 200 finds no user behind the token and answers 401, which the device treats as signed out.
// Logs carry the request id and counts only, never an id or a key.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bearerToken, invalidPayload, json, pgFailure, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';

export const MAX_BODY_BYTES = 1024;
/** Keys per listing call (0013 caps it at 1000) and per Storage remove call. */
export const LIST_LIMIT = 1000;
export const BATCH = 100;
/** A person's objects are a few hundred traces at most (14-day retention); this bounds a bad day. */
export const MAX_LISTINGS = 20;

export const DeleteBodySchema = z.object({ confirm: z.literal('DELETE') }).strict();

export interface ObjectKey {
  bucket: string;
  name: string;
}

export interface DeletePorts {
  /** 0013 `account_object_keys`, (bucket, name) order after the cursor. */
  objectKeys(userId: string, after: ObjectKey | null, limit: number): Promise<ObjectKey[]>;
  /** Removes `names` from `bucket`; resolves to the names removed, throws on a refusal. */
  removeObjects(bucket: string, names: string[]): Promise<string[]>;
  /** The account's email, read before the delete for the audit purge; null when it can't be read. */
  userEmail(userId: string): Promise<string | null>;
  /** The hard delete. Throws on failure (an error carrying `status` when GoTrue answered). */
  deleteUser(userId: string): Promise<void>;
  /** 0013 `purge_auth_audit`, after the delete: the count of audit rows removed. */
  purgeAuthAudit(userId: string, email: string | null): Promise<number>;
}

export interface DeleteDeps {
  verifyJwt(token: string): Promise<string | null>;
  ports: DeletePorts;
  log?: Logger;
}

export interface DeleteResponse {
  deleted: true;
  objectsRemoved: number;
  /** Objects the Storage API would not remove now; the retention sweep deletes them. */
  objectsLeft: number;
}

async function removeObjects(userId: string, ports: DeletePorts): Promise<{ removed: number; left: number }> {
  let removed = 0;
  let left = 0;
  let after: ObjectKey | null = null;
  for (let listing = 0; listing < MAX_LISTINGS; listing += 1) {
    const keys = await ports.objectKeys(userId, after, LIST_LIMIT);
    if (keys.length === 0) break;
    for (let i = 0; i < keys.length; i += BATCH) {
      const byBucket = new Map<string, string[]>();
      for (const k of keys.slice(i, i + BATCH)) byBucket.set(k.bucket, [...(byBucket.get(k.bucket) ?? []), k.name]);
      for (const [bucket, names] of byBucket) {
        let gone: string[];
        try {
          gone = await ports.removeObjects(bucket, names);
        } catch {
          left += names.length;
          continue;
        }
        const wanted = new Set(names);
        const n = new Set(gone.filter((g) => wanted.has(g))).size;
        removed += n;
        left += names.length - n;
      }
    }
    if (keys.length < LIST_LIMIT) break;
    after = keys[keys.length - 1] as ObjectKey;
  }
  return { removed, left };
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

  let objects: { removed: number; left: number };
  try {
    objects = await removeObjects(userId, deps.ports);
  } catch (err) {
    // The listing itself failed: nothing is deleted, so the driver is told to try again.
    return reply(pgFailure(err, log, { requestId: id }, 'account-delete'));
  }
  if (objects.left > 0) log.warn('account-delete left objects for the retention sweep', { requestId: id, left: objects.left });

  // Read while the user exists; without it the purge still matches the id, which every row GoTrue
  // writes about an account carries.
  const email = await deps.ports.userEmail(userId).catch(() => null);

  try {
    await deps.ports.deleteUser(userId);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
    log.error('account-delete auth delete failed', { requestId: id, status });
    // GoTrue unreachable or overloaded: retryable. Anything else: a failure the driver can retry later.
    if (status === null || status >= 500) return reply(json(503, { code: 'retry' }, { 'retry-after': '5' }));
    return reply(json(500, { code: 'internal' }));
  }

  try {
    await deps.ports.purgeAuthAudit(userId, email);
  } catch {
    log.warn('account-delete audit purge failed; the 30-day job removes the rows', { requestId: id });
  }

  const response: DeleteResponse = { deleted: true, objectsRemoved: objects.removed, objectsLeft: objects.left };
  return reply(json(200, response, { 'cache-control': 'no-store' }));
}

/** A `{ bucket, name }[]` from the RPC, or a thrown error: the listing is our own contract. */
function toKeys(data: unknown): ObjectKey[] {
  if (!Array.isArray(data)) throw new Error('account-delete: a listing that is not an array');
  return data.map((row) => {
    const r = row as Partial<ObjectKey> | null;
    if (!r || typeof r.bucket !== 'string' || typeof r.name !== 'string' || r.bucket === '' || r.name === '') {
      throw new Error('account-delete: a listing row that is not { bucket, name }');
    }
    return { bucket: r.bucket, name: r.name };
  });
}

/** The service-role client as the handler's three ports. */
export function createDeletePorts(client: SupabaseClient): DeletePorts {
  return {
    async objectKeys(userId, after, limit) {
      const { data, error } = await client.rpc('account_object_keys', {
        p_user: userId,
        p_limit: limit,
        p_after_bucket: after?.bucket ?? null,
        p_after_name: after?.name ?? null,
      });
      if (error) throw asPgError(error);
      return toKeys(data);
    },
    async removeObjects(bucket, names) {
      const { data, error } = await client.storage.from(bucket).remove(names);
      if (error) throw new Error('storage remove failed');
      return Array.isArray(data) ? data.flatMap((o) => (typeof o?.name === 'string' ? [o.name] : [])) : [];
    },
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
