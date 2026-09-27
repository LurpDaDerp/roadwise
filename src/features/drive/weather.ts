import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { useDrive } from '@/drive/useDrive';

/**
 * The HUD's one weather source: Open-Meteo's current conditions, reduced to at most one hazard
 * worth a driver's glance. Fetched only while the HUD is on screen and the drive records — once
 * on mount, then every 15 min, and again after 20 km of the trip's own odometer — and never any
 * faster. Everything fails silently: no position, no network, a slow answer, a malformed body all
 * mean "no hazard", never words on the HUD (SR9).
 */

export type WeatherHazard =
  | 'thunderstorm'
  | 'icy_rain'
  | 'heavy_snow'
  | 'dense_fog'
  | 'heavy_rain'
  | 'strong_wind';

/** The `current` block of an Open-Meteo forecast answer, the three fields the HUD reads. */
export interface OpenMeteoCurrent {
  /** WMO weather interpretation code. */
  weather_code?: number | null;
  /** km/h (`wind_speed_unit=kmh`). */
  wind_gusts_10m?: number | null;
  /** metres. */
  visibility?: number | null;
}

export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_REFETCH_DISTANCE_M = 20_000;
export const WEATHER_TIMEOUT_MS = 5_000;
export const WIND_GUST_HAZARD_KMH = 70;
export const FOG_VISIBILITY_M = 200;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;

/** The `current=` variables, as the Open-Meteo docs list them. */
export const WEATHER_CURRENT_VARS = 'weather_code,wind_gusts_10m,visibility';

const THUNDERSTORM = new Set([95, 96, 99]);
const FREEZING = new Set([56, 57, 66, 67]);
const HEAVY_SNOW = new Set([75, 86]);
const FOG = new Set([45, 48]);
const VIOLENT_RAIN = new Set([65, 82]);

const num = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * At most one hazard, the most dangerous first: thunderstorm, freezing rain or drizzle, heavy
 * snow, dense fog (by code or by sight line), violent rain, then high gusts. Anything else — an
 * ordinary shower, a breeze, a clear sky — is no hazard at all.
 */
export function weatherHazardOf(c: OpenMeteoCurrent): WeatherHazard | null {
  const code = num(c.weather_code);
  if (code !== null && THUNDERSTORM.has(code)) return 'thunderstorm';
  if (code !== null && FREEZING.has(code)) return 'icy_rain';
  if (code !== null && HEAVY_SNOW.has(code)) return 'heavy_snow';
  const visibility = num(c.visibility);
  if ((code !== null && FOG.has(code)) || (visibility !== null && visibility < FOG_VISIBILITY_M)) {
    return 'dense_fog';
  }
  if (code !== null && VIOLENT_RAIN.has(code)) return 'heavy_rain';
  const gust = num(c.wind_gusts_10m);
  if (gust !== null && gust >= WIND_GUST_HAZARD_KMH) return 'strong_wind';
  return null;
}

/**
 * The request. The position is rounded to one decimal (about 10 km): enough for a weather
 * hazard, and too coarse to say where the driver is.
 */
export function openMeteoUrl(latitude: number, longitude: number): string {
  const lat = encodeURIComponent(latitude.toFixed(1));
  const lng = encodeURIComponent(longitude.toFixed(1));
  return (
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lng}&current=${WEATHER_CURRENT_VARS}` +
    '&wind_speed_unit=kmh&timezone=auto'
  );
}

/** What the fetch needs of `fetch` (the global satisfies it; tests pass a stand-in). */
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
    const res = await doFetch(openMeteoUrl(latitude, longitude), { signal: control.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { current?: OpenMeteoCurrent } | null;
    const current = body?.current;
    return current && typeof current === 'object' ? weatherHazardOf(current) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hazard to show, or null. `active` is "the HUD is up and the drive records": off, nothing
 * runs and nothing shows. The position is the OS's cached fix (no GPS started, no battery beyond
 * the drive's own capture); with none cached there is no fetch.
 */
export function useWeatherHazard(active: boolean): WeatherHazard | null {
  const [hazard, setHazard] = useState<WeatherHazard | null>(null);
  // Every 20 km of the trip's own odometer: a free signal, so the car crossing into other
  // weather is noticed without a position read of its own.
  const leg = useDrive((s) => Math.floor(s.distanceM / WEATHER_REFETCH_DISTANCE_M));

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
