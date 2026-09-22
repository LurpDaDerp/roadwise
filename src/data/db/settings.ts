import type { Db } from '@/data/db/driver';
import { asText } from '@/data/db/row';

/**
 * Device-local preferences — units, text size, which one-off banners have been dismissed —
 * stored as JSON per key.
 *
 * The values are written by this app and never come off the wire, so `get` casts the parsed
 * JSON to the caller's type rather than validating it. A key holding a literal `null` is
 * indistinguishable from a key that was never set; use `remove` to clear one.
 */
export function createSettingsRepo(db: Db) {
  async function get<T>(key: string): Promise<T | null> {
    const { rows } = await db.execute('SELECT value_json FROM settings WHERE key = ?', [key]);
    const row = rows[0];
    if (!row) return null;
    return JSON.parse(asText(row, 'value_json')) as T;
  }

  return {
    get,

    getOr: async <T>(key: string, fallback: T): Promise<T> => (await get<T>(key)) ?? fallback,

    async set(key: string, value: unknown): Promise<void> {
      await db.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
        key,
        JSON.stringify(value),
      ]);
    },

    async remove(key: string): Promise<boolean> {
      const { changes } = await db.execute('DELETE FROM settings WHERE key = ?', [key]);
      return changes > 0;
    },

    /**
     * Several keys in one read (the drive host's arming check, Task 19 r2). A key never set is
     * absent from the result. Rejects on a read failure, like `get`.
     */
    async getMany(keys: readonly string[]): Promise<Record<string, unknown>> {
      if (keys.length === 0) return {};
      const { rows } = await db.execute(
        `SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
        [...keys]
      );
      const out: Record<string, unknown> = {};
      for (const row of rows) out[asText(row, 'key')] = JSON.parse(asText(row, 'value_json'));
      return out;
    },

    /** Every setting at once, for hydrating a store at launch. */
    async all(): Promise<Record<string, unknown>> {
      const { rows } = await db.execute('SELECT key, value_json FROM settings ORDER BY key ASC');
      const out: Record<string, unknown> = {};
      for (const row of rows) out[asText(row, 'key')] = JSON.parse(asText(row, 'value_json'));
      return out;
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
