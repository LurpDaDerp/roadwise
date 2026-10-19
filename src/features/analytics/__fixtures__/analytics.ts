import { drive, NOW } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/features/drives/model';

import { coach, driveGrid, fitLines, personalBests, rangeStart, scoredSince, trend, windowSums, type AxisScores, type Range } from '../model';
import type { AnalyticsData } from '../useAnalytics';

export { NOW };

export const SCORES: AxisScores = { speeding: 88, braking: 72, accel: 95, cornering: 100, phone: 60, clean: 50 };
export const NO_SCORES: AxisScores = { speeding: null, braking: null, accel: null, cornering: null, phone: null, clean: null };

const HOUR = 3_600_000;

/** `n` scored drives, one every `everyH` hours back from NOW, ids d0, d1, … (newest first). */
export function drives(n: number, everyH = 5, over: Partial<LocalDrive> = {}): LocalDrive[] {
  return Array.from({ length: n }, (_, i) =>
    drive({ clientTripId: `d${i}`, startedAt: NOW - (1 + i * everyH) * HOUR, endedAt: NOW - (1 + i * everyH) * HOUR + 24 * 60_000, ...over })
  );
}

const ROUTE = [
  { latitude: 40.7, longitude: -74 },
  { latitude: 40.71, longitude: -74.01 },
];

/** What `useAnalytics(range)` returns for the given drives, computed with the real model. */
export function analytics(list: readonly LocalDrive[], range: Range = 'week', over: Partial<AnalyticsData> = {}): AnalyticsData {
  const sinceMs = rangeStart(NOW, range);
  const totals = { drives: 4, cleanDrives: 2, miles: 48 };
  const routes = list.length > 0 ? [ROUTE] : [];
  return {
    range,
    sinceMs,
    coaching: { scores: SCORES, totals, coaching: coach(SCORES, totals) },
    bests: personalBests(list),
    sums: windowSums(list, sinceMs),
    grid: driveGrid(list, sinceMs),
    // No events: every Score point reads 100.
    trend: trend(list, [], range, NOW),
    drives: scoredSince(list, sinceMs),
    routes,
    region: fitLines(routes),
    loading: false,
    error: false,
    refetch: () => {},
    ...over,
  };
}

/** An empty account. */
export const empty = (over: Partial<AnalyticsData> = {}): AnalyticsData =>
  analytics([], 'week', {
    coaching: { scores: NO_SCORES, totals: { drives: 0, cleanDrives: 0, miles: 0 }, coaching: coach(NO_SCORES, { drives: 0, miles: 0 }) },
    ...over,
  });
