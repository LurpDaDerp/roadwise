// The finalize pipeline (design §3.1 "finalizing", §4.4 finalize-trip).
//
// Turns the closed session the engine hands over into a stored trip, a provisional score, a
// polyline and one idempotent upload. Pure TypeScript over the `Db`; the platform comes in
// through `FinalizeDeps` (the trace writer, the hash), so the whole pipeline runs under Jest.
//
// Order of work:
//   1. the trip row exists, and the ring's un-checkpointed tail is in `samples`;
//   2. the trip's rows are read back from `samples` — the durable record, not the ring — and
//      become the trace text, its digest, and the metrics the score is built on;
//   3. the trip and its events are scored, located and capped for the upload; the payload is
//      validated; the trace file is written. A *discarded* trip (§9.4: a train, a plane) is the
//      exception — nobody wants it uploaded, so no trace is written, nothing is queued, and its
//      row goes straight to `sync_state = 'synced'`;
//   4. ONE transaction replaces the events, updates the trip row (marked `queued`, or `synced`
//      when discarded), queues the upload under `trip:<clientTripId>` and purges the samples.
//      It commits or it does not.
// Steps 1–3 leave nothing behind that the next call cannot redo (a `recording` row, durable
// samples, a trace file that is rewritten). A re-run is an in-process retry of the same session
// — the events, alerts and gaps live only in memory — so a failure is reported to the engine
// (which re-arms) and the host may call again with the same closed session. A call that finds
// the trip already finalized returns what is stored; one that finds it synced or final and no
// longer queued (a discarded trip included) refuses, since re-running would overwrite what was
// settled.
import type { ScorableEvent, ScoredTrip, TripMetrics } from '@scoring';
import { mergeEvents } from '@/core/detectors';
import { inferRole, type RoleInference } from '@/core/detectors/role';
import { ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import {
  createEventsRepo,
  createSamplesRepo,
  createSettingsRepo,
  createTripsRepo,
  MissingTripError,
  type Db,
  type EventRow,
  type NewEvent,
  type TripRow,
  type TripStatus,
} from '@/data/db';
import {
  FinalizeTripPayloadSchema,
  MAX_EVENTS,
  MAX_POLYLINE_BYTES,
  type FinalizeTripPayload,
  type PayloadEvent,
} from '@/data/sync/payload';
import { enqueueFinalize, findFinalize } from '@/data/sync/queue';
import { geohash5, haversineMeters, roundCoord, type LatLng } from '@/lib/geo';
import { encodePolyline, simplify } from '@/lib/polyline';
import { isNight } from '@/lib/time';
import type { Fix, TripSession } from './engine.types';
import { arbiterStateKey } from './recorder';
import { longestHandlingRunMinutes } from './rolePrior';
import { appendRow, createSession, GNSS_JUMP_MPS, roleSourceFor } from './session';
import type { DetectedEvent, FeatureRow } from './types';

/**
 * Rows within this distance of the trip's first and last fix stay out of the polyline and off the
 * events' coordinates, so a stored trip never pins the driveway. Scoring sees every row.
 */
export const TRIM_ENDPOINTS_M = 200;
/** Douglas–Peucker tolerance for the stored polyline; doubled until the polyline fits the cap. */
export const POLYLINE_EPSILON_M = 10;
/** Douglas–Peucker runs per chunk of this many points (O(n·k) on a long smooth track otherwise). */
export const SIMPLIFY_CHUNK = 1000;

/** The trace's name, relative to the traces directory; the sync runner prefixes `<uid>/` in storage. */
export const tracePathFor = (clientTripId: string): string => `${clientTripId}.bin.gz`;

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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
  /**
   * The session was rebuilt by crash recovery from the last checkpoint (`recovery.ts`), not
   * closed by the engine that recorded it: stored on the row and sent in the payload as
   * `incomplete`. Such a session has no gaps and no alerts, so its `durationS` is the wall span
   * from the first row to the close. Defaults to false — the engine's own finalize never sets it.
   */
  incomplete?: boolean;
  /**
   * P(driver) before this trip's evidence: `readRolePrior(db)`, read by the host before the call.
   * Only an auto or moving start reads it; absent, it is 0.5 — neutral, never "driver".
   */
  rolePrior?: number;
  /**
   * The trip's start/end cells are a route this user has confirmed driving
   * (`isHabitualDriverRoute` over the session's first and last fixes' geohash-5, computed by the
   * host). Only an auto or moving start reads it; absent, false.
   */
  habitualRoute?: boolean;
}

