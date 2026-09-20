// The finalize pipeline (design §3.1 "finalizing", §4.4 finalize-trip).
//
// Turns the closed session the engine hands over into a stored trip, a provisional score, a
// polyline and one idempotent upload. Pure TypeScript over the `Db`; the platform comes in
// through `FinalizeDeps` (the trace writer, the hash), so the whole pipeline runs under Jest.
//
// Order of work, chosen so that a crash anywhere leaves a state the next call repairs:
//   1. the trip row exists, and the ring's un-checkpointed tail is in `samples`;
//   2. the trip's rows are read back from `samples` — the durable record, not the ring — and
//      become the trace file, its digest, and the metrics the score is built on;
//   3. events are scored, located and stored; the trip row is updated and marked `queued`;
//   4. the upload is queued under `trip:<clientTripId>`; only then are the samples purged.
// A call that finds the trip already finalized *and* queued returns what is stored. One that
// finds it finalized but not queued (a crash between 3 and 4) simply runs again: the samples
// are still there, and every step is idempotent.
import type { ScoredTrip, TripMetrics } from '@scoring';
import { mergeEvents } from '@/core/detectors';
import {
  createEventsRepo,
  createSamplesRepo,
  createTripsRepo,
  MissingTripError,
  type Db,
  type EventRow,
  type NewEvent,
  type TripRow,
  type TripStatus,
} from '@/data/db';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload, type PayloadEvent } from '@/data/sync/payload';
import { enqueueFinalize, findFinalize } from '@/data/sync/queue';
import { geohash5, haversineMeters, roundCoord, type LatLng } from '@/lib/geo';
import { encodePolyline, simplify } from '@/lib/polyline';
import { isNight, sunIsDown } from '@/lib/time';
import type { Fix, TripSession } from './engine.types';
import { appendRow, createSession, GNSS_JUMP_MPS, ROW_MS } from './session';
import type { DetectedEvent, FeatureRow, LimitSample } from './types';

/**
 * Rows within this distance of the trip's first and last fix stay out of the polyline and off the
 * events' coordinates, so a stored trip never pins the driveway. Scoring sees every row.
 */
export const TRIM_ENDPOINTS_M = 200;
/** Douglas–Peucker tolerance for the stored polyline. */
export const POLYLINE_EPSILON_M = 10;

/** The trace's name, relative to the traces directory; the sync runner prefixes `<uid>/` in storage. */
export const tracePathFor = (clientTripId: string): string => `${clientTripId}.bin.gz`;

export interface FinalizeDeps {
  db: Db;
  /** The scoring package, injected so the finalizer scores with exactly what the host loaded. */
  scoring: typeof import('@scoring');
  /** IANA zone of the device at finalize: stored on the trip and used for the night rule. */
  tz: string;
  fs: {
    /** Write `bytes` gzip-compressed at `path` (relative to the traces directory), replacing any file there. */
    writeGzip(path: string, bytes: Uint8Array): Promise<void>;
  };
  hash: {
    /** Lowercase hex SHA-256 of a UTF-8 string (`sha256Hex` in `src/lib/hash` on device). */
    sha256(text: string): Promise<string>;
  };
  /** Wall clock for the row stamps; defaults to `Date.now`. */
  now?: () => number;
  /** Whether the camera pipeline ran for this trip. M1 has no camera, so it defaults to false. */
  cameraSession?: boolean;
}

export interface FinalizeResult {
  trip: TripRow;
  events: EventRow[];
  scored: ScoredTrip;
  payload: FinalizeTripPayload;
}

const UNKNOWN_LIMIT: LimitSample = {
  limitMps: null,
  source: 'unknown',
  matchConfidence: 0,
  parallelRoads: false,
};

/** JSON with every object's keys sorted, so the digest is the same whatever order the rows were stored in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const record = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k]])
    );
  });
}

/** The engine's own accumulators, re-run over the durable rows: distance, GNSS share, sustained speed. */
function replay(session: Readonly<TripSession>, rows: FeatureRow[]): TripSession {
  const check = createSession({
    clientTripId: session.clientTripId,
    mode: session.mode,
    role: session.role,
    startSource: session.startSource,
    startedAt: session.startedAt,
  });
  for (const row of rows) appendRow(check, row, UNKNOWN_LIMIT);
  return check;
}

/** The IMU counts as present when any row carries a non-zero reading in the six extremes. */
const imuPresent = (rows: FeatureRow[]): boolean =>
  rows.some(
    (r) =>
      r.aLonMax !== 0 ||
      r.aLonMin !== 0 ||
      r.aLatMax !== 0 ||
      r.aLatMin !== 0 ||
      r.yawRateMax !== 0 ||
      r.jerkMax !== 0
  );

