// The typed wrapper over the native DmsVision module: arguments are checked before the bridge,
// results are validated after, and a missing native module (Jest, Expo Go, web) rejects with
// E_UNAVAILABLE instead of crashing at import. Only the `DmsVision` lookup is stubbed (replacing all
// of expo-modules-core breaks Expo's winter runtime at load, see drive-sense's api.test.ts).
import DmsVision, {
  DMS_VISION_ERROR_CODES,
  DMS_VISION_EVENTS,
  DMS_VISION_METHODS,
  isDmsVisionError,
  type CapturePolicy,
  type StartOptions,
} from '../src';

jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const status = () => ({
    state: 'running',
    fpsTarget: 15,
    fpsActual: 14.8,
    dropped: 0,
    gazeNetAvailable: false,
    gazeNetOn: false,
    thermal: 'nominal',
    thermalLevel: 0,
    lowPower: false,
    latLandmarkP50: 11,
    latLandmarkP95: 19,
    latGazeP50: null,
    latGazeP95: null,
    latTotalP50: 15,
    latTotalP95: 24,
    procCpuMsPerS: 210,
  });
  const remove = jest.fn();
  const native = {
    getPermission: jest.fn(async () => ({ status: 'granted', canAskAgain: false })),
    requestPermission: jest.fn(async () => ({ status: 'denied', canAskAgain: false })),
    start: jest.fn(async () => undefined),
    setPolicy: jest.fn(async () => null),
    stop: jest.fn(async () => undefined),
    getStatus: jest.fn(async () => status()),
    getModelInfo: jest.fn(async () => ({
      landmarkerSha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
      gazeNetAvailable: false,
      gazeSha256: null,
      mediapipe: '0.10.35',
      onnxruntime: null,
    })),
    selfTest: jest.fn(async () => '{"version":1}'),
    addListener: jest.fn(() => ({ remove })),
  };
  const control = { native, status, remove };
  return {
    ...actual,
    __dmsVision: control,
    requireOptionalNativeModule: (name: string) =>
      name === 'DmsVision'
        ? (globalThis as { __dmsVisionAbsent?: boolean }).__dmsVisionAbsent
          ? null
          : native
        : actual.requireOptionalNativeModule(name),
  };
});

type Control = { native: Record<string, jest.Mock>; status: () => Record<string, unknown> };
const absent = (v: boolean) => ((globalThis as { __dmsVisionAbsent?: boolean }).__dmsVisionAbsent = v);
const control = (jest.requireMock('expo-modules-core') as { __dmsVision: Control }).__dmsVision;
const mockNative = control.native;

const START: StartOptions = {
  gateToken: 'tok-1',
  fps: 15,
  gazeNet: false,
  gazeNetEvery: 1,
  delegate: 'cpu',
  rotationOffsetDegrees: 0,
};
const POLICY: CapturePolicy = {
  gateToken: 'tok-1',
  capture: 'run',
  fps: 8,
  gazeNet: false,
  gazeNetEvery: 2,
  setupMode: false,
  previewAllowed: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  absent(false);
});

test('the three event names are fixed, in order', () => {
  expect(DMS_VISION_EVENTS).toEqual(['frames', 'status', 'state']);
});

test('the method list names every bridged method of the API', () => {
  const api = DmsVision as unknown as Record<string, unknown>;
  expect(
    Object.keys(api)
      .filter((k) => k !== 'addListener' && k !== 'isAvailable')
      .sort()
  ).toEqual([...DMS_VISION_METHODS].sort());
  expect(DMS_VISION_METHODS).toEqual([
    'getPermission',
    'requestPermission',
    'start',
    'setPolicy',
    'stop',
    'getStatus',
    'getModelInfo',
    'selfTest',
  ]);
});

test('the error codes', () => {
  expect(DMS_VISION_ERROR_CODES).toEqual([
    'E_UNAVAILABLE',
    'E_PERMISSION',
    'E_NOT_FOREGROUND',
    'E_BAD_ARGS',
    'E_CAMERA',
    'E_MODEL',
    'E_STATE',
    'E_RESULT',
  ]);
  expect(isDmsVisionError(Object.assign(new Error('x'), { code: 'E_STATE' }), 'E_STATE')).toBe(true);
  expect(isDmsVisionError(Object.assign(new Error('x'), { code: 'E_NOPE' }))).toBe(false);
  expect(isDmsVisionError(null)).toBe(false);
});

