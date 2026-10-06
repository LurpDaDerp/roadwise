// Fixtures for the v3 upload: a valid payload, a stored finalize response, and a merge target.
import type { MergeTarget } from '../engine.ts';
import type { FinalizeTripPayloadV3, FinalizeTripResponseV3 } from '../payload.ts';

export const USER = '11111111-1111-4111-8111-111111111111';
export const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TRIP_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EVENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const EVENT_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** 2026-10-05 18:00:00 UTC = 14:00 New York. */
export const STARTED_AT = Date.UTC(2026, 9, 5, 18, 0, 0);

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
    dmsOn: true,
    dmsFaceSeen: true,
    start: { lat: 40.7128, lng: -74.006 },
    end: { lat: 40.7306, lng: -73.9352 },
    polyline: 'abc_def',
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
      dmsMult: 1.25,
      mult: 1.5,
      gains: 177,
      shortScale: 1,
      events: [{ id: EVENT, penalty: 10 }],
      penalties: 10,
      net: 167,
      ratingPenalty: 10,
      activeEventCount: 1,
    },
    net: 167,
    streak: { before: 10, after: 11, outcome: 'grew', nextMult: 1.22, atRisk: false, freezes: 2, freezeEarned: false },
    progress: { points: 167, lifetime: 167, level: 1, levelUp: false, safetyRating: 91.7, ranked: false },
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
    startedAt: STARTED_AT - 40 * 60_000,
    endedAt: STARTED_AT - 2 * 60_000,
    tz: 'America/New_York',
    localDay: '2026-10-05',
    miles: 3,
    safeMiles: 3,
    nightMiles: 0,
    durationS: 2280,
    dmsOn: false,
    dmsFaceSeen: false,
    polyline: 'xyz',
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
    isLoop: false,
    loopRepeat: false,
    safeMilesEarlierToday: 0,
    streak: { streak: 4, atRisk: false, freezes: 1, cleanRun: 2 },
    ...over,
  };
}
