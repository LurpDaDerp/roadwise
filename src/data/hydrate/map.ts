/**
 * Server rows → local rows, for the restore path (R10).
 *
 * The server's tables are the device's tables in another shape (design §4.2): the columns are the
 * same facts, but timestamps are `timestamptz` strings rather than epoch ms, JSON is `jsonb`
 * rather than TEXT, booleans are booleans, and a few facts are split differently —
 * `had_severe_event` is a column there and a key inside `conditions_json` here, an event's
 * duration is `duration_ms` there and `duration_s` here, and a report lives in its own
 * `event_disputes` row there and in `trip_events.dispute_json` here (M2 carry-over 7).
 *
 * The target is exact: **a restored trip must render identically to the same trip finalized on
 * this device and synced** — every field a screen reads comes out the way `finalizeTrip` and the
 * runner's `applyFinalize` would have written it. `map.test.ts` pins that against a real
 * finalize.
 *
 * Every row is parsed before it is mapped. The server is ours, but a row this build cannot read in
 * full is skipped rather than half-written, and two fields are checked for safety rather than
 * shape: `client_trip_id` becomes part of a local file path (`<id>.bin.gz`), so it must match the
 * server's own charset rule, and every id is bounded before it reaches SQL.
 */
import { z } from 'zod';

import {
  DISPUTE_REASONS,
  type DisputeRecord,
  type EventRow,
  type TripRow,
  type TripStatus,
} from '@/data/db/types';
import { CLIENT_TRIP_ID } from '@/data/sync/queue';
import { DayRowSchema, type DayRow } from '@/data/sync/response';

/** The trip columns the restore reads — what the device stores, and nothing it does not. */
export const TRIP_COLUMNS = [
  'id',
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
  'category_deductions',
  'exposure',
  'data_quality',
  'conditions',
  'had_severe_event',
  'limit_coverage_pct',
  'start_label',
  'end_label',
  'start_geohash5',
  'end_geohash5',
  'polyline',
  'status',
  'incomplete',
  'updated_at',
].join(',');

export const EVENT_COLUMNS = [
  'id',
  'trip_id',
  'client_event_id',
  'category',
  'started_at',
  'duration_ms',
  'lat',
  'lng',
  'measured',
  'context',
  'severity',
  'confidence',
  'deduction',
  'alert_shown',
  'corrected',
  'source',
  'status',
].join(',');

export const DISPUTE_COLUMNS = [
  'event_id',
  'reason',
  'note',
  'stated_limit_mph',
  'auto_accepted',
  'denied_reason',
  'decided_at',
  'created_at',
].join(',');

export const DAY_COLUMNS = [
  'day',
  'long_term_score',
  'band',
  'provisional',
  'safe_day',
  'good_day',
  'phone_free_day',
  'camera_day',
  'exposure',
  'driving_s',
  'trips_scored',
  'trips_all',
  'severe_events',
  'updated_at',
].join(',');

export const BASELINE_COLUMNS = ['medians', 'computed_at'].join(',');

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A PostgREST `timestamptz` (`2026-09-21T10:00:00.123456+00:00`) as epoch ms, or null.
 *
 * Parsed by hand rather than with `Date.parse`: Hermes' parser is not guaranteed to accept six
 * fractional digits, and a timestamp it misread would move a drive to another day.
 */
export function parseTimestamp(text: string): number | null {
  const m = ISO.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
  const ms = Number((frac + '000').slice(0, 3));
  let offsetMin = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  const out = utc - offsetMin * 60_000;
  return Number.isFinite(out) ? out : null;
}

/** A server timestamp exactly as the server wrote it — the cursor keeps these verbatim. */
export const TimestampText = z.string().max(40).regex(ISO);

/** PostgREST renders `numeric` as a JSON number; a numeric string is accepted too. */
const num = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i).transform(Number),
]).pipe(z.number().refine(Number.isFinite));

const jsonObject = z.record(z.string(), z.unknown());

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const isUuid = (value: string): boolean => Uuid.safeParse(value).success;

// ---------------------------------------------------------------------------------------------
// Rows, as the server sends them
// ---------------------------------------------------------------------------------------------

const SERVER_TRIP_STATUSES = ['provisional', 'final', 'unscored', 'discarded'] as const satisfies readonly TripStatus[];

