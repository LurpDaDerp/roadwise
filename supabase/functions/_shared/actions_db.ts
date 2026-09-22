// The database port trip-actions talks to: finalize-trip's `Db` (the aggregate lookups) plus the
// lookups and writers the three actions need, and the one storage call (the trace object goes
// before the soft delete). Same rules as db.ts: no query builder leaves this file, every lookup
// filters on the user id the handler took from the JWT, every writer is called by name with the
// user as `p_user`.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Baselines, DayRow } from './aggregate.ts';
import { createDb, type Db } from './db.ts';
import { MAX_EVENTS } from './payload.ts';
import { asPgError } from './pg.ts';
import type { ScoredTrip, TripMetrics } from './scoring/index';

/** The private bucket the device uploads traces to (§4.5). */
export const TRACES_BUCKET = 'traces';

/** A stored trip with every column an action reads: identity, state, and the re-score inputs. */
export interface StoredTrip {
  id: string;
  clientTripId: string;
  status: string;
  score: number | null;
  role: TripMetrics['role'];
  /** `trips.scoring_version`: the version the trip was first scored under, which every re-score keeps. */
  scoringVersion: number;
  localDay: string;
  tz: string;
  /** epoch ms */
  startedAt: number;
  endedAt: number;
  distanceM: number;
  durationS: number;
  exposure: number;
  dataQuality: string;
  /** Points lost per category as stored, for a reply that recomputed nothing. */
  categoryDeductions: Record<string, number>;
  limitCoveragePct: number | null;
  /** `trips.rows_digest` verbatim; validated against the contract before it is scored with. */
  rowsDigest: unknown;
  tracePath: string | null;
  /**
   * `trips.scored_without_trace` (0008): whether the drive was scored without a trace, finalize-trip's
   * `no_trace` condition at scoring time. Never changed by retention clearing `trace_path`.
   */
  scoredWithoutTrace: boolean;
  incomplete: boolean;
  hadSevereEvent: boolean;
  cameraSession: boolean;
  deletedAt: string | null;
}

/** A stored event with what the scorer reads; severity and multiplier are recomputed, not read. */
export interface StoredEvent {
  /** `trip_events.id`, the id `apply_recompute` takes. */
  id: string;
  tripId: string;
  /** The device's id, the one the scorer's `eventDeductions` is keyed by. */
  clientEventId: string;
  category: string;
  startedAt: number;
  durationMs: number;
  /** `trip_events.confidence` */
  q: number;
  corrected: boolean;
  status: string;
  measured: Record<string, unknown>;
  context: Record<string, unknown>;
}

export type EventLookup = { kind: 'none' } | { kind: 'one'; event: StoredEvent } | { kind: 'many' };

export interface AllowanceResult {
  used_7d: number;
  limit_7d: number;
  remaining_7d: number;
  disputed_30d: number;
  scored_30d: number;
  max_30d: number;
  remaining_30d: number;
  remaining_allowance: number;
  can_auto_accept: boolean;
  denied_reason: 'allowance_7d' | 'allowance_30d' | null;
}

export interface RecordDisputeResult {
  dispute_id: string;
  trip_id: string;
  auto_accepted: boolean;
  consumed: boolean;
  denied_reason: 'allowance_7d' | 'allowance_30d' | null;
  remaining_7d: number;
  remaining_30d: number;
  remaining_allowance: number;
  event_status: string;
  replayed: boolean;
}

export interface SetRoleResult {
  trip_id: string;
  role: string;
  status: string;
  score: number | null;
}

export interface SoftDeleteResult {
  trip_id: string;
  trace_path: string | null;
  replayed: boolean;
}

/** One `p_events` row: the server id, the status to store, the deduction (null on an unscored trip). */
export interface RecomputeEventRow {
  id: string;
  status: string;
  deduction: number | null;
}

/** `p_scored`: the scorer's result plus the trip's severe flag as re-derived by the caller. */
export type RecomputeScored = ScoredTrip & { hadSevereEvent: boolean };

/** `apply_recompute(p_user, p_trip_id, p_scored, p_events, p_day, p_baselines)`; null scored + null events = day refresh. */
export interface RecomputeEnvelope {
  userId: string;
  tripId: string;
  scored: RecomputeScored | null;
  events: RecomputeEventRow[] | null;
  day: DayRow[];
  baselines: Baselines | null;
}

