import { dangerFrom } from '../danger';
import { driveWeatherOf } from '../driveWeather';
import { parseWeather, weatherUrl } from '../openMeteo';
import { roadStateAt } from '../road';
import { fetchRoadSeries, parseRoadSeries, readingAt, retryAfterMs, reviveSeries, roadSeriesUrl } from '../roadSeries';

import { answer, INTERPOLATED, NORTH_AMERICA, NOW, recordedAt, seriesBody } from '../__fixtures__/roadSeries';

const FETCHED = NOW * 1000 + 4000;
const VARS = ['is_day', 'precipitation', 'rain', 'showers', 'snowfall', 'temperature_2m', 'visibility', 'weather_code', 'wind_gusts_10m', 'wind_speed_10m'];

describe('the request', () => {
  test('the 15-minute series 7 hours back and 2 ahead, the hours 6 back and 5 ahead, every variable the alerts read, no current', () => {
    const url = new URL(roadSeriesUrl(47.6, -122.3));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => !['minutely_15', 'hourly'].includes(k)))).toEqual({
      latitude: '47.6',
      longitude: '-122.3',
      past_minutely_15: '28',
      forecast_minutely_15: '8',
      past_hours: '6',
      forecast_hours: '5',
      wind_speed_unit: 'mph',
      timeformat: 'unixtime',
    });
    for (const block of ['minutely_15', 'hourly']) expect(url.searchParams.get(block)?.split(',').sort()).toEqual(VARS);
    // 20 variables: the same cost as the current-and-hourly request.
    expect(new URL(weatherUrl(47.6, -122.3)).searchParams.get('hourly')).toBe(url.searchParams.get('minutely_15'));
  });

  test('the position is rounded to one decimal before it leaves the phone', () => {
    const url = roadSeriesUrl(47.60621, -122.33207);
    expect(url).toContain('latitude=47.6&longitude=-122.3&');
    expect(url).not.toContain('47.606');
  });
});