/** What the finalizer decided about who drove (§9.7): what the row and the payload carry. */
export interface TripRoleDecision {
  role: 'driver' | 'passenger' | 'unknown';
  /** P(driver), 0..1. */
  roleConfidence: number;
}

/**
 * Who drove (§9.7, R11, rev1 C1).
 *
 * A **manual start** (`tap`) is a declared drive: the stated role stands — driver at 0.95, or
 * passenger — and the trip's phone handling is never evidence against it, so using the phone
 * costs a driver points, never the score itself. The prior and the route are not read.
 *
 * An **auto or moving start** is inferred. High evidence (a habitual route, or a prior at or
 * above 0.8) sets the handling evidence aside; otherwise the longest single handling run is the
 * evidence. What `inferRole` cannot settle is `unknown` — asked (C10), unscored as
 * `role_unknown` meanwhile — and such an upload always carries `roleSource` `auto` or
 * `moving_start`, the only sources finalize-trip accepts `unknown` from (B4). `other` (transit)
 * becomes passenger: M3 has no transit classifier, so it cannot arise, but it must not score.
 *
 * Scope of the phone rule (E2 review M3): phone use never unscores a *manual* drive. On an
 * inferred drive with thin evidence it is evidence — one continuous run of three minutes or more
 * halves P(driver), which can make the drive `unknown` (unscored until the driver answers) or,
 * on a prior of 0.4 or less, `passenger` (§9.7). It never removes a score from a drive the
 * evidence already calls a driver's: a high prior or a habitual route sets it aside.
 */
export function decideRole(
  session: Pick<TripSession, 'role' | 'startEvidence'>,
  rows: readonly FeatureRow[],
  events: readonly DetectedEvent[],
  evidence: { rolePrior?: number; habitualRoute?: boolean }
): TripRoleDecision {
  const statedPassenger = session.role === 'passenger';
  let inferred: RoleInference;
  if (session.startEvidence === 'tap') {
    inferred = inferRole(
      {
        manualStart: true,
        statedPassenger,
        continuousHandlingMinutes: 0,
        habitualDriverRoute: false,
        transitPattern: false,
        cameraFaceDriverSeat: false,
      },
      0.5
    );
  } else {
    const prior = evidence.rolePrior ?? 0.5;
    const habitualRoute = evidence.habitualRoute === true;
    const highEvidence = habitualRoute || prior >= 0.8;
    inferred = inferRole(
      {
        manualStart: false,
        statedPassenger,
        continuousHandlingMinutes: highEvidence ? 0 : longestHandlingRunMinutes(rows, events),
        habitualDriverRoute: habitualRoute,
        transitPattern: false,
        cameraFaceDriverSeat: false,
      },
      prior
    );
  }
  const role = inferred.role === 'other' ? 'passenger' : inferred.role;
  return { role, roleConfidence: clamp(finite(inferred.pDriver, 0.5), 0, 1) };
}

export interface FinalizeResult {
  /**
   * The stored row: `sync_state` is `queued` — or `synced` when `scored.status` is `discarded`,
   * since a discarded trip is kept locally but never uploaded.
   */
  trip: TripRow;
  /** Every event stored locally — the upload in `payload.events` may be capped below this. */
  events: EventRow[];
  scored: ScoredTrip;
  /**
   * The validated upload. For a discarded trip it was built and validated but never queued, and
   * its `tracePath` is null: no trace file exists for it.
   */
  payload: FinalizeTripPayload;
}


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

