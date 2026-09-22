/** @jest-environment node */
import * as scoring from '@scoring';
import type { AlertDecision } from '@/core/alerts/types';
import { NO_LIMIT, T0, limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { StartEvidence, TripRole, TripSession } from '@/core/engine/engine.types';
import {
  finalizeTrip,
  POLYLINE_EPSILON_M,
  simplifyTrack,
  TRIM_ENDPOINTS_M,
  tracePathFor,
  type FinalizeDeps,
} from '@/core/engine/finalize';
import { isHabitualDriverRoute, readRolePrior, recordRoleAnswer } from '@/core/engine/rolePrior';
import { appendRow, closeSession, createSession } from '@/core/engine/session';
import type { DetectedEvent, FeatureRow } from '@/core/engine/types';
import {
  createEventsRepo,
  createQueueRepo,
  createSamplesRepo,
  createTripsRepo,
  migrate,
  type Db,
  type TripStatus,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { FinalizeTripPayloadSchema, MAX_EVENTS, MAX_POLYLINE_BYTES } from '@/data/sync/payload';
import { geohash5, haversineMeters, roundCoord, type LatLng } from '@/lib/geo';
import { decodePolyline, encodePolyline, simplify } from '@/lib/polyline';

const TRIP = '123e4567-e89b-42d3-a456-426614174000';
const TZ = 'America/Los_Angeles';
/** Wall clock at finalize, for the row stamps. */
const NOW = T0 + 2_000_000;
const L35 = limit(mph(35));

const SF = { lat: 37.7749, lng: -122.4194 };
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((SF.lat * Math.PI) / 180);
const SPEED = 10;

/**
 * `n` rows at 1 Hz from San Francisco: east at `speed` for the first half, then north. Every
 * 50th row loses its fix; every row carries a little IMU noise so the IMU counts as present.
 */
function track(n: number, t0 = T0, speed = SPEED): FeatureRow[] {
  const half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) =>
    row({
      ts: t0 + i * 1000,
      lat: SF.lat + (Math.max(0, i - half) * speed) / M_PER_DEG_LAT,
      lng: SF.lng + (Math.min(i, half) * speed) / M_PER_DEG_LNG,
      speed,
      course: i <= half ? 90 : 0,
      gnssValid: i % 50 !== 25,
      aLonMax: 0.02,
      aLonMin: -0.02,
    })
  );
}

interface SessionOpts {
  role?: TripRole;
  events?: DetectedEvent[];
  alerts?: AlertDecision[];
  startedAt?: number;
  endedAt?: number;
  /** Default `tap`, the parked Start tap the worked example was recorded with. */
  evidence?: StartEvidence;
}

/** The closed session the engine hands over: accumulators over every row, the ring holding the tail. */
function session(rows: FeatureRow[], opts: SessionOpts = {}): Readonly<TripSession> {
  const startedAt = opts.startedAt ?? rows[0]?.ts ?? T0;
  const s = createSession({
    clientTripId: TRIP,
    mode: 'mounted',
    role: opts.role ?? 'driver',
    startSource: (opts.evidence ?? 'tap') === 'auto' ? 'auto' : 'manual',
    startEvidence: opts.evidence ?? 'tap',
    startedAt,
  });
  // Every tenth row has no known limit, for limit_coverage_pct.
  rows.forEach((r, i) => appendRow(s, r, i % 10 === 9 ? NO_LIMIT : L35));
  s.events = opts.events ?? [];
  s.alerts = opts.alerts ?? [];
  const last = rows[rows.length - 1];
  return closeSession(s, opts.endedAt ?? (last ? last.ts + 1000 : startedAt + 5000));
}

type EventSeed = Partial<DetectedEvent> &
  Pick<DetectedEvent, 'id' | 'category' | 'startedAt' | 'durationS' | 'q' | 'measured'>;
const ev = (p: EventSeed): DetectedEvent => ({
  corrected: false,
  status: 'scored',
  context: { night: false, precipitation: false },
  alertable: true,
  source: 'gnss',
  ...p,
});

// The §9.4 worked example (packages/scoring golden test), placed inside the trip.
const p1 = ev({ id: 'p1', category: 'phone', startedAt: T0 + 300_000, durationS: 12, q: 0.9, measured: { speedMps: mph(35) }, source: 'os' });
const s1 = ev({ id: 's1', category: 'speeding', startedAt: T0 + 600_000, durationS: 45, q: 0.85, measured: { overMps: mph(12), limitMps: mph(35) }, context: { night: false, precipitation: true } });
const b1 = ev({ id: 'b1', category: 'braking', startedAt: T0 + 900_000, durationS: 1, q: 0.8, measured: { peakG: 0.42 }, source: 'both' });
/** A possible (unscored) brake 50 m into the trip: costs nothing, and sits inside the trimmed start. */
const x1 = ev({ id: 'x1', category: 'braking', startedAt: T0 + 5_000, durationS: 1, q: 0.4, status: 'possible', alertable: false, measured: { peakG: 0.31 }, source: 'both' });
const WORKED = [p1, s1, b1, x1];
const speedingAlert: AlertDecision = { id: 'a1', level: 1, kind: 'speeding', eventId: 's1', ts: T0 + 605_000 };

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

let db: Db;
let files: Map<string, Uint8Array>;
let deps: FinalizeDeps;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  files = new Map();
  deps = {
    db,
    scoring,
    tz: TZ,
    fs: {
      writeGzip: async (path, bytes) => {
        files.set(path, bytes);
      },
    },
    hash: { sha256 },
    now: () => NOW,
  };
});

