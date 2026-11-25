/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import { REFUSED_NEVER, type Db } from '@/data/db';
import { TRIP_COLUMNS } from '@/data/db/trips';
import type { TripRow } from '@/data/db/types';
import { fullTrip, SERVER_ID } from '@/data/queries/__fixtures__/fullTrip';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { readDriveCount, readDriveDetail, readDriveHistory, readDrives, readRecentDrives, readRoutePolylines, readStatSums, useDriveCount, useRecentDrives } from '@/data/queries/drives';
import { readScoredDrives, SCORED_TRIP } from '@/data/queries/analytics';
import { DRIVE_HISTORY_FILTERS } from '@/data/queries/keys';
import {
  countEvents,
  isListed,
  isScoredDrive,
  matchesHistoryFilter,
  sumStats,
  toListedDrive,
  toLocalDrive,
  toTripView,
  TRIP_LIST_VIEW,
  TRIP_VIEW,
} from '@/data/queries/rows';

const T0 = 1_700_000_000_000;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    { client_trip_id: uuid(1), started_at: T0 - 1000, tz: 'UTC', status: 'scored', miles: 10, duration_s: 600, clean: 1, counts_json: JSON.stringify({ speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0 }), polyline: 'abc', origin: 'auto' },
    // an older build's counts_json still names its phone handling count: it is ignored (V11 recounted its pickups)
    { client_trip_id: uuid(2), started_at: T0 - 2000, tz: 'UTC', status: 'pending', miles: 4, duration_s: 300, clean: 0, counts_json: JSON.stringify({ speeding: 1, pickups: 0, handlingS: 20 }), night_miles: 1, not_driving_expired: 1 },
    { client_trip_id: uuid(4), started_at: T0 - 4000, tz: 'UTC', status: 'not_driving', miles: 3 },
    { client_trip_id: uuid(5), started_at: T0 - 5000, tz: 'UTC', status: 'recording' },
    { client_trip_id: uuid(6), started_at: T0 - 90 * 86_400_000, tz: 'UTC', status: 'unscored', reason: 'too_short', miles: 0.2, polyline: 'old' },
    { client_trip_id: uuid(7), started_at: T0 - 100 * 86_400_000, tz: 'UTC', status: 'failed', sync_error: 'http_404', miles: 2 },
    { client_trip_id: uuid(8), started_at: T0 - 6000, tz: 'UTC', status: 'pending', reason: 'too_short', miles: 0.1, duration_s: 50 },
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(2), type: 'speeding', tier: 'minor', started_at: T0 - 1900, duration_s: 8, lat: 47.6, lng: -122.3, measured_json: '{"speedMph":41,"overMphS":12}' },
    { id: uuid(22), client_trip_id: uuid(2), type: 'hard_brake', tier: 'severe', started_at: T0 - 1800, duration_s: 0, dispute_status: 'pending', dispute_reason: 'hazard' },
  ]);
});

test('lists hide recording drives, and keep a drive that failed to upload; filters pick clean / passenger', async () => {
  expect(DRIVE_HISTORY_FILTERS).toEqual(['all', 'clean', 'passenger']);
  const all = await readDriveHistory(db, 'all');
  expect(all.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(4), uuid(8), uuid(6), uuid(7)]);
  expect((await readDriveHistory(db, 'clean')).map((d) => d.clientTripId)).toEqual([uuid(1)]);
  expect((await readDriveHistory(db, 'passenger')).map((d) => d.clientTripId)).toEqual([uuid(4)]);
  expect(all[0]).toMatchObject({ origin: 'auto', notDrivingExpired: false });
  expect(all[1]).toMatchObject({ origin: 'manual', notDrivingExpired: true, counts: { speeding: 1, hardBrake: 0, hardAccel: 0, hardCorner: 0, pickups: 0, eyesOff: 0, drowsy: 0 } });
  expect(all[1]?.counts).not.toHaveProperty('handlingS');
});

test('detail returns the drive with its events (dispute state, coordinates, measurements); null when absent', async () => {
  const detail = (await readDriveDetail(db, uuid(2)))!;
  expect(detail.drive.clientTripId).toBe(uuid(2));
  expect(detail.events).toHaveLength(2);
  expect(detail.events[0]).toMatchObject({ type: 'speeding', lat: 47.6, measured: { speedMph: 41, overMphS: 12 }, disputeStatus: 'none', removed: false });
  expect(detail.events[1]).toMatchObject({ disputeStatus: 'pending' });
  expect(await readDriveDetail(db, uuid(99))).toBeNull();
});

