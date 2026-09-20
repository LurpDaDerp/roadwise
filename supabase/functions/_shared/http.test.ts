import { assertEquals } from '@std/assert';
import { bearerToken, json, readJsonBody, requestId } from './http.ts';
import { asPgError, isPgError, PgError } from './pg.ts';

const req = (init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request('http://local/fn', { method: 'POST', ...init });

Deno.test('bearerToken reads the Authorization header case-insensitively and refuses anything else', () => {
  assertEquals(bearerToken(req({ headers: { authorization: 'Bearer abc.def' } })), 'abc.def');
  assertEquals(bearerToken(req({ headers: { authorization: 'bearer   abc' } })), 'abc');
  assertEquals(bearerToken(req({ headers: { authorization: 'Basic abc' } })), null);
  assertEquals(bearerToken(req({ headers: { authorization: 'Bearer' } })), null);
  assertEquals(bearerToken(req()), null);
});

Deno.test('requestId prefers the gateway headers and otherwise mints one', () => {
  assertEquals(requestId(req({ headers: { 'x-request-id': 'r1', 'sb-request-id': 'r2' } })), 'r1');
  assertEquals(requestId(req({ headers: { 'sb-request-id': 'r2' } })), 'r2');
  assertEquals(typeof requestId(req()), 'string');
});

Deno.test('readJsonBody caps the size by header and by bytes, and refuses non-JSON', async () => {
  const declared = await readJsonBody(req({ headers: { 'content-length': '999' }, body: '{}' }), 10);
  assertEquals(declared.ok, false);
  if (!declared.ok) assertEquals(declared.response.status, 413);
  const actual = await readJsonBody(req({ body: '{"pad":"xxxxxxxxxxxxxxxxxxxx"}' }), 10);
  assertEquals(actual.ok, false);
  if (!actual.ok) assertEquals(actual.response.status, 413);
  const bad = await readJsonBody(req({ body: '{nope' }), 100);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(await bad.response.json(), { code: 'invalid_json' });
  const good = await readJsonBody(req({ body: '{"a":1}' }), 100);
  assertEquals(good, { ok: true, body: { a: 1 } });
});

Deno.test('json replies carry the content type and any extra headers', async () => {
  const res = json(503, { code: 'retry' }, { 'retry-after': '2' });
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertEquals(res.headers.get('retry-after'), '2');
  assertEquals(await res.json(), { code: 'retry' });
});

Deno.test('asPgError keeps the SQLSTATE, message, details and hint; isPgError recognises the shape from any module', () => {
  const err = asPgError({ code: '22023', message: 'nope', details: 'd', hint: 'h' });
  assertEquals(err instanceof PgError, true);
  assertEquals([err.code, err.message, err.details, err.hint], ['22023', 'nope', 'd', 'h']);
  assertEquals(asPgError({ message: 'no code' }).code, 'unknown');
  assertEquals(isPgError(err), true);
  const twin = Object.assign(new Error('twin'), { name: 'PgError', code: '42501' });
  assertEquals(isPgError(twin), true);
  assertEquals(isPgError(new Error('plain')), false);
  assertEquals(isPgError('string'), false);
});