/** What the recorder leaves behind: the trip row and the rows up to the last checkpoint. */
async function persisted(rows: FeatureRow[], upTo: number, status: TripStatus = 'recording') {
  await createTripsRepo(db).insert(
    { client_trip_id: TRIP, started_at: rows[0]?.ts ?? T0, tz: TZ, status, checkpoint_ts: rows[upTo - 1]?.ts ?? null },
    T0
  );
  await createSamplesRepo(db).appendMany(TRIP, rows.slice(0, upTo).map((r) => ({ ts: r.ts, row: r })));
}

const traceText = () => new TextDecoder().decode(files.get(tracePathFor(TRIP)));

describe('the worked example (spec §9.4): 22 minutes, 13.2 km, the three golden events', () => {
  const N = 1320;
  let rows: FeatureRow[];
  let s: Readonly<TripSession>;

  beforeEach(async () => {
    rows = track(N);
    // The last checkpoint covered row 1289; rows 1290..1319 are only in the ring.
    await persisted(rows, 1290);
    s = session(rows, { events: WORKED, alerts: [speedingAlert] });
  });

  test('scores 74 provisionally and stores the trip as provisional and queued', async () => {
    const { trip, scored } = await finalizeTrip(s, deps);

    expect(scored).toMatchObject({ score: 74, status: 'final', dataQuality: 'A' });
    expect(scored.exposure).toBeCloseTo(1.1, 6);

    expect(trip).toMatchObject({
      client_trip_id: TRIP,
      status: 'provisional',
      sync_state: 'queued',
      score: 74,
      scoring_version: '1',
      data_quality: 'A',
      tz: TZ,
      role: 'driver',
      role_confidence: 0.95,
      role_source: 'manual',
      mode: 'mounted',
      camera_session: 0,
      started_at: T0,
      ended_at: T0 + N * 1000,
      duration_s: N,
      limit_coverage_pct: 90,
      start_geohash5: geohash5(SF.lat, SF.lng),
      end_geohash5: geohash5(rows[N - 1]!.lat, rows[N - 1]!.lng),
      start_label: null,
      end_label: null,
      checkpoint_ts: rows[N - 1]!.ts,
      incomplete: 0,
      created_at: T0,
      updated_at: NOW,
    });
    // 1320 rows make 1319 ten-metre segments.
    expect(trip.distance_m).toBeCloseTo((N - 1) * SPEED, -1);
    expect(trip.exposure).toBeCloseTo(1.1, 6);
    const deductions = JSON.parse(trip.category_deductions_json ?? 'null');
    expect(deductions.phone).toBeCloseTo(14.545, 2);
    expect(deductions.speeding).toBeCloseTo(6.818, 2);
    expect(deductions.braking).toBeCloseTo(4.773, 2);
    expect(JSON.parse(trip.conditions_json ?? 'null')).toEqual({
      night: false,
      precipitation: false,
      hadSevereEvent: false,
    });
    await expect(createTripsRepo(db).list()).resolves.toHaveLength(1);
  });

  test('stores the events with deductions, alert flags, severity and trimmed 3 dp coordinates', async () => {
    const { events } = await finalizeTrip(s, deps);

    expect(events.map((e) => e.id)).toEqual(['x1', 'p1', 's1', 'b1']);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));

    expect(byId.p1).toMatchObject({
      client_trip_id: TRIP,
      category: 'phone',
      started_at: T0 + 300_000,
      duration_s: 12,
      confidence: 0.9,
      severity: '1',
      alert_shown: 0,
      corrected: 0,
      status: 'scored',
      source: 'os',
      lat: roundCoord(rows[300]!.lat),
      lng: roundCoord(rows[300]!.lng),
    });
    expect(byId.p1).toMatchObject({ lat: 37.775, lng: -122.385 });
    expect(byId.p1!.deduction).toBeCloseTo(14.545, 2);
    expect(JSON.parse(byId.p1!.measured_json ?? 'null')).toEqual({ speedMps: mph(35) });
    expect(JSON.parse(byId.p1!.context_json ?? 'null')).toEqual({ night: false, precipitation: false });

    expect(byId.s1).toMatchObject({ severity: '2', alert_shown: 1, source: 'gnss' });
    expect(byId.s1!.deduction).toBeCloseTo(6.818, 2);
    expect(JSON.parse(byId.s1!.context_json ?? 'null')).toEqual({ night: false, precipitation: true });

    expect(byId.b1).toMatchObject({
      severity: '1.75',
      lat: roundCoord(rows[900]!.lat),
      lng: roundCoord(rows[900]!.lng),
    });
    expect(byId.b1!.deduction).toBeCloseTo(4.773, 2);

    // Inside the trimmed 200 m at the start: no coordinates. Possible, so no deduction.
    expect(byId.x1).toMatchObject({ status: 'possible', lat: null, lng: null, deduction: 0, severity: '1' });

    await expect(createEventsRepo(db).countByTrip(TRIP)).resolves.toBe(4);
  });

  test('builds the upload payload, validates it and queues it once under trip:<id>', async () => {
    const { payload, scored } = await finalizeTrip(s, deps);

    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      clientTripId: TRIP,
      startedAt: T0,
      endedAt: T0 + N * 1000,
      tz: TZ,
      durationS: N,
      role: 'driver',
      roleConfidence: 0.95,
      roleSource: 'manual',
      mode: 'mounted',
      cameraSession: false,
      provisional: scored,
      startGeohash5: geohash5(SF.lat, SF.lng),
      endGeohash5: geohash5(rows[N - 1]!.lat, rows[N - 1]!.lng),
      tracePath: `${TRIP}.bin.gz`,
      hadSevereEvent: false,
    });
    expect(payload.distanceM).toBeCloseTo((N - 1) * SPEED, -1);

    expect(payload.events.map((e) => e.id)).toEqual(['x1', 'p1', 's1', 'b1']);
    expect(payload.events[1]).toMatchObject({
      id: 'p1',
      durationS: 12,
      durationMs: 12_000,
      severity: 1,
      contextMultiplier: 1,
      lat: 37.775,
      lng: -122.385,
      alertShown: false,
      source: 'os',
      measured: { speedMps: mph(35) },
      context: { night: false, precipitation: false },
    });
    expect(payload.events[1]!.deduction).toBeCloseTo(14.545, 2);
    expect(payload.events[2]).toMatchObject({ id: 's1', severity: 2, contextMultiplier: 1.25, alertShown: true });
    expect(payload.events[0]).toMatchObject({ id: 'x1', status: 'possible', lat: null, lng: null, deduction: 0 });

    const queue = createQueueRepo(db);
    await expect(queue.countByStatus('pending')).resolves.toBe(1);
    const [item] = await queue.nextDue(NOW);
    expect(item).toMatchObject({ kind: 'finalize-trip', idempotency_key: `trip:${TRIP}`, created_at: NOW });
    expect(JSON.parse(item!.payload_json)).toEqual(payload);
  });

  test('makes the ring tail durable, writes the trace, digests it and purges the samples', async () => {
    const samples = createSamplesRepo(db);
    await expect(samples.count(TRIP)).resolves.toBe(1290);

    const { payload } = await finalizeTrip(s, deps);

    const text = traceText();
    const trace = JSON.parse(text) as FeatureRow[];
    expect(trace).toHaveLength(N);
    expect(trace[0]).toEqual(rows[0]);
    // Row 1319 was only ever in the ring.
    expect(trace[N - 1]).toEqual(rows[N - 1]);
    // Canonical: keys sorted, so the digest does not depend on how the native module ordered them.
    expect(Object.keys(trace[0]!)).toEqual([...Object.keys(trace[0]!)].sort());

    expect(payload.rowsDigest).toEqual({
      count: N,
      validGnssPct: expect.closeTo(98.03, 1),
      imuPresent: true,
      maxSustainedSpeedMps: expect.closeTo(SPEED, 6),
      sha256: await sha256(text),
    });
    expect(files.size).toBe(1);
    await expect(samples.count(TRIP)).resolves.toBe(0);
  });

  test('the polyline is simplified, endpoint-trimmed, decodable and stored on the trip', async () => {
    const { trip, payload } = await finalizeTrip(s, deps);

    expect(trip.polyline).toBe(payload.polyline);
    const pts = decodePolyline(payload.polyline);
    // Two straight legs: the first kept row, the corner, the last kept row — plus the one chunk
    // boundary the ~1280-point track crosses (simplification runs per 1000 points).
    expect(pts).toHaveLength(4);

    const first = rows[0]!;
    const last = rows[N - 1]!;
    const startGap = haversineMeters(pts[0]!, first);
    const endGap = haversineMeters(pts[pts.length - 1]!, last);
    expect(startGap).toBeGreaterThan(TRIM_ENDPOINTS_M - 2);
    expect(startGap).toBeLessThan(TRIM_ENDPOINTS_M + 2 * SPEED + 2);
    expect(endGap).toBeGreaterThan(TRIM_ENDPOINTS_M - 2);
    expect(endGap).toBeLessThan(TRIM_ENDPOINTS_M + 2 * SPEED + 2);
    expect(haversineMeters(pts[1]!, rows[660]!)).toBeLessThan(POLYLINE_EPSILON_M);
    // The boundary vertex lies on the north leg, so it adds no error to the drawn path.
    expect(pts[2]!.lng).toBeCloseTo(pts[3]!.lng, 5);
  });

  test('is idempotent: a second call returns the stored result and queues nothing more', async () => {
    const first = await finalizeTrip(s, deps);
    const again = await finalizeTrip(s, deps);

    expect(again.payload).toEqual(first.payload);
    expect(again.scored).toEqual(first.scored);
    expect(again.trip).toEqual(first.trip);
    expect(again.events).toEqual(first.events);
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
    await expect(createEventsRepo(db).countByTrip(TRIP)).resolves.toBe(4);
    expect(files.size).toBe(1);
  });

  test('a finalize cut off after the trip row flipped but before the queue row is redone from the samples', async () => {
    // Undo the recorder state and rebuild it as the interrupted run would have left it.
    await createTripsRepo(db).remove(TRIP);
    await persisted(rows, 1290, 'provisional');

    const { trip, scored } = await finalizeTrip(s, deps);

    expect(scored.score).toBe(74);
    expect(trip).toMatchObject({ status: 'provisional', sync_state: 'queued', score: 74 });
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(0);
  });
});

