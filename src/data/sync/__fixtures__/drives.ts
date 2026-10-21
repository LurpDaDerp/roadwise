/**
 * Finished drives for the sync and restore suites, written the way the finalizer leaves them: a
 * `pending` trip row with its events, counters and kept samples, and its v5 upload queued (held
 * for nothing: due at once). Built from the data layer's own repos, so these suites do not depend
 * on the engine.
 */
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createSamplesRepo } from '@/data/db/samples';
import { createTripsRepo } from '@/data/db/trips';
import type { NewEvent, TripPatch } from '@/data/db/types';
import { countEvents } from '@/data/queries/rows';
import type { FinalizeTripPayloadV3, FinalizeTripPayloadV4, FinalizeTripPayloadV5, FinalizeTripResponse, PayloadEvent, PayloadEventV4 } from '@/data/sync/payload';
import { enqueueFinalize } from '@/data/sync/queue';

export const T0 = 1_700_000_000_000;
export const DURATION_MS = 1_200_000;

/** A lowercase v4 uuid numbered `n`. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** One speeding event, 20 s, five minutes in. */
export const speeding = (id: string, t0: number): PayloadEvent => ({
  id,
  type: 'speeding',
  tier: 'minor',
  startedAt: t0 + 300_000,
  durationS: 20,
  lat: null,
  lng: null,
  measured: { speedMph: 50, limitMph: 40, overMphS: 30 },
});

export interface DriveOptions {
  t0?: number;
  events?: PayloadEvent[];
  origin?: 'auto' | 'manual';
  notDrivingExpired?: boolean;
  /** null: no counters (an older drive). */
  exposure?: FinalizeTripPayloadV5['exposure'] | null;
  /** Extra columns on the trip row. */
  row?: TripPatch;
}

/** One phone pickup, 12 s in hand, seven minutes in. */
export const pickup = (id: string, t0: number): PayloadEvent => ({
  id,
  type: 'phone_pickup',
  tier: 'moderate',
  startedAt: t0 + 420_000,
  durationS: 12,
  lat: null,
  lng: null,
  measured: { speedMph: 35, maxSpeedMph: 41.5 },
});

/** The v5 upload of a 20-minute, 11-mile drive. */
export function payloadV5(clientTripId: string, opts: DriveOptions = {}): FinalizeTripPayloadV5 {
  const t0 = opts.t0 ?? T0;
  return {
    v: 5,
    clientTripId,
    startedAt: t0,
    endedAt: t0 + DURATION_MS,
    tz: 'UTC',
    localDay: dayOf(t0),
    miles: 11,
    nightMiles: 0,
    durationS: DURATION_MS / 1000,
    start: { lat: 47.6062, lng: -122.3321 },
    end: { lat: 47.7, lng: -122.3 },
    polyline: '',
    integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 61 },
    events: opts.events ?? [],
    appVersion: '4',
    origin: opts.origin ?? 'manual',
    notDrivingExpired: opts.notDrivingExpired ?? false,
    ...(opts.exposure === undefined ? { exposure: { slowdowns: 4, speedups: 5, turns: 3, limitS: 900, movingS: 1100, phoneS: 1000 } } : opts.exposure === null ? {} : { exposure: opts.exposure }),
  };
}

/** The same drive as a build from before phone tracking queued it (v4: no pickups, no phone seconds). */
export function payloadV4(clientTripId: string, opts: DriveOptions = {}): FinalizeTripPayloadV4 {
  const { v: _v, exposure, events, ...rest } = payloadV5(clientTripId, opts);
  const v4Events = events.filter((e) => e.type !== 'phone_pickup') as PayloadEventV4[];
  if (exposure === undefined) return { ...rest, v: 4, events: v4Events };
  const { phoneS: _p, ...counters } = exposure;
  return { ...rest, v: 4, events: v4Events, exposure: counters };
}

/** The same drive as an older build queued it (v3, with a phone event and safe miles). */
export function payloadV3(clientTripId: string, opts: DriveOptions = {}): FinalizeTripPayloadV3 {
  const v4 = payloadV4(clientTripId, { ...opts, exposure: null });
  const { v: _v, origin: _o, notDrivingExpired: _n, exposure: _e, events, ...rest } = v4;
  return {
    ...rest,
    v: 3,
    safeMiles: 9,
    events: [
      ...events.map((e) => ({ ...e, measured: { ...e.measured } })),
      { id: uuid(990), type: 'phone_pickup', tier: 'severe', startedAt: v4.startedAt + 600_000, durationS: 3, stoppedInTraffic: true, lat: null, lng: null, measured: { mounted: false } },
    ],
  };
}

/** A finished drive on the phone: its row, its events, two samples and its upload queued (due at `t0 + 1 300 000`). */
export async function finishedDrive(db: Db, clientTripId: string, opts: DriveOptions = {}): Promise<FinalizeTripPayloadV5> {
  const p = payloadV5(clientTripId, opts);
  const finalizedAt = p.endedAt + 100_000;
  await createTripsRepo(db).insert(
    {
      client_trip_id: clientTripId,
      started_at: p.startedAt,
      ended_at: p.endedAt,
      tz: p.tz,
      local_day: p.localDay,
      status: 'pending',
      miles: p.miles,
      duration_s: p.durationS,
      start_lat: p.start?.lat ?? null,
      start_lng: p.start?.lng ?? null,
      end_lat: p.end?.lat ?? null,
      end_lng: p.end?.lng ?? null,
      max_speed_mph: p.integrity.maxSpeedMph,
      clean: p.events.some((e) => e.type !== 'eyes_off' && e.type !== 'drowsy') ? 0 : 1,
      counts_json: JSON.stringify(countEvents(p.events)),
      origin: p.origin,
      not_driving_expired: p.notDrivingExpired ? 1 : 0,
      finalized_at: finalizedAt,
      slowdowns: p.exposure?.slowdowns ?? null,
      speedups: p.exposure?.speedups ?? null,
      turns: p.exposure?.turns ?? null,
      limit_s: p.exposure?.limitS ?? null,
      moving_s: p.exposure?.movingS ?? null,
      phone_s: p.exposure?.phoneS ?? 0,
      ...opts.row,
    },
    finalizedAt
  );
  const rows: NewEvent[] = p.events.map((e) => ({
    id: e.id,
    client_trip_id: clientTripId,
    type: e.type,
    tier: e.tier,
    started_at: e.startedAt,
    duration_s: e.durationS,
    lat: e.lat,
    lng: e.lng,
    measured_json: JSON.stringify(e.measured),
  }));
  if (rows.length > 0) await createEventsRepo(db).insertMany(rows);
  await createSamplesRepo(db).appendMany(clientTripId, [
    { ts: p.startedAt, row: { n: 1 } },
    { ts: p.endedAt - 1000, row: { n: 2 } },
  ]);
  await enqueueFinalize(db, p, finalizedAt);
  return p;
}

/** The server's v4 answer for `clientTripId`. */
export const answer = (clientTripId: string, over: Partial<FinalizeTripResponse> = {}): FinalizeTripResponse => ({
  tripId: uuid(77),
  clientTripId,
  mergedInto: null,
  scored: true,
  reason: null,
  eventIds: [],
  rating: { safetyRating: 91.2, ranked: true },
  challenges: [],
  achievements: [],
  ...over,
});
