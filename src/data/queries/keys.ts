/**
 * Query keys for the local drive data. Every key is namespaced by a root so a change event can
 * sweep a family with one prefix (`invalidateAfterSync`) and a screen can still name one drive.
 */
export type DriveHistoryFilter = 'all' | 'clean' | 'negative' | 'passenger';
export const DRIVE_HISTORY_FILTERS: readonly DriveHistoryFilter[] = ['all', 'clean', 'negative', 'passenger'];

export const queryKeys = {
  recentDrives: (limit: number) => ['drives', 'recent', limit] as const,
  driveHistory: (filter: DriveHistoryFilter) => ['drives', 'history', filter] as const,
  drive: (clientTripId: string) => ['drive', clientTripId] as const,
  statSums: (sinceMs: number | null) => ['stats', sinceMs] as const,
  driveCount: () => ['driveCount'] as const,
  routes: (sinceMs: number | null) => ['routes', sinceMs] as const,
};

/** Every root the data layer owns; a change event refreshes them all. */
export const QUERY_ROOTS = ['drives', 'drive', 'stats', 'driveCount', 'routes'] as const;
export type QueryRoot = (typeof QUERY_ROOTS)[number];