describe('other outcomes', () => {
  test('a passenger trip is stored unscored, with its events but no deductions, and still queues', async () => {
    const rows = track(1320);
    await persisted(rows, 1320);
    const { trip, events, scored, payload } = await finalizeTrip(
      session(rows, { role: 'passenger', events: WORKED }),
      deps
    );

    expect(scored).toMatchObject({ status: 'unscored', reason: 'passenger', score: null });
    expect(trip).toMatchObject({ status: 'unscored', sync_state: 'queued', score: null, role: 'passenger' });
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.deduction === null)).toBe(true);
    expect(payload.provisional).toEqual(scored);
    expect(payload.events.every((e) => e.deduction === null)).toBe(true);
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(0);
    expect(files.has(tracePathFor(TRIP))).toBe(true);
  });

  test('a manual trip with no rows and no trip row yet is created, unscored as too short, and queued', async () => {
    const { trip, events, scored, payload } = await finalizeTrip(
      session([], { startedAt: T0, endedAt: T0 + 5000 }),
      deps
    );

    expect(scored).toMatchObject({ status: 'unscored', reason: 'too_short', score: null });
    expect(trip).toMatchObject({
      client_trip_id: TRIP,
      status: 'unscored',
      sync_state: 'queued',
      started_at: T0,
      ended_at: T0 + 5000,
      duration_s: 5,
      distance_m: 0,
      limit_coverage_pct: 0,
      polyline: null,
      start_geohash5: null,
      end_geohash5: null,
      checkpoint_ts: null,
      created_at: NOW,
    });
    expect(events).toEqual([]);
    expect(payload).toMatchObject({
      polyline: '',
      startGeohash5: null,
      endGeohash5: null,
      tracePath: `${TRIP}.bin.gz`,
      rowsDigest: {
        count: 0,
        validGnssPct: 0,
        imuPresent: false,
        maxSustainedSpeedMps: 0,
        sha256: await sha256('[]'),
      },
    });
    expect(traceText()).toBe('[]');
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
  });

  test('a short trip the recorder never checkpointed gets its trip row and its rows from the ring', async () => {
    const rows = track(100);
    const { trip, payload } = await finalizeTrip(session(rows), deps);

    expect(trip).toMatchObject({ status: 'unscored', sync_state: 'queued', checkpoint_ts: rows[99]!.ts });
    expect(payload.rowsDigest.count).toBe(100);
    expect(JSON.parse(traceText())).toHaveLength(100);
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(0);
  });

  test('an implausibly fast trip is discarded: stored as synced, nothing queued, no trace written', async () => {
    const rows = track(300, T0, 50);
    await persisted(rows, 300);
    const { trip, scored, payload, events } = await finalizeTrip(session(rows), deps);

    expect(scored).toMatchObject({ status: 'discarded', reason: 'implausible_speed', score: null });
    // Kept locally so the trip is not re-detected, but there is nothing to upload (§4.4).
    expect(trip).toMatchObject({
      status: 'discarded',
      sync_state: 'synced',
      server_id: null,
      checkpoint_ts: rows[299]!.ts,
    });
    expect(events).toEqual([]);
    expect(payload).toMatchObject({ provisional: scored, tracePath: null });
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
    expect(files.size).toBe(0);
    const queue = createQueueRepo(db);
    await expect(queue.countByStatus('pending')).resolves.toBe(0);
    await expect(queue.byKey(`trip:${TRIP}`)).resolves.toBeNull();
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(0);
    // Settled: like a synced trip with no queue item, it is never re-run.
    await expect(finalizeTrip(session(rows), deps)).rejects.toThrow(/already discarded\/synced/);
    expect(files.size).toBe(0);
  });

  test('fractional row timestamps finalize cleanly: the trip stamps are whole milliseconds', async () => {
    // A native clock reporting `Date().timeIntervalSince1970 * 1000` is not integral.
    const rows = track(300).map((r) => ({ ...r, ts: r.ts + 0.25 }));
    await persisted(rows, 300);
    const { trip, payload } = await finalizeTrip(session(rows), deps);

    expect(payload).toMatchObject({ startedAt: T0, endedAt: T0 + 300_000 });
    expect(trip).toMatchObject({ started_at: T0, ended_at: T0 + 300_000 });
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload.rowsDigest.count).toBe(300);
  });

  test('when checkpoints were lost, the metrics describe what the trace holds, not what the engine saw', async () => {
    const rows = track(1320);
    // Rows 600..1199 never reached SQLite; 1200..1319 are still in the ring.
    await persisted(rows, 600);
    const s = session(rows, { events: WORKED });
    expect(s.distanceM).toBeCloseTo(1319 * SPEED, -1);

    const { payload } = await finalizeTrip(s, deps);

    expect(payload.rowsDigest.count).toBe(720);
    expect(JSON.parse(traceText())).toHaveLength(720);
    // 599 segments east, one straight jump across the hole, 119 north: about 12.6 km.
    expect(payload.distanceM).toBeGreaterThan(12_000);
    expect(payload.distanceM).toBeLessThan(13_000);
    // Time is the trip's time regardless.
    expect(payload.durationS).toBe(1320);
  });

  test('the digest is canonical: rows stored with another key order digest the same', async () => {
    const rows = track(200);
    const reversed = rows.map((r) => Object.fromEntries(Object.entries(r).reverse()));
    await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: TZ, status: 'recording' }, T0);
    await createSamplesRepo(db).appendMany(TRIP, reversed.map((r, i) => ({ ts: rows[i]!.ts, row: r })));

    const { payload } = await finalizeTrip(session(rows), deps);

    const text = traceText();
    expect(JSON.parse(text)).toEqual(rows);
    expect(Object.keys((JSON.parse(text) as FeatureRow[])[0]!)).toEqual(Object.keys(rows[0]!).sort());
    expect(payload.rowsDigest.sha256).toBe(await sha256(text));
  });

  describe('hadSevereEvent', () => {
    const setup = async (events: DetectedEvent[], alerts: AlertDecision[] = []) => {
      const rows = track(1320);
      await persisted(rows, 1320);
      const { trip, payload } = await finalizeTrip(session(rows, { events, alerts }), deps);
      return { trip, payload, conditions: JSON.parse(trip.conditions_json ?? 'null') };
    };

    test('is set by an L3 alert', async () => {
      const l3: AlertDecision = { id: 'a3', level: 3, kind: 'speeding', eventId: 's1', ts: T0 + 610_000 };
      const { payload, conditions } = await setup(WORKED, [l3]);
      expect(payload.hadSevereEvent).toBe(true);
      expect(conditions.hadSevereEvent).toBe(true);
      expect(payload.provisional.score).toBe(74);
    });

    test('is set by a scored speeding event at or beyond SEVERE_SPEEDING_OVER_MPS', async () => {
      const severe = { ...s1, measured: { overMps: scoring.CONSTANTS.SEVERE_SPEEDING_OVER_MPS, limitMps: mph(35) } };
      const { payload, conditions } = await setup([p1, severe, b1]);
      expect(payload.hadSevereEvent).toBe(true);
      expect(conditions.hadSevereEvent).toBe(true);
    });

    test('is not set by a possible speeding event, however fast, nor by L1/L2 alerts', async () => {
      const possible = { ...s1, status: 'possible' as const, measured: { overMps: mph(30), limitMps: mph(35) } };
      const l2: AlertDecision = { id: 'a2', level: 2, kind: 'phone', eventId: 'p1', ts: T0 + 305_000 };
      const { payload, conditions } = await setup([p1, possible, b1], [speedingAlert, l2]);
      expect(payload.hadSevereEvent).toBe(false);
      expect(conditions.hadSevereEvent).toBe(false);
    });
  });

  describe('night', () => {
    test('a drive starting at 04:13 local is night by the clock rule', async () => {
      const t0 = T0 - 10 * 3_600_000; // 12:13 UTC = 04:13 in Los Angeles
      const rows = track(300, t0);
      await persisted(rows, 300);
      const { trip } = await finalizeTrip(session(rows), deps);
      expect(JSON.parse(trip.conditions_json ?? 'null').night).toBe(true);
    });

    test('the clock rule alone decides: 20:00 local in November is dark, and is not night', async () => {
      const t0 = Date.UTC(2023, 10, 15, 4, 0); // 20:00 the evening before in Los Angeles
      const rows = track(300, t0);
      await persisted(rows, 300);
      const { trip } = await finalizeTrip(session(rows), deps);
      expect(JSON.parse(trip.conditions_json ?? 'null').night).toBe(false);
    });

    test('the clock rule runs in the trip time zone, not the device zone', async () => {
      const at = Date.UTC(2023, 10, 14, 14, 30); // 23:30 in Tokyo, 14:30 in London
      const tokyo = await finalizeTrip(session([], { startedAt: at, endedAt: at + 5000 }), { ...deps, tz: 'Asia/Tokyo' });
      expect(JSON.parse(tokyo.trip.conditions_json ?? 'null').night).toBe(true);

      await createTripsRepo(db).remove(TRIP);
      await db.execute('DELETE FROM sync_queue');
      const london = await finalizeTrip(session([], { startedAt: at, endedAt: at + 5000 }), { ...deps, tz: 'Europe/London' });
      expect(JSON.parse(london.trip.conditions_json ?? 'null').night).toBe(false);
    });
  });

  describe('event merging safety net (ruling: drowsiness never merges with phone)', () => {
    const phone = ev({ id: 'p', category: 'phone', startedAt: T0 + 300_000, durationS: 12, q: 0.9, measured: { speedMps: 15 }, source: 'imu' });
    const focusAt305 = (focusKind: 'glance' | 'drowsiness') =>
      ev({ id: 'f', category: 'focus', startedAt: T0 + 305_000, durationS: 5, q: 0.9, measured: { glanceS: 5, focusKind }, source: 'camera' });

    test('an overlapping drowsiness episode stays its own event', async () => {
      const rows = track(1320);
      await persisted(rows, 1320);
      const { events } = await finalizeTrip(session(rows, { events: [phone, focusAt305('drowsiness')] }), deps);
      expect(events.map((e) => e.id)).toEqual(['p', 'f']);
    });

    test('an overlapping glance is folded into the phone event, and an alert on it counts as shown', async () => {
      const rows = track(1320);
      await persisted(rows, 1320);
      const phoneAlert: AlertDecision = { id: 'a1', level: 2, kind: 'phone', eventId: 'f', ts: T0 + 306_000 };
      const { events, payload } = await finalizeTrip(
        session(rows, { events: [phone, focusAt305('glance')], alerts: [phoneAlert] }),
        deps
      );
      expect(events.map((e) => e.id)).toEqual(['p']);
      expect(events[0]).toMatchObject({ duration_s: 12, alert_shown: 1, source: 'both' });
      expect(payload.events[0]).toMatchObject({ id: 'p', alertShown: true, measured: { speedMps: 15, glanceS: 5, focusKind: 'glance' } });
    });
  });

  test('the incomplete flag comes from the deps: off by default, on the row and in the payload when set', async () => {
    const rows = track(200);
    const normal = await finalizeTrip(session(rows), deps);
    expect(normal.trip.incomplete).toBe(0);
    expect(normal.payload.incomplete).toBe(false);

    await db.execute('DELETE FROM sync_queue');
    await db.execute('DELETE FROM trips');
    const recovered = await finalizeTrip(session(rows), { ...deps, incomplete: true });
    expect(recovered.trip.incomplete).toBe(1);
    expect(recovered.payload.incomplete).toBe(true);
    expect(FinalizeTripPayloadSchema.parse(recovered.payload)).toEqual(recovered.payload);
  });

  test('a fractional last row ts is rounded before it becomes checkpoint_ts', async () => {
    const rows = track(200).map((r, i) => (i === 199 ? { ...r, ts: r.ts + 0.4 } : r));
    const { trip } = await finalizeTrip(session(rows), deps);
    expect(trip.checkpoint_ts).toBe(rows[198]!.ts + 1000);
    expect(Number.isInteger(trip.checkpoint_ts)).toBe(true);
  });

  test('the camera flag comes from the host', async () => {
    const rows = track(300);
    await persisted(rows, 300);
    const { trip, payload } = await finalizeTrip(session(rows), { ...deps, cameraSession: true });
    expect(trip.camera_session).toBe(1);
    expect(payload.cameraSession).toBe(true);
  });

  test('non-finite numbers never reach the payload: grade C path, bad fixes dropped', async () => {
    const rows = track(300);
    // The very first fix is the one the jump rule cannot catch (nothing to jump from).
    rows[0] = { ...rows[0]!, lat: Number.NaN };
    rows[150] = { ...rows[150]!, lat: Number.NaN, lng: Number.NaN };
    rows[299] = { ...rows[299]!, lat: Number.POSITIVE_INFINITY };
    await persisted(rows, 300);
    const s: Readonly<TripSession> = { ...session(rows), durationS: Number.NaN };

    const { trip, scored, payload } = await finalizeTrip(s, deps);

    expect(scored).toMatchObject({ status: 'unscored', reason: 'grade_c', dataQuality: 'C' });
    expect(trip).toMatchObject({ status: 'unscored', duration_s: 0 });
    expect(payload.durationS).toBe(0);
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload.startGeohash5).toBe(geohash5(rows[1]!.lat, rows[1]!.lng));
    expect(payload.endGeohash5).toBe(geohash5(rows[298]!.lat, rows[298]!.lng));
    const pts = decodePolyline(payload.polyline);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
    expect(pts.every((p) => haversineMeters(p, SF) < 5000)).toBe(true);
  });
});

