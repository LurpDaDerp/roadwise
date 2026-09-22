import { assert, assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { signSweep } from '../_shared/sweep_auth.ts';
import {
  BATCH,
  createPurgePorts,
  handlePurge,
  LEASE_S,
  MAX_BATCHES,
  PURGE_JOB,
  type ObjectKey,
  type PurgeDb,
  type PurgeDeps,
  type PurgeStorage,
} from './handler.ts';

const KEY = 'purge-test-key-0123456789abcdef-0123';
const NOW_S = 1_790_000_000;

/** An in-memory bucket store behind the two ports, recording every call in order. */
function world(opts: { underage?: ObjectKey[]; expired?: ObjectKey[]; leaseHeld?: boolean } = {}) {
  const objects = new Map<string, Set<string>>();
  const add = (k: ObjectKey) => {
    const set = objects.get(k.bucket) ?? new Set<string>();
    set.add(k.name);
    objects.set(k.bucket, set);
  };
  const underage = opts.underage ?? [];
  const expired = opts.expired ?? [];
  [...underage, ...expired].forEach(add);
  const alive = (k: ObjectKey) => objects.get(k.bucket)?.has(k.name) ?? false;
  const calls: string[] = [];
  let leaseHeld = opts.leaseHeld ?? false;
  const db: PurgeDb = {
    underageKeys: (limit) => {
      calls.push(`underage:${limit}`);
      return Promise.resolve(underage.filter(alive).slice(0, limit));
    },
    expiredKeys: (limit) => {
      calls.push(`expired:${limit}`);
      return Promise.resolve(expired.filter(alive).slice(0, limit));
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
      let n = 0;
      for (const name of names) if (objects.get(bucket)?.delete(name)) n += 1;
      return Promise.resolve(n);
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
    newHolder: () => 'holder-1',
    ...over,
  });
  return { objects, calls, logs, deps, db, storage };
}

const keys = (bucket: string, prefix: string, n: number): ObjectKey[] =>
  Array.from({ length: n }, (_, i) => ({ bucket, name: `${prefix}/${String(i).padStart(4, '0')}.bin.gz` }));

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
  assertEquals(w.objects.get('traces')?.size, 3);
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

Deno.test('removes a blocked child\'s objects and the expired traces, and answers with counts only', async () => {
  const w = world({
    underage: [...keys('traces', CHILD, 3), ...keys('avatars', CHILD, 1)],
    expired: keys('traces', ADULT, 2),
  });
  const res = await handlePurge(await signed(), w.deps());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { status: 'done', underage_removed: 4, expired_removed: 2, failed: 0, more: false });
  assertEquals([...w.objects.values()].reduce((n, s) => n + s.size, 0), 0);
  // counts only: no key, path or user id anywhere in the response or the logs
  const text = JSON.stringify(body) + JSON.stringify(w.logs);
  assert(!text.includes(CHILD) && !text.includes(ADULT) && !text.includes('.bin.gz'));
  // one lease around the whole run, released at the end
  assertEquals(w.calls[0], `take:holder-1:${LEASE_S}`);
  assertEquals(w.calls.at(-1), 'release:holder-1');
});

Deno.test('batches of BATCH keys, per bucket, until the list is empty', async () => {
  const w = world({ expired: keys('traces', ADULT, BATCH * 2 + 5) });
  const res = await handlePurge(await signed(), w.deps());
  assertEquals((await res.json()).expired_removed, BATCH * 2 + 5);
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')), [`expired:${BATCH}`, `expired:${BATCH}`, `expired:${BATCH}`, `expired:${BATCH}`]);
  assertEquals(w.calls.filter((c) => c.startsWith('remove:')), [`remove:traces:${BATCH}`, `remove:traces:${BATCH}`, 'remove:traces:5']);
});

