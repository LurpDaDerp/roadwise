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
   * Run `fn` inside a transaction, committing on resolve and rolling back on throw. The `tx`
   * handed to `fn` is the transactional handle — use it, not the outer `Db`, inside the callback.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/**
 * The on-device driver: WAL for concurrent reads while the engine writes 1 Hz sample rows, and
 * foreign keys ON so deleting a trip takes its events and samples with it.
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

  const db: Db = {
    async execute(sql: string, params: unknown[] = []): Promise<DbResult> {
      const statement = await native.prepareAsync(sql);
      try {
        const result = await statement.executeAsync<Record<string, unknown>>(
          params as (string | number | boolean | null | Uint8Array)[]
        );
        const rows = await result.getAllAsync();
        return { rows, changes: result.changes };
      } finally {
        await statement.finalizeAsync();
      }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      let out!: T;
      await native.withTransactionAsync(async () => {
        out = await fn(db);
      });
      return out;
    },
  };

  return db;
}
