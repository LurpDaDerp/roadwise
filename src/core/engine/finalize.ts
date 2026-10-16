// The finalize pipeline (plan §3, §5): the closed session the engine hands over becomes a stored
// drive with a local estimate, a privacy-trimmed route, from/to labels, and one queued upload.
//
//   1. the route is trimmed (zones + first/last 0.25 mi) and the events located on it;
//   2. the v3 payload is built and validated against the upload contract;
//   3. the drive is scored locally with `scoreDrive` and the cached context — an estimate until
//      the server answers;
//   4. ONE transaction replaces the events, updates the trip row (`pending`), queues the upload
//      and purges the samples. It commits or it does not.
// A payload the contract refuses is stored as `failed` (never uploaded, never left `recording`).
// A drive that never moved is not finalized at all: `closeDrive` drops it (nothing stored or queued).
//
// DashPal (plan §8.4): before any of that, the dashcam's facts for the drive are read once (they
// read the samples the transaction purges). Its candidates become severe `eyes_off` / `drowsy`
// events under the scoring rules (once the drive's warm-up is over, at 10 mph or more on a good fix, an eyes-off
// beside a phone event dropped, at most one drowsy per 10 min and one eyes-off per 5 min), and its
// seconds become the payload's `dashcam` block, from which the estimate derives the DashPal bonus
// exactly as the server does.
import {
  DASHCAM_DROWSY_GAP_S,
  DASHCAM_EYES_OFF_GAP_S,
  DASHCAM_MIN_MPH,
  DASHCAM_PHONE_OVERLAP_S,
  NO_EVENTS_FIRST_S,
  dashcamDrive,
  isDashcamType,
  scoreDrive,
  type DashcamEventType,
  type DriveBreakdown,
  type DriveContext,
  type DriveEvent,
} from '@scoring';

import type { DashcamCandidate, DashcamTripFacts } from '@/dashcam/facts';

import { createEventsRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, type Db, type EventRow, type NewEvent, type TripRow } from '@/data/db';
import { deviceTrimSeed } from '@/data/devices/deviceSecret';
import { countEvents } from '@/data/queries/rows';
import {
  FinalizeTripPayloadV3Schema,
  MAX_DRIVE_MS,
  MAX_EVENTS,
  MAX_POLYLINE_BYTES,
  TZ_NAME_PATTERN,
  type DashcamV3,
  type FinalizeTripPayloadV3,
  type PayloadEventV3,
} from '@/data/sync/payload';
import { enqueueFinalize } from '@/data/sync/queue';
import { RUN_SEPARATOR } from '@/lib/polyline';
import { metersToMiles, mpsToMph } from '@/lib/units';
import { dayKey } from '@/lib/time';

import type { TripSession } from './engine.types';
import { expoGeocoder, labelFor, type Geocoder } from './labels';
import { parseZones, PRIVACY_ZONES_KEY, trimRoute, type PrivacyZone } from './privacy';
import { durationSOf } from './session';
import type { DetectedEvent } from './types';

export interface FinalizeDeps {
  db: Db;
  /** IANA zone of the device at finalize: stored on the trip and used for the local day. */
  tz: string;
  now?: () => number;
  appVersion: string;
  /** The privacy zones; default: the settings repo's `privacy.zones`. */
  zones?: () => Promise<PrivacyZone[]>;
  /** Reverse geocoder for the labels; default expo-location. `null`: no geocode (zone names only). */
  geocode?: Geocoder | null;
  /** The cached summary context for the estimate (streak); null when nothing is cached. */
  context?: () => Promise<{ streak: number } | null>;
  /** The per-drive privacy trim seed. Default: `deviceTrimSeed` (HMAC of the SecureStore secret). */
  trimSeed?: (clientTripId: string) => Promise<string>;
  /**
   * What the DashPal dashcam saw on this drive (`loadDashcamTripFacts` in `src/dashcam/facts.ts`).
   * Called once, before the final transaction purges the samples it reads. Absent, or failing: the
   * drive has no DashPal events and no DashPal block.
   */
  dashcamFacts?: (trip: { clientTripId: string; startedAt: number; endedAt: number }) => Promise<DashcamTripFacts>;
}

export interface FinalizeResult {
  trip: TripRow;
  events: EventRow[];
  /** The queued upload, or null when the contract refused the drive (stored as `failed`). */
  payload: FinalizeTripPayloadV3 | null;
  /** The local estimate. */
  breakdown: DriveBreakdown;
}

