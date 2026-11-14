import { assert, assertEquals } from '@std/assert';
import { handleWeather, OPEN_METEO_FORECAST, upstreamUrl, type WeatherDeps } from './handler.ts';

const GOOD = 'good-token';
const UID = '00000000-0000-4000-8000-000000000001';
const VARS = 'weather_code,temperature_2m,precipitation,rain,showers,snowfall,wind_speed_10m,wind_gusts_10m,visibility,is_day';
const HOME_QUERY = `latitude=47.6&longitude=-122.3&current=${VARS}&hourly=${VARS}&past_hours=6&forecast_hours=3&wind_speed_unit=mph&timeformat=unixtime`;
const SERIES_QUERY =
  `latitude=47.6&longitude=-122.3&minutely_15=${VARS}&hourly=${VARS}` +
  '&past_minutely_15=28&forecast_minutely_15=8&past_hours=6&forecast_hours=5&wind_speed_unit=mph&timeformat=unixtime';
const SKY_QUERY = 'latitude=47.6&longitude=-122.3&current=weather_code,is_day,cloud_cover,precipitation';
const FORECAST_QUERY = `latitude=47.6&longitude=-122.3&hourly=${VARS}&past_hours=6&forecast_hours=24&wind_speed_unit=mph&timeformat=unixtime`;

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function deps(over: Partial<WeatherDeps> = {}): WeatherDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    verifyJwt: (token) => Promise.resolve(token === GOOD ? UID : null),
    fetch: (url) => {
      calls.push(url);
      return Promise.resolve(new Response('{"current":{"time":1}}', { status: 200 }));
    },
    log: quiet,
    ...over,
  };
}

/** The phone's call: the query in a POST body, the region supabase-js adds in the URL. */
const call = (query: string, token: string | null = GOOD, method = 'POST'): Request =>
  new Request('https://x.supabase.co/functions/v1/weather?forceFunctionRegion=eu-central-1', {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: method === 'POST' ? JSON.stringify({ query }) : undefined,
  });

/** A query's parameters in name order, for comparing two queries whatever order they were written in. */
const sorted = (q: string): string[] => [...new URLSearchParams(q)].map(([k, v]) => `${k}=${v}`).sort();

Deno.test('every query the app sends passes through unchanged', () => {
  for (const q of [HOME_QUERY, SERIES_QUERY, SKY_QUERY, FORECAST_QUERY]) {
    const url = upstreamUrl(new URLSearchParams(q));
    assert(url !== null && url.startsWith(`${OPEN_METEO_FORECAST}?`), q);
    assert(!url.includes('%2C'));
    assertEquals(sorted(url.slice(OPEN_METEO_FORECAST.length + 1)), sorted(q));
  }
});

Deno.test('commas sent as %2C are read', () => {
  const url = upstreamUrl(new URLSearchParams(SKY_QUERY.replaceAll(',', '%2C')));
  assertEquals(url, `${OPEN_METEO_FORECAST}?${SKY_QUERY}`);
});

Deno.test('a finer position, an unknown variable or parameter, a repeat or a big count is refused', () => {
  const bad = [
    'latitude=47.61&longitude=-122.3&current=weather_code',
    'latitude=47&longitude=-122.3&current=weather_code',
    'latitude=91.0&longitude=-122.3&current=weather_code',
    'latitude=47.6&longitude=-181.0&current=weather_code',
    'latitude=47.6&longitude=-122.3',
    'latitude=47.6&longitude=-122.3&current=weather_code,apparent_temperature',
    'latitude=47.6&longitude=-122.3&current=',
    'latitude=47.6&longitude=-122.3&current=weather_code&apikey=x',
    'latitude=47.6&longitude=-122.3&current=weather_code&current=is_day',
    'latitude=47.6&longitude=-122.3&current=weather_code&past_hours=49',
    'latitude=47.6&longitude=-122.3&current=weather_code&past_hours=-1',
    'latitude=47.6&longitude=-122.3&current=weather_code&wind_speed_unit=kmh',
    'latitude=47.6&longitude=-122.3&current=weather_code&timeformat=iso8601',
    'latitude=47.6&longitude=-122.3&current=weather_code&forceFunctionRegion=eu-central-1',
  ];
  for (const q of bad) assertEquals(upstreamUrl(new URLSearchParams(q)), null, q);
});

Deno.test('a signed-in POST is relayed and the body comes back as it came', async () => {
  const d = deps();
  const res = await handleWeather(call(HOME_QUERY), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { current: { time: 1 } });
  assertEquals(d.calls.length, 1);
  assertEquals(sorted(d.calls[0].slice(OPEN_METEO_FORECAST.length + 1)), sorted(HOME_QUERY));
  assert(res.headers.get('x-request-id'));
});

Deno.test('no token or a refused one is a 401 and never reaches Open-Meteo', async () => {
  const d = deps();
  assertEquals((await handleWeather(call(HOME_QUERY, null), d)).status, 401);
  assertEquals((await handleWeather(call(HOME_QUERY, 'bad'), d)).status, 401);
  assertEquals(d.calls, []);
});

Deno.test('Auth out of reach is a 503 to retry', async () => {
  const res = await handleWeather(call(HOME_QUERY), deps({ verifyJwt: () => Promise.reject(new Error('down')) }));
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('retry-after'), '2');
});

Deno.test('anything but POST is a 405; a bad query or body a 400 without a request', async () => {
  const d = deps();
  const getRes = await handleWeather(call(HOME_QUERY, GOOD, 'GET'), d);
  assertEquals(getRes.status, 405);
  assertEquals(getRes.headers.get('allow'), 'POST');
  assertEquals((await handleWeather(call('latitude=47.61&longitude=-122.3&current=weather_code'), d)).status, 400);
  const raw = (body: string) =>
    new Request('https://x.supabase.co/functions/v1/weather', { method: 'POST', headers: { authorization: `Bearer ${GOOD}` }, body });
  for (const body of ['not json', '{}', '{"query":5}', 'null']) assertEquals((await handleWeather(raw(body), d)).status, 400, body);
  assertEquals(d.calls, []);
});

Deno.test('Open-Meteo refusing for too many requests is a 429 with its Retry-After', async () => {
  const res = await handleWeather(
    call(SERIES_QUERY),
    deps({ fetch: () => Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '60' } })) })
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), '60');
  await res.body?.cancel();
});

Deno.test('an Open-Meteo error, a malformed or oversized body or a dropped connection is a 502', async () => {
  for (const fetch of [
    () => Promise.resolve(new Response('oops', { status: 503 })),
    () => Promise.resolve(new Response('<html>', { status: 200 })),
    () => Promise.resolve(new Response('{}', { status: 200, headers: { 'content-length': '2000000' } })),
    () => Promise.reject(new TypeError('connection reset')),
  ]) {
    const res = await handleWeather(call(HOME_QUERY), deps({ fetch }));
    assertEquals(res.status, 502);
    await res.body?.cancel();
  }
});

Deno.test('a slow Open-Meteo is a 504 after the time-out', async () => {
  const res = await handleWeather(
    call(HOME_QUERY),
    deps({
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    })
  );
  assertEquals(res.status, 504);
  await res.body?.cancel();
});