describe('the answer', () => {
  test('a North America answer: 36 steps, step 28 is now, rain and showers one sum, the hourly block kept', () => {
    const s = parseRoadSeries(NORTH_AMERICA, 47.61, -122.33, FETCHED)!;
    expect(s).toMatchObject({ lat: 47.6, lng: -122.3, fetchedAtMs: FETCHED });
    expect(s.steps).toHaveLength(36);
    expect(s.steps[0]?.t).toBe(NOW - 7 * 3600);
    expect(s.steps[28]?.t).toBe(NOW);
    expect(s.steps[28]).toMatchObject({ code: 61, rain15: 0.4, isDay: true, visM: 9600 });
    expect(s.steps[32]).toMatchObject({ code: 65, isDay: false });
    expect(s.steps[32]?.rain15).toBeCloseTo(1.9, 9);
    expect(s.hourly.time).toHaveLength(12);
    expect(Object.keys(s.hourly).sort()).toEqual(['time', ...VARS].sort());
  });

  test('an interpolated answer: each hour spread flat over its steps', () => {
    const s = parseRoadSeries(INTERPOLATED, 35.68, 139.69, FETCHED)!;
    expect(s.steps.slice(25, 29).map((x) => x.rain15)).toEqual([1, 1, 1, 1]);
    expect(roadStateAt(s, NOW * 1000, 35.68, 139.69)).toEqual({ g: 'wet' });
  });

  test('every field may be missing; times out of order are skipped; no steps is no answer', () => {
    const s = parseRoadSeries({ minutely_15: { time: [900, 1800, 1800, 900, 'x', 2700], rain: [1, 'wet'], is_day: [1, 0, 1, 1, 1, 2] } }, 1, 2, 0)!;
    expect(s.steps.map((x) => x.t)).toEqual([900, 1800, 2700]);
    expect(s.steps[0]).toEqual({ t: 900, code: null, tempC: null, rain15: 1, precip15: null, snow15: null, windMph: null, gustMph: null, visM: null, isDay: true });
    expect(s.steps[1]).toMatchObject({ rain15: null, isDay: false });
    expect(s.steps[2]?.isDay).toBeNull();
    expect(s.hourly).toEqual({});
    for (const body of [null, 'x', [], {}, { minutely_15: { time: [] } }, { minutely_15: [1] }]) expect(parseRoadSeries(body, 1, 2, 0)).toBeNull();
    expect(parseRoadSeries(NORTH_AMERICA, Number.NaN, 2, 0)).toBeNull();
  });

  test('a saved series reads back as it was; anything else is none', () => {
    const s = parseRoadSeries(NORTH_AMERICA, 47.6, -122.3, FETCHED)!;
    expect(reviveSeries(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(reviveSeries(null)).toBeNull();
    expect(reviveSeries({ ...s, fetchedAtMs: 'x' })).toBeNull();
    expect(reviveSeries({ ...s, steps: [] })).toBeNull();
    expect(reviveSeries({ ...s, steps: [...s.steps].reverse() })).toBeNull();
  });
});

describe('the reading at a step is the reading of a current-and-hourly answer at that moment', () => {
  test.each([
    ['North America', NORTH_AMERICA],
    ['interpolated', INTERPOLATED],
  ])('%s: the same WeatherReading, alert and tag, now and at later steps', (_, body) => {
    const s = parseRoadSeries(body, 47.6, -122.3, FETCHED)!;
    for (const k of [0, 1, 2, 3]) {
      const at = NOW + k * 900;
      const recorded = parseWeather(recordedAt(body, at));
      const ours = readingAt(s, at * 1000 + 30_000);
      expect(ours).toEqual(recorded);
      expect(dangerFrom(ours)).toEqual(dangerFrom(recorded));
      expect(driveWeatherOf(ours)).toEqual(driveWeatherOf(recorded));
    }
  });

  test('the fixtures make it count: an alert and a tag to agree on', () => {
    const s = parseRoadSeries(NORTH_AMERICA, 47.6, -122.3, FETCHED)!;
    expect(driveWeatherOf(readingAt(s, NOW * 1000))).toBe('rain');
    expect(dangerFrom(readingAt(s, NOW * 1000))?.kind).toBe('rain_at_night');
    const showers = seriesBody(NOW, (t) => (t === NOW ? { rain: 0.3, showers: 0.2 } : {}));
    const reading = readingAt(parseRoadSeries(showers, 47.6, -122.3, FETCHED)!, NOW * 1000)!;
    expect(reading.samples[0]?.rainMmH).toBe(2);
    expect(reading).toEqual(parseWeather(recordedAt(showers, NOW)));
  });

  test('before the first step there is no reading', () => {
    const s = parseRoadSeries(NORTH_AMERICA, 47.6, -122.3, FETCHED)!;
    expect(readingAt(s, (NOW - 7 * 3600) * 1000 - 1)).toBeNull();
  });
});

describe('fetching', () => {
  const now = () => FETCHED;

  test('an answer: the series of the rounded cell, stamped when it came', async () => {
    const urls: string[] = [];
    const r = await fetchRoadSeries(47.61, -122.34, { now, fetch: async (url) => (urls.push(url), answer(NORTH_AMERICA)) });
    expect(urls).toEqual([roadSeriesUrl(47.6, -122.3)]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.series).toMatchObject({ lat: 47.6, lng: -122.3, fetchedAtMs: FETCHED });
  });

  test('429: limited, with its Retry-After when it has one', async () => {
    expect(await fetchRoadSeries(1, 2, { now, fetch: async () => answer({ error: true }, 429, { 'Retry-After': '120' }) })).toEqual({ kind: 'limited', retryAfterMs: 120_000 });
    expect(await fetchRoadSeries(1, 2, { now, fetch: async () => answer({ error: true }, 429) })).toEqual({ kind: 'limited', retryAfterMs: null });
  });

  test('any other failure: an error status, a malformed body, a throw, a slow answer, a bad position', async () => {
    expect(await fetchRoadSeries(1, 2, { now, fetch: async () => answer({ error: true, reason: 'x' }, 400) })).toEqual({ kind: 'failed' });
    expect(await fetchRoadSeries(1, 2, { now, fetch: async () => answer({ error: true }, 503) })).toEqual({ kind: 'failed' });
    expect(await fetchRoadSeries(1, 2, { now, fetch: async () => answer({ hourly: {} }) })).toEqual({ kind: 'failed' });
    expect(
      await fetchRoadSeries(1, 2, {
        now,
        fetch: async () => {
          throw new Error('offline');
        },
      })
    ).toEqual({ kind: 'failed' });
    const slow = (_: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await fetchRoadSeries(1, 2, { now, fetch: slow, timeoutMs: 5 })).toEqual({ kind: 'failed' });
    expect(await fetchRoadSeries(Number.NaN, 2, { now, fetch: async () => answer(NORTH_AMERICA) })).toEqual({ kind: 'failed' });
  });

  test('Retry-After: seconds or an HTTP date', () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    expect(retryAfterMs(' 0 ', 0)).toBe(0);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:00:00 GMT'))).toBe(28 * 60_000);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 08:00:00 GMT'))).toBe(0);
    for (const v of [null, undefined, '', 'soon', '-5']) expect(retryAfterMs(v, 0)).toBeNull();
  });
});
