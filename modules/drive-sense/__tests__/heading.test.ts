// The JS face of Android's phone heading (`PhoneHeading`, README §12): the subscription's life
// around the native start and stop, and what a missing module or sensor does.
import { PhoneHeading } from '../src/heading';

// `jest.mock` is hoisted above the import, so the stub native module is built inside the factory
// and reached through `jest.requireMock`.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const listeners: ((p: unknown) => void)[] = [];
  const native = {
    available: jest.fn(() => true),
    start: jest.fn(() => true),
    stop: jest.fn(() => undefined),
    addListener: jest.fn((event: string, fn: (p: unknown) => void) => {
      listeners.push(fn);
      return {
        remove: jest.fn(() => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }),
      };
    }),
  };
  return {
    ...actual,
    requireOptionalNativeModule: (name: string) => (name === 'PhoneHeading' ? native : null),
    __heading: { native, listeners },
  };
});

type Stub = {
  native: { available: jest.Mock; start: jest.Mock; stop: jest.Mock; addListener: jest.Mock };
  listeners: ((p: unknown) => void)[];
};
const stub = () => (jest.requireMock('expo-modules-core') as { __heading: Stub }).__heading;
const emit = (p: unknown) => {
  for (const fn of [...stub().listeners]) fn(p);
};

beforeEach(() => {
  const { native } = stub();
  native.start.mockClear().mockReturnValue(true);
  native.stop.mockClear();
  native.addListener.mockClear();
});

describe('PhoneHeading', () => {
  test('available: the native answer, read once', () => {
    expect(PhoneHeading.available()).toBe(true);
    expect(PhoneHeading.available()).toBe(true);
    expect(stub().native.available).toHaveBeenCalledTimes(1);
  });

  test('watch listens, then starts the sensor; each well-formed reading reaches the callback; remove stops it once', async () => {
    const seen: unknown[] = [];
    const sub = await PhoneHeading.watch((h) => seen.push(h));
    expect(stub().native.addListener).toHaveBeenCalledWith('heading', expect.any(Function));
    expect(stub().native.start).toHaveBeenCalledTimes(1);
    emit({ trueHeading: 12, magHeading: 10, accuracy: 3 });
    emit({ trueHeading: 'x', magHeading: 10, accuracy: 3 });
    emit(null);
    expect(seen).toEqual([{ trueHeading: 12, magHeading: 10, accuracy: 3 }]);
    sub.remove();
    sub.remove();
    expect(stub().native.stop).toHaveBeenCalledTimes(1);
    expect(stub().listeners).toHaveLength(0);
    emit({ trueHeading: 50, magHeading: 50, accuracy: 3 });
    expect(seen).toHaveLength(1);
  });

  test('no sensor (start answers false, or throws): rejects and leaves no listener', async () => {
    stub().native.start.mockReturnValueOnce(false);
    await expect(PhoneHeading.watch(() => {})).rejects.toThrow('no rotation-vector sensor');
    expect(stub().listeners).toHaveLength(0);
    stub().native.start.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(PhoneHeading.watch(() => {})).rejects.toThrow('no rotation-vector sensor');
    expect(stub().listeners).toHaveLength(0);
    expect(stub().native.stop).not.toHaveBeenCalled();
  });
});
