/**
 * The on-device schema. SQLite is the source of truth for the user's own drives (offline-first,
 * plan §5): a drive is recorded here, classified here (scored or too short, clean or not), uploaded
 * from here, and the server's answer is written back here.
 *
 * Conventions:
 * - timestamps are epoch **milliseconds** stored as INTEGER;
 * - booleans are INTEGER 0/1;
 * - anything structured is a TEXT column named `*_json` holding `JSON.stringify` output;
 * - a statement per array entry — drivers prepare one statement at a time.
 *
 * Versions 1 and 2 are the v2 app's (never shipped to users). Version 3 drops the v2 trip tables
 * and creates the v3 ones; `settings` and `speed_limit_tiles` survive untouched. Version 4 removes
 * what the in-app driver monitoring (DMS) left behind. Version 5 adds the DashPal dashcam's tables.
 * Version 6 marks the DashPal events that arrived while no drive was open. Versions 7 to 9 add a
 * column each. Version 10 is the round where points and phone use leave, drives start on their own,
 * scores are judged per opportunity and problem spots are kept. Version 13 keeps a drive's route
 * and places for 183 days only (`archive.ts`).
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

/**
 * V4 — the in-app driver monitoring (DMS) is gone: its two trip columns, its event types and its
 * settings (the on/off switch, the calibration time, the face profile and the setup record).
 */
export const SCHEMA_V4: readonly string[] = [
  'ALTER TABLE trips DROP COLUMN dms_on',
  'ALTER TABLE trips DROP COLUMN dms_face_seen',
  "DELETE FROM trip_events WHERE type IN ('eyes_off', 'drowsy')",
  "DELETE FROM settings WHERE key IN ('dms.enabled', 'dms.calibratedAt', 'dms.profile', 'dms.setup')",
];

/**
 * V5 — the DashPal dashcam link (plan §3.6, §7.5).
 *
 * - `dashcam_events`: every event the dashcam reported, persisted before the phone acknowledges it,
 *   deduplicated on `(dashcam_id, boot_id, seq)`. `id` is a fresh lowercase v4 uuid minted at the
 *   first insert (an event's identity in the upload). `t_ms`/`dur_ds` are dashcam uptime; wall
 *   times are derived from the boot's best clock offset when needed, so `at_ms`/`started_at_ms`
 *   are only a cache. `client_trip_id` is stamped at finalize; an event outside a drive keeps
 *   NULL and is pruned 7 days after receipt, below its boot's floor. `boot_id` is the dashcam's random per-boot id, plus 2^32 per
 *   local collision generation (a HELLO that cannot belong to the stored boot of that id).
 * - `dashcam_boots`: per dashcam boot, the best uptime → epoch offset and its round trip, the
 *   floor below which every seq is stored, gone from the dashcam's ring, pruned or given up by the
 *   prune (an incoming event below it is not stored; the prune raises it past what it deletes),
 *   and the highest seq stored.
 * - `dashcam_coverage`: per recorded drive, the seconds moving at 5 mph or more and, of those, the
 *   seconds the dashcam watched a live face on this phone's primary link; the last time the phone
 *   had every event the dashcam had announced.
 */
