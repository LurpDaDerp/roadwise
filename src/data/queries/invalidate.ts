/**
 * Telling the cache that SQLite moved.
 *
 * Four things change a row under a mounted screen: work being queued, the sync runner writing
 * back what the server answered, hydration restoring history from the server, and the drive host
 * finalizing a trip. None of them may import this module (the runner and the hydrator are below
 * the UI; the engine must stay free of React), so the wiring runs the other way — each announces
 * itself on the one change event (`@/data/events`) and this module listens.
 *
 * The change event is the default source because it already fires after the transaction that
 * wrote the row commits, and coalesces a burst into one macrotask. The host may still inject
 * `onTripChanged` to narrow a refresh to one trip it can name.
 */
import type { QueryClient } from '@tanstack/react-query';

import { onDataChanged, type DataChange } from '@/data/events';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';

/** Refetching a query whose statement is failing changes nothing here; the screen shows its error. */
const ignore = () => undefined;

/**
 * Roots refreshed only by some changes (T7 round 2, I2). Rewards are a server read of 8 selects on
 * an always-mounted card, and only a drain that actually settled something can have moved them
 * (the watermark): so only a `sync` change whose pass settled at least one item (`done > 0`)
 * refreshes them, and not again while the snapshot is under `REWARDS_REFRESH_MIN_MS` old (a
 * multi-pass drain emits several). Every other root refreshes on every change, as before.
 */
export const ROOT_SOURCES: Readonly<Partial<Record<(typeof QUERY_ROOTS)[number], readonly DataChange['source'][]>>> = {
  rewards: ['sync'],
};

/** A rewards snapshot younger than this is not refetched by a sync (no timer: judged at the event). */
export const REWARDS_REFRESH_MIN_MS = 60_000;

function rootWants(root: (typeof QUERY_ROOTS)[number], change: DataChange | undefined): boolean {
  const sources = ROOT_SOURCES[root];
  if (sources === undefined) return true;
  if (change === undefined || !sources.includes(change.source)) return false;
  return change.source !== 'sync' || (change.result?.done ?? 0) > 0;
}

/**
 * Everything this layer caches is now suspect. Called after a sync pass or a restore writes trips,
 * scores and day rows — every family at once, because one response can move all of them. `change`
 * is the event that caused it; a root in `ROOT_SOURCES` refreshes only for the changes it lists
 * (with no `change`, it does not refresh).
 */
export async function invalidateAfterSync(queryClient: QueryClient, change?: DataChange): Promise<void> {
  await Promise.all(
    QUERY_ROOTS.filter((root) => rootWants(root, change)).map((root) =>
      root === 'rewards'
        ? queryClient
            .invalidateQueries(
              {
                queryKey: [root],
                predicate: (query) => Date.now() - query.state.dataUpdatedAt >= REWARDS_REFRESH_MIN_MS,
              },
              { cancelRefetch: false }
            )
            .catch(ignore)
        : queryClient.invalidateQueries({ queryKey: [root] }).catch(ignore)
    )
  );
}

/**
 * One trip changed: the trip details, its own event timeline, and the lists and aggregates it
 * appears in. Cheaper than a full sweep when the engine finalizes a drive and names it — only
 * `tripEvents` is narrowed to the one id, since no other trip's timeline can have moved.
 *
 * The `['trip']` *root* is invalidated rather than the single key: `TripDetail` carries
 * `scoredTripCount` and `stage`, which every finalize changes for every trip. Only active
 * queries refetch, so a screen that is not mounted costs nothing.
 */
export async function invalidateTrip(
  queryClient: QueryClient,
  clientTripId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['trip'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: queryKeys.tripEvents(clientTripId) }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['trips'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['scoreDaily'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['insights'] }).catch(ignore),
    queryClient.invalidateQueries({ queryKey: ['longTermScore'] }).catch(ignore),
  ]);
}

export type Unsubscribe = () => void;

export interface InvalidationSources {
  /**
   * Subscribe to data changes. Defaults to `onDataChanged`, which fires when work is queued, after
   * every pass that settles something, after each page a restore commits, and when the host
   * finalizes a drive.
   */
  changes?: (listener: (change: DataChange) => void) => Unsubscribe;
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
  const subscribe = sources.changes ?? onDataChanged;
  const offs: Unsubscribe[] = [
    subscribe((change) => {
      void invalidateAfterSync(queryClient, change);
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
