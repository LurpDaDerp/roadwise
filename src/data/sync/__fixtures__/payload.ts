import type { FinalizeTripPayload } from '@/data/sync/payload';

/** A minimal valid `FinalizeTripPayload`, for tests that care about the envelope, not the trip. */
export const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
export const T0 = 1_700_000_000_000;

export const tripPayload = (
  overrides: Partial<FinalizeTripPayload> = {}
): FinalizeTripPayload => ({
  clientTripId: TRIP_ID,
  startedAt: T0,
  endedAt: T0 + 120_000,
  tz: 'UTC',
  distanceM: 900,
  durationS: 120,
  role: 'driver',
  roleConfidence: null,
  roleSource: 'manual',
  mode: 'mounted',
  cameraSession: false,
  provisional: {
    score: 74,
    status: 'final',
    exposure: 0.75,
    dataQuality: 'A',
    categoryDeductions: { phone: 0, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    eventDeductions: {},
    scoringVersion: 1,
  },
  events: [],
  rowsDigest: {
    count: 120,
    validGnssPct: 100,
    imuPresent: true,
    maxSustainedSpeedMps: 8,
    sha256: 'a'.repeat(64),
  },
  startGeohash5: '9q8yy',
  endGeohash5: '9q8yy',
  polyline: '',
  tracePath: `${TRIP_ID}.bin.gz`,
  hadSevereEvent: false,
  incomplete: false,
  ...overrides,
});
