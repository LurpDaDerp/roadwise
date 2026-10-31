/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';
import {
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V11,
  SCHEMA_V12,
  SCHEMA_V13,
  SCHEMA_VERSION_TABLE,
} from '@/data/db/schema';

const TABLES = [
  'schema_version',
  'trips',
  'trip_events',
  'samples',
  'sync_queue',
  'speed_limit_tiles',
  'settings',
  'dashcam_events',
  'dashcam_boots',
  'dashcam_coverage',
  'problem_spots',
  'route_pool',
];
const V4_INDEXES = ['idx_trips_started_at', 'idx_trips_local_day', 'idx_trip_events_client_trip_id', 'idx_sync_queue_due'];
const INDEXES = [...V4_INDEXES, 'idx_dashcam_events_id', 'idx_dashcam_events_trip', 'idx_dashcam_events_received'];

async function names(db: Db, type: 'table' | 'index'): Promise<string[]> {
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]);
  return rows.map((row) => String(row.name));
}

const columns = async (db: Db, table: string): Promise<string[]> =>
  (await db.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name));

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
});

test('creates every v3, v5 and v10 table and index, and nothing of v2', async () => {
  await migrate(db);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('records the schema version it reached (14)', async () => {
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(14);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 14 }]);
});

test('is idempotent', async () => {
  await migrate(db);
  const tables = await names(db, 'table');
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(await names(db, 'table')).toEqual(tables);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 14 }]);
});

test('the trips table carries the current columns (phone time among them) and none of the points or screen-switch ones', async () => {
  await migrate(db);
  const cols = await columns(db, 'trips');
  for (const c of ['miles', 'night_miles', 'polyline', 'from_label', 'to_label', 'counts_json', 'result_json', 'merged_into', 'integrity_json', 'start_lat', 'start_lng']) {
    expect(cols).toContain(c);
  }
  for (const c of ['role', 'score', 'dms_on', 'dms_face_seen', 'points_net', 'estimate', 'breakdown_json', 'safe_miles']) expect(cols).not.toContain(c);
  expect(cols.slice(-17)).toEqual([
    'continues', 'end_cause', 'watched_miles', 'origin', 'not_driving_expired', 'continuations', 'finalized_at', 'start_source', 'last_seq',
    'slowdowns', 'speedups', 'turns', 'limit_s', 'moving_s', 'phone_s', 'archived_at', 'route_full',
  ]);
  const events = await columns(db, 'trip_events');
  for (const c of ['type', 'tier', 'measured_json', 'dispute_status']) expect(events).toContain(c);
  expect(events.slice(-2)).toEqual(['lat_full', 'lng_full']);
  for (const c of ['units', 'stopped_in_traffic', 'penalty']) expect(events).not.toContain(c);
});

test('a v2 development database steps up to v3: the trip tables are replaced, settings and tiles survive', async () => {
  for (const statement of SCHEMA_V1) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (1)');
  await db.execute("INSERT INTO settings (key, value_json) VALUES ('units', '\"mi\"')");
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('old', 1, 'UTC', 'recording', 1, 1)");

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT * FROM trips')).rows).toEqual([]);
  expect((await db.execute("SELECT value_json FROM settings WHERE key = 'units'")).rows).toEqual([{ value_json: '"mi"' }]);
  expect(await columns(db, 'trips')).toContain('night_miles');
});

