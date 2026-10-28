/**
 * Query keys for the local drive data. Every key is namespaced by a root so a change event can
 * sweep a family with one prefix (`invalidateAfterSync`) and a screen can still name one drive.
 */
export type DriveHistoryFilter = 'all' | 'clean' | 'passenger';
export const DRIVE_HISTORY_FILTERS: readonly DriveHistoryFilter[] = ['all', 'clean', 'passenger'];

export const queryKeys = {
  recentDrives: (limit: number) => ['drives', 'recent', limit] as const,
  driveHistory: (filter: DriveHistoryFilter) => ['drives', 'history', filter] as const,
  drive: (clientTripId: string) => ['drive', clientTripId] as const,
  /** The events of a list's drives (`ids`, comma-joined): one read for a whole list's scores. */
  driveEvents: (ids: string) => ['drives', 'events', ids] as const,
  statSums: (sinceMs: number | null) => ['stats', sinceMs] as const,
  driveCount: () => ['driveCount'] as const,
  routes: (sinceMs: number | null) => ['routes', sinceMs] as const,
  /** The route pool's lines (archived drives' routes, with no drive and no date). */
  routePool: () => ['routes', 'pool'] as const,
  windowEvents: (sinceMs: number | null) => ['stats', 'events', sinceMs] as const,
  scoredDrives: (sinceMs: number | null) => ['stats', 'drives', sinceMs] as const,
  /** The problem spots view (Analytics' card and sheet). */
  spots: () => ['spots'] as const,
};

/** Every root the data layer owns; a change event refreshes them all (a `spots` change only `spots`). */
export const QUERY_ROOTS = ['drives', 'drive', 'stats', 'driveCount', 'routes', 'spots'] as const;
export type QueryRoot = (typeof QUERY_ROOTS)[number];
