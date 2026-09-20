import type { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';

import type { Db } from '@/data/db/driver';
import {
  createTestDb,
  seedDay,
  seedEvents,
  seedTrips,
  wrapperFor,
} from '@/data/queries/__fixtures__/harness';
import { deductions, eventRow, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import { createQueryClient } from '@/data/queries/client';
import { MissingDataProviderError } from '@/data/queries/context';
import { useInsights, useScoreDaily, useTrip, useTripEvents, useTrips } from '@/data/queries/hooks';

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);

let db: Db;
let client: QueryClient;
let wrapper: ReturnType<typeof wrapperFor>;

const A = tripRow({
  client_trip_id: 'a',
  started_at: Date.UTC(2026, 0, 5, 12, 0, 0),
  duration_s: 1800,
  distance_m: 10 * MILE_M,
  score: 90,
  category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 4 })),
});
const B = tripRow({
  client_trip_id: 'b',
  started_at: Date.UTC(2026, 0, 7, 12, 0, 0),
  duration_s: 3600,
  distance_m: 20 * MILE_M,
  score: 80,
  category_deductions_json: JSON.stringify(deductions({ speeding: 10, phone: 10 })),
  incomplete: 1,
  sync_state: 'failed',
  sync_error: 'trip_too_old',
});
const C = tripRow({
  client_trip_id: 'c',
  started_at: Date.UTC(2026, 0, 12, 12, 0, 0),
  duration_s: 900,
  distance_m: 5 * MILE_M,
  score: 100,
  status: 'final',
  sync_state: 'synced',
  server_id: 'srv-c',
});
const RECORDING = tripRow({
  client_trip_id: 'live',
  started_at: Date.UTC(2026, 0, 20, 11, 0, 0),
  ended_at: null,
  status: 'recording',
  score: null,
  sync_state: 'local',
});
const DISCARDED = tripRow({
  client_trip_id: 'train',
  started_at: Date.UTC(2026, 0, 9, 12, 0, 0),
  status: 'discarded',
  score: null,
  sync_state: 'synced',
});

beforeEach(async () => {
  db = await createTestDb();
  client = createQueryClient();
  wrapper = wrapperFor(db, client, () => NOW);
});

afterEach(() => {
  client.clear();
});

