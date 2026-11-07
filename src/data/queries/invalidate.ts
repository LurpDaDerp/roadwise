/**
 * Telling the cache that SQLite moved. The writers (the finalizer, the sync runner, the restore,
 * the drive actions) announce themselves on the one change event (`@/data/events`); this listens.
 */
import type { QueryClient } from '@tanstack/react-query';

import { onDataChanged, type DataChange } from '@/data/events';
import { queryKeys, QUERY_ROOTS } from '@/data/queries/keys';

const ignore = () => undefined;

/**
 * The settings-backed caches a wipe empties (saved and learned places, their suggestions and the
 * recap's prompt, the emergency contacts, Permit mode's settings). They are keyed by no uid.
 */
export const WIPE_RESET_ROOTS: readonly string[] = ['places', 'emergency', 'permit'];

/**
 * Everything this layer caches is now suspect, except after a spots recompute: it moved only the
 * spots, so only they refresh. A wipe also resets the settings-backed caches (`WIPE_RESET_ROOTS`)
 * to empty, so no screen paints the leaving driver's places or contacts from the cache.
 */
export async function invalidateAfterSync(queryClient: QueryClient, change?: DataChange): Promise<void> {
  if (change?.source === 'wipe') {
    await queryClient.resetQueries({ predicate: (q) => WIPE_RESET_ROOTS.includes(String(q.queryKey[0])) }).catch(ignore);
  }
  const roots = change?.source === 'spots' ? (['spots'] as const) : QUERY_ROOTS;
  await Promise.all(roots.map((root) => queryClient.invalidateQueries({ queryKey: [root] }).catch(ignore)));
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
