import { act, renderHook } from '@testing-library/react-native';

import { useSkyMood, type SkyPorts } from '@/ui/sky/useSkyMood';
import { SKY_CACHE_KEY, type FetchLike } from '@/ui/sky/weather';

const NOON_SEATTLE = Date.parse('2024-03-20T20:00:00Z');

function memoryStorage(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    data,
    getItem: jest.fn(async (k: string) => data[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      data[k] = v;
    }),
  };
}

const answer =
  (code: number): FetchLike =>
  async () =>
    ({ ok: true, json: async () => ({ current: { weather_code: code, cloud_cover: 90 } }) }) as unknown as Response;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

test('reads the sun at the known position and the weather there, storing only the rounded place', async () => {
  const storage = memoryStorage();
  const fetch = jest.fn(answer(61));
  const ports: SkyPorts = {
    position: async () => ({ lat: 47.60621, lng: -122.33207 }),
    storage,
    fetch,
    now: () => NOON_SEATTLE,
  };
  const { result } = await renderHook(() => useSkyMood(ports));
  await flush();
  expect(result.current).toMatchObject({ phase: 'day', weather: { kind: 'rain' } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toContain('latitude=47.6&longitude=-122.3');
  const stored = JSON.parse(storage.data[SKY_CACHE_KEY]!);
  expect(stored).toMatchObject({ lat: 47.6, lng: -122.3, weather: { kind: 'rain' } });
});

test('with no position it follows the clock and asks no one', async () => {
  const fetch = jest.fn(answer(0));
  const ports: SkyPorts = {
    position: async () => null,
    storage: memoryStorage(),
    fetch,
    now: () => new Date(2026, 9, 17, 23, 0).getTime(),
  };
  const { result } = await renderHook(() => useSkyMood(ports));
  await flush();
  expect(result.current).toMatchObject({ phase: 'night', weather: { kind: 'clear' } });
  expect(fetch).not.toHaveBeenCalled();
});

test('a stored answer paints at once and is reused while fresh', async () => {
  const storage = memoryStorage({
    [SKY_CACHE_KEY]: JSON.stringify({ lat: 47.6, lng: -122.3, weather: { kind: 'snow', intensity: 'light' }, fetchedAt: NOON_SEATTLE - 60_000 }),
  });
  const fetch = jest.fn(answer(0));
  const ports: SkyPorts = { position: async () => ({ lat: 47.6, lng: -122.3 }), storage, fetch, now: () => NOON_SEATTLE };
  const { result } = await renderHook(() => useSkyMood(ports));
  await flush();
  expect(result.current.weather.kind).toBe('snow');
  expect(fetch).not.toHaveBeenCalled();
});

test('turned off (a static look), it reads no position and asks for no weather; turned back on, it reads both at once', async () => {
  const fetch = jest.fn(answer(61));
  const position = jest.fn(async () => ({ lat: 47.60621, lng: -122.33207 }));
  const ports: SkyPorts = { position, storage: memoryStorage(), fetch, now: () => NOON_SEATTLE };
  const { result, rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useSkyMood(ports, { enabled }), {
    initialProps: { enabled: false },
  });
  await flush();
  expect(position).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();

  await rerender({ enabled: true });
  await flush();
  expect(position).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ phase: 'day', weather: { kind: 'rain' } });
});

test('turned off, coming back to the front asks no one either', async () => {
  const { AppState } = jest.requireActual<typeof import('react-native')>('react-native');
  const listeners: ((s: string) => void)[] = [];
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, l: (s: string) => void) => {
    listeners.push(l);
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);
  const fetch = jest.fn(answer(61));
  const position = jest.fn(async () => ({ lat: 47.6, lng: -122.3 }));
  await renderHook(() => useSkyMood({ position, storage: memoryStorage(), fetch, now: () => NOON_SEATTLE }, { enabled: false }));
  await flush();
  for (const l of listeners) l('active');
  await flush();
  expect(position).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  spy.mockRestore();
});
