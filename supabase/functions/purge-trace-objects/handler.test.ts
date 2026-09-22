import { assert, assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { signSweep } from '../_shared/sweep_auth.ts';
import {
  BATCH,
  BUDGET_MS,
  createPurgePorts,
  handlePurge,
  LEASE_S,
  LIST_LIMIT,
  MAX_LISTINGS,
  PURGE_JOB,
  type ObjectKey,
  type PurgeDb,
  type PurgeDeps,
  type PurgeStorage,
} from './handler.ts';

const KEY = 'purge-test-key-0123456789abcdef-0123';
const NOW_S = 1_790_000_000;

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An in-memory bucket store behind the two ports, listing exactly as the SQL does (underage in
 * (bucket, name) order after a (bucket, name) cursor; expired in name order after a name cursor),
 * recording every call in order. Names in `stuck` are listed but never removed.
 */
function world(opts: { underage?: ObjectKey[]; expired?: ObjectKey[]; leaseHeld?: boolean; stuck?: Set<string> } = {}) {
  const objects = new Map<string, Set<string>>();
  const add = (k: ObjectKey) => {
    const set = objects.get(k.bucket) ?? new Set<string>();
    set.add(k.name);
    objects.set(k.bucket, set);
  };
  const underage = [...(opts.underage ?? [])].sort((a, b) => byteOrder(a.bucket, b.bucket) || byteOrder(a.name, b.name));
  const expired = [...(opts.expired ?? [])].sort((a, b) => byteOrder(a.name, b.name));
  [...underage, ...expired].forEach(add);
  const alive = (k: ObjectKey) => objects.get(k.bucket)?.has(k.name) ?? false;
  const stuck = opts.stuck ?? new Set<string>();
  const calls: string[] = [];
  const cleared: string[][] = [];
  let leaseHeld = opts.leaseHeld ?? false;
  const db: PurgeDb = {
    underageKeys: (after, limit) => {
      calls.push(`underage:${after ? after.name : 'start'}:${limit}`);
      const rest = underage.filter(
        (k) => alive(k) && (!after || byteOrder(k.bucket, after.bucket) > 0 || (k.bucket === after.bucket && byteOrder(k.name, after.name) > 0))
      );
      return Promise.resolve(rest.slice(0, limit));
    },
    expiredKeys: (afterName, limit) => {
      calls.push(`expired:${afterName ?? 'start'}:${limit}`);
      return Promise.resolve(expired.filter((k) => alive(k) && (afterName === null || byteOrder(k.name, afterName) > 0)).slice(0, limit));
    },
    clearTracePaths: (keys) => {
      calls.push(`clear:${keys.length}`);
      cleared.push(keys);
      return Promise.resolve(keys.length);
    },
    takeLease: (holder, seconds) => {
      calls.push(`take:${holder}:${seconds}`);
      if (leaseHeld) return Promise.resolve(false);
      leaseHeld = true;
      return Promise.resolve(true);
    },
    releaseLease: (holder) => {
      calls.push(`release:${holder}`);
      leaseHeld = false;
      return Promise.resolve();
    },
  };
  const storage: PurgeStorage = {
    remove: (bucket, names) => {
      calls.push(`remove:${bucket}:${names.length}`);
      const gone: string[] = [];
      for (const name of names) if (!stuck.has(name) && objects.get(bucket)?.delete(name)) gone.push(name);
      return Promise.resolve(gone);
    },
  };
  const logs: unknown[][] = [];
  const log = { warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) };
  const deps = (over: Partial<PurgeDeps> = {}): PurgeDeps => ({
    hmacKey: KEY,
    db,
    storage,
    log,
    nowS: () => NOW_S,
    nowMs: () => 0,
    newHolder: () => 'holder-1',
    ...over,
  });
  const left = (bucket: string) => objects.get(bucket)?.size ?? 0;
  return { objects, calls, cleared, logs, deps, db, storage, left };
}

const keys = (bucket: string, prefix: string, n: number): ObjectKey[] =>
  Array.from({ length: n }, (_, i) => ({ bucket, name: `${prefix}/${String(i).padStart(5, '0')}.bin.gz` }));

