import {
  CLEAR,
  fetchSkyWeather,
  openMeteoUrl,
  parseSkyCache,
  roundCoord,
  skyWeatherFor,
  weatherFromWmo,
  WEATHER_STALE_MS,
  WEATHER_TTL_MS,
  type FetchLike,
  type SkyCache,
} from '@/ui/sky/weather';

describe('WMO codes', () => {
  test.each([
    [0, 'clear'],
    [1, 'clear'],
    [3, 'cloudy'],
    [45, 'fog'],
    [48, 'fog'],
    [51, 'rain'],
    [55, 'rain'],
    [57, 'rain'],
    [61, 'rain'],
    [65, 'rain'],
    [67, 'rain'],
    [80, 'rain'],
    [82, 'rain'],
    [71, 'snow'],
    [75, 'snow'],
    [77, 'snow'],
    [85, 'snow'],
    [86, 'snow'],
    [95, 'storm'],
    [96, 'storm'],
    [99, 'storm'],
  ])('%i → %s', (code, kind) => {
    expect(weatherFromWmo(code).kind).toBe(kind);
  });

  test('partly cloudy is cloudy only from 60 % cover', () => {
    expect(weatherFromWmo(2, 40).kind).toBe('clear');
    expect(weatherFromWmo(2, 75).kind).toBe('cloudy');
    expect(weatherFromWmo(2).kind).toBe('clear');
  });

  test('drizzle is light rain, a downpour heavy', () => {
    expect(weatherFromWmo(53)).toEqual({ kind: 'rain', intensity: 'light' });
    expect(weatherFromWmo(65)).toEqual({ kind: 'rain', intensity: 'heavy' });
  });

  test('an unknown code is clear', () => {
    expect(weatherFromWmo(42)).toEqual(CLEAR);
    expect(weatherFromWmo(Number.NaN)).toEqual(CLEAR);
  });
});

describe('the Open-Meteo request', () => {
  test('rounds the position to one decimal (about 10 km) and asks only for current conditions', () => {
    const url = openMeteoUrl(47.60621, -122.33207);
    expect(url).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=47.6&longitude=-122.3&current=weather_code,is_day,cloud_cover,precipitation'
    );
    expect(roundCoord(-0.04)).toBe(-0);
    expect(roundCoord(51.56)).toBe(51.6);
  });

  const respond =
    (body: unknown, ok = true): FetchLike =>
    async () =>
      ({ ok, json: async () => body }) as unknown as Response;

  test('reads weather_code and cloud_cover', async () => {
    await expect(fetchSkyWeather(1, 2, { fetch: respond({ current: { weather_code: 63, cloud_cover: 100 } }) })).resolves.toEqual({
      kind: 'rain',
      intensity: 'moderate',
    });
  });

  test('fails silently: HTTP error, malformed body, network error, timeout', async () => {
    await expect(fetchSkyWeather(1, 2, { fetch: respond({}, false) })).resolves.toBeNull();
    await expect(fetchSkyWeather(1, 2, { fetch: respond({ current: { weather_code: 'x' } }) })).resolves.toBeNull();
    await expect(fetchSkyWeather(1, 2, { fetch: respond(null) })).resolves.toBeNull();
    await expect(
      fetchSkyWeather(1, 2, {
        fetch: async () => {
          throw new Error('offline');
        },
      })
    ).resolves.toBeNull();
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(fetchSkyWeather(1, 2, { fetch: hang, timeoutMs: 5 })).resolves.toBeNull();
  });
});

describe('the cache', () => {
  const place = { lat: 47.6062, lng: -122.3321 };
  const T = 1_700_000_000_000;
  const fresh: SkyCache = { lat: 47.6, lng: -122.3, weather: { kind: 'snow', intensity: 'light' }, fetchedAt: T - 5 * 60_000 };

  test('a fresh answer for the same rounded place is reused without a request', async () => {
    const fetch = jest.fn<Promise<Response>, Parameters<FetchLike>>();
    const res = await skyWeatherFor(place, { now: T, cache: fresh, fetch });
    expect(res).toMatchObject({ weather: fresh.weather, fetched: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('after 30 min, or at another place, it asks again and stores only the rounded place', async () => {
    const save = jest.fn();
    const fetch: FetchLike = async () => ({ ok: true, json: async () => ({ current: { weather_code: 0 } }) }) as unknown as Response;
    const res = await skyWeatherFor(place, { now: fresh.fetchedAt + WEATHER_TTL_MS, cache: fresh, fetch, save });
    expect(res).toMatchObject({ weather: CLEAR, fetched: true });
    expect(save).toHaveBeenCalledWith({ lat: 47.6, lng: -122.3, weather: CLEAR, fetchedAt: fresh.fetchedAt + WEATHER_TTL_MS });

    const elsewhere = await skyWeatherFor({ lat: 40.71, lng: -74.0 }, { now: T, cache: fresh, fetch, save });
    expect(elsewhere.fetched).toBe(true);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 40.7, lng: -74 }));
  });

  test('a failed refresh keeps a same-place answer under 3 h old, then falls back to clear', async () => {
    const fail: FetchLike = async () => {
      throw new Error('offline');
    };
    const hourOld = { ...fresh, fetchedAt: T - 60 * 60_000 };
    await expect(skyWeatherFor(place, { now: T, cache: hourOld, fetch: fail })).resolves.toMatchObject({ weather: fresh.weather });
    const stale = { ...fresh, fetchedAt: T - WEATHER_STALE_MS - 1 };
    await expect(skyWeatherFor(place, { now: T, cache: stale, fetch: fail })).resolves.toMatchObject({ weather: CLEAR });
    await expect(skyWeatherFor({ lat: 0, lng: 0 }, { now: T, cache: fresh, fetch: fail })).resolves.toMatchObject({ weather: CLEAR });
  });

  test('a stored cache is read defensively', () => {
    expect(parseSkyCache(JSON.stringify(fresh))).toEqual(fresh);
    expect(parseSkyCache(null)).toBeNull();
    expect(parseSkyCache('{')).toBeNull();
    expect(parseSkyCache(JSON.stringify({ lat: 'x' }))).toBeNull();
    expect(parseSkyCache(JSON.stringify({ ...fresh, weather: { kind: 'hail', intensity: 'light' } }))?.weather).toBeNull();
    // A precise position that somehow got stored is rounded on the way in.
    expect(parseSkyCache(JSON.stringify({ ...fresh, lat: 47.60621, lng: -122.33207 }))).toMatchObject({ lat: 47.6, lng: -122.3 });
  });
});