/** Valid fixes in order, minus any that would take more than `GNSS_JUMP_MPS` to reach — the distance rule. */
function cleanTrack(rows: FeatureRow[]): Fix[] {
  const track: Fix[] = [];
  for (const r of rows) {
    if (!r.gnssValid) continue;
    const prev = track[track.length - 1];
    if (prev && haversineMeters(prev, r) > GNSS_JUMP_MPS * Math.max(1, (r.ts - prev.ts) / 1000)) {
      continue;
    }
    track.push({ lat: r.lat, lng: r.lng, ts: r.ts });
  }
  return track;
}

/** Indices `[from, to)` of the track beyond `metres` of both the first and the last fix. */
function trimmedRange(track: Fix[], metres: number): [from: number, to: number] {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return [0, 0];
  let from = 0;
  while (from < track.length && haversineMeters(track[from] as Fix, first) < metres) from += 1;
  let to = track.length;
  while (to > from && haversineMeters(track[to - 1] as Fix, last) < metres) to -= 1;
  return [from, to];
}

/** Index of the last fix at or before `ts`, else the first fix; -1 on an empty track. */
function fixIndexAt(track: Fix[], ts: number): number {
  let lo = 0;
  let hi = track.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((track[mid] as Fix).ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0) return found;
  return track.length > 0 ? 0 : -1;
}

/** Hour of day in `tz`; NaN when Intl does not know the zone. */
function hourIn(ts: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(ts));
    return Number(parts.find((p) => p.type === 'hour')?.value);
  } catch {
    return NaN;
  }
}

const tripStatus = (status: ScoredTrip['status']): TripStatus =>
  status === 'final' ? 'provisional' : status;

const toNewEvent = (e: PayloadEvent, clientTripId: string): NewEvent => ({
  id: e.id,
  client_trip_id: clientTripId,
  category: e.category,
  started_at: e.startedAt,
  duration_s: e.durationS,
  lat: e.lat,
  lng: e.lng,
  measured_json: JSON.stringify(e.measured),
  severity: String(e.severity),
  confidence: e.q,
  context_json: JSON.stringify(e.context),
  deduction: e.deduction,
  alert_shown: e.alertShown ? 1 : 0,
  corrected: e.corrected ? 1 : 0,
  status: e.status,
  source: e.source,
});

