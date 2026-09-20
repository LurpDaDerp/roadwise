/**
 * The app's React Query client.
 *
 * Every query in this layer reads local SQLite, which changes only when this app writes to it.
 * That decides the defaults: **no retries** (a failing statement fails the same way a moment
 * later, and a retry ladder would only delay the error a screen needs to show), and no refetch
 * on focus or reconnect — freshness comes from `invalidateAfterSync` and the engine's
 * `onTripChanged`, which know exactly when a row moved. `staleTime` then only protects against
 * two screens mounting the same key in the same breath.
 */
import { QueryClient } from '@tanstack/react-query';

/** How long a cached read is served without going back to SQLite. */
export const DEFAULT_STALE_MS = 30_000;
/** How long an unobserved query is kept, so a back-navigation paints from cache. */
export const DEFAULT_GC_MS = 5 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: DEFAULT_STALE_MS,
        gcTime: DEFAULT_GC_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}
