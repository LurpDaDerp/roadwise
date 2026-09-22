import type { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';

import type { Db } from '@/data/db/driver';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import { createQueryClient } from '@/data/queries/client';
import { useTrip, useTripEvents, useTrips, type TripDetail } from '@/data/queries/hooks';
import { queryKeys } from '@/data/queries/keys';
import {
  invalidateAfterSync,
  invalidateTrip,
  subscribeInvalidation,
  type Unsubscribe,
} from '@/data/queries/invalidate';
import { emitDataChanged, type ChangeSource, type DataChange } from '@/data/events';

const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);

let db: Db;
let client: QueryClient;
let wrapper: ReturnType<typeof wrapperFor>;
let detach: Unsubscribe | null;

const A = tripRow({
  client_trip_id: 'a',
  started_at: Date.UTC(2026, 0, 5, 12, 0, 0),
  duration_s: 1800,
  distance_m: 10 * MILE_M,
  score: 90,
});
const B = tripRow({
  client_trip_id: 'b',
  started_at: Date.UTC(2026, 0, 7, 12, 0, 0),
  duration_s: 3600,
  distance_m: 20 * MILE_M,
  score: 80,
});

beforeEach(async () => {
  db = await createTestDb();
  client = createQueryClient();
  wrapper = wrapperFor(db, client, () => NOW);
  detach = null;
});

afterEach(() => {
  detach?.();
  client.clear();
});

