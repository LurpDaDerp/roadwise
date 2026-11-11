// The drive's weather watch (modes plan §10 A2; the alert of `src/features/weather`, the road state
// of `src/features/weather/road.ts`). While a drive records, in any app state (iOS keeps RoadWise
// running on location during a drive), it asks Open-Meteo for the 15-minute series of the car's 0.1°
// cell (`fetchRoadSeries`) and holds the answers. The position is the drive's own latest fix, else
// the phone's last known one (with neither, the first fix makes the first request). Requests fall
// due on rows; there is no timer:
// - as the drive opens, unless an answer under 30 min old is already held for the cell;
// - when the cell's answer is 30 min old (the model updates hourly), or the car enters a cell with no
//   answer under 30 min old (a car weaving along a border re-reads the cells it holds);
// - never within 5 min of the last answered request (meanwhile a touching cell's answer stands);
// - after a failure (no network, a slow answer, an error, a malformed body) the next try waits 1, 2,
//   4, 8, then 15 min; after a 429 the larger of its Retry-After and 15 min, doubling to 60. An
//   answer resets both.
// The last 6 cells are held in memory, and the newest is saved under one setting (`hold`), so a
// relaunch mid-drive keeps it; a saved answer older than 90 min is dropped.
//
// An answer serves for 90 min after it came, at its cell or one touching it; after that the weather
// is unknown: no alert, no tag, and the normal lines. From the serving answer, at each 15-minute step
// (no request), the alert (`dangerFrom`) and the drive's weather (`driveWeatherOf`, its current
// conditions only) are judged again through `readingAt`; each judgement tells `onTag` its word, then
// `onAlert` the alert. The judgement keeps its answer while that still serves and no newer one serves
// the car's cell, so a fix jittering across a cell border does not flip the alert. Each request's
// outcome is judged at once too, so a failure with nothing serving is "no alert". `roadAt` is the
// road state at a row's time and place.
//
// A reading or alert lookup given in place of the request (`read`, `lookup`: test seams) holds no
// series: it is asked once as the drive opens, then every 15 min and after each 20 km of the trip's
// own odometer, never faster, and it has no road state.
import type { RoadStamp } from '@/core/road';

import { createSettingsRepo, type Db } from '@/data/db';
import { dangerFrom, type DangerAlert } from '@/features/weather/danger';
import { driveWeatherOf, type DriveWeather } from '@/features/weather/driveWeather';
import type { FetchLike, WeatherReading } from '@/features/weather/openMeteo';
import { inRoadCell, roadFresh, roadStateAt, roadTitleAt, stepIndexAt } from '@/features/weather/road';
import { fetchRoadSeries, readingAt, reviveSeries, type RoadSeriesResult, type WeatherSeries } from '@/features/weather/roadSeries';

/** A lookup seam is asked every 15 min while the drive records… */
export const WEATHER_REFRESH_MS = 15 * 60_000;
/** …and after each 20 km driven. */
export const WEATHER_REFETCH_DISTANCE_M = 20_000;

/** A cell's answer is asked again once it is this old. */
export const CELL_REFRESH_MS = 30 * 60_000;
/** Never two requests within this of the last answered one. */
export const REQUEST_FLOOR_MS = 5 * 60_000;
/** The waits after failures in a row (the last one repeats). */
export const FAILURE_BACKOFF_MS: readonly number[] = [1, 2, 4, 8, 15].map((m) => m * 60_000);
/** The first wait after a 429 (or its Retry-After when longer), doubling with each one in a row… */
export const LIMITED_BACKOFF_MS = 15 * 60_000;
/** …to this at most. */
export const LIMITED_BACKOFF_MAX_MS = 60 * 60_000;
/** The cells whose answers are held. */
export const HELD_CELLS = 6;
/** The setting the newest answer is saved under. */
export const WEATHER_HOLD_KEY = 'drive.weatherHold';

/** The alert at a place, or null; never throws. */
export type WeatherLookup = (lat: number, lng: number) => Promise<DangerAlert | null>;

/** The weather reading at a place, or null; never throws. */
export type WeatherReadingLookup = (lat: number, lng: number) => Promise<WeatherReading | null>;

/** Where the newest answer is saved, so a relaunch mid-drive keeps it. */
export interface WeatherHold {
  read(): Promise<unknown>;
  write(series: WeatherSeries): Promise<void>;
  clear(): Promise<void>;
}

/** The newest answer, saved in `settings`. */
export function weatherHoldIn(db: Db): WeatherHold {
  const settings = createSettingsRepo(db);
  return {
    read: () => settings.get<unknown>(WEATHER_HOLD_KEY),
    write: (series) => settings.set(WEATHER_HOLD_KEY, series),
    async clear() {
      await settings.remove(WEATHER_HOLD_KEY);
    },
  };
}

