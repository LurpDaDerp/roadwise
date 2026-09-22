import { CONSTANTS } from '@scoring';

import {
  currentSpeedMps,
  isMovingStart,
  MOVING_FIX_MAX_AGE_MS,
  MOVING_FIX_TIMEOUT_MS,
  type MovingDeps,
} from '@/features/drive/movingCheck';

const NOW = 1_700_000_000_000;

const fix = (speed: number | null, ageMs = 0) => ({
  timestamp: NOW - ageMs,
  coords: { latitude: 47.6, longitude: -122.3, altitude: null, accuracy: 8, altitudeAccuracy: null, heading: null, speed },
});

function deps(over: Partial<MovingDeps> = {}): MovingDeps {
  return {
    getLastKnownPositionAsync: jest.fn(async () => null),
    getCurrentPositionAsync: jest.fn(async () => fix(null)),
    now: () => NOW,
    ...over,
  };
}

afterEach(() => jest.useRealTimers());

describe('currentSpeedMps', () => {
  test('a fresh last-known fix answers at once, without asking for a new one', async () => {
    const d = deps({ getLastKnownPositionAsync: jest.fn(async () => fix(13, 3_000)) });
    await expect(currentSpeedMps(d)).resolves.toBe(13);
    expect(d.getLastKnownPositionAsync).toHaveBeenCalledWith({ maxAge: MOVING_FIX_MAX_AGE_MS });
    expect(d.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  test('a stale last-known fix is ignored and a fresh fix is read', async () => {
    const d = deps({
      getLastKnownPositionAsync: jest.fn(async () => fix(30, MOVING_FIX_MAX_AGE_MS + 1)),
      getCurrentPositionAsync: jest.fn(async () => fix(0)),
    });
    await expect(currentSpeedMps(d)).resolves.toBe(0);
  });

  test('a fix without a speed (the -1 sentinel or null) is unknown, never 0', async () => {
    await expect(
      currentSpeedMps(deps({ getCurrentPositionAsync: jest.fn(async () => fix(-1)) }))
    ).resolves.toBeNull();
    await expect(
      currentSpeedMps(deps({ getCurrentPositionAsync: jest.fn(async () => fix(null)) }))
    ).resolves.toBeNull();
  });

  test('no fix inside the bound is unknown (the sheet opens rather than waiting)', async () => {
    jest.useFakeTimers();
    const d = deps({ getCurrentPositionAsync: jest.fn(() => new Promise<never>(() => {})) });
    const answer = currentSpeedMps(d);
    await jest.advanceTimersByTimeAsync(MOVING_FIX_TIMEOUT_MS);
    await expect(answer).resolves.toBeNull();
  });

  test('a location error is unknown, not a throw', async () => {
    const d = deps({
      getLastKnownPositionAsync: jest.fn(async () => {
        throw new Error('denied');
      }),
      getCurrentPositionAsync: jest.fn(async () => {
        throw new Error('denied');
      }),
    });
    await expect(currentSpeedMps(d)).resolves.toBeNull();
  });
});

describe('isMovingStart', () => {
  test('only a known speed above the lockout line', () => {
    expect(isMovingStart(null)).toBe(false);
    expect(isMovingStart(CONSTANTS.LOCKOUT_SPEED_MPS)).toBe(false);
    expect(isMovingStart(CONSTANTS.LOCKOUT_SPEED_MPS + 0.1)).toBe(true);
  });
});
