export { readScoredDrives, readWindowEvents, toDriveEvent, useScoredDrives, useWindowEvents } from '@/data/queries/analytics';
export { createQueryClient, DEFAULT_GC_MS, DEFAULT_STALE_MS } from '@/data/queries/client';
export { DataProvider, MissingDataProviderError, useDataSource, useDb, type DataSource } from '@/data/queries/context';
export {
  readDriveCount,
  readDriveDetail,
  readDriveHistory,
  readDrives,
  readRecentDrives,
  readRoutePolylines,
  readStatSums,
  useDriveCount,
  useDriveDetail,
  useDriveHistory,
  useRecentDrives,
  useRoutePolylines,
  useStatSums,
  type DriveCounts,
  type DriveStatus,
  type LocalDrive,
  type LocalDriveEvent,
} from '@/data/queries/drives';
export { invalidateAfterSync, invalidateDrive, subscribeInvalidation, type InvalidationSources, type Unsubscribe } from '@/data/queries/invalidate';
export { DRIVE_HISTORY_FILTERS, queryKeys, QUERY_ROOTS, type DriveHistoryFilter, type QueryRoot } from '@/data/queries/keys';
export {
  countEvents,
  EMPTY_COUNTS,
  EMPTY_SUMS,
  isListed,
  isScoredDrive,
  matchesHistoryFilter,
  parseBreakdown,
  parseCounts,
  parseResult,
  sumStats,
  toLocalDrive,
  toLocalDriveEvent,
} from '@/data/queries/rows';
export { markNotDriving, reportEvent, type DriveActionDeps } from '@/data/sync/driveActions';
