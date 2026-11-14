import { assert, assertEquals } from '@std/assert';
import { createWeatherDb, handleWeather, MAX_CALL_COST, OPEN_METEO_LIMITS, RATE_LIMITS, OPEN_METEO_FORECAST, upstreamUrl, type WeatherDeps } from './handler.ts';

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
    db: { takeRateLimit: () => Promise.resolve(true), takeGlobalRateLimit: () => Promise.resolve(true) },
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

Deno.test('the budgets are pinned', () => {
  assertEquals(RATE_LIMITS, {
    user: { key: 'weather_relay', window: '1 hour', max: 120, retryAfterS: 600 },
    global: [
      { key: 'weather_relay_minute', window: '1 minute', max: 250, retryAfterS: 60 },
      { key: 'weather_relay_hour', window: '1 hour', max: 2000, retryAfterS: 600 },
      { key: 'weather_relay_day', window: '1 day', max: 4500, retryAfterS: 3600 },
    ],
  });
});

Deno.test("the app-wide budgets stay under Open-Meteo's free limits at the dearest query's cost", () => {
  const [minute, hour, day] = RATE_LIMITS.global;
  assert(minute.max * MAX_CALL_COST <= OPEN_METEO_LIMITS.minute);
  assert(hour.max * MAX_CALL_COST <= OPEN_METEO_LIMITS.hour);
  assert(day.max * MAX_CALL_COST <= OPEN_METEO_LIMITS.day);
});

Deno.test('a spent user budget is a 429 that never spends the shared budget or reaches Open-Meteo', async () => {
  const spent: string[] = [];
  const d = deps({
    db: {
      takeRateLimit: (user, key, window, max) => {
        spent.push(`user:${user}:${key}:${window}:${max}`);
        return Promise.resolve(false);
      },
      takeGlobalRateLimit: () => {
        spent.push('global');
        return Promise.resolve(true);
      },
    },
  });
  const res = await handleWeather(call(HOME_QUERY), d);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), '600');
  assertEquals(spent, [`user:${UID}:weather_relay:1 hour:120`]);
  assertEquals(d.calls, []);
  await res.body?.cancel();
});

Deno.test('a spent shared budget is a 429; an unreadable one a 503; neither reaches Open-Meteo', async () => {
  const global = deps({ db: { takeRateLimit: () => Promise.resolve(true), takeGlobalRateLimit: (key) => Promise.resolve(key !== 'weather_relay_day') } });
  const limited = await handleWeather(call(HOME_QUERY), global);
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get('retry-after'), '3600');
  await limited.body?.cancel();
  const broken = deps({ db: { takeRateLimit: () => Promise.reject(new Error('db down')), takeGlobalRateLimit: () => Promise.resolve(true) } });
  const down = await handleWeather(call(HOME_QUERY), broken);
  assertEquals(down.status, 503);
  await down.body?.cancel();
  assertEquals([...global.calls, ...broken.calls], []);
});

Deno.test('the budget rows go through the service-role functions', async () => {
  const rpcs: [string, Record<string, unknown>][] = [];
  const db = createWeatherDb({
    rpc: (fn, args) => {
      rpcs.push([fn, args]);
      return Promise.resolve({ data: true, error: null });
    },
  });
  assertEquals(await db.takeRateLimit(UID, 'weather_relay', '1 hour', 120), true);
  assertEquals(await db.takeGlobalRateLimit('weather_relay_day', '1 day', 4500), true);
  assertEquals(rpcs, [
    ['take_rate_limit', { p_user: UID, p_key: 'weather_relay', p_window: '1 hour', p_max: 120 }],
    ['take_global_rate_limit', { p_key: 'weather_relay_day', p_window: '1 day', p_max: 4500 }],
  ]);
});

Deno.test('a minute burst is refused before it spends the hour and day rows', async () => {
  const taken: string[] = [];
  const d = deps({
    db: {
      takeRateLimit: () => Promise.resolve(true),
      takeGlobalRateLimit: (key) => {
        taken.push(key);
        return Promise.resolve(key !== 'weather_relay_minute');
      },
    },
  });
  const res = await handleWeather(call(HOME_QUERY), d);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), '60');
  assertEquals(taken, ['weather_relay_minute']);
  assertEquals(d.calls, []);
  await res.body?.cancel();
});

Deno.test('a call within every budget spends the user row then the minute, hour and day rows', async () => {
  const taken: string[] = [];
  const d = deps({
    db: {
      takeRateLimit: (_u, key) => {
        taken.push(key);
        return Promise.resolve(true);
      },
      takeGlobalRateLimit: (key) => {
        taken.push(key);
        return Promise.resolve(true);
      },
    },
  });
  const res = await handleWeather(call(HOME_QUERY), d);
  assertEquals(res.status, 200);
  assertEquals(taken, ['weather_relay', 'weather_relay_minute', 'weather_relay_hour', 'weather_relay_day']);
  await res.body?.cancel();
});
