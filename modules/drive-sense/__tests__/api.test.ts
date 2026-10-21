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
  DRIVE_SENSE_SYNC_METHODS,
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
    lockProof: true,
    lockDelayMs: 10_500,
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
    getScreenState: jest.fn(async () => ({ locked: true, on: false })),
    getThermalState: jest.fn(async () => 'fair'),
    requestMotionPermission: jest.fn(async () => 'granted'),
    excludeFromBackup: jest.fn(async () => undefined),
    setDriveDisplay: jest.fn(async () => undefined),
    getLastExitInfo: jest.fn(async () => ({
      ts: 1_700_000_000_000,
      reason: 'watchdog',
      whileCapturing: true,
    })),
    isIgnoringBatteryOptimizations: jest.fn(async () => false),
    selfTest: jest.fn(async () => '{"version":1}'),
    setTripReminder: jest.fn(async (on: boolean) => ({
      enabled: on,
      state: on ? 'needs' : 'off',
      missing: on ? ['locationAlways'] : [],
    })),
    getTripReminderStatus: jest.fn(async () => ({
      enabled: true,
      state: 'on',
      missing: [],
    })),
    requestReminderLocation: jest.fn(async () => 'whenInUse'),
    claimReminderTap: jest.fn(async () => true),
    takeReminderTap: jest.fn(async () => ({ token: '9f1c2b7e-0d4a-4c1e-9a77-1b2c3d4e5f60', at: 1_700_000_000_000 })),
    markLockProof: jest.fn(async () => undefined),
    listInstalledApps: jest.fn(async () => [{ package: 'com.waze', label: 'Waze' }]),
    launchApp: jest.fn(async () => true),
    setDashpalLink: jest.fn(async () => 'running'),
    audioOutputState: jest.fn(() => ({ callActive: false, volume: 0.5, headphones: false })),
    holdAwake: jest.fn(() => true),
    dashpalLinkRunning: jest.fn(() => true),
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

test('the nine event names are fixed, in order', () => {
  expect(DRIVE_SENSE_EVENTS).toEqual([
    'activity',
    'row',
    'speed',
    'screen',
    'thermal',
    'notificationAction',
    'call',
    'reminderTap',
    'dashpalLinkTick',
  ]);
});

test('the method list names every bridged method of the API', () => {
  const api: Record<(typeof DRIVE_SENSE_METHODS)[number] | (typeof DRIVE_SENSE_SYNC_METHODS)[number], unknown> = DriveSense;
  expect(Object.keys(api).filter((k) => k !== 'addListener').sort()).toEqual(
    [...DRIVE_SENSE_METHODS, ...DRIVE_SENSE_SYNC_METHODS].sort()
  );
  const all = [...DRIVE_SENSE_METHODS, ...DRIVE_SENSE_SYNC_METHODS];
  expect(new Set(all).size).toBe(all.length);
});

