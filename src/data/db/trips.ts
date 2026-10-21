import type { Db } from '@/data/db/driver';
import { MissingTripError } from '@/data/db/errors';
import {
  asEnum,
  asFlag,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
  insertStatement,
  updateStatement,
} from '@/data/db/row';
import {
  DRIVE_ORIGINS,
  START_SOURCES,
  TRIP_END_CAUSES,
  TRIP_STATUSES,
  type Flag,
  type NewTrip,
  type StartSource,
  type TripEndCause,
  type TripPatch,
  type TripRow,
  type TripStatus,
} from '@/data/db/types';

/** The writable columns, in schema order. Nothing outside this list can reach the SQL. */
const COLUMNS = [
  'client_trip_id',
  'started_at',
  'ended_at',
  'tz',
  'local_day',
  'miles',
  'night_miles',
  'duration_s',
  'start_lat',
  'start_lng',
  'end_lat',
  'end_lng',
  'polyline',
  'from_label',
  'to_label',
  'max_speed_mph',
  'integrity_json',
  'status',
  'clean',
  'counts_json',
  'reason',
  'merged_into',
  'result_json',
  'server_id',
  'sync_error',
  'checkpoint_ts',
  'created_at',
  'updated_at',
  'continues',
  'end_cause',
  'watched_miles',
  'origin',
  'not_driving_expired',
  'continuations',
  'finalized_at',
  'start_source',
  'last_seq',
  'slowdowns',
  'speedups',
  'turns',
  'limit_s',
  'moving_s',
] as const;

/** Every column except the primary key and `created_at`, which a patch must not move. */
const PATCHABLE = COLUMNS.filter((column) => column !== 'client_trip_id' && column !== 'created_at');

const asFlagOrNull = (row: Record<string, unknown>, key: string): Flag | null => {
  const v = asNumberOrNull(row, key);
  return v === null ? null : v === 0 ? 0 : 1;
};

/** A stored end cause this build knows, else null (never a throw: the note is optional). */
const endCauseOf = (v: string | null): TripEndCause | null => (TRIP_END_CAUSES as readonly string[]).includes(v ?? '') ? (v as TripEndCause) : null;

/** A stored start source this build knows, else null (the column's CHECK keeps it so anyway). */
const startSourceOf = (v: string | null): StartSource | null => (START_SOURCES as readonly string[]).includes(v ?? '') ? (v as StartSource) : null;

export function toTripRow(row: Record<string, unknown>): TripRow {
  return {
    client_trip_id: asText(row, 'client_trip_id'),
    started_at: asNumber(row, 'started_at'),
    ended_at: asNumberOrNull(row, 'ended_at'),
    tz: asText(row, 'tz'),
    local_day: asTextOrNull(row, 'local_day'),
    miles: asNumber(row, 'miles'),
    night_miles: asNumber(row, 'night_miles'),
    duration_s: asNumber(row, 'duration_s'),
    start_lat: asNumberOrNull(row, 'start_lat'),
    start_lng: asNumberOrNull(row, 'start_lng'),
    end_lat: asNumberOrNull(row, 'end_lat'),
    end_lng: asNumberOrNull(row, 'end_lng'),
    polyline: asTextOrNull(row, 'polyline'),
    from_label: asTextOrNull(row, 'from_label'),
    to_label: asTextOrNull(row, 'to_label'),
    max_speed_mph: asNumber(row, 'max_speed_mph'),
    integrity_json: asTextOrNull(row, 'integrity_json'),
    status: asEnum(row, 'status', TRIP_STATUSES),
    clean: asFlagOrNull(row, 'clean'),
    counts_json: asTextOrNull(row, 'counts_json'),
    reason: asTextOrNull(row, 'reason'),
    merged_into: asTextOrNull(row, 'merged_into'),
    result_json: asTextOrNull(row, 'result_json'),
    server_id: asTextOrNull(row, 'server_id'),
    sync_error: asTextOrNull(row, 'sync_error'),
    checkpoint_ts: asNumberOrNull(row, 'checkpoint_ts'),
    created_at: asNumber(row, 'created_at'),
    updated_at: asNumber(row, 'updated_at'),
    continues: asFlag(row, 'continues'),
    end_cause: endCauseOf(asTextOrNull(row, 'end_cause')),
    watched_miles: asNumberOrNull(row, 'watched_miles') ?? 0,
    origin: asEnum(row, 'origin', DRIVE_ORIGINS),
    not_driving_expired: asFlag(row, 'not_driving_expired'),
    continuations: asNumberOrNull(row, 'continuations') ?? 0,
    finalized_at: asNumberOrNull(row, 'finalized_at'),
    start_source: startSourceOf(asTextOrNull(row, 'start_source')),
    last_seq: asNumberOrNull(row, 'last_seq'),
    slowdowns: asNumberOrNull(row, 'slowdowns'),
    speedups: asNumberOrNull(row, 'speedups'),
    turns: asNumberOrNull(row, 'turns'),
    limit_s: asNumberOrNull(row, 'limit_s'),
    moving_s: asNumberOrNull(row, 'moving_s'),
  };
}

export interface TripListOptions {
  limit?: number;
  offset?: number;
  status?: TripStatus;
}

/**
 * Throw unless `clientTripId` names a trip, using the handle it is given so the check sees the
 * same transaction as the write that follows it (foreign keys may be off inside a device
 * transaction, see `createExpoDb`).
 */
