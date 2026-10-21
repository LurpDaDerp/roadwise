import { act, renderHook } from '@testing-library/react-native';
import { useEffect } from 'react';
import { AppState } from 'react-native';

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

const answer61 = () => answer(61);

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
  // The listeners as the app would hold them: removing one stops it hearing anything.
  const listeners = new Set<(s: string) => void>();
  const listen = ((_type: string, l: (s: string) => void) => {
    listeners.add(l);
    return { remove: () => listeners.delete(l) };
  }) as unknown as typeof AppState.addEventListener;
  const fetch = jest.fn(answer(61));
  const position = jest.fn(async () => ({ lat: 47.6, lng: -122.3 }));
  const ports: SkyPorts = { position, storage: memoryStorage(), fetch, now: () => NOON_SEATTLE };
  // Only for this test: the shared mock keeps its own answer for the tests after it.
  await jest.mocked(AppState.addEventListener).withImplementation(listen, async () => {
    const { rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useSkyMood(ports, { enabled }), {
      initialProps: { enabled: true },
    });
    await flush();
    expect(position).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    await rerender({ enabled: false });
    for (const l of [...listeners]) l('active');
    await flush();
    expect(listeners.size).toBe(0);
    expect(position).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

test('turned off while the position is being read (the stored static look arriving), it asks for no weather once the position answers', async () => {
  let found: (p: { lat: number; lng: number }) => void = () => {};
  const position = jest.fn(() => new Promise<{ lat: number; lng: number }>((r) => (found = r)));
  const fetch = jest.fn(answer61());
  const ports: SkyPorts = { position, storage: memoryStorage(), fetch, now: () => NOON_SEATTLE };
  const { result, rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useSkyMood(ports, { enabled }), {
    initialProps: { enabled: true },
  });
  await flush();
  expect(position).toHaveBeenCalledTimes(1);

  await rerender({ enabled: false });
  await act(async () => found({ lat: 47.60621, lng: -122.33207 }));
  await flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.weather.kind).toBe('clear');
});

/**
 * What a theme fed `enabled ? mood : null` (the root layout's Adaptive) wears at each commit while
 * on, as `phase:weather`, each change once.
 */
function useCommitted(ports: SkyPorts, enabled: boolean, seen: string[]) {
  const mood = useSkyMood(ports, { enabled });
  useEffect(() => {
    const worn = `${mood.phase}:${mood.weather.kind}`;
    if (enabled && seen.at(-1) !== worn) seen.push(worn);
  });
  return mood;
}

test("turned back on, the first mood handed on is the hour of that moment, never the hour it was last on", async () => {
  // Seattle: noon PDT, then midnight.
  let now = Date.parse('2026-06-21T19:00:00Z');
  const ports: SkyPorts = { position: async () => null, storage: null, now: () => now };
  const seen: string[] = [];
  const { rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useCommitted(ports, enabled, seen), {
    initialProps: { enabled: true },
  });
  await flush();
  expect(seen.at(-1)).toBe('day:clear');

  await rerender({ enabled: false });
  now = Date.parse('2026-06-22T07:00:00Z');
  seen.length = 0;
  await rerender({ enabled: true });
  await flush();
  expect(seen).toEqual(['night:clear']);
});

/** The first request answers rain; the next waits (a slow network) until `fail` turns it down. */
function slowSecondAnswer() {
  let calls = 0;
  let fail: () => void = () => {};
  const fetch: FetchLike = (url, init) => {
    calls++;
    if (calls === 1) return answer61()(url, init);
    return new Promise<Response>((r) => (fail = () => r({ ok: false } as Response)));
  };
  return { fetch, calls: () => calls, fail: () => fail() };
}

test('turned back on more than 3 h after its last weather answer, that answer is not shown while the new one is asked for', async () => {
  let now = NOON_SEATTLE;
  const { fetch, calls, fail } = slowSecondAnswer();
  const ports: SkyPorts = { position: async () => ({ lat: 47.6, lng: -122.3 }), storage: memoryStorage(), fetch, now: () => now };
  const seen: string[] = [];
  const { rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useCommitted(ports, enabled, seen), {
    initialProps: { enabled: true },
  });
  await flush();
  expect(seen.at(-1)).toBe('day:rain');

  await rerender({ enabled: false });
  now = NOON_SEATTLE + 3 * 60 * 60_000 + 60_000;
  seen.length = 0;
  await rerender({ enabled: true });
  await flush();
  expect(calls()).toBe(2);
  expect(seen).toEqual(['day:clear']);
  await act(async () => fail());
  await flush();
  expect(seen).toEqual(['day:clear']);
});

test('turned back on within 3 h, the last answer stays on show while the new one is asked for', async () => {
  let now = NOON_SEATTLE;
  const { fetch, calls, fail } = slowSecondAnswer();
  const ports: SkyPorts = { position: async () => ({ lat: 47.6, lng: -122.3 }), storage: memoryStorage(), fetch, now: () => now };
  const seen: string[] = [];
  const { result, rerender } = await renderHook(({ enabled }: { enabled: boolean }) => useCommitted(ports, enabled, seen), {
    initialProps: { enabled: true },
  });
  await flush();
  await rerender({ enabled: false });
  now = NOON_SEATTLE + 60 * 60_000;
  seen.length = 0;
  await rerender({ enabled: true });
  await flush();
  expect(calls()).toBe(2);
  expect(seen).not.toContain('day:clear');
  expect(result.current).toMatchObject({ phase: 'day', weather: { kind: 'rain' } });
  // A failed request keeps an answer under 3 h old.
  await act(async () => fail());
  await flush();
  expect(seen).not.toContain('day:clear');
  expect(result.current).toMatchObject({ phase: 'day', weather: { kind: 'rain' } });
});
