/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { CURRENT_SCHEMA_VERSION, migrate } from '@/data/db/migrate';

const TABLES = [
  'schema_version',
  'trips',
  'trip_events',
  'samples',
  'sync_queue',
  'speed_limit_tiles',
  'settings',
  'score_daily_cache',
  'inbox_cache',
];

// `samples` is deliberately absent: its primary key (client_trip_id, ts) already covers the
// range reads, and a second index on the 1 Hz table would cost every insert.
const INDEXES = ['idx_trips_started_at', 'idx_trip_events_client_trip_id', 'idx_sync_queue_due'];

async function names(db: Db, type: 'table' | 'index'): Promise<string[]> {
  const { rows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [type]
  );
  return rows.map((row) => String(row.name));
}

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
});

test('creates every schema v1 table', async () => {
  await migrate(db);
  expect(await names(db, 'table')).toEqual([...TABLES].sort());
});

test('creates the query indexes the app reads through', async () => {
  await migrate(db);
  expect(await names(db, 'index')).toEqual([...INDEXES].sort());
});

test('records the schema version it reached', async () => {
  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 1 }]);
});

test('is idempotent: running twice leaves one version row and the same tables', async () => {
  await migrate(db);
  const tablesAfterFirst = await names(db, 'table');

  await expect(migrate(db)).resolves.toBe(CURRENT_SCHEMA_VERSION);

  expect(await names(db, 'table')).toEqual(tablesAfterFirst);
  const { rows } = await db.execute('SELECT version FROM schema_version');
  expect(rows).toEqual([{ version: 1 }]);
});

test('keeps data written between runs', async () => {
  await migrate(db);
  await db.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"mph"']);

  await migrate(db);

  const { rows } = await db.execute('SELECT value_json FROM settings WHERE key = ?', ['units']);
  expect(rows).toEqual([{ value_json: '"mph"' }]);
});

const insertTrip = (db: Db, status: string, syncState: string) =>
  db.execute(
    'INSERT INTO trips (client_trip_id, started_at, tz, status, sync_state, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['t1', 1, 'UTC', status, syncState, 1, 1]
  );

test('rejects a trip status outside the allowed set', async () => {
  await migrate(db);
  await expect(insertTrip(db, 'bogus', 'local')).rejects.toThrow();
});

test('rejects a trip sync_state outside the allowed set', async () => {
  await migrate(db);
  await expect(insertTrip(db, 'final', 'bogus')).rejects.toThrow();
  // The allowed ones all go in.
  for (const state of ['local', 'queued', 'uploading', 'synced', 'failed']) {
    await db.execute('DELETE FROM trips');
    await expect(insertTrip(db, 'final', state)).resolves.toBeDefined();
  }
});

test('trips carries the incomplete flag, NOT NULL and off by default', async () => {
  await migrate(db);
  const { rows } = await db.execute('PRAGMA table_info(trips)');
  const column = rows.find((row) => row.name === 'incomplete');
  expect(column).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });

  await insertTrip(db, 'recording', 'local');
  const { rows: stored } = await db.execute('SELECT incomplete FROM trips');
  expect(stored).toEqual([{ incomplete: 0 }]);
});

test('rejects a sync_queue status outside the allowed set', async () => {
  await migrate(db);
  const insert = (status: string) =>
    db.execute(
      'INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, next_attempt_at, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?)',
      ['finalize-trip', '{}', `k-${status}`, status, 1, 1]
    );

  await expect(insert('bogus')).rejects.toThrow();
  for (const status of ['pending', 'inflight', 'done', 'failed']) {
    await expect(insert(status)).resolves.toBeDefined();
  }
});

test('deleting a trip cascades to its events and samples', async () => {
  await migrate(db);
  await db.execute(
    'INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?)',
    ['t1', 1, 'UTC', 'recording', 1, 1]
  );
  await db.execute(
    'INSERT INTO trip_events (id, client_trip_id, category, started_at) VALUES (?, ?, ?, ?)',
    ['e1', 't1', 'hard_brake', 2]
  );
  await db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [
    't1',
    2,
    '{}',
  ]);

  await db.execute('DELETE FROM trips WHERE client_trip_id = ?', ['t1']);

  const events = await db.execute('SELECT count(*) AS n FROM trip_events');
  const samples = await db.execute('SELECT count(*) AS n FROM samples');
  expect(events.rows).toEqual([{ n: 0 }]);
  expect(samples.rows).toEqual([{ n: 0 }]);
});
