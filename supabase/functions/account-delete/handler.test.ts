import { assertEquals } from '@std/assert';
import { handleAccountDelete, type DeletePorts } from './handler.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const quiet = { warn: () => {}, error: () => {} };

function world(opts: { deleteError?: unknown; authThrows?: boolean; emailError?: boolean; purgeError?: boolean } = {}) {
  const calls: string[] = [];
  const ports: DeletePorts = {
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
  const verifyJwt = (token: string) => (opts.authThrows ? Promise.reject(new Error('auth down')) : Promise.resolve(token === 'good' ? UID : null));
  return { calls, deps: { verifyJwt, ports, log: quiet } };
}

const post = (body: unknown, token = 'good', method = 'POST') =>
  new Request('http://local/functions/v1/account-delete', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

Deno.test('the email is read, the auth user deleted, the audit purged, in that order; the answer is deleted: true', async () => {
  const w = world();
  const res = await handleAccountDelete(post({ confirm: 'DELETE' }), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true });
  assertEquals(res.headers.get('cache-control'), 'no-store');
  assertEquals(w.calls, [`email:${UID}`, `delete:${UID}`, `purge:${UID}:a@example.com`]);
});

Deno.test("the account is always the caller's: an id in the body is refused; without the word nothing happens", async () => {
  const w = world();
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', userId: 'other' }), w.deps)).status, 400);
  assertEquals((await handleAccountDelete(post({ confirm: 'delete' }), w.deps)).status, 400);
  assertEquals((await handleAccountDelete(post('not json'), w.deps)).status, 400);
  assertEquals(w.calls, []);
});

Deno.test('only POST; no token or a refused one is 401; Auth down is 503; an oversized body is refused unread', async () => {
  const w = world();
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }, 'good', 'GET'), w.deps)).status, 405);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }, ''), w.deps)).status, 401);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }, 'bad'), w.deps)).status, 401);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }), world({ authThrows: true }).deps)).status, 503);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', pad: 'x'.repeat(2000) }), w.deps)).status, 413);
  assertEquals(w.calls, []);
});

Deno.test('the auth delete failing: 503 when GoTrue is down, 500 otherwise; never a 200 and no purge', async () => {
  const down = world({ deleteError: Object.assign(new Error('down'), { status: 502 }) });
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }), down.deps)).status, 503);
  const refused = world({ deleteError: Object.assign(new Error('nope'), { status: 422 }) });
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE' }), refused.deps)).status, 500);
  assertEquals(refused.calls, [`email:${UID}`, `delete:${UID}`]);
});

Deno.test('an unreadable email or a failed purge never undoes the deletion', async () => {
  const w = world({ emailError: true, purgeError: true });
  const res = await handleAccountDelete(post({ confirm: 'DELETE' }), w.deps);
  assertEquals(res.status, 200);
  assertEquals(w.calls, [`email:${UID}`, `delete:${UID}`, `purge:${UID}:null`]);
});
