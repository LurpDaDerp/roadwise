/**
 * The drive's weather request: Open-Meteo's 15-minute series for the car's cell (7 hours back, 2
 * ahead) and the hourly block the alerts already read (6 hours back, 5 ahead), the same variables
 * in both, so one request costs what the current-and-hourly request costs.
 *
 * - The step a moment falls in stands in for Open-Meteo's `current` (which is that same step), so the
 *   alert (`dangerFrom`) and the drive's weather (`driveWeatherOf`) read it through `parseWeather`
 *   exactly as they read a current-and-hourly answer, at any step of the series, with no request.
 * - The road state (`./road.ts`) reads the steps.
 * - The position is rounded to 0.1° before it leaves the phone. Every field may be missing; a body
 *   with no steps is no answer. One request, aborted after 5 s, asked once more through the
 *   `weather` edge function when Open-Meteo did not answer (`./transport.ts`); it never throws.
 */
import { num, parseWeather, roundCoord, sum, WEATHER_VARS, type FetchLike, type WeatherReading } from './openMeteo';
import { stepIndexAt, type RoadSeries, type RoadStep } from './road';
import { ROAD_SERIES, ROAD_STEP_S } from './thresholds';
import { requestOpenMeteo, type OpenMeteoFallback } from './transport';

/** A cell's series with the hourly block (time and each variable, oldest first), as stored. */
export type WeatherSeries = RoadSeries & { hourly: Record<string, (number | null)[]> };

/** How a request ended: an answer, a refusal for asking too often (429), or any other failure. */
export type RoadSeriesResult =
  | { kind: 'ok'; series: WeatherSeries }
  | { kind: 'limited'; retryAfterMs: number | null }
  | { kind: 'failed' };

const VARS = WEATHER_VARS.split(',');

export function roadSeriesUrl(lat: number, lng: number): string {
  const la = roundCoord(lat).toFixed(1);
  const lo = roundCoord(lng).toFixed(1);
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
    `&minutely_15=${WEATHER_VARS}&hourly=${WEATHER_VARS}` +
    `&past_minutely_15=${ROAD_SERIES.pastSteps}&forecast_minutely_15=${ROAD_SERIES.aheadSteps}` +
    `&past_hours=${ROAD_SERIES.pastHours}&forecast_hours=${ROAD_SERIES.aheadHours}` +
    '&wind_speed_unit=mph&timeformat=unixtime'
  );
}

type Block = Record<string, unknown>;

const blockOf = (v: unknown): Block => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Block) : {});
const column = (b: Block, k: string): unknown[] => (Array.isArray(b[k]) ? (b[k] as unknown[]) : []);
const day = (v: unknown): boolean | null => (v === 1 || v === true ? true : v === 0 || v === false ? false : null);

/** The steps of a 15-minute block, each with a time after the one before. */
function stepsOf(b: Block): RoadStep[] {
  const steps: RoadStep[] = [];
  column(b, 'time').forEach((raw, i) => {
    const t = num(raw);
    if (t === null || t <= (steps.at(-1)?.t ?? -Infinity)) return;
    const at = (k: string): number | null => num(column(b, k)[i]);
    steps.push({
      t,
      code: at('weather_code'),
      tempC: at('temperature_2m'),
      rain15: sum(at('rain'), at('showers')),
      precip15: at('precipitation'),
      snow15: at('snowfall'),
      windMph: at('wind_speed_10m'),
      gustMph: at('wind_gusts_10m'),
      visM: at('visibility'),
      isDay: day(column(b, 'is_day')[i]),
    });
  });
  return steps;
}

/** The hourly block, kept as columns of numbers (anything else null). */
function hourlyOf(b: Block): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const k of ['time', ...VARS]) if (Array.isArray(b[k])) out[k] = (b[k] as unknown[]).map(num);
  return out;
}

/** The series in an Open-Meteo answer for the cell of `lat`, `lng`, or null when it has no steps. */
export function parseRoadSeries(body: unknown, lat: number, lng: number, fetchedAtMs: number): WeatherSeries | null {
  const b = blockOf(body);
  const steps = stepsOf(blockOf(b.minutely_15));
  if (steps.length === 0 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: roundCoord(lat), lng: roundCoord(lng), fetchedAtMs, steps, hourly: hourlyOf(blockOf(b.hourly)) };
}

/** A stored series read back (it was written by `parseRoadSeries`), or null when it is not one. */
export function reviveSeries(v: unknown): WeatherSeries | null {
  const s = blockOf(v);
  const lat = num(s.lat);
  const lng = num(s.lng);
  const fetchedAtMs = num(s.fetchedAtMs);
  if (lat === null || lng === null || fetchedAtMs === null || !Array.isArray(s.steps)) return null;
  const steps: RoadStep[] = [];
  for (const raw of s.steps) {
    const st = blockOf(raw);
    const t = num(st.t);
    if (t === null || t <= (steps.at(-1)?.t ?? -Infinity)) return null;
    steps.push({
      t,
      code: num(st.code),
      tempC: num(st.tempC),
      rain15: num(st.rain15),
      precip15: num(st.precip15),
      snow15: num(st.snow15),
      windMph: num(st.windMph),
      gustMph: num(st.gustMph),
      visM: num(st.visM),
      isDay: day(st.isDay),
    });
  }
  if (steps.length === 0) return null;
  return { lat, lng, fetchedAtMs, steps, hourly: hourlyOf(blockOf(s.hourly)) };
}

/**
 * The weather reading at a moment, as `parseWeather` reads a current-and-hourly answer: the step the
 * moment falls in as `current` (its sums over 15 minutes), the hourly block as it came. Null before
 * the first step. Whether the series is still fresh enough is the caller's to judge.
 */
export function readingAt(series: WeatherSeries, tsMs: number): WeatherReading | null {
  const s = series.steps[stepIndexAt(series.steps, tsMs)];
  if (s === undefined) return null;
  const current = {
    time: s.t,
    interval: ROAD_STEP_S,
    weather_code: s.code,
    temperature_2m: s.tempC,
    precipitation: s.precip15,
    // Rain and showers are one sum in a step; `parseWeather` adds them back the same.
    rain: s.rain15,
    showers: null,
    snowfall: s.snow15,
    wind_speed_10m: s.windMph,
    wind_gusts_10m: s.gustMph,
    visibility: s.visM,
    is_day: s.isDay === null ? null : s.isDay ? 1 : 0,
  };
  return parseWeather({ current, hourly: series.hourly });
}

/** `Retry-After` in ms: delta seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // An HTTP date always ends in GMT.
  const at = /GMT$/i.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** One request for the series at a place (with the edge function as its fallback), aborted after the timeout. Never throws. */
export async function fetchRoadSeries(
  lat: number,
  lng: number,
  deps: { fetch?: FetchLike; timeoutMs?: number; now?: () => number; fallback?: OpenMeteoFallback | null } = {}
): Promise<RoadSeriesResult> {
  const now = deps.now ?? Date.now;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { kind: 'failed' };
  const res = await requestOpenMeteo(roadSeriesUrl(lat, lng), deps);
  if (res === null) return { kind: 'failed' };
  try {
    if (res.status === 429) {
      const headers = res.headers as Headers | undefined;
      return { kind: 'limited', retryAfterMs: retryAfterMs(typeof headers?.get === 'function' ? headers.get('Retry-After') : null, now()) };
    }
    if (!res.ok) return { kind: 'failed' };
    const series = parseRoadSeries(await res.json(), lat, lng, now());
    return series === null ? { kind: 'failed' } : { kind: 'ok', series };
  } catch {
    return { kind: 'failed' };
  }
}