export const SCHEMA_V5: readonly string[] = [
  `CREATE TABLE dashcam_events (
    dashcam_id TEXT NOT NULL,
    boot_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    ev INTEGER NOT NULL,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    audible INTEGER NOT NULL,
    detail INTEGER NOT NULL,
    t_ms INTEGER NOT NULL,
    dur_ds INTEGER NOT NULL,
    value REAL NOT NULL,
    at_ms INTEGER,
    started_at_ms INTEGER,
    received_at_ms INTEGER NOT NULL,
    client_trip_id TEXT REFERENCES trips (client_trip_id) ON DELETE SET NULL,
    PRIMARY KEY (dashcam_id, boot_id, seq)
  )`,
  'CREATE UNIQUE INDEX idx_dashcam_events_id ON dashcam_events (id)',
  'CREATE INDEX idx_dashcam_events_trip ON dashcam_events (client_trip_id)',
  'CREATE INDEX idx_dashcam_events_received ON dashcam_events (received_at_ms)',
  `CREATE TABLE dashcam_boots (
    dashcam_id TEXT NOT NULL,
    boot_id INTEGER NOT NULL,
    offset_ms INTEGER,
    rtt_ms INTEGER,
    floor_seq INTEGER NOT NULL DEFAULT 0,
    max_seq INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (dashcam_id, boot_id)
  )`,
  `CREATE TABLE dashcam_coverage (
    client_trip_id TEXT PRIMARY KEY NOT NULL REFERENCES trips (client_trip_id) ON DELETE CASCADE,
    moving_s INTEGER NOT NULL DEFAULT 0,
    covered_s INTEGER NOT NULL DEFAULT 0,
    last_synced_at_ms INTEGER
  )`,
];

/**
 * V6 — `dashcam_events.ignored`: 1 when the event arrived while no drive was open (from the Start
 * Drive tap until that drive's finalize has finished). The row is still stored, so the ACK cursor
 * and the dedup on `(dashcam_id, boot_id, seq)` see every seq, but it is only a delivery record: no
 * drive claims it and it is pruned with the other unclaimed events after 7 days. The first copy's
 * flag stands; a replayed copy never changes it.
 */
export const SCHEMA_V6: readonly string[] = ['ALTER TABLE dashcam_events ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0'];

/**
 * V7 — `trips.continues`: 1 when the drive was started within `MERGE_GAP_S` of the end of the
 * phone's previous drive, so it has no 30 s warm-up. Stored with the trip's first row, so a drive
 * rebuilt after a relaunch (adopt, orphan) decides its warm-up the same way the live engine did.
 */
export const SCHEMA_V7: readonly string[] = ['ALTER TABLE trips ADD COLUMN continues INTEGER NOT NULL DEFAULT 0'];

/**
 * V8 — `trips.end_cause`: what ended a drive this phone recorded (`manual`, `manual_still` for a
 * manual end cut at the last movement, `stopped`, `walking`, `orphan`, `limit`), for the summary's
 * end note. Local only, never uploaded; null on a drive hydrated from the server.
 */
export const SCHEMA_V8: readonly string[] = ['ALTER TABLE trips ADD COLUMN end_cause TEXT'];

/**
 * V9 — `trips.watched_miles`: the miles DashPal watched on the drive (`watchedMiles`: its miles ×
 * the covered share of its moving seconds), for the radar's Attention. A drive this phone recorded
 * takes it from its `dashcam_coverage` row; one restored from the server, from its DashPal seconds.
 */
export const SCHEMA_V9: readonly string[] = [
  'ALTER TABLE trips ADD COLUMN watched_miles REAL NOT NULL DEFAULT 0',
  `UPDATE trips SET watched_miles = (
     SELECT CASE WHEN c.moving_s > 0 AND c.covered_s > 0 AND trips.miles > 0
       THEN trips.miles * MIN(c.covered_s, c.moving_s) * 1.0 / c.moving_s ELSE 0 END
     FROM dashcam_coverage c WHERE c.client_trip_id = trips.client_trip_id)
   WHERE EXISTS (SELECT 1 FROM dashcam_coverage c WHERE c.client_trip_id = trips.client_trip_id)`,
];

/**
 * V10 (removal part): points and phone use are gone.
 * - phone events go, and each drive's clean flag is recomputed from the events it keeps (DashPal
 *   events never break a clean drive);
 * - the local points estimate (`points_net`, `estimate`, `breakdown_json`), safe miles and the stored
 *   server answers (`result_json`: every one held points) go; event penalties, units and
 *   stopped-in-traffic go (they were points, or phone use's);
 * - the streak card's dismissal and the screen-switch settings go.
 */
