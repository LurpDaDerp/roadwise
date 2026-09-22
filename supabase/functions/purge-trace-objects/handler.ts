// purge-trace-objects: deletes, through the Storage API, the trace objects nothing else will ever
// remove (task B6, ruling T12 security I-1). A release gate: the block screen promises "RoadWise
// will finish removing your recorded drives from its servers".
//
// Two lists, both read by service-role-only SQL:
//   * `underage` — every object under a blocked (u13) user's prefix, in any bucket
//     (0006 `underage_object_keys`). 0006's minimisation deletes the child's trips rows, so without
//     this nothing would ever find those traces again.
//   * `expired`  — every `traces` object created more than 14 days ago, the dispute window
//     (0008 `expired_trace_object_keys`), found by object metadata alone, so an orphan of any cause
//     (a blocked child, M8's delete-account, a trips row lost some other way) is still found.
//
// The contract:
//   * POST only (405). Woken by pg_cron through pg_net (0008 `dispatch_purge_traces`), never by a
//     client: `verify_jwt = false`, and the caller proves itself with `X-Sweep-Signature`
//     (_shared/sweep_auth.ts, purpose 'purge-trace-objects', the dedicated secret
//     PURGE_TRACES_HMAC_KEY). A missing, malformed, stale (> 120 s) or wrong signature is 401 before
//     any database call. A key missing or under 32 bytes is 500 `misconfigured`, also before any call.
//     The body is ignored.
//   * No two runs at once: a 15-minute lease (`take_job_lease`). A run that finds it held answers
//     200 `{ status: 'busy' }` and does nothing; a crashed run's lease lapses on its own.
//   * Bounded: batches of BATCH keys, at most MAX_BATCHES per list per run. `more: true` says the
//     cap was reached with work left; the next hourly wake continues. A batch that removes nothing
//     ends that list for this run (never a spin on keys the Storage API will not remove).
//   * Idempotent: deleting removes the objects, so the next listing moves on; a replayed wake
//     repeats nothing harmful.
//   * Counts only, in the response and the logs. No key, path or user id is ever logged or returned.
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, pgFailure, requirePost, type Logger } from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';
import { SWEEP_SIGNATURE_HEADER, sweepKeyUsable, verifySweepSignature } from '../_shared/sweep_auth.ts';

export const PURGE_PURPOSE = 'purge-trace-objects';
export const PURGE_JOB = 'purge-trace-objects';
export const BATCH = 100;
export const MAX_BATCHES = 20;
export const LEASE_S = 900;

export interface ObjectKey {
  bucket: string;
  name: string;
}

export interface PurgeDb {
  underageKeys(limit: number): Promise<ObjectKey[]>;
  expiredKeys(limit: number): Promise<ObjectKey[]>;
  takeLease(holder: string, seconds: number): Promise<boolean>;
  releaseLease(holder: string): Promise<void>;
}

export interface PurgeStorage {
  /** Removes `names` from `bucket`; resolves to how many objects were removed, throws on a failure. */
  remove(bucket: string, names: string[]): Promise<number>;
}

export interface PurgeDeps {
  hmacKey: string | undefined;
  db: PurgeDb;
  storage: PurgeStorage;
  log?: Logger;
  nowS?: () => number;
  newHolder?: () => string;
}

interface ListResult {
  removed: number;
  failed: number;
  more: boolean;
}

/** One list: batches until it is empty, a batch removes nothing, a removal fails, or the cap. */
async function purgeList(list: (limit: number) => Promise<ObjectKey[]>, storage: PurgeStorage): Promise<ListResult> {
  const out: ListResult = { removed: 0, failed: 0, more: false };
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const keys = await list(BATCH);
    if (keys.length === 0) return out;
    const byBucket = new Map<string, string[]>();
    for (const k of keys) byBucket.set(k.bucket, [...(byBucket.get(k.bucket) ?? []), k.name]);
    let removedNow = 0;
    for (const [bucket, names] of byBucket) {
      try {
        removedNow += await storage.remove(bucket, names);
      } catch {
        out.failed += names.length;
        out.removed += removedNow;
        return out;
      }
    }
    out.removed += removedNow;
    if (removedNow === 0) return out;
    if (batch === MAX_BATCHES - 1 && keys.length === BATCH) out.more = true;
  }
  return out;
}

