import type { SQLiteDatabase } from 'expo-sqlite';
import { BUSY_TIMEOUT_MS, createExpoDb, type OpenDatabase } from '@/data/db/driver';

/**
 * `createExpoDb` over a fake native handle. `driver.test.ts` pins the `Db` contract through
 * sql.js; this suite pins what only the device driver does — the pragmas every connection is
 * opened with, on the main handle and on each exclusive-transaction connection. A connection
 * without `busy_timeout` fails with `database is locked` the moment another writer holds the
 * lock, so this is the one place that guarantee is checked. (`expo-sqlite` itself is never
 * loaded: the driver's dynamic import is bypassed by handing it the opener.)
 */

/** Every statement sent to the main connection, in order. */
const mainSql: string[] = [];
/** Every statement sent to each transaction connection: one list per transaction, in order. */
const txnSql: string[][] = [];
const opened: string[] = [];

/** The slice of `SQLiteDatabase` the driver uses, recording every statement into `sink`. */
function fakeConnection(sink: string[]): SQLiteDatabase {
  const fake = {
    execAsync: async (sql: string) => {
      sink.push(sql);
    },
    prepareAsync: async (sql: string) => ({
      executeAsync: async () => {
        sink.push(sql);
        return { changes: 0, getAllAsync: async () => [] };
      },
      finalizeAsync: async () => {},
    }),
    // Like expo: a fresh connection per exclusive transaction, handed to the task.
    withExclusiveTransactionAsync: async (task: (txn: SQLiteDatabase) => Promise<void>) => {
      const inner: string[] = [];
      txnSql.push(inner);
      await task(fakeConnection(inner));
    },
  };
  return fake as unknown as SQLiteDatabase;
}

const open: OpenDatabase = async (name) => {
  opened.push(name);
  return fakeConnection(mainSql);
};

const PRAGMAS_PER_CONNECTION = ['PRAGMA foreign_keys = ON;', `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`];

beforeEach(() => {
  mainSql.length = 0;
  txnSql.length = 0;
  opened.length = 0;
});

test('the busy timeout is five seconds', () => {
  expect(BUSY_TIMEOUT_MS).toBe(5000);
});

test('opens the named database in WAL, with foreign keys on and the busy timeout set', async () => {
  await createExpoDb('roadwise.db', open);
  expect(opened).toEqual(['roadwise.db']);
  expect(mainSql).toEqual(['PRAGMA journal_mode = WAL;', ...PRAGMAS_PER_CONNECTION]);
});

test('every transaction connection gets foreign keys and the busy timeout before the body runs', async () => {
  const db = await createExpoDb('roadwise.db', open);
  const out = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"mph"']);
    return 'committed';
  });
  await db.transaction((tx) => tx.execute('DELETE FROM settings'));

  expect(out).toBe('committed');
  expect(txnSql).toEqual([
    [...PRAGMAS_PER_CONNECTION, 'INSERT INTO settings (key, value_json) VALUES (?, ?)'],
    [...PRAGMAS_PER_CONNECTION, 'DELETE FROM settings'],
  ]);
  // The bodies ran on their own connections, never on the main handle.
  expect(mainSql.filter((sql) => !sql.startsWith('PRAGMA'))).toEqual([]);
});

test('a statement on the main handle runs there', async () => {
  const db = await createExpoDb('roadwise.db', open);
  await expect(db.execute('SELECT 1')).resolves.toEqual({ rows: [], changes: 0 });
  expect(mainSql[mainSql.length - 1]).toBe('SELECT 1');
  expect(txnSql).toEqual([]);
});

test('nested transactions are refused, as the sql.js driver refuses them', async () => {
  const db = await createExpoDb('roadwise.db', open);
  await expect(
    db.transaction(async (tx) => tx.transaction(async () => 'inner'))
  ).rejects.toThrow('nested transactions are not supported');
});
