/** @jest-environment node */
import {
  classifyInvokeError,
  classifyStatus,
  classifyStorageError,
  DayRowSchema,
  FinalizeResponseSchema,
  isDatabaseLocked,
  retryAfterSeconds,
} from '@/data/sync/response';

const DAY_ROW = {
  day: '2026-09-20',
  longTermScore: 81,
  band: 'gold',
  provisional: false,
  safeDay: true,
  goodDay: false,
  phoneFreeDay: true,
  cameraDay: false,
  exposure: 1.1,
  drivingS: 1200,
  tripsScored: 2,
  severeEvents: 0,
};

const TRIP_FIELDS = {
  categoryDeductions: { phone: 0, speeding: 6, braking: 0, accel: 0, cornering: 0, focus: 0 },
  exposure: 1,
  dataQuality: 'A',
  hadSevereEvent: false,
  limitCoveragePct: 80,
};

const RESPONSE = {
  tripId: 'a3f1c2d4-5b6e-4f8a-9c0d-1e2f3a4b5c6d',
  score: 74,
  status: 'final',
  day: DAY_ROW,
  trip: TRIP_FIELDS,
  provisionalMismatch: false,
  replayed: false,
};

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
  // Some storage-api versions answer a duplicate as HTTP 400 with the real code in the body.
  expect(
    classifyStorageError({
      status: 400,
      statusCode: '409',
      error: 'Duplicate',
      message: 'The resource already exists',
    })
  ).toMatchObject({ alreadyExists: true });
  expect(classifyStorageError({ status: 400, code: 'KeyAlreadyExists' })).toMatchObject({
    alreadyExists: true,
  });
  expect(classifyStorageError({ status: 500, message: 'boom' })).toMatchObject({
    alreadyExists: false,
    kind: 'retryable',
    code: 'storage_500',
  });
  expect(classifyStorageError({ status: 403, message: 'not authorized' })).toMatchObject({
    alreadyExists: false,
    kind: 'terminal',
  });
});

test('SQLite contention is recognised wherever it surfaces', () => {
  expect(isDatabaseLocked(new Error('database is locked'))).toBe(true);
  expect(isDatabaseLocked(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  expect(isDatabaseLocked(new Error('no such column: nope'))).toBe(false);
});

test('the success shape is exactly the keys the function returns', () => {
  expect(FinalizeResponseSchema.parse(RESPONSE)).toEqual(RESPONSE);

  // An unscored or discarded trip carries a null score.
  expect(
    FinalizeResponseSchema.parse({ ...RESPONSE, score: null, status: 'unscored' }).score
  ).toBeNull();
  expect(
    FinalizeResponseSchema.parse({ ...RESPONSE, score: null, status: 'discarded' }).status
  ).toBe('discarded');
});

test('anything the contract does not describe is refused, not guessed at', () => {
  const refused: Record<string, unknown>[] = [
    { ...RESPONSE, longTermScore: 81 }, // an unknown key
    { ...RESPONSE, day: '2026-09-20' }, // the day as a bare date
    { ...RESPONSE, day: { ...DAY_ROW, points: 50 } }, // an unknown key inside the day
    { ...RESPONSE, trip: { ...TRIP_FIELDS, scoringVersion: 1 } }, // an unknown key inside the trip
    { ...RESPONSE, trip: { ...TRIP_FIELDS, dataQuality: 'D' } }, // a grade the scorer has no band for
    // A breakdown missing a category is a partial answer, and a partial answer is not applied.
    { ...RESPONSE, trip: { ...TRIP_FIELDS, categoryDeductions: { phone: 0 } } },
    { ...RESPONSE, day: { ...DAY_ROW, day: '20 September' } },
    { ...RESPONSE, tripId: 'srv-1' }, // not a uuid
    { ...RESPONSE, score: 74, status: 'unscored' }, // a score on an unscored trip
    { ...RESPONSE, score: null }, // no score on a final trip
    { ...RESPONSE, score: 101 },
    { ...RESPONSE, status: 'recording' },
    { ...RESPONSE, provisionalMismatch: undefined },
    { ...RESPONSE, replayed: undefined },
    { ...RESPONSE, day: undefined },
  ];
  for (const value of refused) expect(FinalizeResponseSchema.safeParse(value).success).toBe(false);
});

test('every number in a day row is finite', () => {
  // JSON cannot carry them, but the schema is the contract and says so out loud.
  for (const broken of [Infinity, -Infinity, NaN]) {
    expect(DayRowSchema.safeParse({ ...DAY_ROW, exposure: broken }).success).toBe(false);
    expect(DayRowSchema.safeParse({ ...DAY_ROW, drivingS: broken }).success).toBe(false);
  }
  expect(DayRowSchema.safeParse({ ...DAY_ROW, longTermScore: null, band: null }).success).toBe(true);
  expect(DayRowSchema.safeParse({ ...DAY_ROW, tripsScored: -1 }).success).toBe(false);
});

test('a day row may carry tripsAll (0009, D2): a count, and absent on an older server', () => {
  expect(DayRowSchema.safeParse({ ...DAY_ROW, tripsAll: 3 }).success).toBe(true);
  expect(DayRowSchema.safeParse(DAY_ROW).success).toBe(true);
  expect(DayRowSchema.safeParse({ ...DAY_ROW, tripsAll: -1 }).success).toBe(false);
  expect(DayRowSchema.safeParse({ ...DAY_ROW, tripsAll: 1.5 }).success).toBe(false);
});
