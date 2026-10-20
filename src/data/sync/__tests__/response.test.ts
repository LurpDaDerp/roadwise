/** @jest-environment node */
import { classifyInvokeError, classifyStatus } from '@/data/sync/response';
import { functionsHttpError } from '@/data/sync/__fixtures__/fakes';

test('a 404 is not a refusal: the function is not there (yet), so the item retries', async () => {
  expect(classifyStatus(404)).toBe('retryable');
  // Whatever the gateway puts in its body, the item records the status: it is what is reopened on.
  const bare = await classifyInvokeError(functionsHttpError(404, { code: 'NOT_FOUND' }).error, 0);
  expect(bare).toMatchObject({ kind: 'retryable', code: 'http_404', status: 404 });
});

test('the server’s own refusals stay terminal', () => {
  expect(classifyStatus(400)).toBe('terminal');
  expect(classifyStatus(403)).toBe('terminal');
  expect(classifyStatus(413)).toBe('terminal');
  expect(classifyStatus(401)).toBe('unauthorized');
  expect(classifyStatus(429)).toBe('retryable');
  expect(classifyStatus(503)).toBe('retryable');
});