export interface WeatherWatchDeps {
  now(): number;
  /** The series request's fetch (default the global one). */
  fetch?: FetchLike;
  /** Where the newest answer is saved (none: it is held in memory only). */
  hold?: WeatherHold;
  /** A reading lookup in place of the series request (a test seam): the alert and the tag come from it. */
  read?: WeatherReadingLookup;
  /** An alert-only lookup in place of the series request (no tag then); `read` wins when both are given. */
  lookup?: WeatherLookup;
  /** The phone's cached position, when the drive has no fix of its own yet. */
  lastPosition?: () => Promise<{ lat: number; lng: number } | null>;
  /** Each judgement (null: no alert), in order; a stopped watch reports nothing more. */
  onAlert(alert: DangerAlert | null): void;
  /** Each judgement's word for the drive's weather (never for one with no reading), before its alert. */
  onTag?(tag: DriveWeather): void;
}

export interface WeatherWatch {
  /** A drive row: its fix is the position, and the clock (and for a lookup seam the odometer) may make a request due. */
  onRow(row: { gnssValid: boolean; lat: number; lng: number }, distanceM: number): void;
  /** The road state at a moment and place: `{}` for a normal road, null when unknown (no serving answer). */
  roadAt(tsMs: number, lat: number, lng: number): RoadStamp | null;
  /** The title for a road state at a moment and place ("Slippery roads" in the cold), or null when it moves no line. */
  roadTitle(road: RoadStamp | null | undefined, tsMs: number, lat: number, lng: number): string | null;
  /** No more requests or answers (the drive ended). */
  stop(): void;
}

/** One watch per drive; the first request goes at once (once the saved answer and the position are read). */
export function createWeatherWatch(deps: WeatherWatchDeps): WeatherWatch {
  return deps.read !== undefined || deps.lookup !== undefined ? createLookupWatch(deps) : createSeriesWatch(deps);
}

type Position = { lat: number; lng: number };

const cell = (v: number): number => Math.round(v * 10);
const sameCell = (s: WeatherSeries, lat: number, lng: number): boolean => cell(s.lat) === cell(lat) && cell(s.lng) === cell(lng);

function createSeriesWatch(deps: WeatherWatchDeps): WeatherWatch {
  /** Newest first, one per cell. */
  const held: WeatherSeries[] = [];
  let stopped = false;
  let ready = false;
  let inFlight = false;
  let pos: Position | null = null;
  let lastAnsweredAt: number | null = null;
  let retryAt = 0;
  let failures = 0;
  let limited = 0;
  /** What the last judgement was made from: the answer and its step, or nothing. */
  let judged = 'none';
  /** The answer the last judgement was made from, or null. */
  let judgedSeries: WeatherSeries | null = null;
  /** Each answer's road state at the step it was last read at (it changes only with the step). */
  const roads = new WeakMap<WeatherSeries, { i: number; road: RoadStamp | null }>();
  let writes: Promise<void> = Promise.resolve();

  function keep(series: WeatherSeries): void {
    const i = held.findIndex((s) => sameCell(s, series.lat, series.lng));
    if (i >= 0) held.splice(i, 1);
    held.unshift(series);
    if (held.length > HELD_CELLS) held.length = HELD_CELLS;
  }

  /** The answers that serve at a moment and place: the place's own cell first, then the newest. */
  function serving(tsMs: number, lat: number, lng: number): WeatherSeries[] {
    const near = held.filter((s) => roadFresh(s, tsMs) && inRoadCell(s, lat, lng));
    return [...near.filter((s) => sameCell(s, lat, lng)), ...near.filter((s) => !sameCell(s, lat, lng))];
  }

  function due(now: number, at: Position): boolean {
    if (inFlight || now < retryAt) return false;
    if (lastAnsweredAt !== null && now - lastAnsweredAt < REQUEST_FLOOR_MS) return false;
    return !held.some((s) => sameCell(s, at.lat, at.lng) && now - s.fetchedAtMs < CELL_REFRESH_MS);
  }

  /**
   * The answer the judgement reads at a moment and place: the last one judged while it still serves
   * and the place's first serving answer is no newer, else that first one.
   */
  function judging(tsMs: number, lat: number, lng: number): WeatherSeries | null {
    const near = serving(tsMs, lat, lng);
    const first = near[0] ?? null;
    if (judgedSeries !== null && near.includes(judgedSeries) && first !== null && first.fetchedAtMs <= judgedSeries.fetchedAtMs) return judgedSeries;
    return first;
  }

  /** Tells the tag and the alert from the serving answer, when it or its step changed (or `force`). */
  function judge(now: number, force: boolean): void {
    if (pos === null) return;
    const s = judging(now, pos.lat, pos.lng);
    judgedSeries = s;
    const key = s === null ? 'none' : `${s.lat},${s.lng},${s.fetchedAtMs},${stepIndexAt(s.steps, now)}`;
    if (!force && key === judged) return;
    judged = key;
    const reading = s === null ? null : readingAt(s, now);
    const tag = driveWeatherOf(reading);
    if (tag !== null) {
      try {
        deps.onTag?.(tag);
      } catch {
        // The tag is a nicety: the alert still goes out.
      }
    }
    deps.onAlert(dangerFrom(reading));
  }

  function request(at: Position): void {
    inFlight = true;
    const sentAt = deps.now();
    void (async () => {
      let result: RoadSeriesResult;
      try {
        result = await fetchRoadSeries(at.lat, at.lng, { fetch: deps.fetch, now: deps.now });
      } catch {
        result = { kind: 'failed' };
      }
      inFlight = false;
      if (stopped) return;
      const now = deps.now();
      if (result.kind === 'ok') {
        const { series } = result;
        keep(series);
        lastAnsweredAt = sentAt;
        retryAt = 0;
        failures = 0;
        limited = 0;
        writes = writes.then(() => deps.hold?.write(series)).catch(() => {});
      } else if (result.kind === 'limited') {
        limited += 1;
        const wait = Math.min(LIMITED_BACKOFF_MAX_MS, LIMITED_BACKOFF_MS * 2 ** (limited - 1));
        retryAt = now + Math.max(wait, result.retryAfterMs ?? 0);
      } else {
        failures += 1;
        retryAt = now + (FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1] ?? 0);
      }
      judge(now, true);
    })();
  }

  function step(): void {
    if (!ready || stopped || pos === null) return;
    const now = deps.now();
    if (due(now, pos)) request(pos);
    judge(now, false);
  }

  void (async () => {
    try {
      const saved = (await deps.hold?.read()) ?? null;
      const series = reviveSeries(saved);
      if (series !== null && roadFresh(series, deps.now())) held.push(series);
      else if (saved !== null) writes = writes.then(() => deps.hold?.clear()).catch(() => {});
    } catch {
      // No saved answer: the first request asks.
    }
    let at: Position | null = null;
    try {
      at = pos ?? (await deps.lastPosition?.()) ?? null;
    } catch {
      at = null;
    }
    pos ??= at;
    ready = true;
    step();
  })();

  return {
    onRow(row) {
      if (stopped) return;
      if (row.gnssValid && Number.isFinite(row.lat) && Number.isFinite(row.lng)) pos = { lat: row.lat, lng: row.lng };
      step();
    },
    roadAt(tsMs, lat, lng) {
      for (const s of serving(tsMs, lat, lng)) {
        // A serving answer is fresh and covers the place, so its state follows from the step alone.
        const i = stepIndexAt(s.steps, tsMs);
        let memo = roads.get(s);
        if (memo === undefined || memo.i !== i) {
          memo = { i, road: roadStateAt(s, tsMs, lat, lng) };
          roads.set(s, memo);
        }
        if (memo.road !== null) return memo.road;
      }
      return null;
    },
    roadTitle(road, tsMs, lat, lng) {
      return roadTitleAt(judging(tsMs, lat, lng), tsMs, road);
    },
    stop() {
      stopped = true;
    },
  };
}

