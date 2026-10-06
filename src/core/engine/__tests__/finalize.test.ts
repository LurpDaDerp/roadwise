/** @jest-environment node */
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { brakeEvent, closedSession, speedingEvent, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import { finalizeTrip, INVALID_PAYLOAD_SYNC_ERROR, normaliseZone, sanitizeEvent } from '@/core/engine/finalize';
import { PRIVACY_ZONES_KEY } from '@/core/engine/privacy';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { FinalizeTripPayloadV3Schema } from '@/data/sync/payload';
import { findFinalize } from '@/data/sync/queue';
import { decodePolyline } from '@/lib/polyline';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const deps = (over: Partial<Parameters<typeof finalizeTrip>[1]> = {}) => ({
  db,
  tz: TZ,
  now: () => T0 + 1_000_000,
  appVersion: '3.0.0',
  geocode: null,
  trimSeed: async (id: string) => `${id}-seed`.padEnd(64, '0'),
  ...over,
});

test('a 20-minute drive is stored as pending with the estimate, its trimmed route, labels and one queued v3 payload', async () => {
  // 1200 rows × 15 m = 18 km ≈ 11.2 mi; one speeding and one brake after the warm-up.
  const session = closedSession(1200, [speedingEvent(T0 + 300_000), brakeEvent(T0 + 600_000)], { unsafeRows: (i) => i >= 300 && i < 320 });
  await createSettingsRepo(db).set(PRIVACY_ZONES_KEY, [{ id: 'h', name: 'Home', lat: 47.6062, lng: -122.3321, radiusM: 300 }]);
  const geocoded: string[] = [];
  const result = await finalizeTrip(session, deps({ geocode: async (p) => (geocoded.push(`${p.lat},${p.lng}`), 'Capitol Hill'), context: async () => ({ streak: 10 }) }));

  expect(result.trip).toMatchObject({ status: 'pending', estimate: 1, tz: TZ, local_day: '2023-11-14', from_label: 'Home', to_label: 'Capitol Hill', sync_error: null });
  expect(geocoded).toHaveLength(1); // the start was inside a zone: no geocode there
  expect(result.trip.miles).toBeCloseTo(11.18, 1);
  expect(result.trip.safe_miles).toBeLessThan(result.trip.miles);
  expect(result.trip.night_miles).toBe(0); // 14:13 local: daylight
  expect(result.trip.duration_s).toBe(1200);
  expect(result.breakdown.scored).toBe(true);
  expect(result.breakdown.streakMult).toBe(1.2);
  expect(result.trip.points_net).toBe(result.breakdown.net);
  expect(result.trip.clean).toBe(0);
  expect(JSON.parse(result.trip.counts_json!)).toMatchObject({ speeding: 1, hardBrake: 1 });
  expect(result.events).toHaveLength(2);
  expect(result.events[0]).toMatchObject({ id: uuid(1), type: 'speeding', penalty: 15 });
  expect(result.events[1]!.lat).not.toBeNull();

  const payload = result.payload!;
  expect(FinalizeTripPayloadV3Schema.safeParse(payload).success).toBe(true);
  expect(payload).toMatchObject({ v: 3, clientTripId: session.clientTripId, startedAt: T0, endedAt: T0 + 1_200_000, tz: TZ, localDay: '2023-11-14', dmsOn: false, appVersion: '3.0.0' });
  expect(payload.start).toEqual({ lat: 47.6062, lng: -122.3321 });
  expect(payload.integrity).toMatchObject({ mockLocation: false, motionMismatch: false, validGnssPct: 100 });
  expect(payload.integrity.maxSpeedMph).toBeCloseTo(33.55, 1);
  // The route never shows the first/last 0.25 mi nor the zone around the start.
  const shown = decodePolyline(payload.polyline);
  expect(shown.length).toBeGreaterThan(2);
  expect(Math.min(...shown.map((p) => p.lng))).toBeGreaterThan(-122.3321 + 402 / 75_000);
  // The trim plan never leaves the phone.
  expect(JSON.stringify(payload)).not.toMatch(/startM|zoneRadiiM|plan/);
  expect(await findFinalize(db, session.clientTripId)).toEqual(payload);
  expect(await createSamplesRepo(db).count(session.clientTripId)).toBe(0);
  const item = await createQueueRepo(db).byKey(`trip:${session.clientTripId}`);
  expect(item?.owner_uid).toBe('user-1');
});

test('a short drive is stored unscored-as-estimate (too_short) and still uploaded; mock rows mark the integrity', async () => {
  const session = closedSession(40, [], { mockEvery: 10 });
  const result = await finalizeTrip(session, deps());
  expect(result.breakdown).toMatchObject({ scored: false, reason: 'too_short' });
  expect(result.trip).toMatchObject({ status: 'pending', points_net: null, clean: null, reason: 'too_short' });
  expect(result.payload?.integrity.mockLocation).toBe(true);
  expect(JSON.parse(result.trip.integrity_json!).mockLocation).toBe(true);
});

test('the estimate credits safe miles after today’s earlier drives (daily cap)', async () => {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: uuid(9), started_at: T0 - 3_600_000, tz: TZ, local_day: '2023-11-14', status: 'scored', safe_miles: 38 }, T0);
  const session = closedSession(1200);
  const result = await finalizeTrip(session, deps());
  // 38 mi already today: 2 at full rate, the rest at half.
  expect(result.breakdown.creditedMiles).toBeCloseTo(2 + (result.breakdown.safeMiles - 2) / 2, 2);
});

test('a motion mismatch (GPS moving, IMU flat) is flagged', async () => {
  const session = closedSession(300, [], { over: () => ({ aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0 }) });
  const result = await finalizeTrip(session, deps());
  expect(result.payload?.integrity.motionMismatch).toBe(true);
});

test('a second call for the same drive returns what is stored and queues nothing new', async () => {
  const session = closedSession(200);
  const first = await finalizeTrip(session, deps());
  const again = await finalizeTrip(session, deps());
  expect(again.trip.updated_at).toBe(first.trip.updated_at);
  expect(again.payload).toBeNull();
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

test('sanitizeEvent clamps and rounds what a detector emitted', () => {
  const e = sanitizeEvent({ id: 'x', type: 'phone_handling', tier: 'moderate', startedAt: T0 - 5, durationS: Number.NaN, units: 0, measured: { speedMph: 1.23456, peakG: Number.POSITIVE_INFINITY } }, T0, T0 + 60_000);
  expect(e).toEqual({ id: 'x', type: 'phone_handling', tier: 'moderate', startedAt: T0, durationS: 0, units: 1, measured: { speedMph: 1.235 } });
});

test('normaliseZone', () => {
  expect(normaliseZone('America/New_York')).toBe('America/New_York');
  expect(normaliseZone('GMT+5')).toBe('Etc/GMT-5');
  expect(normaliseZone('UTC-3')).toBe('Etc/GMT+3');
  expect(normaliseZone('GMT+05:30')).toBe('UTC');
  expect(normaliseZone('')).toBe('UTC');
  expect(normaliseZone('Not/AZone')).toBe('UTC');
});
