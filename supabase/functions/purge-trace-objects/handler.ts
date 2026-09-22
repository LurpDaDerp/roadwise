// purge-trace-objects: deletes, through the Storage API, the trace objects nothing else will ever
// remove (task B6, ruling T12 security I-1). A release gate: the block screen promises "RoadWise
// will finish removing your recorded drives from its servers".
//
// Two lists, both read by service-role-only SQL (0008):
//   * `underage` — every object under a blocked (u13) user's prefix, in any bucket
//     (`underage_object_keys_after`). 0006's minimisation deletes the child's trips rows, so
//     without this nothing would ever find those traces again.
//   * `expired`  — every `traces` object past the 14-day retention, counted from the drive's end
//     where a trips row exists and from the upload otherwise (`expired_trace_object_keys`), found
//     by object metadata, so an orphan of any cause (a blocked child, M8's delete-account, a trips
//     row lost some other way) is still found. Each expired trace deleted also stops being named by
//     its trips row (`clear_trace_paths`); a re-score reads `scored_without_trace` (the recording
//     as it was scored), so clearing the path never lowers a grade (ruling B6 r2).
//
// The contract:
//   * POST only (405). Woken by pg_cron through pg_net every 15 minutes (0008
//     `dispatch_purge_traces`), never by a client: `verify_jwt = false`, and the caller proves
//     itself with `X-Sweep-Signature` (_shared/sweep_auth.ts, purpose 'purge-trace-objects', the
//     dedicated secret PURGE_TRACES_HMAC_KEY). A missing, malformed, stale (> 120 s) or wrong
//     signature is 401 before any database call. A key missing or under 32 bytes is 500
//     `misconfigured`, also before any call. The body is ignored.
//   * No two runs at once: a 15-minute lease (`take_job_lease`). A run that finds it held answers
//     200 `{ status: 'busy' }` and does nothing; a crashed run's lease lapses on its own.
//   * Bounded: each list is read LIST_LIMIT keys at a time (one scan per call, not per batch), at
//     most MAX_LISTINGS calls; removal goes in batches of BATCH; and the run stops once it has used
//     BUDGET_MS, well inside pg_net's 10 s timeout. `more: true` says it stopped with work possibly
//     left, and the next wake continues.
//   * A batch Storage refuses, or does not fully remove, is counted in `failed` and passed over:
//     the cursor moves on, so keys that can never be removed never stall the keys behind them.
//   * Idempotent: deleting removes the objects, so the next listing moves on; a replayed wake
//     repeats nothing harmful.
//   * Counts only, in the response and the logs. No key, path or user id is ever logged or returned.
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, pgFailure, requirePost, type Logger } from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';
import { SWEEP_SIGNATURE_HEADER, sweepKeyUsable, verifySweepSignature } from '../_shared/sweep_auth.ts';

export const PURGE_PURPOSE = 'purge-trace-objects';
export const PURGE_JOB = 'purge-trace-objects';
/** Keys per listing call (the RPCs' own ceiling): each list is scanned once per LIST_LIMIT keys. */
export const LIST_LIMIT = 1000;
/** Keys per Storage API remove call. */
export const BATCH = 100;
/** Listing calls per list per run, so a run's work is bounded even with time left. */
export const MAX_LISTINGS = 2;
/** Work stops once a run has used this much time, well inside pg_net's 10 s request timeout. */
export const BUDGET_MS = 7500;
export const LEASE_S = 900;
/** The bucket whose deleted keys name a trips row's trace_path. */
export const TRACES_BUCKET = 'traces';

export interface ObjectKey {
  bucket: string;
  name: string;
}

export interface PurgeDb {
  /** 0008 `underage_object_keys_after`: every bucket, (bucket, name) order, after the cursor. */
  underageKeys(after: ObjectKey | null, limit: number): Promise<ObjectKey[]>;
  /** 0008 `expired_trace_object_keys`: the traces bucket, name order, after the cursor. */
  expiredKeys(afterName: string | null, limit: number): Promise<ObjectKey[]>;
  /** 0008 `clear_trace_paths`: for trace keys just deleted; the count of trips rows cleared. */
  clearTracePaths(keys: string[]): Promise<number>;
  takeLease(holder: string, seconds: number): Promise<boolean>;
  releaseLease(holder: string): Promise<void>;
}

export interface PurgeStorage {
  /** Removes `names` from `bucket`; resolves to the names actually removed, throws on a failure. */
  remove(bucket: string, names: string[]): Promise<string[]>;
}

export interface PurgeDeps {
  hmacKey: string | undefined;
  db: PurgeDb;
  storage: PurgeStorage;
  log?: Logger;
  nowS?: () => number;
  /** The run's clock for its time budget (ms). */
  nowMs?: () => number;
  newHolder?: () => string;
}