export const ServerTripSchema = z.object({
  id: Uuid,
  client_trip_id: z.string().regex(CLIENT_TRIP_ID),
  started_at: TimestampText,
  ended_at: TimestampText,
  tz: z.string().min(1).max(64),
  distance_m: num,
  duration_s: num,
  role: z.string().min(1).max(16),
  role_confidence: num.nullable(),
  role_source: z.string().max(32).nullable(),
  mode: z.string().min(1).max(16),
  camera_session: z.boolean(),
  score: num.nullable(),
  scoring_version: num,
  category_deductions: jsonObject,
  exposure: num,
  data_quality: z.enum(['A', 'B', 'C']),
  conditions: jsonObject,
  had_severe_event: z.boolean(),
  limit_coverage_pct: num.nullable(),
  start_label: z.string().max(80).nullable(),
  end_label: z.string().max(80).nullable(),
  start_geohash5: z.string().max(5).nullable(),
  end_geohash5: z.string().max(5).nullable(),
  polyline: z.string().max(16_384),
  status: z.enum(SERVER_TRIP_STATUSES),
  incomplete: z.boolean(),
  updated_at: TimestampText,
});
export type ServerTrip = z.infer<typeof ServerTripSchema>;

export const ServerEventSchema = z.object({
  id: Uuid,
  trip_id: Uuid,
  client_event_id: z.string().min(1).max(64),
  category: z.string().min(1).max(16),
  started_at: TimestampText,
  duration_ms: num,
  lat: num.nullable(),
  lng: num.nullable(),
  measured: jsonObject,
  context: jsonObject,
  severity: num,
  confidence: num,
  deduction: num.nullable(),
  alert_shown: z.boolean(),
  corrected: z.boolean(),
  source: z.string().min(1).max(16),
  status: z.string().min(1).max(16),
});
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const ServerDisputeSchema = z.object({
  event_id: Uuid,
  reason: z.enum(DISPUTE_REASONS),
  note: z.string().max(500).nullable(),
  stated_limit_mph: num.nullable(),
  auto_accepted: z.boolean(),
  denied_reason: z.string().max(64).nullable(),
  decided_at: TimestampText,
  created_at: TimestampText,
});
export type ServerDispute = z.infer<typeof ServerDisputeSchema>;

export const ServerDaySchema = z.object({
  day: z.string(),
  long_term_score: num.nullable(),
  band: z.string().nullable(),
  provisional: z.boolean(),
  safe_day: z.boolean(),
  good_day: z.boolean(),
  phone_free_day: z.boolean(),
  camera_day: z.boolean(),
  exposure: num,
  driving_s: num,
  trips_scored: num,
  /** 0009 (D2); null or absent on a row from before it, which the reader treats as M2 did. */
  trips_all: num.nullable().optional(),
  severe_events: num,
  updated_at: TimestampText,
});
export type ServerDay = z.infer<typeof ServerDaySchema>;

export const ServerBaselineSchema = z.object({
  medians: jsonObject,
  computed_at: TimestampText,
});
export type ServerBaseline = z.infer<typeof ServerBaselineSchema>;

/** Parse one row, or null when this build cannot read it in full. */
export function parseRow<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** The trip columns the server owns, as `finalizeTrip` + `applyFinalize` would have left them. */
export type ServerOwnedTripFields = Omit<
  TripRow,
  'client_trip_id' | 'checkpoint_ts' | 'sync_error' | 'deleted_at' | 'created_at' | 'updated_at'
>;

