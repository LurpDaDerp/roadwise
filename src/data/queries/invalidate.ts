/**
 * Telling the cache that SQLite moved.
 *
 * Two things change a row under a mounted screen: the sync runner writing back what
 * `finalize-trip` answered, and the engine finalizing a drive. Neither may import this module
 * (the runner is below the UI; the engine must stay free of React), so the wiring runs the other
 * way — the host calls `subscribeInvalidation` once and hands it the two sources.
 *
 * The queue's own `queue:changed` emitter is the default source, because it already fires after
 * the transaction that wrote the row commits and coalesces a batch into one macrotask. The
 * engine's finalize is injected as `onTripChanged` rather than imported, so this file's module
 * graph stops at `src/data`.
 */
import type { QueryClient } from '@tanstack/react-query';

import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';
import { onQueueChanged } from '@/data/sync/queue';

/** Refetching a query whose statement is failing changes nothing here; the screen shows its error. */
const ignore = () => undefined;

/**
 * Everything this layer caches is now suspect. Called after a sync pass writes trips, scores and
 * day rows back — all five families at once, because one finalize response can move all of them.
 */
export async function invalidateAfterSync(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    QUERY_ROOTS.map((root) => queryClient.invalidateQueries({ queryKey: [root] }).catch(ignore))
  );
}

/**
 * One trip changed: its own two keys, and the lists and aggregates it appears in. Cheaper than a
 * full sweep when the engine finalizes a drive and names it.
 */
export async function invalidateTrip(
  queryClient: QueryClient,
  clientTripId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.trip(clientTripId) }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: queryKeys.tripEvents(clientTripId) }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['trips'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['scoreDaily'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['insights'] }).catch(ignore),
  ]);
}

export type Unsubscribe = () => void;

export interface InvalidationSources {
  /**
   * Subscribe to the sync queue. Defaults to `onQueueChanged`, which fires when work is queued —
   * and, through the runner, after every pass that settles a trip.
   */
  queueEvents?: (listener: () => void) => Unsubscribe;
  /**
   * Subscribe to the engine finalizing a drive. The listener is given the trip's client id when
   * the host knows it, and invalidates everything when it does not.
   */
  onTripChanged?: (listener: (clientTripId?: string) => void) => Unsubscribe;
}

/**
 * Wire both sources to the cache. Returns one unsubscribe that detaches whatever was attached and
 * is safe to call twice — a screen unmounting during a drive must not leave a listener behind.
 */
export function subscribeInvalidation(
  queryClient: QueryClient,
  sources: InvalidationSources = {}
): Unsubscribe {
  const subscribeQueue = sources.queueEvents ?? onQueueChanged;
  const offs: Unsubscribe[] = [
    subscribeQueue(() => {
      void invalidateAfterSync(queryClient);
    }),
  ];

  if (sources.onTripChanged) {
    offs.push(
      sources.onTripChanged((clientTripId) => {
        void (clientTripId === undefined || clientTripId === ''
          ? invalidateAfterSync(queryClient)
          : invalidateTrip(queryClient, clientTripId));
      })
    );
  }

  return () => {
    while (offs.length > 0) offs.pop()?.();
  };
}
