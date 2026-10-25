// Fixtures for the v5 upload: a valid payload, a phone pickup, the v4 and v3 payloads older builds
// send (for the upgrade paths) and a stored finalize response.
import type { FinalizeTripPayloadV3, FinalizeTripPayloadV4, FinalizeTripPayloadV5, FinalizeTripResponse, PayloadEvent } from '../payload.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TRIP_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EVENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const EVENT_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const EVENT_3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const PICKUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** A DashPal dashcam's id (its identity MAC, lowercase hex). */
export const DASHCAM = 'a4c1380f2b7e';
/** 2026-10-05 18:00:00 UTC = 14:00 New York. */
export const STARTED_AT = Date.UTC(2026, 9, 5, 18, 0, 0);

/** Google polyline encoding at precision 5 (the inverse of `decodeLine`). */
export function encodePolyline(points: [number, number][]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    enc(la - prevLat);
    enc(ln - prevLng);
    prevLat = la;
    prevLng = ln;
  }
  return out;
}

/** A straight line due north from `lat`, `lng`, roughly `miles` long (1° of latitude ≈ 69.09 mi). */
export const lineOfMiles = (miles: number, lat = 40.7128, lng = -74.006): string =>
  encodePolyline(Array.from({ length: 11 }, (_, i) => [lat + (miles / 69.09) * (i / 10), lng] as [number, number]));

/** 12 miles in 30 minutes, noticed on its own, one minor hard brake, its opportunity counters. */
export function payload(over: Partial<FinalizeTripPayloadV5> = {}): FinalizeTripPayloadV5 {
  return {
    v: 5,
    clientTripId: TRIP,
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 30 * 60_000,
    tz: 'America/New_York',
    localDay: '2026-10-05',
    miles: 12,
    nightMiles: 0,
    durationS: 1800,
    start: { lat: 40.7128, lng: -74.006 },
    end: { lat: 40.7306, lng: -73.9352 },
    polyline: lineOfMiles(12.4),
    integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 98, maxSpeedMph: 62 },
    events: [
      {
        id: EVENT,
        type: 'hard_brake',
        tier: 'minor',
        startedAt: STARTED_AT + 10 * 60_000,
        durationS: 2,
        lat: 40.72,
        lng: -73.98,
        measured: { peakG: 0.42 },
      },
    ],
    appVersion: '3.1.0',
    origin: 'auto',
    notDrivingExpired: false,
    exposure: { slowdowns: 18, speedups: 17, turns: 11, limitS: 1200, movingS: 1650, phoneS: 1500 },
    ...over,
  };
}

/** A phone pickup 12 min into `payload()`: 24 s in hand (severe), picked up at 31.2 mph, at most 38.4. */
export function pickup(over: Partial<PayloadEvent> = {}): PayloadEvent {
  return {
    id: PICKUP,
    type: 'phone_pickup',
    tier: 'severe',
    startedAt: STARTED_AT + 12 * 60_000,
    durationS: 24,
    lat: 40.721,
    lng: -73.979,
    measured: { speedMph: 31.2, maxSpeedMph: 38.4 },
    ...over,
  };
}

/** The same drive as a build from before phone tracking sends it: v4, no phone seconds. */
export function payloadV4(over: Partial<FinalizeTripPayloadV4> = {}): FinalizeTripPayloadV4 {
  const { v: _v, events, exposure, ...rest } = payload();
  return {
    ...rest,
    v: 4,
    appVersion: '3.0.0',
    events: events.map((e) => ({ ...e, type: e.type as FinalizeTripPayloadV4['events'][number]['type'] })),
    exposure: { slowdowns: exposure!.slowdowns, speedups: exposure!.speedups, turns: exposure!.turns, limitS: exposure!.limitS, movingS: exposure!.movingS },
    ...over,
  };
}

/** The same drive as an older build sends it: v3, with safe miles and a phone pickup. */
export function payloadV3(over: Partial<FinalizeTripPayloadV3> = {}): FinalizeTripPayloadV3 {
  return {
    v: 3,
    clientTripId: TRIP,
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 30 * 60_000,
    tz: 'America/New_York',
    localDay: '2026-10-05',
    miles: 12,
    safeMiles: 11.8,
    nightMiles: 0,
    durationS: 1800,
    start: { lat: 40.7128, lng: -74.006 },
    end: { lat: 40.7306, lng: -73.9352 },
    polyline: lineOfMiles(12.4),
    integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 98, maxSpeedMph: 62 },
    events: [
      {
        id: EVENT,
        type: 'hard_brake',
        tier: 'minor',
        startedAt: STARTED_AT + 10 * 60_000,
        durationS: 2,
        lat: 40.72,
        lng: -73.98,
        measured: { peakG: 0.42 },
      },
      {
        id: EVENT_3,
        type: 'phone_pickup',
        tier: 'severe',
        startedAt: STARTED_AT + 12 * 60_000,
        durationS: 4,
        stoppedInTraffic: false,
        lat: 40.721,
        lng: -73.979,
        measured: { mounted: false, maxSpeedMph: 31 },
      },
      {
        id: EVENT_2,
        type: 'speeding',
        tier: 'minor',
        startedAt: STARTED_AT + 15 * 60_000,
        durationS: 20,
        lat: 40.722,
        lng: -73.978,
        measured: { speedMph: 41, limitMph: 35, overMphS: 30, maxSpeedMph: 43 },
      },
    ],
    appVersion: '2.0.0',
    ...over,
  };
}

/** The answer apply_drive stores for `payload()`. */
export function response(over: Partial<FinalizeTripResponse> = {}): FinalizeTripResponse {
  return {
    tripId: '99999999-9999-4999-8999-999999999999',
    clientTripId: TRIP,
    mergedInto: null,
    scored: true,
    reason: null,
    eventIds: [EVENT],
    rating: { safetyRating: 87.4, ranked: true },
    challenges: [],
    achievements: ['first_drive'],
    ...over,
  };
}
