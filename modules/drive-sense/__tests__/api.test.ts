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
    setDriveDisplay: jest.fn(async () => undefined),
    setForgotToStartReminder: jest.fn(async () => undefined),
    checkForgottenDrive: jest.fn(async () => ({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000 })),
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

test('the six event names are fixed, in order', () => {
  expect(DRIVE_SENSE_EVENTS).toEqual([
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
    await DriveSense.startCapture('pocket');
    await DriveSense.stopCapture();
    await DriveSense.setCaptureRate('low');
    await DriveSense.excludeFromBackup('file:///data/traces/');
    const display = { speed: 34, limit: 35, unit: 'mph', points: 1240, pointsDelta: 18, stopped: true } as const;
    await DriveSense.setDriveDisplay(display);
    await DriveSense.setForgotToStartReminder(true);
    expect(mockNative.startCapture).toHaveBeenCalledWith('pocket');
    expect(mockNative.stopCapture).toHaveBeenCalledTimes(1);
    expect(mockNative.setCaptureRate).toHaveBeenCalledWith('low');
    expect(mockNative.excludeFromBackup).toHaveBeenCalledWith('file:///data/traces/');
    expect(mockNative.setDriveDisplay).toHaveBeenCalledWith(display);
    expect(mockNative.setForgotToStartReminder).toHaveBeenCalledWith(true);
    // Unknown speed and limit, no points while moving, the drive's end: all valid states.
    await DriveSense.setDriveDisplay({ speed: null, limit: null, unit: 'km/h', points: null, pointsDelta: null, stopped: false, ended: true });
    expect(mockNative.setDriveDisplay).toHaveBeenLastCalledWith({
      speed: null,
      limit: null,
      unit: 'km/h',
      points: null,
      pointsDelta: null,
      stopped: false,
      ended: true,
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
    await expect(DriveSense.checkForgottenDrive(1_700_000_000_000)).resolves.toEqual({
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_600_000,
    });
    expect(mockNative.checkForgottenDrive).toHaveBeenCalledWith(1_700_000_000_000);
    await expect(DriveSense.selfTest('[]')).resolves.toBe('{"version":1}');
    expect(mockNative.selfTest).toHaveBeenCalledWith('[]');
  });

  test('a null exit info and a null forgotten drive are passed through', async () => {
    mockNative.getLastExitInfo!.mockResolvedValueOnce(null);
    await expect(DriveSense.getLastExitInfo()).resolves.toBeNull();
    mockNative.checkForgottenDrive!.mockResolvedValueOnce(null);
    await expect(DriveSense.checkForgottenDrive(0)).resolves.toBeNull();
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
  const coded = Object.assign(new Error('startCapture needs location permission'), { code: 'E_PERMISSION' });
  mockNative.startCapture!.mockRejectedValueOnce(coded);
  const e = await DriveSense.startCapture('mounted').catch((x: unknown) => x);
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
    // `exit` is `true` or absent, never false
    ['queryMotionHistory', [{ type: 'walking', confidence: 'high', ts: 1, exit: false }]],
    ['getScreenState', { locked: 'yes', on: true }],
    ['getThermalState', 'hot'],
    ['requestMotionPermission', 'undetermined'],
    ['getLastExitInfo', { ts: 1, reason: 'bored', whileCapturing: true }],
    ['isIgnoringBatteryOptimizations', 'true'],
    ['checkForgottenDrive', { startedAt: 1 }],
    ['checkForgottenDrive', { startedAt: 1.5, endedAt: 2 }],
    ['selfTest', 42],
  ] as const)('a malformed %s result rejects', async (method, bad) => {
    mockNative[method]!.mockResolvedValueOnce(bad);
    const args =
      method === 'queryMotionHistory' ? [0, 1] : method === 'selfTest' ? ['[]'] : method === 'checkForgottenDrive' ? [0] : [];
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
    ['setDriveDisplay', [{ speed: '34', limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: true }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'knots', points: null, pointsDelta: null, stopped: true }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: true, extra: 1 }]],
    ['setForgotToStartReminder', ['yes']],
    ['checkForgottenDrive', [-1]],
    ['checkForgottenDrive', [Number.NaN]],
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
