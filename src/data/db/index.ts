export { createExpoDb, type Db, type DbResult } from '@/data/db/driver';
export { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';
export { SCHEMA_V1, SCHEMA_VERSION_TABLE } from '@/data/db/schema';

export { createEventsRepo, type EventsRepo } from '@/data/db/events';
export { backoffSeconds, createQueueRepo, MAX_ATTEMPTS, type QueueRepo } from '@/data/db/queue';
export { createSamplesRepo, type SamplesRepo } from '@/data/db/samples';
export { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
export { createTilesRepo, type TilesRepo } from '@/data/db/tiles';
export { createTripsRepo, type TripListOptions, type TripsRepo } from '@/data/db/trips';

export type {
  EventPatch,
  EventRow,
  Flag,
  NewEvent,
  NewTrip,
  QueueItem,
  QueueStatus,
  SampleRow,
  SettingRow,
  Tile,
  TileRow,
  TripPatch,
  TripRow,
  TripStatus,
  TripSyncState,
} from '@/data/db/types';
