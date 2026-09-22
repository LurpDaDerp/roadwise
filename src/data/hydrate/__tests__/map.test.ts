/** @jest-environment node */
import * as scoring from '@scoring';

import type { AlertDecision } from '@/core/alerts/types';
import { limit, mph, NO_LIMIT, row, T0 } from '@/core/detectors/__fixtures__/rows';
import { finalizeTrip } from '@/core/engine/finalize';
import { appendRow, closeSession, createSession } from '@/core/engine/session';
import type { DetectedEvent, FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createSamplesRepo } from '@/data/db/samples';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import { createHydrator } from '@/data/hydrate/hydrate';
import {
  parseRow,
  parseTimestamp,
  ServerDisputeSchema,
  ServerTripSchema,
  toDayRow,
  toDisputeRecord,
  toStoredBaseline,
} from '@/data/hydrate/map';
import { parseStoredBaseline } from '@/data/queries/insights';
import { parseDispute, toTripEventView, toTripSummary } from '@/data/queries/rows';
import { createFakeSupabase } from '@/data/sync/__fixtures__/fakes';
import type { FinalizeTripPayload } from '@/data/sync/payload';
import { DEVICE_OWNER_KEY } from '@/data/sync/queue';

const UID = '0b9f7a52-7a8e-4a4f-8f38-3f1c1f5a9d10';
const TRIP = '123e4567-e89b-42d3-a456-426614174000';
const SERVER_TRIP = 'a3f1c2d4-5b6e-4f8a-9c0d-1e2f3a4b5c6d';
const TZ = 'America/Los_Angeles';
const NOW = T0 + 2_000_000;

/** A `timestamptz` the way PostgREST renders it. */
const pgTime = (ms: number): string => new Date(ms).toISOString().replace('Z', '+00:00');

const SF = { lat: 37.7749, lng: -122.4194 };
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((SF.lat * Math.PI) / 180);

function track(n: number): FeatureRow[] {
  const half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) =>
    row({
      ts: T0 + i * 1000,
      lat: SF.lat + (Math.max(0, i - half) * 10) / M_PER_DEG_LAT,
      lng: SF.lng + (Math.min(i, half) * 10) / M_PER_DEG_LNG,
      speed: 10,
      course: i <= half ? 90 : 0,
      gnssValid: true,
      aLonMax: 0.02,
      aLonMin: -0.02,
    })
  );
}

const ev = (
  p: Partial<DetectedEvent> & Pick<DetectedEvent, 'id' | 'category' | 'startedAt' | 'durationS' | 'q' | 'measured'>
): DetectedEvent => ({
  corrected: false,
  status: 'scored',
  context: { night: false, precipitation: false },
  alertable: true,
  source: 'gnss',
  ...p,
});

const EVENTS = [
  ev({ id: 'p1', category: 'phone', startedAt: T0 + 300_000, durationS: 12.5, q: 0.9, measured: { speedMps: mph(35) }, source: 'os' }),
  ev({ id: 's1', category: 'speeding', startedAt: T0 + 600_000, durationS: 45, q: 0.85, measured: { overMps: mph(12), limitMps: mph(35), speedMps: mph(47) } }),
  ev({ id: 'b1', category: 'braking', startedAt: T0 + 900_000, durationS: 1, q: 0.8, measured: { peakG: 0.42 }, source: 'both' }),
  ev({ id: 'x1', category: 'braking', startedAt: T0 + 5_000, durationS: 1, q: 0.4, status: 'possible', alertable: false, measured: { peakG: 0.31 }, source: 'both' }),
];
const ALERT: AlertDecision = { id: 'a1', level: 1, kind: 'speeding', eventId: 's1', ts: T0 + 605_000 };

async function freshDb(): Promise<Db> {
  const db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, UID);
  return db;
}

/** Finalize a real drive on `db`, then apply what the server answered the way the runner does. */
async function finalizeAndSync(db: Db): Promise<FinalizeTripPayload> {
  const rows = track(1320);
  await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(TRIP, rows.map((r) => ({ ts: r.ts, row: r })));
  const s = createSession({ clientTripId: TRIP, mode: 'mounted', role: 'driver', startSource: 'manual', startedAt: T0 });
  rows.forEach((r, i) => appendRow(s, r, i % 10 === 9 ? NO_LIMIT : limit(mph(35))));
  s.events = EVENTS;
  s.alerts = [ALERT];
  const closed = closeSession(s, T0 + rows.length * 1000);
  const { payload } = await finalizeTrip(closed, {
    db,
    scoring,
    tz: TZ,
    fs: { writeGzip: async () => undefined },
    hash: { sha256: async () => 'a'.repeat(64) },
    now: () => NOW,
  });
  // The runner's applyFinalize: the server's id, status and score, the row now synced. The
  // server agreed with the device here, so the breakdown fields are the device's own.
  await createTripsRepo(db).update(TRIP, { sync_state: 'synced', server_id: SERVER_TRIP, sync_error: null }, NOW);
  return payload;
}

