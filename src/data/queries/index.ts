export { readScoredDrives, readWindowEvents, SCORED_TRIP, toDriveEvent, useScoredDrives, useWindowEvents } from '@/data/queries/analytics';
export { createQueryClient, DEFAULT_GC_MS, DEFAULT_STALE_MS } from '@/data/queries/client';
export { DataProvider, MissingDataProviderError, useDataSource, useDb, type DataSource } from '@/data/queries/context';
export {
  readDriveCount,
  readDriveDetail,
  readDriveEvents,
  readDriveHistory,
  readDrives,
  readRecentDrives,
  readRoutePolylines,
  readRoutePool,
  readStatSums,
  useDriveCount,
  useDriveDetail,
  useDriveHistory,
  useRecentDrives,
  useRoutePolylines,
  useRoutePool,
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
  exposureOf,
  isListed,
  isScoredDrive,
  matchesHistoryFilter,
  parseCounts,
  parseResult,
  sumStats,
  toLocalDrive,
  toLocalDriveEvent,
} from '@/data/queries/rows';
export {
  hiddenByZone,
  middleOf,
  readSpotInputs,
  readSpotsView,
  readWatchSpots,
  SPOT_READ,
  toProblemSpot,
  useSpots,
  type ProblemSpot,
  type SpotInputs,
  type SpotsView,
} from '@/data/queries/spots';
export { markNotDriving, reportEvent, type DriveActionDeps } from '@/data/sync/driveActions';
