/**
 * Query keys for the local drive data. Every key is namespaced by a root so a change event can
 * sweep a family with one prefix (`invalidateAfterSync`) and a screen can still name one drive.
 */
/** A history filter for the drives made in one paired car: `car:{uid}` (iPhone, 2 or more cars paired). */
export type CarHistoryFilter = `car:${string}`;
export type DriveHistoryFilter = 'all' | 'clean' | 'passenger' | CarHistoryFilter;
/** The filters every phone has (the car filters come and go with the paired cars). */
export const DRIVE_HISTORY_FILTERS: readonly DriveHistoryFilter[] = ['all', 'clean', 'passenger'];

const CAR_FILTER_PREFIX = 'car:';

/** The history filter for the drives in the car with `uid`. */
export const carHistoryFilter = (uid: string): CarHistoryFilter => `${CAR_FILTER_PREFIX}${uid}`;

/** The car uid a car filter names; null for any other filter (and for a car filter with no uid). */
export function carFilterUid(filter: DriveHistoryFilter): string | null {
  if (!filter.startsWith(CAR_FILTER_PREFIX)) return null;
  const uid = filter.slice(CAR_FILTER_PREFIX.length);
  return uid === '' ? null : uid;
}

export const queryKeys = {
  recentDrives: (limit: number) => ['drives', 'recent', limit] as const,
  driveHistory: (filter: DriveHistoryFilter) => ['drives', 'history', filter] as const,
  drive: (clientTripId: string) => ['drive', clientTripId] as const,
  /** The events of a list's drives (`ids`, comma-joined): one read for a whole list's scores. */
  driveEvents: (ids: string) => ['drives', 'events', ids] as const,
  statSums: (sinceMs: number | null) => ['stats', sinceMs] as const,
  driveCount: () => ['driveCount'] as const,
  routes: (sinceMs: number | null) => ['routes', sinceMs] as const,
  /** Which kinds of drive are archived (Drive history's empty titles). Under `drives`: every change refreshes it. */
  archivedKinds: () => ['drives', 'archived'] as const,
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
