import type { Db } from '@/data/db/driver';
import {
  asFlag,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
  insertStatement,
  updateStatement,
} from '@/data/db/row';
import { assertTripExists } from '@/data/db/trips';
import type { EventPatch, EventRow, NewEvent } from '@/data/db/types';

const COLUMNS = [
  'id',
  'client_trip_id',
  'category',
  'started_at',
  'duration_s',
  'lat',
  'lng',
  'measured_json',
  'severity',
  'confidence',
  'context_json',
  'deduction',
  'alert_shown',
  'corrected',
  'status',
  'source',
  'dispute_json',
] as const;

/** An event never changes which trip it belongs to, and its id is its identity. */
const PATCHABLE = COLUMNS.filter((column) => column !== 'id' && column !== 'client_trip_id');

function toEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: asText(row, 'id'),
    client_trip_id: asText(row, 'client_trip_id'),
    category: asText(row, 'category'),
    started_at: asNumber(row, 'started_at'),
    duration_s: asNumber(row, 'duration_s'),
    lat: asNumberOrNull(row, 'lat'),
    lng: asNumberOrNull(row, 'lng'),
    measured_json: asTextOrNull(row, 'measured_json'),
    severity: asTextOrNull(row, 'severity'),
    confidence: asNumberOrNull(row, 'confidence'),
    context_json: asTextOrNull(row, 'context_json'),
    deduction: asNumberOrNull(row, 'deduction'),
    alert_shown: asFlag(row, 'alert_shown'),
    corrected: asFlag(row, 'corrected'),
    status: asTextOrNull(row, 'status'),
    source: asTextOrNull(row, 'source'),
    dispute_json: asTextOrNull(row, 'dispute_json'),
  };
}

export function createEventsRepo(db: Db) {
  async function get(id: string, on: Db = db): Promise<EventRow | null> {
    const { rows } = await on.execute('SELECT * FROM trip_events WHERE id = ?', [id]);
    const row = rows[0];
    return row ? toEventRow(row) : null;
  }

  async function insertOn(event: NewEvent, on: Db): Promise<EventRow> {
    const { sql, params } = insertStatement('trip_events', COLUMNS, event);
    await on.execute(sql, params);
    const inserted = await get(event.id, on);
    if (!inserted) throw new Error(`event ${event.id} vanished after insert`);
    return inserted;
  }

  return {
    get: (id: string) => get(id),

    async insert(event: NewEvent): Promise<EventRow> {
      await assertTripExists(db, event.client_trip_id);
      return insertOn(event, db);
    },

    /**
     * All or nothing: a batch naming a trip that is not there writes none of it, and throws
     * `MissingTripError` — checked explicitly inside the transaction rather than left to the
     * foreign key, which may not be enforced there on device.
     *
     * Given a transaction handle `on`, the batch joins that transaction instead of opening its
     * own; atomicity is then the caller's transaction.
     */
    insertMany(events: readonly NewEvent[], on?: Db): Promise<EventRow[]> {
      const run = async (tx: Db): Promise<EventRow[]> => {
        for (const clientTripId of new Set(events.map((event) => event.client_trip_id))) {
          await assertTripExists(tx, clientTripId);
        }
        const written: EventRow[] = [];
        for (const event of events) written.push(await insertOn(event, tx));
        return written;
      };
      return on ? run(on) : db.transaction(run);
    },

    /** Oldest first — the order the trip detail screen lists them in. */
    async listByTrip(clientTripId: string): Promise<EventRow[]> {
      const { rows } = await db.execute(
        'SELECT * FROM trip_events WHERE client_trip_id = ? ORDER BY started_at ASC, id ASC',
        [clientTripId]
      );
      return rows.map(toEventRow);
    },

    async countByTrip(clientTripId: string): Promise<number> {
      const { rows } = await db.execute(
        'SELECT count(*) AS n FROM trip_events WHERE client_trip_id = ?',
        [clientTripId]
      );
      return asNumber(rows[0] ?? {}, 'n');
    },

    /**
     * Used when a dispute is settled: mark corrected, zero the deduction, record the report.
     * Runs on `on` when given, so the event, its trip and the day cache move together.
     */
    async update(id: string, patch: EventPatch, on: Db = db): Promise<EventRow | null> {
      const statement = updateStatement('trip_events', PATCHABLE, patch, 'id = ?', [id]);
      if (!statement) return get(id, on);
      const { changes } = await on.execute(statement.sql, statement.params);
      return changes === 0 ? null : get(id, on);
    },

    /** Runs on `on` when given, so it can share a caller's transaction. */
    async removeByTrip(clientTripId: string, on: Db = db): Promise<number> {
      const { changes } = await on.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [
        clientTripId,
      ]);
      return changes;
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
