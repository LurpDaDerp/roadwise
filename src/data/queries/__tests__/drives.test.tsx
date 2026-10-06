/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { readDriveDetail, readDriveHistory, readRecentDrives, readRoutePolylines, readStatSums, useDriveCount, useRecentDrives } from '@/data/queries/drives';
import { countEvents, matchesHistoryFilter, toLocalDrive } from '@/data/queries/rows';

const T0 = 1_700_000_000_000;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    { client_trip_id: uuid(1), started_at: T0 - 1000, tz: 'UTC', status: 'scored', miles: 10, duration_s: 600, points_net: 120, estimate: 0, clean: 1, counts_json: JSON.stringify({ speeding: 0, pickups: 0, handlingS: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 0 }), polyline: 'abc' },
    { client_trip_id: uuid(2), started_at: T0 - 2000, tz: 'UTC', status: 'pending', miles: 4, duration_s: 300, points_net: -20, estimate: 1, clean: 0, counts_json: JSON.stringify({ speeding: 1, pickups: 1, handlingS: 20 }), night_miles: 1 },
    { client_trip_id: uuid(3), started_at: T0 - 3000, tz: 'UTC', status: 'merged', merged_into: uuid(1) },
    { client_trip_id: uuid(4), started_at: T0 - 4000, tz: 'UTC', status: 'not_driving', points_net: 0, miles: 3 },
    { client_trip_id: uuid(5), started_at: T0 - 5000, tz: 'UTC', status: 'recording' },
    { client_trip_id: uuid(6), started_at: T0 - 90 * 86_400_000, tz: 'UTC', status: 'unscored', reason: 'too_short', miles: 0.2, polyline: 'old' },
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(2), type: 'speeding', tier: 'minor', started_at: T0 - 1900, duration_s: 8, penalty: 15, lat: 47.6, lng: -122.3, measured_json: '{"speedMph":41}' },
    { id: uuid(22), client_trip_id: uuid(2), type: 'phone_pickup', tier: 'severe', started_at: T0 - 1800, duration_s: 20, penalty: 40, dispute_status: 'pending', stopped_in_traffic: 1 },
  ]);
});

test('lists hide merged, recording and failed drives; filters pick clean / negative / passenger', async () => {
  const all = await readDriveHistory(db, 'all');
  expect(all.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(4), uuid(6)]);
  expect((await readDriveHistory(db, 'clean')).map((d) => d.clientTripId)).toEqual([uuid(1)]);
  expect((await readDriveHistory(db, 'negative')).map((d) => d.clientTripId)).toEqual([uuid(2)]);
  expect((await readDriveHistory(db, 'passenger')).map((d) => d.clientTripId)).toEqual([uuid(4)]);
  expect(all[1]).toMatchObject({ estimate: true, pointsNet: -20, counts: expect.objectContaining({ speeding: 1, pickups: 1, handlingS: 20, hardBrake: 0 }) });
});

test('detail returns the drive with its events (dispute state, coordinates, measurements); null when absent', async () => {
  const detail = (await readDriveDetail(db, uuid(2)))!;
  expect(detail.drive.clientTripId).toBe(uuid(2));
  expect(detail.events).toHaveLength(2);
  expect(detail.events[0]).toMatchObject({ type: 'speeding', penalty: 15, lat: 47.6, measured: { speedMph: 41 }, disputeStatus: 'none', removed: false });
  expect(detail.events[1]).toMatchObject({ disputeStatus: 'pending', stoppedInTraffic: true });
  expect(await readDriveDetail(db, uuid(99))).toBeNull();
});

test('stat sums cover scored and pending drives only, within the window; routes are the listed polylines', async () => {
  const all = await readStatSums(db, null);
  expect(all).toMatchObject({ miles: 14, durationS: 900, drives: 2, cleanDrives: 1, speeding: 1, pickups: 1, handlingS: 20, nightMiles: 1 });
  const week = await readStatSums(db, T0 - 7 * 86_400_000);
  expect(week.drives).toBe(2);
  expect(await readRoutePolylines(db, null)).toEqual(['abc', 'old']);
  expect(await readRoutePolylines(db, T0 - 86_400_000)).toEqual(['abc']);
});

test('recent drives: the newest listed drives, capped', async () => {
  expect((await readRecentDrives(db, 2)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect((await readRecentDrives(db, 10)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(4), uuid(6)]);
  // The hooks are thin wrappers over these readers (React Query + the provider's db).
  expect(typeof useRecentDrives).toBe('function');
  expect(typeof useDriveCount).toBe('function');
});

test('row bridges: counts from events, filters on a drive view', () => {
  expect(countEvents([{ type: 'phone_handling', durationS: 30 }, { type: 'hard_brake', status: 'removed' }, { type: 'drowsy' }])).toMatchObject({ handlingS: 30, hardBrake: 0, drowsy: 1 });
  const d = toLocalDrive({
    client_trip_id: 'x', started_at: 1, ended_at: 2, tz: 'UTC', local_day: null, miles: 1, safe_miles: 1, night_miles: 0, duration_s: 1, dms_on: 1, dms_face_seen: 0,
    start_lat: null, start_lng: null, end_lat: null, end_lng: null, polyline: null, from_label: 'Home', to_label: null, max_speed_mph: 0, integrity_json: null,
    status: 'failed', points_net: null, estimate: 1, breakdown_json: null, clean: null, counts_json: 'not json', reason: null, merged_into: null, result_json: 'nope', server_id: null, sync_error: 'x', checkpoint_ts: null, created_at: 1, updated_at: 1,
  });
  expect(d).toMatchObject({ dmsOn: true, fromLabel: 'Home', result: null, counts: expect.objectContaining({ speeding: 0 }) });
  expect(matchesHistoryFilter(d, 'all')).toBe(false);
});
