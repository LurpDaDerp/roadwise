/** @jest-environment node */
import { classifyDrive, MERGE_GAP_S } from '@scoring';

import { T0 } from '@/core/detectors/__fixtures__/rows';
import { brakeEvent, closedSession, rows, speedingEvent, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import {
  closeDrive,
  dropReason,
  dropTrip,
  exposureOf,
  finalizeTrip,
  INVALID_PAYLOAD_SYNC_ERROR,
  isDropped,
  normaliseZone,
  sanitizeEvent,
  UPLOAD_HOLD_MS,
} from '@/core/engine/finalize';
import { PRIVACY_ZONES_KEY } from '@/core/engine/privacy';
import { appendRow, closeAtLastMovement, closeSession, createSession } from '@/core/engine/session';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { FinalizeTripPayloadV4Schema, MAX_DRIVE_MS } from '@/data/sync/payload';
import { findFinalize } from '@/data/sync/queue';
import { haversineMeters } from '@/lib/geo';
import { decodeRuns } from '@/lib/polyline';
import { metersToMiles } from '@/lib/units';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const NOW = T0 + 1_000_000;
const deps = (over: Partial<Parameters<typeof finalizeTrip>[1]> = {}) => ({
  db,
  tz: TZ,
  now: () => NOW,
  appVersion: '2.0.0',
  geocode: null,
  trimSeed: async (id: string) => `${id}-seed`.padEnd(64, '0'),
  ...over,
});

/** Store a session's rows as the recorder would have (the trip row and its samples). */
async function recorded(session: Readonly<TripSession>, list: ReturnType<typeof rows>): Promise<void> {
  await createTripsRepo(db).insert({ client_trip_id: session.clientTripId, started_at: session.startedAt, tz: TZ, status: 'recording', origin: session.origin }, T0);
  await createSamplesRepo(db).appendMany(session.clientTripId, list.map((r) => ({ ts: r.ts, row: r })));
}

test('a 20-minute drive is stored as pending with its classification, trimmed route, labels, exposure and one held v4 payload', async () => {
  // 1200 rows × 15 m = 18 km ≈ 11.2 mi; one speeding and one brake after the warm-up.
  const session = closedSession(1200, [speedingEvent(T0 + 300_000), brakeEvent(T0 + 600_000)], { origin: 'auto' });
  await createSettingsRepo(db).set(PRIVACY_ZONES_KEY, [{ id: 'h', name: 'Home', lat: 47.6062, lng: -122.3321, radiusM: 300 }]);
  const geocoded: string[] = [];
  const result = await finalizeTrip(session, deps({ geocode: async (p) => (geocoded.push(`${p.lat},${p.lng}`), 'Capitol Hill') }));

  expect(result.trip).toMatchObject({
    status: 'pending',
    tz: TZ,
    local_day: '2023-11-14',
    from_label: 'Home',
    to_label: 'Capitol Hill',
    sync_error: null,
    origin: 'auto',
    not_driving_expired: 0,
    continuations: 0,
    finalized_at: NOW,
    reason: null,
    clean: 0,
  });
  expect(result.trip).not.toHaveProperty('points_net');
  expect(geocoded).toHaveLength(1); // the start was inside a zone: no geocode there
  expect(result.trip.miles).toBeCloseTo(11.18, 1);
  expect(result.trip.night_miles).toBe(0); // 14:13 local: daylight
  expect(result.trip.duration_s).toBe(1200);
  expect(result.drive).toEqual({ scored: true, reason: null, activeEventCount: 2 });
  expect(JSON.parse(result.trip.counts_json!)).toMatchObject({ speeding: 1, hardBrake: 1 });
  expect(result.events).toHaveLength(2);
  expect(result.events[0]).toMatchObject({ id: uuid(1), type: 'speeding' });
  expect(result.events[1]!.lat).not.toBeNull();

  const payload = result.payload!;
  expect(FinalizeTripPayloadV4Schema.safeParse(payload).success).toBe(true);
  expect(payload).toMatchObject({ v: 4, clientTripId: session.clientTripId, startedAt: T0, endedAt: T0 + 1_200_000, tz: TZ, localDay: '2023-11-14', appVersion: '2.0.0', origin: 'auto', notDrivingExpired: false });
  expect(payload).not.toHaveProperty('safeMiles');
  expect(payload.start).toEqual({ lat: 47.6062, lng: -122.3321 });
  expect(payload.integrity).toMatchObject({ mockLocation: false, motionMismatch: false, validGnssPct: 100 });
  expect(payload.integrity.maxSpeedMph).toBeCloseTo(33.55, 1);
  // The opportunities: one per row moving at 5 mph or more, the stored columns the same.
  expect(payload.exposure).toEqual(exposureOf(session, 1200));
  expect(payload.exposure!.movingS).toBe(1200);
  expect(result.trip).toMatchObject({ slowdowns: 0, speedups: 0, turns: 0, limit_s: 0, moving_s: 1200 });
  // The route never shows the first/last 0.25 mi nor the zone around the start.
  const runs = decodeRuns(payload.polyline);
  expect(runs).toHaveLength(1); // the zone sits at the start, inside the trimmed end: one visible run
  const shown = runs.flat();
  expect(shown.length).toBeGreaterThan(2);
  expect(Math.min(...shown.map((p) => p.lng))).toBeGreaterThan(-122.3321 + 402 / 75_000);
  // The trim plan never leaves the phone.
  expect(JSON.stringify(payload)).not.toMatch(/startM|zoneRadiiM|plan/);
  expect(await findFinalize(db, session.clientTripId)).toEqual(payload);
  const item = await createQueueRepo(db).byKey(`trip:${session.clientTripId}`);
  expect(item?.owner_uid).toBe('user-1');
  // Held: the upload waits out the merge window from the finalize.
  expect(item?.next_attempt_at).toBe(NOW + UPLOAD_HOLD_MS);
  expect(UPLOAD_HOLD_MS).toBe(MERGE_GAP_S * 1000);
});

test('the drive’s own samples stay through its hold; drives whose hold is over lose theirs (the sweep)', async () => {
  const trips = createTripsRepo(db);
  const samples = createSamplesRepo(db);
  // An older drive finalized 6 min ago, and one finalized 2 min ago: only the first is swept.
  for (const [n, at] of [
    [21, NOW - 360_000],
    [22, NOW - 120_000],
  ] as const) {
    await trips.insert({ client_trip_id: uuid(n), started_at: T0 - 3_600_000, tz: TZ, status: 'pending', finalized_at: at }, T0);
    await samples.appendMany(uuid(n), rows(3).map((r) => ({ ts: r.ts, row: r })));
  }
  const list = rows(200);
  const session = closedSession(200);
  await recorded(session, list);
  await finalizeTrip(session, deps());
  expect(await samples.count(session.clientTripId)).toBe(200);
  expect(await samples.count(uuid(21))).toBe(0);
  expect(await samples.count(uuid(22))).toBe(3);
});

test('a drive whose "Not driving?" ran out (the row says so, or the host does) uploads notDrivingExpired', async () => {
  const session = closedSession(200, [], { origin: 'auto' });
  await recorded(session, rows(200));
  await createTripsRepo(db).update(session.clientTripId, { not_driving_expired: 1 }, T0);
  const result = await finalizeTrip(session, deps());
  expect(result.payload).toMatchObject({ notDrivingExpired: true, origin: 'auto' });
  expect(result.trip.not_driving_expired).toBe(1);

  const other = closedSession(200, [], { clientTripId: uuid(30) });
  expect((await finalizeTrip(other, deps({ notDrivingExpired: true }))).payload).toMatchObject({ notDrivingExpired: true, origin: 'manual' });
});

test('a drive started from the parked spot (start source motion) labels and stores that spot; the upload’s start stays its first row', async () => {
  const base = closedSession(300);
  const parked = { lat: 47.61, lng: -122.34 };
  const session: Readonly<TripSession> = { ...base, startSource: 'motion', startPlace: parked, continuations: 2 };
  const labelled: string[] = [];
  const result = await finalizeTrip(session, deps({ geocode: async (p) => (labelled.push(`${p.lat},${p.lng}`), 'Somewhere') }));
  expect(labelled[0]).toBe(`${parked.lat},${parked.lng}`);
  expect(result.trip).toMatchObject({ start_lat: 47.61, start_lng: -122.34, start_source: 'motion', continuations: 2 });
  expect(result.payload!.start).toEqual({ lat: 47.6062, lng: -122.3321 });
});

test('a drive through a mid-route privacy zone uploads both visible runs, so the whole visible distance passes the server miles check', async () => {
  // 1200 rows x 15 m = 18 km ~ 11.2 mi due east from START; a 300 m zone around the 9 km mark.
  const session = closedSession(1200, []);
  const mid = session.track[600]!;
  await createSettingsRepo(db).set(PRIVACY_ZONES_KEY, [{ id: 's', name: 'School', lat: mid.lat, lng: mid.lng, radiusM: 300 }]);
  const result = await finalizeTrip(session, deps());
  const payload = result.payload!;
  expect(FinalizeTripPayloadV4Schema.safeParse(payload).success).toBe(true);
  const runs = decodeRuns(payload.polyline);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  // No encoded point inside the zone, and no segment of any run crosses it (west stays west, east stays east).
  for (const run of runs) {
    for (const p of run) expect(haversineMeters(p, mid)).toBeGreaterThan(300);
    for (let i = 1; i < run.length; i += 1) expect(Math.sign(run[i - 1]!.lng - mid.lng)).toBe(Math.sign(run[i]!.lng - mid.lng));
  }
  // The server's rule (`finalize_rules.milesExceedRoute`): miles <= visible miles x 1.25 + 4. With only the longer
  // half (~5.3 mi) an 11.2 mi drive would be refused as implausible; with both runs it is plausible with room to spare.
  const visibleMiles = runs.reduce((m, run) => m + run.slice(1).reduce((s, p, i) => s + haversineMeters(run[i]!, p), 0), 0) / 1609.344;
  expect(visibleMiles).toBeGreaterThan(9);
  expect(payload.miles).toBeLessThanOrEqual(visibleMiles * 1.25 + 4);
  expect(payload.miles).toBeGreaterThan(Math.max(...runs.map((run) => run.slice(1).reduce((s, p, i) => s + haversineMeters(run[i]!, p), 0))) / 1609.344 * 1.25 + 4);
  expect(result.trip.polyline).toBe(payload.polyline);
});

test('a short drive is stored too short (pending, reason kept, no clean flag) and still uploaded; mock rows mark the integrity', async () => {
  const session = closedSession(40, [], { mockEvery: 10 });
  const result = await finalizeTrip(session, deps());
  expect(result.drive).toEqual({ scored: false, reason: 'too_short', activeEventCount: 0 });
  expect(result.trip).toMatchObject({ status: 'pending', clean: null, reason: 'too_short' });
  expect(result.payload?.integrity.mockLocation).toBe(true);
  expect(JSON.parse(result.trip.integrity_json!).mockLocation).toBe(true);
});

test('a clean scored drive has clean 1; DashPal-only events never break clean (classifyDrive)', async () => {
  const result = await finalizeTrip(closedSession(1200), deps());
  expect(result.trip.clean).toBe(1);
  expect(result.drive).toEqual(classifyDrive({ miles: result.trip.miles, durationS: 1200, events: [] }));
});

test('a motion mismatch (GPS moving, IMU flat) is flagged', async () => {
  const session = closedSession(300, [], { over: () => ({ aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0 }) });
  const result = await finalizeTrip(session, deps());
  expect(result.payload?.integrity.motionMismatch).toBe(true);
});

test('a second call for the same drive returns what is stored and queues nothing new', async () => {
  const session = closedSession(200);
  const first = await finalizeTrip(session, deps());
  const again = await finalizeTrip(session, deps({ now: () => NOW + 5000 }));
  expect(again.trip.updated_at).toBe(first.trip.updated_at);
  expect(again.payload).toBeNull();
  expect(again.drive).toEqual(first.drive);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
});

test('a drive the contract refuses is stored as failed and never queued', async () => {
  const session = closedSession(200, [], { clientTripId: 'not-a-uuid' });
  const result = await finalizeTrip(session, deps());
  expect(result.payload).toBeNull();
  expect(result.trip).toMatchObject({ status: 'failed', sync_error: INVALID_PAYLOAD_SYNC_ERROR });
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
  expect(await createEventsRepo(db).listByTrip('not-a-uuid')).toEqual([]);
});

test('sanitizeEvent clamps and rounds what a detector emitted, keeping only the measured fields of the contract', () => {
  const e = sanitizeEvent({ id: 'x', type: 'hard_brake', tier: 'minor', startedAt: T0 - 5, durationS: Number.NaN, measured: { speedMph: 1.23456, peakG: Number.POSITIVE_INFINITY } }, T0, T0 + 60_000);
  expect(e).toEqual({ id: 'x', type: 'hard_brake', tier: 'minor', startedAt: T0, durationS: 0, measured: { speedMph: 1.235 } });
  const base = { id: 'x', type: 'speeding', tier: 'minor', startedAt: T0, durationS: 10 } as const;
  expect(sanitizeEvent({ ...base, measured: { overMphS: 12.34567 } }, T0, T0 + 60_000).measured).toEqual({ overMphS: 12.346 });
  expect(sanitizeEvent({ ...base, measured: { overMphS: 5e6 } }, T0, T0 + 60_000).measured).toEqual({ overMphS: 1e6 });
  expect(sanitizeEvent({ ...base, measured: { overMphS: -3 } }, T0, T0 + 60_000).measured).toEqual({ overMphS: 0 });
  expect(sanitizeEvent({ ...base, measured: { overMphS: Number.NaN } }, T0, T0 + 60_000).measured).toEqual({});
  // Fields an older detector wrote (phone use) never reach the upload.
  const legacy = { ...base, measured: { maxSpeedMph: 52, mounted: true } } as unknown as Parameters<typeof sanitizeEvent>[0];
  expect(sanitizeEvent(legacy, T0, T0 + 60_000).measured).toEqual({});
});

test('normaliseZone', () => {
  expect(normaliseZone('America/New_York')).toBe('America/New_York');
  expect(normaliseZone('GMT+5')).toBe('Etc/GMT-5');
  expect(normaliseZone('UTC-3')).toBe('Etc/GMT+3');
  expect(normaliseZone('GMT+05:30')).toBe('UTC');
  expect(normaliseZone('')).toBe('UTC');
  expect(normaliseZone('Not/AZone')).toBe('UTC');
});

describe('a drive closed at its last movement', () => {
  /** 600 rows at 15 m/s (9 km), then 300 parked rows jittering 10 m a second (3 km of drift) with events in them. */
  function cutSession() {
    const s = createSession({ clientTripId: '22222222-2222-4222-8222-222222222222', startedAt: T0, origin: 'manual' });
    const drive = rows(600);
    const end = drive.at(-1)!;
    const parked = rows(300, { t0: T0 + 600_000, speedMps: 0.5 }).map((r, i) => ({ ...r, lng: end.lng + (i % 2 === 0 ? 10 : 0) / 75_000 }));
    for (const r of [...drive, ...parked]) appendRow(s, r, { unsafe: false, limitUsable: false });
    s.events.push(
      // Speeding that ran 40 s into the stop: clipped at the cut.
      { id: uuid(11), type: 'speeding', tier: 'moderate', startedAt: T0 + 580_000, durationS: 60, measured: { speedMph: 45 } },
      // A speeding event well into the parked tail: dropped.
      { id: uuid(13), type: 'speeding', tier: 'minor', startedAt: T0 + 700_000, durationS: 30, measured: {} }
    );
    return { open: s, closed: closeAtLastMovement(s, 'stopped') };
  }

  test('the payload ends at the cut with the mark’s miles, exposure and no tail event; a crossing event is clipped', async () => {
    const { open, closed } = cutSession();
    expect(closed.endedAt).toBe(T0 + 600_000);
    const result = await finalizeTrip(closed, deps());
    const payload = result.payload!;
    expect(FinalizeTripPayloadV4Schema.safeParse(payload).success).toBe(true);
    expect(payload.endedAt).toBe(T0 + 600_000);
    expect(payload.miles).toBeCloseTo(metersToMiles(open.moved!.distanceM), 3);
    expect(payload.miles).toBeLessThan(metersToMiles(open.distanceM));
    expect(payload.events.map((e) => [e.id, e.durationS])).toEqual([[uuid(11), 20]]);
    // The parked tail moves nothing at 5 mph: the mark's moving seconds, never the tail's.
    expect(payload.exposure!.movingS).toBe(open.moved!.movingRows);
    expect((await createEventsRepo(db).listByTrip(closed.clientTripId)).map((e) => [e.id, e.tier])).toEqual([[uuid(11), 'moderate']]);
  });

  test('a drive that reached the 12 h bound (cause limit) is stored pending with a payload the contract takes', async () => {
    const s = createSession({ clientTripId: '33333333-3333-4333-8333-333333333333', startedAt: T0, origin: 'auto' });
    // One fix a minute for 12 h, 900 m apart: the last movement 1 s before the bound.
    for (let k = 0; k < 720; k += 1) {
      appendRow(s, { ...rows(1, { t0: T0 + k * 60_000 })[0]!, lng: -122.3321 + (k * 900) / 75_000, speed: -1 }, { unsafe: false, limitUsable: false });
    }
    appendRow(s, { ...rows(1, { t0: T0 + MAX_DRIVE_MS - 1000 })[0]!, lng: -122.3321 + (720 * 900) / 75_000, speed: -1 }, { unsafe: false, limitUsable: false });
    const closed = closeAtLastMovement(s, 'limit');
    expect(closed.endedAt! - closed.startedAt).toBeLessThanOrEqual(MAX_DRIVE_MS);
    const result = await finalizeTrip(closed, deps({ now: () => T0 + MAX_DRIVE_MS + 5000 }));
    expect(result.trip.status).toBe('pending');
    expect(result.payload).not.toBeNull();
    expect(FinalizeTripPayloadV4Schema.safeParse(result.payload).success).toBe(true);
  });
});

describe('a drive that never moved is dropped (closeDrive)', () => {
  const ID = '44444444-4444-4444-8444-444444444444';
  async function recordingTrip(n: number, over: Parameters<typeof rows>[1] = {}) {
    await createTripsRepo(db).insert({ client_trip_id: ID, started_at: T0, tz: TZ, status: 'recording' }, T0);
    const list = rows(n, { speedMps: 0, ...over });
    await createSamplesRepo(db).appendMany(ID, list.map((r) => ({ ts: r.ts, row: r })));
    await createEventsRepo(db).insertMany([{ id: uuid(40), client_trip_id: ID, type: 'hard_brake', tier: 'severe', started_at: T0 + 5000 }]);
    await db.execute('INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s) VALUES (?, 0, 0)', [ID]);
    const s = createSession({ clientTripId: ID, startedAt: T0, origin: 'manual' });
    for (const r of list) appendRow(s, r, { unsafe: false, limitUsable: false });
    return s;
  }

  test('an automatic end of a drive that stood still removes the trip, samples, events and coverage; nothing is queued', async () => {
    const s = await recordingTrip(60);
    expect(dropReason(s)).toBe('no_movement');
    const result = await closeDrive(closeAtLastMovement(s, 'stopped'), deps());
    expect(result).toEqual({ dropped: 'no_movement', clientTripId: ID });
    expect(await createTripsRepo(db).get(ID)).toBeNull();
    expect(await createSamplesRepo(db).count(ID)).toBe(0);
    expect(await createEventsRepo(db).listByTrip(ID)).toEqual([]);
    expect((await db.execute('SELECT * FROM dashcam_coverage')).rows).toEqual([]);
    expect((await db.execute('SELECT * FROM sync_queue')).rows).toEqual([]);
  });

  test('no valid fix at all is no_gps; a manual end of a never-moved drive is dropped too', async () => {
    const s = await recordingTrip(60, { over: () => ({ gnssValid: false, speed: -1 }) });
    expect(dropReason(s)).toBe('no_gps');
    expect(await closeDrive(closeSession(s, T0 + 60_000, 'manual'), deps())).toEqual({ dropped: 'no_gps', clientTripId: ID });
    expect(await createTripsRepo(db).get(ID)).toBeNull();
  });

  test('a drive that moved but never reached driving speed is not_driven and dropped, however it ended', async () => {
    // 8 mph for 10 min (a run, or a crawl in a lot): movement on pace, never 10 mph.
    const walk = rows(600, { speedMps: 3.58 });
    for (const [label, close] of [
      ['manual', (s: TripSession) => closeSession(s, T0 + 600_000, 'manual')],
      ['stopped', (s: TripSession) => closeAtLastMovement(s, 'stopped')],
      ['walking', (s: TripSession) => closeAtLastMovement(s, 'walking', { notAfter: T0 + 300_000 })],
      ['orphan', (s: TripSession) => closeAtLastMovement(s, 'orphan')],
    ] as const) {
      await createTripsRepo(db).insert({ client_trip_id: ID, started_at: T0, tz: TZ, status: 'recording' }, T0);
      const s = createSession({ clientTripId: ID, startedAt: T0, origin: 'manual' });
      for (const r of walk) appendRow(s, r, { unsafe: false, limitUsable: false });
      expect(s.moved).not.toBeNull();
      expect(s.droveAt).toBeNull();
      expect(dropReason(s)).toBe('not_driven');
      expect([label, await closeDrive(close(s), deps())]).toEqual([label, { dropped: 'not_driven', clientTripId: ID }]);
      expect(await createTripsRepo(db).get(ID)).toBeNull();
    }
    expect((await db.execute('SELECT * FROM sync_queue')).rows).toEqual([]);
  });

  test('driving speed needs trusted readings: 30 mph rows rated at 3 m/s are not_driven; at -1 (no rating) they count', () => {
    const untrusted = createSession({ clientTripId: ID, startedAt: T0, origin: 'manual' });
    for (const r of rows(60, { over: () => ({ speedAcc: 3 }) })) appendRow(untrusted, r, { unsafe: false, limitUsable: false });
    expect(dropReason(untrusted)).toBe('not_driven');
    expect(untrusted.droveAt).toBeNull();
    const unrated = createSession({ clientTripId: ID, startedAt: T0, origin: 'manual' });
    for (const r of rows(60, { over: () => ({ speedAcc: -1 }) })) appendRow(unrated, r, { unsafe: false, limitUsable: false });
    expect(dropReason(unrated)).toBeNull();
  });

  test('no_gps outranks the rest, and no_movement outranks not_driven', () => {
    expect(dropReason({ validGnssRows: 0, moved: null, droveAt: null })).toBe('no_gps');
    expect(dropReason({ validGnssRows: 5, moved: null, droveAt: null })).toBe('no_movement');
    expect(dropReason({ validGnssRows: 5, moved: null, droveAt: T0 })).toBe('no_movement');
  });

  test('a drive that moved is kept (dropReason null) and finalized as before', async () => {
    const s = createSession({ clientTripId: ID, startedAt: T0, origin: 'manual' });
    for (const r of rows(60)) appendRow(s, r, { unsafe: false, limitUsable: false });
    expect(dropReason(s)).toBeNull();
    const result = await closeDrive(closeAtLastMovement(s, 'stopped'), deps());
    expect(isDropped(result)).toBe(false);
    expect((await createTripsRepo(db).get(ID))!.status).toBe('pending');
  });

  test('a second closeDrive after a drop neither throws nor inserts; dropTrip never deletes a finalized row', async () => {
    const s = await recordingTrip(10);
    const closed = closeAtLastMovement(s, 'stopped');
    await closeDrive(closed, deps());
    expect(await closeDrive(closed, deps())).toEqual({ dropped: 'no_movement', clientTripId: ID });
    expect(await createTripsRepo(db).count()).toBe(0);
    await createTripsRepo(db).insert({ client_trip_id: ID, started_at: T0, tz: TZ, status: 'pending' }, T0);
    expect(await dropTrip(db, ID)).toBe(false);
    expect((await createTripsRepo(db).get(ID))!.status).toBe('pending');
    // closeDrive hands the stored drive back rather than deleting it.
    const back = await closeDrive(closed, deps());
    expect(isDropped(back)).toBe(false);
  });
});

test.each([
  ['a manual end at the tap', 'manual', false, 'manual'],
  ['a manual end cut after standing still', 'manual', true, 'manual_still'],
  ['the automatic end', 'stopped', true, 'stopped'],
  ['a walking end', 'walking', true, 'walking'],
  ['the 12 h end', 'limit', true, 'limit'],
  ['an orphan', 'orphan', true, 'orphan'],
] as const)('%s stores end_cause %s/%s as %s (local only: never in the payload)', async (_label, cause, cut, stored) => {
  const session = { ...closedSession(60), endCause: cause, cut };
  const result = await finalizeTrip(session, deps());
  expect(result.trip.end_cause).toBe(stored);
  // (origin is how the drive started, not how it ended; limitS is a counter.)
  expect(JSON.stringify({ ...result.payload, origin: null, exposure: null })).not.toContain(stored);
});

test('a drive under 0.5 mi is scored once it lasts 2 min (and too short under both)', async () => {
  // 150 rows at 5 m/s: 0.47 mi in 150 s.
  const long = closedSession(150, [], { speedMps: 5 });
  const scored = await finalizeTrip(long, deps());
  expect(scored.trip.miles).toBeLessThan(0.5);
  expect(scored.drive).toMatchObject({ scored: true, reason: null });
  expect(scored.trip.reason).toBeNull();
  const short = closedSession(110, [], { speedMps: 5, clientTripId: uuid(8) });
  expect((await finalizeTrip(short, deps())).drive).toMatchObject({ scored: false, reason: 'too_short' });
});
