/** @jest-environment node */
import {
  classifyInvokeError,
  classifyStatus,
  classifyStorageError,
  dayKeyOf,
  FinalizeResponseSchema,
  isDatabaseLocked,
  localDay,
  retryAfterSeconds,
} from '@/data/sync/response';

const T0 = 1_700_000_000_000;

const httpError = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  name: 'FunctionsHttpError',
  context: {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  },
});

test('the status decides whether an item is refused, re-authorized or retried', () => {
  expect(classifyStatus(400)).toBe('terminal');
  expect(classifyStatus(403)).toBe('terminal');
  expect(classifyStatus(422)).toBe('terminal');
  expect(classifyStatus(401)).toBe('unauthorized');
  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    expect(classifyStatus(status)).toBe('retryable');
  }
  // No status at all is a request that never reached anyone.
  expect(classifyStatus(null)).toBe('retryable');
});

test('a 400 carries the server code through to the item', async () => {
  await expect(
    classifyInvokeError(httpError(400, { code: 'implausible_speed', field: 'provisional' }), T0)
  ).resolves.toEqual({
    kind: 'terminal',
    code: 'implausible_speed',
    status: 400,
    retryAfterS: null,
  });
});

test('a body that says nothing useful falls back to naming the status', async () => {
  await expect(classifyInvokeError(httpError(503, 'gateway down'), T0)).resolves.toMatchObject({
    kind: 'retryable',
    code: 'http_503',
  });
  await expect(
    classifyInvokeError({ name: 'FunctionsFetchError', message: 'failed' }, T0)
  ).resolves.toMatchObject({ kind: 'retryable', code: 'network', status: null });
});

test('Retry-After is read as seconds or as an HTTP date', () => {
  expect(retryAfterSeconds('120', T0)).toBe(120);
  expect(retryAfterSeconds(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90);
  // A date already past asks for no wait at all, never a negative one.
  expect(retryAfterSeconds(new Date(T0 - 90_000).toUTCString(), T0)).toBe(0);
  expect(retryAfterSeconds('soon', T0)).toBeNull();
  expect(retryAfterSeconds(null, T0)).toBeNull();
});

test('a storage 409 is not a failure: the object is already where it belongs', () => {
  expect(classifyStorageError({ status: 409, message: 'The resource already exists' })).toMatchObject(
    { alreadyExists: true }
  );
  // Some storage errors carry the status only as a string, and some only in the message.
  expect(classifyStorageError({ statusCode: '409', message: 'Duplicate' })).toMatchObject({
    alreadyExists: true,
  });
  expect(classifyStorageError({ message: 'The resource already exists' })).toMatchObject({
    alreadyExists: true,
  });
  expect(classifyStorageError({ status: 500, message: 'boom' })).toMatchObject({
    alreadyExists: false,
    kind: 'retryable',
    code: 'storage_500',
  });
});

test('SQLite contention is recognised wherever it surfaces', () => {
  expect(isDatabaseLocked(new Error('database is locked'))).toBe(true);
  expect(isDatabaseLocked(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  expect(isDatabaseLocked(new Error('no such column: nope'))).toBe(false);
});

test('the success shape is read leniently, but a status it cannot store is refused', () => {
  expect(
    FinalizeResponseSchema.parse({
      tripId: 'srv-1',
      score: 74,
      status: 'final',
      day: { day: '2026-09-20' },
      provisionalMismatch: false,
      replayed: true,
      longTermScore: 81,
    })
  ).toEqual({
    tripId: 'srv-1',
    score: 74,
    status: 'final',
    day: { day: '2026-09-20' },
    provisionalMismatch: false,
    replayed: true,
  });

  // An unscored trip has no score; a response that omits the key leaves the local one alone.
  expect(FinalizeResponseSchema.parse({ tripId: 'srv-1', score: null, status: 'unscored' }).score)
    .toBeNull();
  expect(FinalizeResponseSchema.parse({ tripId: 'srv-1', status: 'final' }).score).toBeUndefined();

  expect(() => FinalizeResponseSchema.parse({ tripId: 'srv-1', status: 'recording' })).toThrow();
  expect(() => FinalizeResponseSchema.parse({ status: 'final' })).toThrow();
});

test('a day is filed under the server key when there is one, else the trip local date', () => {
  expect(dayKeyOf({ day: '2026-09-20', points: 50 }, T0, 'UTC')).toBe('2026-09-20');
  // 2023-11-14T22:13:20Z is still the 14th in London and already the 15th in Tokyo.
  expect(dayKeyOf({ points: 50 }, T0, 'Europe/London')).toBe('2023-11-14');
  expect(dayKeyOf(undefined, T0, 'Asia/Tokyo')).toBe('2023-11-15');
  expect(localDay(T0, 'not/a-zone')).toBe('2023-11-14');
});