test('a v3 database steps up to v4: the DMS columns, events and settings go, everything else survives', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (3)');
  await db.execute(
    "INSERT INTO trips (client_trip_id, started_at, tz, status, miles, dms_on, dms_face_seen, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 4.5, 1, 1, 1, 1)"
  );
  for (const [id, type] of [['e1', 'speeding'], ['e2', 'eyes_off'], ['e3', 'drowsy'], ['e4', 'hard_brake']]) {
    await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at) VALUES (?, 't1', ?, 'minor', 1)", [id, type]);
  }
  for (const key of ['dms.enabled', 'dms.calibratedAt', 'dms.profile', 'dms.setup', 'units']) {
    await db.execute("INSERT INTO settings (key, value_json) VALUES (?, 'true')", [key]);
  }

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  const cols = await columns(db, 'trips');
  expect(cols).not.toContain('dms_on');
  expect(cols).not.toContain('dms_face_seen');
  expect((await db.execute('SELECT client_trip_id, miles FROM trips')).rows).toEqual([{ client_trip_id: 't1', miles: 4.5 }]);
  expect((await db.execute('SELECT id FROM trip_events ORDER BY id')).rows).toEqual([{ id: 'e1' }, { id: 'e4' }]);
  expect((await db.execute('SELECT key FROM settings')).rows).toEqual([{ key: 'units' }]);
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('a v4 database steps up to v5 and on: the DashPal tables are added, everything else survives', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (4)');
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 1, 1)");
  await db.execute("INSERT INTO settings (key, value_json) VALUES ('units', ?)", ['"km"']);
  expect(await names(db, 'index')).toEqual([...V4_INDEXES].sort());

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
  expect((await db.execute('SELECT client_trip_id FROM trips')).rows).toEqual([{ client_trip_id: 't1' }]);
  expect((await db.execute('SELECT key FROM settings')).rows).toEqual([{ key: 'units' }]);
  expect(await columns(db, 'dashcam_events')).toEqual([
    'dashcam_id', 'boot_id', 'seq', 'id', 'ev', 'name', 'tier', 'audible', 'detail', 't_ms', 'dur_ds', 'value',
    'at_ms', 'started_at_ms', 'received_at_ms', 'client_trip_id', 'ignored',
  ]);
  expect(await columns(db, 'dashcam_boots')).toEqual(['dashcam_id', 'boot_id', 'offset_ms', 'rtt_ms', 'floor_seq', 'max_seq']);
  expect(await columns(db, 'dashcam_coverage')).toEqual(['client_trip_id', 'moving_s', 'covered_s', 'last_synced_at_ms']);
});

test('a v5 database steps up to v6: every stored DashPal event stays and counts as received in a drive (ignored 0)', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (5)');
  await db.execute(
    `INSERT INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms)
     VALUES ('a4cf12b3c4d5', 7, 0, 'id-0', 0, 'MICROSLEEP', 3, 1, 0, 100, 5, 1.5, 1)`
  );

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT id, ignored FROM dashcam_events')).rows).toEqual([{ id: 'id-0', ignored: 0 }]);
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('a v6 database steps up to v7: every stored drive stays and does not continue a previous one (continues 0)', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (6)');
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'recording', 1, 1)");

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT client_trip_id, continues FROM trips')).rows).toEqual([{ client_trip_id: 't1', continues: 0 }]);
  expect(await columns(db, 'trips')).toContain('continues');
});

test('a v7 database steps up to v8: every stored drive stays, with no end cause (no note)', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (7)');
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 1, 1)");

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT client_trip_id, end_cause FROM trips')).rows).toEqual([{ client_trip_id: 't1', end_cause: null }]);
  expect(await columns(db, 'trips')).toEqual(expect.arrayContaining(['continues', 'end_cause', 'watched_miles']));
});

test('a v8 database steps up to v9: a drive DashPal covered gets its watched miles from its coverage, the rest 0', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (8)');
  for (const id of ['t1', 't2', 't3']) {
    await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, miles, created_at, updated_at) VALUES (?, 1, 'UTC', 'scored', 20, 1, 1)", [id]);
  }
  await db.execute("INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES ('t1', 1000, 500), ('t2', 0, 0)");

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT client_trip_id, watched_miles FROM trips ORDER BY client_trip_id')).rows).toEqual([
    { client_trip_id: 't1', watched_miles: 10 },
    { client_trip_id: 't2', watched_miles: 0 },
    { client_trip_id: 't3', watched_miles: 0 },
  ]);
});

/** A database at V9, as a build before this round left it. */
async function atV9(): Promise<void> {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8, ...SCHEMA_V9]) {
    await db.execute(statement);
  }
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (9)');
}

