import type { Db } from '@/data/db/driver';
import { asNumber, asText } from '@/data/db/row';
import type { Tile } from '@/data/db/types';

/**
 * Prefetched speed-limit segments, one row per map tile.
 *
 * The cache is advisory: a miss or a stale tile just means asking the `speed-limits` function
 * again. `expires_at` is the server's TTL (≤ 30 days), and a tile counts as stale the instant it
 * is reached.
 */
export function createTilesRepo(db: Db) {
  return {
    async putTile(tileKey: string, expiresAt: number, segments: unknown): Promise<void> {
      await db.execute(
        'INSERT OR REPLACE INTO speed_limit_tiles (tile_key, expires_at, segments_json) VALUES (?, ?, ?)',
        [tileKey, expiresAt, JSON.stringify(segments)]
      );
    },

    /** Null for a tile that was never fetched, and for one that has expired by `now`. */
    async getTile<T>(tileKey: string, now: number = Date.now()): Promise<Tile<T> | null> {
      const { rows } = await db.execute(
        'SELECT * FROM speed_limit_tiles WHERE tile_key = ? AND expires_at > ?',
        [tileKey, now]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        tile_key: asText(row, 'tile_key'),
        expires_at: asNumber(row, 'expires_at'),
        segments: JSON.parse(asText(row, 'segments_json')) as T,
      };
    },

    /** Returns how many stale tiles went. */
    async purgeExpired(now: number = Date.now()): Promise<number> {
      const { changes } = await db.execute('DELETE FROM speed_limit_tiles WHERE expires_at <= ?', [
        now,
      ]);
      return changes;
    },

    async count(): Promise<number> {
      const { rows } = await db.execute('SELECT count(*) AS n FROM speed_limit_tiles');
      return asNumber(rows[0] ?? {}, 'n');
    },
  };
}

export type TilesRepo = ReturnType<typeof createTilesRepo>;
