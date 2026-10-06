/**
 * Telling the cache that SQLite moved. The writers (the finalizer, the sync runner, the restore,
 * the drive actions) announce themselves on the one change event (`@/data/events`); this listens.
 */
import type { QueryClient } from '@tanstack/react-query';

import { onDataChanged, type DataChange } from '@/data/events';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';

const ignore = () => undefined;

/** Everything this layer caches is now suspect. */
export async function invalidateAfterSync(queryClient: QueryClient, _change?: DataChange): Promise<void> {
  await Promise.all(QUERY_ROOTS.map((root) => queryClient.invalidateQueries({ queryKey: [root] }).catch(ignore)));
}

/** One drive changed: its detail, and every list and aggregate it appears in. */
export async function invalidateDrive(queryClient: QueryClient, clientTripId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.drive(clientTripId) }).catch(ignore),
    ...QUERY_ROOTS.filter((root) => root !== 'drive').map((root) => queryClient.invalidateQueries({ queryKey: [root] }).catch(ignore)),
  ]);
}

export type Unsubscribe = () => void;

export interface InvalidationSources {
  changes?: (listener: (change: DataChange) => void) => Unsubscribe;
}

/** Wire the change event to the cache. Returns one unsubscribe, safe to call twice. */
export function subscribeInvalidation(queryClient: QueryClient, sources: InvalidationSources = {}): Unsubscribe {
  const subscribe = sources.changes ?? onDataChanged;
  let off: Unsubscribe | null = subscribe((change) => {
    void invalidateAfterSync(queryClient, change);
  });
  return () => {
    off?.();
    off = null;
  };
}