test('a v9 database steps up through v10: the old phone events and the points columns go, clean is recounted, the old answers and settings go', async () => {
  await atV9();
  const trip = (id: string, status: string, extra: string, values: string) =>
    db.execute(`INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at${extra}) VALUES (?, 1, 'UTC', ?, 1, 1${values})`, [id, status]);
  // a scored drive whose only event was a pickup: clean once the pickup goes
  await trip('pickup', 'scored', ', points_net, estimate, clean, safe_miles, result_json', `, 40, 0, 0, 3, '{"net":40}'`);
  // a pending estimate with a phone event and a hard brake: still not clean
  await trip('brake', 'pending', ', points_net, estimate, clean, breakdown_json', ", 12, 1, 0, '{}'");
  // a scored drive with only a DashPal event: clean
  await trip('dashpal', 'scored', ', clean', ', 0');
  // a drive with no verdict keeps none
  await trip('unscored', 'unscored', ', clean', ', NULL');
  // a recording drive keeps its samples; a finished one loses them
  await trip('rec', 'recording', '', '');
  const event = (id: string, tripId: string, type: string, tier = 'severe') =>
    db.execute(
      "INSERT INTO trip_events (id, client_trip_id, type, tier, started_at, units, stopped_in_traffic, penalty) VALUES (?, ?, ?, ?, 1, 2, 1, -20)",
      [id, tripId, type, tier]
    );
  await event('p1', 'pickup', 'phone_pickup');
  await event('p2', 'brake', 'phone_handling', 'moderate');
  await event('b1', 'brake', 'hard_brake');
  await event('d1', 'dashpal', 'drowsy');
  await db.execute("INSERT INTO samples (client_trip_id, ts, row_json) VALUES ('rec', 1, '{}'), ('pickup', 1, '{}')");
  for (const key of ['home.streakCard.dismissed', 'drive.phoneSwitch', 'units']) {
    await db.execute("INSERT INTO settings (key, value_json) VALUES (?, 'true')", [key]);
  }

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT id FROM trip_events ORDER BY id')).rows).toEqual([{ id: 'b1' }, { id: 'd1' }]);
  const fresh = { result_json: null, origin: 'manual', not_driving_expired: 0, continuations: 0, finalized_at: null };
  expect(
    (await db.execute('SELECT client_trip_id, clean, result_json, origin, not_driving_expired, continuations, finalized_at FROM trips ORDER BY client_trip_id')).rows
  ).toEqual([
    { client_trip_id: 'brake', clean: 0, ...fresh },
    { client_trip_id: 'dashpal', clean: 1, ...fresh },
    { client_trip_id: 'pickup', clean: 1, ...fresh },
    { client_trip_id: 'rec', clean: null, ...fresh },
    { client_trip_id: 'unscored', clean: null, ...fresh },
  ]);
  expect((await db.execute('SELECT DISTINCT slowdowns, speedups, turns, limit_s, moving_s, start_source, last_seq FROM trips')).rows).toEqual([
    { slowdowns: null, speedups: null, turns: null, limit_s: null, moving_s: null, start_source: null, last_seq: null },
  ]);
  const cols = await columns(db, 'trips');
  for (const c of ['points_net', 'estimate', 'breakdown_json', 'safe_miles']) expect(cols).not.toContain(c);
  const events = await columns(db, 'trip_events');
  for (const c of ['units', 'stopped_in_traffic', 'penalty']) expect(events).not.toContain(c);
  expect((await db.execute('SELECT client_trip_id FROM samples')).rows).toEqual([{ client_trip_id: 'rec' }]);
  expect((await db.execute('SELECT key FROM settings')).rows).toEqual([{ key: 'units' }]);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('a v10 database steps up to v11: every drive gets 0 phone seconds and its stored pickups recounted from its active phone_pickup events', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8, ...SCHEMA_V9, ...SCHEMA_V10]) {
    await db.execute(statement);
  }
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (10)');
  const trip = (id: string, counts: string | null) =>
    db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, counts_json, moving_s, created_at, updated_at) VALUES (?, 1, 'UTC', 'scored', ?, 600, 1, 1)", [id, counts]);
  // an old build's counts: its pickups' events went at V10
  await trip('old', '{"speeding":1,"pickups":3,"handlingS":40,"hardBrake":0}');
  // a drive with one active pickup and one removed by a report
  await trip('now', '{"speeding":0}');
  await trip('none', null);
  await trip('junk', 'not json');
  for (const [id, status] of [
    ['p1', 'active'],
    ['p2', 'removed'],
  ] as const) {
    await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at, status) VALUES (?, 'now', 'phone_pickup', 'moderate', 1, ?)", [id, status]);
  }

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  const rows = (await db.execute('SELECT client_trip_id, counts_json, phone_s, moving_s FROM trips ORDER BY client_trip_id')).rows;
  expect(rows.map((r) => [r.client_trip_id, r.counts_json === null || r.counts_json === 'not json' ? r.counts_json : JSON.parse(String(r.counts_json)), r.phone_s, r.moving_s])).toEqual([
    ['junk', 'not json', 0, 600],
    ['none', null, 0, 600],
    ['now', { speeding: 0, pickups: 1 }, 0, 600],
    ['old', { speeding: 1, pickups: 0, handlingS: 40, hardBrake: 0 }, 0, 600],
  ]);
});

