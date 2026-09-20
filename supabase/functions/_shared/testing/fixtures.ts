// Test fixtures shared by the edge-function suites: one consistent upload (the numbers agree
// with each other: 13.2 km in 22 minutes at 1 Hz, one phone pickup at 35 mph) whose
// `provisional` block is the scoring package's own result over those inputs, so the happy path
// has no mismatch and every mismatch test starts from a known-good score.
import { scoreTrip } from '../scoring/index';
import type { ScoredTrip } from '../scoring/index';
import type { FinalizeTripPayload, PayloadEvent } from '../payload.ts';
import { tripMetrics } from '../plausibility.ts';

/** 2023-11-14T22:13:20Z: 14:13 in Los Angeles, 07:13 the next day in Tokyo. */
export const T0 = 1_700_000_000_000;
export const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CLIENT_TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
export const TRIP_DAY = '2023-11-14';
export const TZ = 'America/Los_Angeles';

export const event = (overrides: Partial<PayloadEvent> = {}): PayloadEvent => ({
  id: 'p1',
  category: 'phone',
  startedAt: T0 + 300_000,
  durationS: 12,
  durationMs: 12_000,
  q: 0.9,
  corrected: false,
  status: 'scored',
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
  contextMultiplier: 1,
  severity: 0.7,
  deduction: 10.182,
  lat: 37.775,
  lng: -122.385,
  alertShown: true,
  source: 'os',
  ...overrides,
});

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
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
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

export const payload = (overrides: Partial<FinalizeTripPayload> = {}): FinalizeTripPayload => {
  const { provisional, ...rest } = overrides;
  const merged: PayloadInputs = { ...base, ...rest };
  return { ...merged, provisional: provisional ?? provisionalFor(merged) };
};

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
