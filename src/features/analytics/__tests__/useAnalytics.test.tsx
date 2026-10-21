import { act, renderHook, waitFor } from '@testing-library/react-native';
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

// Let every read land first (the drives and two event windows), so none re-renders a hook after its test.
afterEach(async () => {
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.clear();
});

test('useCoaching: the last 30 days’ scores, Safety Rating and advice', async () => {
  const { result } = await renderHook(() => useCoaching(), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  // 3 drives, 18 miles; braking 100 / (1 + 50/18/16) = 85.2 → 85 (good).
  expect(result.current.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 18, watchedMiles: 0 });
  expect(result.current.scores.braking).toBe(85);
  expect(result.current.scores.attention).toBeNull();
  expect(result.current.coaching).toMatchObject({ level: 'good', axis: null });
  // (6 × 100 + 85.2) / 7 over the five phone categories (Speed and Phone use double), ranked at 18 mi.
  expect(result.current.rating).toEqual({ rating: 97.9, ranked: true });
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

  // The trend by day. Score: the rating over each day's 30 days, from the first day they hold
  // 10 mi (Sunday: the drives of 10 and 3 days ago); today's two severe brakes take it to 97.9.
  expect(result.current.trend.step).toBe('day');
  expect(result.current.trend.series.score.map((p) => [p.when, p.value])).toEqual([
    ['on Sunday', 100],
    ['on Monday', 100],
    ['on Tuesday', 100],
    ['today', 98],
  ]);
  // Events per mile on each day with drives: none over 5 mi, then 2 over 5.
  expect(result.current.trend.series.events.map((p) => [p.when, p.value])).toEqual([
    ['on Sunday', 0],
    ['today', 0.4],
  ]);
  // Points: the running total, from the drive before the week (90 + 140) on.
  expect(result.current.trend.series.points.map((p) => p.value)).toEqual([230, 230, 230, 230, 280, 280, 280, 300]);
  // The radar's centre is the latest Score point.
  expect(Math.round(result.current.coaching.rating.rating!)).toBe(98);

  await rerender({ range: 'year' });
  await waitFor(() => expect(result.current.sums.drives).toBe(4));
  expect(result.current.range).toBe('year');
  // Score by month, wherever a month's 30 days hold 10 mi: July and October.
  await waitFor(() => expect(result.current.trend.series.score).toHaveLength(2));
  expect(result.current.trend.series.score.map((p) => p.when)).toEqual(['in July', 'in October 2026']);
});

test('the Trends card’s latest points are the total now, when the screen passes it', async () => {
  const { result } = await renderHook(() => useAnalytics('week', { pointsNow: 1000 }), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.trend.series.points.map((p) => p.value)).toEqual([230, 230, 230, 230, 280, 280, 280, 1000]);
});

test('every range reads the same year and 30 days of events: a wider range scores its older drives with their own at once', async () => {
  // Trip 4 (100 days ago, July) had a severe brake: braking 100 / (1 + 25/30/16) = 95.0, the rating (6 × 100 + 95.0) / 7 = 99.3.
  await seedEvents(db, [{ id: uuid(23), client_trip_id: uuid(4), type: 'hard_brake', tier: 'severe', started_at: NOW - 100 * DAY + 1 }]);
  // 374 days ago, before the year: 12 mi with a severe speeding, inside October 2025's 30 days.
  await seedTrips(db, [{ client_trip_id: uuid(6), started_at: NOW - 374 * DAY, tz: 'UTC', status: 'scored', miles: 12, duration_s: 900, points_net: 10 }]);
  await seedEvents(db, [{ id: uuid(24), client_trip_id: uuid(6), type: 'speeding', tier: 'severe', started_at: NOW - 374 * DAY + 1 }]);
  const julyScores: number[] = [];
  const { result, rerender } = await renderHook(
    ({ range }: { range: 'week' | 'year' }) => {
      const data = useAnalytics(range);
      if (range === 'year') for (const p of data.trend.series.score) if (p.when === 'in July') julyScores.push(p.value);
      return data;
    },
    { wrapper: wrapperFor(db, client, now), initialProps: { range: 'week' } }
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  await rerender({ range: 'year' });
  await waitFor(() => expect(result.current.trend.series.score).toHaveLength(3));
  // October 2025: speed 100 / (1 + 100/12/16) = 65.8 (×2), the rest 100: 90.2.
  expect(result.current.trend.series.score[0]).toMatchObject({ when: 'in October 2025', value: 90 });
  expect(result.current.trend.series.score[1]).toMatchObject({ when: 'in July', value: 99 });
  // Every render drew July at its true Score, never a perfect 100 without its events.
  expect(new Set(julyScores)).toEqual(new Set([99]));
});

test('while the window’s events are still loading, nothing is scored: drives alone never read as perfect', async () => {
  const queries = jest.requireActual<typeof import('@/data/queries/analytics')>('@/data/queries/analytics');
  const spy = jest.spyOn(queries, 'useWindowEvents').mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() } as never);
  // Both hooks unmount before the spy goes: a late query landing would otherwise re-render them
  // with the real hook, which has a different number of hooks inside.
  const mounted: { unmount(): void }[] = [];
  try {
    const analytics = await renderHook(() => useAnalytics('week'), { wrapper: wrapperFor(db, client, now) });
    mounted.push(analytics);
    const { result } = analytics;
    await waitFor(() => expect(result.current.drives).toHaveLength(2));
    expect(result.current.coaching.totals.drives).toBe(0);
    expect(Object.values(result.current.coaching.scores).some((s) => s === 100)).toBe(false);
    expect(result.current.coaching.coaching?.level).not.toBe('good');
    // Nor does the trend's Score: it waits for the range's events too.
    expect(result.current.trend.series.score).toEqual([]);
    const coach = await renderHook(() => useCoaching(), { wrapper: wrapperFor(db, client, now) });
    mounted.push(coach);
    await waitFor(() => expect(coach.result.current.loading).toBe(true));
    expect(coach.result.current.totals.drives).toBe(0);
  } finally {
    for (const m of mounted) await act(() => m.unmount());
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