export interface RecomputeResult {
  trip_id: string;
  score: number | null;
  status: string;
}

/** The Storage API refused or failed the object removal; the delete must not proceed. */
export class StorageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageFailure';
  }
}

export interface ActionsDb extends Db {
  /** The stored trip for this user and client id, deleted or not; null when none. */
  findTripRow(userId: string, clientTripId: string): Promise<StoredTrip | null>;
  findTripById(userId: string, tripId: string): Promise<StoredTrip | null>;
  /** The user's event with that client id; `many` when the device reused an id across trips. */
  findEvent(userId: string, clientEventId: string): Promise<EventLookup>;
  /** Every event of the user's trip, oldest first, any status; at most `MAX_EVENTS`, all `apply_trip` stores. */
  listTripEvents(userId: string, tripId: string): Promise<StoredEvent[]>;
  /** Dispute rows of the user that were not auto-accepted, created at or after `sinceMs`. */
  countDeniedDisputes(userId: string, sinceMs: number): Promise<number>;
  countDisputeAllowance(userId: string): Promise<AllowanceResult>;
  recordDispute(
    userId: string,
    eventId: string,
    reason: string,
    note: string | null,
    statedLimitMph: number | null
  ): Promise<RecordDisputeResult>;
  setTripRole(userId: string, tripId: string, role: string): Promise<SetRoleResult>;
  softDeleteTrip(userId: string, tripId: string): Promise<SoftDeleteResult>;
  applyRecompute(envelope: RecomputeEnvelope): Promise<RecomputeResult>;
  /** Removes the object from the traces bucket; a key that is not there is a no-op. */
  removeTrace(key: string): Promise<void>;
}

const TRIP_COLUMNS =
  'id, client_trip_id, status, score, role, scoring_version, local_day, tz, started_at, ended_at, distance_m, duration_s, exposure, data_quality, category_deductions, limit_coverage_pct, rows_digest, trace_path, scored_without_trace, incomplete, had_severe_event, camera_session, deleted_at';
const EVENT_COLUMNS =
  'id, trip_id, client_event_id, category, started_at, duration_ms, confidence, corrected, status, measured, context';

interface TripRecord {
  id: string;
  client_trip_id: string;
  status: string;
  score: number | null;
  role: TripMetrics['role'];
  scoring_version: number | string;
  local_day: string;
  tz: string;
  started_at: string;
  ended_at: string;
  distance_m: number | string;
  duration_s: number | string;
  exposure: number | string;
  data_quality: string;
  category_deductions: Record<string, number> | null;
  limit_coverage_pct: number | string | null;
  rows_digest: unknown;
  trace_path: string | null;
  scored_without_trace: boolean;
  incomplete: boolean;
  had_severe_event: boolean;
  camera_session: boolean;
  deleted_at: string | null;
}

interface EventRecord {
  id: string;
  trip_id: string;
  client_event_id: string;
  category: string;
  started_at: string;
  duration_ms: number | string;
  confidence: number | string;
  corrected: boolean;
  status: string;
  measured: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}

const toStoredTrip = (row: TripRecord): StoredTrip => ({
  id: row.id,
  clientTripId: row.client_trip_id,
  status: row.status,
  score: row.score,
  role: row.role,
  scoringVersion: Number(row.scoring_version),
  localDay: row.local_day,
  tz: row.tz,
  startedAt: Date.parse(row.started_at),
  endedAt: Date.parse(row.ended_at),
  distanceM: Number(row.distance_m),
  durationS: Number(row.duration_s),
  exposure: Number(row.exposure),
  dataQuality: row.data_quality,
  categoryDeductions: row.category_deductions ?? {},
  limitCoveragePct: row.limit_coverage_pct === null ? null : Number(row.limit_coverage_pct),
  rowsDigest: row.rows_digest,
  tracePath: row.trace_path,
  scoredWithoutTrace: row.scored_without_trace === true,
  incomplete: row.incomplete,
  hadSevereEvent: row.had_severe_event,
  cameraSession: row.camera_session,
  deletedAt: row.deleted_at,
});