export async function finalizeTrip(
  session: Readonly<TripSession>,
  deps: FinalizeDeps
): Promise<FinalizeResult> {
  const { db, scoring, tz } = deps;
  const now = deps.now ?? Date.now;
  const trips = createTripsRepo(db);
  const events = createEventsRepo(db);
  const samples = createSamplesRepo(db);
  const id = session.clientTripId;

  // Already done: hand back what the first run stored, and finish its purge if it never got there.
  const existing = await trips.get(id);
  if (existing && existing.status !== 'recording') {
    const stored = await findFinalize(db, id);
    if (stored) {
      await samples.purgeByTrip(id);
      return {
        trip: existing,
        events: await events.listByTrip(id),
        scored: stored.provisional,
        payload: stored,
      };
    }
  }
  if (!existing) {
    await trips.insert(
      { client_trip_id: id, started_at: session.startedAt, tz, status: 'recording' },
      now()
    );
  }

  // 1. Whatever the recorder did not checkpoint is still in the ring; make it durable first.
  const latest = await samples.latest(id);
  const tail = session.rows.filter((r) => r.ts > (latest?.ts ?? Number.NEGATIVE_INFINITY));
  if (tail.length > 0) await samples.appendMany(id, tail.map((row) => ({ ts: row.ts, row })));

  // 2. The durable rows become the trace, the digest and the metrics.
  const rows = (await samples.range(id, 0, Number.MAX_SAFE_INTEGER)).map(
    (s) => JSON.parse(s.row_json) as FeatureRow
  );
  const traceJson = canonicalJson(rows);
  const tracePath = tracePathFor(id);
  await deps.fs.writeGzip(tracePath, new TextEncoder().encode(traceJson));
  const recheck = replay(session, rows);
  const rowsDigest: FinalizeTripPayload['rowsDigest'] = {
    count: rows.length,
    validGnssPct: recheck.validGnssPct,
    imuPresent: imuPresent(rows),
    maxSustainedSpeedMps: recheck.maxSustainedSpeedMps,
    sha256: await deps.hash.sha256(traceJson),
  };

  // 3. Score. The engine merged already; running the rule again is idempotent and covers a host
  //    that hands over raw detections.
  const merged = mergeEvents([...session.events]);
  const metrics: TripMetrics = {
    distanceM: recheck.distanceM,
    durationS: session.durationS,
    validGnssPct: rowsDigest.validGnssPct,
    imuPresent: rowsDigest.imuPresent,
    role: session.role,
    maxSustainedSpeedMps: rowsDigest.maxSustainedSpeedMps,
  };
  const scored = scoring.scoreTrip(metrics, merged);

  // Geometry: the polyline and the events' coordinates share one trimmed track.
  const track = cleanTrack(rows);
  const [from, to] = trimmedRange(track, TRIM_ENDPOINTS_M);
  const polyline = encodePolyline(simplify(track.slice(from, to), POLYLINE_EPSILON_M));
  const locate = (ts: number): LatLng | null => {
    const i = fixIndexAt(track, ts);
    if (i < from || i >= to) return null;
    const fix = track[i] as Fix;
    return { lat: roundCoord(fix.lat), lng: roundCoord(fix.lng) };
  };
  const first = recheck.firstFix ?? session.firstFix;
  const last = recheck.lastFix ?? session.lastFix;

  // Conditions and the safe-day flag (§9.9): night by the trip's clock or by the sun at its start.
  const { CONSTANTS } = scoring;
  const hour = hourIn(session.startedAt, tz);
  const night =
    (Number.isNaN(hour)
      ? isNight(new Date(session.startedAt))
      : hour >= CONSTANTS.NIGHT_START_H || hour < CONSTANTS.NIGHT_END_H) ||
    (first !== null && sunIsDown(new Date(session.startedAt), first.lat, first.lng));
  const hadSevereEvent =
    merged.some(
      (e) =>
        e.category === 'speeding' &&
        e.status === 'scored' &&
        (e.measured.overMps ?? 0) >= CONSTANTS.SEVERE_SPEEDING_OVER_MPS
    ) || session.alerts.some((a) => a.level === 3);
  const conditions = { night, precipitation: false, hadSevereEvent };

  const alerted = new Set(session.alerts.flatMap((a) => (a.eventId ? [a.eventId] : [])));
  const alertShown = (e: DetectedEvent): boolean =>
    alerted.has(e.id) || (e.absorbedIds ?? []).some((absorbed) => alerted.has(absorbed));
  const payloadEvents: PayloadEvent[] = merged.map((e) => {
    const at = locate(e.startedAt);
    return {
      id: e.id,
      category: e.category,
      startedAt: e.startedAt,
      durationS: e.durationS,
      durationMs: Math.round(e.durationS * 1000),
      q: e.q,
      corrected: e.corrected,
      status: e.status,
      measured: { ...e.measured },
      context: { ...e.context },
      contextMultiplier: scoring.contextMultiplier(e),
      severity: scoring.severity(e),
      deduction: scored.status === 'final' ? (scored.eventDeductions[e.id] ?? 0) : null,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      alertShown: alertShown(e),
      source: e.source,
    };
  });

  const endedAt =
    session.endedAt ??
    (session.lastRowTs !== null ? session.lastRowTs + ROW_MS : session.startedAt);
  const payload = FinalizeTripPayloadSchema.parse({
    clientTripId: id,
    startedAt: session.startedAt,
    endedAt,
    tz,
    distanceM: metrics.distanceM,
    durationS: metrics.durationS,
    role: session.role,
    roleConfidence: null,
    roleSource: session.startSource,
    mode: session.mode,
    cameraSession: deps.cameraSession ?? false,
    provisional: scored,
    events: payloadEvents,
    rowsDigest,
    startGeohash5: first ? geohash5(first.lat, first.lng) : null,
    endGeohash5: last ? geohash5(last.lat, last.lng) : null,
    polyline,
    tracePath,
    hadSevereEvent,
  } satisfies FinalizeTripPayload);

  // 4. Persist: events, then the trip row (marked queued before the item exists, so a runner that
  //    drains on enqueue cannot have its `synced` overwritten), then the queue item, then the purge.
  await events.removeByTrip(id);
  const eventRows = await events.insertMany(payloadEvents.map((e) => toNewEvent(e, id)));
  const trip = await trips.update(
    id,
    {
      started_at: session.startedAt,
      ended_at: endedAt,
      tz,
      distance_m: metrics.distanceM,
      duration_s: metrics.durationS,
      role: session.role,
      role_confidence: null,
      role_source: session.startSource,
      mode: session.mode,
      camera_session: payload.cameraSession ? 1 : 0,
      score: scored.score,
      scoring_version: String(scored.scoringVersion),
      category_deductions_json: JSON.stringify(scored.categoryDeductions),
      exposure: scored.exposure,
      data_quality: scored.dataQuality,
      conditions_json: JSON.stringify(conditions),
      limit_coverage_pct:
        session.rowsCount > 0 ? (session.limitKnownRows * 100) / session.rowsCount : 0,
      start_geohash5: payload.startGeohash5,
      end_geohash5: payload.endGeohash5,
      polyline: polyline === '' ? null : polyline,
      status: tripStatus(scored.status),
      sync_state: 'queued',
      checkpoint_ts: session.lastRowTs,
    },
    now()
  );
  if (!trip) throw new MissingTripError(id);
  await enqueueFinalize(db, payload, now());
  await samples.purgeByTrip(id);

  return { trip, events: eventRows, scored, payload };
}
