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
import { scoreDrive, type DriveBreakdown, type DriveContext, type DriveEvent } from '@scoring';

import { createEventsRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, type Db, type EventRow, type NewEvent, type TripRow } from '@/data/db';
import { deviceTrimSeed } from '@/data/devices/deviceSecret';
import { countEvents } from '@/data/queries/rows';
import {
  FinalizeTripPayloadV3Schema,
  MAX_EVENTS,
  MAX_POLYLINE_BYTES,
  TZ_NAME_PATTERN,
  type FinalizeTripPayloadV3,
  type PayloadEventV3,
} from '@/data/sync/payload';
import { enqueueFinalize } from '@/data/sync/queue';
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

/** A copy of the event with every number finite and rounded, so the contract holds whatever a detector emitted. */
export function sanitizeEvent(e: DetectedEvent, tripStartedAt: number, tripEndedAt: number): DetectedEvent {
  const startedAt = clamp(Number.isFinite(e.startedAt) ? Math.round(e.startedAt) : tripStartedAt, tripStartedAt, tripEndedAt);
  const maxDuration = Math.max(0, (tripEndedAt - startedAt) / 1000 + 2);
  const measured: DetectedEvent['measured'] = {};
  if (typeof e.measured.speedMph === 'number' && Number.isFinite(e.measured.speedMph)) measured.speedMph = clamp(round3(e.measured.speedMph), 0, 250);
  if (typeof e.measured.limitMph === 'number' && Number.isFinite(e.measured.limitMph)) measured.limitMph = clamp(Math.round(e.measured.limitMph), 0, 120);
  if (typeof e.measured.peakG === 'number' && Number.isFinite(e.measured.peakG)) measured.peakG = clamp(round3(e.measured.peakG), 0, 10);
  if (typeof e.measured.mounted === 'boolean') measured.mounted = e.measured.mounted;
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
      breakdown: existing.breakdown_json ? (JSON.parse(existing.breakdown_json) as DriveBreakdown) : scoreDrive({ miles: 0, safeMiles: 0, events: [], dmsOn: false }, { streak: 0, safeMilesEarlierToday: 0 }),
    };
  }
  if (existing === null) {
    await trips.insert({ client_trip_id: id, started_at: startedAt, tz, local_day: localDay, status: 'recording', dms_on: session.dmsOn ? 1 : 0 }, now());
  }

  // 1. The route and the events on it.
  const zones = await (deps.zones ?? (() => readZones(db)))();
  const route = trimRoute(session.track, zones, MAX_POLYLINE_BYTES, await (deps.trimSeed ?? deviceTrimSeed)(id));
  const geocode = deps.geocode === undefined ? expoGeocoder : deps.geocode;
  const [fromLabel, toLabel] = await Promise.all([labelFor(session.firstFix, zones, geocode), labelFor(session.lastFix, zones, geocode)]);

  const cleaned = session.events
    .filter((e) => e.startedAt < endedAt + 2000)
    .map((e) => sanitizeEvent(e, startedAt, endedAt))
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
    dmsOn: session.dmsOn,
    dmsFaceSeen: session.dmsFaceSeen,
    start: point(session.firstFix),
    end: point(session.lastFix),
    polyline: route.polyline,
    integrity,
    events: payloadEvents,
    appVersion: deps.appVersion.slice(0, 32) || 'unknown',
  };
  const parsed = FinalizeTripPayloadV3Schema.safeParse(candidate);

  // 3. The local estimate.
  const streak = (await deps.context?.().catch(() => null))?.streak ?? 0;
  const ctx: DriveContext = { streak, safeMilesEarlierToday: await safeMilesEarlierToday(db, localDay, startedAt) };
  const driveEvents: DriveEvent[] = cleaned.map(({ measured: _m, ...e }) => e);
  const breakdown = scoreDrive({ miles, safeMiles, events: driveEvents, dmsOn: session.dmsOn }, ctx);
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
    dms_on: session.dmsOn ? 1 : 0,
    dms_face_seen: session.dmsFaceSeen ? 1 : 0,
    start_lat: candidate.start?.lat ?? null,
    start_lng: candidate.start?.lng ?? null,
    end_lat: candidate.end?.lat ?? null,
    end_lng: candidate.end?.lng ?? null,
    polyline: route.polyline === '' ? null : route.polyline,
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
