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
  windowStart,
  windowSums,
  type CoachWindow,
  type DriveGrid,
  type MapPoint,
  type PersonalBests,
  type Range,
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
  const result = useMemo(() => coachWindow(drives.data ?? [], events.data ?? [], sinceMs), [drives.data, events.data, sinceMs]);
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
  const all = useScoredDrives(null);
  const events = useWindowEvents(coachSince);

  const drives = all.data;
  const coaching = useMemo(() => coachWindow(drives ?? [], events.data ?? [], coachSince), [drives, events.data, coachSince]);
  const bests = useMemo(() => personalBests(drives ?? []), [drives]);
  const windowed = useMemo(() => {
    const list = drives ?? [];
    return { sums: windowSums(list, sinceMs), grid: driveGrid(list, sinceMs), drives: scoredSince(list, sinceMs) };
  }, [drives, sinceMs]);
  // The map draws the same drives as every other card: scored ones, not "Wasn't driving".
  const map = useMemo(() => {
    const routes = routeLines((drives ?? []).flatMap((d) => (d.polyline ? [d.polyline] : [])));
    return { routes, region: fitLines(routes) };
  }, [drives]);

  const { refetch: refetchAll } = all;
  const { refetch: refetchEvents } = events;
  const refetch = useMemo(
    () => () => {
      void refetchAll();
      void refetchEvents();
    },
    [refetchAll, refetchEvents]
  );

  return {
    range,
    sinceMs,
    coaching,
    bests,
    ...windowed,
    ...map,
    loading: all.isLoading || events.isLoading,
    error: all.isError || events.isError,
    refetch,
  };
}
