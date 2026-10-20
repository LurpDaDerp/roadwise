// The typed wrapper over the native Live Activity module: arguments validated before the bridge,
// results coerced to the contract, and a missing native module (Android, Jest, Expo Go, web)
// answering "unsupported" rather than rejecting.
import LiveDrive, { createFakeLiveDrive, LIVE_DRIVE_METHODS, type LiveDriveApi, type LiveDriveState } from '../src';

jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const native = {
    isSupported: jest.fn(async () => true),
    start: jest.fn(async () => true),
    update: jest.fn(async () => undefined),
    end: jest.fn(async () => undefined),
  };
  const control = { present: true, native };
  return {
    ...actual,
    __liveDrive: control,
    requireOptionalNativeModule: (name: string) =>
      name === 'LiveDrive' ? (control.present ? native : null) : actual.requireOptionalNativeModule(name),
  };
});

type Control = { present: boolean; native: Record<string, jest.Mock> };
const control = (jest.requireMock('expo-modules-core') as { __liveDrive: Control }).__liveDrive;
const mockNative = control.native;

const state: LiveDriveState = { speed: 34, limit: 35, unit: 'mph', points: 1240, pointsDelta: 18, stopped: true };

beforeEach(() => jest.clearAllMocks());

test('the method list names every bridged method', () => {
  const api: Record<(typeof LIVE_DRIVE_METHODS)[number], unknown> = LiveDrive;
  expect(Object.keys(api).sort()).toEqual([...LIVE_DRIVE_METHODS].sort());
});

test('every method goes to native with its arguments and coerces the result', async () => {
  await expect(LiveDrive.isSupported()).resolves.toBe(true);
  await expect(LiveDrive.start(state)).resolves.toBe(true);
  expect(mockNative.start).toHaveBeenCalledWith(state);
  const moving = { ...state, points: null, pointsDelta: null, stopped: false, speed: null, limit: null };
  await LiveDrive.update(moving);
  expect(mockNative.update).toHaveBeenCalledWith(moving);
  await LiveDrive.end();
  expect(mockNative.end).toHaveBeenCalledTimes(1);
  // Anything but `true` from native is "not running" / "not supported".
  mockNative.start!.mockResolvedValueOnce(undefined);
  await expect(LiveDrive.start(state)).resolves.toBe(false);
  mockNative.isSupported!.mockResolvedValueOnce('yes');
  await expect(LiveDrive.isSupported()).resolves.toBe(false);
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
  ['update', { speed: 1, limit: 1, unit: 'mph', points: null, pointsDelta: null }],
  ['update', { ...state, extra: 1 }],
  ['update', { ...state, skyMid: 'navy' }],
  ['update', { ...state, accent: '#93A9FF80' }],
] as const)('%s rejects a bad state without calling native', async (method, bad) => {
  const fn = LiveDrive[method] as (s: unknown) => Promise<unknown>;
  await expect(fn(bad)).rejects.toThrow(`LiveDrive.${method}: invalid state`);
  expect(mockNative[method]).not.toHaveBeenCalled();
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

  test('nothing rejects: unsupported, start false, update and end resolve', async () => {
    await expect(api.isSupported()).resolves.toBe(false);
    await expect(api.start(state)).resolves.toBe(false);
    await expect(api.update(state)).resolves.toBeUndefined();
    await expect(api.end()).resolves.toBeUndefined();
  });

  test('a bad state still rejects (the caller has a bug whatever the platform)', async () => {
    await expect(api.start({ ...state, stopped: 'yes' } as unknown as LiveDriveState)).rejects.toThrow('invalid state');
  });
});

describe('the fake', () => {
  test('one activity at a time, started only by start, updated while running, gone on end', async () => {
    const fake = createFakeLiveDrive();
    expect(fake.active).toBeNull();
    await fake.update(state); // nothing running: ignored
    expect(fake.active).toBeNull();
    await expect(fake.start(state)).resolves.toBe(true);
    expect(fake.active).toEqual(state);
    const moving = { ...state, stopped: false, points: null, pointsDelta: null };
    await fake.update(moving);
    expect(fake.active).toEqual(moving);
    await fake.end();
    expect(fake.active).toBeNull();
    expect(fake.calls).toEqual(['update', 'start', 'update', 'end']);
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
});
