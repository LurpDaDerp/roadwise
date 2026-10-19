/**
 * Whether the weather is dangerous to drive in, and which danger to name (plan D14). Pure: the
 * reading in, at most one alert out. Thresholds and their sources are in `./thresholds.ts`.
 *
 * Each moment (now and the next 2 hours) is judged on its own; the most severe danger across them
 * wins, and on a tie the soonest. Anything less than dangerous (a wet road, a breezy day, light
 * snow) is no alert at all.
 */
import type { WeatherReading, WeatherSample } from './openMeteo';
import { ICE, QUARTER_MILE_M, RATE, WIND, WMO } from './thresholds';

/** Most severe first: when two dangers meet, the earlier one is named. */
export const DANGER_ORDER = [
  'blizzard',
  'freezing_rain',
  'black_ice',
  'freezing_drizzle',
  'hail',
  'high_wind',
  'heavy_snow',
  'freezing_fog',
  'dense_fog',
  'low_visibility',
  'thunderstorm',
  'heavy_rain',
  'strong_wind',
] as const;

export type DangerKind = (typeof DANGER_ORDER)[number];

/**
 * One alert. `gustMph` for the wind alerts (the strongest gust in the window), `visibilityM` for
 * the fog and visibility alerts (the lowest), else null.
 */
export type DangerAlert = { kind: DangerKind; gustMph: number | null; visibilityM: number | null };

const rank = (k: DangerKind): number => DANGER_ORDER.indexOf(k);

/** True when `a` is more severe than `b` (or `b` is nothing). */
export function moreSevere(a: DangerKind, b: DangerKind | null): boolean {
  return b === null || rank(a) < rank(b);
}

export function isDangerKind(v: unknown): v is DangerKind {
  return typeof v === 'string' && (DANGER_ORDER as readonly string[]).includes(v);
}

const has = (codes: readonly number[], code: number | null): boolean => code !== null && codes.includes(code);
const atLeast = (v: number | null, min: number): boolean => v !== null && v >= min;
const atMost = (v: number | null, max: number): boolean => v !== null && v <= max;

/** The danger at one moment, or null. `recentRainMm`: rain over the last few hours (black ice). */
export function dangerAt(s: WeatherSample, recentRainMm: number): DangerKind | null {
  const snowing = atLeast(s.snowCmH, 0.01) || has(WMO.snow, s.code);
  const raining = atLeast(s.rainMmH, 0.01) || atLeast(s.precipMmH, 0.01);
  const lowVisibility = atMost(s.visibilityM, QUARTER_MILE_M);
  const fogCode = has(WMO.fog, s.code);
  const freezing = atMost(s.tempC, ICE.freezingC);
  const wind = Math.max(s.windMph ?? 0, s.gustMph ?? 0);

  if (snowing && lowVisibility && wind >= WIND.blizzardMph) return 'blizzard';
  if (has(WMO.freezingRain, s.code)) return 'freezing_rain';
  if (freezing && (recentRainMm >= ICE.wetRoadMm || atLeast(s.rainMmH, ICE.wetRoadMm))) return 'black_ice';
  if (has(WMO.freezingDrizzle, s.code)) return 'freezing_drizzle';
  if (has(WMO.hail, s.code)) return 'hail';
  if (atLeast(s.gustMph, WIND.warningGustMph) || atLeast(s.windMph, WIND.warningSustainedMph)) return 'high_wind';
  if (atLeast(s.snowCmH, RATE.heavySnowCmH) || (snowing && lowVisibility)) return 'heavy_snow';
  // Rime fog (WMO 48) leaves ice on the road whatever the reported visibility; dense fog below
  // freezing does too.
  const foggy = fogCode || (lowVisibility && !raining && !snowing);
  if ((s.code === WMO.rimeFog && (s.tempC === null || freezing)) || (lowVisibility && foggy && freezing)) return 'freezing_fog';
  if (lowVisibility && foggy) return 'dense_fog';
  if (lowVisibility) return 'low_visibility';
  if (has(WMO.thunderstorm, s.code)) return 'thunderstorm';
  if (atLeast(s.rainMmH, RATE.heavyRainMmH)) return 'heavy_rain';
  if (atLeast(s.gustMph, WIND.advisoryGustMph)) return 'strong_wind';
  return null;
}

const WIND_KINDS: ReadonlySet<DangerKind> = new Set(['high_wind', 'strong_wind']);
const SIGHT_KINDS: ReadonlySet<DangerKind> = new Set(['dense_fog', 'low_visibility', 'freezing_fog', 'blizzard', 'heavy_snow']);

/** The single most severe danger in the reading, or null when nothing is dangerous. */
export function dangerFrom(reading: WeatherReading | null): DangerAlert | null {
  if (reading === null) return null;
  let best: DangerKind | null = null;
  for (const s of reading.samples) {
    const k = dangerAt(s, reading.recentRainMm);
    if (k !== null && moreSevere(k, best)) best = k;
  }
  if (best === null) return null;
  const kind = best;
  const hits = reading.samples.filter((s) => dangerAt(s, reading.recentRainMm) === kind);
  const gusts = hits.map((s) => s.gustMph).filter((v): v is number => v !== null);
  const sights = hits.map((s) => s.visibilityM).filter((v): v is number => v !== null);
  return {
    kind,
    gustMph: WIND_KINDS.has(kind) && gusts.length > 0 ? Math.max(...gusts) : null,
    visibilityM: SIGHT_KINDS.has(kind) && sights.length > 0 ? Math.min(...sights) : null,
  };
}
