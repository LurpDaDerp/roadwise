import {
  fetchWeatherHazard,
  FOG_VISIBILITY_M,
  openMeteoUrl,
  WEATHER_CURRENT_VARS,
  WEATHER_TIMEOUT_MS,
  weatherHazardOf,
  WIND_GUST_HAZARD_KMH,
} from '../weather';

describe('weatherHazardOf — at most one hazard, the most dangerous first', () => {
  test.each([
    [95, 'thunderstorm'],
    [96, 'thunderstorm'],
    [99, 'thunderstorm'],
    [56, 'icy_rain'],
    [57, 'icy_rain'],
    [66, 'icy_rain'],
    [67, 'icy_rain'],
    [75, 'heavy_snow'],
    [86, 'heavy_snow'],
    [45, 'dense_fog'],
    [48, 'dense_fog'],
    [65, 'heavy_rain'],
    [82, 'heavy_rain'],
  ] as const)('WMO code %i → %s', (code, hazard) => {
    expect(weatherHazardOf({ weather_code: code })).toBe(hazard);
  });

  test.each([0, 1, 2, 3, 51, 61, 63, 71, 73, 80, 81, 85])(
    'ordinary weather (code %i) is no hazard',
    (code) => {
      expect(weatherHazardOf({ weather_code: code, wind_gusts_10m: 30, visibility: 20_000 })).toBe(
        null
      );
    }
  );

  test('a sight line under 200 m is dense fog whatever the code says', () => {
    expect(weatherHazardOf({ weather_code: 3, visibility: FOG_VISIBILITY_M - 1 })).toBe('dense_fog');
    expect(weatherHazardOf({ weather_code: 3, visibility: FOG_VISIBILITY_M })).toBeNull();
  });

  test('gusts at 70 km/h are strong wind; under it, nothing', () => {
    expect(weatherHazardOf({ weather_code: 2, wind_gusts_10m: WIND_GUST_HAZARD_KMH })).toBe(
      'strong_wind'
    );
    expect(weatherHazardOf({ weather_code: 2, wind_gusts_10m: WIND_GUST_HAZARD_KMH - 0.1 })).toBe(
      null
    );
  });

  test('severity order: a thunderstorm in a gale is a thunderstorm; fog in rain is fog', () => {
    expect(weatherHazardOf({ weather_code: 95, wind_gusts_10m: 100, visibility: 50 })).toBe(
      'thunderstorm'
    );
    expect(weatherHazardOf({ weather_code: 65, visibility: 100 })).toBe('dense_fog');
    expect(weatherHazardOf({ weather_code: 65, wind_gusts_10m: 100 })).toBe('heavy_rain');
  });

  test('missing, null or nonsense fields are no hazard', () => {
    expect(weatherHazardOf({})).toBeNull();
    expect(weatherHazardOf({ weather_code: null, wind_gusts_10m: null, visibility: null })).toBe(
      null
    );
    expect(weatherHazardOf({ weather_code: Number.NaN, wind_gusts_10m: Number.NaN })).toBeNull();
    expect(weatherHazardOf({ weather_code: '95' as unknown as number })).toBeNull();
  });
});

test('the request asks Open-Meteo for the current conditions at a ~100 m position', () => {
  const url = openMeteoUrl(47.60621, -122.33207);
  expect(url.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
  expect(url).toContain('latitude=47.606');
  expect(url).toContain('longitude=-122.332');
  expect(url).toContain(`current=${WEATHER_CURRENT_VARS}`);
  expect(url).toContain('wind_speed_unit=kmh');
  expect(WEATHER_CURRENT_VARS.split(',')).toEqual(['weather_code', 'wind_gusts_10m', 'visibility']);
});

describe('fetchWeatherHazard — never throws, never shows a hazard it did not get', () => {
  const ok = (current: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ current }) } as Response);

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('an answer maps to its hazard', async () => {
    const fetch = jest.fn(() => ok({ weather_code: 95 }));
    await expect(fetchWeatherHazard(1, 2, { fetch })).resolves.toBe('thunderstorm');
    expect(fetch).toHaveBeenCalledWith(openMeteoUrl(1, 2), expect.objectContaining({ signal: expect.anything() }));
  });

  test('a calm answer is null', async () => {
    const fetch = jest.fn(() => ok({ weather_code: 1, wind_gusts_10m: 10, visibility: 30_000 }));
    await expect(fetchWeatherHazard(1, 2, { fetch })).resolves.toBeNull();
  });

  test('a non-2xx answer, a broken body and a network error are all null', async () => {
    await expect(
      fetchWeatherHazard(1, 2, { fetch: jest.fn(() => Promise.resolve({ ok: false } as Response)) })
    ).resolves.toBeNull();
    await expect(
      fetchWeatherHazard(1, 2, {
        fetch: jest.fn(() =>
          Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) } as Response)
        ),
      })
    ).resolves.toBeNull();
    await expect(
      fetchWeatherHazard(1, 2, {
        fetch: jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(null) } as Response)),
      })
    ).resolves.toBeNull();
    await expect(
      fetchWeatherHazard(1, 2, { fetch: jest.fn(() => Promise.reject(new Error('offline'))) })
    ).resolves.toBeNull();
  });

  test('a slow answer is abandoned after 5 s', async () => {
    const fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = fetchWeatherHazard(1, 2, { fetch });
    await jest.advanceTimersByTimeAsync(WEATHER_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
    expect(WEATHER_TIMEOUT_MS).toBe(5000);
  });
});
