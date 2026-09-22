import type { Db } from '@/data/db/driver';
import { asNumberOrNull, asText } from '@/data/db/row';
import type { ScoreDailyCache } from '@/data/db/types';

/**
 * The server's day evaluation (§9.9), cached one row per local calendar date.
 *
 * `finalize-trip` returns the day its trip belongs to, already evaluated over every trip the
 * server holds for that date; the sync runner drops it in here so the home screen can show
 * today's badges with no network. The cache is advisory and always replaceable: a miss just
 * means the screen waits for the next upload, and the newest write for a day wins — the server
 * recomputes the whole day each time, so an older payload is never worth keeping.
 *
 * `day` sorts lexicographically because it is `YYYY-MM-DD`, which is what `range` relies on.
 */
export function createScoreDailyCacheRepo(db: Db) {
  function toEntry<T>(row: Record<string, unknown>): ScoreDailyCache<T> {
    return {
      day: asText(row, 'day'),
      payload: JSON.parse(asText(row, 'payload_json')) as T,
      updated_at: asNumberOrNull(row, 'updated_at'),
    };
  }

  return {
    /** Runs on `on` when given, so the day commits with the trip row the same response settled. */
    async put(
      day: string,
      payload: unknown,
      now: number = Date.now(),
      on: Db = db
    ): Promise<void> {
      await on.execute(
        'INSERT OR REPLACE INTO score_daily_cache (day, payload_json, updated_at) VALUES (?, ?, ?)',
        [day, JSON.stringify(payload), now]
      );
    },

    async get<T>(day: string): Promise<ScoreDailyCache<T> | null> {
      const { rows } = await db.execute('SELECT * FROM score_daily_cache WHERE day = ?', [day]);
      const row = rows[0];
      return row ? toEntry<T>(row) : null;
    },

    /**
     * The newest day on record — the highest `day`, whenever it was written. The long-term score
     * is read from this row alone (R9): an older row may have been overwritten by a later sync
     * with a value that is no longer current, so there is no fallback walk to it.
     */
    async latest<T>(): Promise<ScoreDailyCache<T> | null> {
      const { rows } = await db.execute('SELECT * FROM score_daily_cache ORDER BY day DESC LIMIT 1');
      const row = rows[0];
      return row ? toEntry<T>(row) : null;
    },

    /** Both ends inclusive, oldest first — the order a week strip renders in. */
    async range<T>(fromDay: string, toDay: string): Promise<ScoreDailyCache<T>[]> {
      const { rows } = await db.execute(
        'SELECT * FROM score_daily_cache WHERE day >= ? AND day <= ? ORDER BY day ASC',
        [fromDay, toDay]
      );
      return rows.map((row) => toEntry<T>(row));
    },

    async remove(day: string): Promise<boolean> {
      const { changes } = await db.execute('DELETE FROM score_daily_cache WHERE day = ?', [day]);
      return changes > 0;
    },

    /** Housekeeping: days before the cutoff are older than any screen looks back. */
    async purgeBefore(day: string): Promise<number> {
      const { changes } = await db.execute('DELETE FROM score_daily_cache WHERE day < ?', [day]);
      return changes;
    },
  };
}

export type ScoreDailyCacheRepo = ReturnType<typeof createScoreDailyCacheRepo>;