describe('who was driving (spec §9.7, R11, rev1 C1)', () => {
  const N = 1320;
  /**
   * Rows `[from, from + count)` of the track held and used: screen on, unlocked, handling, with a
   * fix (the track's every-50th dropout would split the run: a row of unknown speed is not proven
   * moving).
   */
  const withHandling = (rows: FeatureRow[], runs: readonly (readonly [from: number, count: number])[]) =>
    rows.map((r, i) =>
      runs.some(([from, count]) => i >= from && i < from + count)
        ? { ...r, handlingScore: 0.8, screenOn: true, locked: false, gnssValid: true }
        : r
    );
  const phoneAt = (id: string, fromRow: number, seconds: number): DetectedEvent =>
    ev({ id, category: 'phone', startedAt: T0 + fromRow * 1000, durationS: seconds, q: 0.9, measured: { speedMps: SPEED }, source: 'os' });

  async function finalizeWith(
    rows: FeatureRow[],
    opts: SessionOpts,
    extra: Partial<Pick<FinalizeDeps, 'rolePrior' | 'habitualRoute'>> = {}
  ) {
    await persisted(rows, rows.length);
    return finalizeTrip(session(rows, opts), { ...deps, ...extra });
  }

  test('(a) a manual trip containing a 4-minute phone episode stays driver and scored', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip, scored, payload } = await finalizeWith(rows, {
      evidence: 'tap',
      events: [phoneAt('p4', 300, 240)],
    });

    expect(scored.status).toBe('final');
    expect(scored.score).toEqual(expect.any(Number));
    expect(scored.categoryDeductions.phone).toBeGreaterThan(0);
    expect(trip).toMatchObject({ role: 'driver', role_confidence: 0.95, role_source: 'manual', status: 'provisional' });
    expect(payload).toMatchObject({ role: 'driver', roleConfidence: 0.95, roleSource: 'manual' });
  });

  test('a manual start ignores the prior and the route: a low prior still leaves it driver at 0.95', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip, scored } = await finalizeWith(rows, { evidence: 'tap' }, { rolePrior: 0.05, habitualRoute: true });
    expect(trip).toMatchObject({ role: 'driver', role_confidence: 0.95 });
    expect(scored.status).toBe('final');
  });

  test('a manual passenger start is a passenger trip', async () => {
    const { trip, payload } = await finalizeWith(track(N), { evidence: 'tap', role: 'passenger' });
    expect(trip).toMatchObject({ role: 'passenger', role_confidence: 0.02, status: 'unscored' });
    expect(payload).toMatchObject({ role: 'passenger', roleSource: 'manual', provisional: { reason: 'passenger' } });
  });

  test('(b) an auto trip with prior 0.9 and three separate 1-minute phone events stays driver', async () => {
    const rows = withHandling(track(N), [[200, 60], [500, 60], [800, 60]]);
    const { trip, scored, payload } = await finalizeWith(
      rows,
      { evidence: 'auto', events: [phoneAt('pa', 200, 60), phoneAt('pb', 500, 60), phoneAt('pc', 800, 60)] },
      { rolePrior: 0.9 }
    );

    expect(scored.status).toBe('final');
    expect(trip).toMatchObject({ role: 'driver', role_source: 'auto', status: 'provisional' });
    expect(trip.role_confidence).toBeCloseTo(0.9);
    expect(payload).toMatchObject({ role: 'driver', roleSource: 'auto' });
  });

  test('a high prior is high evidence: even one 4-minute run leaves the drive with the driver', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip } = await finalizeWith(rows, { evidence: 'auto' }, { rolePrior: 0.85 });
    expect(trip.role).toBe('driver');
    expect(trip.role_confidence).toBeCloseTo(0.85);
  });

  test('an auto trip with a neutral prior and no route history is unknown, role_unknown, and validates', async () => {
    const { trip, scored, payload } = await finalizeWith(track(N), { evidence: 'auto', events: WORKED });

    expect(scored).toMatchObject({ status: 'unscored', reason: 'role_unknown', score: null });
    expect(trip).toMatchObject({ role: 'unknown', role_confidence: 0.5, role_source: 'auto', status: 'unscored', sync_state: 'queued' });
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
    // finalize-trip accepts `unknown` only with an inferred source (B4: unknown_role_not_inferred).
    expect(payload).toMatchObject({ role: 'unknown', roleConfidence: 0.5, roleSource: 'auto' });
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
  });

  test('with no prior given the finalizer assumes neutral, not driver', async () => {
    const { trip } = await finalizeWith(track(N), { evidence: 'auto' });
    expect(trip).toMatchObject({ role: 'unknown', role_confidence: 0.5 });
  });

  test('the same trip on a route confirmed twice as driver is driver', async () => {
    const rows = track(N);
    const start = geohash5(rows[0]!.lat, rows[0]!.lng);
    const end = geohash5(rows[N - 1]!.lat, rows[N - 1]!.lng);
    await recordRoleAnswer(db, 'driver', { start, end });
    await recordRoleAnswer(db, 'driver', { start: end, end: start });

    // What the host does before calling finalize: the stored prior and the route's history.
    const rolePrior = await readRolePrior(db);
    const habitualRoute = await isHabitualDriverRoute(db, start, end);
    expect(rolePrior).toBeCloseTo(0.75);
    expect(habitualRoute).toBe(true);

    const { trip, scored, payload } = await finalizeWith(rows, { evidence: 'auto', events: WORKED }, { rolePrior, habitualRoute });
    expect(scored.status).toBe('final');
    expect(trip.role).toBe('driver');
    expect(trip.role_confidence).toBeCloseTo(0.9);
    expect(payload.startGeohash5).toBe(start);
    expect(payload.endGeohash5).toBe(end);
  });

  test('a habitual route is high evidence: a 4-minute run on it is not counted', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip } = await finalizeWith(rows, { evidence: 'auto' }, { rolePrior: 0.75, habitualRoute: true });
    expect(trip.role).toBe('driver');
    expect(trip.role_confidence).toBeCloseTo(0.9);
  });

  test('a neutral-evidence auto trip with one continuous 4-minute handling run is unknown, not passenger', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip, scored, payload } = await finalizeWith(rows, { evidence: 'auto' }, { rolePrior: 0.5 });
    expect(trip.role).toBe('unknown');
    expect(trip.role_confidence).toBeCloseTo(0.25);
    expect(scored.reason).toBe('role_unknown');
    expect(FinalizeTripPayloadSchema.parse(payload).roleSource).toBe('auto');
  });

  test('the same minutes split into three runs do not lean passenger at all', async () => {
    const rows = withHandling(track(N), [[200, 80], [400, 80], [600, 80]]);
    const { trip } = await finalizeWith(rows, { evidence: 'auto' }, { rolePrior: 0.5 });
    expect(trip.role_confidence).toBeCloseTo(0.5);
  });

  test('a moving start is not manual evidence: neutral, it is unknown with source moving_start', async () => {
    const { trip, scored, payload } = await finalizeWith(track(N), { evidence: 'movingStart' });
    expect(trip).toMatchObject({ role: 'unknown', role_confidence: 0.5, role_source: 'moving_start' });
    expect(scored.reason).toBe('role_unknown');
    expect(FinalizeTripPayloadSchema.parse(payload)).toMatchObject({ role: 'unknown', roleSource: 'moving_start' });
  });

  test('a moving start with a strong prior is driver', async () => {
    const { trip } = await finalizeWith(track(N), { evidence: 'movingStart' }, { rolePrior: 0.9 });
    expect(trip).toMatchObject({ role: 'driver', role_source: 'moving_start' });
  });

  test('passenger mode on an auto drive is authoritative', async () => {
    const { trip, payload } = await finalizeWith(track(N), { evidence: 'auto', role: 'passenger' }, { rolePrior: 0.95, habitualRoute: true });
    expect(trip).toMatchObject({ role: 'passenger', role_confidence: 0.02, status: 'unscored' });
    expect(payload.provisional.reason).toBe('passenger');
  });

  test('a low prior and a long run on an auto drive infer passenger (the §9.7 threshold)', async () => {
    const rows = withHandling(track(N), [[300, 240]]);
    const { trip } = await finalizeWith(rows, { evidence: 'auto' }, { rolePrior: 0.3 });
    expect(trip.role).toBe('passenger');
    expect(trip.role_confidence).toBeCloseTo(0.15);
  });
});

