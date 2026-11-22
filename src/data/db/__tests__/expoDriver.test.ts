import type { SQLiteDatabase } from 'expo-sqlite';
import { BUSY_TIMEOUT_MS, createExpoDb, type OpenDatabase } from '@/data/db/driver';
import { isDatabaseLocked } from '@/data/sync/response';

/**
 * `createExpoDb` over a fake native handle. `driver.test.ts` pins the `Db` contract through
 * sql.js; this suite pins what only the device driver does — the pragmas every connection is
 * opened with, on the main handle and on each exclusive-transaction connection, and how each
 * transaction begins. A connection without `busy_timeout` fails with `database is locked` the
 * moment another writer holds the lock, and so does a transaction that reads before it takes the
 * lock (SQLite waits out the timeout only for a connection that has read nothing yet), so this is
 * the one place those guarantees are checked. (`expo-sqlite` itself is never loaded: the driver's
 * dynamic import is bypassed by handing it the opener.)
 */

/** Every statement sent to the main connection, in order. */
const mainSql: string[] = [];
/** Every statement sent to each transaction connection: one list per transaction, in order. */
const txnSql: string[][] = [];
const opened: string[] = [];
/** Another connection holds the write lock: a BEGIN IMMEDIATE fails as SQLite's would after the wait. */
let lockHeldElsewhere = false;

/**
 * The slice of `SQLiteDatabase` the driver uses, recording every statement into `sink`. Its
 * `execAsync` keeps SQLite's transaction state, one statement at a time and stopping at the first
 * that fails, like `sqlite3_exec`: a BEGIN inside a transaction, or a COMMIT or ROLLBACK outside
 * one, throws SQLite's own error.
 */
function fakeConnection(sink: string[]): SQLiteDatabase {
  let open: 'none' | 'deferred' | 'immediate' = 'none';
  const run = (statement: string) => {
    if (/^BEGIN/.test(statement)) {
      if (open !== 'none') throw new Error('cannot start a transaction within a transaction');
      if (statement === 'BEGIN IMMEDIATE' && lockHeldElsewhere) throw new Error('database is locked');
      open = statement === 'BEGIN IMMEDIATE' ? 'immediate' : 'deferred';
    } else if (statement === 'COMMIT' || statement === 'ROLLBACK') {
      if (open === 'none') throw new Error(`cannot ${statement.toLowerCase()} - no transaction is active`);
      open = 'none';
    }
  };
  const fake = {
    execAsync: async (sql: string) => {
      sink.push(sql);
      for (const statement of sql.split(';').map((s) => s.trim()).filter((s) => s !== '')) run(statement);
    },
    prepareAsync: async (sql: string) => ({
      executeAsync: async () => {
        // Each statement a body sends is recorded with the kind of transaction it ran in.
        sink.push(open === 'none' ? sql : `${sql} [${open}]`);
        return { changes: 0, getAllAsync: async () => [] };
      },
      finalizeAsync: async () => {},
    }),
    // Like expo (`SQLiteDatabase.withExclusiveTransactionAsync`): a fresh connection per exclusive
    // transaction, a plain BEGIN on it before the task, COMMIT after, ROLLBACK and rethrow on a throw.
    withExclusiveTransactionAsync: async (task: (txn: SQLiteDatabase) => Promise<void>) => {
      const inner: string[] = [];
      txnSql.push(inner);
      const txn = fakeConnection(inner);
      let error: unknown;
      try {
        await txn.execAsync('BEGIN');
        await task(txn);
        await txn.execAsync('COMMIT');
      } catch (e) {
        await txn.execAsync('ROLLBACK');
        error = e;
      }
      if (error) throw error;
    },
  };
  return fake as unknown as SQLiteDatabase;
}

const open: OpenDatabase = async (name) => {
  opened.push(name);
  return fakeConnection(mainSql);
};

const PRAGMAS_PER_CONNECTION = ['PRAGMA foreign_keys = ON;', `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`];
/** What the driver sends on a transaction connection before the body runs: expo's BEGIN, the pragmas, then the swap. */
const BEGUN = ['BEGIN', ...PRAGMAS_PER_CONNECTION, 'ROLLBACK; BEGIN IMMEDIATE;'];

beforeEach(() => {
  mainSql.length = 0;
  txnSql.length = 0;
  opened.length = 0;
  lockHeldElsewhere = false;
});

test('the busy timeout is five seconds', () => {
  expect(BUSY_TIMEOUT_MS).toBe(5000);
});

test('opens the named database in WAL, with foreign keys on and the busy timeout set', async () => {
  await createExpoDb('roadwise.db', open);
  expect(opened).toEqual(['roadwise.db']);
  expect(mainSql).toEqual(['PRAGMA journal_mode = WAL;', ...PRAGMAS_PER_CONNECTION]);
});

test('every transaction connection gets foreign keys and the busy timeout, then takes the write lock, before the body runs', async () => {
  const db = await createExpoDb('roadwise.db', open);
  const out = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', ['units', '"mph"']);
    return 'committed';
  });
  await db.transaction((tx) => tx.execute('DELETE FROM settings'));

  expect(out).toBe('committed');
  expect(txnSql).toEqual([
    [...BEGUN, 'INSERT INTO settings (key, value_json) VALUES (?, ?) [immediate]', 'COMMIT'],
    [...BEGUN, 'DELETE FROM settings [immediate]', 'COMMIT'],
  ]);
  // The bodies ran on their own connections, never on the main handle.
  expect(mainSql.filter((sql) => !sql.startsWith('PRAGMA'))).toEqual([]);
});

test('a body that reads before it writes reads inside the immediate transaction, so the lock is held before its first read', async () => {
  const db = await createExpoDb('roadwise.db', open);
  await db.transaction(async (tx) => {
    await tx.execute("SELECT value_json FROM settings WHERE key = 'owner'");
    await tx.execute("UPDATE sync_queue SET status = 'done' WHERE id = 1");
  });
  expect(txnSql).toEqual([
    [...BEGUN, "SELECT value_json FROM settings WHERE key = 'owner' [immediate]", "UPDATE sync_queue SET status = 'done' WHERE id = 1 [immediate]", 'COMMIT'],
  ]);
});

test('when the lock never comes, the caller gets "database is locked" (not a failed rollback) and the body never runs', async () => {
  const db = await createExpoDb('roadwise.db', open);
  lockHeldElsewhere = true;
  const body = jest.fn(async () => 'ran');
  const failure = await db.transaction(body).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('database is locked');
  // The runner's and the engine's release paths still recognise it.
  expect(isDatabaseLocked(failure)).toBe(true);
  expect(body).not.toHaveBeenCalled();
  // The swap's ROLLBACK ran and BEGIN IMMEDIATE failed; a plain BEGIN gave expo's ROLLBACK a transaction to end.
  expect(txnSql).toEqual([[...BEGUN, 'BEGIN;', 'ROLLBACK']]);

  // Once the lock is free, the next transaction goes through as usual.
  lockHeldElsewhere = false;
  await expect(db.transaction(async () => 'committed')).resolves.toBe('committed');
  expect(txnSql[1]).toEqual([...BEGUN, 'COMMIT']);
});

test('a body that throws is rolled back and its error reaches the caller', async () => {
  const db = await createExpoDb('roadwise.db', open);
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('DELETE FROM settings');
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  expect(txnSql).toEqual([[...BEGUN, 'DELETE FROM settings [immediate]', 'ROLLBACK']]);
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
