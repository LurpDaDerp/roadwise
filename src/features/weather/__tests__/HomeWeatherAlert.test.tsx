import { act, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';

import { draw, press } from '@/features/drives/__fixtures__/drives';
import { publishUnits } from '@/data/queries/units';
import { tokens } from '@/ui/tokens';

import { okJson, openMeteoBody } from '../__fixtures__/openMeteo';
import type { DangerKind } from '../danger';
import { HomeWeatherAlert } from '../HomeWeatherAlert';
import { HOME_WEATHER_REFRESH_MS, useWeatherAlert, WEATHER_DISMISSED_KEY, type DismissStore, type WeatherPorts } from '../useWeatherAlert';

// Focus runs its effect on mount (and again whenever the callback changes), as on a real focus;
// `mockFocus.blur()` runs its cleanup, as another screen coming to the front does.
const mockFocus = { blur: () => {} };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (fn: () => void | (() => void)) =>
      useEffect(() => {
        const cleanup = fn();
        mockFocus.blur = () => {
          if (typeof cleanup === 'function') cleanup();
        };
        return cleanup;
      }, [fn]),
  };
});

// The local settings table, as the default dismissal store and the units read it.
const mockSettings = new Map<string, string>();
let mockWithDb = false;
const mockDb = {
  execute: jest.fn(async (sql: string, params: unknown[]) => {
    const key = params[0] as string;
    if (sql.startsWith('SELECT')) return { rows: mockSettings.has(key) ? [{ value_json: mockSettings.get(key) }] : [], changes: 0 };
    if (sql.startsWith('INSERT')) mockSettings.set(key, params[1] as string);
    if (sql.startsWith('DELETE')) mockSettings.delete(key);
    return { rows: [], changes: 1 };
  }),
};
jest.mock('@/data/queries/context', () => ({ useOptionalDb: () => (mockWithDb ? mockDb : null) }));

const FOG = { current: { weather_code: 45, visibility: 180 } };
const GUSTS = { current: { wind_gusts_10m: 52 } };
const CALM = {};

let clock = 1_790_000_000_000;
let body: Parameters<typeof openMeteoBody>[0] | 'fail' = CALM;
const mockFetch = jest.fn(async () => (body === 'fail' ? ({ ok: false } as Response) : okJson(openMeteoBody(body))));
let place: { lat: number; lng: number } | null = { lat: 47.61, lng: -122.33 };
const ports: WeatherPorts = { position: async () => place, fetch: mockFetch, now: () => clock };

function memoryStore(start: DangerKind | null = null): DismissStore & { kind: DangerKind | null } {
  const s = {
    kind: start,
    read: async () => s.kind,
    write: async (k: DangerKind | null) => {
      s.kind = k;
    },
  };
  return s;
}

let appStateListeners: ((s: AppStateStatus) => void)[] = [];
const foreground = async () => {
  await act(async () => {
    for (const l of appStateListeners) l('active');
  });
};

async function show(store?: DismissStore) {
  const r = await draw(<HomeWeatherAlert ports={ports} store={store} />);
  await act(async () => {});
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  clock = 1_790_000_000_000;
  body = CALM;
  place = { lat: 47.61, lng: -122.33 };
  mockWithDb = false;
  mockSettings.clear();
  publishUnits('mi');
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
    appStateListeners.push(fn as (s: AppStateStatus) => void);
    return { remove: () => {} } as never;
  });
});
afterEach(() => jest.restoreAllMocks());

