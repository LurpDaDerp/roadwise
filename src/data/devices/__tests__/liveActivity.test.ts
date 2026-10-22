/** @jest-environment node */
import {
  createLiveActivityStarter,
  createPushToStart,
  LIVE_ACTIVITY_START_FUNCTION,
  requestLiveActivityStart,
  requestLiveActivityStartOutcome,
  STARTER_MEMORY,
  type LiveActivityStartOutcome,
  type LiveActivityStartRequest,
} from '@/data/devices/liveActivity';
import { createLiveDriveTokenPort } from '@/data/devices/pushToken';

const REQ = {
  deviceId: 'install-1234',
  clientTripId: '00000000-0000-4000-8000-000000000001',
  leg: 1,
  startedAt: 1_700_000_000_000,
  state: { speed: 34, limit: 35, unit: 'mph', speedTint: null, speeding: false, notDrivingAvailable: true, weatherKind: null, weatherText: null },
} as unknown as LiveActivityStartRequest;

test('asks live-activity-start with the device, the drive, its leg and its first state; true only when the server says it sent the push', async () => {
  const calls: [string, unknown][] = [];
  const invoke = async (name: string, { body }: { body: unknown }) => {
    calls.push([name, body]);
    return { data: { sent: true }, error: null };
  };
  expect(await requestLiveActivityStart(REQ, { invoke })).toBe(true);
  expect(calls).toEqual([[LIVE_ACTIVITY_START_FUNCTION, { deviceId: REQ.deviceId, clientTripId: REQ.clientTripId, leg: 1, startedAt: REQ.startedAt, state: REQ.state }]]);
  expect(LIVE_ACTIVITY_START_FUNCTION).toBe('live-activity-start');
});

test('anything else is false and never throws: no token, a duplicate, an error answer, a thrown call, garbage', async () => {
  const answer = (data: unknown, error: unknown = null) => async () => ({ data, error });
  expect(await requestLiveActivityStart(REQ, { invoke: answer({ sent: false, reason: 'no_token' }) })).toBe(false);
  expect(await requestLiveActivityStart(REQ, { invoke: answer({ sent: false, reason: 'duplicate' }) })).toBe(false);
  expect(await requestLiveActivityStart(REQ, { invoke: answer(null, { name: 'FunctionsHttpError' }) })).toBe(false);
  expect(await requestLiveActivityStart(REQ, { invoke: answer('sent') })).toBe(false);
  const onError = jest.fn();
  expect(await requestLiveActivityStart(REQ, { invoke: async () => Promise.reject(new TypeError('offline')), onError })).toBe(false);
  expect(onError).toHaveBeenCalledWith(new Error('TypeError'), 'live activity start');
});