const toStoredEvent = (row: EventRecord): StoredEvent => ({
  id: row.id,
  tripId: row.trip_id,
  clientEventId: row.client_event_id,
  category: row.category,
  startedAt: Date.parse(row.started_at),
  durationMs: Number(row.duration_ms),
  q: Number(row.confidence),
  corrected: row.corrected,
  status: row.status,
  measured: row.measured ?? {},
  context: row.context ?? {},
});

export function createActionsDb(client: SupabaseClient): ActionsDb {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw asPgError(error);
    return data as T;
  };

  return {
    ...createDb(client),

    async findTripRow(userId, clientTripId) {
      const { data, error } = await client
        .from('trips')
        .select(TRIP_COLUMNS)
        .eq('user_id', userId)
        .eq('client_trip_id', clientTripId)
        .maybeSingle();
      if (error) throw asPgError(error);
      return data ? toStoredTrip(data as unknown as TripRecord) : null;
    },

    async findTripById(userId, tripId) {
      const { data, error } = await client
        .from('trips')
        .select(TRIP_COLUMNS)
        .eq('id', tripId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw asPgError(error);
      return data ? toStoredTrip(data as unknown as TripRecord) : null;
    },

    // A trip the user deleted keeps its events, and the device reuses a client event id across
    // installs, so a deleted trip's event must not make a live one ambiguous (a 409 the user can
    // do nothing about). The live trips are asked first; only when nothing live matches is the
    // whole set read, so a queued dispute for a trip deleted meanwhile still finds its event and
    // replays rather than reading as a 404.
    async findEvent(userId, clientEventId) {
      const live = await client
        .from('trip_events')
        .select(`${EVENT_COLUMNS}, trips!inner(deleted_at)`)
        .eq('user_id', userId)
        .eq('client_event_id', clientEventId)
        .is('trips.deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(2);
      if (live.error) throw asPgError(live.error);
      let rows = (live.data ?? []) as unknown as EventRecord[];
      if (rows.length === 0) {
        const any = await client
          .from('trip_events')
          .select(EVENT_COLUMNS)
          .eq('user_id', userId)
          .eq('client_event_id', clientEventId)
          .order('created_at', { ascending: false })
          .limit(2);
        if (any.error) throw asPgError(any.error);
        rows = (any.data ?? []) as unknown as EventRecord[];
      }
      if (rows.length === 0) return { kind: 'none' };
      if (rows.length > 1) return { kind: 'many' };
      return { kind: 'one', event: toStoredEvent(rows[0]) };
    },

    async listTripEvents(userId, tripId) {
      const { data, error } = await client
        .from('trip_events')
        .select(EVENT_COLUMNS)
        .eq('user_id', userId)
        .eq('trip_id', tripId)
        .order('started_at')
        .limit(MAX_EVENTS);
      if (error) throw asPgError(error);
      return ((data ?? []) as unknown as EventRecord[]).map(toStoredEvent);
    },

    async countDeniedDisputes(userId, sinceMs) {
      const { count, error } = await client
        .from('event_disputes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('auto_accepted', false)
        .gte('created_at', new Date(sinceMs).toISOString());
      if (error) throw asPgError(error);
      return count ?? 0;
    },

    countDisputeAllowance: (userId) => rpc<AllowanceResult>('count_dispute_allowance', { p_user: userId }),

    recordDispute: (userId, eventId, reason, note, statedLimitMph) =>
      rpc<RecordDisputeResult>('record_dispute', {
        p_user: userId,
        p_event_id: eventId,
        p_reason: reason,
        p_note: note,
        p_stated_limit_mph: statedLimitMph,
      }),

    setTripRole: (userId, tripId, role) =>
      rpc<SetRoleResult>('set_trip_role_row', { p_user: userId, p_trip_id: tripId, p_role: role }),

    softDeleteTrip: (userId, tripId) =>
      rpc<SoftDeleteResult>('soft_delete_trip', { p_user: userId, p_trip_id: tripId }),

    applyRecompute: (e) =>
      rpc<RecomputeResult>('apply_recompute', {
        p_user: e.userId,
        p_trip_id: e.tripId,
        p_scored: e.scored,
        p_events: e.events,
        p_day: e.day,
        p_baselines: e.baselines,
      }),

    async removeTrace(key) {
      const { error } = await client.storage.from(TRACES_BUCKET).remove([key]);
      if (error) throw new StorageFailure(error.message);
    },
  };
}
