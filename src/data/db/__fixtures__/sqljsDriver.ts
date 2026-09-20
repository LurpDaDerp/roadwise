import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import type { Db, DbResult } from '@/data/db/driver';

/**
 * A `Db` over sql.js, for tests only.
 *
 * sql.js is the real SQLite engine compiled to WebAssembly, so CHECK constraints, `ON DELETE
 * CASCADE`, `AUTOINCREMENT` and index behaviour match the device. Loading the wasm needs Node's
 * `fs`, so every suite that uses this driver must declare `@jest-environment node`.
 *
 * sql.js is a single in-memory connection, so `transaction()` issues plain BEGIN/COMMIT/ROLLBACK
 * and hands the *same* handle back as `tx` — unlike the device driver, where `tx` is a separate
 * connection. Both refuse a nested `transaction()` with the same error, so code written against
 * the interface behaves the same either way.
 */

let runtime: Promise<SqlJsStatic> | undefined;

function loadSqlJs(): Promise<SqlJsStatic> {
  // No `locateFile`: the CommonJS Node build of sql.js finds `sql-wasm.wasm` beside itself. That
  // keeps this file free of Node globals — the root tsconfig's `types` is `["jest"]`, so
  // `require.resolve` would not typecheck here.
  runtime ??= initSqlJs();
  return runtime;
}

/** sql.js binds only these; normalise the booleans and `undefined` a caller might pass. */
type SqlJsValue = number | string | Uint8Array | null;

function toBindValue(value: unknown): SqlJsValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`sql.js cannot bind a value of type ${typeof value}`);
}

function run(raw: Database, sql: string, params: unknown[]): DbResult {
  const statement = raw.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params.map(toBindValue));
    const rows: Record<string, unknown>[] = [];
    // `step()` both executes the statement and advances it, so writes run even though they
    // produce no rows.
    while (statement.step()) rows.push(statement.getAsObject());
    return { rows, changes: raw.getRowsModified() };
  } finally {
    statement.free();
  }
}

function wrap(raw: Database, insideTransaction: boolean): Db {
  const db: Db = {
    // `async` so that a SQLite error surfaces as a rejection, the way the native driver's would.
    async execute(sql: string, params: unknown[] = []): Promise<DbResult> {
      return run(raw, sql, params);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (insideTransaction) {
        throw new Error('Db.transaction: nested transactions are not supported');
      }
      raw.run('BEGIN;');
      try {
        const out = await fn(wrap(raw, true));
        raw.run('COMMIT;');
        return out;
      } catch (error) {
        raw.run('ROLLBACK;');
        throw error;
      }
    },
  };
  return db;
}

export async function createSqlJsDb(): Promise<Db> {
  const SQL = await loadSqlJs();
  const raw = new SQL.Database();
  // Must be set outside any transaction, and it is off by default in SQLite.
  raw.run('PRAGMA foreign_keys = ON;');
  return wrap(raw, false);
}