export async function assertTripExists(on: Db, clientTripId: string): Promise<void> {
  const { rows } = await on.execute('SELECT 1 FROM trips WHERE client_trip_id = ?', [clientTripId]);
  if (rows.length === 0) throw new MissingTripError(clientTripId);
}

export function createTripsRepo(db: Db) {
  async function get(clientTripId: string, on: Db = db): Promise<TripRow | null> {
    const { rows } = await on.execute('SELECT * FROM trips WHERE client_trip_id = ?', [clientTripId]);
    const row = rows[0];
    return row ? toTripRow(row) : null;
  }

  /** Applies the named columns and always moves `updated_at`. Null when there is no such trip. */
  async function update(clientTripId: string, patch: TripPatch, now: number = Date.now(), on: Db = db): Promise<TripRow | null> {
    const statement = updateStatement('trips', PATCHABLE, { ...patch, updated_at: now }, 'client_trip_id = ?', [clientTripId]);
    if (!statement) return null;
    const { changes } = await on.execute(statement.sql, statement.params);
    return changes === 0 ? null : get(clientTripId, on);
  }

  return {
    get,
    update,

    async insert(trip: NewTrip, now: number = Date.now(), on: Db = db): Promise<TripRow> {
      const { sql, params } = insertStatement('trips', COLUMNS, { ...trip, created_at: now, updated_at: now });
      await on.execute(sql, params);
      const inserted = await get(trip.client_trip_id, on);
      if (!inserted) throw new Error(`trip ${trip.client_trip_id} vanished after insert`);
      return inserted;
    },

    /** Newest first. */
    async list(options: TripListOptions = {}): Promise<TripRow[]> {
      const { limit = -1, offset = 0, status } = options;
      const where = status ? 'WHERE status = ?' : '';
      const params = status ? [status, limit, offset] : [limit, offset];
      const { rows } = await db.execute(
        `SELECT * FROM trips ${where} ORDER BY started_at DESC, client_trip_id ASC LIMIT ? OFFSET ?`,
        params
      );
      return rows.map(toTripRow);
    },

    /** Every trip still `recording` (crash recovery), oldest first. */
    async listRecording(): Promise<TripRow[]> {
      const { rows } = await db.execute("SELECT * FROM trips WHERE status = 'recording' ORDER BY started_at ASC");
      return rows.map(toTripRow);
    },

    async count(): Promise<number> {
      const { rows } = await db.execute('SELECT count(*) AS n FROM trips');
      return asNumber(rows[0] ?? {}, 'n');
    },

    /**
     * When the phone's most recent closed drive ended (merged ones included: they were driven too),
     * or null. A drive started within `MERGE_GAP_S` of it has no warm-up.
     */
    async lastEndedAt(): Promise<number | null> {
      const { rows } = await db.execute("SELECT MAX(ended_at) AS t FROM trips WHERE status != 'recording' AND ended_at IS NOT NULL");
      return asNumberOrNull(rows[0] ?? {}, 't');
    },

    /** The latest drive that is not merged away or still recording. */
    async latestFinished(): Promise<TripRow | null> {
      const { rows } = await db.execute(
        "SELECT * FROM trips WHERE status NOT IN ('recording', 'merged') ORDER BY started_at DESC LIMIT 1"
      );
      const row = rows[0];
      return row ? toTripRow(row) : null;
    },

    checkpoint: (clientTripId: string, checkpointTs: number, now: number = Date.now(), on?: Db) =>
      update(clientTripId, { checkpoint_ts: checkpointTs }, now, on),

    /** Stamp when the drive's end was decided (the upload hold and a re-open run from it). Null when there is no such trip. */
    setFinalized: (clientTripId: string, at: number, on?: Db) => update(clientTripId, { finalized_at: at }, at, on),

    /**
     * Re-open a finished drive the car has set off again from, within the upload hold: the row goes
     * back to `recording` with no end (`ended_at`, `end_cause`, `finalized_at` cleared), one more
     * continuation, and its checkpoint at its newest sample, so the engine resumes after the rows it
     * already holds. Only a `pending` drive (its upload held, never sent) can be re-opened; anything
     * else answers null and nothing changes.
     */
    async reopen(clientTripId: string, now: number = Date.now(), on: Db = db): Promise<TripRow | null> {
      const { changes } = await on.execute(
        `UPDATE trips SET status = 'recording', ended_at = NULL, end_cause = NULL, finalized_at = NULL,
           continuations = continuations + 1,
           checkpoint_ts = (SELECT MAX(ts) FROM samples WHERE samples.client_trip_id = trips.client_trip_id),
           sync_error = NULL, updated_at = ?
         WHERE client_trip_id = ? AND status = 'pending'`,
        [now, clientTripId]
      );
      return changes === 0 ? null : get(clientTripId, on);
    },

    /** Takes the trip's events, samples and DashPal coverage with it (explicitly: foreign keys may be off in a device transaction). */
    async remove(clientTripId: string, on: Db = db): Promise<boolean> {
      await on.execute('DELETE FROM samples WHERE client_trip_id = ?', [clientTripId]);
      await on.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [clientTripId]);
      await on.execute('DELETE FROM dashcam_coverage WHERE client_trip_id = ?', [clientTripId]);
      const { changes } = await on.execute('DELETE FROM trips WHERE client_trip_id = ?', [clientTripId]);
      return changes > 0;
    },
  };
}

export type TripsRepo = ReturnType<typeof createTripsRepo>;