describe('useTrips', () => {
  test('lists the visible trips newest first, with the recording and discarded rows left out', async () => {
    await seedTrips(db, [A, B, C, RECORDING, DISCARDED]);
    const { result } = await renderHook(() => useTrips(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((t) => t.clientTripId)).toEqual(['c', 'b', 'a']);
  });

  test('a discarded trip comes back only when the caller asks for it', async () => {
    await seedTrips(db, [A, DISCARDED]);
    const { result } = await renderHook(() => useTrips({ includeDiscarded: true }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((t) => t.clientTripId)).toEqual(['train', 'a']);
  });

  test('surfaces incomplete and the reason an upload was refused', async () => {
    await seedTrips(db, [B]);
    const { result } = await renderHook(() => useTrips(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]).toMatchObject({
      clientTripId: 'b',
      incomplete: true,
      syncState: 'failed',
      syncError: 'trip_too_old',
      pendingSync: false,
      band: 'good',
    });
  });

  test('a filter narrows the list, and the page is a page of the filtered list', async () => {
    await seedTrips(db, [A, B, C]);
    const { result } = await renderHook(() => useTrips({ category: 'speeding', limit: 1 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // A and B cost speeding points; C is clean. Newest first, one per page.
    expect(result.current.data?.map((t) => t.clientTripId)).toEqual(['b']);
  });

  test('two filters that differ only in key order share one cache entry', async () => {
    await seedTrips(db, [A]);
    const first = await renderHook(() => useTrips({ role: 'driver', limit: 5 }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    const second = await renderHook(() => useTrips({ limit: 5, role: 'driver' }), { wrapper });
    // Served from cache on the first render, with no second read of SQLite.
    expect(second.result.current.data?.map((t) => t.clientTripId)).toEqual(['a']);
  });
});

describe('useTrip', () => {
  test('a coached trip: the worst category, the learning stage and the trip count', async () => {
    await seedTrips(db, [A, B]);
    const { result } = await renderHook(() => useTrip('a'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      scoredTripCount: 2,
      stage: 'new',
      tipOutcome: 'coach',
      unscoredReason: null,
      trip: { clientTripId: 'a', worstCategory: 'speeding', score: 90 },
    });
  });

  test('at the third scored trip the driver is past the learning period', async () => {
    await seedTrips(db, [A, B, C]);
    const { result } = await renderHook(() => useTrip('a'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ scoredTripCount: 3, stage: 'experienced' });
  });

  test('a clean scored trip asks for the keep-it-up card, not a coaching tip', async () => {
    await seedTrips(db, [C]);
    const { result } = await renderHook(() => useTrip('c'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ tipOutcome: 'keep_it_up', unscoredReason: null });
  });

  test('an unscored trip shows the facts, and says why it has no score', async () => {
    const passenger = tripRow({
      client_trip_id: 'p',
      status: 'unscored',
      score: null,
      role: 'passenger',
    });
    await seedTrips(db, [passenger]);
    const { result } = await renderHook(() => useTrip('p'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      tipOutcome: 'facts_only',
      unscoredReason: 'passenger',
      scoredTripCount: 0,
      stage: 'new',
    });
  });

  test('a trip that is not there resolves to null rather than erroring', async () => {
    const { result } = await renderHook(() => useTrip('missing'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  test('with no id the query never runs', async () => {
    const { result } = await renderHook(() => useTrip(null), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.isPending).toBe(true);
    expect(client.getQueryData(['trip', ''])).toBeUndefined();
  });
});

describe('useTripEvents', () => {
  test('returns the timeline oldest first, with possible events marked', async () => {
    await seedTrips(db, [A]);
    await seedEvents(db, [
      eventRow({ id: 'e2', client_trip_id: 'a', started_at: A.started_at + 120_000 }),
      eventRow({
        id: 'e1',
        client_trip_id: 'a',
        started_at: A.started_at + 60_000,
        category: 'braking',
        status: 'possible',
        deduction: null,
        severity: '1.2',
      }),
    ]);
    const { result } = await renderHook(() => useTripEvents('a'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.current.data?.[0]).toMatchObject({
      category: 'braking',
      severity: 1.2,
      possible: true,
      affectsScore: false,
    });
    expect(result.current.data?.[1]).toMatchObject({ affectsScore: true, deduction: 6 });
  });

  test('with no id the query never runs', async () => {
    const { result } = await renderHook(() => useTripEvents(undefined), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.isPending).toBe(true);
  });
});

describe('useScoreDaily', () => {
  test('reads the cached days in range, oldest first, with their points', async () => {
    await seedDay(db, '2026-01-05', { day: '2026-01-05', safeDay: true, phoneFreeDay: true }, NOW);
    await seedDay(db, '2026-01-06', { day: '2026-01-06', goodDay: true }, NOW);
    await seedDay(db, '2026-01-30', { day: '2026-01-30', safeDay: true }, NOW);

    const { result } = await renderHook(
      () => useScoreDaily({ from: '2026-01-01', to: '2026-01-07' }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((d) => d.day)).toEqual(['2026-01-05', '2026-01-06']);
    expect(result.current.data?.[0]).toMatchObject({ safeDay: true, points: 75, updatedAt: NOW });
    expect(result.current.data?.[1]?.points).toBe(20);
  });
});

describe('useInsights', () => {
  test('aggregates the stored trips over the selected period', async () => {
    await seedTrips(db, [A, B, C, RECORDING, DISCARDED]);
    const { result } = await renderHook(() => useInsights('4w'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      period: '4w',
      to: NOW,
      enoughData: true,
      scoredTripsAllTime: 3,
      baselineSource: null,
      youVsYou: null,
    });
    expect(result.current.data?.totals).toMatchObject({ scoredTrips: 3, durationS: 6300 });
    expect(result.current.data?.categories[0]).toMatchObject({
      category: 'speeding',
      deduction: 16,
      per100Mi: 45.71,
      perHour: 9.14,
    });
  });

  test('a stored baseline in settings drives the you-vs-you card', async () => {
    await seedTrips(db, [A, B, C]);
    await db.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', [
      'insights.baseline',
      JSON.stringify({ medians: { speeding: 2, score: 95 }, computedAt: '2026-01-19' }),
    ]);

    const { result } = await renderHook(() => useInsights('4w'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.baselineSource).toBe('stored');
    expect(result.current.data?.youVsYou?.categories[0]).toMatchObject({
      key: 'speeding',
      current: 6,
      baseline: 2,
      direction: 'worse',
    });
  });
});

describe('the client and the provider', () => {
  test('local reads never retry and nothing polls', () => {
    // The "freshness comes from invalidation, not from polling" design rests on these three.
    expect(createQueryClient().getDefaultOptions().queries).toMatchObject({
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
  });

  test('a hook rendered without DataProvider throws a named error', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(renderHook(() => useTrips())).rejects.toBeInstanceOf(MissingDataProviderError);
    } finally {
      quiet.mockRestore();
    }
  });
})
