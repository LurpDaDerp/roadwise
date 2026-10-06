import { act, renderHook } from '@testing-library/react-native';

import {
  alertHazard,
  fetchWeatherHazard,
  NWS_USER_AGENT,
  nwsAlertsUrl,
  useWeatherHazard,
  WEATHER_LABELS,
  WEATHER_REFETCH_DISTANCE_M,
  WEATHER_REFRESH_MS,
  WEATHER_TIMEOUT_MS,
  weatherHazardOf,
  type NwsAlertProperties,
} from '../weather';

const mockLastKnown = jest.fn();
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: (...args: unknown[]) => mockLastKnown(...args),
}));

const alert = (event: string, severity = 'Severe', extra: Partial<NwsAlertProperties> = {}): NwsAlertProperties => ({
  event,
  severity,
  status: 'Actual',
  messageType: 'Alert',
  ...extra,
});

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const featuresOf = (...alerts: NwsAlertProperties[]) => ({
  type: 'FeatureCollection',
  features: alerts.map((properties) => ({ type: 'Feature', properties })),
});

describe('alertHazard — only live, severe, driving-relevant alerts', () => {
  test.each([
    ['Tornado Warning', 'tornado'],
    ['Blizzard Warning', 'blizzard'],
    ['Ice Storm Warning', 'ice_storm'],
    ['Winter Storm Warning', 'winter_storm'],
    ['Flash Flood Warning', 'flash_flood'],
    ['Flood Warning', 'flood'],
    ['High Wind Warning', 'high_wind'],
    ['Severe Thunderstorm Warning', 'thunderstorm'],
    ['Snow Squall Warning', 'snow_squall'],
  ] as const)('%s → %s', (event, hazard) => {
    expect(alertHazard(alert(event))).toBe(hazard);
    expect(alertHazard(alert(event, 'Extreme'))).toBe(hazard);
  });

  test('fog and freezing rain advisories count at any severity', () => {
    expect(alertHazard(alert('Dense Fog Advisory', 'Minor'))).toBe('dense_fog');
    expect(alertHazard(alert('Freezing Fog Advisory', 'Moderate'))).toBe('dense_fog');
    expect(alertHazard(alert('Freezing Rain Advisory', 'Moderate'))).toBe('freezing_rain');
  });

  test('a driving warning rated below Severe is ignored', () => {
    expect(alertHazard(alert('Flood Warning', 'Moderate'))).toBeNull();
    expect(alertHazard(alert('Winter Storm Warning', 'Unknown'))).toBeNull();
  });

  test('events that do not change the drive are ignored', () => {
    expect(alertHazard(alert('Heat Advisory'))).toBeNull();
    expect(alertHazard(alert('Excessive Heat Warning', 'Extreme'))).toBeNull();
    expect(alertHazard(alert('Air Quality Alert'))).toBeNull();
    expect(alertHazard(alert('Red Flag Warning'))).toBeNull();
  });

  test('tests, exercises and cancellations are ignored', () => {
    expect(alertHazard(alert('Tornado Warning', 'Extreme', { status: 'Test' }))).toBeNull();
    expect(alertHazard(alert('Tornado Warning', 'Extreme', { status: 'Exercise' }))).toBeNull();
    expect(alertHazard(alert('Tornado Warning', 'Extreme', { messageType: 'Cancel' }))).toBeNull();
    expect(alertHazard(alert('Tornado Warning', 'Extreme', { messageType: 'Update' }))).toBe('tornado');
  });

  test('a malformed alert is no hazard', () => {
    expect(alertHazard({})).toBeNull();
    expect(alertHazard({ event: 42 as unknown as string, severity: null, status: 'Actual' })).toBeNull();
  });
});

describe('weatherHazardOf — at most one hazard, the most dangerous first', () => {
  test('several alerts: the worst wins whatever the order', () => {
    expect(
      weatherHazardOf([alert('Dense Fog Advisory', 'Minor'), alert('Tornado Warning'), alert('High Wind Warning')])
    ).toBe('tornado');
    expect(weatherHazardOf([alert('Freezing Rain Advisory', 'Moderate'), alert('Ice Storm Warning')])).toBe(
      'ice_storm'
    );
  });

  test('no alerts, or none that count, is no hazard', () => {
    expect(weatherHazardOf([])).toBeNull();
    expect(weatherHazardOf([alert('Heat Advisory'), alert('Flood Warning', 'Minor')])).toBeNull();
  });
});

test('every banner is three words at most', () => {
  for (const label of Object.values(WEATHER_LABELS)) {
    expect(label.split(' ').length).toBeLessThanOrEqual(3);
  }
  expect(WEATHER_LABELS.ice_storm).toBe('Ice warning');
});

test('the request asks api.weather.gov for active alerts at a ~10 km position', () => {
  const url = nwsAlertsUrl(47.60621, -122.33207);
  expect(url).toBe(`https://api.weather.gov/alerts/active?point=${encodeURIComponent('47.6,-122.3')}`);
});

describe('fetchWeatherHazard — never throws', () => {
  test('identifies itself and parses the alert features', async () => {
    const fetch = jest.fn(async () => okJson(featuresOf(alert('Blizzard Warning'))));
    await expect(fetchWeatherHazard(44.98, -93.27, { fetch })).resolves.toBe('blizzard');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.weather.gov/alerts/active?point=');
    expect(init.headers).toEqual({ 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' });
    expect(NWS_USER_AGENT).toMatch(/^RoadWise \(.+\)$/);
  });

  test('an HTTP error (e.g. outside the US), a bad body or a network error is no hazard', async () => {
    await expect(
      fetchWeatherHazard(51.5, -0.1, { fetch: async () => ({ ok: false }) as Response })
    ).resolves.toBeNull();
    await expect(fetchWeatherHazard(40, -100, { fetch: async () => okJson(null) })).resolves.toBeNull();
    await expect(fetchWeatherHazard(40, -100, { fetch: async () => okJson({ features: 'x' }) })).resolves.toBeNull();
    await expect(
      fetchWeatherHazard(40, -100, { fetch: async () => okJson({ features: [null, 3, { properties: null }] }) })
    ).resolves.toBeNull();
    await expect(
      fetchWeatherHazard(40, -100, {
        fetch: async () => {
          throw new Error('offline');
        },
      })
    ).resolves.toBeNull();
  });

  test('a slow answer is aborted after the timeout', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const pending = fetchWeatherHazard(40, -100, { fetch });
      jest.advanceTimersByTime(WEATHER_TIMEOUT_MS);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('useWeatherHazard — on mount, then every 15 min or 20 km, only while recording', () => {
  const realFetch = globalThis.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLastKnown.mockReset().mockResolvedValue({ coords: { latitude: 39.74, longitude: -104.99 } });
    mockFetch = jest.fn(async () => okJson(featuresOf(alert('Winter Storm Warning'))));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  const flush = () => act(async () => {});

  test('not recording: no request, no hazard', async () => {
    const { result } = await renderHook(() => useWeatherHazard(false, 0));
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test('fetches on mount, after 15 min and after 20 km — not faster', async () => {
    const { result, rerender } = await renderHook(({ d }: { d: number }) => useWeatherHazard(true, d), {
      initialProps: { d: 0 },
    });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('winter_storm');

    await rerender({ d: WEATHER_REFETCH_DISTANCE_M - 1 });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(WEATHER_REFRESH_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await rerender({ d: WEATHER_REFETCH_DISTANCE_M });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('no last known position: no request, no hazard', async () => {
    mockLastKnown.mockResolvedValue(null);
    const { result } = await renderHook(() => useWeatherHazard(true, 0));
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
