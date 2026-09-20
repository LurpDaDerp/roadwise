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
    -- Finalized by crash recovery from the last checkpoint rather than by the engine (§19.1).
    incomplete INTEGER NOT NULL DEFAULT 0,
    server_id TEXT,
    -- Why the upload was refused for good: the error code from the server's 400, shown to the
    -- driver beside a failed trip. NULL on every trip whose upload has not been refused.
    sync_error TEXT,
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
    -- When the item was claimed for upload. A crash mid-upload would leave it 'inflight'
    -- forever otherwise; reclaimInflight uses this to hand a stale claim back.
    claimed_at INTEGER,
    -- When this item's large object (a trip's trace) reached Storage. The uploader records it
    -- the moment the object is there, so a crash between the upload and the call that follows
    -- does not send the file a second time. NULL until it has, and on items with no object.
    trace_uploaded_at INTEGER,
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

  // The server's day evaluation (§9.9), as `finalize-trip` returned it, so the home screen can
  // show today's badges offline. `day` is the local calendar date, `YYYY-MM-DD`.
  `CREATE TABLE IF NOT EXISTS score_daily_cache (
    day TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER
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
  // `samples` has no index of its own: its primary key (client_trip_id, ts) already serves the
  // range reads, and a second B-tree would be maintained on every 1 Hz insert for nothing.
  // The uploader's "what is due now" query.
  'CREATE INDEX IF NOT EXISTS idx_sync_queue_due ON sync_queue (status, next_attempt_at)',
];

/**
 * V2 — what M2's trip screens need, as three added columns.
 *
 * They were first written into `SCHEMA_V1` on the grounds that v1 had never shipped. That was
 * true of the app and false of the two development builds, whose databases are recorded at
 * version 1: `migrate` would have found nothing newer to run and the first read of one of these
 * columns would have thrown. Worse, `sync_queue.owner_uid` is a *guard* — a database without it
 * reads null for every item, which is exactly the "any session may send this" case the column
 * exists to refuse. So they ship as a version of their own, and V1 is back to what it was.
 *
 * `ALTER TABLE … ADD COLUMN` on a nullable column with no default rewrites no rows in SQLite,
 * so this is instant on any database a phone holds.
 */
export const SCHEMA_V2: readonly string[] = [
  // When the driver deleted this trip (§7.D D5). The row is kept rather than dropped because the
  // delete is owed to the server: the delete-trip queue item sits here until it drains, and the
  // runner reads this column to decide that a queued trace is no longer worth uploading. Every
  // list and every detail read excludes a row with a value here, so the trip is gone the instant
  // the driver confirms, offline included. NULL on a live trip.
  'ALTER TABLE trips ADD COLUMN deleted_at INTEGER',

  // The driver's report about this event (§7.D D3, §9.9): reason, note, statedLimitMph,
  // submittedAt, outcome, deniedReason, remainingAllowance, decidedAt. The status column alone
  // cannot carry the outcomes D3 has to tell apart — accepted and removed from the score,
  // recorded but beyond the auto-accept allowance, refused because the window closed, and never
  // sent — and the queue item that carried the report is purged once it settles, so the record
  // lives with the event it is about and goes with it when the trip is deleted.
  'ALTER TABLE trip_events ADD COLUMN dispute_json TEXT',

  // The signed-in user this work belongs to, stamped when it was queued. One device holds one
  // database, so without this column user A's queued dispute -- free-text note and all -- could
  // be posted under user B's token. Every row that predates this migration is left NULL, and the
  // runner refuses an item it cannot attribute rather than sending it under whoever is signed in.
  'ALTER TABLE sync_queue ADD COLUMN owner_uid TEXT',
];
