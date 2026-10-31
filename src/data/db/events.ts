import { EVENT_TYPES, TIERS } from '@/data/sync/payload';
import type { Db } from '@/data/db/driver';
import { asEnum, asNumber, asNumberOrNull, asText, asTextOrNull, insertStatement, updateStatement } from '@/data/db/row';
import { assertTripExists } from '@/data/db/trips';
import { DISPUTE_STATUSES, type EventPatch, type EventRow, type NewEvent } from '@/data/db/types';

const COLUMNS = [
  'id',
  'client_trip_id',
  'type',
  'tier',
  'started_at',
  'duration_s',
  'lat',
  'lng',
  'measured_json',
  'status',
  'dispute_status',
  'dispute_reason',
  'dispute_message',
  'lat_full',
  'lng_full',
] as const;

/** An event's id is its identity, and its `client_trip_id` never changes after insert. */
const PATCHABLE = COLUMNS.filter((column) => column !== 'id' && column !== 'client_trip_id');

export function toEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: asText(row, 'id'),
    client_trip_id: asText(row, 'client_trip_id'),
    type: asEnum(row, 'type', EVENT_TYPES),
    tier: asEnum(row, 'tier', TIERS),
    started_at: asNumber(row, 'started_at'),
    duration_s: asNumber(row, 'duration_s'),
    lat: asNumberOrNull(row, 'lat'),
    lng: asNumberOrNull(row, 'lng'),
    lat_full: asNumberOrNull(row, 'lat_full'),
    lng_full: asNumberOrNull(row, 'lng_full'),
    measured_json: asTextOrNull(row, 'measured_json'),
    status: asEnum(row, 'status', ['active', 'removed'] as const),
    dispute_status: asEnum(row, 'dispute_status', DISPUTE_STATUSES),
    dispute_reason: asTextOrNull(row, 'dispute_reason'),
    dispute_message: asTextOrNull(row, 'dispute_message'),
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

    /** All or nothing. Given a transaction handle `on`, the batch joins that transaction. */
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

    /** Oldest first — the order the summary lists them in. */
    async listByTrip(clientTripId: string, on: Db = db): Promise<EventRow[]> {
      const { rows } = await on.execute(
        'SELECT * FROM trip_events WHERE client_trip_id = ? ORDER BY started_at ASC, id ASC',
        [clientTripId]
      );
      return rows.map(toEventRow);
    },

    async update(id: string, patch: EventPatch, on: Db = db): Promise<EventRow | null> {
      const statement = updateStatement('trip_events', PATCHABLE, patch, 'id = ?', [id]);
      if (!statement) return get(id, on);
      const { changes } = await on.execute(statement.sql, statement.params);
      return changes === 0 ? null : get(id, on);
    },

    async remove(id: string, on: Db = db): Promise<number> {
      const { changes } = await on.execute('DELETE FROM trip_events WHERE id = ?', [id]);
      return changes;
    },

    async removeByTrip(clientTripId: string, on: Db = db): Promise<number> {
      const { changes } = await on.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [clientTripId]);
      return changes;
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
