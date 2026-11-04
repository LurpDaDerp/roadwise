/** @jest-environment node */
import { fetchForecast, FORECAST_HOURS, forecastUrl, parseForecast } from '../forecast';

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

const H0 = 1_792_396_800; // an hour's stamp (unix s)
const rows = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

/** `n` hourly rows from H0. */
function body(n: number, over: Record<string, unknown[]> = {}) {
  return {
    hourly: {
      time: Array.from({ length: n }, (_, i) => H0 + i * 3600),
      weather_code: rows(n, 3),
      temperature_2m: rows(n, 5),
      precipitation: rows(n, 0),
      rain: rows(n, 0),
      showers: rows(n, 0),
      snowfall: rows(n, 0),
      wind_speed_10m: rows(n, 5),
      wind_gusts_10m: rows(n, 9),
      visibility: rows(n, 16000),
      is_day: rows(n, 1),
      ...over,
    },
  };
}

it('asks for the hourly forecast at the place rounded to 0.1°, 6 hours back and 24 ahead', () => {
  const url = forecastUrl(40.7128, -74.006);
  expect(url).toContain('latitude=40.7&longitude=-74.0');
  expect(url).toContain('&hourly=weather_code,temperature_2m,precipitation,rain,showers,snowfall,wind_speed_10m,wind_gusts_10m,visibility,is_day');
  expect(url).toContain('&past_hours=6&forecast_hours=24');
  expect(FORECAST_HOURS).toBe(24);
  expect(url).toContain('&wind_speed_unit=mph&timeformat=unixtime');
  expect(url).not.toContain('current=');
  expect(url).not.toContain('40.71');
});

it('reads every hour, in order, as an hourly rate', () => {
  const f = parseForecast(body(3, { rain: [0, 1, 2], showers: [0, 0.5, null], snowfall: [0, 0, 0.3], is_day: [1, 0, null] }));
  expect(f?.points.map((p) => p.sample.time)).toEqual([H0, H0 + 3600, H0 + 7200]);
  expect(f?.points[1]?.sample).toMatchObject({ rainMmH: 1.5, isDay: false, tempC: 5, gustMph: 9 });
  expect(f?.points[2]?.sample).toMatchObject({ rainMmH: 2, snowCmH: 0.3, isDay: null });
});

it('gives each hour the rain of the 3 hours and the snow of the 6 hours up to it', () => {
  const rain = [1, 1, 1, 1, 0, 0, 0, 0];
  const snow = [1, 0, 0, 0, 0, 0, 1, 0];
  const f = parseForecast(body(8, { rain, snowfall: snow }));
  expect(f?.points.map((p) => p.recentRainMm)).toEqual([1, 2, 3, 3, 2, 1, 0, 0]);
  expect(f?.points.map((p) => p.recentSnowCm)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  // Snow from 6 hours before falls out; the stamp's own hour counts.
  expect(parseForecast(body(8, { snowfall: [1, 0, 0, 0, 0, 0, 0, 0] }))?.points.map((p) => p.recentSnowCm)).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
});

it('sorts the hours and drops a repeated or broken stamp', () => {
  const b = body(3);
  b.hourly.time = [H0 + 7200, H0, H0 + 7200, 'x' as unknown as number].slice(0, 3);
  b.hourly.time.push(Number.NaN);
  const f = parseForecast(b);
  expect(f?.points.map((p) => p.sample.time)).toEqual([H0, H0 + 7200]);
});

it('reads nothing from a body with no hourly stamps', () => {
  expect(parseForecast(null)).toBeNull();
  expect(parseForecast('x')).toBeNull();
  expect(parseForecast({})).toBeNull();
  expect(parseForecast({ hourly: {} })).toBeNull();
  expect(parseForecast({ hourly: { time: [] } })).toBeNull();
  expect(parseForecast({ hourly: { time: ['a'] } })).toBeNull();
});

it('a missing value is unknown, not zero', () => {
  const f = parseForecast({ hourly: { time: [H0] } });
  expect(f?.points[0]?.sample).toMatchObject({ code: null, tempC: null, rainMmH: null, visibilityM: null });
  expect(f?.points[0]).toMatchObject({ recentRainMm: 0, recentSnowCm: 0 });
});

describe('the request', () => {
  it('reads the answer', async () => {
    const fetch = jest.fn(async () => okJson(body(2)));
    const f = await fetchForecast(40.7, -74, { fetch });
    expect(f?.points).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(forecastUrl(40.7, -74), expect.objectContaining({ headers: { Accept: 'application/json' } }));
  });

  it('is null on any failure, and never throws', async () => {
    expect(await fetchForecast(40.7, -74, { fetch: async () => ({ ok: false }) as Response })).toBeNull();
    expect(await fetchForecast(40.7, -74, { fetch: async () => Promise.reject(new Error('offline')) })).toBeNull();
    expect(await fetchForecast(40.7, -74, { fetch: async () => ({ ok: true, json: async () => Promise.reject(new Error('bad')) }) as unknown as Response })).toBeNull();
    expect(await fetchForecast(Number.NaN, -74, { fetch: async () => okJson(body(2)) })).toBeNull();
  });

  it('gives up after the timeout', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const pending = fetchForecast(40.7, -74, { fetch, timeoutMs: 5000 });
      jest.advanceTimersByTime(5000);
      expect(await pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
