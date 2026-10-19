/**
 * The weather that dangerous-weather alerts read (plan D14): Open-Meteo's forecast API
 * (api.open-meteo.com, free, no key; the same third party the sky theme already asks), with the
 * conditions now and for the next 2 hours, the rain of the last 3 hours (black ice, water standing
 * on the road) and the snow of the last 6 (snow on the road).
 *
 * - The position is rounded to one decimal (about 10 km) before it leaves the phone: fine enough
 *   for the weather, too coarse to say where the driver is.
 * - One request, aborted after 5 s. Every failure (no network, a slow answer, a malformed body)
 *   is `null`, which callers treat as "nothing to say".
 * - Wind comes back in mph so the thresholds read as the NWS writes them; precipitation in mm,
 *   snowfall in cm, visibility in metres (Open-Meteo's units); `is_day` says whether it is light.
 */
import { ICE, LOOKAHEAD_HOURS, PAST_HOURS, SNOW_ROAD } from './thresholds';

/** One moment of weather. Rates are per hour; any field the model lacks is null. */
export type WeatherSample = {
  /** Unix seconds. */
  time: number;
  code: number | null;
  tempC: number | null;
  /** Rain and showers, mm an hour. */
  rainMmH: number | null;
  /** All precipitation (rain, showers and snow as water), mm an hour. */
  precipMmH: number | null;
  /** Snowfall, cm an hour. */
  snowCmH: number | null;
  windMph: number | null;
  gustMph: number | null;
  visibilityM: number | null;
  /** Daylight (Open-Meteo's `is_day`): false after dark. */
  isDay: boolean | null;
};

export type WeatherReading = {
  /** Now first, then each hour ahead (at most `LOOKAHEAD_HOURS`). */
  samples: WeatherSample[];
  /** Rain and showers over the last `ICE.lookbackHours`, mm. */
  recentRainMm: number;
  /** Snowfall over the last `SNOW_ROAD.lookbackHours`, cm. */
  recentSnowCm: number;
};

export const OPEN_METEO_TIMEOUT_MS = 5_000;

const VARS = 'weather_code,temperature_2m,precipitation,rain,showers,snowfall,wind_speed_10m,wind_gusts_10m,visibility,is_day';

/** One decimal: about 11 km of latitude. */
export function roundCoord(v: number): number {
  return Math.round(v * 10) / 10;
}

export function weatherUrl(lat: number, lng: number): string {
  const la = roundCoord(lat).toFixed(1);
  const lo = roundCoord(lng).toFixed(1);
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
    `&current=${VARS}&hourly=${VARS}&past_hours=${PAST_HOURS}&forecast_hours=${LOOKAHEAD_HOURS + 1}` +
    '&wind_speed_unit=mph&timeformat=unixtime'
  );
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const scaled = (v: number | null, k: number): number | null => (v === null ? null : v * k);
const day = (v: unknown): boolean | null => (v === 1 ? true : v === 0 ? false : null);

type Block = Record<string, unknown>;

/** A sample from one set of values; `perHour` turns the block's sums into hourly rates. */
function sampleOf(time: number, at: (key: string) => unknown, perHour: number): WeatherSample {
  return {
    time,
    code: num(at('weather_code')),
    tempC: num(at('temperature_2m')),
    rainMmH: scaled(sum(num(at('rain')), num(at('showers'))), perHour),
    precipMmH: scaled(num(at('precipitation')), perHour),
    snowCmH: scaled(num(at('snowfall')), perHour),
    windMph: num(at('wind_speed_10m')),
    gustMph: num(at('wind_gusts_10m')),
    visibilityM: num(at('visibility')),
    isDay: day(at('is_day')),
  };
}

/**
 * The reading in an Open-Meteo answer, or null when it has no current conditions. `current` sums
 * cover its own interval (15 min), so they are scaled to an hour; `hourly` sums cover the hour
 * before each time stamp.
 */
export function parseWeather(body: unknown): WeatherReading | null {
  if (!body || typeof body !== 'object') return null;
  const current = (body as { current?: unknown }).current;
  if (!current || typeof current !== 'object') return null;
  const c = current as Block;
  const now = num(c.time);
  if (now === null) return null;
  const interval = num(c.interval);
  const perHour = interval !== null && interval > 0 ? 3600 / interval : 4;
  const samples = [sampleOf(now, (k) => c[k], perHour)];

  let recentRainMm = 0;
  let recentSnowCm = 0;
  const hourly = (body as { hourly?: unknown }).hourly;
  const h = hourly && typeof hourly === 'object' ? (hourly as Record<string, unknown>) : {};
  const times = Array.isArray(h.time) ? h.time : [];
  const ahead = now + LOOKAHEAD_HOURS * 3600;
  const rainSince = now - ICE.lookbackHours * 3600;
  const snowSince = now - SNOW_ROAD.lookbackHours * 3600;
  let currentCounted = false;
  times.forEach((raw, i) => {
    const t = num(raw);
    if (t === null) return;
    const at = (k: string) => (Array.isArray(h[k]) ? (h[k] as unknown[])[i] : null);
    if (t > now && t <= ahead) samples.push(sampleOf(t, at, 1));
    else if (t > snowSince && t <= now) {
      if (t > rainSince) recentRainMm += sum(num(at('rain')), num(at('showers'))) ?? 0;
      recentSnowCm += num(at('snowfall')) ?? 0;
      if (t === now) currentCounted = true;
    }
  });
  // The quarter hour since the last hourly stamp is not in any hourly sum yet.
  if (!currentCounted) {
    recentRainMm += sum(num(c.rain), num(c.showers)) ?? 0;
    recentSnowCm += num(c.snowfall) ?? 0;
  }
  return { samples, recentRainMm, recentSnowCm };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One request, aborted after the timeout. Never throws: null on any failure. */
export async function fetchWeather(
  lat: number,
  lng: number,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<WeatherReading | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? OPEN_METEO_TIMEOUT_MS);
  try {
    const res = await doFetch(weatherUrl(lat, lng), { signal: control.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return parseWeather(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
