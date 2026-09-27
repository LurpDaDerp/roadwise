import { assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { EXPORT_KEY, EXPORT_MAX, EXPORT_WINDOW, handleAccountExport, RETRY_AFTER_S, type ExportDb } from './handler.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const quiet = { warn: () => {}, error: () => {} };

function doc(userId: string) {
  return { format: 'roadwise-export', format_version: 1, account: { user_id: userId, email: 'a@example.com' }, trips: [] };
}

function world(opts: { budget?: boolean; exported?: unknown; exportError?: unknown; authThrows?: boolean } = {}) {
  const calls: string[] = [];
  const db: ExportDb = {
    takeRateLimit: (userId, key, window, max) => {
      calls.push(`take:${userId}:${key}:${window}:${max}`);
      return Promise.resolve(opts.budget ?? true);
    },
    exportAccount: (userId) => {
      calls.push(`export:${userId}`);
      if (opts.exportError) return Promise.reject(opts.exportError);
      return Promise.resolve('exported' in opts ? opts.exported : doc(userId));
    },
  };
  const verifyJwt = (token: string) => {
    if (opts.authThrows) return Promise.reject(new Error('auth down'));
    return Promise.resolve(token === 'good' ? UID : null);
  };
  return { calls, deps: { verifyJwt, db, log: quiet } };
}

const post = (token: string | null, body = '{}', method = 'POST') =>
  new Request('http://local/account-export', {
    method,
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
    body: method === 'POST' ? body : undefined,
  });

Deno.test('the caller gets their own document, never cached, with a request id', async () => {
  const w = world();
  const res = await handleAccountExport(post('good'), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), doc(UID));
  assertEquals(res.headers.get('cache-control'), 'no-store');
  assertEquals(typeof res.headers.get('x-request-id'), 'string');
  assertEquals(w.calls, [`take:${UID}:${EXPORT_KEY}:${EXPORT_WINDOW}:${EXPORT_MAX}`, `export:${UID}`]);
});

Deno.test('the body cannot name another account: it is ignored', async () => {
  const w = world();
  const res = await handleAccountExport(post('good', JSON.stringify({ userId: OTHER, p_user: OTHER })), w.deps);
  assertEquals(res.status, 200);
  assertEquals(w.calls.includes(`export:${OTHER}`), false);
});

Deno.test('a document that is not the caller\'s is never sent', async () => {
  for (const exported of [doc(OTHER), { account: null }, [], null, 'x']) {
    const w = world({ exported });
    const res = await handleAccountExport(post('good'), w.deps);
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { code: 'internal' });
  }
});

Deno.test('only POST', async () => {
  const res = await handleAccountExport(post('good', '', 'GET'), world().deps);
  assertEquals(res.status, 405);
});

Deno.test('no token, or one Auth refuses: 401 before anything runs', async () => {
  for (const token of [null, 'bad']) {
    const w = world();
    const res = await handleAccountExport(post(token), w.deps);
    assertEquals(res.status, 401);
    assertEquals(w.calls, []);
  }
});

Deno.test('Auth unreachable: 503 retry, nothing runs', async () => {
  const w = world({ authThrows: true });
  const res = await handleAccountExport(post('good'), w.deps);
  assertEquals(res.status, 503);
  assertEquals(w.calls, []);
});

Deno.test('an oversized body is refused unread', async () => {
  const w = world();
  const res = await handleAccountExport(post('good', 'x'.repeat(2048)), w.deps);
  assertEquals(res.status, 413);
  assertEquals(w.calls, []);
});

Deno.test('a body that is not JSON is simply ignored', async () => {
  const res = await handleAccountExport(post('good', 'not json'), world().deps);
  assertEquals(res.status, 200);
});

Deno.test('the budget is spent: 429 with a retry, and the export never runs', async () => {
  const w = world({ budget: false });
  const res = await handleAccountExport(post('good'), w.deps);
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { code: 'too_many_requests' });
  assertEquals(res.headers.get('retry-after'), String(RETRY_AFTER_S));
  assertEquals(w.calls.some((c) => c.startsWith('export:')), false);
});

Deno.test('a database failure maps through the shared codes, with no message in the body', async () => {
  const w = world({ exportError: new PgError('40001', 'serialization failure') });
  const res = await handleAccountExport(post('good'), w.deps);
  assertEquals(res.status, 503);
  const other = await handleAccountExport(post('good'), world({ exportError: new PgError('P0002', 'no such account') }).deps);
  assertEquals(other.status, 500);
  assertEquals(await other.json(), { code: 'internal' });
});
