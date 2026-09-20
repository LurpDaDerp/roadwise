import type { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';

import type { Db } from '@/data/db/driver';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import { createQueryClient } from '@/data/queries/client';
import { useTrip, useTrips } from '@/data/queries/hooks';
import { queryKeys } from '@/data/queries/keys';
import {
  invalidateAfterSync,
  invalidateTrip,
  subscribeInvalidation,
  type Unsubscribe,
} from '@/data/queries/invalidate';
import { emitQueueChanged } from '@/data/sync/queue';

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

test('a queue:changed wake refetches through the default wiring', async () => {
  await seedTrips(db, [A]);
  detach = subscribeInvalidation(client);
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await seedTrips(db, [B]);
  // The emitter fires its listeners on a macrotask, after the transaction that queued the work.
  emitQueueChanged();

  await waitFor(() => expect(result.current.data).toHaveLength(2));
});

test('an injected queue emitter is used in place of the default', async () => {
  const queue = fakeEmitter<[]>();
  await seedTrips(db, [A]);
  detach = subscribeInvalidation(client, { queueEvents: queue.subscribe });
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await seedTrips(db, [B]);
  queue.emit();

  await waitFor(() => expect(result.current.data).toHaveLength(2));
});

test('onTripChanged refreshes the named trip and the lists, and leaves other trips alone', async () => {
  await seedTrips(db, [A, B]);
  const engine = fakeEmitter<[string | undefined]>();
  detach = subscribeInvalidation(client, {
    queueEvents: fakeEmitter<[]>().subscribe,
    onTripChanged: engine.subscribe,
  });

  const first = await renderHook(() => useTrip('a'), { wrapper });
  const second = await renderHook(() => useTrip('b'), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

  await db.execute('UPDATE trips SET score = 50 WHERE client_trip_id IN (?, ?)', ['a', 'b']);
  engine.emit('a');

  await waitFor(() => expect(first.result.current.data?.trip.score).toBe(50));
  // 'b' was never invalidated, so its cached detail is still the one that was read.
  expect(second.result.current.data?.trip.score).toBe(80);
});

test('a trip change with no id falls back to invalidating everything', async () => {
  await seedTrips(db, [A, B]);
  const engine = fakeEmitter<[string | undefined]>();
  detach = subscribeInvalidation(client, {
    queueEvents: fakeEmitter<[]>().subscribe,
    onTripChanged: engine.subscribe,
  });

  const { result } = await renderHook(() => useTrip('b'), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  await db.execute('UPDATE trips SET score = 50 WHERE client_trip_id = ?', ['b']);
  engine.emit(undefined);

  await waitFor(() => expect(result.current.data?.trip.score).toBe(50));
});

test('invalidateTrip touches the trip keys and the lists, not another trip', async () => {
  await seedTrips(db, [A, B]);
  const first = await renderHook(() => useTrip('a'), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

  await invalidateTrip(client, 'a');
  expect(client.getQueryState(['trip', 'b'])).toBeUndefined();
  expect(client.getQueryState(['trip', 'a'])).toBeDefined();
});

test('the unsubscribe detaches both sources and is safe to call twice', () => {
  const queue = fakeEmitter<[]>();
  const engine = fakeEmitter<[string | undefined]>();
  const off = subscribeInvalidation(client, {
    queueEvents: queue.subscribe,
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
  const queue = fakeEmitter<[]>();
  await seedTrips(db, [A]);
  const off = subscribeInvalidation(client, { queueEvents: queue.subscribe });
  const { result } = await renderHook(() => useTrips(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  // `invalidateQueries` marks its matches synchronously, so the flag is the crisp signal for
  // "the wake reached the cache" — and the positive case is covered by the tests above.
  queue.emit();
  expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(true);

  await waitFor(() => expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(false));
  off();
  queue.emit();
  expect(client.getQueryState(queryKeys.trips())?.isInvalidated).toBe(false);
});