export const INVALID_PAYLOAD_SYNC_ERROR = 'invalid_payload';
/** The contract's ceiling on `integrity.maxSpeedMph`. */
const MAX_SPEED = 300;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A whole-hour `GMT+5`, `UTC-3`, `GMT+05:00` or `UTC+0500`, the offset forms a phone can report. */
const HOUR_OFFSET_ZONE = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/;

/**
 * The zone a drive can carry: the device's id when it is a zone NAME the contract accepts and Intl
 * knows; a whole-hour offset becomes `Etc/GMT∓H` (the sign is inverted in Etc names); anything
 * else becomes `UTC`. The drive is then always stored, never refused by its own contract.
 */
export function normaliseZone(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return 'UTC';
  let zone = 'UTC';
  if (TZ_NAME_PATTERN.test(raw)) {
    zone = raw;
  } else {
    const m = HOUR_OFFSET_ZONE.exec(raw);
    const hours = m ? Number(m[2]) : NaN;
    const minutes = m?.[3] === undefined ? 0 : Number(m[3]);
    if (m && minutes === 0 && hours === 0) zone = 'UTC';
    else if (m && minutes === 0 && m[1] === '+' && hours <= 14) zone = `Etc/GMT-${hours}`;
    else if (m && minutes === 0 && m[1] === '-' && hours <= 12) zone = `Etc/GMT+${hours}`;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** A lowercase uuid the upload contract (`z.uuid()`) and the server (`apply_drive`) both accept. */
const EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DASHCAM_ID = /^[0-9a-f]{12}$/;
const GAP_MS: Readonly<Record<DashcamEventType, number>> = { drowsy: DASHCAM_DROWSY_GAP_S * 1000, eyes_off: DASHCAM_EYES_OFF_GAP_S * 1000 };

const candidateDuration = (c: DashcamCandidate): number => (Number.isFinite(c.durationS) ? Math.max(0, c.durationS) : 0);

/**
 * The scored DashPal events of a drive from the dashcam's candidates (plan §8.4), in time order:
 * kept only when they start once the drive's warm-up is over (`warmupEndsAt`; default
 * `NO_EVENTS_FIRST_S` after the start) and by its end, at a known
 * GPS speed of `DASHCAM_MIN_MPH` or more (an unknown speed drops it); an eyes-off whose span comes
 * within `DASHCAM_PHONE_OVERLAP_S` of an active phone pickup or handling event is dropped (the
 * phone already charged that look); then at most one drowsy per `DASHCAM_DROWSY_GAP_S` and one
 * eyes-off per `DASHCAM_EYES_OFF_GAP_S`, the earliest kept. A candidate whose id is not a lowercase
 * uuid, or repeats an id already on the drive, is dropped rather than refuse the whole upload.
 */
export function dashcamEvents(
  candidates: readonly DashcamCandidate[],
  trip: { startedAt: number; endedAt: number; warmupEndsAt?: number },
  driveEvents: readonly Pick<DriveEvent, 'id' | 'type' | 'startedAt' | 'durationS' | 'status'>[]
): DetectedEvent[] {
  const earliest = trip.warmupEndsAt ?? trip.startedAt + NO_EVENTS_FIRST_S * 1000;
  const slack = DASHCAM_PHONE_OVERLAP_S * 1000;
  const taken = new Set(driveEvents.map((e) => e.id));
  const phone = driveEvents
    .filter((e) => e.status !== 'removed' && (e.type === 'phone_pickup' || e.type === 'phone_handling'))
    .map((e) => [e.startedAt - slack, e.startedAt + Math.max(0, finite(e.durationS)) * 1000 + slack] as const);
  const eligible = candidates
    .filter((c) => (c.kind === 'eyes_off' || c.kind === 'drowsy') && typeof c.id === 'string' && EVENT_UUID.test(c.id) && !taken.has(c.id))
    .filter((c) => Number.isFinite(c.startedAt) && c.startedAt >= earliest && c.startedAt <= trip.endedAt)
    .filter((c) => c.speedMph !== null && Number.isFinite(c.speedMph) && c.speedMph >= DASHCAM_MIN_MPH)
    .filter((c) => {
      if (c.kind !== 'eyes_off') return true;
      const end = c.startedAt + candidateDuration(c) * 1000;
      return !phone.some(([from, to]) => c.startedAt <= to && end >= from);
    })
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lastKept: Partial<Record<DashcamEventType, number>> = {};
  const out: DetectedEvent[] = [];
  for (const c of eligible) {
    const prev = lastKept[c.kind];
    if (taken.has(c.id) || (prev !== undefined && c.startedAt - prev < GAP_MS[c.kind])) continue;
    lastKept[c.kind] = c.startedAt;
    taken.add(c.id);
    out.push({
      id: c.id,
      type: c.kind,
      tier: 'severe',
      startedAt: Math.round(c.startedAt),
      durationS: candidateDuration(c),
      measured: { source: 'dashcam', speedMph: c.speedMph as number },
    });
  }
  return out;
}

/**
 * The payload's `dashcam` block from the facts: present only when a paired dashcam covered some of
 * the drive (`dashcamId` non-null and a 12-hex id), whole seconds clamped into the contract
 * (moving ≤ 12 h, covered ≤ moving). Anything else: null, and the drive is simply not a DashPal one.
 */
export function dashcamBlock(facts: DashcamTripFacts | null): DashcamV3 | null {
  if (facts === null || typeof facts.dashcamId !== 'string') return null;
  const deviceId = facts.dashcamId.toLowerCase();
  if (!DASHCAM_ID.test(deviceId)) return null;
  const movingS = clamp(Math.floor(finite(facts.movingS)), 0, MAX_DRIVE_MS / 1000);
  const coveredS = clamp(Math.floor(finite(facts.coveredS)), 0, movingS);
  return { deviceId, movingS, coveredS, synced: facts.synced === true };
}

/** A copy of the event with every number finite and rounded, so the contract holds whatever a detector emitted. */
export function sanitizeEvent(e: DetectedEvent, tripStartedAt: number, tripEndedAt: number): DetectedEvent {
  const startedAt = clamp(Number.isFinite(e.startedAt) ? Math.round(e.startedAt) : tripStartedAt, tripStartedAt, tripEndedAt);
  const maxDuration = Math.max(0, (tripEndedAt - startedAt) / 1000 + 2);
  const measured: DetectedEvent['measured'] = {};
  if (typeof e.measured.speedMph === 'number' && Number.isFinite(e.measured.speedMph)) measured.speedMph = clamp(round3(e.measured.speedMph), 0, 250);
  if (typeof e.measured.limitMph === 'number' && Number.isFinite(e.measured.limitMph)) measured.limitMph = clamp(Math.round(e.measured.limitMph), 0, 120);
  if (typeof e.measured.peakG === 'number' && Number.isFinite(e.measured.peakG)) measured.peakG = clamp(round3(e.measured.peakG), 0, 10);
  if (typeof e.measured.mounted === 'boolean') measured.mounted = e.measured.mounted;
  // The contract's rule: a DashPal event carries source dashcam, and nothing else does.
  if (isDashcamType(e.type)) measured.source = 'dashcam';
  const out: DetectedEvent = {
    id: e.id,
    type: e.type,
    tier: e.tier,
    startedAt,
    durationS: clamp(round3(finite(e.durationS)), 0, maxDuration),
    measured,
  };
  if (e.type === 'phone_handling') out.units = clamp(Math.floor(finite(e.units ?? 1, 1)), 1, 1440);
  if (e.type === 'phone_pickup' && e.stoppedInTraffic === true) out.stoppedInTraffic = true;
  return out;
}

/** Safe miles already credited today before this drive, from the device's own rows. */
export async function safeMilesEarlierToday(db: Db, localDay: string, startedAt: number): Promise<number> {
  const { rows } = await db.execute(
    `SELECT COALESCE(SUM(safe_miles), 0) AS n FROM trips
      WHERE local_day = ? AND started_at < ? AND status IN ('scored', 'pending')`,
    [localDay, startedAt]
  );
  const n = rows[0]?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

const toNewEvent = (e: PayloadEventV3, clientTripId: string, penalty: number | null): NewEvent => ({
  id: e.id,
  client_trip_id: clientTripId,
  type: e.type,
  tier: e.tier,
  started_at: e.startedAt,
  duration_s: e.durationS,
  units: e.units ?? null,
  stopped_in_traffic: e.stoppedInTraffic === true ? 1 : 0,
  lat: e.lat,
  lng: e.lng,
  measured_json: JSON.stringify(e.measured),
  penalty,
  status: 'active',
  dispute_status: 'none',
});

async function readZones(db: Db): Promise<PrivacyZone[]> {
  try {
    return parseZones(await createSettingsRepo(db).get<unknown>(PRIVACY_ZONES_KEY));
  } catch {
    return [];
  }
}

/**
 * Why a closed drive is not kept: `no_gps` when it never had a valid fix, `no_movement` when the
 * car never moved (`session.ts` "Movement"), whatever ended it. Null: the drive is kept.
 */
export type DropReason = 'no_movement' | 'no_gps';

export function dropReason(session: Pick<TripSession, 'moved' | 'validGnssRows'>): DropReason | null {
  if (session.moved !== null) return null;
  return session.validGnssRows === 0 ? 'no_gps' : 'no_movement';
}

/** A drive that was not kept: nothing stored, uploaded or scored. */
export interface DroppedResult {
  dropped: DropReason;
  clientTripId: string;
}

/**
 * Delete a drive that is not kept, in one transaction: its samples, events and DashPal coverage,
 * then the trip row, but only while that row is still `recording` (a finalized drive is never
 * deleted). Nothing is queued. Returns false when a finalized row stood in the way.
 */
export async function dropTrip(db: Db, clientTripId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const trip = await createTripsRepo(db).get(clientTripId, tx);
    if (trip !== null && trip.status !== 'recording') return false;
    await tx.execute('DELETE FROM samples WHERE client_trip_id = ?', [clientTripId]);
    await tx.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [clientTripId]);
    await tx.execute('DELETE FROM dashcam_coverage WHERE client_trip_id = ?', [clientTripId]);
    await tx.execute("DELETE FROM trips WHERE client_trip_id = ? AND status = 'recording'", [clientTripId]);
    return true;
  });
}

