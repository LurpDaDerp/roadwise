// The finalize pipeline (modes plan §3.5, §3.11; phone plan P5): the closed session the engine hands
// over becomes a stored drive with a privacy-trimmed route, from/to labels, its opportunity counters
// and one queued upload.
//
//   1. the route is trimmed (zones + first/last 0.25 mi) and the events located on it;
//   2. the v5 payload is built and validated against the upload contract (how the drive started,
//      whether its "Not driving?" ran out, its exposure with the phone seconds, its phone pickups);
//   3. the drive is classified (`classifyDrive`: scored, or too short; the events that break clean);
//   4. ONE transaction replaces the events, updates the trip row (`pending`, `finalized_at`), queues
//      the upload (due at once), and sweeps the samples of every finished drive, this one's too:
//      they only ever served a relaunch mid-drive. It commits or it does not.
// A payload the contract refuses is stored as `failed` (never uploaded, never left `recording`).
// A drive that never moved, or never reached driving speed, and a Start-card drive too short to
// score, is not finalized at all: `closeDrive` drops it (nothing stored or queued).
//
// DashPal: before any of that, the dashcam's facts for the drive are read once. Its candidates
// become severe `eyes_off` / `drowsy` events under the scoring rules (inside the drive, at 10 mph or
// more on a good fix; every such episode counts), and its seconds become the payload's `dashcam`
// block.
import {
  classifyDrive,
  DASHCAM_MIN_MPH,
  isDashcamType,
  phonePickupTier,
  tooShort,
  watchedMiles,
  type DriveClass,
  type DriveEvent,
  type Exposure,
} from '@scoring';

import type { DashcamCandidate, DashcamTripFacts } from '@/dashcam/facts';

import { createEventsRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, type Db, type EventRow, type NewEvent, type TripRow } from '@/data/db';
import { deviceTrimSeed } from '@/data/devices/deviceSecret';
import { countEvents } from '@/data/queries/rows';
import {
  FinalizeTripPayloadV5Schema,
  MAX_DRIVE_MS,
  MAX_EVENTS,
  MAX_POLYLINE_BYTES,
  TZ_NAME_PATTERN,
  type FinalizeTripPayloadV5,
  type PayloadDashcam,
  type PayloadEvent,
} from '@/data/sync/payload';
import { enqueueFinalize } from '@/data/sync/queue';
import { RUN_SEPARATOR } from '@/lib/polyline';
import { metersToMiles, mpsToMph } from '@/lib/units';
import { dayKey } from '@/lib/time';

import type { TripSession } from './engine.types';
import { closeExposure } from './exposure';
import { expoGeocoder, labelFor, startPoint, type Geocoder } from './labels';
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
  /** The per-drive privacy trim seed. Default: `deviceTrimSeed` (HMAC of the SecureStore secret). */
  trimSeed?: (clientTripId: string) => Promise<string>;
  /**
   * The drive's in-drive "Not driving?" ran out (the host's budget). Also read from the trip row
   * (`not_driving_expired`, written the moment it ran out); either one marks the drive.
   */
  notDrivingExpired?: boolean;
  /**
   * What the DashPal dashcam saw on this drive (`loadDashcamTripFacts` in `src/dashcam/facts.ts`).
   * Called once, before the final transaction. Absent, or failing: the drive has no DashPal events
   * and no DashPal block.
   */
  dashcamFacts?: (trip: { clientTripId: string; startedAt: number; endedAt: number }) => Promise<DashcamTripFacts>;
}

