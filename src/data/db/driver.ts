import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * The one database seam the app talks through.
 *
 * Every repository takes a `Db` rather than reaching for `expo-sqlite` itself, so the same code
 * runs against the native database on device and against sql.js under Jest. Keep this surface
 * tiny: one way to run a statement, one way to group statements atomically.
 */
export interface DbResult {
  /** Rows a SELECT produced, column name → value. Empty for writes. */
  rows: Record<string, unknown>[];
  /** `sqlite3_changes()` — rows inserted, updated or deleted by the statement. */
  changes: number;
}

export interface Db {
  /** Run one statement with bound parameters. Never interpolate values into `sql`. */
  execute(sql: string, params?: unknown[]): Promise<DbResult>;
  /**
   * Run `fn` inside a transaction, committing on resolve and rolling back on throw.
   *
   * **Use the `tx` handed to `fn`, not the outer `Db`.** On device `tx` is a separate connection
   * holding the transaction; a statement sent to the outer handle would run outside it and would
   * not be rolled back.
   *
   * **Nested and overlapping transactions are not supported.** `tx.transaction(...)` throws, and
   * a driver holds one transaction at a time — the engine appending sample rows and the uploader
   * draining the queue must not both be inside one.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Values SQLite can bind. Anything else is a programming error at the call site. */
type BindValue = string | number | boolean | null | Uint8Array;

function wrapExpo(native: SQLiteDatabase, insideTransaction: boolean): Db {
  return {
    async execute(sql: string, params: unknown[] = []): Promise<DbResult> {
      const statement = await native.prepareAsync(sql);
      try {
        const result = await statement.executeAsync<Record<string, unknown>>(params as BindValue[]);
        const rows = await result.getAllAsync();
        return { rows, changes: result.changes };
      } finally {
        await statement.finalizeAsync();
      }
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (insideTransaction) {
        throw new Error('Db.transaction: nested transactions are not supported');
      }

      let out!: T;
      let ran = false;
      // Exclusive, not `withTransactionAsync`: that one issues BEGIN/COMMIT on the shared
      // connection, so an unrelated concurrent write (the engine appending a 1 Hz row while the
      // uploader drains the queue) would be swept into — and rolled back with — this
      // transaction. `withExclusiveTransactionAsync` opens its own connection and hands it over
      // as `txn`; other writers get `database is locked` and retry rather than being undone.
      await native.withExclusiveTransactionAsync(async (txn) => {
        // Foreign keys are per-connection and default to off, and `txn` is a fresh connection.
        // SQLite treats this as a no-op once a transaction is open (expo issues BEGIN before
        // handing `txn` over), so it may not take effect — see the note on `createExpoDb`.
        await txn.execAsync('PRAGMA foreign_keys = ON;');
        out = await fn(wrapExpo(txn, true));
        ran = true;
      });
      // `withExclusiveTransactionAsync` rethrows whatever the task threw, so reaching here
      // without having run means expo changed its contract rather than the task failing.
      if (!ran) throw new Error('Db.transaction: the transaction body did not run');
      return out;
    },
  };
}

/**
 * The on-device driver: WAL for concurrent reads while the engine writes 1 Hz sample rows, and
 * foreign keys ON so deleting a trip takes its events and samples with it.
 *
 * Known caveat: `expo-sqlite` runs an exclusive transaction on its own connection and opens the
 * transaction before handing the handle over, so `PRAGMA foreign_keys` cannot be set for it.
 * Statements inside a `transaction()` may therefore run with foreign keys off on device — the
 * atomicity guarantees hold, but a cascade or a rejected orphan row inside a transaction does
 * not. Repositories rely on foreign keys only outside transactions (`trips.remove`); the one
 * place a test leans on it inside one is `events.insertMany`.
 *
 * `expo-sqlite` is imported lazily so that importing this module (for the `Db` type, or for a
 * repository that only ever sees an injected `Db`) never pulls a native module into a test
 * process. No Jest suite calls this function.
 */
export async function createExpoDb(name: string): Promise<Db> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  const native = await openDatabaseAsync(name);
  await native.execAsync('PRAGMA journal_mode = WAL;');
  await native.execAsync('PRAGMA foreign_keys = ON;');
  return wrapExpo(native, false);
}