describe('read-back rule', () => {
  const N = 300;
  let rows: FeatureRow[];

  beforeEach(async () => {
    rows = track(N);
    await persisted(rows, N);
    await finalizeTrip(session(rows), deps);
    await createTripsRepo(db).update(TRIP, { sync_state: 'synced', server_id: 'srv-1' }, NOW);
  });

  test('a synced trip comes back from storage, never re-run', async () => {
    const { trip, payload } = await finalizeTrip(session(rows), deps);
    expect(trip).toMatchObject({ sync_state: 'synced', server_id: 'srv-1' });
    expect(payload.clientTripId).toBe(TRIP);
    expect(files.size).toBe(1);
  });

  test('a synced trip whose queue item was purged cannot be re-run either', async () => {
    await db.execute('DELETE FROM sync_queue');
    await expect(finalizeTrip(session(rows), deps)).rejects.toThrow(/already/);
    expect(await createTripsRepo(db).get(TRIP)).toMatchObject({ sync_state: 'synced', server_id: 'srv-1' });
    expect(files.size).toBe(1);
  });
});

describe('the write step is atomic', () => {
  test('a failure at the queue insert leaves the trip recording, no events, samples intact', async () => {
    const rows = track(1320);
    await persisted(rows, 1290);
    const failing: Db = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            execute: (sql, params) =>
              sql.includes('sync_queue') ? Promise.reject(new Error('disk full')) : tx.execute(sql, params),
          })
        ),
    };

    await expect(
      finalizeTrip(session(rows, { events: WORKED }), { ...deps, db: failing })
    ).rejects.toThrow('disk full');

    expect(await createTripsRepo(db).get(TRIP)).toMatchObject({
      status: 'recording',
      sync_state: 'local',
      score: null,
    });
    await expect(createEventsRepo(db).countByTrip(TRIP)).resolves.toBe(0);
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(1320);
    await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(0);

    // The same session finalizes cleanly on the retry.
    const { trip } = await finalizeTrip(session(rows, { events: WORKED }), deps);
    expect(trip).toMatchObject({ status: 'provisional', sync_state: 'queued', score: 74 });
    await expect(createSamplesRepo(db).count(TRIP)).resolves.toBe(0);
  });
});

