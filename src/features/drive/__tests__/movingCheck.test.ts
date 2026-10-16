import { currentSpeedMps, MOVING_FIX_MAX_AGE_MS, type MovingDeps } from '@/features/drive/movingCheck';

jest.mock('expo-location', () => ({ Accuracy: { High: 4 }, getLastKnownPositionAsync: jest.fn(), getCurrentPositionAsync: jest.fn() }));

const T = 1_700_000_000_000;

function deps(over: Partial<MovingDeps> = {}): MovingDeps {
  return {
    getLastKnownPositionAsync: async () => null,
    getCurrentPositionAsync: async () => ({ timestamp: T, coords: { speed: 0 } }),
    now: () => T,
    ...over,
  };
}

test('a fresh last-known fix answers at once; a stale one defers to a fresh fix', async () => {
  expect(await currentSpeedMps(deps({ getLastKnownPositionAsync: async () => ({ timestamp: T - 5000, coords: { speed: 2 } }) }))).toBe(2);
  expect(await currentSpeedMps(deps({ getLastKnownPositionAsync: async () => ({ timestamp: T - MOVING_FIX_MAX_AGE_MS - 1, coords: { speed: 2 } }), getCurrentPositionAsync: async () => ({ timestamp: T, coords: { speed: 0.5 } }) }))).toBe(0.5);
});

test('an unknown or negative speed is null (never 0), and a fix that never arrives is null', async () => {
  expect(await currentSpeedMps(deps({ getCurrentPositionAsync: async () => ({ timestamp: T, coords: { speed: -1 } }) }))).toBeNull();
  expect(await currentSpeedMps(deps({ getCurrentPositionAsync: async () => ({ timestamp: T, coords: { speed: null } }) }))).toBeNull();
  jest.useFakeTimers();
  try {
    const p = currentSpeedMps(deps({ getCurrentPositionAsync: () => new Promise(() => {}) }));
    await jest.advanceTimersByTimeAsync(2100);
    expect(await p).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
