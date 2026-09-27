import { assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { BATCH, handleAccountDelete, LIST_LIMIT, type DeletePorts, type ObjectKey } from './handler.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const quiet = { warn: () => {}, error: () => {} };
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An in-memory bucket store listing exactly as 0013 does, recording every call in order. */
function world(opts: {
  objects?: ObjectKey[];
  stuck?: Set<string>;
  refuseBucket?: string;
  listError?: unknown;
  deleteError?: unknown;
  authThrows?: boolean;
  emailError?: boolean;
  purgeError?: boolean;
} = {}) {
  const alive = new Set((opts.objects ?? []).map((k) => `${k.bucket}\u0000${k.name}`));
  const all = [...(opts.objects ?? [])].sort((a, b) => byteOrder(a.bucket, b.bucket) || byteOrder(a.name, b.name));
  const calls: string[] = [];
  const ports: DeletePorts = {
    objectKeys: (userId, after, limit) => {
      calls.push(`list:${userId}:${after ? after.name : 'start'}`);
      if (opts.listError) return Promise.reject(opts.listError);
      const rest = all.filter(
        (k) =>
          k.name.startsWith(`${userId}/`) &&
          alive.has(`${k.bucket}\u0000${k.name}`) &&
          (!after || byteOrder(k.bucket, after.bucket) > 0 || (k.bucket === after.bucket && byteOrder(k.name, after.name) > 0))
      );
      return Promise.resolve(rest.slice(0, limit));
    },
    removeObjects: (bucket, names) => {
      calls.push(`remove:${bucket}:${names.length}`);
      if (bucket === opts.refuseBucket) return Promise.reject(new Error('refused'));
      const gone = names.filter((n) => !opts.stuck?.has(n));
      for (const n of gone) alive.delete(`${bucket}\u0000${n}`);
      return Promise.resolve(gone);
    },
    userEmail: (userId) => {
      calls.push(`email:${userId}`);
      return opts.emailError ? Promise.reject(new Error('lookup failed')) : Promise.resolve('a@example.com');
    },
    deleteUser: (userId) => {
      calls.push(`delete:${userId}`);
      return opts.deleteError ? Promise.reject(opts.deleteError) : Promise.resolve();
    },
    purgeAuthAudit: (userId, email) => {
      calls.push(`purge:${userId}:${email}`);
      return opts.purgeError ? Promise.reject(new Error('purge failed')) : Promise.resolve(5);
    },
  };
  const verifyJwt = (token: string) => {
    if (opts.authThrows) return Promise.reject(new Error('auth down'));
    return Promise.resolve(token === 'good' ? UID : null);
  };
  return { calls, alive, deps: { verifyJwt, ports, log: quiet } };
}

const post = (token: string | null, body: unknown = { confirm: 'DELETE' }, method = 'POST') =>
  new Request('http://local/account-delete', {
    method,
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

const traces = (n: number, user = UID): ObjectKey[] =>
  Array.from({ length: n }, (_, i) => ({ bucket: 'traces', name: `${user}/t-${String(i).padStart(5, '0')}.bin.gz` }));

Deno.test('the objects go first, then the auth user; the answer counts them', async () => {
  const w = world({ objects: [...traces(3), { bucket: 'other', name: `${UID}/x.bin` }, ...traces(2, OTHER)] });
  const res = await handleAccountDelete(post('good'), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, objectsRemoved: 4, objectsLeft: 0 });
  assertEquals(res.headers.get('cache-control'), 'no-store');
  assertEquals(w.calls, [
    `list:${UID}:start`,
    'remove:other:1',
    'remove:traces:3',
    `email:${UID}`,
    `delete:${UID}`,
    `purge:${UID}:a@example.com`,
  ]);
  // the other person's objects are untouched
  assertEquals([...w.alive].filter((k) => k.includes(OTHER)).length, 2);
});

Deno.test('the account is always the caller\'s: an id in the body is refused, not followed', async () => {
  const w = world();
  const res = await handleAccountDelete(post('good', { confirm: 'DELETE', userId: OTHER }), w.deps);
  assertEquals(res.status, 400);
  assertEquals(w.calls, []);
});

Deno.test('without the confirmation word nothing happens', async () => {
  for (const body of [{}, { confirm: 'delete' }, { confirm: true }, 'DELETE', 'not json']) {
    const w = world({ objects: traces(1) });
    const res = await handleAccountDelete(post('good', body), w.deps);
    assertEquals(res.status, 400);
    assertEquals(w.calls, []);
  }
});

Deno.test('only POST; no token or a refused one is 401; Auth down is 503; nothing runs', async () => {
  assertEquals((await handleAccountDelete(post('good', undefined, 'GET'), world().deps)).status, 405);
  for (const token of [null, 'bad']) {
    const w = world();
    assertEquals((await handleAccountDelete(post(token), w.deps)).status, 401);
    assertEquals(w.calls, []);
  }
  const down = world({ authThrows: true });
  assertEquals((await handleAccountDelete(post('good'), down.deps)).status, 503);
  assertEquals(down.calls, []);
});

Deno.test('an oversized body is refused unread', async () => {
  const w = world();
  const res = await handleAccountDelete(post('good', 'x'.repeat(4096)), w.deps);
  assertEquals(res.status, 413);
  assertEquals(w.calls, []);
});

Deno.test('many objects: listed a page at a time, removed a batch at a time', async () => {
  const w = world({ objects: traces(LIST_LIMIT + 5) });
  const res = await handleAccountDelete(post('good'), w.deps);
  assertEquals(await res.json(), { deleted: true, objectsRemoved: LIST_LIMIT + 5, objectsLeft: 0 });
  assertEquals(w.calls.filter((c) => c.startsWith('list:')).length, 2);
  assertEquals(w.calls.filter((c) => c.startsWith('remove:')).length, Math.ceil(LIST_LIMIT / BATCH) + 1);
  assertEquals(w.calls.slice(-2), [`delete:${UID}`, `purge:${UID}:a@example.com`]);
});

Deno.test('a refused or partial removal is counted, and the account is still deleted (the sweep collects the rest)', async () => {
  const w = world({ objects: [...traces(2), { bucket: 'other', name: `${UID}/x.bin` }], refuseBucket: 'other', stuck: new Set([`${UID}/t-00001.bin.gz`]) });
  const res = await handleAccountDelete(post('good'), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, objectsRemoved: 1, objectsLeft: 2 });
  assertEquals(w.calls.includes(`delete:${UID}`), true);
});

Deno.test('a listing that fails deletes nothing and says why in a code', async () => {
  const w = world({ listError: new PgError('40001', 'serialization failure') });
  const res = await handleAccountDelete(post('good'), w.deps);
  assertEquals(res.status, 503);
  assertEquals(w.calls.some((c) => c.startsWith('delete:') || c.startsWith('purge:')), false);
  const drift = world({ listError: new Error('account-delete: a listing that is not an array') });
  const res2 = await handleAccountDelete(post('good'), drift.deps);
  assertEquals(res2.status, 500);
  assertEquals(await res2.json(), { code: 'internal' });
});

Deno.test('the auth delete failing: 503 when GoTrue is down, 500 otherwise; never a 200', async () => {
  const down = await handleAccountDelete(post('good'), world({ deleteError: Object.assign(new Error('x'), { status: 502 }) }).deps);
  assertEquals(down.status, 503);
  const unreachable = await handleAccountDelete(post('good'), world({ deleteError: new Error('fetch failed') }).deps);
  assertEquals(unreachable.status, 503);
  const refused = await handleAccountDelete(post('good'), world({ deleteError: Object.assign(new Error('x'), { status: 400 }) }).deps);
  assertEquals(refused.status, 500);
  assertEquals(await refused.json(), { code: 'internal' });
});

Deno.test('the audit log is purged only after the delete succeeded, and never undoes it', async () => {
  const failed = world({ deleteError: Object.assign(new Error('x'), { status: 502 }) });
  await handleAccountDelete(post('good'), failed.deps);
  assertEquals(failed.calls.some((c) => c.startsWith('purge:')), false);

  const purgeFails = world({ purgeError: true });
  const res = await handleAccountDelete(post('good'), purgeFails.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).deleted, true);

  // No email to hand: the purge still runs on the id, which every audit row carries.
  const noEmail = world({ emailError: true });
  const ok = await handleAccountDelete(post('good'), noEmail.deps);
  assertEquals(ok.status, 200);
  assertEquals(noEmail.calls.slice(-2), [`delete:${UID}`, `purge:${UID}:null`]);
});
