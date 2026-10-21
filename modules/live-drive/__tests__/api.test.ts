// The typed wrapper over the native Live Activity module: arguments validated before the bridge,
// results coerced to the contract, the push-to-start token checked, and a missing native module
// (Android, Jest, Expo Go, web) answering "unsupported" rather than rejecting.
import LiveDrive, { createFakeLiveDrive, LIVE_DRIVE_EVENTS, LIVE_DRIVE_METHODS, type LiveDriveApi, type LiveDriveState } from '../src';

const TOKEN = 'a1'.repeat(32);

jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const listeners = new Map<string, (mockPayload: unknown) => void>();
  const native = {
    isSupported: jest.fn(async () => true),
    isRunning: jest.fn(async () => true),
    getPushToStartToken: jest.fn(async () => 'a1'.repeat(32)),
    start: jest.fn(async () => true),
    update: jest.fn(async () => undefined),
    end: jest.fn(async () => undefined),
    addListener: jest.fn((event: string, fn: (mockPayload: unknown) => void) => {
      listeners.set(event, fn);
      return { remove: () => listeners.delete(event) };
    }),
  };
  const control = { present: true, native, listeners };
  return {
    ...actual,
    __liveDrive: control,
    requireOptionalNativeModule: (name: string) =>
      name === 'LiveDrive' ? (control.present ? native : null) : actual.requireOptionalNativeModule(name),
  };
});

type Control = { present: boolean; native: Record<string, jest.Mock>; listeners: Map<string, (p: unknown) => void> };
const control = (jest.requireMock('expo-modules-core') as { __liveDrive: Control }).__liveDrive;
const mockNative = control.native;

const state: LiveDriveState = {
  speed: 34,
  limit: 35,
  unit: 'mph',
  speedTint: null,
  speeding: false,
  notDrivingAvailable: true,
  weatherKind: null,
  weatherText: null,
};

beforeEach(() => jest.clearAllMocks());

test('the method list names every bridged method; one event', () => {
  const api: Record<(typeof LIVE_DRIVE_METHODS)[number] | 'addListener', unknown> = LiveDrive;
  expect(Object.keys(api).sort()).toEqual([...LIVE_DRIVE_METHODS, 'addListener'].sort());
  expect([...LIVE_DRIVE_METHODS]).toEqual(['isSupported', 'isRunning', 'getPushToStartToken', 'start', 'update', 'end']);
  expect([...LIVE_DRIVE_EVENTS]).toEqual(['pushToStartToken']);
});

test('every method goes to native with its arguments and coerces the result', async () => {
  await expect(LiveDrive.isSupported()).resolves.toBe(true);
  await expect(LiveDrive.isRunning()).resolves.toBe(true);
  await expect(LiveDrive.getPushToStartToken()).resolves.toBe(TOKEN);
  await expect(LiveDrive.start(state)).resolves.toBe(true);
  expect(mockNative.start).toHaveBeenCalledWith(state);
  const over = { ...state, speed: 48, speedTint: '#FF5A4F', speeding: true, weatherKind: 'heavy_rain', weatherText: 'Heavy rain' };
  await LiveDrive.update(over);
  expect(mockNative.update).toHaveBeenCalledWith(over);
  const unknown = { ...state, speed: null, limit: null, notDrivingAvailable: false, unit: 'km/h' as const };
  await LiveDrive.update(unknown);
  expect(mockNative.update).toHaveBeenLastCalledWith(unknown);
  await LiveDrive.end();
  expect(mockNative.end).toHaveBeenCalledTimes(1);
  // Anything but `true` from native is "not running" / "not supported"; anything but hex is no token.
  mockNative.start!.mockResolvedValueOnce(undefined);
  await expect(LiveDrive.start(state)).resolves.toBe(false);
  mockNative.isSupported!.mockResolvedValueOnce('yes');
  await expect(LiveDrive.isSupported()).resolves.toBe(false);
  mockNative.isRunning!.mockResolvedValueOnce(1);
  await expect(LiveDrive.isRunning()).resolves.toBe(false);
  for (const bad of [null, '', 'ABCDEF'.repeat(8), 'zz'.repeat(20), 42, 'a1'.repeat(101)]) {
    mockNative.getPushToStartToken!.mockResolvedValueOnce(bad);
    await expect(LiveDrive.getPushToStartToken()).resolves.toBeNull();
  }
});

test("the app's sky goes along as \"#RRGGBB\" or null", async () => {
  const sky = { ...state, skyTop: '#0B2A5C', skyMid: '#123B7A', skyLow: '#1A4C94', accent: '#93A9FF' };
  await LiveDrive.update(sky);
  expect(mockNative.update).toHaveBeenLastCalledWith(sky);
  const plain = { ...state, skyTop: null, skyMid: null, skyLow: null, accent: null };
  await LiveDrive.update(plain);
  expect(mockNative.update).toHaveBeenLastCalledWith(plain);
});