/**
 * The end of every drive: one that never moved is dropped (`dropTrip`), any other is finalized
 * (`finalizeTrip`). A retry after a drop finds nothing and drops again; a drive somehow already
 * finalized under the same id is handed back as stored, never deleted.
 */
export async function closeDrive(session: Readonly<TripSession>, deps: FinalizeDeps): Promise<FinalizeResult | DroppedResult> {
  const reason = dropReason(session);
  if (reason !== null && (await dropTrip(deps.db, session.clientTripId))) return { dropped: reason, clientTripId: session.clientTripId };
  return finalizeTrip(session, deps);
}

export const isDropped = (r: FinalizeResult | DroppedResult): r is DroppedResult => 'dropped' in r;

export async function finalizeTrip(session: Readonly<TripSession>, deps: FinalizeDeps): Promise<FinalizeResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const tz = normaliseZone(deps.tz);
  const trips = createTripsRepo(db);
  const events = createEventsRepo(db);
  const samples = createSamplesRepo(db);
  const id = session.clientTripId;
  const startedAt = Math.round(session.startedAt);
  const endedAt = Math.round(session.endedAt ?? (session.lastRowTs !== null ? session.lastRowTs + 1000 : startedAt + 1000));
  const localDay = dayKey(new Date(startedAt), tz);

  // Already finalized (a retried call): hand back what is stored, never re-run.
  const existing = await trips.get(id);
  if (existing !== null && existing.status !== 'recording') {
    return {
      trip: existing,
      events: await events.listByTrip(id),
      payload: null,
      breakdown: existing.breakdown_json ? (JSON.parse(existing.breakdown_json) as DriveBreakdown) : scoreDrive({ miles: 0, safeMiles: 0, events: [] }, { streak: 0, safeMilesEarlierToday: 0 }),
    };
  }
  if (existing === null) {
    await trips.insert({ client_trip_id: id, started_at: startedAt, tz, local_day: localDay, status: 'recording', continues: session.warmup.continues ? 1 : 0 }, now());
  }

  // 0. What the DashPal dashcam saw: read before the transaction below purges the samples.
  const facts = deps.dashcamFacts ? await deps.dashcamFacts({ clientTripId: id, startedAt, endedAt }).catch(() => null) : null;
  const dashcam = dashcamBlock(facts);

  // 1. The route and the events on it.
  const zones = await (deps.zones ?? (() => readZones(db)))();
  const route = trimRoute(session.track, zones, MAX_POLYLINE_BYTES, await (deps.trimSeed ?? deviceTrimSeed)(id));
  // Every visible run, space-joined: the server sums them and the maps draw them apart.
  const polyline = route.runs.join(RUN_SEPARATOR);
  const geocode = deps.geocode === undefined ? expoGeocoder : deps.geocode;
  const [fromLabel, toLabel] = await Promise.all([labelFor(session.firstFix, zones, geocode), labelFor(session.lastFix, zones, geocode)]);

  const phoneEvents = session.events.filter((e) => e.startedAt < endedAt + 2000).map((e) => sanitizeEvent(e, startedAt, endedAt));
  const fromDashcam = dashcamEvents(facts?.events ?? [], { startedAt, endedAt, warmupEndsAt: session.warmup.endsAt }, phoneEvents).map((e) => sanitizeEvent(e, startedAt, endedAt));
  const cleaned = [...phoneEvents, ...fromDashcam]
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_EVENTS);
  const payloadEvents: PayloadEventV3[] = cleaned.map((e) => {
    const at = route.locate(e.startedAt);
    const out: PayloadEventV3 = {
      id: e.id,
      type: e.type,
      tier: e.tier,
      startedAt: e.startedAt,
      durationS: e.durationS,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      measured: e.measured,
    };
    if (e.units !== undefined) out.units = e.units;
    if (e.stoppedInTraffic === true) out.stoppedInTraffic = true;
    return out;
  });

  // 2. The metrics and the payload.
  const miles = round3(clamp(metersToMiles(finite(session.distanceM)), 0, 1000));
  const safeMiles = round3(clamp(metersToMiles(finite(session.safeDistanceM)), 0, miles));
  const nightMiles = round3(clamp(metersToMiles(finite(session.nightDistanceM)), 0, miles));
  const durationS = round3(durationSOf({ startedAt, endedAt }));
  const maxSpeedMph = round3(clamp(mpsToMph(finite(session.maxSpeedMps)), 0, MAX_SPEED));
  const validGnssPct = session.rowsCount > 0 ? round3(clamp((session.validGnssRows * 100) / session.rowsCount, 0, 100)) : 0;
  const integrity = {
    mockLocation: session.mockRows > 0,
    motionMismatch: session.movingRows >= 60 && session.imuActiveRows < 0.05 * session.movingRows,
    validGnssPct,
    maxSpeedMph,
  };
  const point = (f: { lat: number; lng: number } | null) => (f === null ? null : { lat: round4(f.lat), lng: round4(f.lng) });
  const candidate = {
    v: 3 as const,
    clientTripId: id,
    startedAt,
    endedAt,
    tz,
    localDay,
    miles,
    safeMiles,
    nightMiles,
    durationS,
    start: point(session.firstFix),
    end: point(session.lastFix),
    polyline,
    integrity,
    events: payloadEvents,
    appVersion: deps.appVersion.slice(0, 32) || 'unknown',
    ...(dashcam === null ? {} : { dashcam }),
  };
  const parsed = FinalizeTripPayloadV3Schema.safeParse(candidate);

  // 3. The local estimate.
  const streak = (await deps.context?.().catch(() => null))?.streak ?? 0;
  const ctx: DriveContext = { streak, safeMilesEarlierToday: await safeMilesEarlierToday(db, localDay, startedAt) };
  const driveEvents: DriveEvent[] = cleaned.map(({ measured: _m, ...e }) => e);
  // The same derivation as the server's: the DashPal bonus from the block's seconds.
  const breakdown = scoreDrive({ miles, safeMiles, events: driveEvents, dashcam: dashcamDrive(dashcam) }, ctx);
  const penaltyOf = new Map(breakdown.events.map((e) => [e.id, e.penalty]));
  const counts = countEvents(cleaned);

  const patch = {
    started_at: startedAt,
    ended_at: endedAt,
    tz,
    local_day: localDay,
    miles,
    safe_miles: safeMiles,
    night_miles: nightMiles,
    duration_s: durationS,
    start_lat: candidate.start?.lat ?? null,
    start_lng: candidate.start?.lng ?? null,
    end_lat: candidate.end?.lat ?? null,
    end_lng: candidate.end?.lng ?? null,
    polyline: polyline === '' ? null : polyline,
    from_label: fromLabel,
    to_label: toLabel,
    max_speed_mph: maxSpeedMph,
    integrity_json: JSON.stringify(integrity),
    points_net: breakdown.scored ? breakdown.net : null,
    estimate: 1 as const,
    breakdown_json: JSON.stringify(breakdown),
    clean: breakdown.scored ? (breakdown.activeEventCount === 0 ? 1 : 0) : null,
    counts_json: JSON.stringify(counts),
    reason: breakdown.scored ? null : (breakdown.reason ?? null),
    checkpoint_ts: null,
  } as const;

  // 4. One transaction.
  const written = await db.transaction(async (tx) => {
    await events.removeByTrip(id, tx);
    const eventRows = await events.insertMany(
      payloadEvents.map((e) => toNewEvent(e, id, penaltyOf.get(e.id) ?? null)),
      tx
    );
    const trip = await trips.update(
      id,
      parsed.success
        ? { ...patch, status: 'pending', sync_error: null }
        : { ...patch, status: 'failed', sync_error: INVALID_PAYLOAD_SYNC_ERROR },
      now(),
      tx
    );
    if (!trip) throw new Error(`trip ${id} vanished before finalize`);
    if (parsed.success) await enqueueFinalize(db, parsed.data, now(), tx);
    await samples.purgeByTrip(id, tx);
    return { trip, eventRows };
  });

  return { trip: written.trip, events: written.eventRows, payload: parsed.success ? parsed.data : null, breakdown };
}