function createLookupWatch(deps: WeatherWatchDeps): WeatherWatch {
  const read: WeatherReadingLookup | null = deps.read ?? null;
  /** The alert, and the tag when the answer was a reading. */
  async function ask(lat: number, lng: number): Promise<{ alert: DangerAlert | null; tag: DriveWeather | null }> {
    if (read === null) return { alert: await (deps.lookup as WeatherLookup)(lat, lng), tag: null };
    const reading = await read(lat, lng);
    return { alert: dangerFrom(reading), tag: driveWeatherOf(reading) };
  }
  let stopped = false;
  let inFlight = false;
  let lastCheckAt: number | null = null;
  let lastLeg = 0;
  let fix: { lat: number; lng: number } | null = null;

  async function position(): Promise<{ lat: number; lng: number } | null> {
    if (fix !== null) return fix;
    try {
      return (await deps.lastPosition?.()) ?? null;
    } catch {
      return null;
    }
  }

  function check(): void {
    if (stopped || inFlight) return;
    inFlight = true;
    lastCheckAt = deps.now();
    void (async () => {
      let alert: DangerAlert | null = null;
      let tag: DriveWeather | null = null;
      let at: { lat: number; lng: number } | null = null;
      try {
        at = await position();
        if (at !== null) ({ alert, tag } = await ask(at.lat, at.lng));
      } catch {
        alert = null;
        tag = null;
      } finally {
        inFlight = false;
      }
      // With no position yet the check waits for the drive's first fix.
      if (at === null) {
        lastCheckAt = null;
        return;
      }
      if (stopped) return;
      if (tag !== null) {
        try {
          deps.onTag?.(tag);
        } catch {
          // The tag is a nicety: the alert still goes out.
        }
      }
      deps.onAlert(alert);
    })();
  }

  check();

  return {
    onRow(row, distanceM) {
      if (stopped) return;
      if (row.gnssValid && Number.isFinite(row.lat) && Number.isFinite(row.lng)) fix = { lat: row.lat, lng: row.lng };
      const leg = Math.floor(Math.max(0, distanceM) / WEATHER_REFETCH_DISTANCE_M);
      const now = deps.now();
      const dueByTime = lastCheckAt === null || now - lastCheckAt >= WEATHER_REFRESH_MS;
      const dueByDistance = leg > lastLeg;
      if (!dueByTime && !dueByDistance) return;
      if (inFlight) return;
      lastLeg = leg;
      check();
    },
    roadAt: () => null,
    roadTitle: () => null,
    stop() {
      stopped = true;
    },
  };
}