describe('the card', () => {
  test('nothing dangerous: nothing at all', async () => {
    await show();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
  });

  test('dense fog: a yellow-outlined paper card, warning glyph, title, one line and a ✕; spoken as one alert', async () => {
    body = FOG;
    await show();
    const card = screen.getByTestId('home-weather-alert');
    const c = tokens.color.light;
    expect(card).toHaveStyle({ borderColor: c.signal.minor.fill, borderWidth: 2, backgroundColor: c.surface, borderRadius: 28 });
    expect(screen.getByTestId('home-weather-alert-icon', { includeHiddenElements: true })).toHaveStyle({ color: c.signal.minor.text });
    // sizes come from the scale: a touch-size disc around a large glyph
    expect(screen.getByTestId('home-weather-alert-icon', { includeHiddenElements: true })).toHaveStyle({ fontSize: tokens.size.iconLg });
    expect(screen.getByTestId('home-weather-alert-title')).toHaveTextContent('Dense fog');
    expect(screen.getByTestId('home-weather-alert-line')).toHaveTextContent('Visibility 600 ft. Slow down, low beams on.');
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Weather alert. Dense fog. Visibility 600 ft. Slow down, low beams on.');
    expect(screen.getByRole('button', { name: 'Hide weather alert' })).toHaveProp('accessibilityHint', 'Hides it until the weather changes.');
  });

  test('in km: the gusts in km/h', async () => {
    publishUnits('km');
    body = GUSTS;
    await show();
    expect(screen.getByTestId('home-weather-alert-title')).toHaveTextContent('Strong winds');
    expect(screen.getByTestId('home-weather-alert-line')).toHaveTextContent('Gusts to 84 km/h. Keep both hands on the wheel.');
  });

  test('no position (location not allowed or never read): no request, no card', async () => {
    place = null;
    body = FOG;
    await show();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
  });

  test('a failed request is silent', async () => {
    body = 'fail';
    await show();
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
  });

  test('the request carries the position rounded to one decimal', async () => {
    await show();
    expect((mockFetch.mock.calls[0] as unknown as [string])[0]).toContain('latitude=47.6&longitude=-122.3&');
  });
});

describe('asked on focus and on return to the front, at most every 15 min', () => {
  test('once on focus; again from the front only after 15 min', async () => {
    await show();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    clock += HOME_WEATHER_REFRESH_MS - 1;
    await foreground();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    clock += 1;
    await foreground();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a return to the front while Home is not the screen in front (another tab, a drive) asks nothing', async () => {
    await show();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFocus.blur();
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a danger that starts shows on the next ask; one that ends goes', async () => {
    await show();
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
    body = GUSTS;
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(screen.getByTestId('home-weather-alert-title')).toHaveTextContent('Strong winds');
    body = CALM;
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
  });
});

describe('the ✕', () => {
  test('hides the alert and remembers its kind; it stays hidden after a restart while that danger lasts', async () => {
    body = FOG;
    const store = memoryStore();
    const first = await show(store);
    await press(screen.getByTestId('home-weather-alert-dismiss'));
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
    expect(store.kind).toBe('dense_fog');
    await first.unmount();

    await show(store);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
    expect(store.kind).toBe('dense_fog');
  });

  test('a different danger shows at once, and the hidden one is forgotten', async () => {
    body = FOG;
    const store = memoryStore('dense_fog');
    await show(store);
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
    body = { current: { weather_code: 66 } };
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(screen.getByTestId('home-weather-alert-title')).toHaveTextContent('Freezing rain');
    expect(store.kind).toBeNull();
  });

  test('once the danger ends the dismissal is cleared, so the same danger later shows again', async () => {
    body = FOG;
    const store = memoryStore('dense_fog');
    await show(store);
    body = CALM;
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(store.kind).toBeNull();
    body = FOG;
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(screen.getByTestId('home-weather-alert-title')).toHaveTextContent('Dense fog');
  });

  test('a failed ask keeps the dismissal (nothing is known to have ended)', async () => {
    body = 'fail';
    const store = memoryStore('dense_fog');
    await show(store);
    expect(store.kind).toBe('dense_fog');
  });

  test('by default the hidden kind lives in the local settings table', async () => {
    mockWithDb = true;
    body = FOG;
    const first = await show();
    await press(screen.getByTestId('home-weather-alert-dismiss'));
    expect(mockSettings.get(WEATHER_DISMISSED_KEY)).toBe(JSON.stringify('dense_fog'));
    await first.unmount();
    await show();
    expect(screen.queryByTestId('home-weather-alert')).toBeNull();
    body = CALM;
    clock += HOME_WEATHER_REFRESH_MS;
    await foreground();
    expect(mockSettings.has(WEATHER_DISMISSED_KEY)).toBe(false);
  });
});

describe('the weather now for the drive card', () => {
  const Probe = () => {
    const { conditions } = useWeatherAlert(ports, memoryStore());
    return <Text testID="probe">{conditions ? `${conditions.tempF}° F ${conditions.label}` : 'none'}</Text>;
  };

  test('the same reading as the alerts: °F and the sky in words, with no request of its own', async () => {
    body = { current: { weather_code: 2, temperature_2m: 21.7 } };
    await draw(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('probe')).toHaveTextContent('71° F Partly cloudy');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a failed ask leaves it empty', async () => {
    body = 'fail';
    await draw(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});
