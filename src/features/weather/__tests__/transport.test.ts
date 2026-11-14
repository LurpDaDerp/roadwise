import { openMeteoUrl } from '@/ui/sky/weather';

import { forecastUrl } from '../forecast';
import { fetchWeather, weatherUrl } from '../openMeteo';
import { fetchRoadSeries, roadSeriesUrl } from '../roadSeries';
import { DIRECT_TIMEOUT_MS, edgeFallback, FALLBACK_TIMEOUT_MS, requestOpenMeteo, type FetchLike, type OpenMeteoFallback } from '../transport';
import { okJson, openMeteoBody } from '../__fixtures__/openMeteo';

const mockClient = {
  auth: { getSession: jest.fn() },
  functions: { invoke: jest.fn() },
};
jest.mock('@/data/supabase/client', () => ({ supabase: mockClient }));

const URL_ = 'https://api.open-meteo.com/v1/forecast?latitude=47.6&longitude=-122.3&current=weather_code';
const QUERY = 'latitude=47.6&longitude=-122.3&current=weather_code';

const status = (code: number, headers: Record<string, string> = {}): Response =>
  ({ ok: code >= 200 && code < 300, status: code, headers: new Headers(headers), json: async () => ({}) }) as Response;

describe('requestOpenMeteo', () => {
  test('a direct answer is the answer: no fallback for a 2xx, a 429 or another 4xx', async () => {
    for (const code of [200, 429, 400]) {
      const direct = status(code);
      const fallback = jest.fn<ReturnType<OpenMeteoFallback>, Parameters<OpenMeteoFallback>>(async () => status(200));
      expect(await requestOpenMeteo(URL_, { fetch: async () => direct, fallback })).toBe(direct);
      expect(fallback).not.toHaveBeenCalled();
    }
  });

  test('a dropped connection asks the fallback with the same query and its own time-out', async () => {
    const answer = status(200);
    const fallback = jest.fn<ReturnType<OpenMeteoFallback>, Parameters<OpenMeteoFallback>>(async () => answer);
    const res = await requestOpenMeteo(URL_, {
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
      fallback,
    });
    expect(res).toBe(answer);
    expect(fallback.mock.calls).toEqual([[QUERY, FALLBACK_TIMEOUT_MS]]);
  });

  test('a 5xx asks the fallback; when that fails too, the 5xx is what comes back', async () => {
    const down = status(503);
    expect(await requestOpenMeteo(URL_, { fetch: async () => down, fallback: async () => status(200) })).not.toBe(down);
    expect(await requestOpenMeteo(URL_, { fetch: async () => down, fallback: async () => null })).toBe(down);
    expect(
      await requestOpenMeteo(URL_, {
        fetch: async () => down,
        fallback: async () => {
          throw new Error('boom');
        },
      })
    ).toBe(down);
  });

  test('a direct request with no answer is abandoned after its time-out, then the fallback is asked', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const hang: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          })
        );
      const answer = status(200);
      const pending = requestOpenMeteo(URL_, { fetch: hang, fallback: async () => answer });
      await jest.advanceTimersByTimeAsync(DIRECT_TIMEOUT_MS);
      expect(aborted).toBe(true);
      expect(await pending).toBe(answer);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a fallback that never settles is abandoned after its own time-out', async () => {
    jest.useFakeTimers();
    try {
      const down = status(503);
      const pending = requestOpenMeteo(URL_, { fetch: async () => down, fallback: () => new Promise<Response | null>(() => {}) });
      await jest.advanceTimersByTimeAsync(FALLBACK_TIMEOUT_MS);
      expect(await pending).toBe(down);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a fallback that throws at once is no answer, never a throw', async () => {
    const down = status(503);
    const fallback: OpenMeteoFallback = () => {
      throw new Error('boom');
    };
    expect(await requestOpenMeteo(URL_, { fetch: async () => down, fallback })).toBe(down);
  });

  test('an injected fetch is the whole transport: no fallback unless one is injected', async () => {
    const res = await requestOpenMeteo(URL_, {
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(res).toBeNull();
  });
});

describe('the callers read a fallback answer as they read a direct one', () => {
  const reset: FetchLike = async () => {
    throw new TypeError('Network request failed');
  };

  test('the weather now', async () => {
    const reading = await fetchWeather(47.6, -122.3, { fetch: reset, fallback: async () => okJson(openMeteoBody()) });
    expect(reading?.samples[0]?.tempC).toEqual(expect.any(Number));
  });

  test("the drive's series keeps a fallback 429 a 429", async () => {
    const r = await fetchRoadSeries(47.6, -122.3, { fetch: reset, now: () => 0, fallback: async () => status(429, { 'Retry-After': '30' }) });
    expect(r).toEqual({ kind: 'limited', retryAfterMs: 30_000 });
  });
});

describe('edgeFallback', () => {
  beforeEach(() => {
    mockClient.auth.getSession.mockReset();
    mockClient.functions.invoke.mockReset();
  });

  test('signed out, the function is not called', async () => {
    mockClient.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await edgeFallback(QUERY, FALLBACK_TIMEOUT_MS)).toBeNull();
    expect(mockClient.functions.invoke).not.toHaveBeenCalled();
  });

  test('signed in, the query goes in a POST body to the European region, and the answer comes back as a 200', async () => {
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    mockClient.functions.invoke.mockResolvedValue({ data: { current: { time: 1 } }, error: null });
    const res = await edgeFallback(QUERY, FALLBACK_TIMEOUT_MS);
    expect(mockClient.functions.invoke).toHaveBeenCalledWith('weather', {
      method: 'POST',
      body: { query: QUERY },
      region: 'eu-central-1',
      timeout: FALLBACK_TIMEOUT_MS,
    });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ current: { time: 1 } });
  });

  test("a non-2xx is the function's own response; a call that never reached it is null", async () => {
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    const limited = status(429, { 'Retry-After': '30' });
    mockClient.functions.invoke.mockResolvedValueOnce({ data: null, error: { context: limited } });
    expect(await edgeFallback(QUERY, FALLBACK_TIMEOUT_MS)).toBe(limited);
    mockClient.functions.invoke.mockResolvedValueOnce({ data: null, error: { context: new TypeError('Network request failed') } });
    expect(await edgeFallback(QUERY, FALLBACK_TIMEOUT_MS)).toBeNull();
  });
});

describe("the relay's allowed queries are the app's own", () => {
  // supabase/functions/weather relays only these shapes; a URL builder that drifts from them would
  // lose its fallback, so it fails here first.
  const { APP_QUERIES, APP_QUERY_PLACE } = jest.requireActual<typeof import('../../../../supabase/functions/weather/app_queries')>(
    '../../../../supabase/functions/weather/app_queries'
  );
  const lat = Number(APP_QUERY_PLACE.latitude);
  const lng = Number(APP_QUERY_PLACE.longitude);
  const queryOf = (url: string) => url.slice(url.indexOf('?') + 1);

  test.each([
    ['sky', () => openMeteoUrl(lat, lng)],
    ['home', () => weatherUrl(lat, lng)],
    ['series', () => roadSeriesUrl(lat, lng)],
    ['forecast', () => forecastUrl(lat, lng)],
  ] as const)('%s', (name, build) => {
    expect(queryOf(build())).toBe(APP_QUERIES[name]);
  });
});