export function toTripFields(trip: ServerTrip): ServerOwnedTripFields | null {
  const startedAt = parseTimestamp(trip.started_at);
  const endedAt = parseTimestamp(trip.ended_at);
  if (startedAt === null || endedAt === null) return null;
  return {
    started_at: startedAt,
    ended_at: endedAt,
    tz: trip.tz,
    distance_m: trip.distance_m,
    duration_s: trip.duration_s,
    role: trip.role,
    role_confidence: trip.role_confidence,
    role_source: trip.role_source,
    mode: trip.mode,
    camera_session: trip.camera_session ? 1 : 0,
    score: trip.score,
    scoring_version: String(trip.scoring_version),
    category_deductions_json: JSON.stringify(trip.category_deductions),
    exposure: trip.exposure,
    data_quality: trip.data_quality,
    // The device keeps the severe flag inside `conditions_json` (`withSevereFlag`); the server keeps
    // it in its own column. Same order the runner writes: the observations, then the flag.
    conditions_json: JSON.stringify({ ...trip.conditions, hadSevereEvent: trip.had_severe_event }),
    limit_coverage_pct: trip.limit_coverage_pct,
    start_label: trip.start_label,
    end_label: trip.end_label,
    start_geohash5: trip.start_geohash5,
    end_geohash5: trip.end_geohash5,
    // The finalizer stores an empty polyline as NULL; the server column is NOT NULL DEFAULT ''.
    polyline: trip.polyline === '' ? null : trip.polyline,
    status: trip.status,
    sync_state: 'synced',
    incomplete: trip.incomplete ? 1 : 0,
    server_id: trip.id,
  };
}

/** A report, in the shape `parseDispute` reads and the D3 sheet renders. */
export function toDisputeRecord(dispute: ServerDispute): DisputeRecord | null {
  const submittedAt = parseTimestamp(dispute.created_at);
  const decidedAt = parseTimestamp(dispute.decided_at);
  if (submittedAt === null || decidedAt === null) return null;
  return {
    reason: dispute.reason,
    note: dispute.note !== null && dispute.note.length > 0 ? dispute.note : null,
    statedLimitMph: dispute.stated_limit_mph,
    submittedAt,
    outcome: dispute.auto_accepted ? 'accepted' : 'denied',
    deniedReason: dispute.denied_reason,
    // The server stores the decision, not the allowance left at the time; the record says
    // "unknown" rather than inventing a count (§9.9: the client never computes an allowance).
    remainingAllowance: null,
    code: null,
    decidedAt,
  };
}

/**
 * An event, as `finalizeTrip`'s `toNewEvent` writes it. `dispute_json` is the server's record when
 * there is one; otherwise whatever the device already holds is kept by the caller (a refusal the
 * server never recorded — a closed window — exists only here).
 */
export function toEventRow(
  event: ServerEvent,
  clientTripId: string,
  dispute: DisputeRecord | null
): EventRow | null {
  const startedAt = parseTimestamp(event.started_at);
  if (startedAt === null) return null;
  return {
    id: event.client_event_id,
    client_trip_id: clientTripId,
    category: event.category,
    started_at: startedAt,
    duration_s: event.duration_ms / 1000,
    lat: event.lat,
    lng: event.lng,
    measured_json: JSON.stringify(event.measured),
    severity: String(event.severity),
    confidence: event.confidence,
    context_json: JSON.stringify(event.context),
    deduction: event.deduction,
    alert_shown: event.alert_shown ? 1 : 0,
    corrected: event.corrected ? 1 : 0,
    status: event.status,
    source: event.source,
    dispute_json: dispute === null ? null : JSON.stringify(dispute),
  };
}

/** A day row in the wire shape the runner caches (`DayRow`), or null when it is not one. */
export function toDayRow(day: ServerDay): DayRow | null {
  const parsed = DayRowSchema.safeParse({
    day: day.day,
    longTermScore: day.long_term_score,
    band: day.band,
    provisional: day.provisional,
    safeDay: day.safe_day,
    goodDay: day.good_day,
    phoneFreeDay: day.phone_free_day,
    cameraDay: day.camera_day,
    exposure: day.exposure,
    drivingS: day.driving_s,
    tripsScored: day.trips_scored,
    ...(day.trips_all === null || day.trips_all === undefined ? {} : { tripsAll: day.trips_all }),
    severeEvents: day.severe_events,
  });
  return parsed.success ? parsed.data : null;
}

/** What `insights.baseline` holds: the envelope `parseStoredBaseline` reads. */
export interface StoredBaseline {
  medians: Record<string, number>;
  computedAt: number;
}

export function toStoredBaseline(baseline: ServerBaseline): StoredBaseline | null {
  const computedAt = parseTimestamp(baseline.computed_at);
  if (computedAt === null) return null;
  const medians: Record<string, number> = {};
  for (const [key, value] of Object.entries(baseline.medians)) {
    if (typeof value === 'number' && Number.isFinite(value)) medians[key] = value;
  }
  return { medians, computedAt };
}
