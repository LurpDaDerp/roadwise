/** @jest-environment node */
import { LIVE_ACTIVITY_START_FUNCTION, requestLiveActivityStart, type LiveActivityStartRequest } from '@/data/devices/liveActivity';
import { createLiveDriveTokenPort } from '@/data/devices/pushToken';

const REQ = {
  deviceId: 'install-1234',
  clientTripId: '00000000-0000-4000-8000-000000000001',
  startedAt: 1_700_000_000_000,
  state: { speed: 34, limit: 35, unit: 'mph', speedTint: null, speeding: false, notDrivingAvailable: true, weatherKind: null, weatherText: null },
} as unknown as LiveActivityStartRequest;

test('asks live-activity-start with the device, the drive and its first state; true only when the server says it sent the push', async () => {
  const calls: [string, unknown][] = [];
  const invoke = async (name: string, { body }: { body: unknown }) => {
    calls.push([name, body]);
    return { data: { sent: true }, error: null };
  };
  expect(await requestLiveActivityStart(REQ, { invoke })).toBe(true);
  expect(calls).toEqual([[LIVE_ACTIVITY_START_FUNCTION, { deviceId: REQ.deviceId, clientTripId: REQ.clientTripId, startedAt: REQ.startedAt, state: REQ.state }]]);
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

test('the live-drive port: where the module has no token (Jest, Android, an older build) the token is null and listening is a no-op', async () => {
  const port = createLiveDriveTokenPort();
  await expect(port.getToken()).resolves.toBeNull();
  expect(() => port.addTokenListener(() => {}).remove()).not.toThrow();
});
