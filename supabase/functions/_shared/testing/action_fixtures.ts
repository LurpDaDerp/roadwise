// Fixtures for the trip-actions suites: a stored `trips` row with every column the re-score reads
// (rows_digest, distance, role, incomplete, trace_path) and stored `trip_events` rows as PostgREST
// returns them. The inputs agree with `fixtures.ts` (13.2 km in 22 minutes, one 12 s phone pickup
// at 35 mph) and every derived number — score, category deductions, exposure, the event's severity
// and deduction — is the scoring package's own result over them, exactly as finalize-trip stored
// it, so a re-score over the stored rows lands on the same score the upload was given.
import { scoreTrip, severity } from '../scoring/index';
import type { ScorableEvent, TripMetrics } from '../scoring/index';
import { CLIENT_TRIP_ID, T0, TRIP_DAY, TZ, UID } from './fixtures.ts';

export const TRIP_ID = 'trip-0001';
export const EVENT_ID = 'event-0001';
export const CLIENT_EVENT_ID = 'p1';
export const TRACE_KEY = `${UID}/${CLIENT_TRIP_ID}.bin.gz`;

/** The digest the upload carried: grade A, 1 Hz, 20 m/s sustained maximum. */
export const ROWS_DIGEST = {
  count: 1320,
  validGnssPct: 98.03,
  imuPresent: true,
  maxSustainedSpeedMps: 20,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
};

/** The scorer's trip-level inputs, as `storedMetrics` rebuilds them from the row. */
export const STORED_METRICS: TripMetrics = {
  distanceM: 13_200,
  durationS: 1320,
  validGnssPct: ROWS_DIGEST.validGnssPct,
  imuPresent: true,
  role: 'driver',
  maxSustainedSpeedMps: ROWS_DIGEST.maxSustainedSpeedMps,
};

/** The stored phone pickup as the scorer sees it. */
export const STORED_EVENT: ScorableEvent = {
  id: CLIENT_EVENT_ID,
  category: 'phone',
  startedAt: T0 + 300_000,
  durationS: 12,
  q: 0.9,
  corrected: false,
  status: 'scored',
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
};

/** What the upload was scored: the package over the inputs above (85, phone 14.545…). */
export const STORED_SCORED = scoreTrip(STORED_METRICS, [STORED_EVENT]);
export const STORED_SCORE = STORED_SCORED.score as number;

/** A stored trip as PostgREST returns it, with the columns the actions read. */
export const storedTripRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  limit_coverage_pct: 80,
  id: TRIP_ID,
  user_id: UID,
  client_trip_id: CLIENT_TRIP_ID,
  started_at: new Date(T0).toISOString(),
  ended_at: new Date(T0 + 1_320_000).toISOString(),
  local_day: TRIP_DAY,
  tz: TZ,
  distance_m: STORED_METRICS.distanceM,
  duration_s: STORED_METRICS.durationS,
  role: 'driver',
  scoring_version: STORED_SCORED.scoringVersion,
  score: STORED_SCORE,
  status: 'final',
  exposure: STORED_SCORED.exposure,
  data_quality: STORED_SCORED.dataQuality,
  category_deductions: STORED_SCORED.categoryDeductions,
  had_severe_event: false,
  camera_session: false,
  rows_digest: ROWS_DIGEST,
  trace_path: TRACE_KEY,
  incomplete: false,
  deleted_at: null,
  created_at: new Date(T0 + 1_400_000).toISOString(),
  ...overrides,
});

/** A stored event as PostgREST returns it: the phone pickup of `fixtures.ts` on the stored trip. */
export const storedEventRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: EVENT_ID,
  trip_id: TRIP_ID,
  user_id: UID,
  client_event_id: CLIENT_EVENT_ID,
  category: 'phone',
  started_at: new Date(STORED_EVENT.startedAt).toISOString(),
  duration_ms: Math.round(STORED_EVENT.durationS * 1000),
  lat: 37.775,
  lng: -122.385,
  measured: STORED_EVENT.measured,
  context: STORED_EVENT.context,
  severity: severity(STORED_EVENT),
  confidence: STORED_EVENT.q,
  context_multiplier: 1,
  deduction: STORED_SCORED.eventDeductions[CLIENT_EVENT_ID],
  alert_shown: true,
  corrected: false,
  source: 'os',
  status: 'scored',
  created_at: new Date(T0 + 1_400_000).toISOString(),
  ...overrides,
});
