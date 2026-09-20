// Plausibility rules for an upload that already passed the contract (design §4.4).
//
// The schema says the payload is well-formed; these rules say whether the trip it describes could
// have happened, and they fail *before* anything is written. Every rejection carries a stable code
// and the field it concerns, so the client can treat it as terminal (a re-send of the same payload
// would fail the same way) and the operator can see which rule fired. Where the tables hold a
// CHECK the contract does not (ceilings, byte lengths), the rule is mirrored here so the refusal
// names a field instead of surfacing as a constraint error.
//
// Two rules do not reject. A trip that arrives without a trace, was recovered by crash restart, or
// whose distance and driving time do not agree with the speeds measured is accepted but scored at
// data-quality B at best: the harsh-manoeuvre categories need grade A confidence that the trip's
// own numbers cannot vouch for. The cap is applied through `TripMetrics.imuPresent` (grade A
// needs the IMU, see `dataQualityGrade`), leaving the stored `rowsDigest` exactly as sent; the
// capped grade itself is persisted as `trips.data_quality`.
import { CONSTANTS, dataQualityGrade } from './scoring/index';
import type { TripMetrics } from './scoring/index';
import { MAX_EVENTS, MAX_POLYLINE_BYTES, type FinalizeTripPayload } from './payload.ts';

/** Mirrors the `trips.client_trip_id` CHECK, so a bad id is a 400 here rather than a 23514 there. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Mirrors the `trip_events.client_event_id` CHECK (length only; the table has no character class). */
export const EVENT_ID_MAX = 64;
/** Table ceilings (migration 0002): `duration_s`, `distance_m`, `trip_events.duration_ms`. */
export const MAX_DURATION_S = 172_800;
export const MAX_DISTANCE_M = 2_000_000;
export const MAX_EVENT_DURATION_MS = 172_800_000;
/** A trip may not have started more than this long ago (the queue retries well inside it). */
export const MAX_TRIP_AGE_MS = 7 * 86_400_000;
/** Device clocks drift; a trip may run this far ahead of the server's clock. */
export const MAX_CLOCK_SKEW_MS = 3_600_000;
/** Wall span ceiling, the `duration_s` ceiling in milliseconds. */
export const MAX_SPAN_MS = MAX_DURATION_S * 1000;
/** Average speed over the whole trip beyond which distance and duration cannot both be right. */
export const MAX_AVG_SPEED_MPS = 45;
/** Rows per second of driving a grade-A or grade-B trip must have delivered. */
export const MIN_ROW_DENSITY = 0.7;
/** The average speed may exceed the 10 s sustained maximum by this factor, or this slack, not both. */
export const SPEED_DIVERGENCE_FACTOR = 1.25;
export const SPEED_DIVERGENCE_SLACK_MPS = 2;
/** `durationS` may exceed the wall span by this much (the finalizer adds one row's second). */
export const SPAN_SLACK_S = 1;

export type PlausibilityCode =
  | 'invalid_client_trip_id'
  | 'invalid_event_id'
  | 'duplicate_event_id'
  | 'too_many_events'
  | 'invalid_event_deductions'
  | 'invalid_timezone'
  | 'implausible_time'
  | 'duration_out_of_range'
  | 'distance_out_of_range'
  | 'event_duration_out_of_range'
  | 'polyline_too_long'
  | 'implausible_speed'
  | 'implausible_distance'
  | 'event_outside_trip'
  | 'sparse_rows';

export type QualityDowngrade =
  | 'no_trace'
  | 'incomplete'
  | 'duration_exceeds_span'
  | 'distance_exceeds_speed';

export interface PlausibilityFailure {
  code: PlausibilityCode;
  /** Dotted path into the payload, `events.3.startedAt` style. */
  field: string;
}

export type PlausibilityResult =
  | { ok: true; downgrades: QualityDowngrade[] }
  | { ok: false; failure: PlausibilityFailure };

const fail = (code: PlausibilityCode, field: string): PlausibilityResult => ({
  ok: false,
  failure: { code, field },
});

/**
 * Whether Intl (ICU) knows the zone. Postgres derives `local_day` from its own tz table; a zone one
 * side knows and the other does not (an alias, a zone newer than one side's tzdata) is refused
 * here or fails closed as 22023 there, and the 22023 log carries the zone so drift is visible.
 */
