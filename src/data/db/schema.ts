/**
 * The on-device schema. SQLite is the source of truth for the user's own drives (offline-first,
 * plan §5): a drive is recorded here, scored here as an estimate, uploaded from here, and the
 * server's answer is written back here.
 *
 * Conventions:
 * - timestamps are epoch **milliseconds** stored as INTEGER;
 * - booleans are INTEGER 0/1;
 * - anything structured is a TEXT column named `*_json` holding `JSON.stringify` output;
 * - a statement per array entry — drivers prepare one statement at a time.
 *
 * Versions 1 and 2 are the v2 app's (never shipped to users). Version 3 drops the v2 trip tables
 * and creates the v3 ones; `settings` and `speed_limit_tiles` survive untouched.
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
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trip_events (
    id TEXT PRIMARY KEY NOT NULL,
    client_trip_id TEXT NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL
  )`,
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
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    claimed_at INTEGER,
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
];

/** v2's additions; kept only so a v2 development database steps through to v3. */
export const SCHEMA_V2: readonly string[] = [];

/**
 * V3 — the v3 trip tables (plan §5, §10). The v2 trip tables are dropped outright: no user ever
 * held one, and a v2 development build's rows do not fit the v3 shape.
 */
export const SCHEMA_V3: readonly string[] = [
  'DROP TABLE IF EXISTS score_daily_cache',
  'DROP TABLE IF EXISTS inbox_cache',
  'DROP TABLE IF EXISTS samples',
  'DROP TABLE IF EXISTS trip_events',
  'DROP TABLE IF EXISTS sync_queue',
  'DROP TABLE IF EXISTS trips',

  `CREATE TABLE trips (
    client_trip_id TEXT PRIMARY KEY NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    tz TEXT NOT NULL,
    local_day TEXT,
    miles REAL NOT NULL DEFAULT 0,
    safe_miles REAL NOT NULL DEFAULT 0,
    night_miles REAL NOT NULL DEFAULT 0,
    duration_s REAL NOT NULL DEFAULT 0,
    dms_on INTEGER NOT NULL DEFAULT 0,
    dms_face_seen INTEGER NOT NULL DEFAULT 0,
    -- The raw first/last fix (4 dp), for the server's merge and loop checks only.
    start_lat REAL, start_lng REAL, end_lat REAL, end_lng REAL,
    -- Already privacy-trimmed (zones + first/last 0.25 mi); what maps and share cards draw.
    polyline TEXT,
    from_label TEXT,
    to_label TEXT,
    max_speed_mph REAL NOT NULL DEFAULT 0,
    integrity_json TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('recording', 'pending', 'scored', 'unscored', 'not_driving', 'merged', 'failed')),
    -- The local estimate (scoreDrive with the cached context) until the server answers.
    points_net INTEGER,
    estimate INTEGER NOT NULL DEFAULT 1,
    breakdown_json TEXT,
    clean INTEGER,
    -- {speeding, pickups, handlingS, hardBrake, hardAccel, hardCorner, eyesOff, drowsy} of active events.
    counts_json TEXT,
    reason TEXT,
    merged_into TEXT,
    result_json TEXT,
    server_id TEXT,
    sync_error TEXT,
    -- The last row the recorder made durable (crash recovery resumes from here).
    checkpoint_ts INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE trip_events (
    id TEXT PRIMARY KEY NOT NULL,
    client_trip_id TEXT NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    tier TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_s REAL NOT NULL DEFAULT 0,
    units INTEGER,
    stopped_in_traffic INTEGER NOT NULL DEFAULT 0,
    lat REAL,
    lng REAL,
    measured_json TEXT,
    penalty INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    dispute_status TEXT NOT NULL DEFAULT 'none'
      CHECK (dispute_status IN ('none', 'pending', 'accepted', 'rejected')),
    dispute_reason TEXT,
    dispute_message TEXT
  )`,

  // The 1 Hz rows of the drive being recorded, for crash recovery. Purged at finalize.
  `CREATE TABLE samples (
    client_trip_id TEXT NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY (client_trip_id, ts)
  )`,

  `CREATE TABLE sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'inflight', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    claimed_at INTEGER,
    owner_uid TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,

  'CREATE INDEX idx_trips_started_at ON trips (started_at DESC)',
  'CREATE INDEX idx_trips_local_day ON trips (local_day)',
  'CREATE INDEX idx_trip_events_client_trip_id ON trip_events (client_trip_id)',
  'CREATE INDEX idx_sync_queue_due ON sync_queue (status, next_attempt_at)',
];
