/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_VERSION_TABLE } from '@/data/db/schema';

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

test('creates every v3 and v5 table and index, and nothing of v2', async () => {
  await migrate(db);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('records the schema version it reached (5)', async () => {
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(5);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 5 }]);
});

test('is idempotent', async () => {
  await migrate(db);
  const tables = await names(db, 'table');
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(await names(db, 'table')).toEqual(tables);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 5 }]);
});

test('the v3 trips table carries the v3 columns', async () => {
  await migrate(db);
  const cols = await columns(db, 'trips');
  for (const c of ['miles', 'safe_miles', 'night_miles', 'polyline', 'from_label', 'to_label', 'points_net', 'estimate', 'counts_json', 'result_json', 'merged_into', 'integrity_json']) {
    expect(cols).toContain(c);
  }
  expect(cols).not.toContain('role');
  expect(cols).not.toContain('score');
  expect(cols).not.toContain('dms_on');
  expect(cols).not.toContain('dms_face_seen');
  const events = await columns(db, 'trip_events');
  for (const c of ['type', 'tier', 'units', 'stopped_in_traffic', 'penalty', 'dispute_status']) expect(events).toContain(c);
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
  expect(await columns(db, 'trips')).toContain('points_net');
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

test('a v4 database steps up to v5: the DashPal tables are added, everything else survives', async () => {
  for (const statement of [...SCHEMA_V1, ...SCHEMA_V2, ...SCHEMA_V3, ...SCHEMA_V4]) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (4)');
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('t1', 1, 'UTC', 'scored', 1, 1)");
  await db.execute("INSERT INTO settings (key, value_json) VALUES ('units', ?)", ['"km"']);
  expect(await names(db, 'index')).toEqual([...V4_INDEXES].sort());

  await expect(migrate(db)).resolves.toBe(5);

  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
  expect((await db.execute('SELECT client_trip_id FROM trips')).rows).toEqual([{ client_trip_id: 't1' }]);
  expect((await db.execute('SELECT key FROM settings')).rows).toEqual([{ key: 'units' }]);
  expect(await columns(db, 'dashcam_events')).toEqual([
    'dashcam_id', 'boot_id', 'seq', 'id', 'ev', 'name', 'tier', 'audible', 'detail', 't_ms', 'dur_ds', 'value',
    'at_ms', 'started_at_ms', 'received_at_ms', 'client_trip_id',
  ]);
  expect(await columns(db, 'dashcam_boots')).toEqual(['dashcam_id', 'boot_id', 'offset_ms', 'rtt_ms', 'floor_seq', 'max_seq']);
  expect(await columns(db, 'dashcam_coverage')).toEqual(['client_trip_id', 'moving_s', 'covered_s', 'last_synced_at_ms']);
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