function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `nowMs` is the server clock: the temporal rules are the only ones that read it. */
export function checkPlausibility(p: FinalizeTripPayload, nowMs: number): PlausibilityResult {
  if (!CLIENT_ID_PATTERN.test(p.clientTripId)) return fail('invalid_client_trip_id', 'clientTripId');
  if (p.events.length > MAX_EVENTS) return fail('too_many_events', 'events');

  const seen = new Set<string>();
  for (const [i, e] of p.events.entries()) {
    if (e.id.length < 1 || e.id.length > EVENT_ID_MAX) return fail('invalid_event_id', `events.${i}.id`);
    if (seen.has(e.id)) return fail('duplicate_event_id', `events.${i}.id`);
    seen.add(e.id);
  }

  // The device's own deduction map is only compared, never stored, but it is parsed twice (here
  // and in Postgres), so it is bounded like the event list it describes.
  const deductionIds = Object.keys(p.provisional.eventDeductions);
  if (deductionIds.length > MAX_EVENTS || deductionIds.some((k) => k.length > EVENT_ID_MAX)) {
    return fail('invalid_event_deductions', 'provisional.eventDeductions');
  }

  if (!knownZone(p.tz)) return fail('invalid_timezone', 'tz');

  // When: numeric comparisons only, so an epoch past the Date range is refused rather than thrown.
  if (p.startedAt < nowMs - MAX_TRIP_AGE_MS || p.startedAt > nowMs + MAX_CLOCK_SKEW_MS) {
    return fail('implausible_time', 'startedAt');
  }
  if (p.endedAt > nowMs + MAX_CLOCK_SKEW_MS || p.endedAt - p.startedAt > MAX_SPAN_MS) {
    return fail('implausible_time', 'endedAt');
  }

  // Table ceilings, mirrored so the refusal names the field.
  if (p.durationS > MAX_DURATION_S) return fail('duration_out_of_range', 'durationS');
  if (p.distanceM > MAX_DISTANCE_M) return fail('distance_out_of_range', 'distanceM');
  for (const [i, e] of p.events.entries()) {
    if (e.durationMs > MAX_EVENT_DURATION_MS) return fail('event_duration_out_of_range', `events.${i}.durationMs`);
  }
  // The contract counts code units; the column counts bytes.
  if (new TextEncoder().encode(p.polyline).byteLength > MAX_POLYLINE_BYTES) {
    return fail('polyline_too_long', 'polyline');
  }

  const digest = p.rowsDigest;
  if (digest.maxSustainedSpeedMps > CONSTANTS.DISCARD_SPEED_MPS) {
    return fail('implausible_speed', 'rowsDigest.maxSustainedSpeedMps');
  }

  // Zero distance in zero time is an empty trip, not an impossible one; any distance in zero time is.
  const average = p.durationS > 0 ? p.distanceM / p.durationS : p.distanceM > 0 ? Infinity : 0;
  if (average > MAX_AVG_SPEED_MPS) return fail('implausible_distance', 'distanceM');

  for (const [i, e] of p.events.entries()) {
    if (e.startedAt < p.startedAt || e.startedAt + e.durationMs > p.endedAt) {
      return fail('event_outside_trip', `events.${i}.startedAt`);
    }
  }

  // Sample density: a trip claiming grade A or B must have delivered the rows that grade rests on.
  // A recovered trip is exempt (its rows past the last checkpoint are gone by design) and is
  // capped at B below instead; a grade-C trip is unscored anyway.
  const grade = dataQualityGrade(digest.validGnssPct, digest.imuPresent);
  if (!p.incomplete && grade !== 'C' && digest.count < MIN_ROW_DENSITY * p.durationS) {
    return fail('sparse_rows', 'rowsDigest.count');
  }

  const downgrades: QualityDowngrade[] = [];
  if (p.tracePath === null) downgrades.push('no_trace');
  if (p.incomplete) downgrades.push('incomplete');
  const spanS = (p.endedAt - p.startedAt) / 1000;
  if (p.durationS > spanS + SPAN_SLACK_S) downgrades.push('duration_exceeds_span');
  const allowed = Math.max(
    digest.maxSustainedSpeedMps * SPEED_DIVERGENCE_FACTOR,
    digest.maxSustainedSpeedMps + SPEED_DIVERGENCE_SLACK_MPS
  );
  if (p.durationS > 0 && average > allowed) downgrades.push('distance_exceeds_speed');
  return { ok: true, downgrades };
}

/**
 * The scorer's trip-level inputs: the device's digest verbatim, except that any downgrade withholds
 * the IMU so `dataQualityGrade` can give at most B. The grade that results is stored as
 * `trips.data_quality`; a later re-score (Task 2b) reproduces it from the row with
 * `imuPresent = rows_digest.imuPresent && data_quality === 'A'`.
 */
export function tripMetrics(
  p: Pick<FinalizeTripPayload, 'distanceM' | 'durationS' | 'role' | 'rowsDigest'>,
  downgrades: readonly QualityDowngrade[]
): TripMetrics {
  return {
    distanceM: p.distanceM,
    durationS: p.durationS,
    validGnssPct: p.rowsDigest.validGnssPct,
    imuPresent: downgrades.length === 0 && p.rowsDigest.imuPresent,
    role: p.role,
    maxSustainedSpeedMps: p.rowsDigest.maxSustainedSpeedMps,
  };
}