test('stat sums cover scored and long-enough pending drives only, within the window; routes are the listed polylines', async () => {
  const all = await readStatSums(db, null);
  expect(all).toEqual({ miles: 14, durationS: 900, drives: 2, cleanDrives: 1, speeding: 1, hardBrake: 0, hardAccel: 0, hardCorner: 0, nightMiles: 1 });
  const week = await readStatSums(db, T0 - 7 * 86_400_000);
  expect(week.drives).toBe(2);
  expect(await readDriveCount(db)).toBe(2);
  expect(await readRoutePolylines(db, null)).toEqual(['abc', 'old']);
  expect(await readRoutePolylines(db, T0 - 86_400_000)).toEqual(['abc']);
});

test('recent drives: the newest listed drives, capped', async () => {
  expect((await readRecentDrives(db, 2)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect((await readRecentDrives(db, 10)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(4), uuid(8), uuid(6), uuid(7)]);
  // The hooks are thin wrappers over these readers (React Query + the provider's db).
  expect(typeof useRecentDrives).toBe('function');
  expect(typeof useDriveCount).toBe('function');
});

test('the narrow reads answer exactly what filtering the whole table does; only a list leaves the stored server answer unread', async () => {
  await seedTrips(db, [
    { client_trip_id: uuid(9), started_at: T0 - 1500, tz: 'UTC', status: 'scored', miles: 0.1 + 0.2, duration_s: 61.7, night_miles: 0.05, clean: 1, counts_json: 'not json', result_json: JSON.stringify({ x: 1 }) },
    { client_trip_id: uuid(10), started_at: T0 - 1500, tz: 'UTC', status: 'pending', miles: 7.3, duration_s: 420.2, clean: 0, counts_json: JSON.stringify({ hardBrake: 2, speeding: 'x' }) },
  ]);
  const whole = await readDrives(db);
  for (const since of [null, T0 - 1500, T0 - 7 * 86_400_000]) {
    expect(await readStatSums(db, since)).toEqual(sumStats(whole, since));
    expect(await readRoutePolylines(db, since)).toEqual(
      whole.filter((d) => isListed(d) && d.polyline !== null && d.polyline !== '' && (since === null || d.startedAt >= since)).map((d) => d.polyline)
    );
  }
  expect(await readDriveCount(db)).toBe(whole.filter(isScoredDrive).length);
  for (const limit of [0, 1, 3, 50]) {
    expect(await readRecentDrives(db, limit)).toEqual(whole.filter(isListed).slice(0, limit));
  }
  for (const filter of DRIVE_HISTORY_FILTERS) {
    expect(await readDriveHistory(db, filter)).toEqual(whole.filter((d) => matchesHistoryFilter(d, filter)).map((d) => ({ ...d, result: null })));
  }
});

test('a drive whose upload has failed at least once and is still owed says so in every read; a first try, a refusal or a done upload does not', async () => {
  const queue = (key: string, status: string, attempts: number, at: number) =>
    db.execute(
      "INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at) VALUES ('finalize-trip', '{}', ?, ?, ?, ?, 0)",
      [key, status, attempts, at]
    );
  // uuid(2) (pending, scored length): tried once, waiting to retry.
  await queue(`trip:${uuid(2)}`, 'pending', 1, T0);
  // uuid(1): its upload went. uuid(8): queued, never tried. uuid(7): turned down for good.
  await queue(`trip:${uuid(1)}`, 'done', 0, T0);
  await queue(`trip:${uuid(8)}`, 'pending', 0, T0);
  await queue(`trip:${uuid(7)}`, 'failed', 1, REFUSED_NEVER);
  const failed = (list: readonly { clientTripId: string; uploadFailed?: boolean }[]) => list.filter((d) => d.uploadFailed === true).map((d) => d.clientTripId);
  expect(failed(await readDriveHistory(db, 'all'))).toEqual([uuid(2)]);
  expect(failed(await readRecentDrives(db, 10))).toEqual([uuid(2)]);
  expect(failed(await readScoredDrives(db, null))).toEqual([uuid(2)]);
  expect((await readDriveDetail(db, uuid(2)))?.drive.uploadFailed).toBe(true);
  expect((await readDriveDetail(db, uuid(8)))?.drive).not.toHaveProperty('uploadFailed');
  // Out of retries without a refusal: still owed, still failed. In flight on a retry: the same.
  await db.execute("UPDATE sync_queue SET status = 'failed', attempts = 20, next_attempt_at = ? WHERE idempotency_key = ?", [T0, `trip:${uuid(2)}`]);
  expect((await readDriveDetail(db, uuid(2)))?.drive.uploadFailed).toBe(true);
  await db.execute("UPDATE sync_queue SET status = 'inflight', attempts = 3 WHERE idempotency_key = ?", [`trip:${uuid(2)}`]);
  expect((await readDriveDetail(db, uuid(2)))?.drive.uploadFailed).toBe(true);
  // Re-armed with a clean ladder (a sign-out's flush, a reopen): back to a first try.
  await db.execute("UPDATE sync_queue SET status = 'pending', attempts = 0 WHERE idempotency_key = ?", [`trip:${uuid(2)}`]);
  expect((await readDriveDetail(db, uuid(2)))?.drive).not.toHaveProperty('uploadFailed');
});

test('row bridges: counts from events, filters on a drive view', () => {
  expect(countEvents([{ type: 'drowsy' }, { type: 'hard_brake', status: 'removed' }, { type: 'hard_corner' }, { type: 'phone_pickup' }])).toEqual({
    speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 1, pickups: 1, eyesOff: 0, drowsy: 1,
  });
  const row: TripRow = {
    client_trip_id: 'x', started_at: 1, ended_at: 2, tz: 'UTC', local_day: null, miles: 1, night_miles: 0, duration_s: 1,
    start_lat: null, start_lng: null, end_lat: null, end_lng: null, polyline: null, from_label: 'Home', to_label: null, max_speed_mph: 0, integrity_json: null,
    status: 'failed', clean: null, counts_json: 'not json', reason: null, result_json: 'nope', server_id: null, sync_error: 'x', checkpoint_ts: null,
    created_at: 1, updated_at: 1, continues: 0, end_cause: null, watched_miles: 0, watched_s: 0, origin: 'manual', not_driving_expired: 0, finalized_at: null,
    start_source: null, last_seq: null, slowdowns: null, speedups: null, turns: null, limit_s: null, moving_s: null, phone_s: 0, archived_at: null,
    route_full: null, from_place: null, to_place: null, car_uid: null, car_name: null, end_lat_full: null, end_lng_full: null,
    speed_trace_json: null, limit_buckets_json: null, weather: null, practice_supervisor: null,
  };
  const d = toLocalDrive(row);
  expect(d).toMatchObject({ fromLabel: 'Home', result: null, counts: expect.objectContaining({ speeding: 0 }) });
  // A drive that failed to upload is still a drive the user made: listed, under "Not synced".
  expect(matchesHistoryFilter(d, 'all')).toBe(true);
  expect(matchesHistoryFilter({ ...d, status: 'recording' }, 'all')).toBe(false);
});

test('the Clean filter never lists a "Wasn’t driving" drive, whatever flag it still carries; Passenger does', async () => {
  const drive = (status: TripRow['status'], clean: boolean | null) => ({ status, clean, archived: false, carUid: null });
  expect(matchesHistoryFilter(drive('not_driving', true), 'clean')).toBe(false);
  expect(matchesHistoryFilter(drive('not_driving', true), 'passenger')).toBe(true);
  expect(matchesHistoryFilter(drive('not_driving', true), 'all')).toBe(true);
  // A clean drive is listed under Clean whether the server has answered yet or not.
  expect(matchesHistoryFilter(drive('scored', true), 'clean')).toBe(true);
  expect(matchesHistoryFilter(drive('pending', true), 'clean')).toBe(true);
  expect(matchesHistoryFilter(drive('scored', false), 'clean')).toBe(false);
  expect(matchesHistoryFilter(drive('scored', null), 'clean')).toBe(false);
  // Marked on this phone with the flag the tap left: under Passenger only.
  await seedTrips(db, [{ client_trip_id: uuid(3), started_at: T0 - 3000, tz: 'UTC', status: 'not_driving', miles: 5, clean: 1 }]);
  expect((await readDriveHistory(db, 'clean')).map((d) => d.clientTripId)).toEqual([uuid(1)]);
  expect((await readDriveHistory(db, 'passenger')).map((d) => d.clientTripId)).toEqual([uuid(3), uuid(4)]);
});

describe('the list reads leave the speed trace, stored server answer and integrity block in SQLite', () => {
  const UNREAD = ['speed_trace_json', 'result_json', 'integrity_json'];
  const NEWEST_FIRST = 'ORDER BY t.started_at DESC, t.client_trip_id ASC';
  /** The drives a list built from the whole row, as it did before it named its columns. */
  const wholeRows = async (where: string, params: unknown[] = []) =>
    (await db.execute(`SELECT ${TRIP_VIEW} FROM trips t WHERE ${where} ${NEWEST_FIRST}`, params)).rows.map((row) => toListedDrive(toTripView(row)));

  beforeEach(async () => {
    // Every column set: one listed (its upload failed once, still owed), one archived, one marked "Wasn't driving".
    await seedTrips(db, [
      fullTrip(uuid(30), T0 - 500, { archived_at: null }),
      fullTrip(uuid(31), T0 - 700),
      fullTrip(uuid(32), T0 - 900, { status: 'not_driving', archived_at: null }),
    ]);
    await db.execute(
      "INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at) VALUES ('finalize-trip', '{}', ?, 'pending', 1, ?, 0)",
      [`trip:${uuid(30)}`, T0]
    );
  });

  test('the select names every other trip column and the upload flag, and nothing else', async () => {
    const { rows } = await db.execute(`SELECT ${TRIP_LIST_VIEW} FROM trips t WHERE t.client_trip_id = ?`, [uuid(30)]);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([...TRIP_COLUMNS.filter((c) => !UNREAD.includes(c)), 'upload_failed'].sort());
    // The seeded row really carries every column, so the reads below compare full drives.
    const whole = (await db.execute('SELECT * FROM trips WHERE client_trip_id = ?', [uuid(30)])).rows[0]!;
    expect(TRIP_COLUMNS.filter((c) => whole[c] === null)).toEqual(['archived_at']);
  });

  test('Drive history builds the very drives the whole row builds, under every filter', async () => {
    for (const filter of DRIVE_HISTORY_FILTERS) {
      const want = (await wholeRows("t.status != 'recording' AND t.archived_at IS NULL")).filter((d) => matchesHistoryFilter(d, filter));
      expect(await readDriveHistory(db, filter)).toEqual(want);
    }
    const listed = (await readDriveHistory(db, 'all')).find((d) => d.clientTripId === uuid(30))!;
    // Every field a list shows is there (and the three it never shows stay null, as they always were).
    expect(listed).toMatchObject({
      polyline: 'whole',
      fromPlace: 'home',
      carName: 'Civic',
      start: { lat: 47.6062, lng: -122.3321 },
      end: { lat: 47.7, lng: -122.3 },
      limitBuckets: { high: { s: 3, m: 90 } },
      weather: 'rain',
      practiceSupervisor: 'Dad',
      uploadFailed: true,
      result: null,
      speedTrace: null,
    });
  });

  test('the scored drives (Home’s coaching, Analytics, commute, Wrapped, spots) are the very drives the whole row builds', async () => {
    for (const since of [null, T0 - 800, T0 + 1]) {
      const want = (await wholeRows(`${SCORED_TRIP} ${since === null ? '' : 'AND t.started_at >= ?'}`, since === null ? [] : [since])).filter(isScoredDrive);
      expect(await readScoredDrives(db, since)).toEqual(want);
    }
    expect((await readScoredDrives(db, null)).map((d) => d.clientTripId)).toEqual([uuid(30), uuid(31), uuid(1), uuid(2)]);
  });

  test('neither list reader asks SQLite for them', async () => {
    const sent: string[] = [];
    const recording: Db = {
      execute: (sql, params) => {
        sent.push(sql);
        return db.execute(sql, params);
      },
      transaction: (fn) => db.transaction(fn),
    };
    await readDriveHistory(recording, 'all');
    await readScoredDrives(recording, null);
    expect(sent).toHaveLength(2);
    for (const sql of sent) {
      expect(sql).not.toContain('t.*');
      for (const column of UNREAD) expect(sql).not.toContain(column);
    }
  });

  test('a drive’s own read still parses its server answer and speed trace', async () => {
    const detail = (await readDriveDetail(db, uuid(30)))!;
    expect(detail.drive.result).toMatchObject({ tripId: SERVER_ID, scored: true });
    expect(detail.drive.speedTrace).not.toBeNull();
  });
});