describe('methods go to native with one options object', () => {
  test('start and setPolicy pass their object through', async () => {
    await DmsVision.start(START);
    await DmsVision.setPolicy(POLICY);
    expect(mockNative.start).toHaveBeenCalledWith(START);
    expect(mockNative.setPolicy).toHaveBeenCalledWith(POLICY);
  });

  test('queries resolve validated results', async () => {
    await expect(DmsVision.getPermission()).resolves.toEqual({ status: 'granted', canAskAgain: false });
    await expect(DmsVision.requestPermission()).resolves.toEqual({ status: 'denied', canAskAgain: false });
    await expect(DmsVision.getStatus()).resolves.toEqual(control.status());
    await expect(DmsVision.getModelInfo()).resolves.toMatchObject({ gazeNetAvailable: false, gazeSha256: null });
    await expect(DmsVision.selfTest('[]')).resolves.toBe('{"version":1}');
    await expect(DmsVision.stop()).resolves.toBeUndefined();
  });
});

describe('arguments are refused before the bridge (E_BAD_ARGS)', () => {
  test.each([
    ['an fps outside {5, 8, 10, 15}', { ...START, fps: 12 }],
    ['an empty gate token', { ...START, gateToken: '' }],
    ['a missing gate token', { ...START, gateToken: undefined }],
    ['a rotation offset of 45', { ...START, rotationOffsetDegrees: 45 }],
    ['gazeNetEvery 3', { ...START, gazeNetEvery: 3 }],
    ['an unknown delegate', { ...START, delegate: 'npu' }],
    ['an extra key', { ...START, extra: true }],
  ])('start: %s', async (_n, opts) => {
    await expect(DmsVision.start(opts as unknown as StartOptions)).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  test('final review n-1: the refusal message never carries the gate token', async () => {
    const secret = 'gate-token-9f3a1c7e';
    const err = await DmsVision.start({ ...START, gateToken: secret, fps: 12 } as unknown as StartOptions).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(secret);
    const err2 = await DmsVision.setPolicy({ ...POLICY, gateToken: secret, fps: 0 } as unknown as CapturePolicy).catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain(secret);
    expect((err2 as Error).message).toContain('[redacted]');
  });

  test.each([
    ['capture "stop"', { ...POLICY, capture: 'stop' }],
    ['fps 0', { ...POLICY, fps: 0 }],
    ['no token', { ...POLICY, gateToken: '' }],
    ['previewAllowed missing', { ...POLICY, previewAllowed: undefined }],
  ])('setPolicy: %s', async (_n, p) => {
    await expect(DmsVision.setPolicy(p as unknown as CapturePolicy)).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
    expect(mockNative.setPolicy).not.toHaveBeenCalled();
  });

  test('selfTest needs a string', async () => {
    await expect(DmsVision.selfTest(42 as unknown as string)).rejects.toMatchObject({ code: 'E_BAD_ARGS' });
  });
});

describe('results are validated after the bridge', () => {
  test('a malformed status rejects with E_RESULT, naming the method', async () => {
    mockNative.getStatus!.mockResolvedValueOnce({ ...control.status(), thermalLevel: 7 });
    const err = await DmsVision.getStatus().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_RESULT' });
    expect(String(err)).toMatch(/DmsVision\.getStatus: invalid result/);
  });
  test('a status with an extra key rejects', async () => {
    mockNative.getStatus!.mockResolvedValueOnce({ ...control.status(), landmarks: [1, 2] });
    await expect(DmsVision.getStatus()).rejects.toThrow(/invalid result/);
  });
  test('a permission with an unknown status rejects', async () => {
    mockNative.getPermission!.mockResolvedValueOnce({ status: 'maybe', canAskAgain: true });
    await expect(DmsVision.getPermission()).rejects.toThrow(/DmsVision\.getPermission/);
  });
  test('model info claiming a net without a sha rejects', async () => {
    mockNative.getModelInfo!.mockResolvedValueOnce({
      landmarkerSha256: 'a'.repeat(64),
      gazeNetAvailable: true,
      gazeSha256: null,
      mediapipe: '0.10.35',
      onnxruntime: '1.30.0',
    });
    await expect(DmsVision.getModelInfo()).rejects.toThrow(/getModelInfo/);
  });
  test('native rejections keep their code', async () => {
    mockNative.start!.mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'E_PERMISSION' }));
    await expect(DmsVision.start(START)).rejects.toMatchObject({ code: 'E_PERMISSION' });
  });
});

describe('without the native module', () => {
  test('isAvailable is false, methods reject E_UNAVAILABLE, stop resolves, listeners are inert', async () => {
    absent(true);
    let Absent!: typeof DmsVision;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry
      Absent = (require('../src') as typeof import('../src')).default;
    });
    expect(Absent.isAvailable()).toBe(false);
    await expect(Absent.getPermission()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    await expect(Absent.start(START)).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    await expect(Absent.stop()).resolves.toBeUndefined();
    const sub = Absent.addListener('frames', () => {});
    expect(() => sub.remove()).not.toThrow();
  });

  test('isAvailable is true with the module', () => {
    expect(DmsVision.isAvailable()).toBe(true);
  });
});

test('addListener passes through to native', () => {
  const fn = jest.fn();
  DmsVision.addListener('state', fn);
  expect(mockNative.addListener).toHaveBeenCalledWith('state', fn);
});
