/**
 * The weather a drive was driven in, one word per drive (`trips.weather`): what the recap's
 * analytics group by and what the "Rain or Shine" badge asks for. Only the conditions NOW count
 * (`samples[0]`, with the rain of the last 3 hours and the snow of the last 6), never the forecast
 * the alerts look ahead to. A drive takes the worst word of all the readings made while it ran
 * (`worseWeather`); one with no reading at all (offline, no position, a dry run) has none (null),
 * never `clear`.
 *
 * - ice: freezing rain or freezing drizzle, or air at or below freezing on a wet road (the black ice
 *   test of `danger.ts`: `ICE.wetRoadMm` of rain in the last 3 hours, or falling at that rate).
 * - snow: a snow code, snow falling at `SNOW_FALLING_CM_H` or more, or snow on the road
 *   (`SNOW_ROAD`: fresh snow in near-freezing air).
 * - rain: a drizzle, rain, shower or thunderstorm code, or rain falling at `RAIN_FALLING_MM_H` or more.
 * - clear: any other reading (cloud and fog included).
 */
import { DRIVE_WEATHERS, type DriveWeather } from '@/data/db/types';

import type { WeatherReading } from './openMeteo';
import { ICE, SNOW_ROAD, WMO } from './thresholds';

export { DRIVE_WEATHERS, type DriveWeather };

/**
 * Rain falling at this rate or more (mm an hour) tags a drive as rain whatever the code says. Well
 * under the AMS's light rain (anything below 2.6 mm an hour) but above the model's drizzle noise: the
 * current rate is a 15-minute sum times four, so a stray 0.05 mm reads as 0.2 mm an hour, and a
 * lower line would tag a dry drive and cheapen the badge.
 */
export const RAIN_FALLING_MM_H = 0.2;

/** Snow falling at this rate or more (cm an hour, 1 mm) tags a drive as snow. */
export const SNOW_FALLING_CM_H = 0.1;

/** WMO codes for drizzle (51-55), rain (61-65), rain showers (80-82) and thunderstorms (95-99). */
export const WMO_RAIN: readonly number[] = [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 97, 99];

const has = (codes: readonly number[], code: number | null): boolean => code !== null && codes.includes(code);
const atLeast = (v: number | null | undefined, line: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= line;
const atMost = (v: number | null | undefined, line: number): boolean => typeof v === 'number' && Number.isFinite(v) && v <= line;

/** The word for one reading (its current conditions only); null when there is no reading. */
export function driveWeatherOf(reading: WeatherReading | null): DriveWeather | null {
  if (reading === null) return null;
  const now = reading.samples[0];
  const code = now?.code ?? null;
  const tempC = now?.tempC ?? null;
  const rainMmH = now?.rainMmH ?? null;
  if (has(WMO.freezingRain, code) || has(WMO.freezingDrizzle, code)) return 'ice';
  if (atMost(tempC, ICE.freezingC) && (atLeast(reading.recentRainMm, ICE.wetRoadMm) || atLeast(rainMmH, ICE.wetRoadMm))) return 'ice';
  if (has(WMO.snow, code) || atLeast(now?.snowCmH, SNOW_FALLING_CM_H)) return 'snow';
  if (atLeast(reading.recentSnowCm, SNOW_ROAD.snowCm) && atMost(tempC, SNOW_ROAD.maxTempC)) return 'snow';
  if (has(WMO_RAIN, code) || atLeast(rainMmH, RAIN_FALLING_MM_H)) return 'rain';
  return 'clear';
}

const RANK: Record<DriveWeather, number> = { clear: 1, rain: 2, snow: 3, ice: 4 };

/** The worse of two words: ice, then snow, then rain, then clear, then none. */
export function worseWeather(a: DriveWeather | null, b: DriveWeather | null): DriveWeather | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[b] > RANK[a] ? b : a;
}