async function signed(ts = NOW_S, key = KEY, purpose = 'purge-trace-objects'): Promise<Request> {
  return new Request('http://local/purge-trace-objects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sweep-signature': await signSweep(purpose, key, ts) },
    body: '{"reason":"sweep"}',
  });
}

const CHILD = 'c0000000-0000-4000-8000-000000000001';
const ADULT = 'a0000000-0000-4000-8000-000000000001';

// --- authentication: 401 before any database call ----------------------------------------------

Deno.test('a missing, stale, malformed, wrong or other-purpose signature is 401 and touches nothing', async () => {
  const w = world({ expired: keys('traces', ADULT, 3) });
  const requests = [
    new Request('http://local/purge-trace-objects', { method: 'POST', body: '{}' }),
    await signed(NOW_S - 121),
    await signed(NOW_S + 121),
    new Request('http://local/purge-trace-objects', { method: 'POST', headers: { 'x-sweep-signature': 'garbage' } }),
    await signed(NOW_S, `${KEY}-wrong`),
    await signed(NOW_S, KEY, 'push-sender-sweep'),
  ];
  for (const req of requests) {
    const res = await handlePurge(req, w.deps());
    assertEquals(res.status, 401);
    assertEquals(await res.json(), { code: 'unauthorized' });
  }
  assertEquals(w.calls, []);
  assertEquals(w.left('traces'), 3);
});

Deno.test('a key missing or under 32 bytes is misconfigured, before any database call', async () => {
  for (const hmacKey of [undefined, 'short-key']) {
    const w = world({ expired: keys('traces', ADULT, 1) });
    const res = await handlePurge(await signed(NOW_S, hmacKey ?? KEY), w.deps({ hmacKey }));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { code: 'misconfigured' });
    assertEquals(w.calls, []);
  }
});

Deno.test('anything but POST is 405', async () => {
  const w = world();
  const res = await handlePurge(new Request('http://local/purge-trace-objects', { method: 'GET' }), w.deps());
  assertEquals(res.status, 405);
  assertEquals(w.calls, []);
});

// --- the run ------------------------------------------------------------------------------------

Deno.test("removes a blocked child's objects and the expired traces, clears their trace_path, and answers with counts only", async () => {
  const w = world({
    underage: [...keys('traces', CHILD, 3), ...keys('avatars', CHILD, 1)],
    expired: keys('traces', ADULT, 2),
  });
  const res = await handlePurge(await signed(), w.deps());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { status: 'done', underage_removed: 4, expired_removed: 2, failed: 0, trace_paths_cleared: 2, more: false });
  assertEquals(w.left('traces') + w.left('avatars'), 0);
  // only the expired traces that were deleted are cleared (the child's trips rows are gone already)
  assertEquals(w.cleared, [keys('traces', ADULT, 2).map((k) => k.name)]);
  // counts only: no key, path or user id anywhere in the response or the logs
  const text = JSON.stringify(body) + JSON.stringify(w.logs);
  assert(!text.includes(CHILD) && !text.includes(ADULT) && !text.includes('.bin.gz'));
  // one lease around the whole run, released at the end
  assertEquals(w.calls[0], `take:holder-1:${LEASE_S}`);
  assertEquals(w.calls.at(-1), 'release:holder-1');
});

Deno.test('each list is read once per LIST_LIMIT keys and removed in client-side batches of BATCH (review m1)', async () => {
  const w = world({ expired: keys('traces', ADULT, BATCH * 2 + 5) });
  const body = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals(body.expired_removed, BATCH * 2 + 5);
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')), [`expired:start:${LIST_LIMIT}`]);
  assertEquals(w.calls.filter((c) => c.startsWith('remove:')), [`remove:traces:${BATCH}`, `remove:traces:${BATCH}`, 'remove:traces:5']);
  assertEquals(w.calls.filter((c) => c.startsWith('clear:')), [`clear:${BATCH}`, `clear:${BATCH}`, 'clear:5']);
});

