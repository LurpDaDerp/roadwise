import type { Flag } from '@/data/db/types';

/**
 * Turning the driver's untyped `Record<string, unknown>` into the row types, and building the
 * two statements whose column list is not fixed at author time (partial insert, partial update).
 *
 * The statement builders take the column names from a module-level allowlist declared next to
 * the table, never from caller data, and every *value* is bound. Nothing here interpolates a
 * value into SQL.
 */

type Row = Record<string, unknown>;

function fail(key: string, value: unknown, expected: string): never {
  throw new TypeError(`column "${key}" is ${JSON.stringify(value) ?? 'undefined'}, expected ${expected}`);
}

export function asText(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : fail(key, value, 'TEXT');
}

export function asTextOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : fail(key, value, 'TEXT or NULL');
}

export function asNumber(row: Row, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : fail(key, value, 'a number');
}

export function asNumberOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : fail(key, value, 'a number or NULL');
}

export function asFlag(row: Row, key: string): Flag {
  return asNumber(row, key) === 0 ? 0 : 1;
}

/** Narrow a CHECK-constrained TEXT column to its union type. */
export function asEnum<T extends string>(row: Row, key: string, allowed: readonly T[]): T {
  const value = asText(row, key);
  const match = allowed.find((candidate) => candidate === value);
  return match ?? fail(key, value, `one of ${allowed.join(', ')}`);
}

export interface Statement {
  sql: string;
  params: unknown[];
}

/**
 * `INSERT INTO <table> (<columns present in values>) VALUES (?, ?, …)`.
 *
 * Only names in `allowed` reach the SQL; `undefined` entries are skipped so the column keeps its
 * schema default.
 */
export function insertStatement(
  table: string,
  allowed: readonly string[],
  values: Row,
  conflict: '' | ' OR REPLACE' | ' OR IGNORE' = ''
): Statement {
  const columns = allowed.filter((column) => values[column] !== undefined);
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT${conflict} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    params: columns.map((column) => values[column]),
  };
}

/**
 * `UPDATE <table> SET <columns present in patch> WHERE <where>`, or `null` when the patch names
 * no known column — the caller decides whether that is a no-op or an error.
 */
export function updateStatement(
  table: string,
  allowed: readonly string[],
  patch: Row,
  where: string,
  whereParams: unknown[]
): Statement | null {
  const columns = allowed.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return null;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  return {
    sql: `UPDATE ${table} SET ${assignments} WHERE ${where}`,
    params: [...columns.map((column) => patch[column]), ...whereParams],
  };
}
