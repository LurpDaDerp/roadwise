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

const INDEXES = [
  'idx_trips_started_at',
  'idx_trip_events_client_trip_id',
  'idx_samples_trip_ts',
  'idx_sync_queue_due',
];

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

test('rejects a trip status outside the allowed set', async () => {
  await migrate(db);
  await expect(
    db.execute(
      'INSERT INTO trips (client_trip_id, started_at, tz, status, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?)',
      ['t1', 1, 'UTC', 'bogus', 1, 1]
    )
  ).rejects.toThrow();
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
