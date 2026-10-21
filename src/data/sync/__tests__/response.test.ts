/** @jest-environment node */
import { classifyInvokeError, classifyStatus, SERVER_BEHIND_CODE } from '@/data/sync/response';
import { functionsHttpError } from '@/data/sync/__fixtures__/fakes';

test('a 404 is not a refusal: the function is not there (yet), so the item retries', async () => {
  expect(classifyStatus(404)).toBe('retryable');
  // Whatever the gateway puts in its body, the item records the status: it is what is reopened on.
  const bare = await classifyInvokeError(functionsHttpError(404, { code: 'NOT_FOUND' }).error, 0);
  expect(bare).toMatchObject({ kind: 'retryable', code: 'http_404', status: 404 });
});

test('a function’s own 404 `not_found` (no such trip or event on the server) is a refusal, never the missing-function retry', async () => {
  const own = await classifyInvokeError(functionsHttpError(404, { code: 'not_found' }).error, 0);
  expect(own).toMatchObject({ kind: 'terminal', code: 'not_found', status: 404 });
  const empty = await classifyInvokeError(functionsHttpError(404, {}).error, 0);
  expect(empty).toMatchObject({ kind: 'retryable', code: 'http_404' });
});

test('the server’s own refusals stay terminal', () => {
  expect(classifyStatus(400)).toBe('terminal');
  expect(classifyStatus(403)).toBe('terminal');
  expect(classifyStatus(413)).toBe('terminal');
  expect(classifyStatus(409)).toBe('terminal');
  expect(classifyStatus(401)).toBe('unauthorized');
  expect(classifyStatus(429)).toBe('retryable');
  expect(classifyStatus(503)).toBe('retryable');
});

test('a 400 that refuses the upload’s contract version (an issue at path `v`) is a server behind the app: retried, never failed', async () => {
  const behind = await classifyInvokeError(
    functionsHttpError(400, { code: 'invalid_payload', issues: [{ path: '', message: 'Unrecognized key: "origin"' }, { path: 'v', message: 'Invalid input: expected 3' }] }).error,
    0
  );
  expect(behind).toEqual({ kind: 'retryable', code: SERVER_BEHIND_CODE, status: 400, retryAfterS: null });
  expect(SERVER_BEHIND_CODE).toBe('server_behind');
});

test('any other invalid_payload stays a refusal, and so does a version issue under another code', async () => {
  const other = await classifyInvokeError(functionsHttpError(400, { code: 'invalid_payload', issues: [{ path: 'events.0.tier', message: 'tier not allowed' }] }).error, 0);
  expect(other).toMatchObject({ kind: 'terminal', code: 'invalid_payload' });
  const nested = await classifyInvokeError(functionsHttpError(400, { code: 'invalid_payload', issues: [{ path: 'exposure.v', message: 'x' }] }).error, 0);
  expect(nested).toMatchObject({ kind: 'terminal', code: 'invalid_payload' });
  const noIssues = await classifyInvokeError(functionsHttpError(400, { code: 'invalid_payload' }).error, 0);
  expect(noIssues).toMatchObject({ kind: 'terminal', code: 'invalid_payload' });
  const notPayload = await classifyInvokeError(functionsHttpError(400, { code: 'spoofed_payload', issues: [{ path: 'v' }] }).error, 0);
  expect(notPayload).toMatchObject({ kind: 'terminal', code: 'spoofed_payload' });
  const notFirstFifty = await classifyInvokeError(
    functionsHttpError(400, { code: 'invalid_payload', issues: [...Array.from({ length: 60 }, () => ({ path: 'events' })), { path: 'v' }] }).error,
    0
  );
  expect(notFirstFifty).toMatchObject({ kind: 'terminal' });
});