export async function handlePurge(req: Request, deps: PurgeDeps): Promise<Response> {
  const log = deps.log ?? console;
  const notPost = requirePost(req);
  if (notPost) return notPost;
  if (!sweepKeyUsable(deps.hmacKey)) {
    log.error('purge-trace-objects misconfigured: PURGE_TRACES_HMAC_KEY missing or under 32 bytes');
    return json(500, { code: 'misconfigured' });
  }
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  const signed = await verifySweepSignature(req.headers.get(SWEEP_SIGNATURE_HEADER), PURGE_PURPOSE, deps.hmacKey, nowS());
  if (!signed) return json(401, { code: 'unauthorized' });

  const holder = (deps.newHolder ?? (() => crypto.randomUUID()))();
  try {
    if (!(await deps.db.takeLease(holder, LEASE_S))) {
      return json(200, { status: 'busy', underage_removed: 0, expired_removed: 0, failed: 0, more: false });
    }
  } catch (err) {
    return pgFailure(err, log, {}, 'purge-trace-objects');
  }

  try {
    const underage = await purgeList((n) => deps.db.underageKeys(n), deps.storage);
    const expired = await purgeList((n) => deps.db.expiredKeys(n), deps.storage);
    const failed = underage.failed + expired.failed;
    if (failed > 0) log.error('purge-trace-objects storage removals failed', { failed });
    return json(200, {
      status: 'done',
      underage_removed: underage.removed,
      expired_removed: expired.removed,
      failed,
      more: underage.more || expired.more,
    });
  } catch (err) {
    return pgFailure(err, log, {}, 'purge-trace-objects');
  } finally {
    try {
      await deps.db.releaseLease(holder);
    } catch {
      // The lease lapses on its own after LEASE_S; a release that failed only delays the next run.
      log.error('purge-trace-objects lease release failed');
    }
  }
}

/** A `{ bucket, name }[]` from an RPC, or a thrown error: the listing is our own contract. */
function toKeys(data: unknown): ObjectKey[] {
  if (!Array.isArray(data)) throw new Error('purge-trace-objects: a listing that is not an array');
  return data.map((row) => {
    const r = row as Partial<ObjectKey> | null;
    if (!r || typeof r.bucket !== 'string' || typeof r.name !== 'string' || r.bucket === '' || r.name === '') {
      throw new Error('purge-trace-objects: a listing row that is not { bucket, name }');
    }
    return { bucket: r.bucket, name: r.name };
  });
}

/** The service-role client, as the handler's two ports. */
export function createPurgePorts(client: SupabaseClient): { db: PurgeDb; storage: PurgeStorage } {
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw asPgError(error);
    return data;
  };
  return {
    db: {
      underageKeys: async (limit) => toKeys(await rpc('underage_object_keys', { p_limit: limit })),
      expiredKeys: async (limit) => toKeys(await rpc('expired_trace_object_keys', { p_limit: limit })),
      takeLease: async (holder, seconds) =>
        (await rpc('take_job_lease', { p_job: PURGE_JOB, p_holder: holder, p_seconds: seconds })) === true,
      releaseLease: async (holder) => {
        await rpc('release_job_lease', { p_job: PURGE_JOB, p_holder: holder });
      },
    },
    storage: {
      async remove(bucket, names) {
        const { data, error } = await client.storage.from(bucket).remove(names);
        if (error) throw new Error('storage remove failed');
        return Array.isArray(data) ? data.length : 0;
      },
    },
  };
}