export interface FinalizeResult {
  trip: TripRow;
  events: EventRow[];
  /** The queued (held) upload, or null when the contract refused the drive (stored as `failed`). */
  payload: FinalizeTripPayloadV5 | null;
  /** Whether it scores and how many events break clean. */
  drive: DriveClass;
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

const candidateDuration = (c: DashcamCandidate): number => (Number.isFinite(c.durationS) ? Math.max(0, c.durationS) : 0);

/**
 * The scored DashPal events of a drive from the dashcam's candidates (each one episode, alerts within
 * 60 s of each other joined), in time order: every one that starts inside the drive (from its start,
 * no warm-up) at a known GPS speed of `DASHCAM_MIN_MPH` or more (an unknown speed drops it). A
 * candidate whose id is not a lowercase uuid, or repeats an id already on the drive, is dropped
 * rather than refuse the whole upload.
 */
export function dashcamEvents(
  candidates: readonly DashcamCandidate[],
  trip: { startedAt: number; endedAt: number },
  driveEvents: readonly Pick<DriveEvent, 'id' | 'type' | 'startedAt' | 'durationS' | 'status'>[]
): DetectedEvent[] {
  const taken = new Set(driveEvents.map((e) => e.id));
  const eligible = candidates
    .filter((c) => (c.kind === 'eyes_off' || c.kind === 'drowsy') && typeof c.id === 'string' && EVENT_UUID.test(c.id) && !taken.has(c.id))
    .filter((c) => Number.isFinite(c.startedAt) && c.startedAt >= trip.startedAt && c.startedAt <= trip.endedAt)
    .filter((c) => c.speedMph !== null && Number.isFinite(c.speedMph) && c.speedMph >= DASHCAM_MIN_MPH)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: DetectedEvent[] = [];
  for (const c of eligible) {
    if (taken.has(c.id)) continue;
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
export function dashcamBlock(facts: DashcamTripFacts | null): PayloadDashcam | null {
  if (facts === null || typeof facts.dashcamId !== 'string') return null;
  const deviceId = facts.dashcamId.toLowerCase();
  if (!DASHCAM_ID.test(deviceId)) return null;
  const movingS = clamp(Math.floor(finite(facts.movingS)), 0, MAX_DRIVE_MS / 1000);
  const coveredS = clamp(Math.floor(finite(facts.coveredS)), 0, movingS);
  return { deviceId, movingS, coveredS, synced: facts.synced === true };
}

/** The contract's ceiling on `measured.overMphS` (mph-seconds past the speeding line). */
const MAX_OVER_MPH_S = 1e6;

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A copy of the event with every number finite and rounded, so the contract holds whatever a
 * detector emitted. A phone pickup keeps whole seconds in hand, at least 1 and at most the drive's
 * (rounded) length and its own span to the end, with the tier they make.
 */
export function sanitizeEvent(e: DetectedEvent, tripStartedAt: number, tripEndedAt: number): DetectedEvent {
  const startedAt = clamp(Number.isFinite(e.startedAt) ? Math.round(e.startedAt) : tripStartedAt, tripStartedAt, tripEndedAt);
  const maxDuration = Math.max(0, (tripEndedAt - startedAt) / 1000 + 2);
  const measured: DetectedEvent['measured'] = {};
  const m = e.measured;
  if (finiteNumber(m.speedMph)) measured.speedMph = clamp(round3(m.speedMph), 0, 250);
  if (finiteNumber(m.maxSpeedMph) && e.type === 'phone_pickup') measured.maxSpeedMph = clamp(round3(m.maxSpeedMph), 0, 250);
  if (finiteNumber(m.limitMph)) measured.limitMph = clamp(Math.round(m.limitMph), 0, 120);
  if (finiteNumber(m.peakG)) measured.peakG = clamp(round3(m.peakG), 0, 10);
  if (finiteNumber(m.overMphS)) measured.overMphS = clamp(round3(m.overMphS), 0, MAX_OVER_MPH_S);
  // The contract's rule: a DashPal event carries source dashcam, and nothing else does.
  if (isDashcamType(e.type)) measured.source = 'dashcam';
  if (e.type === 'phone_pickup') {
    const most = Math.max(1, Math.min(Math.floor(maxDuration), Math.round(round3((tripEndedAt - tripStartedAt) / 1000))));
    const durationS = clamp(Math.round(finite(e.durationS, 1)), 1, most);
    return { id: e.id, type: e.type, tier: phonePickupTier(durationS), startedAt, durationS, measured };
  }
  return {
    id: e.id,
    type: e.type,
    tier: e.tier,
    startedAt,
    durationS: clamp(round3(finite(e.durationS)), 0, maxDuration),
    measured,
  };
}

/**
 * The counters held to what the drive itself allows, exactly as the server holds them
 * (`apply_drive`), so the phone's own reading is the server's: moving time within the drive's
 * length (and 12 h) and within ceil(miles × 720 × 1.25) + 60 s, limit time and phone time each
 * within moving time and within ceil(miles × 360 × 1.25) + 60 s (moving time accrues at 5 mph or
 * more, 720 s a mile at most; limit and phone time at 10 mph or more, 360 s a mile at most), a
 * slowdown or a speed-up per 15 s of moving and a turn per 10 s (at least one each), and no count
 * above 40 a mile. The server takes the time caps in double precision in this same order, so both
 * cut to the same second. Pure.
 */
export function boundExposure(e: Exposure, durationS: number, miles: number): Exposure {
  const whole = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const mi = Math.max(0, Number.isFinite(miles) ? miles : 0);
  const movingS = Math.min(whole(durationS), 43_200, Math.ceil(mi * 720 * 1.25) + 60, whole(e.movingS));
  const cap = Math.min(20_000, Math.ceil(mi * 40));
  const swings = Math.max(1, Math.ceil(movingS / 15));
  return {
    slowdowns: Math.min(cap, swings, whole(e.slowdowns)),
    speedups: Math.min(cap, swings, whole(e.speedups)),
    turns: Math.min(cap, Math.max(1, Math.ceil(movingS / 10)), whole(e.turns)),
    limitS: Math.min(movingS, Math.ceil(mi * 360 * 1.25) + 60, whole(e.limitS)),
    movingS,
    phoneS: Math.min(movingS, Math.ceil(mi * 360 * 1.25) + 60, whole(e.phoneS)),
  };
}

/**
 * The drive's opportunity counters as uploaded and stored: the session's (its mark's, for a cut
 * drive) with the open swing settled (`closeExposure`), then held to the drive (`boundExposure`).
 */
export function exposureOf(session: Pick<TripSession, 'exposure' | 'movingRows'>, durationS: number, miles: number): Exposure {
  return boundExposure(closeExposure(session.exposure, session.movingRows), durationS, miles);
}

const toNewEvent = (e: PayloadEvent, clientTripId: string): NewEvent => ({
  id: e.id,
  client_trip_id: clientTripId,
  type: e.type,
  tier: e.tier,
  started_at: e.startedAt,
  duration_s: e.durationS,
  lat: e.lat,
  lng: e.lng,
  measured_json: JSON.stringify(e.measured),
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
 * Why a closed drive is not kept, whatever ended it: `no_gps` when it never had a valid fix,
 * `no_movement` when the car never moved (`session.ts` "Movement"), `not_driven` when it moved but
 * never reached driving speed (`session.droveAt`: two consecutive trusted readings of 10 mph or
 * more), so a walk or a jog with a drive open earns nothing; `too_short` for a Start-card drive
 * (`manualTooShort`). `cancelled` is never a finalize's: it is the host's "Not driving?"
 * (`src/drive/host.ts`). Null: the drive is kept.
 */
export type DropReason = 'no_movement' | 'no_gps' | 'not_driven' | 'too_short' | 'cancelled';

export function dropReason(session: Pick<TripSession, 'moved' | 'validGnssRows' | 'droveAt'>): Exclude<DropReason, 'cancelled' | 'too_short'> | null {
  if (session.validGnssRows === 0) return 'no_gps';
  if (session.moved === null) return 'no_movement';
  return session.droveAt === null ? 'not_driven' : null;
}

/** When a closed drive ended: its end, else a second after its last row (or its start). */
const endedAtOf = (session: Pick<TripSession, 'startedAt' | 'endedAt' | 'lastRowTs'>): number =>
  Math.round(session.endedAt ?? (session.lastRowTs !== null ? session.lastRowTs + 1000 : Math.round(session.startedAt) + 1000));

/** The drive's miles as the payload states them. */
const milesOf = (session: Pick<TripSession, 'distanceM'>): number => round3(clamp(metersToMiles(finite(session.distanceM)), 0, 1000));

/**
 * A drive started from the Start card that is too short to score is not kept at all (`tooShort`):
 * under `MIN_SCORED_MILES` on the miles the payload would state AND under `MIN_SCORED_S` from the
 * car's first movement (`session.firstMovingAt`, the first row at `MOVING_MIN_MPH` or more) to its
 * end, so the wait before it never counts (the drive's own start stays the tap). An automatic one
 * is kept unscored.
 */
export function manualTooShort(
  session: Pick<TripSession, 'origin' | 'distanceM' | 'startedAt' | 'endedAt' | 'lastRowTs' | 'firstMovingAt'>
): boolean {
  if (session.origin !== 'manual') return false;
  const movingFrom = session.firstMovingAt === null ? null : Math.round(session.firstMovingAt);
  const movingS = movingFrom === null ? 0 : durationSOf({ startedAt: movingFrom, endedAt: endedAtOf(session) });
  return tooShort(milesOf(session), round3(movingS));
}

/** A drive that was not kept: nothing stored, uploaded or scored. */
export interface DroppedResult {
  dropped: Exclude<DropReason, 'cancelled'>;
  clientTripId: string;
}

/**
 * Delete a drive that is not kept, in one transaction: its samples, events and DashPal coverage,
 * then the trip row, but only while that row is still `recording` (a finalized drive is never
 * deleted). Nothing is queued.
 * Returns false when a finalized row stood in the way.
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
 * The end of every drive: one that never moved or never reached driving speed, and a Start-card
 * drive too short to score, is dropped (`dropTrip`), any other is finalized (`finalizeTrip`). A
 * retry after a drop finds nothing and drops again; a drive somehow already finalized under the
 * same id is handed back as stored, never deleted.
 */
export async function closeDrive(session: Readonly<TripSession>, deps: FinalizeDeps): Promise<FinalizeResult | DroppedResult> {
  const reason = dropReason(session) ?? (manualTooShort(session) ? 'too_short' : null);
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
  const endedAt = endedAtOf(session);
  const localDay = dayKey(new Date(startedAt), tz);

  // Already finalized (a retried call): hand back what is stored, never re-run.
  const existing = await trips.get(id);
  if (existing !== null && existing.status !== 'recording') {
    const stored = await events.listByTrip(id);
    return {
      trip: existing,
      events: stored,
      payload: null,
      drive: classifyDrive({ miles: existing.miles, durationS: existing.duration_s, events: stored }),
    };
  }
  if (existing === null) {
    await trips.insert(
      {
        client_trip_id: id,
        started_at: startedAt,
        tz,
        local_day: localDay,
        status: 'recording',
        continues: session.warmup.continues ? 1 : 0,
        origin: session.origin,
        start_source: session.startSource,
      },
      now()
    );
  }
  const notDrivingExpired = deps.notDrivingExpired === true || existing?.not_driving_expired === 1;

  // 0. What the DashPal dashcam saw.
  const facts = deps.dashcamFacts ? await deps.dashcamFacts({ clientTripId: id, startedAt, endedAt }).catch(() => null) : null;
  const dashcam = dashcamBlock(facts);

  // 1. The route and the events on it.
  const zones = await (deps.zones ?? (() => readZones(db)))();
  const route = trimRoute(session.track, zones, MAX_POLYLINE_BYTES, await (deps.trimSeed ?? deviceTrimSeed)(id));
  // Every visible run, space-joined: the server sums them and the maps draw them apart.
  const polyline = route.runs.join(RUN_SEPARATOR);
  const geocode = deps.geocode === undefined ? expoGeocoder : deps.geocode;
  const from = startPoint(session);
  const [fromLabel, toLabel] = await Promise.all([labelFor(from, zones, geocode), labelFor(session.lastFix, zones, geocode)]);

  const phoneEvents = session.events.filter((e) => e.startedAt < endedAt + 2000).map((e) => sanitizeEvent(e, startedAt, endedAt));
  const fromDashcam = dashcamEvents(facts?.events ?? [], { startedAt, endedAt }, phoneEvents).map((e) => sanitizeEvent(e, startedAt, endedAt));
  const cleaned = [...phoneEvents, ...fromDashcam]
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_EVENTS);
  const payloadEvents: PayloadEvent[] = cleaned.map((e) => {
    const at = route.locate(e.startedAt);
    return {
      id: e.id,
      type: e.type,
      tier: e.tier,
      startedAt: e.startedAt,
      durationS: e.durationS,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      measured: e.measured,
    };
  });

  // 2. The metrics and the payload.
  const miles = milesOf(session);
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
  const exposure = exposureOf(session, durationS, miles);
  const point = (f: { lat: number; lng: number } | null) => (f === null ? null : { lat: round4(f.lat), lng: round4(f.lng) });
  const candidate = {
    v: 5 as const,
    clientTripId: id,
    startedAt,
    endedAt,
    tz,
    localDay,
    miles,
    nightMiles,
    durationS,
    // where the drive started and ended never leaves the phone: the route is trimmed to hide them
    start: null,
    end: null,
    polyline,
    integrity,
    events: payloadEvents,
    appVersion: deps.appVersion.slice(0, 32) || 'unknown',
    origin: session.origin,
    notDrivingExpired,
    exposure,
    ...(dashcam === null ? {} : { dashcam }),
  };
  const parsed = FinalizeTripPayloadV5Schema.safeParse(candidate);

  // 3. What the drive is: scored or too short, and the events that break clean.
  const drive = classifyDrive({ miles, durationS, events: cleaned });
  const counts = countEvents(cleaned);
  const stamp = now();
  const start = point(from);
  const end = point(session.lastFix);

  const patch = {
    started_at: startedAt,
    ended_at: endedAt,
    tz,
    local_day: localDay,
    miles,
    night_miles: nightMiles,
    watched_miles: dashcam === null ? 0 : watchedMiles(miles, dashcam.movingS, dashcam.coveredS),
    duration_s: durationS,
    start_lat: start?.lat ?? null,
    start_lng: start?.lng ?? null,
    end_lat: end?.lat ?? null,
    end_lng: end?.lng ?? null,
    polyline: polyline === '' ? null : polyline,
    from_label: fromLabel,
    to_label: toLabel,
    max_speed_mph: maxSpeedMph,
    integrity_json: JSON.stringify(integrity),
    clean: drive.scored ? (drive.activeEventCount === 0 ? 1 : 0) : null,
    counts_json: JSON.stringify(counts),
    reason: drive.reason,
    checkpoint_ts: null,
    origin: session.origin,
    not_driving_expired: notDrivingExpired ? 1 : 0,
    start_source: session.startSource,
    finalized_at: stamp,
    slowdowns: exposure.slowdowns,
    speedups: exposure.speedups,
    turns: exposure.turns,
    limit_s: exposure.limitS,
    moving_s: exposure.movingS,
    phone_s: exposure.phoneS,
    // Local only (the summary's end note); a manual end cut at the last movement is `manual_still`.
    end_cause: session.endCause === null ? null : session.endCause === 'manual' && session.cut ? 'manual_still' : session.endCause,
  } as const;

  // 4. One transaction.
  const written = await db.transaction(async (tx) => {
    await events.removeByTrip(id, tx);
    const eventRows = await events.insertMany(
      payloadEvents.map((e) => toNewEvent(e, id)),
      tx
    );
    const trip = await trips.update(
      id,
      parsed.success
        ? { ...patch, status: 'pending', sync_error: null }
        : { ...patch, status: 'failed', sync_error: INVALID_PAYLOAD_SYNC_ERROR },
      stamp,
      tx
    );
    if (!trip) throw new Error(`trip ${id} vanished before finalize`);
    if (parsed.success) await enqueueFinalize(db, parsed.data, stamp, tx);
    // A finished drive needs no samples (they rebuild a drive under way): this one's go too.
    await samples.purgeFinished(tx);
    return { trip, eventRows };
  });

  return { trip: written.trip, events: written.eventRows, payload: parsed.success ? parsed.data : null, drive };
}
