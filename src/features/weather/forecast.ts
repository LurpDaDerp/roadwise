/**
 * The hourly forecast the weather heads-up before the usual commute reads (`commutePlan.ts`): one
 * Open-Meteo call (the same free, keyless API as the dangerous-weather alerts) for the 6 hours back
 * and the 24 ahead, so a departure up to 20 hours away is covered with the rain and snow that fell
 * before it.
 *
 * - The position is the leg's start place, rounded to one decimal (about 10 km) as every weather
 *   call is: fine enough for the weather, too coarse to say where the driver lives.
 * - Each hourly stamp's sums cover the hour before it. A stamp's recent rain is the rain and showers
 *   of the stamps in the `ICE.lookbackHours` up to and including it, its recent snow the snowfall of
 *   the `SNOW_ROAD.lookbackHours` likewise: what `dangerAt` reads as "the last few hours".
 * - One request, aborted after 5 s. Every failure (no network, a slow answer, a malformed body) is
 *   null, which the planner reads as "unknown" (it never says the weather is fine on a failure).
 */
import { num, OPEN_METEO_TIMEOUT_MS, roundCoord, sampleOf, sum, WEATHER_VARS, type FetchLike, type WeatherSample } from './openMeteo';
import { ICE, PAST_HOURS, SNOW_ROAD } from './thresholds';

/** How far ahead the heads-up's forecast asks, in hours (a departure is at most 20 h away, plus its hour after). */
export const FORECAST_HOURS = 24;

/** One hour of the forecast with the rain and snow before it. */
export interface HourlyPoint {
  sample: WeatherSample;
  /** Rain and showers over the `ICE.lookbackHours` up to this stamp, mm. */
  recentRainMm: number;
  /** Snowfall over the `SNOW_ROAD.lookbackHours` up to this stamp, cm. */
  recentSnowCm: number;
}

export interface HourlyForecast {
  /** In time order. */
  points: HourlyPoint[];
}

export function forecastUrl(lat: number, lng: number): string {
  const la = roundCoord(lat).toFixed(1);
  const lo = roundCoord(lng).toFixed(1);
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
    `&hourly=${WEATHER_VARS}&past_hours=${PAST_HOURS}&forecast_hours=${FORECAST_HOURS}` +
    '&wind_speed_unit=mph&timeformat=unixtime'
  );
}

/** The hourly forecast in an Open-Meteo answer, or null when it holds no hourly stamps. */
export function parseForecast(body: unknown): HourlyForecast | null {
  if (!body || typeof body !== 'object') return null;
  const hourly = (body as { hourly?: unknown }).hourly;
  if (!hourly || typeof hourly !== 'object') return null;
  const h = hourly as Record<string, unknown>;
  if (!Array.isArray(h.time)) return null;
  const rows: { t: number; sample: WeatherSample; rain: number; snow: number }[] = [];
  const seen = new Set<number>();
  h.time.forEach((raw, i) => {
    const t = num(raw);
    if (t === null || seen.has(t)) return;
    seen.add(t);
    const at = (k: string) => (Array.isArray(h[k]) ? (h[k] as unknown[])[i] : null);
    rows.push({ t, sample: sampleOf(t, at, 1), rain: sum(num(at('rain')), num(at('showers'))) ?? 0, snow: num(at('snowfall')) ?? 0 });
  });
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.t - b.t);
  const rainS = ICE.lookbackHours * 3600;
  const snowS = SNOW_ROAD.lookbackHours * 3600;
  const points = rows.map((r) => {
    let recentRainMm = 0;
    let recentSnowCm = 0;
    for (const o of rows) {
      if (o.t > r.t) break;
      if (o.t > r.t - rainS) recentRainMm += o.rain;
      if (o.t > r.t - snowS) recentSnowCm += o.snow;
    }
    return { sample: r.sample, recentRainMm, recentSnowCm };
  });
  return { points };
}

/** One request, aborted after the timeout. Never throws: null on any failure. */
export async function fetchForecast(lat: number, lng: number, deps: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<HourlyForecast | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? OPEN_METEO_TIMEOUT_MS);
  try {
    const res = await doFetch(forecastUrl(lat, lng), { signal: control.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return parseForecast(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
