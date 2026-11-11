/** Open-Meteo 15-minute answers for the road-state and drive-watch tests. */
import { NOW } from './openMeteo';

export { NOW };

/** One step's values, by Open-Meteo's names. */
export type StepValues = Partial<Record<string, number | null>>;

const VARS = ['weather_code', 'temperature_2m', 'precipitation', 'rain', 'showers', 'snowfall', 'wind_speed_10m', 'wind_gusts_10m', 'visibility', 'is_day'];

const DRY: StepValues = {
  weather_code: 3,
  temperature_2m: 8,
  precipitation: 0,
  rain: 0,
  showers: 0,
  snowfall: 0,
  wind_speed_10m: 5,
  wind_gusts_10m: 9,
  visibility: 16000,
  is_day: 1,
};

/** A block of columns from one row per time. */
function columns(times: number[], valuesAt: (t: number, i: number) => StepValues): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = { time: times };
  for (const k of VARS) out[k] = times.map((t, i) => ({ ...DRY, ...valuesAt(t, i) })[k] ?? null);
  return out;
}

/**
 * The drive's answer at `nowS` (unix seconds): 28 steps back and 8 ahead of the step `nowS` falls in,
 * the hourly rows 6 back and 5 ahead of its hour. The hourly sums are the sums of their four steps
 * (as Open-Meteo's North America answers are) unless `hourAt` says otherwise.
 */
export function seriesBody(nowS: number, stepAt: (t: number, i: number) => StepValues = () => ({}), hourAt?: (t: number) => StepValues) {
  const step0 = Math.floor(nowS / 900) * 900;
  const hour0 = Math.floor(nowS / 3600) * 3600;
  const steps = Array.from({ length: 36 }, (_, i) => step0 + (i - 28) * 900);
  const hours = Array.from({ length: 12 }, (_, i) => hour0 + (i - 6) * 3600);
  const minutely = columns(steps, stepAt);
  const sumOver = (h: number, k: string): number =>
    [3, 2, 1, 0].reduce((a, back) => a + Number({ ...DRY, ...stepAt(h - back * 900, -1) }[k] ?? 0), 0);
  const hourly = columns(hours, (h) => ({
    ...stepAt(h, -1),
    rain: sumOver(h, 'rain'),
    showers: sumOver(h, 'showers'),
    precipitation: sumOver(h, 'precipitation'),
    snowfall: sumOver(h, 'snowfall'),
    ...hourAt?.(h),
  }));
  return { minutely_15: minutely, hourly };
}

/**
 * A North America answer as Open-Meteo gives it (Seattle, an evening of showers: values vary step to
 * step, hourly rain is the sum of its four steps, weather codes and gusts do not match the hours).
 * Step 28 is `NOW`.
 */
export const NORTH_AMERICA = (() => {
  const rain = [0, 0, 0, 0, 0, 0, 0.1, 0.2, 0.1, 0, 0, 0, 0, 0, 0.1, 0.3, 0.4, 0.6, 0.5, 0.2, 0.1, 0.1, 0.3, 0.5, 0.7, 0.8, 0.6, 0.4, 0.3, 0.2, 0.2, 0.9, 1.6, 2.1, 1.2, 0.4];
  const showers = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.3, 0.2, 0, 0];
  const code = [3, 3, 3, 3, 2, 3, 51, 61, 51, 3, 3, 3, 2, 3, 51, 61, 61, 63, 61, 51, 51, 51, 61, 61, 63, 63, 61, 61, 61, 51, 51, 63, 65, 65, 63, 61];
  const vis = [24100, 24100, 22800, 22200, 20900, 19600, 15400, 12900, 14700, 18300, 19900, 20400, 20800, 18700, 14200, 10400, 9300, 7600, 8200, 11800, 13900, 13400, 10200, 8800, 7100, 6400, 7400, 8900, 9600, 11200, 11700, 6100, 3900, 3100, 5200, 8600];
  return seriesBody(
    NOW,
    (t, i) => {
      const k = i >= 0 ? i : (t - (NOW - 28 * 900)) / 900;
      const inside = k >= 0 && k < 36;
      const r = inside ? (rain[k] ?? 0) : 0.5;
      const s = inside ? (showers[k] ?? 0) : 0;
      return {
        weather_code: inside ? (code[k] ?? 3) : 61,
        temperature_2m: inside ? 9.4 - k * 0.05 : 7.6,
        rain: r,
        showers: s,
        precipitation: Math.round((r + s) * 10) / 10,
        snowfall: 0,
        wind_speed_10m: inside ? 6 + (k % 5) : 8,
        wind_gusts_10m: inside ? 14 + (k % 7) : 16,
        visibility: inside ? (vis[k] ?? 16000) : 9000,
        is_day: t < NOW + 3600 ? 1 : 0,
      };
    },
    (h) => ({ weather_code: h <= NOW ? 61 : 63, wind_gusts_10m: 13 })
  );
})();

/**
 * An answer outside the native 15-minute regions (Tokyo): the API spreads each hour's values over
 * its four steps, flat. Moderate rain from the hour before `NOW`.
 */
export const INTERPOLATED = seriesBody(NOW, (t) => {
  const hourRain = t > NOW - 3600 ? 4 : t > NOW - 3 * 3600 ? 1.2 : 0;
  return {
    weather_code: hourRain >= 4 ? 63 : hourRain > 0 ? 61 : 3,
    temperature_2m: 14,
    rain: hourRain / 4,
    showers: 0,
    precipitation: hourRain / 4,
    visibility: hourRain >= 4 ? 6000 : 20000,
    is_day: 1,
  };
});

/** The recorded current-and-hourly answer at a step of `body`: its step as `current`, its hours 6 back and 2 ahead. */
export function recordedAt(body: ReturnType<typeof seriesBody>, nowS: number) {
  const m = body.minutely_15;
  const i = (m.time as number[]).indexOf(nowS);
  const current: Record<string, unknown> = { time: nowS, interval: 900 };
  for (const k of VARS) current[k] = (m[k] as unknown[])[i];
  const hour0 = Math.floor(nowS / 3600) * 3600;
  const h = body.hourly;
  const keep = (h.time as number[]).map((t) => t >= hour0 - 6 * 3600 && t <= hour0 + 2 * 3600);
  const hourly: Record<string, unknown[]> = {};
  for (const k of Object.keys(h)) hourly[k] = (h[k] as unknown[]).filter((_, j) => keep[j]);
  return { current, hourly };
}

/** A fetch answer: a JSON body with a status, and headers. */
export const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => body,
  }) as unknown as Response;
