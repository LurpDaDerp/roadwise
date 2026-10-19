import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { okJson, openMeteoBody } from '@/features/weather/__fixtures__/openMeteo';

import { driveWeatherAlert, useDriveWeather, WEATHER_REFETCH_DISTANCE_M, WEATHER_REFRESH_MS } from '../weather';

const mockLastKnown = jest.fn();
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: (...args: unknown[]) => mockLastKnown(...args),
}));

const ICY = { current: { weather_code: 66, temperature_2m: -1 } };

describe('driveWeatherAlert: the dangerous-weather evaluator at the last known position', () => {
  beforeEach(() => mockLastKnown.mockReset().mockResolvedValue({ coords: { latitude: 39.7392, longitude: -104.9903 } }));

  test('freezing rain: the alert, asked of Open-Meteo at a position rounded to one decimal', async () => {
    const fetch = jest.fn(async () => okJson(openMeteoBody(ICY)));
    await expect(driveWeatherAlert({ fetch })).resolves.toEqual({ kind: 'freezing_rain', gustMph: null, visibilityM: null });
    const url = (fetch.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?latitude=39.7&longitude=-105.0&');
    expect(mockLastKnown).toHaveBeenCalledWith({ maxAge: 60 * 60_000 });
  });

  test('nothing dangerous, no position, a failed request or a failed position read: null', async () => {
    await expect(driveWeatherAlert({ fetch: async () => okJson(openMeteoBody()) })).resolves.toBeNull();
    await expect(driveWeatherAlert({ fetch: async () => ({ ok: false }) as Response })).resolves.toBeNull();
    mockLastKnown.mockResolvedValue(null);
    await expect(driveWeatherAlert({ fetch: async () => okJson(openMeteoBody(ICY)) })).resolves.toBeNull();
    mockLastKnown.mockRejectedValue(new Error('no location'));
    await expect(driveWeatherAlert({ fetch: async () => okJson(openMeteoBody(ICY)) })).resolves.toBeNull();
  });
});

describe('useDriveWeather: at the start, then every 15 min or 20 km, only while recording', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLastKnown.mockReset().mockResolvedValue({ coords: { latitude: 39.74, longitude: -104.99 } });
    mockFetch = jest.fn(async () => okJson(openMeteoBody(ICY)));
  });
  afterEach(() => jest.useRealTimers());

  const flush = () => act(async () => {});

  test('not recording: no request, no alert', async () => {
    const { result } = await renderHook(() => useDriveWeather(false, 0, { fetch: mockFetch }));
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test('fetches at the start, after 15 min and after 20 km, and not faster', async () => {
    const { result, rerender } = await renderHook(({ d }: { d: number }) => useDriveWeather(true, d, { fetch: mockFetch }), {
      initialProps: { d: 0 },
    });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current?.kind).toBe('freezing_rain');

    await rerender({ d: WEATHER_REFETCH_DISTANCE_M - 1 });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(WEATHER_REFRESH_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await rerender({ d: WEATHER_REFETCH_DISTANCE_M });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('an unchanged answer keeps the same alert object (no re-render of the screen)', async () => {
    const { result } = await renderHook(() => useDriveWeather(true, 0, { fetch: mockFetch }));
    await flush();
    const first = result.current;
    await act(async () => {
      jest.advanceTimersByTime(WEATHER_REFRESH_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);
  });

  test('the danger ends: the alert goes on the next ask', async () => {
    const { result } = await renderHook(() => useDriveWeather(true, 0, { fetch: mockFetch }));
    await flush();
    expect(result.current).not.toBeNull();
    mockFetch.mockImplementation(async () => okJson(openMeteoBody()));
    await act(async () => {
      jest.advanceTimersByTime(WEATHER_REFRESH_MS);
    });
    expect(result.current).toBeNull();
  });

  test('no last known position: no request, no alert', async () => {
    mockLastKnown.mockResolvedValue(null);
    const { result } = await renderHook(() => useDriveWeather(true, 0, { fetch: mockFetch }));
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test('in the background nothing is asked; a tick missed there is asked on the return to the front, once', async () => {
    const listeners: ((s: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
      listeners.push(fn as (s: AppStateStatus) => void);
      return { remove: () => {} } as never;
    });
    const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
    let current: AppStateStatus = 'active';
    Object.defineProperty(AppState, 'currentState', { get: () => current, configurable: true });
    try {
      await renderHook(() => useDriveWeather(true, 0, { fetch: mockFetch }));
      await flush();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      current = 'background';
      await act(async () => {
        jest.advanceTimersByTime(WEATHER_REFRESH_MS * 2);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      current = 'active';
      await act(async () => {
        for (const l of listeners) l('active');
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // nothing was missed since: another return asks nothing
      await act(async () => {
        for (const l of listeners) l('active');
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(AppState, 'currentState', original);
      else delete (AppState as { currentState?: unknown }).currentState;
      jest.restoreAllMocks();
    }
  });

  test('the drive ends: no alert', async () => {
    const { result, rerender } = await renderHook(({ on }: { on: boolean }) => useDriveWeather(on, 0, { fetch: mockFetch }), {
      initialProps: { on: true },
    });
    await flush();
    expect(result.current).not.toBeNull();
    await rerender({ on: false });
    expect(result.current).toBeNull();
  });
});
