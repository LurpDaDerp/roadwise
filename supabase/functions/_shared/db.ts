// The database port the edge functions talk to, and its supabase-js implementation.
//
// The functions never see a query builder: they read through a handful of named lookups and write
// through the migration's writers (`apply_trip` here; `apply_recompute` and the dispute/role/delete
// writers in trip-actions). The port keeps the handlers testable against an in-memory client and
// keeps every column name in one place. All of it runs under the service role, so every lookup
// filters on the user id the caller derived from the JWT, and every list is bounded. Failures
// surface as `PgError` from `_shared/pg.ts`, with the SQLSTATE the handler maps.
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Baselines,
  DayRow,
  DayTripInput,
  ScoredTripInput,
  TripFields,
} from './aggregate.ts';
import type { FinalizeTripPayload } from './payload.ts';
import { asPgError } from './pg.ts';
import type { ScoredTrip } from './scoring/index';

export interface ExistingTrip {
  id: string;
  score: number | null;
  status: string;
  localDay: string;
  tracePath: string | null;
  deletedAt: string | null;
  /** What a re-score rewrites; echoed on a replay so the device's row follows the stored one. */
  fields: TripFields;
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
  /** Trip rows of the user created at or after `sinceMs`, deleted ones included (deleting must not reset the cap). */
  countTripsSince(userId: string, sinceMs: number): Promise<number>;
  /** The stored `score_daily` row for that local day, or null. */
  getDayRow(userId: string, day: string): Promise<DayRow | null>;
  /** Live scored trips (final or provisional) that ended at or after `sinceMs`, newest first. */
  listScoredTrips(userId: string, sinceMs: number): Promise<ScoredTripRow[]>;
  /**
   * Trips of those local days, any status, with their scored phone-event counts. Soft-deleted ones
   * are included and marked `deleted` (D2: a deleted drive keeps counting against its day).
   */
  listDayTrips(userId: string, days: readonly string[]): Promise<DayTripRow[]>;
  applyTrip(envelope: ApplyTripEnvelope): Promise<ApplyTripResult>;
}

/** Newest-first with a cutoff at `LONG_TERM_MAX_D`, so PostgREST's row cap can never drop a recent trip. */
export const SCORED_TRIPS_LIMIT = 1000;
/** Trips per requested set of days; far above the 24 h upload cap times the 7-day age window per day. */
export const DAY_TRIPS_LIMIT = 500;
/** Trip ids per `in (…)` list on the event query, well inside the gateway's URL budget. */
export const EVENT_ID_CHUNK = 50;

interface TripRecord {
  id: string;
  score: number | null;
  status: string;
  local_day: string;
  ended_at: string;
  exposure: number;
  duration_s: number;
  category_deductions: Record<string, number> | null;
  data_quality: string | null;
  limit_coverage_pct: number | string | null;
  had_severe_event: boolean;
  camera_session: boolean;
  trace_path: string | null;
  deleted_at: string | null;
}

interface DayRecord {
  day: string;
  long_term_score: number | null;
  band: DayRow['band'];
  provisional: boolean;
  safe_day: boolean;
  good_day: boolean;
  phone_free_day: boolean;
  camera_day: boolean;
  exposure: number;
  driving_s: number;
  trips_scored: number;
  /** 0009; absent on a row read before the column exists, which reads as `trips_scored` (M2). */
  trips_all?: number | null;
  severe_events: number;
}

/**
 * The trip fields a re-score rewrites, read back off a stored row.
 *
 * Used on the replay arms, where nothing was recomputed and the honest answer is what is stored.
 * PostgREST hands numerics back as strings, so both are normalised here rather than at the reader.
 */
export function storedTripFields(row: {
  category_deductions: Record<string, number> | null;
  exposure: number | string | null;
  data_quality: string | null;
  had_severe_event: boolean;
  limit_coverage_pct: number | string | null;
}): TripFields {
  return {
    categoryDeductions: row.category_deductions ?? {},
    exposure: Number(row.exposure ?? 0),
    dataQuality: row.data_quality ?? 'C',
    hadSevereEvent: row.had_severe_event,
    limitCoveragePct: row.limit_coverage_pct === null ? null : Number(row.limit_coverage_pct),
  };
}

export function createDb(client: SupabaseClient): Db {
  return {
    async findTrip(userId, clientTripId) {
      const { data, error } = await client
        .from('trips')
        .select(
          'id, score, status, local_day, trace_path, deleted_at, category_deductions, exposure,' +
            ' data_quality, had_severe_event, limit_coverage_pct'
        )
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
        fields: storedTripFields(row),
      };
    },

    async countTripsSince(userId, sinceMs) {
      const { count, error } = await client
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', new Date(sinceMs).toISOString());
      if (error) throw asPgError(error);
      return count ?? 0;
    },

    async getDayRow(userId, day) {
      const { data, error } = await client
        .from('score_daily')
        .select(
          'day, long_term_score, band, provisional, safe_day, good_day, phone_free_day, camera_day, exposure, driving_s, trips_scored, trips_all, severe_events'
        )
        .eq('user_id', userId)
        .eq('day', day)
        .maybeSingle();
      if (error) throw asPgError(error);
      if (!data) return null;
      const row = data as unknown as DayRecord;
      return {
        day: row.day,
        longTermScore: row.long_term_score,
        band: row.band,
        provisional: row.provisional,
        safeDay: row.safe_day,
        goodDay: row.good_day,
        phoneFreeDay: row.phone_free_day,
        cameraDay: row.camera_day,
        exposure: Number(row.exposure),
        drivingS: row.driving_s,
        tripsScored: row.trips_scored,
        tripsAll: row.trips_all ?? row.trips_scored,
        severeEvents: row.severe_events,
      };
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
        .select('id, local_day, score, status, duration_s, exposure, had_severe_event, camera_session, deleted_at')
        .eq('user_id', userId)
        .in('local_day', days)
        .order('started_at')
        .limit(DAY_TRIPS_LIMIT);
      if (error) throw asPgError(error);
      const trips = (data ?? []) as unknown as TripRecord[];
      const phone = new Map<string, number>();
      const ids = trips.map((t) => t.id);
      for (let at = 0; at < ids.length; at += EVENT_ID_CHUNK) {
        const events = await client
          .from('trip_events')
          .select('trip_id')
          .in('trip_id', ids.slice(at, at + EVENT_ID_CHUNK))
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
        deleted: row.deleted_at !== null,
      }));
    },

    async applyTrip(envelope) {
      const { data, error } = await client.rpc('apply_trip', { p: envelope });
      if (error) throw asPgError(error);
      return data as ApplyTripResult;
    },
  };
}