/**
 * Valid, finite fixes in order, minus any that would take more than `GNSS_JUMP_MPS` to reach —
 * the distance rule.
 */
function cleanTrack(rows: FeatureRow[]): Fix[] {
  const track: Fix[] = [];
  for (const r of rows) {
    if (!r.gnssValid || !Number.isFinite(r.lat) || !Number.isFinite(r.lng) || !Number.isFinite(r.ts)) {
      continue;
    }
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

/**
 * Douglas–Peucker over chunks of at most `SIMPLIFY_CHUNK` points that share their boundary
 * points, so a three-hour track costs a few chunks' worth rather than O(n·k) in one go. The
 * boundary points are kept, which costs a handful of extra vertices per trip.
 */
export function simplifyTrack(points: readonly LatLng[], epsilonM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let start = 0; start < points.length; start += SIMPLIFY_CHUNK - 1) {
    const chunk = simplify(points.slice(start, start + SIMPLIFY_CHUNK), epsilonM);
    out.push(...(start === 0 ? chunk : chunk.slice(1)));
    if (start + SIMPLIFY_CHUNK >= points.length) break;
  }
  return out;
}

/** Simplify at `epsilonM`, doubling the tolerance until the encoding fits in `maxBytes`. */
function fitPolyline(points: readonly LatLng[], epsilonM: number, maxBytes: number): string {
  for (let eps = epsilonM; ; eps *= 2) {
    const encoded = encodePolyline(simplifyTrack(points, eps));
    if (encoded.length <= maxBytes) return encoded;
    // Wider than the planet and still too long cannot happen; the guard keeps the loop finite.
    if (eps > 1e8) return '';
  }
}

/**
 * Keep at most `max` events for the upload: removed events go first, then possible ones (both
 * score-neutral), then scored events from the cheapest up; among equals the latest goes first.
 */
export function capEvents(events: PayloadEvent[], max: number): PayloadEvent[] {
  if (events.length <= max) return events;
  const rank = (e: PayloadEvent): number =>
    e.status === 'removed' ? 0 : e.status === 'possible' ? 1 : 2;
  const dropOrder = [...events].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.deduction ?? 0) - (b.deduction ?? 0) || b.startedAt - a.startedAt
  );
  const dropped = new Set(dropOrder.slice(0, events.length - max).map((e) => e.id));
  return events.filter((e) => !dropped.has(e.id));
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

/**
 * The night condition (§9.4): the clock rule in `tz` — at or past `NIGHT_START_H`, or before
 * `NIGHT_END_H` — falling back to the device-local rule when Intl does not know the zone. The
 * sun's position belongs to the HUD's night mode, not to scoring.
 */
export function nightAt(
  ts: number,
  tz: string,
  constants: { NIGHT_START_H: number; NIGHT_END_H: number }
): boolean {
  const hour = hourIn(ts, tz);
  if (Number.isNaN(hour)) return isNight(new Date(ts));
  return hour >= constants.NIGHT_START_H || hour < constants.NIGHT_END_H;
}