export const REMOVAL_V10: readonly string[] = [
  "DELETE FROM trip_events WHERE type IN ('phone_pickup', 'phone_handling')",
  `UPDATE trips SET clean = CASE WHEN EXISTS (SELECT 1 FROM trip_events e WHERE e.client_trip_id = trips.client_trip_id
       AND e.status = 'active' AND e.type NOT IN ('eyes_off', 'drowsy')) THEN 0 ELSE 1 END
     WHERE clean IS NOT NULL`,
  'ALTER TABLE trips DROP COLUMN points_net',
  'ALTER TABLE trips DROP COLUMN estimate',
  'ALTER TABLE trips DROP COLUMN breakdown_json',
  'ALTER TABLE trips DROP COLUMN safe_miles',
  'UPDATE trips SET result_json = NULL',
  'ALTER TABLE trip_events DROP COLUMN penalty',
  'ALTER TABLE trip_events DROP COLUMN units',
  'ALTER TABLE trip_events DROP COLUMN stopped_in_traffic',
  "DELETE FROM settings WHERE key IN ('home.streakCard.dismissed', 'drive.phoneSwitch')",
];

/**
 * V10 (lifecycle part): drives start on their own.
 * - `origin`: how the drive started, noticed on its own (`auto`) or a Start tap (`manual`);
 * - `not_driving_expired`: 1 once the in-drive "Not driving?" ran out of its 2-minute budget (no
 *   "Wasn't driving" later);
 * - `continuations`: a local counter, always 0, that nothing reads;
 * - `finalized_at`: when the end was decided (epoch ms);
 * - `start_source`: where the start came from (`trace`: traced back over the rows, `motion`: the
 *   motion history, `wake`: the first row); the start place lives in the existing
 *   `start_lat`/`start_lng`;
 * - `last_seq`: the last journal row (iOS) the recorder made durable, so a relaunch resumes there;
 * - samples are now kept until the upload is sent, so any left from finished drives go.
 *
 * `start_lat` and `start_lng` exist since V3 (the raw first fix), so they are not added here.
 */
export const LIFECYCLE_V10: readonly string[] = [
  "ALTER TABLE trips ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('auto', 'manual'))",
  'ALTER TABLE trips ADD COLUMN not_driving_expired INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE trips ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE trips ADD COLUMN finalized_at INTEGER',
  "ALTER TABLE trips ADD COLUMN start_source TEXT CHECK (start_source IN ('trace', 'motion', 'wake'))",
  'ALTER TABLE trips ADD COLUMN last_seq INTEGER',
  "DELETE FROM samples WHERE client_trip_id IN (SELECT client_trip_id FROM trips WHERE status != 'recording')",
];

/**
 * V10 (scores part): each drive's chances to slip, counted as it records (scoring `Exposure`).
 * NULL means the drive was recorded before the counters existed: they are estimated at read from
 * its miles and duration (`estimateExposure`).
 */
export const SCORES_V10: readonly string[] = [
  'ALTER TABLE trips ADD COLUMN slowdowns INTEGER',
  'ALTER TABLE trips ADD COLUMN speedups INTEGER',
  'ALTER TABLE trips ADD COLUMN turns INTEGER',
  'ALTER TABLE trips ADD COLUMN limit_s INTEGER',
  'ALTER TABLE trips ADD COLUMN moving_s INTEGER',
];

/**
 * V10 (spots part): `problem_spots`, the places where the same thing keeps happening on this
 * driver's drives, derived on the phone from `trip_events` and `trips.polyline` and replaced whole
 * on every recompute (`src/features/spots/recompute.ts`). Local only: never uploaded or restored.
 * No foreign key: a spot names its newest hit's drive only for the sheet's link.
 */