/** The rows `apply_trip` stores for this payload (0002_trips.sql), rendered as PostgREST would. */
function serverRowsFor(payload: FinalizeTripPayload) {
  const scored = payload.provisional;
  const status = scored.status === 'final' ? 'provisional' : scored.status;
  const trip = {
    id: SERVER_TRIP,
    user_id: UID,
    client_trip_id: payload.clientTripId,
    started_at: pgTime(payload.startedAt),
    ended_at: pgTime(payload.endedAt),
    tz: payload.tz,
    distance_m: payload.distanceM,
    duration_s: payload.durationS,
    role: payload.role,
    role_confidence: payload.roleConfidence,
    role_source: payload.roleSource,
    mode: payload.mode,
    camera_session: payload.cameraSession,
    score: scored.score,
    scoring_version: scored.scoringVersion,
    category_deductions: scored.categoryDeductions,
    exposure: scored.exposure,
    data_quality: scored.dataQuality,
    // The function passes the clock rule's night and a hard false for precipitation.
    conditions: { night: false, precipitation: false },
    had_severe_event: payload.hadSevereEvent,
    limit_coverage_pct: payload.limitCoveragePct,
    start_label: null,
    end_label: null,
    start_geohash5: payload.startGeohash5,
    end_geohash5: payload.endGeohash5,
    polyline: payload.polyline,
    status,
    incomplete: payload.incomplete,
    deleted_at: null,
    updated_at: '2026-09-21T10:00:00.123456+00:00',
  };
  const events = payload.events.map((e, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    trip_id: SERVER_TRIP,
    user_id: UID,
    client_event_id: e.id,
    category: e.category,
    started_at: pgTime(e.startedAt),
    duration_ms: e.durationMs,
    lat: e.lat,
    lng: e.lng,
    measured: e.measured,
    context: e.context,
    severity: e.severity,
    confidence: e.q,
    deduction: scored.status === 'final' ? (scored.eventDeductions[e.id] ?? 0) : null,
    alert_shown: e.alertShown,
    corrected: e.corrected,
    source: e.source,
    status: e.status,
  }));
  return { trip, events };
}

describe('the round trip', () => {
  test('a restored trip renders exactly as the same trip finalized and synced on this device', async () => {
    const local = await freshDb();
    const payload = await finalizeAndSync(local);
    const { trip, events } = serverRowsFor(payload);

    const restored = await freshDb();
    const supabase = createFakeSupabase({ uid: UID, tables: { trips: [trip], trip_events: events } });
    const result = await createHydrator({ db: restored, supabase, now: () => NOW + 1, isBusy: () => false }).run({ full: true });
    expect(result).toMatchObject({ trips: 1, events: payload.events.length, complete: true });

    const before = await createTripsRepo(local).get(TRIP);
    const after = await createTripsRepo(restored).get(TRIP);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(toTripSummary(after!)).toEqual(toTripSummary(before!));

    const view = async (db: Db) =>
      (await createEventsRepo(db).listByTrip(TRIP)).map(toTripEventView);
    const localEvents = await view(local);
    const restoredEvents = await view(restored);
    expect(restoredEvents).toHaveLength(localEvents.length);
    for (const [i, restoredEvent] of restoredEvents.entries()) {
      const localEvent = localEvents[i]!;
      // The wire carries whole milliseconds; the finalizer's fraction beyond that is not a fact
      // any screen shows.
      expect({ ...restoredEvent, durationS: 0 }).toEqual({ ...localEvent, durationS: 0 });
      expect(restoredEvent.durationS).toBeCloseTo(localEvent.durationS, 3);
    }
  });
});

