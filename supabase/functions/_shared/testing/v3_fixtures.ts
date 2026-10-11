// Fixtures for the v3 upload: a valid payload, a stored finalize response, and a merge target.
import type { MergeTarget } from '../engine.ts';
import type { FinalizeTripPayloadV3, FinalizeTripResponseV3 } from '../payload.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TRIP_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EVENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const EVENT_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
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

/** 12 miles in 30 minutes, one minor hard brake (the spec's first example). */
export function payload(over: Partial<FinalizeTripPayloadV3> = {}): FinalizeTripPayloadV3 {
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
    ],
    appVersion: '2.0.0',
    ...over,
  };
}

export function response(over: Partial<FinalizeTripResponseV3> = {}): FinalizeTripResponseV3 {
  return {
    tripId: '99999999-9999-4999-8999-999999999999',
    clientTripId: TRIP,
    mergedInto: null,
    scored: true,
    reason: null,
    breakdown: {
      scored: true,
      safeMiles: 11.8,
      creditedMiles: 11.8,
      milePoints: 118,
      cleanBonus: 0,
      streakMult: 1.2,
      dashcamMult: 1,
      mult: 1.2,
      gains: 142,
      shortScale: 1,
      events: [{ id: EVENT, penalty: 10 }],
      penalties: 10,
      net: 132,
      ratingPenalty: 10,
      activeEventCount: 1,
    },
    net: 132,
    streak: { before: 10, after: 11, outcome: 'grew', nextMult: 1.22, atRisk: false, freezes: 2, freezeEarned: false },
    progress: { points: 132, lifetime: 132, level: 1, levelUp: false, safetyRating: 91.7, ranked: false },
    achievements: ['first_drive'],
    challenges: [],
    league: { tier: 'bronze', placed: true },
    ...over,
  };
}

export function mergeTarget(over: Partial<MergeTarget> = {}): MergeTarget {
  return {
    tripId: '99999999-9999-4999-8999-999999999999',
    clientTripId: TRIP,
    reason: null,
    startedAt: STARTED_AT - 40 * 60_000,
    endedAt: STARTED_AT - 2 * 60_000,
    tz: 'America/New_York',
    localDay: '2026-10-05',
    miles: 3,
    safeMiles: 3,
    nightMiles: 0,
    durationS: 2280,
    polyline: lineOfMiles(3),
    events: [
      {
        id: EVENT_2,
        type: 'phone_pickup',
        tier: 'severe',
        startedAt: STARTED_AT - 20 * 60_000,
        durationS: 5,
        units: null,
        stoppedInTraffic: null,
        zone: null,
        status: 'removed',
        lat: null,
        lng: null,
        measured: {},
        penalty: 0,
      },
    ],
    dashcam: { deviceId: null, movingS: 0, coveredS: 0, synced: false },
    isLoop: false,
    loopRepeat: false,
    safeMilesEarlierToday: 0,
    streak: { streak: 4, atRisk: false, freezes: 1, cleanRun: 2 },
    ...over,
  };
}