/** A stand-in for an emitter the host owns, so the wiring can be driven from a test. */
function fakeEmitter<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  let unsubscribed = 0;
  return {
    subscribe(listener: (...args: T) => void) {
      listeners.add(listener);
      return () => {
        unsubscribed += 1;
        listeners.delete(listener);
      };
    },
    emit(...args: T) {
      for (const listener of [...listeners]) listener(...args);
    },
    get size() {
      return listeners.size;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test('invalidateAfterSync refetches a mounted list, which then sees the new row', async () => {
  await seedTrips(db, [A]);
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toHaveLength(1);

  // What the sync runner does: write the row, then tell the cache.
  await seedTrips(db, [B]);
  expect(result.current.data).toHaveLength(1);

  await invalidateAfterSync(client);
  await waitFor(() => expect(result.current.data).toHaveLength(2));
  expect(result.current.data?.map((t) => t.clientTripId)).toEqual(['b', 'a']);
});

test.each<ChangeSource>(['enqueue', 'sync', 'hydrate', 'finalize'])(
  'a %s change refetches through the default wiring',
  async (source) => {
    await seedTrips(db, [A]);
    detach = subscribeInvalidation(client);
    const { result } = await renderHook(() => useTrips(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await seedTrips(db, [B]);
    // Delivered on a macrotask, after the transaction that wrote the row.
    emitDataChanged(
      source === 'sync' ? { source, result: { done: 1, failed: 0, deferred: 0 } } : { source }
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));
  }
);

test('a change marks the long-term score stale too', async () => {
  const changes = fakeEmitter<[DataChange]>();
  detach = subscribeInvalidation(client, { changes: changes.subscribe });
  client.setQueryData(queryKeys.longTermScore(), { latest: null, scoredDrives: 0, pendingDrives: 0 });
  changes.emit({ source: 'hydrate' });
  expect(client.getQueryState(queryKeys.longTermScore())?.isInvalidated).toBe(true);
  await invalidateTrip(client, 'a');
});

test('an injected change source is used in place of the default', async () => {
  const queue = fakeEmitter<[DataChange]>();
  await seedTrips(db, [A]);
  detach = subscribeInvalidation(client, { changes: queue.subscribe });
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await seedTrips(db, [B]);
  queue.emit({ source: 'enqueue' });

  await waitFor(() => expect(result.current.data).toHaveLength(2));
});

test('onTripChanged refreshes every open trip detail, because the trip count moved', async () => {
  await seedTrips(db, [A, B]);
  const engine = fakeEmitter<[string | undefined]>();
  detach = subscribeInvalidation(client, {
    changes: fakeEmitter<[DataChange]>().subscribe,
    onTripChanged: engine.subscribe,
  });

  const first = await renderHook(() => useTrip('a'), { wrapper });
  const second = await renderHook(() => useTrip('b'), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

  await db.execute('UPDATE trips SET score = 50 WHERE client_trip_id IN (?, ?)', ['a', 'b']);
  engine.emit('a');

  // `scoredTripCount` and `stage` ride on every TripDetail, so one finalize moves them all.
  await waitFor(() => expect(first.result.current.data?.trip.score).toBe(50));
  // Read 'b' from the cache rather than from its hook: RNTL drives one tree at a time, so the
  // second `renderHook`'s tree has not necessarily re-rendered yet. What is under test is that
  // the query refetched, which is what a mounted screen would then paint.
  await waitFor(() =>
    expect(client.getQueryData<TripDetail | null>(queryKeys.trip('b'))?.trip.score).toBe(50)
  );
  expect(second.result.current.isSuccess).toBe(true);
});

test('a trip change with no id falls back to invalidating everything', async () => {
  await seedTrips(db, [A, B]);
  const engine = fakeEmitter<[string | undefined]>();
  detach = subscribeInvalidation(client, {
    changes: fakeEmitter<[DataChange]>().subscribe,
    onTripChanged: engine.subscribe,
  });

  const { result } = await renderHook(() => useTrip('b'), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await db.execute('UPDATE trips SET score = 50 WHERE client_trip_id = ?', ['b']);
  engine.emit(undefined);

  await waitFor(() => expect(result.current.data?.trip.score).toBe(50));
});

test('invalidateTrip sweeps the trip root but only the named timeline', async () => {
  await seedTrips(db, [A, B]);
  const first = await renderHook(() => useTripEvents('a'), { wrapper });
  const second = await renderHook(() => useTripEvents('b'), { wrapper });
  const detail = await renderHook(() => useTrip('b'), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));

  // `invalidateQueries` marks its matches synchronously and clears the flag only once the
  // refetch lands, so the flags read before the await are the scope of the sweep.
  const pending = invalidateTrip(client, 'a');
  expect(client.getQueryState(queryKeys.tripEvents('a'))?.isInvalidated).toBe(true);
  // No other trip's timeline can have moved.
  expect(client.getQueryState(queryKeys.tripEvents('b'))?.isInvalidated).toBe(false);
  // But every trip's detail carries the scored-trip count, so the root is swept.
  expect(client.getQueryState(queryKeys.trip('b'))?.isInvalidated).toBe(true);
  await pending;
});

test('the unsubscribe detaches both sources and is safe to call twice', () => {
  const queue = fakeEmitter<[DataChange]>();
  const engine = fakeEmitter<[string | undefined]>();
  const off = subscribeInvalidation(client, {
    changes: queue.subscribe,
    onTripChanged: engine.subscribe,
  });
  expect(queue.size).toBe(1);
  expect(engine.size).toBe(1);

  off();
  off();

  expect(queue.size).toBe(0);
  expect(engine.size).toBe(0);
  expect(queue.unsubscribed).toBe(1);
  expect(engine.unsubscribed).toBe(1);
});

test('a wake after unsubscribing does not mark anything stale', async () => {
  const queue = fakeEmitter<[DataChange]>();
  await seedTrips(db, [A]);
  const off = subscribeInvalidation(client, { changes: queue.subscribe });
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  // `invalidateQueries` marks its matches synchronously, so the flag is the crisp signal for
  // "the wake reached the cache" — and the positive case is covered by the tests above.
  queue.emit({ source: 'enqueue' });
  expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(true);

  await waitFor(() => expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(false));
  off();
  queue.emit({ source: 'enqueue' });
  expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(false);
});