interface ListResult {
  removed: number;
  failed: number;
  cleared: number;
  more: boolean;
}

/**
 * One list, bounded three ways: LIST_LIMIT keys per listing call (review m1), MAX_LISTINGS calls,
 * and the run's time budget (review m3). Removal goes in client-side batches of BATCH per bucket.
 * A batch Storage refuses, or does not fully remove, is counted in `failed` and passed over; the
 * cursor moves on (security M-1).
 */
async function purgeList<C>(
  list: (after: C | null, limit: number) => Promise<ObjectKey[]>,
  cursorOf: (k: ObjectKey) => C,
  storage: PurgeStorage,
  afterRemoved: ((bucket: string, names: string[]) => Promise<number>) | null,
  overBudget: () => boolean
): Promise<ListResult> {
  const out: ListResult = { removed: 0, failed: 0, cleared: 0, more: false };
  let after: C | null = null;
  for (let listing = 0; listing < MAX_LISTINGS; listing += 1) {
    if (overBudget()) {
      out.more = true;
      return out;
    }
    const keys = await list(after, LIST_LIMIT);
    if (keys.length === 0) return out;
    for (let i = 0; i < keys.length; i += BATCH) {
      if (overBudget()) {
        out.more = true;
        return out;
      }
      const byBucket = new Map<string, string[]>();
      for (const k of keys.slice(i, i + BATCH)) byBucket.set(k.bucket, [...(byBucket.get(k.bucket) ?? []), k.name]);
      for (const [bucket, names] of byBucket) {
        let gone: string[];
        try {
          gone = await storage.remove(bucket, names);
        } catch {
          out.failed += names.length;
          continue;
        }
        const wanted = new Set(names);
        const removed = [...new Set(gone.filter((n) => wanted.has(n)))];
        out.removed += removed.length;
        out.failed += names.length - removed.length;
        if (afterRemoved && removed.length > 0) out.cleared += await afterRemoved(bucket, removed);
      }
    }
    if (keys.length < LIST_LIMIT) return out;
    after = cursorOf(keys[keys.length - 1] as ObjectKey);
  }
  out.more = true;
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

  const nowMs = deps.nowMs ?? Date.now;
  const startedMs = nowMs();
  const overBudget = () => nowMs() - startedMs >= BUDGET_MS;
  const holder = (deps.newHolder ?? (() => crypto.randomUUID()))();
  try {
    if (!(await deps.db.takeLease(holder, LEASE_S))) {
      return json(200, { status: 'busy', underage_removed: 0, expired_removed: 0, failed: 0, trace_paths_cleared: 0, more: false });
    }
  } catch (err) {
    return pgFailure(err, log, {}, 'purge-trace-objects');
  }

  try {
    const underage = await purgeList<ObjectKey>(
      (after, limit) => deps.db.underageKeys(after, limit),
      (k) => k,
      deps.storage,
      null,
      overBudget
    );
    // An expired trace that is deleted stops being named by its trips row (ruling B6 retention);
    // the drive's scored_without_trace is untouched, so its grade is not.
    const expired = await purgeList<string>(
      (after, limit) => deps.db.expiredKeys(after, limit),
      (k) => k.name,
      deps.storage,
      (bucket, names) => (bucket === TRACES_BUCKET ? deps.db.clearTracePaths(names) : Promise.resolve(0)),
      overBudget
    );
    const failed = underage.failed + expired.failed;
    const more = underage.more || expired.more;
    if (failed > 0) log.error('purge-trace-objects removals failed', { failed });
    // A count ops can alert on: a backlog that keeps `more` true run after run is a scale signal.
    if (more) log.warn('purge-trace-objects stopped with work left', { underage: underage.removed, expired: expired.removed });
    return json(200, {
      status: 'done',
      underage_removed: underage.removed,
      expired_removed: expired.removed,
      failed,
      trace_paths_cleared: expired.cleared,
      more,
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
      underageKeys: async (after, limit) =>
        toKeys(
          await rpc('underage_object_keys_after', {
            p_limit: limit,
            p_after_bucket: after?.bucket ?? null,
            p_after_name: after?.name ?? null,
          })
        ),
      expiredKeys: async (afterName, limit) =>
        toKeys(await rpc('expired_trace_object_keys', { p_limit: limit, p_after_name: afterName })),
      clearTracePaths: async (keys) => {
        const n = await rpc('clear_trace_paths', { p_keys: keys });
        return typeof n === 'number' ? n : 0;
      },
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
        return Array.isArray(data) ? data.flatMap((o) => (typeof o?.name === 'string' ? [o.name] : [])) : [];
      },
    },
  };
}
