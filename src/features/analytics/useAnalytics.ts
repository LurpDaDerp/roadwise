/**
 * The hooks the Analytics tab and Home's tip card read (plan D6): local SQLite only. The radar's
 * centre is the Safety Rating of the last 90 days, computed here with the scoring package's
 * arithmetic (the server's), so it is always the weighted average of the categories around it.
 */
import { useMemo } from 'react';

import { simplifyTrack } from '@/core/engine/privacy';
import type { LocalDrive } from '@/data/queries/rows';
import { useDataSource } from '@/data/queries/context';
import { useScoredDrives, useWindowEvents } from '@/data/queries/analytics';
import { useRoutePool } from '@/data/queries/drives';
import type { Region } from '@/features/settings/maps';

import {
  allTimeTotals,
  coachWindow,
  COACH_DAYS,
  driveGrid,
  fitLines,
  rangeStart,
  routeLines,
  scoredSince,
  trend,
  TREND_EVENT_DAYS,
  windowStart,
  windowSums,
  type CoachWindow,
  type DriveGrid,
  type AllTimeTotals,
  type MapPoint,
  type Range,
  type Trend,
  type WindowSums,
} from './model';

/** The all-trips map shows every route at once, too far out for detail under this (m): each run is drawn simplified to it. */
export const TRIPS_MAP_SIMPLIFY_M = 30;

/** One run for the overview map: its points within `TRIPS_MAP_SIMPLIFY_M` of the road it drew. */
function overviewRun(run: readonly MapPoint[]): MapPoint[] {
  return simplifyTrack(
    run.map((p) => ({ lat: p.latitude, lng: p.longitude })),
    TRIPS_MAP_SIMPLIFY_M
  ).map((q) => ({ latitude: q.lat, longitude: q.lng }));
}

export interface CoachingData extends CoachWindow {
  /** The 90-day window's cutoff. */
  sinceMs: number;
  loading: boolean;
  error: boolean;
}

/** The last 90 days' sub-scores, Safety Rating and advice (Home's tip card; the Analytics radar and summary). */
export function useCoaching(): CoachingData {
  const { now } = useDataSource();
  const at = now();
  const sinceMs = windowStart(at, COACH_DAYS);
  // The rating's moment moves with the hour, as the window's key does.
  const hourEnd = windowStart(at, 0) + 3_599_999;
  const drives = useScoredDrives(sinceMs);
  const events = useWindowEvents(sinceMs);
  // Until the events are in, nothing is scored: drives with no events yet would read as perfect.
  const result = useMemo(
    () => coachWindow(events.data ? (drives.data ?? []) : [], events.data ?? [], sinceMs, hourEnd),
    [drives.data, events.data, sinceMs, hourEnd]
  );
  return { ...result, sinceMs, loading: drives.isLoading || events.isLoading, error: drives.isError || events.isError };
}

export interface AnalyticsData {
  range: Range;
  /** The range's cutoff (now floored to the hour, minus 1, 7, 30 or 365 days). */
  sinceMs: number;
  /** The last 90 days, whatever the range: the radar's scores and centre, and the advice. */
  coaching: CoachWindow;
  /** All time: the longest clean drive and the clean drives (the All time card), the share of miles after dark (the time-of-day comment). */
  allTime: AllTimeTotals;
  /** The range's metric sums (the Driving card, Trends' clean share, the category sheets). */
  sums: WindowSums;
  /** Every scored drive, all time, by weekday × 3-hour band (When you drive and the time-of-day comment). */
  grid: DriveGrid;
  /** The range's Score and Events over time (the Trends card). */
  trend: Trend;
  /** Every scored drive not yet archived, newest first (the Drives list, which pages them ten at a time). */
  drives: LocalDrive[];
  /** Some scored drive is archived (past 183 days): an empty Drives list says "in the last 6 months". */
  archivedDrives: boolean;
  /**
   * Every scored drive's route, all time, one line per run (no "Wasn't driving" trips): the routes
   * the drives hold (the whole route where the phone recorded it, else the trimmed one), then the
   * route pool's (the archived drives' trimmed lines).
   */
  routes: MapPoint[][];
  /** Where the trip map opens (`fitRegion`); null with no routes. */
  region: Region | null;
  loading: boolean;
  error: boolean;
  refetch(): void;
}

