import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

/**
 * The driving screen's one weather source: Open-Meteo's current conditions, reduced to at most
 * one hazard worth a driver's glance (spec "Weather hazards"). Fetched only while the drive
 * records — once on mount, then every 15 min, and again after 20 km of the trip's own odometer —
 * and never any faster. Everything fails silently: no position, no network, a slow answer, a
 * malformed body all mean "no hazard".
 */

export type WeatherHazard = 'thunderstorm' | 'icy_rain' | 'heavy_snow' | 'dense_fog' | 'heavy_rain' | 'strong_wind';

/** The `current` block of an Open-Meteo forecast answer, the three fields read. */
export interface OpenMeteoCurrent {
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
const POSITION_MAX_AGE_MS = 60 * 60_000;

export const WEATHER_CURRENT_VARS = 'weather_code,wind_gusts_10m,visibility';

const THUNDERSTORM = new Set([95, 96, 99]);
const FREEZING = new Set([56, 57, 66, 67]);
const HEAVY_SNOW = new Set([75, 86]);
const FOG = new Set([45, 48]);
const VIOLENT_RAIN = new Set([65, 82]);

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The one-line banner's words, two at most. */
export const WEATHER_LABELS: Readonly<Record<WeatherHazard, string>> = {
  thunderstorm: 'Thunderstorm',
  icy_rain: 'Icy rain',
  heavy_snow: 'Heavy snow',
  dense_fog: 'Dense fog',
  heavy_rain: 'Heavy rain',
  strong_wind: 'Strong wind',
};

export const weatherLabel = (h: WeatherHazard): string => WEATHER_LABELS[h];

/** At most one hazard, the most dangerous first. */
export function weatherHazardOf(c: OpenMeteoCurrent): WeatherHazard | null {
  const code = num(c.weather_code);
  if (code !== null && THUNDERSTORM.has(code)) return 'thunderstorm';
  if (code !== null && FREEZING.has(code)) return 'icy_rain';
  if (code !== null && HEAVY_SNOW.has(code)) return 'heavy_snow';
  const visibility = num(c.visibility);
  if ((code !== null && FOG.has(code)) || (visibility !== null && visibility < FOG_VISIBILITY_M)) return 'dense_fog';
  if (code !== null && VIOLENT_RAIN.has(code)) return 'heavy_rain';
  const gust = num(c.wind_gusts_10m);
  if (gust !== null && gust >= WIND_GUST_HAZARD_KMH) return 'strong_wind';
  return null;
}

/** The request. The position is rounded to one decimal (about 10 km). */
export function openMeteoUrl(latitude: number, longitude: number): string {
  const lat = encodeURIComponent(latitude.toFixed(1));
  const lng = encodeURIComponent(longitude.toFixed(1));
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=${WEATHER_CURRENT_VARS}&wind_speed_unit=kmh&timezone=auto`;
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
