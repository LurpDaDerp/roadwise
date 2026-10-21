/**
 * The hooks the Analytics tab and Home's tip card read (plan D6): local SQLite only. The radar's
 * centre is the 30-day window's Safety Rating, computed here with the scoring package's arithmetic
 * (the server's), so it is always the weighted average of the categories around it. The points
 * total now comes from the server (`useMySummary`), which the screen reads and passes in.
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
  TREND_EVENT_DAYS,
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

/** The last 30 days' sub-scores, Safety Rating and advice (Home's tip card; the Analytics radar and summary). */
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
  /** The last 30 days, whatever the range: the radar's scores and centre, and the advice. */
  coaching: CoachWindow;
  /** All time. */
  bests: PersonalBests;
  /** The range's metric sums. */
  sums: WindowSums;
  /** The range's drives by weekday × 3-hour band. */
  grid: DriveGrid;
  /** The range's Score, Events and Points over time (the Trends card). */
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

export interface AnalyticsOptions {
  /** The driver's points total now (the server's): the Trends card's latest Points value. */
  pointsNow?: number | null;
}

/** Everything the Analytics tab draws, for the chosen range. */
export function useAnalytics(range: Range, { pointsNow = null }: AnalyticsOptions = {}): AnalyticsData {
  const { now } = useDataSource();
  const at = now();
  const coachSince = windowStart(at, COACH_DAYS);
  const sinceMs = rangeStart(at, range);
  // The trend's axis ends with the current hour (the same window), so it recomputes once an hour, not every render.
  const hourEnd = windowStart(at, 0) + 3_599_999;
  const all = useScoredDrives(null);
  const events = useWindowEvents(coachSince);
  // The trend's Score looks back 30 days from each point, so it reads a year and 30 days of events
  // for every range: switching the range never waits on a new read.
  const rangeEvents = useWindowEvents(windowStart(at, TREND_EVENT_DAYS));
  // A new window (the next hour's) holds the last one's events until its own land: the Score waits
  // for the window's own events, so a drive is never scored without its events.
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
  const trendData = useMemo(() => trend(drives ?? [], trendEvents, range, hourEnd, { pointsNow }), [drives, trendEvents, range, hourEnd, pointsNow]);
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