/** A copy of the event with every number finite, so the payload contract holds whatever a detector emitted. */
function sanitizeEvent(e: DetectedEvent, tripStartedAt: number): DetectedEvent {
  const measured: ScorableEvent['measured'] = {};
  for (const [key, value] of Object.entries(e.measured)) {
    if (typeof value !== 'number' || Number.isFinite(value)) {
      (measured as Record<string, unknown>)[key] = value;
    }
  }
  return {
    ...e,
    startedAt: Number.isFinite(e.startedAt) ? Math.round(e.startedAt) : tripStartedAt,
    durationS: Math.max(0, finite(e.durationS)),
    q: clamp(finite(e.q), 0, 1),
    measured,
  };
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
  // The contract carries whole milliseconds; a fractional native clock must not fail the trip.
  const startedAt = Math.round(session.startedAt);

  // Already done: hand back what the first run stored. A trip the server has confirmed, or that
  // is final, is never re-run — that would replace the confirmed result with a provisional one.
  const existing = await trips.get(id);
  if (existing) {
    const settled = existing.status === 'final' || existing.sync_state === 'synced';
    const stored =
      settled || existing.status !== 'recording' ? await findFinalize(db, id) : null;
    if (stored) {
      await samples.purgeByTrip(id);
      return {
        trip: existing,
        events: await events.listByTrip(id),
        scored: stored.provisional,
        payload: stored,
      };
    }
    if (settled) {
      throw new Error(
        `trip ${id} is already ${existing.status}/${existing.sync_state} and no longer queued; it cannot be finalized again`
      );
    }
  } else {
    await trips.insert({ client_trip_id: id, started_at: startedAt, tz, status: 'recording' }, now());
  }

  // 1. Whatever the recorder did not checkpoint is still in the ring; make it durable first.
  const latest = await samples.latest(id);
  const tail = session.rows.filter((r) => r.ts > (latest?.ts ?? Number.NEGATIVE_INFINITY));
  if (tail.length > 0) await samples.appendMany(id, tail.map((row) => ({ ts: row.ts, row })));

  // 2. The durable rows become the trace text, the digest and the metrics.
  const rows = (await samples.range(id, 0, Number.MAX_SAFE_INTEGER)).map(
    (s) => JSON.parse(s.row_json) as FeatureRow
  );
  const traceJson = canonicalJson(rows);
  const recheck = replay(session, rows);

  // 3. Score over what was measured; anything non-finite takes the scorer's grade C path and is
  //    written out as 0 so the trip is kept rather than refused by the contract.
  const merged = mergeEvents(session.events.map((e) => sanitizeEvent(e, startedAt)));
  // Who drove decides whether there is a score at all: `unknown` is unscored as role_unknown.
  const decided = decideRole(session, rows, merged, deps);
  const measured: TripMetrics = {
    distanceM: recheck.distanceM,
    durationS: session.durationS,
    validGnssPct: recheck.validGnssPct,
    imuPresent: imuPresent(rows),
    role: decided.role,
    maxSustainedSpeedMps: recheck.maxSustainedSpeedMps,
  };
  const scored = scoring.scoreTrip(measured, merged);
  const metrics = {
    distanceM: Math.max(0, finite(measured.distanceM)),
    durationS: Math.max(0, finite(measured.durationS)),
    validGnssPct: clamp(finite(measured.validGnssPct), 0, 100),
    maxSustainedSpeedMps: Math.max(0, finite(measured.maxSustainedSpeedMps)),
  };

  // A discarded trip is settled locally and never uploaded: the server would only reject it
  // (§4.4), so it gets no trace file and no queue item. The digest still describes its rows.
  const discarded = scored.status === 'discarded';
  const tracePath = discarded ? null : tracePathFor(id);
  if (tracePath !== null) await deps.fs.writeGzip(tracePath, new TextEncoder().encode(traceJson));
  const sha256 = await deps.hash.sha256(traceJson);
  const rowsDigest: FinalizeTripPayload['rowsDigest'] = {
    count: rows.length,
    validGnssPct: metrics.validGnssPct,
    imuPresent: measured.imuPresent,
    maxSustainedSpeedMps: metrics.maxSustainedSpeedMps,
    sha256,
  };

  // Geometry: the polyline and the events' coordinates share one trimmed track.
  const track = cleanTrack(rows);
  const [from, to] = trimmedRange(track, TRIM_ENDPOINTS_M);
  const polyline = fitPolyline(track.slice(from, to), POLYLINE_EPSILON_M, MAX_POLYLINE_BYTES);
  const locate = (ts: number): LatLng | null => {
    const i = fixIndexAt(track, ts);
    if (i < from || i >= to) return null;
    const fix = track[i] as Fix;
    return { lat: roundCoord(fix.lat), lng: roundCoord(fix.lng) };
  };
  const first = track[0] ?? null;
  const last = track[track.length - 1] ?? null;

  // Conditions and the safe-day flag (§9.9). Night is the clock rule in the trip's zone (§9.4).
  const { CONSTANTS } = scoring;
  const night = nightAt(startedAt, tz, CONSTANTS);
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
  const allEvents: PayloadEvent[] = merged.map((e) => {
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
      context: { night: e.context.night, precipitation: e.context.precipitation },
      contextMultiplier: scoring.contextMultiplier(e),
      severity: Math.max(0, finite(scoring.severity(e))),
      deduction: scored.status === 'final' ? Math.max(0, finite(scored.eventDeductions[e.id] ?? 0)) : null,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      alertShown: alertShown(e),
      source: e.source,
    };
  });

  const endedAt = Math.round(
    session.endedAt ?? (session.lastRowTs !== null ? session.lastRowTs + ROW_MS : startedAt)
  );
  const checkpointTs = session.lastRowTs === null ? null : Math.round(session.lastRowTs);
  const incomplete = deps.incomplete === true;
  const limitCoveragePct =
    session.rowsCount > 0 ? (session.limitKnownRows * 100) / session.rowsCount : 0;
  const payload = FinalizeTripPayloadSchema.parse({
    clientTripId: id,
    startedAt,
    endedAt,
    tz,
    distanceM: metrics.distanceM,
    durationS: metrics.durationS,
    role: decided.role,
    roleConfidence: decided.roleConfidence,
    roleSource: roleSourceFor(session.startEvidence),
    mode: session.mode,
    cameraSession: deps.cameraSession ?? false,
    provisional: scored,
    events: capEvents(allEvents, MAX_EVENTS),
    rowsDigest,
    startGeohash5: first ? geohash5(first.lat, first.lng) : null,
    endGeohash5: last ? geohash5(last.lat, last.lng) : null,
    limitCoveragePct,
    polyline,
    tracePath,
    hadSevereEvent,
    incomplete,
  } satisfies FinalizeTripPayload);

  // 4. One transaction: the events, the trip row, the queue item and the purge commit together,
  //    so no state exists in which the trip says `queued` and nothing is queued.
  const written = await db.transaction(async (tx) => {
    await events.removeByTrip(id, tx);
    const eventRows = await events.insertMany(
      allEvents.map((e) => toNewEvent(e, id)),
      tx
    );
    const trip = await trips.update(
      id,
      {
        started_at: startedAt,
        ended_at: endedAt,
        tz,
        distance_m: metrics.distanceM,
        duration_s: metrics.durationS,
        role: decided.role,
        role_confidence: decided.roleConfidence,
        role_source: roleSourceFor(session.startEvidence),
        mode: session.mode,
        camera_session: payload.cameraSession ? 1 : 0,
        score: scored.score,
        scoring_version: String(scored.scoringVersion),
        category_deductions_json: JSON.stringify(scored.categoryDeductions),
        exposure: scored.exposure,
        data_quality: scored.dataQuality,
        conditions_json: JSON.stringify(conditions),
        limit_coverage_pct: limitCoveragePct,
        start_geohash5: payload.startGeohash5,
        end_geohash5: payload.endGeohash5,
        polyline: polyline === '' ? null : polyline,
        status: tripStatus(scored.status),
        // Nothing to sync for a discarded trip: it is settled the moment it is stored.
        sync_state: discarded ? 'synced' : 'queued',
        checkpoint_ts: checkpointTs,
        incomplete: incomplete ? 1 : 0,
      },
      now(),
      tx
    );
    if (!trip) throw new MissingTripError(id);
    if (!discarded) await enqueueFinalize(db, payload, now(), tx);
    await samples.purgeByTrip(id, tx);
    // The recording's arbiter state has nothing left to resume (N-m4): gone with the samples.
    await createSettingsRepo(tx).remove(arbiterStateKey(id));
    return { trip, eventRows };
  });

  return { trip: written.trip, events: written.eventRows, scored, payload };
}
