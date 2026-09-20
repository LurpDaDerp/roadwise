// The database port the edge functions talk to, and its supabase-js implementation.
//
// The functions never see a query builder: they read through a handful of named lookups and write
// through the migration's writers (`apply_trip` here; `apply_recompute` and the dispute/role/delete
// writers in trip-actions). The port keeps the handlers testable against an in-memory client and
// keeps every column name in one place. All of it runs under the service role, so every lookup
// filters on the user id the caller derived from the JWT.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Baselines, DayRow, DayTripInput, ScoredTripInput } from './aggregate.ts';
import type { FinalizeTripPayload } from './payload.ts';
import type { ScoredTrip } from './scoring/index';

/** A PostgREST error with its SQLSTATE, so the handler can map the writers' fixed codes. */
export class PgError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null
  ) {
    super(message);
    this.name = 'PgError';
  }
}

export interface ExistingTrip {
  id: string;
  score: number | null;
  status: string;
  localDay: string;
  tracePath: string | null;
  deletedAt: string | null;
}

export interface ScoredTripRow extends ScoredTripInput {
  id: string;
  localDay: string;
}

export interface DayTripRow extends DayTripInput {
  id: string;
}

/** `apply_trip(p)` as migration 0002 defines it; `day` is always sent as an array here. */
export interface ApplyTripEnvelope {
  userId: string;
  payload: FinalizeTripPayload;
  scored: ScoredTrip;
  day: DayRow[];
  baselines: Baselines | null;
  conditions: { night: boolean; precipitation: boolean };
  limitCoveragePct: number | null;
}

export interface ApplyTripResult {
  trip_id: string;
  score: number | null;
  status: string;
  day: string;
  replayed: boolean;
}

export interface Db {
  /** The stored trip for this user and client id, deleted or not; null when none. */
  findTrip(userId: string, clientTripId: string): Promise<ExistingTrip | null>;
  /** Every trip row of the user on that local day, deleted ones included (deleting must not reset the cap). */
  countTripsOnDay(userId: string, day: string): Promise<number>;
  /** Live scored trips (final or provisional) that ended at or after `sinceMs`, newest first. */
  listScoredTrips(userId: string, sinceMs: number): Promise<ScoredTripRow[]>;
  /** Live trips of those local days, any status, with their scored phone-event counts. */
  listDayTrips(userId: string, days: readonly string[]): Promise<DayTripRow[]>;
  applyTrip(envelope: ApplyTripEnvelope): Promise<ApplyTripResult>;
}

/** Newest-first with a cutoff at `LONG_TERM_MAX_D`, so PostgREST's row cap can never drop a recent trip. */
export const SCORED_TRIPS_LIMIT = 1000;

interface TripRecord {
  id: string;
  score: number | null;
  status: string;
  local_day: string;
  ended_at: string;
  exposure: number | string;
  duration_s: number | string;
  category_deductions: Record<string, number> | null;
  had_severe_event: boolean;
  camera_session: boolean;
  trace_path: string | null;
  deleted_at: string | null;
}

interface PostgrestError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

const asPgError = (e: PostgrestError): PgError =>
  new PgError(e.code ?? 'unknown', e.message, e.details ?? null, e.hint ?? null);

export function createDb(client: SupabaseClient): Db {
  return {
    async findTrip(userId, clientTripId) {
      const { data, error } = await client
        .from('trips')
        .select('id, score, status, local_day, trace_path, deleted_at')
        .eq('user_id', userId)
        .eq('client_trip_id', clientTripId)
        .maybeSingle();
      if (error) throw asPgError(error);
      if (!data) return null;
      const row = data as unknown as TripRecord;
      return {
        id: row.id,
        score: row.score,
        status: row.status,
        localDay: row.local_day,
        tracePath: row.trace_path,
        deletedAt: row.deleted_at,
      };
    },

    async countTripsOnDay(userId, day) {
      const { count, error } = await client
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('local_day', day);
      if (error) throw asPgError(error);
      return count ?? 0;
    },

    async listScoredTrips(userId, sinceMs) {
      const { data, error } = await client
        .from('trips')
        .select('id, ended_at, local_day, score, exposure, duration_s, category_deductions')
        .eq('user_id', userId)
        .in('status', ['final', 'provisional'])
        .is('deleted_at', null)
        .gte('ended_at', new Date(sinceMs).toISOString())
        .order('ended_at', { ascending: false })
        .limit(SCORED_TRIPS_LIMIT);
      if (error) throw asPgError(error);
      return ((data ?? []) as unknown as TripRecord[]).map((row) => ({
        id: row.id,
        endedAt: Date.parse(row.ended_at),
        localDay: row.local_day,
        score: Number(row.score),
        exposure: Number(row.exposure),
        durationS: Number(row.duration_s),
        categoryDeductions: row.category_deductions ?? {},
      }));
    },

    async listDayTrips(userId, days) {
      const { data, error } = await client
        .from('trips')
        .select('id, local_day, score, status, duration_s, exposure, had_severe_event, camera_session')
        .eq('user_id', userId)
        .in('local_day', days)
        .is('deleted_at', null)
        .order('started_at');
      if (error) throw asPgError(error);
      const trips = (data ?? []) as unknown as TripRecord[];
      const phone = new Map<string, number>();
      if (trips.length > 0) {
        const events = await client
          .from('trip_events')
          .select('trip_id')
          .in(
            'trip_id',
            trips.map((t) => t.id)
          )
          .eq('category', 'phone')
          .eq('status', 'scored');
        if (events.error) throw asPgError(events.error);
        for (const e of (events.data ?? []) as unknown as { trip_id: string }[]) {
          phone.set(e.trip_id, (phone.get(e.trip_id) ?? 0) + 1);
        }
      }
      return trips.map((row) => ({
        id: row.id,
        localDay: row.local_day,
        score: row.score,
        status: row.status as DayTripInput['status'],
        durationS: Number(row.duration_s),
        exposure: Number(row.exposure),
        hadSevereEvent: row.had_severe_event,
        phoneEvents: phone.get(row.id) ?? 0,
        cameraGood: row.camera_session,
      }));
    },

    async applyTrip(envelope) {
      const { data, error } = await client.rpc('apply_trip', { p: envelope });
      if (error) throw asPgError(error);
      return data as ApplyTripResult;
    },
  };
}
