/**
 * The road state a drive's weather warnings are judged by: the grip and the sight cap at the car,
 * from the 15-minute weather series of its 0.1° cell. Pure: the series, a moment and a position in;
 * a stamp out (`{}` for a dry road in clear air), or null when the state is unknown. Unknown and `{}`
 * both warn at the normal lines; only a grip or a cap moves the warning lines (`judgedLimitMph`,
 * `hardLines`). The score never reads it.
 * Numbers and their sources are in `./thresholds.ts`.
 *
 * - Grip at a step, first match wins:
 *   - ice: a freezing rain or freezing drizzle code, or air at or below freezing after 0.5 mm of
 *     rain in 3 hours or with rain falling at 0.5 mm an hour (the black-ice rule of the alerts);
 *   - snow: snow falling at the heavy rate, or fresh snow on the road in near-freezing air;
 *   - water: heavy rain, water standing on the road, or moderate rain in the dark;
 *   - wet: the water film (rain, and snow as water, in; the air drying it out) at the wet line;
 *   - else dry.
 * - Sight: a speed cap from the visibility (`SIGHT_BANDS`).
 * - Two steps: the grip at a moment is the worse of its step and the one before, so a burst holds
 *   15 to 30 minutes and easing takes two easier steps; the sight reads the clearer visibility of the
 *   two, so fog must stand for two steps and a single low step does nothing.
 * - Known only within 90 minutes of the fetch, with 6 hours of steps before the moment's step, and at
 *   the series' cell or one touching it. A missing field makes its rule not fire.
 */
import { worseGrip, type RoadGrip, type RoadStamp, type SightCapMph } from '@/core/road';

import { roadTitle } from './copy';
import {
  ICE,
  NIGHT_RAIN,
  RATE,
  ROAD_HISTORY_STEPS,
  ROAD_STALE_MS,
  ROAD_STEP_S,
  SIGHT_BANDS,
  SNOW_ROAD,
  STANDING_WATER,
  WATER_FILM,
  WMO,
} from './thresholds';

/** One 15-minute step. Sums cover the 15 minutes before `t`; any field the model lacks is null. */
export type RoadStep = {
  /** Unix seconds. */
  t: number;
  code: number | null;
  tempC: number | null;
  /** Rain and showers in the step, mm. */
  rain15: number | null;
  /** All precipitation in the step (snow as water), mm. */
  precip15: number | null;
  /** Snowfall in the step, cm. */
  snow15: number | null;
  windMph: number | null;
  gustMph: number | null;
  visM: number | null;
  isDay: boolean | null;
};

/** The 15-minute series of one cell. */
export type RoadSeries = {
  /** The cell: the position asked for, rounded to 0.1°. */
  lat: number;
  lng: number;
  /** When the answer came (ms). */
  fetchedAtMs: number;
  /** Oldest first, each step after the one before. */
  steps: readonly RoadStep[];
};

/** Rounded to 6 places: sums of 15-minute values stay clean at the lines. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const has = (codes: readonly number[], code: number | null): boolean => code !== null && codes.includes(code);
const atLeast = (v: number | null, min: number): boolean => v !== null && v >= min;
const atMost = (v: number | null, max: number): boolean => v !== null && v <= max;

/** The 0.1° cell index of a coordinate. */
const cellOf = (v: number): number => Math.round(v * 10);

/** True when the position is in the series' cell or one touching it (0.1° either way). */
export function inRoadCell(series: RoadSeries, lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const dLat = Math.abs(cellOf(lat) - cellOf(series.lat));
  const dLng = Math.abs(cellOf(lng) - cellOf(series.lng)) % 3600;
  return dLat <= 1 && Math.min(dLng, 3600 - dLng) <= 1;
}

/** True while the series still says what the road is at `tsMs` (within 90 minutes of the fetch). */
export function roadFresh(series: RoadSeries, tsMs: number): boolean {
  return Math.abs(tsMs - series.fetchedAtMs) <= ROAD_STALE_MS;
}

/** The step a moment falls in: the last with `t` at or before it; -1 when there is none. */
export function stepIndexAt(steps: readonly RoadStep[], tsMs: number): number {
  let i = -1;
  steps.forEach((s, k) => {
    if (s.t * 1000 <= tsMs) i = k;
  });
  return i;
}

