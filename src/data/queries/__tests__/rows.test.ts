import { estimateExposure } from '@scoring';

import type { EventRow, TripRow } from '@/data/db/types';
import { exposureOf, isScoredDrive, parseResult, toLocalDrive, toLocalDriveEvent } from '@/data/queries/rows';

const row = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'e1',
  client_trip_id: 't1',
  type: 'speeding',
  tier: 'moderate',
  started_at: 1_700_000_000_000,
  duration_s: 40,
  lat: null,
  lng: null,
  measured_json: '{"speedMph":52,"limitMph":40,"overMphS":180.5,"mounted":false,"maxSpeedMph":60}',
  status: 'active',
  dispute_status: 'none',
  dispute_reason: null,
  dispute_message: null,
  ...over,
});

const trip = (over: Partial<TripRow> = {}): TripRow => ({
  client_trip_id: 'x',
  started_at: 1,
  ended_at: 2,
  tz: 'UTC',
  local_day: null,
  miles: 12,
  night_miles: 0,
  duration_s: 1800,
  start_lat: null,
  start_lng: null,
  end_lat: null,
  end_lng: null,
  polyline: null,
  from_label: null,
  to_label: null,
  max_speed_mph: 0,
  integrity_json: null,
  status: 'pending',
  clean: 1,
  counts_json: null,
  reason: null,
  result_json: null,
  server_id: null,
  sync_error: null,
  checkpoint_ts: null,
  created_at: 1,
  updated_at: 1,
  continues: 0,
  end_cause: null,
  watched_miles: 0,
  origin: 'manual',
  not_driving_expired: 0,
  finalized_at: null,
  start_source: null,
  last_seq: null,
  slowdowns: null,
  speedups: null,
  turns: null,
  limit_s: null,
  moving_s: null,
  phone_s: 0,
  ...over,
});

const ANSWER = {
  tripId: '00000000-0000-4000-8000-000000000001',
  clientTripId: '00000000-0000-4000-8000-000000000002',
  mergedInto: null,
  scored: true,
  reason: null,
  eventIds: [],
  rating: { safetyRating: 88.4, ranked: true },
  challenges: [{ id: 'c1', title: 'Clean sweep' }],
  achievements: ['first_drive'],
};

test('a drive event keeps what it measured (speeding: overMphS; a phone pickup: its top speed) and drops the keys this build does not read', () => {
  expect(toLocalDriveEvent(row())).toEqual({
    id: 'e1',
    type: 'speeding',
    tier: 'moderate',
    startedAt: 1_700_000_000_000,
    durationS: 40,
    lat: null,
    lng: null,
    disputeStatus: 'none',
    disputeMessage: null,
    removed: false,
    measured: { speedMph: 52, limitMph: 40, overMphS: 180.5 },
  });
  expect(toLocalDriveEvent(row({ type: 'eyes_off', tier: 'severe', measured_json: '{"source":"dashcam","speedMph":30}' })).measured).toEqual({ speedMph: 30, source: 'dashcam' });
  expect(toLocalDriveEvent(row({ type: 'phone_pickup', tier: 'moderate', duration_s: 12, measured_json: '{"speedMph":35,"maxSpeedMph":41.5,"mounted":false}' }))).toMatchObject({
    type: 'phone_pickup',
    durationS: 12,
    measured: { speedMph: 35, maxSpeedMph: 41.5 },
  });
  expect(toLocalDriveEvent(row({ measured_json: 'not json' })).measured).toEqual({});
  expect(toLocalDriveEvent(row({ measured_json: null, status: 'removed' }))).toMatchObject({ measured: {}, removed: true });
});

test('a drive counts toward stats when scored, or pending and long enough to score; points play no part', () => {
  expect(isScoredDrive({ status: 'scored', reason: null })).toBe(true);
  expect(isScoredDrive({ status: 'pending', reason: null })).toBe(true);
  expect(isScoredDrive({ status: 'pending', reason: 'too_short' })).toBe(false);
  for (const status of ['recording', 'unscored', 'not_driving', 'failed'] as const) expect(isScoredDrive({ status, reason: null })).toBe(false);
});

test('the stored answer reads as v4; an older points answer or garbage is null', () => {
  expect(parseResult(JSON.stringify(ANSWER))).toEqual(ANSWER);
  expect(parseResult(JSON.stringify({ ...ANSWER, net: 120, breakdown: {} }))).toMatchObject({ rating: { safetyRating: 88.4 } });
  expect(parseResult(JSON.stringify({ tripId: ANSWER.tripId, clientTripId: ANSWER.clientTripId, mergedInto: null, scored: true, reason: null, net: 120 }))).toBeNull();
  expect(parseResult('nope')).toBeNull();
  expect(parseResult(null)).toBeNull();
});

test('exposure: the counted columns when all five are there, with the phone seconds (clamped), else estimated from miles and duration (no phone seconds)', () => {
  expect(exposureOf(trip({ slowdowns: 9, speedups: 8, turns: 5, limit_s: 2000, moving_s: 1500 }))).toEqual({
    exposure: { slowdowns: 9, speedups: 8, turns: 5, limitS: 1500, movingS: 1500, phoneS: 0 },
    estimated: false,
  });
  expect(exposureOf(trip({ slowdowns: 9, speedups: 8, turns: 5, limit_s: 900, moving_s: 1500, phone_s: 1200 })).exposure.phoneS).toBe(1200);
  expect(exposureOf(trip({ slowdowns: 9, speedups: 8, turns: 5, limit_s: 900, moving_s: 1500, phone_s: 9000 })).exposure.phoneS).toBe(1500);
  // A drive recorded before the counters: estimated, and never watched for phone use.
  expect(exposureOf(trip({ phone_s: 700 })).exposure.phoneS).toBe(0);
  expect(exposureOf(trip({ slowdowns: 9, speedups: 8, turns: 5, limit_s: 100, moving_s: null }))).toEqual({ exposure: estimateExposure(12, 1800), estimated: true });
  expect(exposureOf(trip())).toEqual({ exposure: estimateExposure(12, 1800), estimated: true });
});

test('a local drive carries how it started, its "Not driving?" verdict, start source and exposure', () => {
  const d = toLocalDrive(
    trip({ origin: 'auto', not_driving_expired: 1, start_source: 'trace', slowdowns: 3, speedups: 4, turns: 2, limit_s: 600, moving_s: 900, result_json: JSON.stringify(ANSWER) })
  );
  expect(d).toMatchObject({
    origin: 'auto',
    notDrivingExpired: true,
    startSource: 'trace',
    exposure: { slowdowns: 3, speedups: 4, turns: 2, limitS: 600, movingS: 900, phoneS: 0 },
    exposureEstimated: false,
    result: ANSWER,
  });
  expect(d).not.toHaveProperty('pointsNet');
  expect(d).not.toHaveProperty('estimate');
  expect(toLocalDrive(trip())).toMatchObject({ origin: 'manual', notDrivingExpired: false, startSource: null, exposureEstimated: true });
});
