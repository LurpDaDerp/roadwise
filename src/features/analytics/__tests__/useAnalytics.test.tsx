import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { createTestDb, seedEvents, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { createQueryClient } from '@/data/queries/client';
import { invalidateAfterSync } from '@/data/queries/invalidate';
import { encodeRuns } from '@/lib/polyline';

import { useAnalytics, useCoaching } from '../useAnalytics';

const DAY = 86_400_000;
// A Wednesday noon, local time.
const NOW = new Date(2026, 9, 14, 12, 0).getTime();
const now = () => NOW;
const route = encodeRuns([
  [
    { lat: 47.6, lng: -122.3 },
    { lat: 47.62, lng: -122.32 },
  ],
]);

let db: Db;
let client: QueryClient;

beforeEach(async () => {
  db = await createTestDb();
  client = createQueryClient();
  const trip = (n: number, daysAgo: number, over: Record<string, unknown> = {}) => ({
    client_trip_id: uuid(n),
    started_at: NOW - daysAgo * DAY,
    tz: 'UTC',
    status: 'scored' as const,
    miles: 5,
    duration_s: 600,
    points_net: 50,
    clean: 1 as const,
    polyline: route,
    ...over,
  });
  await seedTrips(db, [
    trip(1, 0.5, { clean: 0, counts_json: JSON.stringify({ hardBrake: 2 }), points_net: 20 }),
    trip(2, 3),
    trip(3, 10, { miles: 8, points_net: 140 }),
    trip(4, 100, { miles: 30, points_net: 90 }),
    // "Wasn't driving": counted nowhere, drawn nowhere.
    trip(5, 2, { status: 'not_driving', points_net: null }),
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: NOW - 0.5 * DAY },
    { id: uuid(22), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: NOW - 0.5 * DAY + 1 },
  ]);
});

afterEach(() => client.clear());

test('useCoaching: the last 30 days’ scores and advice', async () => {
  const { result } = await renderHook(() => useCoaching(), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  // 3 drives, 18 miles; braking 100 − 10·50/18 = 72.2 → 72 (fair).
  expect(result.current.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 18 });
  expect(result.current.scores.braking).toBe(72);
  expect(result.current.coaching).toMatchObject({ level: 'fair', axis: 'braking' });
  expect(result.current.error).toBe(false);
});

test('useAnalytics: range sums, grid and list; all-time bests and routes; 30-day coaching', async () => {
  const { result, rerender } = await renderHook(({ range }: { range: 'week' | 'year' }) => useAnalytics(range), {
    wrapper: wrapperFor(db, client, now),
    initialProps: { range: 'week' },
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.sums).toMatchObject({ drives: 2, miles: 10, hardBrake: 2, points: 70, cleanPct: 50 });
  expect(result.current.drives.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect(result.current.grid.total).toBe(2);
  expect(result.current.bests.mostPoints).toEqual({ value: 140, clientTripId: uuid(3) });
  expect(result.current.bests.longestClean).toEqual({ value: 30, clientTripId: uuid(4) });
  expect(result.current.coaching.totals.drives).toBe(3);
  expect(result.current.routes).toHaveLength(4);
  expect(result.current.region).toMatchObject({ latitude: 47.62, longitude: -122.3 });

  // The trend: one point per day with drives; today's two severe brakes over 5 mi
  // (100 − 10·50/5) take its Score to the floor.
  expect(result.current.trend.step).toBe('day');
  expect(result.current.trend.series.points.map((p) => [p.when, p.value])).toEqual([
    ['on Sunday', 50],
    ['today', 20],
  ]);
  expect(result.current.trend.series.score.map((p) => p.value)).toEqual([100, 0]);

  await rerender({ range: 'year' });
  await waitFor(() => expect(result.current.sums.drives).toBe(4));
  expect(result.current.range).toBe('year');
  // A year reads its own events (past the 30-day window): Score by month, July and October.
  await waitFor(() => expect(result.current.trend.series.score).toHaveLength(2));
  expect(result.current.trend.series.score.map((p) => p.when)).toEqual(['in July', 'in October 2026']);
});

test('while the window’s events are still loading, nothing is scored: drives alone never read as perfect', async () => {
  const queries = jest.requireActual<typeof import('@/data/queries/analytics')>('@/data/queries/analytics');
  const spy = jest.spyOn(queries, 'useWindowEvents').mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() } as never);
  try {
    const { result } = await renderHook(() => useAnalytics('week'), { wrapper: wrapperFor(db, client, now) });
    await waitFor(() => expect(result.current.drives).toHaveLength(2));
    expect(result.current.coaching.totals.drives).toBe(0);
    expect(Object.values(result.current.coaching.scores).some((s) => s === 100)).toBe(false);
    expect(result.current.coaching.coaching?.level).not.toBe('good');
    const coach = await renderHook(() => useCoaching(), { wrapper: wrapperFor(db, client, now) });
    await waitFor(() => expect(coach.result.current.loading).toBe(true));
    expect(coach.result.current.totals.drives).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test('a sync refreshes the analytics data', async () => {
  const { result } = await renderHook(() => useAnalytics('week'), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await seedTrips(db, [{ client_trip_id: uuid(9), started_at: NOW - DAY, tz: 'UTC', status: 'scored', miles: 2, points_net: 10 }]);
  await invalidateAfterSync(client);
  await waitFor(() => expect(result.current.sums.drives).toBe(3));
});
