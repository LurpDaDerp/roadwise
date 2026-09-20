/**
 * Typed shapes for the rows in `schema.ts`.
 *
 * These mirror the stored columns exactly — same snake_case names, `*_json` columns left as the
 * TEXT they are — so the upload payload the sync layer builds is a projection of a row rather
 * than a translation of one. Timestamps are epoch milliseconds; 0/1 columns are typed `Flag`.
 */

export type Flag = 0 | 1;

export type TripStatus = 'recording' | 'provisional' | 'final' | 'unscored' | 'discarded';
export const TRIP_STATUSES: readonly TripStatus[] = [
  'recording',
  'provisional',
  'final',
  'unscored',
  'discarded',
];

export type TripSyncState = 'local' | 'queued' | 'uploading' | 'synced' | 'failed';
export const TRIP_SYNC_STATES: readonly TripSyncState[] = [
  'local',
  'queued',
  'uploading',
  'synced',
  'failed',
];

export type QueueStatus = 'pending' | 'inflight' | 'done' | 'failed';
export const QUEUE_STATUSES: readonly QueueStatus[] = ['pending', 'inflight', 'done', 'failed'];

export interface TripRow {
  client_trip_id: string;
  started_at: number;
  ended_at: number | null;
  tz: string;
  distance_m: number;
  duration_s: number;
  role: string | null;
  role_confidence: number | null;
  role_source: string | null;
  mode: string | null;
  camera_session: Flag;
  score: number | null;
  scoring_version: string | null;
  category_deductions_json: string | null;
  exposure: number | null;
  data_quality: string | null;
  conditions_json: string | null;
  limit_coverage_pct: number | null;
  start_label: string | null;
  end_label: string | null;
  start_geohash5: string | null;
  end_geohash5: string | null;
  polyline: string | null;
  status: TripStatus;
  sync_state: TripSyncState;
  /** How far the recorder has durably written, so a crash resumes rather than restarts. */
  checkpoint_ts: number | null;
  /**
   * The trip was finalized by crash recovery from its last checkpoint, not by the engine that
   * recorded it (§19.1): its tail past the checkpoint may be missing, it had no alerts, and its
   * `duration_s` is the wall span with no gap-merge pause subtracted.
   */
  incomplete: Flag;
  /** The server's `trips.id`, once `finalize-trip` has accepted the upload. */
  server_id: string | null;
  /**
   * The `code` of the 400 that refused this trip's upload for good, so the history screen can say
   * why. Set together with `sync_state = 'failed'`; cleared when an upload finally succeeds.
   */
  sync_error: string | null;
  created_at: number;
  updated_at: number;
}

/** `created_at`/`updated_at` are stamped by the repository from the `now` it is given. */
export type NewTrip = Pick<TripRow, 'client_trip_id' | 'started_at' | 'tz' | 'status'> &
  Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

export type TripPatch = Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

export interface EventRow {
  id: string;
  client_trip_id: string;
  category: string;
  started_at: number;
  duration_s: number;
  lat: number | null;
  lng: number | null;
  measured_json: string | null;
  severity: string | null;
  confidence: number | null;
  context_json: string | null;
  deduction: number | null;
  alert_shown: Flag;
  corrected: Flag;
  status: string | null;
  source: string | null;
}

export type NewEvent = Pick<EventRow, 'id' | 'client_trip_id' | 'category' | 'started_at'> &
  Partial<EventRow>;

export type EventPatch = Partial<Omit<EventRow, 'id' | 'client_trip_id'>>;

export interface SampleRow {
  client_trip_id: string;
  ts: number;
  row_json: string;
}

export interface QueueItem {
  id: number;
  kind: string;
  payload_json: string;
  /** Unique; the server dedupes on it, so re-enqueueing the same work is a no-op. */
  idempotency_key: string;
  status: QueueStatus;
  /** Failed attempts so far; a successful one does not count. Drives the backoff ladder. */
  attempts: number;
  next_attempt_at: number;
  /** Set when `nextDue` claims the item, cleared when the attempt closes out. */
  claimed_at: number | null;
  /**
   * When this item's large object (a trip's trace) reached Storage, so a retry after a crash
   * between the upload and the call that follows does not send the file again. Null until it has.
   */
  trace_uploaded_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface TileRow {
  tile_key: string;
  expires_at: number;
  segments_json: string;
}

/** A tile with its segments already parsed — what callers of the tiles repo actually want. */
export interface Tile<T> {
  tile_key: string;
  expires_at: number;
  segments: T;
}

export interface SettingRow {
  key: string;
  value_json: string;
}

export interface ScoreDailyCacheRow {
  /** Local calendar date, `YYYY-MM-DD` — the key the server's day evaluation is filed under. */
  day: string;
  payload_json: string;
  updated_at: number | null;
}

/** A cached day with its payload already parsed — what callers of the cache repo want. */
export interface ScoreDailyCache<T> {
  day: string;
  payload: T;
  updated_at: number | null;
}