Deno.test('a run stops at MAX_BATCHES per list and says there is more', async () => {
  const w = world({ expired: keys('traces', ADULT, BATCH * MAX_BATCHES + 1) });
  const body = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals(body.expired_removed, BATCH * MAX_BATCHES);
  assertEquals(body.more, true);
  assertEquals(w.objects.get('traces')?.size, 1);
  // the next wake finishes it
  const next = await (await handlePurge(await signed(), w.deps())).json();
  assertEquals([next.expired_removed, next.more], [1, false]);
});

Deno.test('a removal that fails stops that list, is counted, and the lease is still released', async () => {
  const w = world({ underage: keys('traces', CHILD, 2), expired: keys('traces', ADULT, 2) });
  const storage: PurgeStorage = { remove: () => Promise.reject(new Error(`boom for ${CHILD}`)) };
  const body = await (await handlePurge(await signed(), w.deps({ storage }))).json();
  assertEquals(body, { status: 'done', underage_removed: 0, expired_removed: 0, failed: 4, more: false });
  assertEquals(w.calls.at(-1), 'release:holder-1');
  assert(!JSON.stringify(w.logs).includes(CHILD), 'the storage error text (which could name a path) is never logged');
});

Deno.test('a batch that removes nothing ends the list (no spin on keys Storage will not remove)', async () => {
  const w = world({ expired: keys('traces', ADULT, 3) });
  const storage: PurgeStorage = { remove: () => Promise.resolve(0) };
  const body = await (await handlePurge(await signed(), w.deps({ storage }))).json();
  assertEquals(body.expired_removed, 0);
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')).length, 1);
});

Deno.test('a run that finds the lease held does nothing and says busy', async () => {
  const w = world({ expired: keys('traces', ADULT, 3), leaseHeld: true });
  const res = await handlePurge(await signed(), w.deps());
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: 'busy', underage_removed: 0, expired_removed: 0, failed: 0, more: false });
  assertEquals(w.calls, [`take:holder-1:${LEASE_S}`]);
  assertEquals(w.objects.get('traces')?.size, 3);
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
  assertEquals(w.calls.filter((c) => c.startsWith('expired:')), [`expired:${BATCH}`, `expired:${BATCH}`]);
});

// --- the ports over supabase-js -----------------------------------------------------------------

Deno.test('the ports call the service-role RPCs with the fixed job name and validate the listing', async () => {
  const rpcs: [string, unknown][] = [];
  const removed: [string, string[]][] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      rpcs.push([fn, args]);
      if (fn === 'take_job_lease') return Promise.resolve({ data: true, error: null });
      if (fn === 'release_job_lease') return Promise.resolve({ data: true, error: null });
      if (fn === 'expired_trace_object_keys') return Promise.resolve({ data: [{ bucket: 'traces', name: 'u/t.bin.gz' }], error: null });
      return Promise.resolve({ data: [{ bucket: 'traces' }], error: null });
    },
    storage: {
      from: (bucket: string) => ({
        remove: (names: string[]) => {
          removed.push([bucket, names]);
          return Promise.resolve({ data: names.map((name) => ({ name })), error: null });
        },
      }),
    },
  };
  // deno-lint-ignore no-explicit-any
  const { db, storage } = createPurgePorts(client as any);
  assertEquals(await db.takeLease('h', LEASE_S), true);
  await db.releaseLease('h');
  assertEquals(await db.expiredKeys(7), [{ bucket: 'traces', name: 'u/t.bin.gz' }]);
  let threw = false;
  try {
    await db.underageKeys(7);
  } catch {
    threw = true;
  }
  assert(threw, 'a listing row without a name is refused');
  assertEquals(await storage.remove('traces', ['a', 'b']), 2);
  assertEquals(rpcs, [
    ['take_job_lease', { p_job: PURGE_JOB, p_holder: 'h', p_seconds: LEASE_S }],
    ['release_job_lease', { p_job: PURGE_JOB, p_holder: 'h' }],
    ['expired_trace_object_keys', { p_limit: 7 }],
    ['underage_object_keys', { p_limit: 7 }],
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