Deno.test('a full listing is followed by the next page after its last key; the run stops at MAX_LISTINGS with more', async () => {
  const w = world({ expired: keys('traces', ADULT, LIST_LIMIT * MAX_LISTINGS + 1) });
  const body = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals([body.expired_removed, body.more], [LIST_LIMIT * MAX_LISTINGS, true]);
  const lastOfFirst = keys('traces', ADULT, LIST_LIMIT)[LIST_LIMIT - 1]!.name;
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')), [`expired:start:${LIST_LIMIT}`, `expired:${lastOfFirst}:${LIST_LIMIT}`]);
  assert(JSON.stringify(w.logs).includes('stopped with work left'), 'more is logged as a count line ops can alert on');
  // the next wake finishes it
  const next = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals([next.expired_removed, next.more], [1, false]);
});

Deno.test('keys that can never be removed are passed over: the batch behind them is still removed (security M-1)', async () => {
  const all = keys('traces', ADULT, BATCH * 2);
  const stuck = new Set(all.slice(0, BATCH).map((k) => k.name)); // the whole head batch
  const w = world({ expired: all, stuck });
  const body = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals(body, { status: 'done', underage_removed: 0, expired_removed: BATCH, failed: BATCH, trace_paths_cleared: BATCH, more: false });
  assertEquals(w.left('traces'), BATCH);
  // and only the removed ones had their trace_path cleared
  assertEquals(w.cleared.flat().some((n) => stuck.has(n)), false);
});

Deno.test('negative control: without the cursor a stuck head of a full page would be listed again forever', async () => {
  // LIST_LIMIT stuck keys fill the first page; the fake's cursor is what reaches the key behind them
  const all = keys('traces', ADULT, LIST_LIMIT + 1);
  const stuck = new Set(all.slice(0, LIST_LIMIT).map((k) => k.name));
  const w = world({ expired: all, stuck });
  const body = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals([body.expired_removed, body.failed], [1, LIST_LIMIT]);
  // the same world with the cursor dropped from the listing: every page is the same stuck head
  const w2 = world({ expired: all, stuck });
  const noCursor: PurgeDb = { ...w2.db, expiredKeys: (_after, limit) => w2.db.expiredKeys(null, limit) };
  const stalled = await (await handlePurge(await signed(), w2.deps({ db: noCursor }))).json();
  assertEquals([stalled.expired_removed, stalled.more], [0, true], 'never reaches the key behind the stuck page');
});

Deno.test('a removal that throws is counted and passed over; the lease is still released', async () => {
  const w = world({ underage: keys('traces', CHILD, 2), expired: keys('traces', ADULT, 2) });
  const storage: PurgeStorage = { remove: () => Promise.reject(new Error(`boom for ${CHILD}`)) };
  const body = await (await handlePurge(await signed(), w.deps({ storage }))).json();
  assertEquals(body, { status: 'done', underage_removed: 0, expired_removed: 0, failed: 4, trace_paths_cleared: 0, more: false });
  assertEquals(w.calls.filter((c) => c.startsWith('clear:')), []);
  assertEquals(w.calls.at(-1), 'release:holder-1');
  assert(!JSON.stringify(w.logs).includes(CHILD), 'the storage error text (which could name a path) is never logged');
});

Deno.test('the run keeps a time budget inside pg_net\'s 10 s timeout and says more when it stops (review m3)', async () => {
  let t = 0;
  const w = world({ expired: keys('traces', ADULT, BATCH * 5) });
  const storage: PurgeStorage = {
    remove: async (bucket, names) => {
      t += 3000; // each remove call costs 3 s
      return await w.storage.remove(bucket, names);
    },
  };
  const body = await (await handlePurge(await signed(), w.deps({ storage, nowMs: () => t }))).json();
  // 0 s, 3 s and 6 s start a batch; 9 s is past BUDGET_MS
  assert(BUDGET_MS > 6000 && BUDGET_MS <= 9000);
  assertEquals([body.expired_removed, body.more], [BATCH * 3, true]);
});

