import type { Db } from '@/data/db/driver';
import { asNumber, asText } from '@/data/db/row';
import type { SampleRow } from '@/data/db/types';

/**
 * The 1 Hz feature rows for the trip being recorded. They exist so scoring and the trace export
 * can replay the drive; once the trace is written they are purged, which is what keeps this
 * table from growing without bound.
 */

function toSampleRow(row: Record<string, unknown>): SampleRow {
  return {
    client_trip_id: asText(row, 'client_trip_id'),
    ts: asNumber(row, 'ts'),
    row_json: asText(row, 'row_json'),
  };
}

// The native module can redeliver a second it already sent (a batch flushed twice across a
// relaunch); replacing is right, and crashing the recorder over it is not.
const APPEND =
  'INSERT OR REPLACE INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)';

export function createSamplesRepo(db: Db) {
  return {
    async append(clientTripId: string, ts: number, row: unknown): Promise<void> {
      await db.execute(APPEND, [clientTripId, ts, JSON.stringify(row)]);
    },

    /** One transaction per batch: a partial batch is never visible to a reader. */
    appendMany(
      clientTripId: string,
      rows: readonly { ts: number; row: unknown }[]
    ): Promise<void> {
      return db.transaction(async (tx) => {
        for (const { ts, row } of rows) {
          await tx.execute(APPEND, [clientTripId, ts, JSON.stringify(row)]);
        }
      });
    },

    /** Inclusive at both ends, oldest first. */
    async range(clientTripId: string, fromTs: number, toTs: number): Promise<SampleRow[]> {
      const { rows } = await db.execute(
        'SELECT * FROM samples WHERE client_trip_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC',
        [clientTripId, fromTs, toTs]
      );
      return rows.map(toSampleRow);
    },

    async latest(clientTripId: string): Promise<SampleRow | null> {
      const { rows } = await db.execute(
        'SELECT * FROM samples WHERE client_trip_id = ? ORDER BY ts DESC LIMIT 1',
        [clientTripId]
      );
      const row = rows[0];
      return row ? toSampleRow(row) : null;
    },

    async count(clientTripId: string): Promise<number> {
      const { rows } = await db.execute(
        'SELECT count(*) AS n FROM samples WHERE client_trip_id = ?',
        [clientTripId]
      );
      return asNumber(rows[0] ?? {}, 'n');
    },

    /** Called once the trace has been exported. Returns how many rows went. */
    async purgeByTrip(clientTripId: string): Promise<number> {
      const { changes } = await db.execute('DELETE FROM samples WHERE client_trip_id = ?', [
        clientTripId,
      ]);
      return changes;
    },
  };
}

export type SamplesRepo = ReturnType<typeof createSamplesRepo>;
