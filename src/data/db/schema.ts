/**
 * The on-device schema. SQLite is the source of truth while a drive is recording and until the
 * upload queue drains, so these columns mirror the server tables (design §4.2) one-for-one in
 * snake_case: the upload payload is a rename-free projection of a `trips` row plus its
 * `trip_events`.
 *
 * Conventions:
 * - timestamps are epoch **milliseconds** stored as INTEGER (`Date.now()` round-trips exactly);
 * - booleans are INTEGER 0/1;
 * - anything the server holds as `jsonb` is a TEXT column named `*_json` holding `JSON.stringify`
 *   output, parsed at the repository edge;
 * - a statement per array entry — drivers prepare one statement at a time.
 */

/** Migration bookkeeping. Created before the version row is read, so it is not part of V1. */
export const SCHEMA_VERSION_TABLE =
  'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)';

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS trips (
    client_trip_id TEXT PRIMARY KEY NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    tz TEXT NOT NULL,
    distance_m REAL NOT NULL DEFAULT 0,
    duration_s REAL NOT NULL DEFAULT 0,
    role TEXT,
    role_confidence REAL,
    role_source TEXT,
    mode TEXT,
    camera_session INTEGER NOT NULL DEFAULT 0,
    score REAL,
    scoring_version TEXT,
    category_deductions_json TEXT,
    exposure REAL,
    data_quality TEXT,
    conditions_json TEXT,
    limit_coverage_pct REAL,
    start_label TEXT,
    end_label TEXT,
    start_geohash5 TEXT,
    end_geohash5 TEXT,
    polyline TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('recording', 'provisional', 'final', 'unscored', 'discarded')),
    sync_state TEXT NOT NULL DEFAULT 'local'
      CHECK (sync_state IN ('local', 'queued', 'uploading', 'synced', 'failed')),
    checkpoint_ts INTEGER,
    server_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS trip_events (
    id TEXT PRIMARY KEY NOT NULL,
    client_trip_id TEXT NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_s REAL NOT NULL DEFAULT 0,
    lat REAL,
    lng REAL,
    measured_json TEXT,
    severity TEXT,
    confidence REAL,
    context_json TEXT,
    deduction REAL,
    alert_shown INTEGER NOT NULL DEFAULT 0,
    corrected INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    source TEXT
  )`,

  // The 1 Hz feature rows for the active trip. Purged once the trace is exported, so the table
  // stays bounded; `row_json` is the native module's feature row verbatim.
  `CREATE TABLE IF NOT EXISTS samples (
    client_trip_id TEXT NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY (client_trip_id, ts)
  )`,

  `CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'inflight', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS speed_limit_tiles (
    tile_key TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    segments_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS score_daily_cache (
    day TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS inbox_cache (
    id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    read_at INTEGER
  )`,

  // The history list reads newest-first.
  'CREATE INDEX IF NOT EXISTS idx_trips_started_at ON trips (started_at DESC)',
  // Every event read is scoped to one trip.
  'CREATE INDEX IF NOT EXISTS idx_trip_events_client_trip_id ON trip_events (client_trip_id)',
  // Range reads while scoring a trip.
  'CREATE INDEX IF NOT EXISTS idx_samples_trip_ts ON samples (client_trip_id, ts)',
  // The uploader's "what is due now" query.
  'CREATE INDEX IF NOT EXISTS idx_sync_queue_due ON sync_queue (status, next_attempt_at)',
];
