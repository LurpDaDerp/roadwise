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
  /**
   * When the driver deleted this trip (§7.D D5). The row survives the delete because the server
   * still has to be told; every read excludes it. Null on a live trip.
   */
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

/** `created_at`/`updated_at` are stamped by the repository from the `now` it is given. */
export type NewTrip = Pick<TripRow, 'client_trip_id' | 'started_at' | 'tz' | 'status'> &
  Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

export type TripPatch = Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

/**
 * The six reasons D3 offers (§7.D D3), in the order they are read, and the words the
 * `trip-actions` contract expects on the wire.
 */
export const DISPUTE_REASONS = [
  'not_driver',
  'passenger_phone',
  'wrong_limit',
  'hazard',
  'phone_moved',
  'other',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/**
 * Where a report has got to (§9.9). `queued` is the optimistic local state written the moment
 * the driver confirms; the rest are the server's answers, applied by the sync handler.
 *
 * - `accepted` — inside the auto-accept guard-rails: the event is removed from the score.
 * - `denied` — recorded as feedback, beyond the allowance, and honestly said so.
 * - `window_closed` — the 14-day window had passed; nothing was recorded.
 * - `refused` — the server would not take it for some other stated reason (the event is not
 *   scored, the trip is not scored). The code is kept so support can read it.
 */
export type DisputeOutcome = 'queued' | 'accepted' | 'denied' | 'window_closed' | 'refused';

/** `trip_events.dispute_json`, parsed. Written by the D3 sheet, settled by the sync handler. */
export interface DisputeRecord {
  reason: DisputeReason;
  note: string | null;
  statedLimitMph: number | null;
  submittedAt: number;
  outcome: DisputeOutcome;
  /** The server's own `denied_reason` (`allowance_7d` / `allowance_30d`), never derived here. */
  deniedReason: string | null;
  /** Reports left inside the guard-rails, as the server counted them. Null until it answers. */
  remainingAllowance: number | null;
  /** The refusal code behind a `window_closed` or `refused` outcome. */
  code: string | null;
  decidedAt: number | null;
}

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
  /** The driver's report about this event and how it was resolved (§7.D D3). Null until reported. */
  dispute_json: string | null;
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
