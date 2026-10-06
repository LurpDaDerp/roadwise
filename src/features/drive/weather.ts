import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

/**
 * The driving screen's one weather source: the US National Weather Service's active alerts
 * (api.weather.gov, a free public service), reduced to at most one driving hazard worth a glance
 * (spec "Weather hazards": an active weather alert). Fetched only while the drive records — once
 * on mount, then every 15 min, and again after 20 km of the trip's own odometer — and never any
 * faster. Everything fails silently: no position, no network, outside the US, a slow answer, a
 * malformed body all mean "no hazard".
 */

export type WeatherHazard =
  | 'tornado'
  | 'hurricane'
  | 'flash_flood'
  | 'blizzard'
  | 'snow_squall'
  | 'ice_storm'
  | 'dust_storm'
  | 'tropical_storm'
  | 'thunderstorm'
  | 'winter_storm'
  | 'flood'
  | 'dense_fog'
  | 'freezing_rain'
  | 'high_wind';

/** The fields read from one alert's `properties` (CAP over GeoJSON). */
export interface NwsAlertProperties {
  event?: string | null;
  /** 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'. */
  severity?: string | null;
  /** 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft'. */
  status?: string | null;
  /** 'Alert' | 'Update' | 'Cancel'. */
  messageType?: string | null;
}

export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_REFETCH_DISTANCE_M = 20_000;
export const WEATHER_TIMEOUT_MS = 5_000;
const POSITION_MAX_AGE_MS = 60 * 60_000;

/** api.weather.gov asks every caller to identify itself with a contact. */
export const NWS_USER_AGENT = 'RoadWise (support@roadwise.app)';

/** The one-line banner's words, three at most. */
export const WEATHER_LABELS: Readonly<Record<WeatherHazard, string>> = {
  tornado: 'Tornado warning',
  hurricane: 'Hurricane warning',
  flash_flood: 'Flash flood warning',
  blizzard: 'Blizzard warning',
  snow_squall: 'Snow squall',
  ice_storm: 'Ice warning',
  dust_storm: 'Dust storm',
  tropical_storm: 'Tropical storm',
  thunderstorm: 'Severe storm',
  winter_storm: 'Winter storm',
  flood: 'Flood warning',
  dense_fog: 'Dense fog',
  freezing_rain: 'Freezing rain',
  high_wind: 'High winds',
};

export const weatherLabel = (h: WeatherHazard): string => WEATHER_LABELS[h];

/** The most dangerous to a driver first: when several alerts cover the area, the first wins. */
const HAZARD_ORDER: readonly WeatherHazard[] = [
  'tornado',
  'hurricane',
  'flash_flood',
  'blizzard',
  'snow_squall',
  'ice_storm',
  'dust_storm',
  'tropical_storm',
  'thunderstorm',
  'winter_storm',
  'flood',
  'dense_fog',
  'freezing_rain',
  'high_wind',
];

/** NWS event names (lower case) that matter on the road. Everything else is ignored. */
const EVENTS: Readonly<Record<string, WeatherHazard>> = {
  'tornado warning': 'tornado',
  'hurricane warning': 'hurricane',
  'flash flood warning': 'flash_flood',
  'flash flood emergency': 'flash_flood',
  'blizzard warning': 'blizzard',
  'snow squall warning': 'snow_squall',
  'ice storm warning': 'ice_storm',
  'dust storm warning': 'dust_storm',
  'tropical storm warning': 'tropical_storm',
  'severe thunderstorm warning': 'thunderstorm',
  'winter storm warning': 'winter_storm',
  'flood warning': 'flood',
  'dense fog advisory': 'dense_fog',
  'freezing fog advisory': 'dense_fog',
  'freezing rain advisory': 'freezing_rain',
  'high wind warning': 'high_wind',
  'extreme wind warning': 'high_wind',
};

/** These are advisories, rated below Severe by the NWS, yet still change how a car handles or how far a driver sees. */
const ADVISORIES: ReadonlySet<WeatherHazard> = new Set(['dense_fog', 'freezing_rain']);
const SEVERE = new Set(['severe', 'extreme']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** The hazard one alert stands for, or null when it is not a live, severe, driving-relevant alert. */
export function alertHazard(p: NwsAlertProperties): WeatherHazard | null {
  if (str(p.status) !== 'actual' || str(p.messageType) === 'cancel') return null;
  const hazard = EVENTS[str(p.event)];
  if (hazard === undefined) return null;
  return SEVERE.has(str(p.severity)) || ADVISORIES.has(hazard) ? hazard : null;
}

/** At most one hazard across every alert covering the point, the most dangerous first. */
export function weatherHazardOf(alerts: readonly NwsAlertProperties[]): WeatherHazard | null {
  let best: WeatherHazard | null = null;
  for (const a of alerts) {
    const h = a && typeof a === 'object' ? alertHazard(a) : null;
    if (h !== null && (best === null || HAZARD_ORDER.indexOf(h) < HAZARD_ORDER.indexOf(best))) best = h;
  }
  return best;
}

/**
 * The request. The position is rounded to one decimal (about 10 km): fine enough for an alert
 * zone, too coarse to say where the driver is.
 */
export function nwsAlertsUrl(latitude: number, longitude: number): string {
  const point = encodeURIComponent(`${latitude.toFixed(1)},${longitude.toFixed(1)}`);
  return `https://api.weather.gov/alerts/active?point=${point}`;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One fetch, aborted after `timeoutMs`. Never throws: any failure is "no hazard". */
export async function fetchWeatherHazard(
  latitude: number,
  longitude: number,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<WeatherHazard | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? WEATHER_TIMEOUT_MS);
  try {
    const res = await doFetch(nwsAlertsUrl(latitude, longitude), {
      signal: control.signal,
      headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { features?: unknown } | null;
    const features = Array.isArray(body?.features) ? (body.features as unknown[]) : [];
    const alerts = features.map((f) =>
      f && typeof f === 'object' ? ((f as { properties?: NwsAlertProperties }).properties ?? {}) : {}
    );
    return weatherHazardOf(alerts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hazard to show, or null. `active`: the drive records. `distanceM`: the trip's odometer, so
 * the car crossing into other weather is noticed without a position read of its own.
 */
export function useWeatherHazard(active: boolean, distanceM: number): WeatherHazard | null {
  const [hazard, setHazard] = useState<WeatherHazard | null>(null);
  const leg = Math.floor(distanceM / WEATHER_REFETCH_DISTANCE_M);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = async () => {
      let next: WeatherHazard | null = null;
      try {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
        if (pos) next = await fetchWeatherHazard(pos.coords.latitude, pos.coords.longitude);
      } catch {
        next = null;
      }
      if (live) setHazard(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), WEATHER_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, leg]);

  return active ? hazard : null;
}
