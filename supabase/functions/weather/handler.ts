// The phone's second way to Open-Meteo. The phone asks api.open-meteo.com itself first; only when
// that fails (a dropped connection, a time-out, a 5xx) does it ask here, and this function asks
// Open-Meteo from the server's network instead. The phone calls it in a European region, where
// Open-Meteo's geo DNS hands out a different server than the one a phone in North America is given,
// so a regional outage of Open-Meteo's own servers (or a broken route to one) does not blank the
// weather.
//
//   * Signed-in callers only (the bearer token, checked with Auth), so this is no open proxy, and
//     each within a per-user budget and app-wide ones under Open-Meteo's free limits (`RATE_LIMITS`).
//   * A POST whose JSON body carries the query (`{ "query": "latitude=47.6&longitude=-122.3&…" }`):
//     the position is never part of the request's URL, which the platform's request logs keep.
//   * Only `/v1/forecast` and only the parameters the app sends, each checked: a position with one
//     decimal (the phone rounds to about 10 km before anything leaves it, and this refuses anything
//     finer), the app's variable names, small hour and quarter-hour counts, mph and unix time.
//     Anything else is a 400 and never reaches Open-Meteo.
//   * Open-Meteo's answer is passed through as it came: a 200's body, and a 429 with its
//     Retry-After. Any other failure is a 502 (or a 504 after the time-out); the phone reads every
//     one of those as "no weather", as it reads its own failed request.
//   * Nothing about the position is logged: only the outcome and Open-Meteo's status.
import { bearerToken, json, readJsonBody, requestId, requirePost, withRequestId } from '../_shared/http.ts';

export const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
/** Open-Meteo's answer is abandoned after this long (the phone gives the whole call 8 s). */
export const UPSTREAM_TIMEOUT_MS = 6_000;
/** An Open-Meteo answer larger than this is refused (the app's largest is about 60 KB). */
export const MAX_BODY_BYTES = 1_000_000;
/** The request body: the app's longest query is about 400 characters. */
export const MAX_REQUEST_BYTES = 2_048;

/** Every variable the app asks for (WEATHER_VARS in src/features/weather/openMeteo.ts, and the sky's). */
export const VARIABLES: ReadonlySet<string> = new Set([
  'weather_code',
  'temperature_2m',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'wind_speed_10m',
  'wind_gusts_10m',
  'visibility',
  'is_day',
  'cloud_cover',
]);

const LIST_PARAMS = ['current', 'hourly', 'minutely_15'] as const;
/** The largest count each range parameter may ask for. */
const COUNT_PARAMS: Readonly<Record<string, number>> = {
  past_hours: 48,
  forecast_hours: 48,
  past_minutely_15: 192,
  forecast_minutely_15: 192,
};
const FIXED_PARAMS: Readonly<Record<string, string>> = { wind_speed_unit: 'mph', timeformat: 'unixtime' };

/** A coordinate with exactly one decimal inside `limit`, or null. */
function coord(raw: string | null, limit: number): string | null {
  if (raw === null || !/^-?\d{1,3}\.\d$/.test(raw)) return null;
  const v = Number(raw);
  return Number.isFinite(v) && Math.abs(v) <= limit ? raw : null;
}

/**
 * The Open-Meteo URL for a query the app would send, or null when anything in it is not: an
 * unknown or repeated parameter, a finer position, an unknown variable, a count out of range.
 */
export function upstreamUrl(search: URLSearchParams): string | null {
  const seen = new Set<string>();
  for (const key of search.keys()) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const lat = coord(search.get('latitude'), 90);
  const lng = coord(search.get('longitude'), 180);
  if (lat === null || lng === null) return null;
  const out = new URLSearchParams({ latitude: lat, longitude: lng });
  const known = new Set(['latitude', 'longitude']);
  let lists = 0;
  for (const name of LIST_PARAMS) {
    const raw = search.get(name);
    known.add(name);
    if (raw === null) continue;
    const vars = raw.split(',');
    if (vars.length === 0 || vars.length > VARIABLES.size || vars.some((v) => !VARIABLES.has(v))) return null;
    out.set(name, vars.join(','));
    lists += 1;
  }
  if (lists === 0) return null;
  for (const [name, max] of Object.entries(COUNT_PARAMS)) {
    const raw = search.get(name);
    known.add(name);
    if (raw === null) continue;
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > max) return null;
    out.set(name, String(Number(raw)));
  }
  for (const [name, value] of Object.entries(FIXED_PARAMS)) {
    const raw = search.get(name);
    known.add(name);
    if (raw === null) continue;
    if (raw !== value) return null;
    out.set(name, value);
  }
  for (const key of seen) if (!known.has(key)) return null;
  // URLSearchParams would write the commas as %2C; Open-Meteo reads either, but plain is what the phone sends.
  return `${OPEN_METEO_FORECAST}?${out.toString().replaceAll('%2C', ',')}`;
}

