/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';

/**
 * The `Db` contract itself, as the sql.js driver implements it. `createExpoDb` is the other
 * implementation of the same contract and must behave the same way; it is not exercised here
 * because it needs a native module.
 */

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('execute reports the rows a read produced and the changes a write made', async () => {
  const write = await db.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', [
    'units',
    '"mph"',
  ]);
  expect(write).toEqual({ rows: [], changes: 1 });

  const read = await db.execute('SELECT key, value_json FROM settings');
  expect(read.rows).toEqual([{ key: 'units', value_json: '"mph"' }]);
});

test('a transaction commits what its body wrote', async () => {
  const out = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"mph"']);
    return 'committed';
  });

  expect(out).toBe('committed');
  await expect(createSettingsRepo(db).get<string>('units')).resolves.toBe('mph');
});

test('a transaction that throws rolls back everything its body wrote', async () => {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"mph"']);
      throw new Error('nope');
    })
  ).rejects.toThrow('nope');

  await expect(createSettingsRepo(db).get('units')).resolves.toBeNull();
});

test('nested transactions are refused rather than silently misbehaving', async () => {
  await expect(
    db.transaction(async (tx) => tx.transaction(async () => 'inner'))
  ).rejects.toThrow('nested transactions are not supported');
});

test('the database is still usable after a nested transaction is refused', async () => {
  await expect(
    db.transaction(async (tx) => tx.transaction(async () => 'inner'))
  ).rejects.toThrow();

  await db.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"kph"']);
  await expect(createSettingsRepo(db).get<string>('units')).resolves.toBe('kph');
});