test.each([
  ['start', { ...state, speed: '34' }],
  ['start', { ...state, unit: 'knots' }],
  ['start', { ...state, points: 120 }],
  ['start', { ...state, stopped: true }],
  ['update', { speed: 1, limit: 1, unit: 'mph' }],
  ['update', { ...state, extra: 1 }],
  ['update', { ...state, skyMid: 'navy' }],
  ['update', { ...state, accent: '#93A9FF80' }],
  ['update', { ...state, speedTint: 'red' }],
  ['update', { ...state, speeding: 'yes' }],
  ['update', { ...state, notDrivingAvailable: undefined }],
  ['update', { ...state, weatherKind: 'Heavy rain' }],
  ['update', { ...state, weatherText: '' }],
] as const)('%s rejects a bad state without calling native', async (method, bad) => {
  const fn = LiveDrive[method] as (s: unknown) => Promise<unknown>;
  await expect(fn(bad)).rejects.toThrow(`LiveDrive.${method}: invalid state`);
  expect(mockNative[method]).not.toHaveBeenCalled();
});

test('the push-to-start token reaches a listener only as hex', () => {
  const got = jest.fn();
  const sub = LiveDrive.addListener('pushToStartToken', got);
  const fire = control.listeners.get('pushToStartToken')!;
  fire({ token: TOKEN });
  fire({ token: 'NOT HEX' });
  fire(null);
  expect(got).toHaveBeenCalledTimes(1);
  expect(got).toHaveBeenCalledWith({ token: TOKEN });
  sub.remove();
  expect(control.listeners.has('pushToStartToken')).toBe(false);
});

describe('without the native module (Android, Jest, Expo Go, web)', () => {
  let api: LiveDriveApi;
  beforeAll(() => {
    control.present = false;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh copy with the lookup returning null
      api = require('../src').default;
    });
  });
  afterAll(() => {
    control.present = true;
  });

  test('nothing rejects: unsupported, not running, no token, start false, update and end resolve, listeners inert', async () => {
    await expect(api.isSupported()).resolves.toBe(false);
    await expect(api.isRunning()).resolves.toBe(false);
    await expect(api.getPushToStartToken()).resolves.toBeNull();
    await expect(api.start(state)).resolves.toBe(false);
    await expect(api.update(state)).resolves.toBeUndefined();
    await expect(api.end()).resolves.toBeUndefined();
    expect(() => api.addListener('pushToStartToken', () => {}).remove()).not.toThrow();
  });

  test('a bad state still rejects (the caller has a bug whatever the platform)', async () => {
    await expect(api.start({ ...state, speeding: 'yes' } as unknown as LiveDriveState)).rejects.toThrow('invalid state');
  });
});

describe('the fake', () => {
  test('one activity at a time, started by start, updated while running, gone on end', async () => {
    const fake = createFakeLiveDrive();
    expect(fake.active).toBeNull();
    await fake.update(state); // nothing running: ignored
    expect(fake.active).toBeNull();
    await expect(fake.isRunning()).resolves.toBe(false);
    await expect(fake.start(state)).resolves.toBe(true);
    expect(fake.active).toEqual(state);
    const over = { ...state, speedTint: '#FF5A4F', speeding: true };
    await fake.update(over);
    expect(fake.active).toEqual(over);
    await expect(fake.isRunning()).resolves.toBe(true);
    await fake.end();
    expect(fake.active).toBeNull();
    expect(fake.calls).toEqual(['update', 'isRunning', 'start', 'update', 'isRunning', 'end']);
  });

  test('a pushed activity runs without start, and a later start updates it instead of replacing it', async () => {
    const fake = createFakeLiveDrive();
    fake.pushStart({ ...state, notDrivingAvailable: true });
    await expect(fake.isRunning()).resolves.toBe(true);
    await expect(fake.start({ ...state, speed: 50 })).resolves.toBe(true);
    expect(fake.active).toMatchObject({ speed: 50 });
  });

  test('unsupported: start resolves false and nothing runs', async () => {
    const fake = createFakeLiveDrive({ supported: false });
    await expect(fake.isSupported()).resolves.toBe(false);
    await expect(fake.start(state)).resolves.toBe(false);
    expect(fake.active).toBeNull();
    fake.setSupported(true);
    await expect(fake.start(state)).resolves.toBe(true);
    fake.setSupported(false);
    expect(fake.active).toBeNull();
  });

  test('the token: settable, and a new one reaches the listeners', async () => {
    const fake = createFakeLiveDrive();
    await expect(fake.getPushToStartToken()).resolves.toBeNull();
    fake.setToken(TOKEN);
    await expect(fake.getPushToStartToken()).resolves.toBe(TOKEN);
    const got = jest.fn();
    const sub = fake.addListener('pushToStartToken', got);
    fake.emitToken('b2'.repeat(32));
    expect(got).toHaveBeenCalledWith({ token: 'b2'.repeat(32) });
    await expect(fake.getPushToStartToken()).resolves.toBe('b2'.repeat(32));
    sub.remove();
    fake.emitToken(TOKEN);
    expect(got).toHaveBeenCalledTimes(1);
  });
});
