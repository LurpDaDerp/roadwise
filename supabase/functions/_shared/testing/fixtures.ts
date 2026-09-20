// Test fixtures shared by the edge-function suites: one consistent upload (the numbers agree
// with each other: 13.2 km in 22 minutes at 1 Hz, one phone pickup at 35 mph) whose derived
// fields are the scoring package's own results over the same inputs, exactly as the device's
// finalizer computes them: `severity`/`contextMultiplier` per event, `provisional` for the trip,
// and each event's `deduction` from that provisional. So the happy path has no mismatch and every
// inconsistency test starts from a known-good upload.
import { contextMultiplier, scoreTrip, severity } from '../scoring/index';
import type { ScoredTrip } from '../scoring/index';
import type { FinalizeTripPayload, PayloadEvent } from '../payload.ts';
import { tripMetrics } from '../plausibility.ts';

/** 2023-11-14T22:13:20Z: 14:13 in Los Angeles, 07:13 the next day in Tokyo. */
export const T0 = 1_700_000_000_000;
/** The server clock the tests run against: two hours after the fixture trip started. */
export const NOW = T0 + 2 * 3_600_000;
export const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CLIENT_TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
export const TRIP_DAY = '2023-11-14';
export const TZ = 'America/Los_Angeles';
export const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/**
 * One event. `severity` and `contextMultiplier` come from the package over the merged
 * `measured`/`context` unless the test overrides them (to send inconsistent numbers on purpose);
 * `deduction` is null until `payload()` fills it from the device's provisional.
 */
export const event = (overrides: Partial<PayloadEvent> = {}): PayloadEvent => {
  const e = {
    id: 'p1',
    category: 'phone' as const,
    startedAt: T0 + 300_000,
    durationS: 12,
    durationMs: 12_000,
    q: 0.9,
    corrected: false,
    status: 'scored' as const,
    measured: { speedMps: 15.6464 },
    context: { night: false, precipitation: false },
    lat: 37.775,
    lng: -122.385,
    alertShown: true,
    source: 'os' as const,
    deduction: null,
    ...overrides,
  };
  return {
    ...e,
    severity: overrides.severity ?? severity(e),
    contextMultiplier: overrides.contextMultiplier ?? contextMultiplier(e),
  };
};

type PayloadInputs = Omit<FinalizeTripPayload, 'provisional'>;

const base: PayloadInputs = {
  clientTripId: CLIENT_TRIP_ID,
  startedAt: T0,
  endedAt: T0 + 1_320_000,
  tz: TZ,
  distanceM: 13_200,
  durationS: 1320,
  role: 'driver',
  roleConfidence: null,
  roleSource: 'manual',
  mode: 'mounted',
  cameraSession: false,
  events: [event()],
  rowsDigest: {
    count: 1320,
    validGnssPct: 98.03,
    imuPresent: true,
    maxSustainedSpeedMps: 20,
    sha256: SHA256_ABC,
  },
  startGeohash5: '9q8yy',
  endGeohash5: '9q8yz',
  polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  tracePath: `${CLIENT_TRIP_ID}.bin.gz`,
  hadSevereEvent: false,
  incomplete: false,
};

/** What the device would have computed for these inputs: the same scorer over the same metrics. */
export const provisionalFor = (p: PayloadInputs): ScoredTrip =>
  scoreTrip(tripMetrics(p, []), p.events);

/**
 * A consistent upload. Without a `provisional` override the device's result is derived and each
 * event's `deduction` is taken from it, as the finalizer does; with one, the events are sent as
 * given so a test can describe exactly what an inconsistent device would send.
 */
export const payload = (overrides: Partial<FinalizeTripPayload> = {}): FinalizeTripPayload => {
  const { provisional, ...rest } = overrides;
  const merged: PayloadInputs = { ...base, ...rest };
  if (provisional) return { ...merged, provisional };
  const derived = provisionalFor(merged);
  const events = merged.events.map((e) => ({
    ...e,
    deduction: derived.status === 'final' ? (derived.eventDeductions[e.id] ?? 0) : null,
  }));
  return { ...merged, events, provisional: derived };
};

/** The spec's §9.4 worked example: 8 mi in 22 min, a pickup, a speeding episode in rain, a hard brake → 74. */
export const workedExample = (overrides: Partial<FinalizeTripPayload> = {}): FinalizeTripPayload =>
  payload({
    distanceM: 12_874.752,
    rowsDigest: { count: 1320, validGnssPct: 98, imuPresent: true, maxSustainedSpeedMps: 26.8224, sha256: SHA256_ABC },
    events: [
      event({ id: 'p1' }),
      event({
        id: 's1',
        category: 'speeding',
        startedAt: T0 + 600_000,
        durationS: 45,
        durationMs: 45_000,
        q: 0.85,
        measured: { overMps: 5.36448, limitMps: 15.6464 },
        context: { night: false, precipitation: true },
        source: 'gnss',
      }),
      event({
        id: 'b1',
        category: 'braking',
        startedAt: T0 + 900_000,
        durationS: 1,
        durationMs: 1000,
        q: 0.8,
        measured: { peakG: 0.42 },
        source: 'imu',
      }),
    ],
    ...overrides,
  });

let seq = 0;

/** A stored `trips` row as PostgREST returns it, for the fake client's tables. */
export const tripRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  seq += 1;
  return {
    id: `trip-${seq}`,
    user_id: UID,
    client_trip_id: `stored-${seq}`,
    started_at: new Date(T0 - 3_600_000).toISOString(),
    ended_at: new Date(T0 - 2_400_000).toISOString(),
    created_at: new Date(T0 - 2_400_000).toISOString(),
    local_day: TRIP_DAY,
    tz: TZ,
    score: 88,
    status: 'final',
    exposure: 1,
    duration_s: 1200,
    category_deductions: { phone: 0, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0 },
    had_severe_event: false,
    camera_session: false,
    trace_path: null,
    deleted_at: null,
    ...overrides,
  };
};

/** A stored `score_daily` row as PostgREST returns it. */
export const dayRowRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  user_id: UID,
  day: TRIP_DAY,
  long_term_score: 81,
  band: 'good',
  provisional: false,
  safe_day: true,
  good_day: false,
  phone_free_day: true,
  camera_day: false,
  exposure: 2.5,
  driving_s: 2400,
  trips_scored: 2,
  severe_events: 0,
  ...overrides,
});
