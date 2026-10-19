/**
 * The weather the theme wears: Open-Meteo's current conditions (api.open-meteo.com, free, no key),
 * reduced to one of six kinds. Decoration only: nothing in RoadWise depends on it.
 *
 * - The position is rounded to one decimal (about 10 km) before it leaves the phone, the same
 *   rounding the dangerous-weather alerts use (`@/features/weather`).
 * - One answer serves 30 min for the same rounded place; it is kept on the phone so a cold launch
 *   paints the right sky at once.
 * - Every failure (no network, a slow answer, a malformed body) is silent and reads as `clear`,
 *   or as the last answer while it is under 3 h old.
 */

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
/** Drizzle and light falls draw fewer streaks / flakes than heavy ones. */
export type WeatherIntensity = 'light' | 'moderate' | 'heavy';

export type SkyWeather = { kind: WeatherKind; intensity: WeatherIntensity };

export const CLEAR: SkyWeather = { kind: 'clear', intensity: 'light' };

export const WEATHER_TTL_MS = 30 * 60_000;
/** A stored answer older than this is not shown after a failed refresh. */
export const WEATHER_STALE_MS = 3 * 60 * 60_000;
export const OPEN_METEO_TIMEOUT_MS = 5_000;

/**
 * WMO weather interpretation codes (the `weather_code` Open-Meteo reports) to a kind. Partly
 * cloudy (2) counts as cloudy only when the cover is 60 % or more.
 */
export function weatherFromWmo(code: number, cloudCover?: number | null): SkyWeather {
  if (!Number.isFinite(code)) return CLEAR;
  switch (code) {
    case 0:
    case 1:
      return CLEAR;
    case 2:
      return typeof cloudCover === 'number' && cloudCover >= 60 ? { kind: 'cloudy', intensity: 'light' } : CLEAR;
    case 3:
      return { kind: 'cloudy', intensity: 'moderate' };
    case 45:
    case 48:
      return { kind: 'fog', intensity: 'moderate' };
    case 51:
    case 56:
      return { kind: 'rain', intensity: 'light' };
    case 53:
    case 55:
    case 57:
      return { kind: 'rain', intensity: 'light' };
    case 61:
    case 80:
      return { kind: 'rain', intensity: 'moderate' };
    case 63:
    case 66:
    case 81:
      return { kind: 'rain', intensity: 'moderate' };
    case 65:
    case 67:
    case 82:
      return { kind: 'rain', intensity: 'heavy' };
    case 71:
    case 77:
    case 85:
      return { kind: 'snow', intensity: 'light' };
    case 73:
      return { kind: 'snow', intensity: 'moderate' };
    case 75:
    case 86:
      return { kind: 'snow', intensity: 'heavy' };
    case 95:
      return { kind: 'storm', intensity: 'moderate' };
    case 96:
    case 99:
      return { kind: 'storm', intensity: 'heavy' };
    default:
      return CLEAR;
  }
}

/** One decimal: about 11 km of latitude. Fine for weather, too coarse to say where anyone is. */
export function roundCoord(v: number): number {
  return Math.round(v * 10) / 10;
}

export function openMeteoUrl(lat: number, lng: number): string {
  const la = roundCoord(lat).toFixed(1);
  const lo = roundCoord(lng).toFixed(1);
  return `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=weather_code,is_day,cloud_cover,precipitation`;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One request, aborted after the timeout. Null on any failure. */
export async function fetchSkyWeather(
  lat: number,
  lng: number,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<SkyWeather | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? OPEN_METEO_TIMEOUT_MS);
  try {
    const res = await doFetch(openMeteoUrl(lat, lng), { signal: control.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { current?: { weather_code?: unknown; cloud_cover?: unknown } } | null;
    const code = body?.current?.weather_code;
    if (typeof code !== 'number') return null;
    const cover = body?.current?.cloud_cover;
    return weatherFromWmo(code, typeof cover === 'number' ? cover : null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What is kept on the phone: the rounded place, the last answer and when it came. */
export type SkyCache = {
  lat: number;
  lng: number;
  weather: SkyWeather | null;
  fetchedAt: number;
};

export type SkyStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export const SKY_CACHE_KEY = 'roadwise.sky.v1';

const KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
const INTENSITIES: readonly WeatherIntensity[] = ['light', 'moderate', 'heavy'];

export function parseSkyCache(raw: string | null): SkyCache | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SkyCache> | null;
    if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number' || typeof v.fetchedAt !== 'number') return null;
    const w = v.weather;
    const weather =
      w && KINDS.includes(w.kind) && INTENSITIES.includes(w.intensity) ? { kind: w.kind, intensity: w.intensity } : null;
    return { lat: roundCoord(v.lat), lng: roundCoord(v.lng), weather, fetchedAt: v.fetchedAt };
  } catch {
    return null;
  }
}

/**
 * The weather for a place: the stored answer while it is fresh and for the same rounded place,
 * else one request. A failed request keeps a same-place answer under 3 h old, else `clear`.
 * The store is written with the rounded place only.
 */
export async function skyWeatherFor(
  place: { lat: number; lng: number },
  deps: { now: number; cache: SkyCache | null; fetch?: FetchLike; save?: (c: SkyCache) => void }
): Promise<{ weather: SkyWeather; cache: SkyCache; fetched: boolean }> {
  const lat = roundCoord(place.lat);
  const lng = roundCoord(place.lng);
  const c = deps.cache;
  const samePlace = !!c && c.lat === lat && c.lng === lng;
  if (samePlace && c.weather && deps.now - c.fetchedAt < WEATHER_TTL_MS && deps.now >= c.fetchedAt) {
    return { weather: c.weather, cache: c, fetched: false };
  }
  const answer = await fetchSkyWeather(lat, lng, { fetch: deps.fetch });
  if (answer) {
    const next: SkyCache = { lat, lng, weather: answer, fetchedAt: deps.now };
    deps.save?.(next);
    return { weather: answer, cache: next, fetched: true };
  }
  const keep = samePlace && c.weather && deps.now - c.fetchedAt < WEATHER_STALE_MS ? c.weather : CLEAR;
  // A failure is not stored as an answer: the next foreground tries again.
  const next: SkyCache = samePlace ? c : { lat, lng, weather: null, fetchedAt: 0 };
  if (!samePlace) deps.save?.(next);
  return { weather: keep, cache: next, fetched: true };
}