test('a v11 database steps up to v12: every merged-away drive goes with its events, samples and DashPal coverage, its raw DashPal events unstamped; the rest stays', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8, ...SCHEMA_V9, ...SCHEMA_V10, ...SCHEMA_V11]) {
    await db.execute(statement);
  }
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (11)');
  // Foreign keys off, as a device transaction may run: every child row must go explicitly.
  await db.execute('PRAGMA foreign_keys = OFF');
  const trip = (id: string, status: string, mergedInto: string | null) =>
    db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, merged_into, created_at, updated_at) VALUES (?, 1, 'UTC', ?, ?, 1, 1)", [id, status, mergedInto]);
  await trip('target', 'scored', null);
  await trip('leg', 'merged', 'target');
  await trip('rec', 'recording', null);
  for (const [id, tripId] of [
    ['e-target', 'target'],
    ['e-leg', 'leg'],
  ] as const) {
    await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at) VALUES (?, ?, 'speeding', 'minor', 1)", [id, tripId]);
  }
  await db.execute("INSERT INTO samples (client_trip_id, ts, row_json) VALUES ('leg', 1, '{}'), ('rec', 1, '{}')");
  await db.execute("INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES ('target', 10, 8), ('leg', 5, 4)");
  for (const [seq, tripId] of [
    [1, 'target'],
    [2, 'leg'],
  ] as const) {
    await db.execute(
      `INSERT INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms, client_trip_id)
       VALUES ('a4cf12b3c4d5', 7, ?, ?, 0, 'MICROSLEEP', 3, 1, 0, 100, 5, 1.5, 1, ?)`,
      [seq, `dc-${seq}`, tripId]
    );
  }

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT client_trip_id, status FROM trips ORDER BY client_trip_id')).rows).toEqual([
    { client_trip_id: 'rec', status: 'recording' },
    { client_trip_id: 'target', status: 'scored' },
  ]);
  expect((await db.execute('SELECT id FROM trip_events ORDER BY id')).rows).toEqual([{ id: 'e-target' }]);
  expect((await db.execute('SELECT client_trip_id FROM samples')).rows).toEqual([{ client_trip_id: 'rec' }]);
  expect((await db.execute('SELECT client_trip_id FROM dashcam_coverage')).rows).toEqual([{ client_trip_id: 'target' }]);
  expect((await db.execute('SELECT id, client_trip_id FROM dashcam_events ORDER BY id')).rows).toEqual([
    { id: 'dc-1', client_trip_id: 'target' },
    { id: 'dc-2', client_trip_id: null },
  ]);
});