test('a call that hangs is given up after the timeout', async () => {
  jest.useFakeTimers();
  try {
    const pending = requestLiveActivityStart(REQ, { invoke: () => new Promise(() => {}), timeoutMs: 500 });
    await jest.advanceTimersByTimeAsync(600);
    expect(await pending).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

describe('the outcome: sent, or why not and whether a retry soon can help', () => {
  const answer = (data: unknown, error: unknown = null) => async () => ({ data, error });
  const httpError = (status: number) => Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError', context: { status } });
  const no = (reason: string, retryable: boolean, detail: string | null = null): LiveActivityStartOutcome =>
    ({ sent: false, reason, detail, retryable }) as LiveActivityStartOutcome;

  test("sent, with the request's speed and limit in the state as the host gave them", async () => {
    const bodies: unknown[] = [];
    const invoke = async (_name: string, { body }: { body: unknown }) => {
      bodies.push(body);
      return { data: { sent: true }, error: null };
    };
    const req = { ...REQ, state: { ...REQ.state, speed: 27, limit: null } };
    expect(await requestLiveActivityStartOutcome(req, { invoke })).toEqual({ sent: true, reason: null, detail: null, retryable: false });
    expect((bodies[0] as { state: { speed: unknown; limit: unknown } }).state).toMatchObject({ speed: 27, limit: null });
  });

  test("the server's answers keep their reason; only an apns_error the server handed back after a passing failure is retryable", async () => {
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'no_token' }) })).toEqual(no('no_token', false));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'duplicate' }) })).toEqual(no('duplicate', false));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'unconfigured' }) })).toEqual(no('unconfigured', false));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'apns_error', detail: 'timeout', retry: true }) })).toEqual(
      no('apns_error', true, 'timeout')
    );
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'apns_error', detail: 'BadDeviceToken', retry: false }) })).toEqual(
      no('apns_error', false, 'BadDeviceToken')
    );
    // an older server (no detail, no retry): it kept its claim, so a retry would be a duplicate
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'apns_error' }) })).toEqual(no('apns_error', false));
    // a detail that is not a plain code is dropped
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer({ sent: false, reason: 'apns_error', detail: '<b>x</b>', retry: true }) })).toEqual(
      no('apns_error', true)
    );
  });

  test('a 2xx outside the contract is a bad answer', async () => {
    for (const data of ['sent', null, 1, {}, { sent: 'yes' }, { sent: false }, { sent: false, reason: 'later' }, { sent: false, reason: 7 }]) {
      expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(data) })).toEqual(no('bad_answer', false));
    }
  });

  test("the server's refusals by status; the fetch and relay failures", async () => {
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, httpError(429)) })).toEqual(no('rate_limited', false));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, httpError(401)) })).toEqual(no('unauthorized', true));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, httpError(404)) })).toEqual(no('not_deployed', false));
    for (const status of [400, 405, 413]) {
      expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, httpError(status)) })).toEqual(no('invalid', false));
    }
    for (const status of [500, 503]) {
      expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, httpError(status)) })).toEqual(no('server_error', true));
    }
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, { name: 'FunctionsHttpError' }) })).toEqual(no('server_error', true));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, { name: 'FunctionsFetchError', context: {} }) })).toEqual(no('network', true));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, { name: 'FunctionsRelayError', context: {} }) })).toEqual(no('server_error', true));
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: answer(null, 'boom') })).toEqual(no('server_error', true));
  });

  test('a thrown call is a network failure, reported without its message; a hang is a timeout', async () => {
    const onError = jest.fn();
    expect(await requestLiveActivityStartOutcome(REQ, { invoke: async () => Promise.reject(new TypeError('offline at 1 Main St')), onError })).toEqual(no('network', true));
    expect(onError).toHaveBeenCalledWith(new Error('TypeError'), 'live activity start');
    jest.useFakeTimers();
    try {
      const pending = requestLiveActivityStartOutcome(REQ, { invoke: () => new Promise(() => {}), timeoutMs: 500 });
      await jest.advanceTimersByTimeAsync(600);
      expect(await pending).toEqual(no('timeout', true));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the retry-safe starter', () => {
  const deferred = () => {
    let resolve!: (v: { data: unknown; error: unknown }) => void;
    const promise = new Promise<{ data: unknown; error: unknown }>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  test('a call while one for the same drive and leg is in flight shares its outcome: one request', async () => {
    const d = deferred();
    const invoke = jest.fn(() => d.promise);
    const starter = createLiveActivityStarter({ invoke });
    const a = starter.start(REQ);
    const b = starter.start({ ...REQ, state: { ...REQ.state, speed: 50 } });
    d.resolve({ data: { sent: true }, error: null });
    expect(await a).toEqual({ sent: true, reason: null, detail: null, retryable: false });
    expect(await b).toEqual(await a);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('once sent, the same leg is never asked again; another leg or drive is', async () => {
    const invoke = jest.fn(async () => ({ data: { sent: true }, error: null }));
    const starter = createLiveActivityStarter({ invoke });
    await starter.start(REQ);
    expect((await starter.start(REQ)).sent).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await starter.start({ ...REQ, leg: 2 });
    await starter.start({ ...REQ, clientTripId: '00000000-0000-4000-8000-000000000002' });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test('after a failure the next call asks again (the retry), and a success then sticks', async () => {
    const replies = [
      { data: { sent: false, reason: 'apns_error', detail: 'network', retry: true }, error: null },
      { data: { sent: true }, error: null },
    ];
    const invoke = jest.fn(async () => replies.shift() ?? { data: null, error: 'unexpected' });
    const starter = createLiveActivityStarter({ invoke });
    expect(await starter.start(REQ)).toEqual({ sent: false, reason: 'apns_error', detail: 'network', retryable: true });
    expect((await starter.start(REQ)).sent).toBe(true);
    expect((await starter.start(REQ)).sent).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test('a thrown call is an outcome, never a rejection, and does not block the retry', async () => {
    const invoke = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ data: { sent: true }, error: null });
    const starter = createLiveActivityStarter({ invoke });
    expect(await starter.start(REQ)).toMatchObject({ sent: false, reason: 'network', retryable: true });
    expect((await starter.start(REQ)).sent).toBe(true);
  });

  test(`it remembers the last ${STARTER_MEMORY} sent legs`, async () => {
    const invoke = jest.fn(async () => ({ data: { sent: true }, error: null }));
    const starter = createLiveActivityStarter({ invoke });
    for (let leg = 0; leg <= STARTER_MEMORY; leg += 1) await starter.start({ ...REQ, leg });
    expect(invoke).toHaveBeenCalledTimes(STARTER_MEMORY + 1);
    await starter.start({ ...REQ, leg: STARTER_MEMORY }); // remembered
    expect(invoke).toHaveBeenCalledTimes(STARTER_MEMORY + 1);
    await starter.start({ ...REQ, leg: 0 }); // the oldest was let go: asked again (the server answers duplicate)
    expect(invoke).toHaveBeenCalledTimes(STARTER_MEMORY + 2);
  });
});

test('the live-drive port: where the module has no token (Jest, Android, an older build) the token is null and listening is a no-op', async () => {
  const port = createLiveDriveTokenPort();
  await expect(port.getToken()).resolves.toBeNull();
  expect(() => port.addTokenListener(() => {}).remove()).not.toThrow();
});

describe('the drive host’s pushToStart', () => {
  const { deviceId: _id, ...HOST_REQ } = REQ;

  test('asks with this install’s id through one retry-safe starter: a retry while the first is out shares it, a sent leg is not asked again', async () => {
    const invoke = jest.fn(async (_name: string, { body }: { body: unknown }) => {
      expect(body).toMatchObject({ deviceId: 'install-9', clientTripId: REQ.clientTripId, leg: 1 });
      return { data: { sent: true }, error: null };
    });
    const deviceId = jest.fn(async () => 'install-9');
    const push = createPushToStart({ deviceId, invoke });
    const [a, b] = await Promise.all([push(HOST_REQ), push(HOST_REQ)]);
    expect(a).toEqual({ sent: true, reason: null, detail: null, retryable: false });
    expect(b).toEqual(a);
    expect((await push(HOST_REQ)).sent).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deviceId).toHaveBeenCalledTimes(3);
  });

  test('a failure answers its reason (a retry then asks again); an id that cannot be read is a network outcome worth a retry, reported, never thrown', async () => {
    const replies = [
      { data: { sent: false, reason: 'unconfigured' }, error: null },
      { data: { sent: true }, error: null },
    ];
    const invoke = jest.fn(async () => replies.shift()!);
    const push = createPushToStart({ deviceId: async () => 'install-9', invoke });
    expect(await push(HOST_REQ)).toEqual({ sent: false, reason: 'unconfigured', detail: null, retryable: false });
    expect((await push(HOST_REQ)).sent).toBe(true);

    const errors: string[] = [];
    const failing = createPushToStart({
      deviceId: async () => {
        throw new Error('db closed');
      },
      invoke,
      onError: (_e, ctx) => errors.push(ctx),
    });
    expect(await failing(HOST_REQ)).toEqual({ sent: false, reason: 'network', detail: null, retryable: true });
    expect(errors).toEqual(['live activity start']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
