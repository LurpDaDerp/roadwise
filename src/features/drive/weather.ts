import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import { dangerFrom, type DangerAlert } from '@/features/weather/danger';
import { fetchWeather, type FetchLike } from '@/features/weather/openMeteo';

/**
 * The driving screen's weather: the dangerous-weather alert (plan D14, `src/features/weather`),
 * judged from Open-Meteo at the phone's position rounded to about 10 km. Asked only while the drive
 * records: once at the start, then every 15 min, and again after each 20 km of the trip's own
 * odometer, never faster. Everything fails silently: no position, no network, a slow answer or a
 * malformed body all mean "no alert".
 */

export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_REFETCH_DISTANCE_M = 20_000;
const POSITION_MAX_AGE_MS = 60 * 60_000;

/** The alert at the phone's last known position, or null. Never throws. */
export async function driveWeatherAlert(deps: { fetch?: FetchLike } = {}): Promise<DangerAlert | null> {
  try {
    const pos = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
    if (!pos) return null;
    return dangerFrom(await fetchWeather(pos.coords.latitude, pos.coords.longitude, { fetch: deps.fetch }));
  } catch {
    return null;
  }
}

/**
 * The alert to show, or null. `active`: the drive records. `distanceM`: the trip's odometer, so the
 * car crossing into other weather is noticed without a position read of its own.
 */
export function useDriveWeather(active: boolean, distanceM: number, deps: { fetch?: FetchLike } = {}): DangerAlert | null {
  const [alert, setAlert] = useState<DangerAlert | null>(null);
  const leg = Math.floor(distanceM / WEATHER_REFETCH_DISTANCE_M);
  const doFetch = deps.fetch;

  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = async () => {
      const next = await driveWeatherAlert({ fetch: doFetch });
      if (live) setAlert((prev) => (sameAlert(prev, next) ? prev : next));
    };
    void refresh();
    const timer = setInterval(() => void refresh(), WEATHER_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, leg, doFetch]);

  return active ? alert : null;
}

/** Same alert, same words: no re-render of the screen for an unchanged answer. */
function sameAlert(a: DangerAlert | null, b: DangerAlert | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.gustMph === b.gustMph && a.visibilityM === b.visibilityM;
}
