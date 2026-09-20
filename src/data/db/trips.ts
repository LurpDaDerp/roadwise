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
  TRIP_STATUSES,
  TRIP_SYNC_STATES,
  type NewTrip,
  type TripPatch,
  type TripRow,
  type TripStatus,
  type TripSyncState,
} from '@/data/db/types';

/** The writable columns, in schema order. Nothing outside this list can reach the SQL. */
const COLUMNS = [
  'client_trip_id',
  'started_at',
  'ended_at',
  'tz',
  'distance_m',
  'duration_s',
  'role',
  'role_confidence',
  'role_source',
  'mode',
  'camera_session',
  'score',
  'scoring_version',
  'category_deductions_json',
  'exposure',
  'data_quality',
  'conditions_json',
  'limit_coverage_pct',
  'start_label',
  'end_label',
  'start_geohash5',
  'end_geohash5',
  'polyline',
  'status',
  'sync_state',
  'checkpoint_ts',
  'incomplete',
  'server_id',
  'sync_error',
  'deleted_at',
  'created_at',
  'updated_at',
] as const;

/** Every column except the primary key and `created_at`, which a patch must not move. */
const PATCHABLE = COLUMNS.filter(
  (column) => column !== 'client_trip_id' && column !== 'created_at'
);

function toTripRow(row: Record<string, unknown>): TripRow {
  return {
    client_trip_id: asText(row, 'client_trip_id'),
    started_at: asNumber(row, 'started_at'),
    ended_at: asNumberOrNull(row, 'ended_at'),
    tz: asText(row, 'tz'),
    distance_m: asNumber(row, 'distance_m'),
    duration_s: asNumber(row, 'duration_s'),
    role: asTextOrNull(row, 'role'),
    role_confidence: asNumberOrNull(row, 'role_confidence'),
    role_source: asTextOrNull(row, 'role_source'),
    mode: asTextOrNull(row, 'mode'),
    camera_session: asFlag(row, 'camera_session'),
    score: asNumberOrNull(row, 'score'),
    scoring_version: asTextOrNull(row, 'scoring_version'),
    category_deductions_json: asTextOrNull(row, 'category_deductions_json'),
    exposure: asNumberOrNull(row, 'exposure'),
    data_quality: asTextOrNull(row, 'data_quality'),
    conditions_json: asTextOrNull(row, 'conditions_json'),
    limit_coverage_pct: asNumberOrNull(row, 'limit_coverage_pct'),
    start_label: asTextOrNull(row, 'start_label'),
    end_label: asTextOrNull(row, 'end_label'),
    start_geohash5: asTextOrNull(row, 'start_geohash5'),
    end_geohash5: asTextOrNull(row, 'end_geohash5'),
    polyline: asTextOrNull(row, 'polyline'),
    status: asEnum(row, 'status', TRIP_STATUSES),
    sync_state: asEnum(row, 'sync_state', TRIP_SYNC_STATES),
    checkpoint_ts: asNumberOrNull(row, 'checkpoint_ts'),
    incomplete: asFlag(row, 'incomplete'),
    server_id: asTextOrNull(row, 'server_id'),
    sync_error: asTextOrNull(row, 'sync_error'),
    deleted_at: asNumberOrNull(row, 'deleted_at'),
    created_at: asNumber(row, 'created_at'),
    updated_at: asNumber(row, 'updated_at'),
  };
}

export interface TripListOptions {
  limit?: number;
  offset?: number;
  status?: TripStatus;
}

/**
 * Throw unless `clientTripId` names a trip, using the handle it is given so the check sees the
 * same transaction as the write that follows it.
 *
 * The repositories that write child rows call this instead of relying on the foreign key: inside
 * a transaction on device, foreign keys may not be enforced (see `createExpoDb`). Outside a
 * transaction the foreign key is still there as a second line of defence.
 */
export async function assertTripExists(on: Db, clientTripId: string): Promise<void> {
  const { rows } = await on.execute('SELECT 1 FROM trips WHERE client_trip_id = ?', [
    clientTripId,
  ]);
  if (rows.length === 0) throw new MissingTripError(clientTripId);
}

export function createTripsRepo(db: Db) {
  async function get(clientTripId: string, on: Db = db): Promise<TripRow | null> {
    const { rows } = await on.execute('SELECT * FROM trips WHERE client_trip_id = ?', [
      clientTripId,
    ]);
    const row = rows[0];
    return row ? toTripRow(row) : null;
  }

  /**
   * Applies the named columns and always moves `updated_at`. Null when there is no such trip.
   * Runs on `on` when given, so it can share a caller's transaction.
   */
  async function update(
    clientTripId: string,
    patch: TripPatch,
    now: number = Date.now(),
    on: Db = db
  ): Promise<TripRow | null> {
    const statement = updateStatement(
      'trips',
      PATCHABLE,
      { ...patch, updated_at: now },
      'client_trip_id = ?',
      [clientTripId]
    );
    // `updated_at` is always set, so `updateStatement` never returns null here.
    if (!statement) return null;
    const { changes } = await on.execute(statement.sql, statement.params);
    return changes === 0 ? null : get(clientTripId, on);
  }

  return {
    get,
    update,

    /** Runs on `on` when given, so the recorder can insert the trip with its first samples. */
    async insert(trip: NewTrip, now: number = Date.now(), on: Db = db): Promise<TripRow> {
      const { sql, params } = insertStatement('trips', COLUMNS, {
        ...trip,
        created_at: now,
        updated_at: now,
      });
      await on.execute(sql, params);
      const inserted = await get(trip.client_trip_id, on);
      // The INSERT succeeded, so the row is there; the read-back exists to pick up the defaults.
      if (!inserted) throw new Error(`trip ${trip.client_trip_id} vanished after insert`);
      return inserted;
    },

    /** Newest first — the order the history list renders in. */
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

    /** The trip the engine is currently writing to, if any. */
    async findRecording(): Promise<TripRow | null> {
      const { rows } = await db.execute(
        "SELECT * FROM trips WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1"
      );
      const row = rows[0];
      return row ? toTripRow(row) : null;
    },

    setStatus: (clientTripId: string, status: TripStatus, now: number = Date.now()) =>
      update(clientTripId, { status }, now),

    setSyncState: (clientTripId: string, syncState: TripSyncState, now: number = Date.now()) =>
      update(clientTripId, { sync_state: syncState }, now),

    /**
     * Record how far the recorder has durably written, so a relaunch resumes from here. Runs on
     * `on` when given, so the mark commits together with the samples it vouches for.
     */
    checkpoint: (clientTripId: string, checkpointTs: number, now: number = Date.now(), on?: Db) =>
      update(clientTripId, { checkpoint_ts: checkpointTs }, now, on),

    /**
     * Takes the trip's events and samples with it. The child rows are deleted explicitly rather
     * than left to `ON DELETE CASCADE`: inside a transaction on device, foreign keys may not be
     * enforced (see `createExpoDb`), and a delete that left a drive's events behind is exactly
     * the residue this call exists to remove. Runs on `on` when given.
     */
    async remove(clientTripId: string, on: Db = db): Promise<boolean> {
      await on.execute('DELETE FROM samples WHERE client_trip_id = ?', [clientTripId]);
      await on.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [clientTripId]);
      const { changes } = await on.execute('DELETE FROM trips WHERE client_trip_id = ?', [
        clientTripId,
      ]);
      return changes > 0;
    },
  };
}

export type TripsRepo = ReturnType<typeof createTripsRepo>;
