import { assertEquals } from '@std/assert';
import type { RevokeOutcome } from '../_shared/apple_siwa.ts';
import { handleAccountDelete, type DeletePorts } from './handler.ts';

const UID = '11111111-1111-4111-8111-111111111111';

const APPLE_SUB = '001234.abcdef0123456789.0123';

function world(
  opts: {
    deleteError?: unknown;
    authThrows?: boolean;
    emailError?: boolean;
    purgeError?: boolean;
    appleSubject?: string | null;
    revoke?: RevokeOutcome | 'throws' | 'unconfigured';
  } = {}
) {
  const calls: string[] = [];
  const warnings: unknown[][] = [];
  const ports: DeletePorts = {
    userFacts: (userId) => {
      calls.push(`email:${userId}`);
      return opts.emailError
        ? Promise.reject(new Error('lookup failed'))
        : Promise.resolve({ email: 'a@example.com', appleSubject: opts.appleSubject === undefined ? APPLE_SUB : opts.appleSubject });
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
  const revokeApple =
    opts.revoke === 'unconfigured'
      ? null
      : (code: string, sub: string) => {
          calls.push(`revoke:${code}:${sub}`);
          return opts.revoke === 'throws' ? Promise.reject(new Error('boom')) : Promise.resolve((opts.revoke ?? 'revoked') as RevokeOutcome);
        };
  const log = { warn: (...args: unknown[]) => warnings.push(args), error: () => {} };
  return { calls, warnings, deps: { verifyJwt, ports, log, revokeApple } };
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

Deno.test('an Apple code: the authorization is revoked after the delete and before the purge', async () => {
  const w = world();
  const res = await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 'c0de.1' }), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true });
  assertEquals(w.calls, [`email:${UID}`, `delete:${UID}`, `revoke:c0de.1:${APPLE_SUB}`, `purge:${UID}:a@example.com`]);
  assertEquals(w.warnings, []);
});

Deno.test('no revoke without a code, without an Apple identity, or when the delete failed', async () => {
  const noCode = world();
  await handleAccountDelete(post({ confirm: 'DELETE' }), noCode.deps);
  assertEquals(noCode.calls, [`email:${UID}`, `delete:${UID}`, `purge:${UID}:a@example.com`]);

  const google = world({ appleSubject: null });
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 'c' }), google.deps)).status, 200);
  assertEquals(google.calls, [`email:${UID}`, `delete:${UID}`, `purge:${UID}:a@example.com`]);

  const failed = world({ deleteError: Object.assign(new Error('down'), { status: 502 }) });
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 'c' }), failed.deps)).status, 503);
  assertEquals(failed.calls, [`email:${UID}`, `delete:${UID}`]);
});

Deno.test('a revoke that fails, throws or is not configured never stops the deletion; it is logged without the code', async () => {
  for (const revoke of ['exchange_failed', 'throws', 'unconfigured'] as const) {
    const w = world({ revoke });
    const res = await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 'secret-code' }), w.deps);
    assertEquals(res.status, 200);
    assertEquals(w.calls.at(-1), `purge:${UID}:a@example.com`);
    assertEquals(w.warnings.length, 1);
    assertEquals(JSON.stringify(w.warnings).includes('secret-code'), false);
  }
});

Deno.test('a malformed Apple code is refused before anything is deleted', async () => {
  const w = world();
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', apple_code: '' }), w.deps)).status, 400);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 'has space' }), w.deps)).status, 400);
  assertEquals((await handleAccountDelete(post({ confirm: 'DELETE', apple_code: 7 }), w.deps)).status, 400);
  assertEquals(w.calls, []);
});
