import { assert, assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import { z } from 'zod';
import { bearerToken, invalidPayload, json, MAX_ISSUES, pgFailure, readJsonBody, requestId, ROW_CODES, withRequestId, type Logger } from './http.ts';
import { asPgError, isPgError, PgError } from './pg.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const req = (init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request('http://local/fn', { method: 'POST', ...init });

const capture = (): { log: Logger; errors: unknown[][] } => {
  const errors: unknown[][] = [];
  return { log: { warn: () => {}, error: (...a) => errors.push(a) }, errors };
};

Deno.test('bearerToken reads the Authorization header case-insensitively and refuses anything else', () => {
  assertEquals(bearerToken(req({ headers: { authorization: 'Bearer abc.def' } })), 'abc.def');
  assertEquals(bearerToken(req({ headers: { authorization: 'bearer   abc' } })), 'abc');
  assertEquals(bearerToken(req({ headers: { authorization: 'Basic abc' } })), null);
  assertEquals(bearerToken(req({ headers: { authorization: 'Bearer' } })), null);
  assertEquals(bearerToken(req()), null);
});

Deno.test('requestId mints a fresh uuid and never reads a client header', () => {
  const id = requestId();
  assertMatch(id, UUID);
  assertNotEquals(requestId(), id);
});

Deno.test('withRequestId stamps the id on any response and hands it back', async () => {
  const res = withRequestId(json(200, { ok: true }), 'abc');
  assertEquals(res.headers.get('x-request-id'), 'abc');
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertEquals(await res.json(), { ok: true });
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
  // with the exact bytes it was parsed from (what an App Attest assertion signs)
  assertEquals(good, { ok: true, body: { a: 1 }, raw: new TextEncoder().encode('{"a":1}') });
});

Deno.test('readJsonBody stops reading a chunked body at the cap instead of buffering it whole', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024).fill(0x78);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const result = await readJsonBody(new Request('http://local/fn', { method: 'POST', body: stream }), 4096);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 413);
  assert(pulled < 64, `read ${pulled} chunks: the whole stream`);
});

Deno.test('json replies carry the content type and any extra headers', async () => {
  const res = json(503, { code: 'retry' }, { 'retry-after': '2' });
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertEquals(res.headers.get('retry-after'), '2');
  assertEquals(await res.json(), { code: 'retry' });
});

Deno.test('invalidPayload names at most 20 issues, the contract version first, however many items were bad', async () => {
  // `v` after the array, so zod reports it after every bad item
  const schema = z.object({ events: z.array(z.object({ id: z.string() })), v: z.literal(5) }).strict();
  const parsed = schema.safeParse({ events: new Array(5000).fill(0), v: 6 });
  assert(!parsed.success);
  assertEquals(parsed.error.issues.length, 5001);
  const res = invalidPayload(parsed.error);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(MAX_ISSUES, 20);
  assertEquals([body.code, body.issues.length], ['invalid_payload', 20]);
  assertEquals(body.issues[0].path, 'v');
  assertEquals(body.issues[1].path, 'events.0');
  // a refusal with few issues is answered whole, in zod's order
  const few = schema.safeParse({ events: [{ id: 1 }], v: 5, extra: true });
  assert(!few.success);
  assertEquals((await invalidPayload(few.error).json()).issues.map((i: { path: string }) => i.path), ['events.0.id', '']);
});

Deno.test('pgFailure answers with the mapped code only; the database message goes to the log', async () => {
  const { log, errors } = capture();
  const shape = pgFailure(new PgError('22023', 'apply_trip day does not match the trip'), log, { requestId: 'r', tz: 'UTC' }, 'fn');
  assertEquals(shape.status, 400);
  assertEquals(await shape.json(), { code: 'invalid_envelope' });
  assertEquals(errors[0][0], 'fn envelope refused');
  assertEquals(errors[0][1], { requestId: 'r', tz: 'UTC', message: 'apply_trip day does not match the trip' });

  for (const code of ['23514', '23505', '22P02', '23502', '22003']) {
    assert(ROW_CODES.has(code), code);
    const res = pgFailure(new PgError(code, 'new row for relation "trips" violates check constraint "x"'), log, {}, 'fn');
    assertEquals(res.status, 400, code);
    assertEquals(await res.json(), { code: 'invalid_event_rows' });
  }

  for (const code of ['55P03', '40P01', '40001']) {
    const res = pgFailure(new PgError(code, 'busy'), log, {}, 'fn');
    assertEquals(res.status, 503, code);
    assertEquals(res.headers.get('retry-after'), '2');
    assertEquals(await res.json(), { code: 'retry' });
  }

  assertEquals(await pgFailure(new PgError('42501', 'fn requires the service role'), log, {}, 'fn').json(), { code: 'misconfigured' });
  assertEquals(await pgFailure(new PgError('42501', 'trip not owned by user'), log, {}, 'fn').json(), { code: 'forbidden' });
  assertEquals(await pgFailure(new PgError('XX000', 'kaboom'), log, {}, 'fn').json(), { code: 'internal' });
  assertEquals(await pgFailure(new Error('plain'), log, {}, 'fn').json(), { code: 'internal' });
  assertEquals(await pgFailure('string', log, {}, 'fn').json(), { code: 'internal' });
  // every non-retryable failure was logged (retryable ones are not: nothing to act on), and none
  // of the bodies above carried a database message
  assertEquals(errors.length, 11);
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