describe('every method goes to native with its arguments', () => {
  test('void methods', async () => {
    await DriveSense.startCapture('pocket');
    await DriveSense.stopCapture();
    await DriveSense.setCaptureRate('low');
    await DriveSense.excludeFromBackup('file:///data/traces/');
    const display = { speed: 34, limit: 35, unit: 'mph', points: 1240, pointsDelta: 18, stopped: true } as const;
    await DriveSense.setDriveDisplay(display);
    expect(mockNative.startCapture).toHaveBeenCalledWith('pocket');
    expect(mockNative.stopCapture).toHaveBeenCalledTimes(1);
    expect(mockNative.stopCapture).toHaveBeenCalledWith('now', 0, false);
    expect(mockNative.setCaptureRate).toHaveBeenCalledWith('low');
    expect(mockNative.excludeFromBackup).toHaveBeenCalledWith('file:///data/traces/');
    expect(mockNative.setDriveDisplay).toHaveBeenCalledWith(display);
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
    // The app's sky, "#RRGGBB" or null.
    const sky = { ...display, skyTop: '#0B2A5C', skyMid: '#123B7A', skyLow: '#1A4C94', accent: null };
    await DriveSense.setDriveDisplay(sky);
    expect(mockNative.setDriveDisplay).toHaveBeenLastCalledWith(sky);
  });

  test('query methods resolve native results', async () => {
    await expect(DriveSense.getState()).resolves.toEqual(mockState());
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

  test('the forgot-to-start reminder: switch, status and the iOS location answer', async () => {
    await expect(DriveSense.setTripReminder(true)).resolves.toEqual({
      enabled: true,
      state: 'needs',
      missing: ['locationAlways'],
    });
    expect(mockNative.setTripReminder).toHaveBeenCalledWith(true);
    await expect(DriveSense.getTripReminderStatus()).resolves.toEqual({ enabled: true, state: 'on', missing: [] });
    await expect(DriveSense.requestReminderLocation()).resolves.toBe('whenInUse');
  });

  test("the reminder's tap: claimed with its token, taken once as handed over", async () => {
    await expect(DriveSense.claimReminderTap('9f1c2b7e-0d4a-4c1e-9a77-1b2c3d4e5f60')).resolves.toBe(true);
    expect(mockNative.claimReminderTap).toHaveBeenCalledWith('9f1c2b7e-0d4a-4c1e-9a77-1b2c3d4e5f60');
    await expect(DriveSense.takeReminderTap()).resolves.toEqual({ token: '9f1c2b7e-0d4a-4c1e-9a77-1b2c3d4e5f60', at: 1_700_000_000_000 });
    mockNative.takeReminderTap!.mockResolvedValueOnce(null);
    await expect(DriveSense.takeReminderTap()).resolves.toBeNull();
  });

  test("stopCapture's drive end goes to native as (kind, endedAt, drivingAtEnd)", async () => {
    await DriveSense.stopCapture({ drivingEndedAt: 1_760_000_000_000, drivingAtEnd: true });
    await DriveSense.stopCapture({ drivingEndedAt: null, drivingAtEnd: false });
    await DriveSense.stopCapture(undefined);
    expect(mockNative.stopCapture!.mock.calls).toEqual([
      ['at', 1_760_000_000_000, true],
      ['dropped', 0, false],
      ['now', 0, false],
    ]);
  });

  test('an in-drive lock proof goes to native with its delay', async () => {
    await DriveSense.markLockProof(10_000);
    await DriveSense.markLockProof(0);
    await DriveSense.markLockProof(60_000);
    expect(mockNative.markLockProof!.mock.calls).toEqual([[10_000], [0], [60_000]]);
  });

  test('navigation apps: listed and launched by package', async () => {
    await expect(DriveSense.listInstalledApps(['com.google.android.apps.maps', 'com.waze'])).resolves.toEqual([{ package: 'com.waze', label: 'Waze' }]);
    expect(mockNative.listInstalledApps).toHaveBeenCalledWith(['com.google.android.apps.maps', 'com.waze']);
    await expect(DriveSense.launchApp('com.waze')).resolves.toBe(true);
    expect(mockNative.launchApp).toHaveBeenCalledWith('com.waze');
    mockNative.listInstalledApps!.mockResolvedValueOnce([]);
    await expect(DriveSense.listInstalledApps(['net.osmand'])).resolves.toEqual([]);
  });

  test('the DashPal link service: a state goes to native, its result is checked', async () => {
    await expect(DriveSense.setDashpalLink('waiting')).resolves.toBe('running');
    expect(mockNative.setDashpalLink).toHaveBeenCalledWith('waiting');
    mockNative.setDashpalLink!.mockResolvedValueOnce('unsupported');
    await expect(DriveSense.setDashpalLink('off')).resolves.toBe('unsupported');
    mockNative.setDashpalLink!.mockResolvedValueOnce('maybe');
    await expect(DriveSense.setDashpalLink('connected')).rejects.toThrow('DriveSense.setDashpalLink: invalid result');
    await expect(DriveSense.setDashpalLink('alerting' as never)).rejects.toThrow('invalid arguments');
  });

  test('the sync functions answer in the same turn, validated', () => {
    expect(DriveSense.audioOutputState()).toEqual({ callActive: false, volume: 0.5, headphones: false });
    mockNative.audioOutputState!.mockReturnValueOnce({ callActive: true, volume: null, headphones: null });
    expect(DriveSense.audioOutputState()).toEqual({ callActive: true, volume: null, headphones: null });
    for (const bad of [{ callActive: false, volume: 1.2, headphones: false }, { callActive: false, volume: 0.5 }, { callActive: false, volume: 0.5, headphones: false, extra: 1 }, null]) {
      mockNative.audioOutputState!.mockReturnValueOnce(bad);
      expect(() => DriveSense.audioOutputState()).toThrow('DriveSense.audioOutputState: invalid result');
    }
    expect(DriveSense.holdAwake(5000)).toBe(true);
    expect(mockNative.holdAwake).toHaveBeenCalledWith(5000);
    for (const bad of [0, 10_001, 1.5, NaN]) expect(() => DriveSense.holdAwake(bad)).toThrow('invalid arguments');
    expect(mockNative.holdAwake).toHaveBeenCalledTimes(1);
    expect(DriveSense.dashpalLinkRunning()).toBe(true);
    mockNative.dashpalLinkRunning!.mockReturnValueOnce('yes');
    expect(() => DriveSense.dashpalLinkRunning()).toThrow('invalid result');
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
    ['getState', { ...mockState(), lockProof: 'yes' }],
    ['getState', { ...mockState(), lockDelayMs: 1.5 }],
    ['getState', { ...mockState(), lockDelayMs: -1 }],
    ['getState', (({ lockProof: _p, ...rest }) => rest)(mockState() as { lockProof: unknown })],
    ['getScreenState', { locked: 'yes', on: true }],
    ['getThermalState', 'hot'],
    ['requestMotionPermission', 'undetermined'],
    ['getLastExitInfo', { ts: 1, reason: 'bored', whileCapturing: true }],
    ['isIgnoringBatteryOptimizations', 'true'],
    ['selfTest', 42],
    ['getTripReminderStatus', { enabled: true, state: 'snoozed', missing: [] }],
    ['getTripReminderStatus', { enabled: true, state: 'paused', missing: [] }],
    ['getTripReminderStatus', { enabled: true, state: 'needs', missing: ['camera'] }],
    ['getTripReminderStatus', { enabled: true, state: 'on', autoOff: false, missing: [] }],
    ['getTripReminderStatus', { enabled: true, state: 'on', missing: [], pausedUntil: null }],
    ['requestReminderLocation', 'sometimes'],
    ['claimReminderTap', 'true'],
    ['claimReminderTap', null],
    ['takeReminderTap', { token: 'has space', at: 1 }],
    ['takeReminderTap', { token: 'x'.repeat(65), at: 1 }],
    ['takeReminderTap', { token: 'tok-a', at: 0 }],
    ['takeReminderTap', { token: 'tok-a', at: 1, extra: true }],
    ['takeReminderTap', { token: 'tok-a' }],
    ['listInstalledApps', [{ package: 'com.waze' }]],
    ['listInstalledApps', [{ package: 'not a package', label: 'X' }]],
    ['listInstalledApps', [{ package: 'com.waze', label: 'Waze', icon: 'x' }]],
    ['listInstalledApps', null],
    ['launchApp', 'true'],
    ['launchApp', null],
  ] as const)('a malformed %s result rejects', async (method, bad) => {
    mockNative[method]!.mockResolvedValueOnce(bad);
    const args =
      method === 'selfTest' ? ['[]'] : method === 'claimReminderTap' ? ['tok-a'] : method === 'listInstalledApps' ? [['com.waze']] : method === 'launchApp' ? ['com.waze'] : [];
    const call = (DriveSense[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    await expect(call).rejects.toThrow(`DriveSense.${method}: invalid result`);
    expect(mockNative[method]).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['startCapture', ['drive']],
    ['setCaptureRate', ['medium']],
    ['excludeFromBackup', ['']],
    ['setDriveDisplay', [{ speed: '34', limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: true }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'knots', points: null, pointsDelta: null, stopped: true }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: true, extra: 1 }]],
    ['setDriveDisplay', [{ speed: 34, limit: 35, unit: 'mph', points: null, pointsDelta: null, stopped: true, skyMid: 'rgba(0, 0, 0, 1)' }]],
    ['selfTest', [{}]],
    ['setTripReminder', ['yes']],
    ['claimReminderTap', ['']],
    ['claimReminderTap', ['tok a']],
    ['claimReminderTap', ['x'.repeat(65)]],
    ['claimReminderTap', [42]],
    ['markLockProof', [-1]],
    ['markLockProof', [60_001]],
    ['markLockProof', [Number.NaN]],
    ['markLockProof', [Number.POSITIVE_INFINITY]],
    ['markLockProof', ['10000']],
    ['listInstalledApps', [[]]],
    ['listInstalledApps', [['com.waze', '']]],
    ['listInstalledApps', [['waze']]],
    ['listInstalledApps', [['com.waze; rm']]],
    ['listInstalledApps', [Array.from({ length: 33 }, (_, i) => `com.app${i}.x`)]],
    ['listInstalledApps', ['com.waze']],
    ['launchApp', ['']],
    ['launchApp', ['waze']],
    ['launchApp', ['com..waze']],
    ['launchApp', [42]],
    ['stopCapture', [{ drivingEndedAt: -1, drivingAtEnd: false }]],
    ['stopCapture', [{ drivingEndedAt: Number.NaN, drivingAtEnd: false }]],
    ['stopCapture', [{ drivingEndedAt: 1, drivingAtEnd: 'yes' }]],
    ['stopCapture', [{ drivingEndedAt: 1 }]],
    ['stopCapture', [null]],
    ['launchApp', ['com.evil.app']],
    ['launchApp', ['com.android.settings']],
    ['listInstalledApps', [['com.waze', 'com.evil.app']]],
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
    await expect(api.setDashpalLink('waiting')).rejects.toThrow('not available');
  });

  test('the sync functions answer the unknown value and never throw', () => {
    expect(api.audioOutputState()).toEqual({ callActive: false, volume: null, headphones: null });
    expect(api.holdAwake(5000)).toBe(false);
    expect(api.dashpalLinkRunning()).toBe(false);
  });

  test('addListener returns an inert subscription', () => {
    const sub = api.addListener('row', () => {});
    expect(() => sub.remove()).not.toThrow();
  });
});
