import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import { archiveDue, type Db } from '@/data/db';
import { createTestDb, seedEvents, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { readScoredDrives, readWindowEvents } from '@/data/queries/analytics';
import { createQueryClient } from '@/data/queries/client';
import { invalidateAfterSync } from '@/data/queries/invalidate';
import { encodeRuns } from '@/lib/polyline';

import { coachWindow, windowStart } from '../model';
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
    clean: 1 as const,
    polyline: route,
    slowdowns: 12,
    speedups: 12,
    turns: 10,
    limit_s: 300,
    moving_s: 500,
    ...over,
  });
  await seedTrips(db, [
    trip(1, 0.5, { clean: 0, counts_json: JSON.stringify({ hardBrake: 2 }) }),
    trip(2, 3),
    trip(3, 10, { miles: 8 }),
    trip(4, 100, { miles: 30 }),
    // "Wasn't driving": counted nowhere, drawn nowhere.
    trip(5, 2, { status: 'not_driving' }),
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

/** The hour the hooks rate as of: the end of the current hour (the window's key moves with it). */
const HOUR_END = windowStart(NOW, 0) + 3_599_999;

test('useCoaching: the last 90 days’ scores, Safety Rating and advice, as of the hour', async () => {
  const { result } = await renderHook(() => useCoaching(), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  // 3 drives, 18 miles (the 100-day-old one is out of the 90 days).
  expect(result.current.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 18, watchedMiles: 0 });
  const since = windowStart(NOW, 90);
  expect(result.current.sinceMs).toBe(since);
  const want = coachWindow(await readScoredDrives(db, since), await readWindowEvents(db, since), since, HOUR_END);
  expect(result.current.scores).toEqual(want.scores);
  expect(result.current.rating).toEqual(want.rating);
  // Two severe brakes in 36 slowdowns weigh on Braking alone; Attention has no DashPal miles.
  expect(result.current.scores.braking!).toBeLessThan(result.current.scores.acceleration!);
  expect(result.current.scores.attention).toBeNull();
  expect(result.current.rating.ranked).toBe(true);
  expect(result.current.error).toBe(false);
});

test('the all-trips map draws each run simplified to 30 m, keeping its ends and any bend wider than that', async () => {
  // A 2 km straight road sampled every 10 m, then a turn: 200 points, three that matter.
  const straight = Array.from({ length: 200 }, (_, i) => ({ lat: 47.6 + i * 0.00009, lng: -122.3 }));
  const bend = { lat: straight[199]!.lat, lng: -122.29 };
  await seedTrips(db, [
    { client_trip_id: uuid(7), started_at: NOW - DAY, tz: 'UTC', status: 'scored', miles: 2, duration_s: 300, polyline: encodeRuns([[...straight, bend]]) },
  ]);
  const { result } = await renderHook(() => useAnalytics('week'), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.routes).toHaveLength(5));
  const drawn = result.current.routes.find((r) => r.length !== 2)!;
  expect(drawn).toHaveLength(3);
  expect(drawn[0]).toMatchObject({ latitude: 47.6, longitude: -122.3 });
  expect(drawn[2]).toMatchObject({ latitude: bend.lat, longitude: bend.lng });
});

test('useAnalytics: range sums with their chances and the trend; all-time totals, grid, list and routes; 90-day coaching', async () => {
  const { result, rerender } = await renderHook(({ range }: { range: 'week' | 'year' }) => useAnalytics(range), {
    wrapper: wrapperFor(db, client, now),
    initialProps: { range: 'week' },
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.sums).toMatchObject({ drives: 2, miles: 10, hardBrake: 2, cleanPct: 50, slowdowns: 24, speedups: 24, turns: 20, limitS: 600, exposureEstimated: false });
  expect(result.current.sums).not.toHaveProperty('points');
  // The list and the grid are all time, whatever the range: every scored drive, newest first, never "Wasn't driving".
  const allTime = [uuid(1), uuid(2), uuid(3), uuid(4)];
  expect(result.current.drives.map((d) => d.clientTripId)).toEqual(allTime);
  expect(result.current.grid.total).toBe(4);
  // All time: the longest clean drive, and the three clean drives (the first one had hard brakes).
  expect(result.current.allTime).toEqual({ longestClean: { value: 30, clientTripId: uuid(4) }, cleanDrives: 3, nightPct: 0 });
  expect(result.current.coaching.totals.drives).toBe(3);
  expect(result.current.routes).toHaveLength(4);
  expect(result.current.region).toMatchObject({ latitude: 47.62, longitude: -122.3 });

  // The trend by day. Score: the rating as of each day's end, from the first day its 90 days hold
  // 10 mi (Sunday: the drives of 10 and 3 days ago); today's two severe brakes take it down.
  expect(result.current.trend.step).toBe('day');
  const score = result.current.trend.series.score;
  expect(score.map((p) => p.when)).toEqual(['on Sunday', 'on Monday', 'on Tuesday', 'today']);
  expect(score[3]!.value).toBeLessThan(score[2]!.value);
  // Events per mile on each day with drives: none over 5 mi, then 2 over 5.
  expect(result.current.trend.series.events.map((p) => [p.when, p.value])).toEqual([
    ['on Sunday', 0],
    ['today', 0.4],
  ]);
  expect(result.current.trend.series).not.toHaveProperty('points');
  // The radar's centre is the latest Score point.
  expect(Math.round(result.current.coaching.rating.rating!)).toBe(score[3]!.value);

  await rerender({ range: 'year' });
  await waitFor(() => expect(result.current.sums.drives).toBe(4));
  expect(result.current.range).toBe('year');
  expect(result.current.sums.cleanPct).toBe(75);
  // The range moves the sums and the trend only.
  expect(result.current.drives.map((d) => d.clientTripId)).toEqual(allTime);
  expect(result.current.grid.total).toBe(4);
  expect(result.current.allTime.cleanDrives).toBe(3);
  // Score by month, wherever the 90 days to a month's end hold 10 mi: July to October.
  await waitFor(() => expect(result.current.trend.series.score).toHaveLength(4));
  expect(result.current.trend.series.score.map((p) => p.when)).toEqual(['in July', 'in August', 'in September', 'in October 2026']);
});

test('the range’s time over the limit reads its own speeding events', async () => {
  await seedEvents(db, [{ id: uuid(25), client_trip_id: uuid(2), type: 'speeding', tier: 'minor', started_at: NOW - 3 * DAY + 1, duration_s: 40 }]);
  const { result } = await renderHook(() => useAnalytics('week'), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(result.current.sums.speedingS).toBeGreaterThan(0));
  expect(result.current.sums.speedingS).toBeLessThanOrEqual(40);
});

test('every range reads the same year and 90 days of events: a wider range scores its older drives with their own at once', async () => {
  await seedEvents(db, [{ id: uuid(23), client_trip_id: uuid(4), type: 'hard_brake', tier: 'severe', started_at: NOW - 100 * DAY + 1 }]);
  // 374 days ago, before the year: 12 mi with a severe speeding, inside October 2025's 90 days.
  await seedTrips(db, [{ client_trip_id: uuid(6), started_at: NOW - 374 * DAY, tz: 'UTC', status: 'scored', miles: 12, duration_s: 900, limit_s: 600, moving_s: 800 }]);
  await seedEvents(db, [{ id: uuid(24), client_trip_id: uuid(6), type: 'speeding', tier: 'severe', started_at: NOW - 374 * DAY + 1, duration_s: 60 }]);
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
  await waitFor(() => expect(result.current.trend.series.score.map((p) => p.when)).toContain('in October 2025'));
  expect(result.current.trend.series.score[0]).toMatchObject({ when: 'in October 2025' });
  // Every render drew July at one Score: never one without its events.
  expect(new Set(julyScores).size).toBe(1);
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
    await waitFor(() => expect(result.current.drives).toHaveLength(4));
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
  await seedTrips(db, [{ client_trip_id: uuid(9), started_at: NOW - DAY, tz: 'UTC', status: 'scored', miles: 2 }]);
  await invalidateAfterSync(client);
  await waitFor(() => expect(result.current.sums.drives).toBe(3));
});

test('past the 183 days a drive leaves the drive list but every all-time number still counts it, and the map draws its route from the pool', async () => {
  // A long clean drive 250 days ago, with its speeding event, inside the Year range.
  await seedTrips(db, [
    { client_trip_id: uuid(6), started_at: NOW - 250 * DAY, ended_at: NOW - 250 * DAY + 600_000, tz: 'UTC', status: 'scored', miles: 40, duration_s: 2400, clean: 0,
      counts_json: JSON.stringify({ speeding: 1 }), polyline: route, slowdowns: 30, speedups: 30, turns: 20, limit_s: 1200, moving_s: 2000 },
    { client_trip_id: uuid(7), started_at: NOW - 260 * DAY, ended_at: NOW - 260 * DAY + 600_000, tz: 'UTC', status: 'scored', miles: 45, duration_s: 2400, clean: 1,
      polyline: encodeRuns([[{ lat: 47.61, lng: -122.31 }, { lat: 47.63, lng: -122.33 }]]), slowdowns: 30, speedups: 30, turns: 20, limit_s: 1200, moving_s: 2000 },
  ]);
  await seedEvents(db, [
    { id: uuid(31), client_trip_id: uuid(6), type: 'speeding', tier: 'moderate', started_at: NOW - 250 * DAY + 60_000, duration_s: 20, lat: 47.6, lng: -122.3, measured_json: '{"speedMph":52,"limitMph":40,"overMphS":120}' },
  ]);
  const { result } = await renderHook(() => useAnalytics('year'), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.drives).toHaveLength(6));
  const before = result.current;
  expect(before.allTime.longestClean).toEqual({ value: 45, clientTripId: uuid(7) });

  await archiveDue(db, NOW);
  await invalidateAfterSync(client);
  await waitFor(() => expect(result.current.drives).toHaveLength(4));
  const after = result.current;
  // The list (and its "Drives · n") holds only the drives with a recap.
  expect(after.drives.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
  expect([before.archivedDrives, after.archivedDrives]).toEqual([false, true]);
  // Every all-time and Year number is the same.
  expect(after.allTime).toEqual({ ...before.allTime, longestClean: { value: 45, clientTripId: null } });
  expect(after.grid).toEqual(before.grid);
  expect(after.sums).toEqual(before.sums);
  expect(after.trend).toEqual(before.trend);
  expect(after.coaching).toEqual(before.coaching);
  // The map draws the same lines: the archived drives' routes now come from the pool.
  expect(after.routes).toHaveLength(before.routes.length);
  expect(after.routes).toEqual(expect.arrayContaining(before.routes));
  expect(before.routes).toEqual(expect.arrayContaining(after.routes));
  expect(after.region).toEqual(before.region);
});