/** The water film (mm) at the end of each step, from the first step of the series. */
function waterFilm(steps: readonly RoadStep[], last: number): number[] {
  const out: number[] = [];
  let w = 0;
  for (const s of steps.slice(0, last + 1)) {
    const water = (s.rain15 ?? 0) + (s.snow15 ?? 0) * WATER_FILM.snowMmPerCm;
    const fast = s.isDay === true && atLeast(s.tempC, WATER_FILM.warmC);
    w = Math.min(WATER_FILM.capMm, w + Math.max(0, water));
    w = r6(Math.max(0, w - (fast ? WATER_FILM.dryWarmMm : WATER_FILM.dryCoolMm)));
    out.push(w);
  }
  return out;
}

/** The sum of a field over the `n` steps ending at `i`. */
function sumBack(steps: readonly RoadStep[], i: number, n: number, field: 'rain15' | 'snow15'): number {
  return r6(steps.slice(Math.max(0, i - n + 1), i + 1).reduce((total, s) => total + (s[field] ?? 0), 0));
}

/** The grip at step `i` (null: dry), with `filmMm` the water film at its end. */
export function gripAt(steps: readonly RoadStep[], i: number, filmMm: number): RoadGrip | null {
  const s = steps[i];
  if (s === undefined) return null;
  const rainRate = s.rain15 === null ? null : r6(s.rain15 * 4);
  const snowRate = s.snow15 === null ? null : r6(s.snow15 * 4);
  const rain3h = sumBack(steps, i, (ICE.lookbackHours * 3600) / ROAD_STEP_S, 'rain15');
  const snow6h = sumBack(steps, i, (SNOW_ROAD.lookbackHours * 3600) / ROAD_STEP_S, 'snow15');
  if (has(WMO.freezingRain, s.code) || has(WMO.freezingDrizzle, s.code)) return 'ice';
  if (atMost(s.tempC, ICE.freezingC) && (rain3h >= ICE.wetRoadMm || atLeast(rainRate, ICE.wetRoadMm))) return 'ice';
  if (atLeast(snowRate, RATE.heavySnowCmH)) return 'snow';
  if (snow6h >= SNOW_ROAD.snowCm && atMost(s.tempC, SNOW_ROAD.maxTempC)) return 'snow';
  if (atLeast(rainRate, RATE.heavyRainMmH) || rain3h >= STANDING_WATER.rainMm) return 'water';
  if (s.isDay === false && atLeast(rainRate, NIGHT_RAIN.rainMmH)) return 'water';
  if (filmMm >= WATER_FILM.wetMm) return 'wet';
  return null;
}

/** The speed cap for a visibility (m), or null when it caps nothing (or is unknown). */
export function sightCapOf(visM: number | null): SightCapMph | null {
  if (visM === null) return null;
  for (const band of SIGHT_BANDS) if (visM <= band.maxM) return band.capMph;
  return null;
}

/**
 * The road state at a moment and position: `{}` for a dry road in clear air, a stamp with the grip
 * and the cap when they tighten, or null when the series cannot say (stale, too little history, or
 * another place).
 */
export function roadStateAt(series: RoadSeries, tsMs: number, lat: number, lng: number): RoadStamp | null {
  if (!roadFresh(series, tsMs) || !inRoadCell(series, lat, lng)) return null;
  const { steps } = series;
  const i = stepIndexAt(steps, tsMs);
  const now = steps[i];
  const before = steps[i - 1];
  const first = steps[i - ROAD_HISTORY_STEPS];
  if (now === undefined || before === undefined || first === undefined || now.t - first.t !== ROAD_HISTORY_STEPS * ROAD_STEP_S) return null;
  const film = waterFilm(steps, i);
  const g = worseGrip(gripAt(steps, i, film[i] ?? 0), gripAt(steps, i - 1, film[i - 1] ?? 0));
  const cap = now.visM === null || before.visM === null ? null : sightCapOf(Math.max(now.visM, before.visM));
  const road: RoadStamp = {};
  if (g !== undefined) road.g = g;
  if (cap !== null) road.cap = cap;
  return road;
}

/** The road's title at a moment ("Slippery roads" for a wet road in the cold of its step), or null. */
export function roadTitleAt(series: RoadSeries | null, tsMs: number, road: RoadStamp | null | undefined): string | null {
  const step = series === null ? undefined : series.steps[stepIndexAt(series.steps, tsMs)];
  return roadTitle(road, step?.tempC ?? null);
}
