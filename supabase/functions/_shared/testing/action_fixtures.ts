// Fixtures for the trip-actions suites: a stored `trips` row with every column the re-score reads
// (rows_digest, distance, role, incomplete, trace_path) and stored `trip_events` rows as PostgREST
// returns them. The numbers agree with `fixtures.ts` (13.2 km in 22 minutes, one phone pickup) so
// a re-score over the stored rows lands on the same score the upload was given.
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

/** A stored trip as PostgREST returns it, with the columns the actions read. */
export const storedTripRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: TRIP_ID,
  user_id: UID,
  client_trip_id: CLIENT_TRIP_ID,
  started_at: new Date(T0).toISOString(),
  ended_at: new Date(T0 + 1_320_000).toISOString(),
  local_day: TRIP_DAY,
  tz: TZ,
  distance_m: 13_200,
  duration_s: 1320,
  role: 'driver',
  score: 90,
  status: 'final',
  exposure: 1.1,
  data_quality: 'A',
  category_deductions: { phone: 10.182, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
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
  started_at: new Date(T0 + 300_000).toISOString(),
  duration_ms: 12_000,
  lat: 37.775,
  lng: -122.385,
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
  severity: 0.7,
  confidence: 0.9,
  context_multiplier: 1,
  deduction: 10.182,
  alert_shown: true,
  corrected: false,
  source: 'os',
  status: 'scored',
  created_at: new Date(T0 + 1_400_000).toISOString(),
  ...overrides,
});