Deno.test('a run that finds the lease held does nothing and says busy', async () => {
  const w = world({ expired: keys('traces', ADULT, 3), leaseHeld: true });
  const res = await handlePurge(await signed(), w.deps());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: 'busy', underage_removed: 0, expired_removed: 0, failed: 0, trace_paths_cleared: 0, more: false });
  assertEquals(w.calls, [`take:holder-1:${LEASE_S}`]);
  assertEquals(w.left('traces'), 3);
});

Deno.test('a database failure mid-run maps like every writer failure and still releases the lease', async () => {
  const w = world();
  const db: PurgeDb = { ...w.db, underageKeys: () => Promise.reject(new PgError('XX000', 'kaboom')) };
  const res = await handlePurge(await signed(), w.deps({ db }));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { code: 'internal' });
  assertEquals(w.calls.at(-1), 'release:holder-1');
});

Deno.test('the request body is ignored', async () => {
  const w = world({ expired: keys('traces', ADULT, 1) });
  const req = new Request('http://local/purge-trace-objects', {
    method: 'POST',
    headers: { 'x-sweep-signature': await signSweep('purge-trace-objects', KEY, NOW_S) },
    body: '{"bucket":"traces","names":["someone-else/everything"],"limit":100000}',
  });
  assertEquals((await (await handlePurge(req, w.deps())).json()).expired_removed, 1);
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')), [`expired:start:${LIST_LIMIT}`]);
});

// --- the ports over supabase-js -----------------------------------------------------------------

Deno.test('the ports call the service-role RPCs with the fixed job name and cursors, and validate the listing', async () => {
  const rpcs: [string, unknown][] = [];
  const removed: [string, string[]][] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      rpcs.push([fn, args]);
      if (fn === 'take_job_lease' || fn === 'release_job_lease') return Promise.resolve({ data: true, error: null });
      if (fn === 'clear_trace_paths') return Promise.resolve({ data: 1, error: null });
      if (fn === 'expired_trace_object_keys') return Promise.resolve({ data: [{ bucket: 'traces', name: 'u/t.bin.gz' }], error: null });
      return Promise.resolve({ data: [{ bucket: 'traces' }], error: null });
    },
    storage: {
      from: (bucket: string) => ({
        remove: (names: string[]) => {
          removed.push([bucket, names]);
          return Promise.resolve({ data: names.slice(1).map((name) => ({ name })), error: null });
        },
      }),
    },
  };
  // deno-lint-ignore no-explicit-any
  const { db, storage } = createPurgePorts(client as any);
  assertEquals(await db.takeLease('h', LEASE_S), true);
  await db.releaseLease('h');
  assertEquals(await db.expiredKeys('u/s.bin.gz', 7), [{ bucket: 'traces', name: 'u/t.bin.gz' }]);
  let threw = false;
  try {
    await db.underageKeys({ bucket: 'traces', name: 'c/x' }, 7);
  } catch {
    threw = true;
  }
  assert(threw, 'a listing row without a name is refused');
  assertEquals(await db.clearTracePaths(['u/t.bin.gz']), 1);
  assertEquals(await storage.remove('traces', ['a', 'b']), ['b'], 'the names Storage reports removed, not the names asked');
  assertEquals(rpcs, [
    ['take_job_lease', { p_job: PURGE_JOB, p_holder: 'h', p_seconds: LEASE_S }],
    ['release_job_lease', { p_job: PURGE_JOB, p_holder: 'h' }],
    ['expired_trace_object_keys', { p_limit: 7, p_after_name: 'u/s.bin.gz' }],
    ['underage_object_keys_after', { p_limit: 7, p_after_bucket: 'traces', p_after_name: 'c/x' }],
    ['clear_trace_paths', { p_keys: ['u/t.bin.gz'] }],
  ]);
  assertEquals(removed, [['traces', ['a', 'b']]]);
});

Deno.test('an RPC error is a PgError the handler maps', async () => {
  const client = { rpc: () => Promise.resolve({ data: null, error: { code: '42501', message: 'take_job_lease requires the service role' } }) };
  // deno-lint-ignore no-explicit-any
  const { db } = createPurgePorts(client as any);
  const w = world();
  const res = await handlePurge(await signed(), w.deps({ db }));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { code: 'misconfigured' });
});