test('a v12 database steps up to v13: every drive stays as it was, not archived, and the route pool starts empty', async () => {
  for (const statement of [
    ...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8, ...SCHEMA_V9, ...SCHEMA_V10, ...SCHEMA_V11, ...SCHEMA_V12,
  ]) {
    await db.execute(statement);
  }
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (12)');
  const trip = (id: string, status: string, endedAt: number) =>
    db.execute(
      `INSERT INTO trips (client_trip_id, started_at, ended_at, tz, status, miles, polyline, from_label, to_label, start_lat, start_lng, end_lat, end_lng, created_at, updated_at)
       VALUES (?, ?, ?, 'UTC', ?, 7.5, '_p~iF~ps|U', 'Home', 'School', 47.6, -122.3, 47.7, -122.4, 1, 1)`,
      [id, endedAt - 600_000, endedAt, status]
    );
  // A year-old drive is not archived by the migration (the archive job does that).
  await trip('old', 'scored', 1_000_000_000_000);
  await trip('new', 'pending', 1_700_000_000_000);
  await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at, lat, lng) VALUES ('e1', 'old', 'speeding', 'minor', 1, 47.6, -122.3)");
  const before = (await db.execute('SELECT * FROM trips ORDER BY client_trip_id')).rows;

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT * FROM trips ORDER BY client_trip_id')).rows).toEqual(before.map((r) => ({ ...r, archived_at: null, route_full: null })));
  expect((await db.execute('SELECT lat, lng FROM trip_events')).rows).toEqual([{ lat: 47.6, lng: -122.3 }]);
  expect(await columns(db, 'route_pool')).toEqual(['polyline']);
  // No rowid: the pool is kept in the lines' order, never the order they were added.
  expect(String((await db.execute("SELECT sql FROM sqlite_master WHERE name = 'route_pool'")).rows[0]?.sql)).toMatch(/WITHOUT ROWID/);
  await expect(db.execute('SELECT rowid FROM route_pool')).rejects.toThrow();
  expect((await db.execute('SELECT COUNT(*) AS n FROM route_pool')).rows).toEqual([{ n: 0 }]);
  // A line is held once.
  expect((await db.execute("INSERT OR IGNORE INTO route_pool (polyline) VALUES ('_p~iF~ps|U')")).changes).toBe(1);
  expect((await db.execute("INSERT OR IGNORE INTO route_pool (polyline) VALUES ('_p~iF~ps|U')")).changes).toBe(0);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
});

test('a v13 database steps up to v14: every drive and event stays as it was, with no whole route and no exact places (they fall back to the uploaded ones)', async () => {
  for (const statement of [
    ...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4, ...SCHEMA_V5, ...SCHEMA_V6, ...SCHEMA_V7, ...SCHEMA_V8, ...SCHEMA_V9, ...SCHEMA_V10, ...SCHEMA_V11, ...SCHEMA_V12,
    ...SCHEMA_V13,
  ]) {
    await db.execute(statement);
  }
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (13)');
  await db.execute(
    `INSERT INTO trips (client_trip_id, started_at, ended_at, tz, status, miles, polyline, start_lat, start_lng, created_at, updated_at)
     VALUES ('t1', 1, 600001, 'UTC', 'scored', 7.5, '_p~iF~ps|U', 47.6, -122.3, 1, 1)`
  );
  await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at, lat, lng) VALUES ('e1', 't1', 'speeding', 'minor', 1, 47.6, -122.3), ('e2', 't1', 'hard_brake', 'minor', 2, NULL, NULL)");
  const trips = (await db.execute('SELECT * FROM trips')).rows;
  const events = (await db.execute('SELECT * FROM trip_events ORDER BY id')).rows;

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect((await db.execute('SELECT * FROM trips')).rows).toEqual(trips.map((r) => ({ ...r, route_full: null })));
  expect((await db.execute('SELECT * FROM trip_events ORDER BY id')).rows).toEqual(events.map((r) => ({ ...r, lat_full: null, lng_full: null })));
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
});