describe('scalars', () => {
  test('timestamps: microseconds, offsets and Z all land on the right millisecond', () => {
    const ms = Date.UTC(2026, 8, 21, 10, 0, 0, 123);
    expect(parseTimestamp('2026-09-21T10:00:00.123456+00:00')).toBe(ms);
    expect(parseTimestamp('2026-09-21T10:00:00.123Z')).toBe(ms);
    expect(parseTimestamp('2026-09-21T03:00:00.123-07:00')).toBe(ms);
    expect(parseTimestamp('2026-09-21 15:30:00.123+0530')).toBe(ms);
    expect(parseTimestamp('2026-09-21T10:00:00+00')).toBe(Date.UTC(2026, 8, 21, 10));
    expect(parseTimestamp('yesterday')).toBeNull();
    expect(parseTimestamp('2026-09-21T10:00:00')).toBeNull();
  });

  test('a client trip id outside the server charset is refused before it can become a file path', () => {
    const base = { ...serverRowsFor(minimalPayload()).trip };
    expect(parseRow(ServerTripSchema, base)).not.toBeNull();
    expect(parseRow(ServerTripSchema, { ...base, client_trip_id: '../../evil' })).toBeNull();
    expect(parseRow(ServerTripSchema, { ...base, id: 'not-a-uuid' })).toBeNull();
  });
});

describe('disputes, days and the baseline', () => {
  test("a server report becomes the record parseDispute reads, and says nothing it doesn't know", () => {
    const raw = {
      event_id: '00000000-0000-4000-8000-000000000001',
      reason: 'wrong_limit',
      note: 'posted 45',
      stated_limit_mph: 45,
      auto_accepted: false,
      denied_reason: 'allowance_7d',
      decided_at: '2026-09-21T10:05:00.5+00:00',
      created_at: '2026-09-21T10:04:00+00:00',
    };
    const dispute = parseRow(ServerDisputeSchema, raw);
    expect(dispute).not.toBeNull();
    const record = toDisputeRecord(dispute!);
    expect(parseDispute(JSON.stringify(record))).toEqual({
      reason: 'wrong_limit',
      note: 'posted 45',
      statedLimitMph: 45,
      submittedAt: Date.UTC(2026, 8, 21, 10, 4),
      outcome: 'denied',
      deniedReason: 'allowance_7d',
      remainingAllowance: null,
      code: null,
      decidedAt: Date.UTC(2026, 8, 21, 10, 5, 0, 500),
    });
    expect(toDisputeRecord({ ...dispute!, auto_accepted: true, denied_reason: null })?.outcome).toBe('accepted');
  });

  test('a day row maps onto the wire shape the runner caches', () => {
    expect(
      toDayRow({
        day: '2026-09-21',
        long_term_score: 81,
        band: 'good',
        provisional: true,
        safe_day: true,
        good_day: false,
        phone_free_day: true,
        camera_day: false,
        exposure: 1.25,
        driving_s: 1800,
        trips_scored: 2,
        severe_events: 0,
        updated_at: '2026-09-21T10:00:00+00:00',
      })
    ).toEqual({
      day: '2026-09-21',
      longTermScore: 81,
      band: 'good',
      provisional: true,
      safeDay: true,
      goodDay: false,
      phoneFreeDay: true,
      cameraDay: false,
      exposure: 1.25,
      drivingS: 1800,
      tripsScored: 2,
      severeEvents: 0,
    });
  });

  test('the baseline lands in the envelope E1 reads', () => {
    const stored = toStoredBaseline({
      medians: { score: 84, speeding: 2.5, phone: 1, junk: 'x' },
      computed_at: '2026-09-21T10:00:00+00:00',
    });
    expect(stored).toEqual({
      medians: { score: 84, speeding: 2.5, phone: 1 },
      computedAt: Date.UTC(2026, 8, 21, 10),
    });
    expect(parseStoredBaseline(stored)).toEqual({ score: 84, speeding: 2.5, phone: 1 });
  });
});

function minimalPayload(): FinalizeTripPayload {
  return {
    clientTripId: TRIP,
    startedAt: T0,
    endedAt: T0 + 60_000,
    tz: TZ,
    distanceM: 1000,
    durationS: 60,
    role: 'driver',
    roleConfidence: null,
    roleSource: 'manual',
    mode: 'mounted',
    cameraSession: false,
    provisional: {
      score: 90,
      status: 'final',
      exposure: 1,
      dataQuality: 'A',
      categoryDeductions: { phone: 0, speeding: 10, braking: 0, accel: 0, cornering: 0, focus: 0 },
      eventDeductions: {},
      scoringVersion: 1,
    },
    events: [],
    rowsDigest: { count: 60, validGnssPct: 100, imuPresent: true, maxSustainedSpeedMps: 10, sha256: 'a'.repeat(64) },
    startGeohash5: null,
    endGeohash5: null,
    limitCoveragePct: 80,
    polyline: '',
    tracePath: null,
    hadSevereEvent: false,
    incomplete: false,
  } as FinalizeTripPayload;
}
