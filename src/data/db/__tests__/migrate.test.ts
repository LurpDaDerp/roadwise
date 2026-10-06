/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';
import { SCHEMA_V1, SCHEMA_VERSION_TABLE } from '@/data/db/schema';

const TABLES = ['schema_version', 'trips', 'trip_events', 'samples', 'sync_queue', 'speed_limit_tiles', 'settings'];
const INDEXES = ['idx_trips_started_at', 'idx_trips_local_day', 'idx_trip_events_client_trip_id', 'idx_sync_queue_due'];

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

test('creates every v3 table and index, and nothing of v2', async () => {
  await migrate(db);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('records the schema version it reached (3)', async () => {
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(3);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 3 }]);
});

test('is idempotent', async () => {
  await migrate(db);
  const tables = await names(db, 'table');
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  expect(await names(db, 'table')).toEqual(tables);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 3 }]);
});

test('the v3 trips table carries the v3 columns', async () => {
  await migrate(db);
  const cols = await columns(db, 'trips');
  for (const c of ['miles', 'safe_miles', 'night_miles', 'polyline', 'from_label', 'to_label', 'points_net', 'estimate', 'counts_json', 'result_json', 'merged_into', 'integrity_json']) {
    expect(cols).toContain(c);
  }
  expect(cols).not.toContain('role');
  expect(cols).not.toContain('score');
  const events = await columns(db, 'trip_events');
  for (const c of ['type', 'tier', 'units', 'stopped_in_traffic', 'penalty', 'dispute_status']) expect(events).toContain(c);
});

test('a v2 development database steps up to v3: the trip tables are replaced, settings and tiles survive', async () => {
  for (const statement of SCHEMA_V1) await db.execute(statement);
  await db.execute(SCHEMA_VERSION_TABLE);
  await db.execute('INSERT INTO schema_version (version) VALUES (1)');
  await db.execute("INSERT INTO settings (key, value_json) VALUES ('units', '\"mi\"')");
  await db.execute("INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at) VALUES ('old', 1, 'UTC', 'recording', 1, 1)");

  await expect(migrate(db)).resolves.toBe(3);

  expect((await db.execute('SELECT * FROM trips')).rows).toEqual([]);
  expect((await db.execute("SELECT value_json FROM settings WHERE key = 'units'")).rows).toEqual([{ value_json: '"mi"' }]);
  expect(await columns(db, 'trips')).toContain('points_net');
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