/**
 * Everything the Analytics tab draws. The range drives only the sums (the Driving card, Trends'
 * clean share, the category sheets) and the trend; the grid, the map and the all-time card read
 * every scored drive, archived ones included (the map draws theirs from the route pool), and the
 * drive list every scored drive not archived.
 */
export function useAnalytics(range: Range): AnalyticsData {
  const { now } = useDataSource();
  const at = now();
  const coachSince = windowStart(at, COACH_DAYS);
  const sinceMs = rangeStart(at, range);
  // The trend's axis ends with the current hour (the same window), so it recomputes once an hour, not every render.
  const hourEnd = windowStart(at, 0) + 3_599_999;
  const all = useScoredDrives(null);
  const pool = useRoutePool();
  const events = useWindowEvents(coachSince);
  // The trend's Score looks back 90 days from each point, so it reads a year and 90 days of events
  // for every range: switching the range never waits on a new read.
  const rangeEvents = useWindowEvents(windowStart(at, TREND_EVENT_DAYS));
  // A new window (the next hour's) holds the last one's events until its own land: the Score waits
  // for the window's own events, so a drive is never scored without its events.
  const trendEvents = rangeEvents.isPlaceholderData ? null : (rangeEvents.data ?? null);

  const drives = all.data;
  // Until the events are in, nothing is scored: drives with no events yet would read as perfect.
  const coaching = useMemo(
    () => coachWindow(events.data ? (drives ?? []) : [], events.data ?? [], coachSince, hourEnd),
    [drives, events.data, coachSince, hourEnd]
  );
  // All time: the drive list (already newest first, paged by its card; an archived drive is in no
  // list), the grid and the totals (every drive, archived ones included).
  const lifetime = useMemo(() => {
    const list = drives ?? [];
    return {
      allTime: allTimeTotals(list),
      grid: driveGrid(list, null),
      drives: scoredSince(list, null).filter((d) => d.archived !== true),
      archivedDrives: list.some((d) => d.archived === true),
    };
  }, [drives]);
  // The range's time over the limit reads its speeding events (the year and 90 days' read holds every range's).
  const rangeEventList = rangeEvents.data;
  const sums = useMemo(() => windowSums(drives ?? [], sinceMs, rangeEventList ?? []), [drives, sinceMs, rangeEventList]);
  const trendData = useMemo(() => trend(drives ?? [], trendEvents, range, hourEnd), [drives, trendEvents, range, hourEnd]);
  // The map draws the same drives as every other card: scored ones, not "Wasn't driving", an
  // archived one's route from the pool (only scored drives' routes are pooled). Simplified (the
  // overview can't show what it drops), and the region fitted on what is drawn.
  const poolLines = pool.data;
  const map = useMemo(() => {
    const lines = [...(drives ?? []).flatMap((d) => (d.polyline ? [d.polyline] : [])), ...(poolLines ?? [])];
    const routes = routeLines(lines).map(overviewRun);
    return { routes, region: fitLines(routes) };
  }, [drives, poolLines]);

  const { refetch: refetchAll } = all;
  const { refetch: refetchPool } = pool;
  const { refetch: refetchEvents } = events;
  const { refetch: refetchRangeEvents } = rangeEvents;
  const refetch = useMemo(
    () => () => {
      void refetchAll();
      void refetchPool();
      void refetchEvents();
      void refetchRangeEvents();
    },
    [refetchAll, refetchPool, refetchEvents, refetchRangeEvents]
  );

  return {
    range,
    sinceMs,
    coaching,
    ...lifetime,
    sums,
    trend: trendData,
    ...map,
    loading: all.isLoading || pool.isLoading || events.isLoading || rangeEvents.isLoading,
    error: all.isError || pool.isError || events.isError || rangeEvents.isError,
    refetch,
  };
}
