/**
 * The hooks the Analytics tab and Home's tip card read (plan D6): local SQLite only. The radar's
 * centre number is the server Safety Rating (`useMySummary().data?.progress.safety_rating`), which
 * the screen reads itself.
 */
import { useMemo } from 'react';

import type { LocalDrive } from '@/data/queries/rows';
import { useDataSource } from '@/data/queries/context';
import { useScoredDrives, useWindowEvents } from '@/data/queries/analytics';
import type { Region } from '@/features/settings/maps';

import {
  coachWindow,
  COACH_DAYS,
  driveGrid,
  fitLines,
  personalBests,
  rangeStart,
  routeLines,
  scoredSince,
  trend,
  windowStart,
  windowSums,
  type CoachWindow,
  type DriveGrid,
  type MapPoint,
  type PersonalBests,
  type Range,
  type Trend,
  type WindowSums,
} from './model';

export interface CoachingData extends CoachWindow {
  /** The 30-day window's cutoff. */
  sinceMs: number;
  loading: boolean;
  error: boolean;
}

/** The last 30 days' sub-scores and advice (Home's tip card; the Analytics radar and summary). */
export function useCoaching(): CoachingData {
  const { now } = useDataSource();
  const sinceMs = windowStart(now(), COACH_DAYS);
  const drives = useScoredDrives(sinceMs);
  const events = useWindowEvents(sinceMs);
  // Until the events are in, nothing is scored: drives with no events yet would read as perfect.
  const result = useMemo(
    () => coachWindow(events.data ? (drives.data ?? []) : [], events.data ?? [], sinceMs),
    [drives.data, events.data, sinceMs]
  );
  return { ...result, sinceMs, loading: drives.isLoading || events.isLoading, error: drives.isError || events.isError };
}

export interface AnalyticsData {
  range: Range;
  /** The range's cutoff (now floored to the hour, minus 1, 7, 30 or 365 days). */
  sinceMs: number;
  /** The last 30 days, whatever the range. */
  coaching: CoachWindow;
  /** All time. */
  bests: PersonalBests;
  /** The range's metric sums. */
  sums: WindowSums;
  /** The range's drives by weekday × 3-hour band. */
  grid: DriveGrid;
  /** The range's Score, Events and Points over time (the Trend card). */
  trend: Trend;
  /** The range's scored drives, newest first (the Drives list; its length matches `sums.drives`). */
  drives: LocalDrive[];
  /** Every scored drive's route, all time, one line per privacy run (no "Wasn't driving" trips). */
  routes: MapPoint[][];
  /** Where the trip map opens (`fitRegion`); null with no routes. */
  region: Region | null;
  loading: boolean;
  error: boolean;
  refetch(): void;
}

/** Everything the Analytics tab draws, for the chosen range. */
export function useAnalytics(range: Range): AnalyticsData {
  const { now } = useDataSource();
  const at = now();
  const coachSince = windowStart(at, COACH_DAYS);
  const sinceMs = rangeStart(at, range);
  // The trend's axis ends with the current hour (the same window), so it recomputes once an hour, not every render.
  const hourEnd = windowStart(at, 0) + 3_599_999;
  const all = useScoredDrives(null);
  const events = useWindowEvents(coachSince);
  // The trend's Score needs every event of the range: the 30-day window's cover a day, week or
  // month (the same query); a year reads its own.
  const rangeEvents = useWindowEvents(range === 'year' ? sinceMs : coachSince);
  // A new window holds the last one's events until its own land, and a shorter window's would
  // leave a year's older drives looking perfect: the Score waits for the window's own events.
  const trendEvents = rangeEvents.isPlaceholderData ? null : (rangeEvents.data ?? null);

  const drives = all.data;
  // Until the events are in, nothing is scored: drives with no events yet would read as perfect.
  const coaching = useMemo(
    () => coachWindow(events.data ? (drives ?? []) : [], events.data ?? [], coachSince),
    [drives, events.data, coachSince]
  );
  const bests = useMemo(() => personalBests(drives ?? []), [drives]);
  const windowed = useMemo(() => {
    const list = drives ?? [];
    return { sums: windowSums(list, sinceMs), grid: driveGrid(list, sinceMs), drives: scoredSince(list, sinceMs) };
  }, [drives, sinceMs]);
  const trendData = useMemo(() => trend(drives ?? [], trendEvents, range, hourEnd), [drives, trendEvents, range, hourEnd]);
  // The map draws the same drives as every other card: scored ones, not "Wasn't driving".
  const map = useMemo(() => {
    const routes = routeLines((drives ?? []).flatMap((d) => (d.polyline ? [d.polyline] : [])));
    return { routes, region: fitLines(routes) };
  }, [drives]);

  const { refetch: refetchAll } = all;
  const { refetch: refetchEvents } = events;
  const { refetch: refetchRangeEvents } = rangeEvents;
  const refetch = useMemo(
    () => () => {
      void refetchAll();
      void refetchEvents();
      void refetchRangeEvents();
    },
    [refetchAll, refetchEvents, refetchRangeEvents]
  );

  return {
    range,
    sinceMs,
    coaching,
    bests,
    ...windowed,
    trend: trendData,
    ...map,
    loading: all.isLoading || events.isLoading || rangeEvents.isLoading,
    error: all.isError || events.isError || rangeEvents.isError,
    refetch,
  };
}
