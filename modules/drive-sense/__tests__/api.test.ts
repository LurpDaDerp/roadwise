// The typed wrapper over the native module: every method and event goes through to native with
// its arguments untouched, results are validated at the bridge, and a missing native module (Jest,
// Expo Go, web) rejects instead of crashing at import.
//
// Only the `DriveSense` lookup is stubbed. Replacing the whole of `expo-modules-core` strips the
// native classes Expo's winter runtime extends at load time, and the suite then dies with "Super
// expression must either be null or a function" before a single test runs.
import DriveSense, {
  DRIVE_SENSE_EVENTS,
  DRIVE_SENSE_METHODS,
  isDriveSenseError,
  type DriveSenseApi,
} from '../src';

// `jest.mock` is hoisted above the import by babel-jest, and its factory runs before any of this
// file's own statements — so the stub native module is built inside the factory and reached
// through `jest.requireMock`.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const state = () => ({
    armed: true,
    capturing: false,
    rate: null,
    mode: null,
    platform: 'ios',
    location: 'always',
    motion: 'granted',
    lockSignal: 'lagged',
    captureWasOpen: false,
    captureStartedAt: null,
    lastRowTs: null,
  });
  const remove = jest.fn();
  const native = {
    arm: jest.fn(async () => undefined),
    disarm: jest.fn(async () => undefined),
    startCapture: jest.fn(async () => undefined),
    stopCapture: jest.fn(async () => undefined),
    setCaptureRate: jest.fn(async () => undefined),
    getState: jest.fn(async () => state()),
    queryMotionHistory: jest.fn(async () => [
      { type: 'automotive', confidence: 'high', ts: 1_700_000_000_000 },
    ]),
    getScreenState: jest.fn(async () => ({ locked: true, on: false })),
    getThermalState: jest.fn(async () => 'fair'),
    requestMotionPermission: jest.fn(async () => 'granted'),
    excludeFromBackup: jest.fn(async () => undefined),
    setNotificationState: jest.fn(async () => undefined),
    getLastExitInfo: jest.fn(async () => ({
      ts: 1_700_000_000_000,
      reason: 'watchdog',
      whileCapturing: true,
    })),
    isIgnoringBatteryOptimizations: jest.fn(async () => false),
    selfTest: jest.fn(async () => '{"version":1}'),
    addListener: jest.fn(() => ({ remove })),
  };
  const control = { present: true, native, state, remove };
  return {
    ...actual,
    __driveSense: control,
    requireOptionalNativeModule: (name: string) =>
      name === 'DriveSense'
        ? control.present
          ? native
          : null
        : actual.requireOptionalNativeModule(name),
  };
});

type Control = {
  present: boolean;
  native: Record<string, jest.Mock>;
  state: () => Record<string, unknown>;
  remove: jest.Mock;
};
const control = (jest.requireMock('expo-modules-core') as { __driveSense: Control }).__driveSense;
const mockNative = control.native;
const mockRemove = control.remove;
const mockState = control.state;

beforeEach(() => jest.clearAllMocks());

test('the seven event names are fixed, in order', () => {
  expect(DRIVE_SENSE_EVENTS).toEqual([
    'wake',
    'activity',
    'row',
    'screen',
    'thermal',
    'notificationAction',
    'call',
  ]);
});

test('the method list names every bridged method of the API', () => {
  const api: Record<(typeof DRIVE_SENSE_METHODS)[number], unknown> = DriveSense;
  expect(Object.keys(api).filter((k) => k !== 'addListener').sort()).toEqual(
    [...DRIVE_SENSE_METHODS].sort()
  );
  expect(new Set(DRIVE_SENSE_METHODS).size).toBe(DRIVE_SENSE_METHODS.length);
});