describe('upload caps (M2 plausibility: at most MAX_EVENTS events, polyline at most MAX_POLYLINE_BYTES)', () => {
  test('over MAX_EVENTS: removed, then possible, then the cheapest scored go; the score is over all of them', async () => {
    const rows = track(1320);
    await persisted(rows, 1320);
    const tiny = Array.from({ length: 498 }, (_, i) =>
      ev({
        id: `t${i}`,
        category: 'braking',
        startedAt: T0 + 10_000 + i * 2000,
        durationS: 1,
        q: i === 0 ? 0.55 : 0.8,
        measured: { peakG: 0.3 + (i % 5) * 0.01 },
        source: 'both',
      })
    );
    const removed = ev({
      id: 'r1',
      category: 'phone',
      startedAt: T0 + 400_000,
      durationS: 20,
      q: 0.95,
      status: 'removed',
      measured: { speedMps: 20 },
      source: 'os',
    });
    const all = [p1, s1, b1, x1, removed, ...tiny];
    expect(all).toHaveLength(503);

    const { scored, events, payload } = await finalizeTrip(session(rows, { events: all }), deps);

    expect(events).toHaveLength(503);
    expect(payload.events).toHaveLength(MAX_EVENTS);
    const ids = new Set(payload.events.map((e) => e.id));
    expect(ids.has('r1')).toBe(false);
    expect(ids.has('x1')).toBe(false);
    expect(ids.has('t0')).toBe(false);
    expect(['p1', 's1', 'b1', 't1', 't497'].every((id) => ids.has(id))).toBe(true);
    expect(payload.events.map((e) => e.startedAt)).toEqual(
      [...payload.events.map((e) => e.startedAt)].sort((a, b) => a - b)
    );
    // Provisional was scored over everything: 501 scored events, braking capped at 12.
    expect(Object.keys(scored.eventDeductions)).toHaveLength(501);
    expect(scored.score).toBe(67);
    expect(payload.provisional).toEqual(scored);
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
  });

  test('a polyline over MAX_POLYLINE_BYTES at 10 m is re-simplified with a doubled epsilon until it fits', async () => {
    const n = 6000;
    // Due north at 10 m/s with a 15 m zigzag: every vertex survives epsilon = 10, none survives 20.
    const rows = Array.from({ length: n }, (_, i) =>
      row({
        ts: T0 + i * 1000,
        lat: SF.lat + (i * SPEED) / M_PER_DEG_LAT,
        lng: SF.lng + (i % 2 === 0 ? 15 : -15) / M_PER_DEG_LNG,
        speed: SPEED,
        course: 0,
        aLonMax: 0.02,
      })
    );
    const dense = encodePolyline(simplify(rows, POLYLINE_EPSILON_M));
    expect(dense.length).toBeGreaterThan(MAX_POLYLINE_BYTES);
    await persisted(rows, n);

    const { trip, payload } = await finalizeTrip(session(rows), deps);

    expect(payload.polyline.length).toBeLessThanOrEqual(MAX_POLYLINE_BYTES);
    expect(payload.polyline.length).toBeGreaterThan(0);
    expect(trip.polyline).toBe(payload.polyline);
    const pts = decodePolyline(payload.polyline);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(haversineMeters(pts[0]!, pts[pts.length - 1]!)).toBeGreaterThan((n - 50) * SPEED);
    expect(FinalizeTripPayloadSchema.parse(payload)).toEqual(payload);
  }, 30_000);
});

describe('simplifyTrack (Douglas–Peucker per chunk of at most 1000 points)', () => {
  const smooth = (n: number): LatLng[] =>
    Array.from({ length: n }, (_, i) => ({
      lat: SF.lat + (i * 8) / M_PER_DEG_LAT,
      lng: SF.lng + (40 * Math.sin(i / 60)) / M_PER_DEG_LNG,
    }));

  test('a 12,000-point smooth track simplifies within budget, decodes, and shares chunk boundaries', () => {
    const pts = smooth(12_000);
    const started = performance.now();
    const out = simplifyTrack(pts, POLYLINE_EPSILON_M);
    expect(performance.now() - started).toBeLessThan(1500);

    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(pts.length / 4);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    for (let i = 1; i < out.length; i += 1) expect(out[i]).not.toEqual(out[i - 1]);
    expect(decodePolyline(encodePolyline(out))).toHaveLength(out.length);
  });

  test('a short track is exactly what the primitive gives', () => {
    const pts = smooth(500);
    expect(simplifyTrack(pts, POLYLINE_EPSILON_M)).toEqual(simplify(pts, POLYLINE_EPSILON_M));
  });
});
