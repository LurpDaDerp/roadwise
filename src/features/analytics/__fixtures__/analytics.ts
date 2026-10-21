import { weightedScore } from '@scoring';

import { drive, NOW, result } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/features/drives/model';

import { coach, driveGrid, fitLines, personalBests, rangeStart, scoredSince, trend, windowSums, type AxisScores, type Range } from '../model';
import type { AnalyticsData } from '../useAnalytics';

export { NOW };

export const SCORES: AxisScores = { speed: 88, braking: 72, acceleration: 95, turning: 100, phone: 60, attention: 90 };
export const NO_SCORES: AxisScores = { speed: null, braking: null, acceleration: null, turning: null, phone: null, attention: null };
/** The Safety Rating of `SCORES`: their weighted average (Speed and Phone use double), 1 decimal. 653 / 8 = 81.6. */
export const SCORES_RATING = Math.round(weightedScore(SCORES)! * 10) / 10;

const HOUR = 3_600_000;
/** The points total after the newest drive; each older drive's answer holds 132 fewer. */
export const POINTS_TOTAL = 1240;

/**
 * `n` scored drives, one every `everyH` hours back from NOW, ids d0, d1, … (newest first). Each
 * carries the server's answer with the points total right after it: 1240 after d0, 1108 after d1, …
 */
export function drives(n: number, everyH = 5, over: Partial<LocalDrive> = {}): LocalDrive[] {
  return Array.from({ length: n }, (_, i) => {
    const base = result();
    return drive({
      clientTripId: `d${i}`,
      startedAt: NOW - (1 + i * everyH) * HOUR,
      endedAt: NOW - (1 + i * everyH) * HOUR + 24 * 60_000,
      result: { ...base, progress: { ...base.progress, points: Math.max(0, POINTS_TOTAL - 132 * i) } },
      ...over,
    });
  });
}

const ROUTE = [
  { latitude: 40.7, longitude: -74 },
  { latitude: 40.71, longitude: -74.01 },
];

/** What `useAnalytics(range)` returns for the given drives, computed with the real model. */
export function analytics(list: readonly LocalDrive[], range: Range = 'week', over: Partial<AnalyticsData> = {}): AnalyticsData {
  const sinceMs = rangeStart(NOW, range);
  const totals = { drives: 4, cleanDrives: 2, miles: 48, watchedMiles: 30 };
  const routes = list.length > 0 ? [ROUTE] : [];
  return {
    range,
    sinceMs,
    coaching: { scores: SCORES, rating: { rating: SCORES_RATING, ranked: true }, totals, coaching: coach(SCORES, totals) },
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
    coaching: {
      scores: NO_SCORES,
      rating: { rating: null, ranked: false },
      totals: { drives: 0, cleanDrives: 0, miles: 0, watchedMiles: 0 },
      coaching: coach(NO_SCORES, { drives: 0, miles: 0 }),
    },
    ...over,
  });