test('v10 checks: origin is auto or manual, start_source one of three, a spot kind one of the four and its state active or cleared', async () => {
  await migrate(db);
  const trip = (id: string, origin: string, source: string | null) =>
    db.execute(
      "INSERT INTO trips (client_trip_id, started_at, tz, status, origin, start_source, created_at, updated_at) VALUES (?, 1, 'UTC', 'recording', ?, ?, 1, 1)",
      [id, origin, source]
    );
  await expect(trip('a', 'auto', 'trace')).resolves.toBeDefined();
  await expect(trip('b', 'manual', null)).resolves.toBeDefined();
  await expect(trip('c', 'mode', null)).rejects.toThrow();
  await expect(trip('d', 'auto', 'guess')).rejects.toThrow();
  const spot = (id: string, kind: string, state: string) =>
    db.execute(
      `INSERT INTO problem_spots (id, kind, state, lat, lng, heading_deg, segment, hits, passes, recent_hits, recent_passes, rate,
         clean_streak, clean_needed, last_hit_at, last_hit_trip, last_pass_at, rank, computed_at)
       VALUES (?, ?, ?, 47.6, -122.3, 90, '_p~iF~ps|U', 3, 5, 3, 5, 0.4, 0, 5, 1, 't', 1, 1, 1)`,
      [id, kind, state]
    );
  await expect(spot('s1', 'hard_brake', 'active')).resolves.toBeDefined();
  await expect(spot('s2', 'speeding', 'cleared')).resolves.toBeDefined();
  await expect(spot('s3', 'phone_pickup', 'active')).rejects.toThrow();
  await expect(spot('s4', 'hard_corner', 'gone')).rejects.toThrow();
  expect(await columns(db, 'problem_spots')).toEqual([
    'id', 'kind', 'state', 'lat', 'lng', 'heading_deg', 'segment', 'limit_mph', 'hits', 'passes', 'recent_hits', 'recent_passes', 'rate',
    'clean_streak', 'clean_needed', 'last_hit_at', 'last_hit_trip', 'last_pass_at', 'cleared_at', 'rank', 'label', 'label_at', 'computed_at',
  ]);
});

test('dashcam rows: an event dedupes on (dashcam, boot, seq) and its id is unique; a deleted trip unstamps its events and drops its coverage', async () => {
  await migrate(db);
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 1, 1)");
  const insert = (seq: number, id: string, trip: string | null) =>
    db.execute(
      `INSERT OR IGNORE INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms, client_trip_id)
       VALUES ('a4cf12b3c4d5', 7, ?, ?, 0, 'MICROSLEEP', 3, 1, 0, 100, 5, 1.5, 1, ?)`,
      [seq, id, trip]
    );
  expect((await insert(1, 'id-1', 't1')).changes).toBe(1);
  expect((await insert(1, 'id-2', null)).changes).toBe(0);
  await expect(
    db.execute(
      `INSERT INTO dashcam_events (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, received_at_ms)
       VALUES ('a4cf12b3c4d5', 7, 2, 'id-1', 0, 'MICROSLEEP', 3, 1, 0, 100, 5, 1.5, 1)`
    )
  ).rejects.toThrow();
  // A boot id past 2^32 (a local collision generation) is stored exactly.
  expect((await db.execute("INSERT INTO dashcam_boots (dashcam_id, boot_id) VALUES ('a4cf12b3c4d5', ?)", [2 ** 32 + 7])).changes).toBe(1);
  expect((await db.execute('SELECT boot_id, floor_seq, max_seq, offset_ms FROM dashcam_boots')).rows).toEqual([
    { boot_id: 2 ** 32 + 7, floor_seq: 0, max_seq: -1, offset_ms: null },
  ]);
  await db.execute("INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES ('t1', 10, 8)");
  await db.execute("DELETE FROM trips WHERE client_trip_id = 't1'");
  expect((await db.execute('SELECT id, client_trip_id FROM dashcam_events')).rows).toEqual([{ id: 'id-1', client_trip_id: null }]);
  expect((await db.execute('SELECT * FROM dashcam_coverage')).rows).toEqual([]);
});

test('rejects a trip status outside the allowed set', async () => {
  await migrate(db);
  await expect(
    db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'bogus', 1, 1)")
  ).rejects.toThrow();
});

test('an event goes with its trip (cascade), outside a transaction', async () => {
  await migrate(db);
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 1, 1)");
  await db.execute("INSERT INTO trip_events (id, client_trip_id, type, tier, started_at) VALUES ('e1', 't1', 'speeding', 'minor', 1)");
  await db.execute("DELETE FROM trips WHERE client_trip_id = 't1'");
  expect((await db.execute('SELECT * FROM trip_events')).rows).toEqual([]);
});