export interface WeatherLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * The relay's budgets, so a signed-in account can't spend Open-Meteo's free allowance for every
 * driver (the requests all leave from the platform's addresses). Honest use is far below the
 * per-user line: the phone asks here only when its own request failed, Home at most every 15 min,
 * the sky every 30 min, a drive about once per 10 km cell or 30 min, the commute heads-up a few
 * times a day. The app-wide lines keep the relay under Open-Meteo's free limits per address (600
 * a minute, 5,000 an hour, 10,000 a day, counted in its cost units) even if every call cost the
 * most any app query costs (`MAX_CALL_COST`: Home's and the drive's 20-variable queries; the sky's
 * and the forecast's cost 1). A spent budget is a 429, which the phone reads as "no weather";
 * handler.test.ts pins the values.
 */
export const MAX_CALL_COST = 2;
export const OPEN_METEO_LIMITS = { minute: 600, hour: 5000, day: 10000 } as const;
export const RATE_LIMITS = {
  user: { key: 'weather_relay', window: '1 hour', max: 120, retryAfterS: 600 },
  global: [
    { key: 'weather_relay_minute', window: '1 minute', max: 250, retryAfterS: 60 },
    { key: 'weather_relay_hour', window: '1 hour', max: 2000, retryAfterS: 600 },
    { key: 'weather_relay_day', window: '1 day', max: 4500, retryAfterS: 3600 },
  ],
} as const;

/** The budget rows (`take_rate_limit`, `take_global_rate_limit`, service role only). */
export interface WeatherDb {
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  takeGlobalRateLimit(key: string, window: string, max: number): Promise<boolean>;
}

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export function createWeatherDb(client: RpcClient): WeatherDb {
  const call = async (fn: string, args: Record<string, unknown>): Promise<boolean> => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw error instanceof Error ? error : new Error(`${fn} failed`);
    return data === true;
  };
  return {
    takeRateLimit: (userId, key, window, max) => call('take_rate_limit', { p_user: userId, p_key: key, p_window: window, p_max: max }),
    takeGlobalRateLimit: (key, window, max) => call('take_global_rate_limit', { p_key: key, p_window: window, p_max: max }),
  };
}

export interface WeatherDeps {
  verifyJwt(token: string): Promise<string | null>;
  db: WeatherDb;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: WeatherLogger;
  timeoutMs?: number;
}

export async function handleWeather(req: Request, deps: WeatherDeps): Promise<Response> {
  const log = deps.log ?? console;
  const id = requestId();
  const finish = (res: Response, outcome: string, upstream: number | null = null): Response => {
    log.info('weather', { requestId: id, outcome, upstream });
    return withRequestId(res, id);
  };

  const wrongMethod = requirePost(req);
  if (wrongMethod) return finish(wrongMethod, 'method_not_allowed');

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyJwt(token);
    } catch (err) {
      log.error('weather token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return finish(json(503, { code: 'retry' }, { 'retry-after': '2' }), 'auth_unavailable');
    }
  }
  if (!userId) return finish(json(401, { code: 'unauthorized' }), 'unauthorized');

  const body = await readJsonBody(req, MAX_REQUEST_BYTES);
  if (!body.ok) return finish(body.response, 'bad_request');
  const query = (body.body as { query?: unknown } | null)?.query;
  const target = typeof query === 'string' ? upstreamUrl(new URLSearchParams(query)) : null;
  if (target === null) return finish(json(400, { code: 'bad_request' }), 'bad_request');

  // The user's budget first (a spent one never touches the shared row), then everyone's.
  const { user, global } = RATE_LIMITS;
  try {
    if (!(await deps.db.takeRateLimit(userId, user.key, user.window, user.max))) {
      return finish(json(429, { code: 'too_many_requests' }, { 'retry-after': String(user.retryAfterS) }), 'rate_limited');
    }
    // Shortest window first: a burst is refused before it spends the hour's and the day's rows.
    for (const g of global) {
      if (!(await deps.db.takeGlobalRateLimit(g.key, g.window, g.max))) {
        return finish(json(429, { code: 'too_many_requests' }, { 'retry-after': String(g.retryAfterS) }), 'global_rate_limited');
      }
    }
  } catch (err) {
    log.error('weather rate limit failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
    return finish(json(503, { code: 'retry' }, { 'retry-after': '30' }), 'rate_limit_unavailable');
  }

  const doFetch = deps.fetch ?? fetch;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  try {
    const res = await doFetch(target, { signal: control.signal, headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      const retry = res.headers.get('retry-after');
      return finish(json(429, { code: 'limited' }, retry ? { 'retry-after': retry } : {}), 'limited', 429);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return finish(json(502, { code: 'upstream' }), 'upstream_error', res.status);
    }
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      return finish(json(502, { code: 'upstream' }), 'upstream_too_large', res.status);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return finish(json(502, { code: 'upstream' }), 'upstream_too_large', res.status);
    try {
      JSON.parse(text);
    } catch {
      return finish(json(502, { code: 'upstream' }), 'upstream_malformed', res.status);
    }
    return finish(new Response(text, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), 'ok', 200);
  } catch (err) {
    const timedOut = control.signal.aborted;
    log.warn('weather upstream failed', { requestId: id, timedOut, error: err instanceof Error ? err.name : 'unknown' });
    return finish(json(timedOut ? 504 : 502, { code: 'upstream' }), timedOut ? 'upstream_timeout' : 'upstream_unreachable');
  } finally {
    clearTimeout(timer);
  }
}
