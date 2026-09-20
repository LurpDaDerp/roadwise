export { createExpoDb, type Db, type DbResult } from '@/data/db/driver';
export { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';
export { SCHEMA_V1, SCHEMA_VERSION_TABLE } from '@/data/db/schema';

export { MissingTripError } from '@/data/db/errors';
export { createEventsRepo, type EventsRepo } from '@/data/db/events';
export {
  backoffSeconds,
  createQueueRepo,
  MAX_ATTEMPTS,
  RECLAIM_AFTER_S,
  type QueueRepo,
} from '@/data/db/queue';
export { createSamplesRepo, type SamplesRepo } from '@/data/db/samples';
export {
  createScoreDailyCacheRepo,
  type ScoreDailyCacheRepo,
} from '@/data/db/scoreDailyCache';
export { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
export { createTilesRepo, type TilesRepo } from '@/data/db/tiles';
export {
  assertTripExists,
  createTripsRepo,
  type TripListOptions,
  type TripsRepo,
} from '@/data/db/trips';

export type {
  EventPatch,
  EventRow,
  Flag,
  NewEvent,
  NewTrip,
  QueueItem,
  QueueStatus,
  SampleRow,
  ScoreDailyCache,
  ScoreDailyCacheRow,
  SettingRow,
  Tile,
  TileRow,
  TripPatch,
  TripRow,
  TripStatus,
  TripSyncState,
} from '@/data/db/types';
