// Fixtures for the v4 upload: a valid payload, one v3 payload from an older build (for the upgrade
// path), a stored finalize response, and a merge target.
import type { MergeTarget } from '../engine.ts';
import type { FinalizeTripPayloadV3, FinalizeTripPayloadV4, FinalizeTripResponse } from '../payload.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TRIP_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EVENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const EVENT_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const EVENT_3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
export function payload(over: Partial<FinalizeTripPayloadV4> = {}): FinalizeTripPayloadV4 {
  return {
    v: 4,
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
    appVersion: '3.0.0',
    origin: 'auto',
    notDrivingExpired: false,
    exposure: { slowdowns: 18, speedups: 17, turns: 11, limitS: 1200, movingS: 1650 },
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

/** The drive before: 3 miles that ended 2 minutes before `payload()` started, one removed DashPal event. */
export function mergeTarget(over: Partial<MergeTarget> = {}): MergeTarget {
  return {
    tripId: '99999999-9999-4999-8999-999999999999',
    clientTripId: TRIP_2,
    reason: null,
    miles: 3,
    durationS: 2280,
    events: [
      {
        id: EVENT_2,
        type: 'eyes_off',
        tier: 'severe',
        startedAt: STARTED_AT - 20 * 60_000,
        durationS: 3,
        zone: null,
        status: 'removed',
        lat: null,
        lng: null,
        measured: { source: 'dashcam', speedMph: 30 },
      },
    ],
    dashcam: { deviceId: null, movingS: 0, coveredS: 0, synced: false },
    ...over,
  };
}