export const PROBLEM_SPOTS_V10: readonly string[] = [
  `CREATE TABLE problem_spots (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('speeding', 'hard_brake', 'hard_corner', 'hard_accel')),
    state TEXT NOT NULL CHECK (state IN ('active', 'cleared')),
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    heading_deg REAL NOT NULL,
    segment TEXT NOT NULL,
    limit_mph INTEGER,
    hits INTEGER NOT NULL,
    passes INTEGER NOT NULL,
    recent_hits INTEGER NOT NULL,
    recent_passes INTEGER NOT NULL,
    rate REAL NOT NULL,
    clean_streak INTEGER NOT NULL,
    clean_needed INTEGER NOT NULL,
    last_hit_at INTEGER NOT NULL,
    last_hit_trip TEXT NOT NULL,
    last_pass_at INTEGER NOT NULL,
    cleared_at INTEGER,
    rank INTEGER NOT NULL,
    label TEXT,
    label_at INTEGER,
    computed_at INTEGER NOT NULL
  )`,
];

/** V10: one entry for the whole round (points and phone use out, drives that start on their own, fair scores, problem spots). */
export const SCHEMA_V10: readonly string[] = [...REMOVAL_V10, ...LIFECYCLE_V10, ...SCORES_V10, ...PROBLEM_SPOTS_V10];

/**
 * V11: phone use is tracked again (motion only).
 * - `phone_s`: the seconds of the drive at driving speed with the motion sensors read, phone use's
 *   opportunities, beside the other counters. 0 on every drive recorded before (it was not watched
 *   for phone use), and on a drive whose counters are estimated.
 * - the stored counts' `pickups` is recounted from the drive's active `phone_pickup` events: a drive
 *   from before V10 still carries its old build's count, whose events V10 deleted.
 * `phone_pickup` events need no change: `trip_events.type` has no CHECK.
 */
export const SCHEMA_V11: readonly string[] = [
  'ALTER TABLE trips ADD COLUMN phone_s INTEGER NOT NULL DEFAULT 0',
  `UPDATE trips SET counts_json = json_set(counts_json, '$.pickups', (SELECT COUNT(*) FROM trip_events e
       WHERE e.client_trip_id = trips.client_trip_id AND e.status = 'active' AND e.type = 'phone_pickup'))
     WHERE counts_json IS NOT NULL AND json_valid(counts_json) AND json_type(counts_json) = 'object'`,
];

/**
 * V12: every drive is a drive of its own. The legacy `merged` rows (a drive the server joined into
 * the one before it, which holds the union) go with their events, samples and DashPal coverage,
 * explicitly, since foreign keys may be off in the migration's transaction; the raw DashPal events
 * stamped with one keep no id of a row that is gone. The table's CHECK still names the status.
 */
export const SCHEMA_V12: readonly string[] = [
  "DELETE FROM trip_events WHERE client_trip_id IN (SELECT client_trip_id FROM trips WHERE status = 'merged')",
  "DELETE FROM samples WHERE client_trip_id IN (SELECT client_trip_id FROM trips WHERE status = 'merged')",
  "DELETE FROM dashcam_coverage WHERE client_trip_id IN (SELECT client_trip_id FROM trips WHERE status = 'merged')",
  "UPDATE dashcam_events SET client_trip_id = NULL WHERE client_trip_id IN (SELECT client_trip_id FROM trips WHERE status = 'merged')",
  "DELETE FROM trips WHERE status = 'merged'",
];

/**
 * V13: a drive's route and places are kept 183 days after it ended (`archive.ts`).
 * - `trips.archived_at`: when the drive was archived (epoch ms). An archived drive keeps every
 *   number the stats read, but no route, no start or end point, no from/to label and no event
 *   place, and it is in no list and has no recap. Null until then.
 * - `route_pool`: the archived scored drives' routes, one line each, with nothing that says which
 *   drive or when: the All trips map draws them beside the routes the drives still hold. A line is
 *   stored once (a restore that brings the server's copy of a line this phone already pooled adds
 *   nothing). It has no rowid: the table is kept in the lines' own order, never in the order they
 *   were added, so a line's place says nothing about its drive or its date.
 */
export const SCHEMA_V13: readonly string[] = [
  'ALTER TABLE trips ADD COLUMN archived_at INTEGER',
  `CREATE TABLE route_pool (
    polyline TEXT PRIMARY KEY NOT NULL
  ) WITHOUT ROWID`,
];
