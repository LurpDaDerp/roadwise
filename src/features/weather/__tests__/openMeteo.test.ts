import { fetchWeather, OPEN_METEO_TIMEOUT_MS, parseWeather, roundCoord, weatherUrl, type FetchLike } from '../openMeteo';

import { H, NOW, okJson, openMeteoBody } from '../__fixtures__/openMeteo';

describe('the request', () => {
  test('the position is rounded to one decimal (about 10 km) before it leaves the phone', () => {
    const url = weatherUrl(47.60621, -122.33207);
    expect(url).toContain('latitude=47.6&longitude=-122.3&');
    expect(url).not.toContain('47.606');
    expect(url).not.toContain('122.332');
    expect(weatherUrl(0.04, -0.04)).toContain('latitude=0.0&longitude=0.0&');
    expect(weatherUrl(40.05, 9.96)).toContain('latitude=40.1&longitude=10.0&');
    expect(roundCoord(-33.86785)).toBe(-33.9);
  });

  test('Open-Meteo, mph, now and the next 2 hours plus the last 3, every variable the alerts read', () => {
    const url = new URL(weatherUrl(47.6, -122.3));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(url.searchParams.get('past_hours')).toBe('3');
    expect(url.searchParams.get('forecast_hours')).toBe('3');
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
    for (const block of ['current', 'hourly']) {
      expect(url.searchParams.get(block)?.split(',').sort()).toEqual(
        ['precipitation', 'rain', 'showers', 'snowfall', 'temperature_2m', 'visibility', 'weather_code', 'wind_gusts_10m', 'wind_speed_10m'].sort()
      );
    }
  });
});

describe('the reading', () => {
  test('now (quarter-hour sums as hourly rates), then only the hours ahead within 2 hours', () => {
    const r = parseWeather(openMeteoBody({ current: { rain: 1, showers: 0.5, precipitation: 1.5, snowfall: 0.25 } }))!;
    expect(r.samples.map((s) => s.time)).toEqual([NOW, H + 3600, H + 2 * 3600]);
    expect(r.samples[0]).toMatchObject({ code: 3, tempC: 8.3, rainMmH: 6, precipMmH: 6, snowCmH: 1, windMph: 4.8, gustMph: 7.6, visibilityM: 15300 });
    expect(r.samples[1]).toMatchObject({ rainMmH: 0, gustMph: 9, visibilityM: 16000 });
  });

  test('recent rain: the hourly rain and showers of the last 3 hours, plus the quarter hour since', () => {
    const r = parseWeather(
      openMeteoBody({
        current: { rain: 0.1, showers: 0 },
        hourly: { rain: [9, 0.2, 0.3, 0.1, 5, 5], showers: [0, 0, 0.1, 0, 0, 0] },
      })
    )!;
    // H − 3 h is outside the window; H + 1 h and H + 2 h are ahead.
    expect(r.recentRainMm).toBeCloseTo(0.2 + 0.4 + 0.1 + 0.1, 5);
  });

  test('missing variables read as unknown, not as zero', () => {
    const r = parseWeather({ current: { time: NOW, weather_code: 45 } })!;
    expect(r.samples).toEqual([
      { time: NOW, code: 45, tempC: null, rainMmH: null, precipMmH: null, snowCmH: null, windMph: null, gustMph: null, visibilityM: null },
    ]);
    expect(r.recentRainMm).toBe(0);
  });

  test('a body without current conditions is no reading', () => {
    expect(parseWeather(null)).toBeNull();
    expect(parseWeather('x')).toBeNull();
    expect(parseWeather({})).toBeNull();
    expect(parseWeather({ current: { weather_code: 3 } })).toBeNull();
  });
});

describe('fetchWeather never throws', () => {
  test('a good answer: the reading, from the rounded position', async () => {
    const fetch = jest.fn<Promise<Response>, Parameters<FetchLike>>(async () => okJson(openMeteoBody()));
    const r = await fetchWeather(47.60621, -122.33207, { fetch });
    expect(r?.samples).toHaveLength(3);
    expect(fetch.mock.calls[0]![0]).toContain('latitude=47.6&longitude=-122.3&');
  });

  test.each<[string, FetchLike]>([
    ['an HTTP error', async () => ({ ok: false }) as Response],
    ['a network failure', async () => Promise.reject(new Error('offline'))],
    ['a malformed body', async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError('bad')) }) as unknown as Response],
    ['an empty body', async () => okJson(null)],
  ])('%s: null', async (_name, fetch) => {
    await expect(fetchWeather(40, -100, { fetch })).resolves.toBeNull();
  });

  test('no position worth asking about: no request', async () => {
    const fetch = jest.fn<Promise<Response>, Parameters<FetchLike>>();
    await expect(fetchWeather(Number.NaN, 3, { fetch })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a slow answer is aborted after 5 s: null', async () => {
    jest.useFakeTimers();
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const pending = fetchWeather(40, -100, { fetch });
      jest.advanceTimersByTime(OPEN_METEO_TIMEOUT_MS);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