describe('every method goes to native with its arguments', () => {
  test('void methods', async () => {
    await DriveSense.arm();
    await DriveSense.disarm();
    await DriveSense.startCapture('pocket');
    await DriveSense.stopCapture();
    await DriveSense.setCaptureRate('low');
    await DriveSense.excludeFromBackup('file:///data/traces/');
    await DriveSense.setNotificationState({ stationary: true, startedAt: 1_700_000_000_000 });
    expect(mockNative.arm).toHaveBeenCalledTimes(1);
    expect(mockNative.disarm).toHaveBeenCalledTimes(1);
    expect(mockNative.startCapture).toHaveBeenCalledWith('pocket');
    expect(mockNative.stopCapture).toHaveBeenCalledTimes(1);
    expect(mockNative.setCaptureRate).toHaveBeenCalledWith('low');
    expect(mockNative.excludeFromBackup).toHaveBeenCalledWith('file:///data/traces/');
    expect(mockNative.setNotificationState).toHaveBeenCalledWith({
      stationary: true,
      startedAt: 1_700_000_000_000,
    });
    // A candidate (final review M5): the notice says it is checking, not recording.
    await DriveSense.setNotificationState({ stationary: false, startedAt: null, candidate: true });
    expect(mockNative.setNotificationState).toHaveBeenLastCalledWith({
      stationary: false,
      startedAt: null,
      candidate: true,
    });
  });

  test('query methods resolve native results', async () => {
    await expect(DriveSense.getState()).resolves.toEqual(mockState());
    await expect(DriveSense.queryMotionHistory(1, 2)).resolves.toEqual([
      { type: 'automotive', confidence: 'high', ts: 1_700_000_000_000 },
    ]);
    expect(mockNative.queryMotionHistory).toHaveBeenCalledWith(1, 2);
    await expect(DriveSense.getScreenState()).resolves.toEqual({ locked: true, on: false });
    await expect(DriveSense.getThermalState()).resolves.toBe('fair');
    await expect(DriveSense.requestMotionPermission()).resolves.toBe('granted');
    await expect(DriveSense.getLastExitInfo()).resolves.toEqual({
      ts: 1_700_000_000_000,
      reason: 'watchdog',
      whileCapturing: true,
    });
    await expect(DriveSense.isIgnoringBatteryOptimizations()).resolves.toBe(false);
    await expect(DriveSense.selfTest('[]')).resolves.toBe('{"version":1}');
    expect(mockNative.selfTest).toHaveBeenCalledWith('[]');
  });

  test('a null exit info is passed through', async () => {
    mockNative.getLastExitInfo!.mockResolvedValueOnce(null);
    await expect(DriveSense.getLastExitInfo()).resolves.toBeNull();
  });
});

test.each(DRIVE_SENSE_EVENTS)('addListener(%s) subscribes natively and removes', (event) => {
  const fn = jest.fn();
  const sub = DriveSense.addListener(event, fn);
  expect(mockNative.addListener).toHaveBeenCalledWith(event, expect.any(Function));
  const delivered = mockNative.addListener!.mock.calls[0]?.[1];
  delivered?.({ some: 'payload' });
  expect(fn).toHaveBeenCalledWith({ some: 'payload' });
  sub.remove();
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test('a native CodedError passes through with its code (README §2 "Errors")', async () => {
  const coded = Object.assign(new Error('arm needs Always'), { code: 'E_PERMISSION' });
  mockNative.arm!.mockRejectedValueOnce(coded);
  const e = await DriveSense.arm().catch((x: unknown) => x);
  expect(e).toBe(coded);
  expect(isDriveSenseError(e, 'E_PERMISSION')).toBe(true);
});

describe('bridge validation', () => {
  test.each([
    ['getState', { ...mockState(), platform: 'web' }],
    ['getState', { ...mockState(), captureStartedAt: 1.5 }],
    ['getState', { ...mockState(), extra: 1 }],
    ['queryMotionHistory', [{ type: 'flying', confidence: 'high', ts: 1 }]],
    ['queryMotionHistory', { type: 'automotive' }],
    ['getScreenState', { locked: 'yes', on: true }],
    ['getThermalState', 'hot'],
    ['requestMotionPermission', 'undetermined'],
    ['getLastExitInfo', { ts: 1, reason: 'bored', whileCapturing: true }],
    ['isIgnoringBatteryOptimizations', 'true'],
    ['selfTest', 42],
  ] as const)('a malformed %s result rejects', async (method, bad) => {
    mockNative[method]!.mockResolvedValueOnce(bad);
    const args = method === 'queryMotionHistory' ? [0, 1] : method === 'selfTest' ? ['[]'] : [];
    const call = (DriveSense[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    await expect(call).rejects.toThrow(`DriveSense.${method}: invalid result`);
    expect(mockNative[method]).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['startCapture', ['drive']],
    ['setCaptureRate', ['medium']],
    ['queryMotionHistory', [Number.NaN, 1]],
    ['queryMotionHistory', [2, 1]],
    ['excludeFromBackup', ['']],
    ['setNotificationState', [{ stationary: 'yes', startedAt: null }]],
    ['setNotificationState', [{ stationary: true, startedAt: 1.5 }]],
    ['setNotificationState', [{ stationary: false, startedAt: null, candidate: 'yes' }]],
    ['selfTest', [{}]],
  ] as const)('%s rejects bad arguments without calling native', async (method, args) => {
    const fn = DriveSense[method] as (...a: readonly unknown[]) => Promise<unknown>;
    await expect(fn(...args)).rejects.toThrow(`DriveSense.${method}`);
    expect(mockNative[method]).not.toHaveBeenCalled();
  });
});

describe('without the native module (Jest, Expo Go, web)', () => {
  let api: DriveSenseApi;
  beforeAll(() => {
    control.present = false;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh copy of the module with the lookup returning null
      api = require('../src').default;
    });
  });
  afterAll(() => {
    control.present = true;
  });

  test('importing does not throw and every method rejects with a clear message', async () => {
    await expect(api.getState()).rejects.toThrow('DriveSense native module is not available');
    await expect(api.startCapture('mounted')).rejects.toThrow('not available');
    await expect(api.isIgnoringBatteryOptimizations()).rejects.toThrow('not available');
  });

  test('addListener returns an inert subscription', () => {
    const sub = api.addListener('row', () => {});
    expect(() => sub.remove()).not.toThrow();
  });
});
