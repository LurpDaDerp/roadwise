import type { Db } from '@/data/db/driver';
import {
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V11,
  SCHEMA_VERSION_TABLE,
} from '@/data/db/schema';

interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/**
 * Append-only. A released version's statements are never edited — a change ships as the next
 * entry, so a device that already ran version N only runs what comes after N.
 */
const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: SCHEMA_V1 },
  { version: 2, statements: SCHEMA_V2 },
  { version: 3, statements: SCHEMA_V3 },
  { version: 4, statements: SCHEMA_V4 },
  { version: 5, statements: SCHEMA_V5 },
  { version: 6, statements: SCHEMA_V6 },
  { version: 7, statements: SCHEMA_V7 },
  { version: 8, statements: SCHEMA_V8 },
  { version: 9, statements: SCHEMA_V9 },
  { version: 10, statements: SCHEMA_V10 },
  { version: 11, statements: SCHEMA_V11 },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Bring `db` up to `CURRENT_SCHEMA_VERSION` and return the version reached. Idempotent, and one
 * transaction: SQLite makes DDL transactional, so a crash mid-way leaves the database at the
 * version it started from.
 */
export async function migrate(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(SCHEMA_VERSION_TABLE);

    const { rows } = await tx.execute('SELECT version FROM schema_version LIMIT 1');
    const recorded = rows[0]?.version;
    const from = typeof recorded === 'number' ? recorded : 0;

    let version = from;
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      for (const statement of migration.statements) await tx.execute(statement);
      version = migration.version;
    }

    if (version !== from) {
      const sql = from === 0 ? 'INSERT INTO schema_version (version) VALUES (?)' : 'UPDATE schema_version SET version = ?';
      await tx.execute(sql, [version]);
    }

    return version;
  });
}
