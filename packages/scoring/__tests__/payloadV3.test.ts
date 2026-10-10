// The v3 upload contract lives in src/data/sync/payload.ts (zod only, mirrored to the edge
// function). It is tested here, beside the scoring types it must stay assignable to.
import {
  FinalizeTripPayloadV3Schema,
  FinalizeTripResponseV3Schema,
  MAX_EVENTS,
  MAX_POLYLINE_RUNS,
  type FinalizeTripPayloadV3,
  type FinalizeTripResponseV3,
  type PayloadEventV3,
} from '../../../src/data/sync/payload';
import type { DriveBreakdown, DriveEvent } from '../src';

const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const event = (n: number, p: Partial<PayloadEventV3> = {}): PayloadEventV3 => ({
  id: uuid(1000 + n),
  type: 'hard_brake',
  tier: 'minor',
  startedAt: T0 + 60_000 + n,
  durationS: 1,
  lat: 40.7128,
  lng: -74.006,
  measured: { peakG: 0.42, speedMph: 30 },
  ...p,
});

const valid = (): FinalizeTripPayloadV3 => ({
  v: 3,
  clientTripId: uuid(1),
  startedAt: T0,
  endedAt: T0 + 20 * 60_000,
  tz: 'America/New_York',
  localDay: '2026-10-05',
  miles: 12,
  safeMiles: 11.8,
  nightMiles: 0,
  durationS: 1200,
  start: { lat: 40.7128, lng: -74.006 },
  end: { lat: 40.758, lng: -73.9855 },
  polyline: '_p~iF~ps|U_ulLnnqC',
  integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 98.5, maxSpeedMph: 61 },
  events: [
    event(1),
    event(2, {
      type: 'speeding',
      tier: 'moderate',
      durationS: 40,
      units: 1,
      zone: null,
      status: 'active',
      measured: { speedMph: 41, limitMph: 30 },
    }),
    event(3, { type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true, lat: null, lng: null, measured: { mounted: false } }),
  ],
  appVersion: '2.0.0',
});

const ok = (p: unknown) => FinalizeTripPayloadV3Schema.safeParse(p).success;
const mutate = (fn: (p: Record<string, any>) => void) => {
  const p = valid() as Record<string, any>;
  fn(p);
  return p;
};

describe('FinalizeTripPayloadV3Schema — accepts', () => {
  test('a full valid payload', () => expect(FinalizeTripPayloadV3Schema.parse(valid())).toEqual(valid()));
  test('null start/end and no events', () => expect(ok(mutate((p) => ((p.start = null), (p.end = null), (p.events = []))))).toBe(true));
  test('safeMiles and nightMiles equal to miles', () => expect(ok(mutate((p) => ((p.safeMiles = 12), (p.nightMiles = 12))))).toBe(true));
  test(`exactly ${MAX_EVENTS} events`, () =>
    expect(ok(mutate((p) => (p.events = Array.from({ length: MAX_EVENTS }, (_, i) => event(i)))))).toBe(true));
  test('a 12 h drive', () =>
    expect(ok(mutate((p) => ((p.endedAt = T0 + 12 * 3_600_000), (p.durationS = 43_200))))).toBe(true));
  test('durationS within 5 s of the wall span', () => {
    expect(ok(mutate((p) => (p.durationS = 1195)))).toBe(true);
    expect(ok(mutate((p) => (p.durationS = 1205)))).toBe(true);
  });
  test('an event ending up to 2 s after endedAt', () =>
    expect(ok(mutate((p) => ((p.events[0].startedAt = T0 + 20 * 60_000 - 1000), (p.events[0].durationS = 3))))).toBe(true));
  test('bounds at their maximum', () =>
    expect(
      ok(
        mutate((p) => {
          p.events[0].measured = { speedMph: 250, limitMph: 120, peakG: 10 };
          p.events[1].units = 1440;
          p.integrity.maxSpeedMph = 300;
          p.polyline = '?~'.repeat(10);
        })
      )
    ).toBe(true));
  test('a route in several visible runs: encoded polylines joined by single spaces, up to the run cap', () => {
    expect(ok(mutate((p) => (p.polyline = '_p~iF~ps|U _ulLnnqC')))).toBe(true);
    expect(ok(mutate((p) => (p.polyline = Array.from({ length: MAX_POLYLINE_RUNS }, () => '_p~iF~ps|U').join(' '))))).toBe(true);
    expect(ok(mutate((p) => (p.polyline = '')))).toBe(true);
  });
  test('a phone handling event with 1 unit', () =>
    expect(ok(mutate((p) => p.events.push(event(9, { type: 'phone_handling', tier: 'moderate', units: 1 }))))).toBe(true));
  test('localDay a day either side of the UTC date (time zones)', () => {
    expect(ok(mutate((p) => (p.localDay = '2026-10-04')))).toBe(true);
    expect(ok(mutate((p) => (p.localDay = '2026-10-06')))).toBe(true);
  });
});

describe('FinalizeTripPayloadV3Schema — rejects', () => {
  test.each<[string, (p: Record<string, any>) => void]>([
    ['v other than 3', (p) => (p.v = 2)],
    ['a non-uuid clientTripId', (p) => (p.clientTripId = 'trip-1')],
    ['a non-uuid event id', (p) => (p.events[0].id = 'abc')],
    ['duplicate event ids', (p) => (p.events[1].id = p.events[0].id)],
    ['endedAt equal to startedAt', (p) => (p.endedAt = p.startedAt)],
    ['a drive over 12 h', (p) => (p.endedAt = T0 + 12 * 3_600_000 + 1)],
    ['a fractional epoch', (p) => (p.startedAt = T0 + 0.5)],
    ['miles over 1000', (p) => (p.miles = 1000.1)],
    ['negative miles', (p) => (p.miles = -1)],
    ['safeMiles over miles', (p) => (p.safeMiles = 12.01)],
    ['negative safeMiles', (p) => (p.safeMiles = -0.1)],
    ['nightMiles over miles', (p) => (p.nightMiles = 13)],
    ['negative durationS', (p) => (p.durationS = -1)],
    ['an offset instead of a tz name', (p) => (p.tz = '+05:00')],
    ['a tz over 64 chars', (p) => (p.tz = `America/${'x'.repeat(60)}`)],
    ['a malformed localDay', (p) => (p.localDay = '2026-10-5')],
    ['an impossible localDay', (p) => (p.localDay = '2026-02-30')],
    ['a localDay far from startedAt', (p) => (p.localDay = '2026-10-08')],
    ['start not rounded to 4 dp', (p) => (p.start = { lat: 40.71281, lng: -74.006 })],
    ['end out of range', (p) => (p.end = { lat: 91, lng: 0 })],
    ['a polyline over 16 KB', (p) => (p.polyline = '?'.repeat(16_385))],
    ['validGnssPct over 100', (p) => (p.integrity.validGnssPct = 100.1)],
    ['missing integrity flags', (p) => delete p.integrity.mockLocation],
    [`more than ${MAX_EVENTS} events`, (p) => (p.events = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event(i)))],
    ['an unknown event type', (p) => (p.events[0].type = 'tailgating')],
    ['a tier the type cannot have', (p) => (p.events[0].tier = 'moderate')],
    ['a moderate phone pickup', (p) => (p.events[2].tier = 'moderate')],
    ['a negative event duration', (p) => (p.events[0].durationS = -1)],
    ['fractional units', (p) => (p.events[1].units = 1.5)],
    ['an unknown zone', (p) => (p.events[1].zone = 'hospital')],
    ['an event before the drive started', (p) => (p.events[0].startedAt = T0 - 1)],
    ['an event after the drive ended', (p) => (p.events[0].startedAt = T0 + 20 * 60_000 + 1)],
    ['an unknown measured key', (p) => (p.events[0].measured.overMps = 3)],
    ['an event lat out of range', (p) => (p.events[0].lat = -90.5)],
    ['an appVersion over 32 chars', (p) => (p.appVersion = '1'.repeat(33))],
    ['an empty appVersion', (p) => (p.appVersion = '')],
    ['an unknown top-level key', (p) => (p.distanceM = 1)],
    ['durationS more than 5 s over the wall span', (p) => (p.durationS = 1205.1)],
    ['durationS more than 5 s under the wall span', (p) => (p.durationS = 1194)],
    ['an event duration over 12 h', (p) => (p.events[0].durationS = 43_201)],
    [
      'an event ending more than 2 s after endedAt',
      (p) => ((p.events[0].startedAt = T0 + 20 * 60_000 - 1000), (p.events[0].durationS = 3.1)),
    ],
    ['units over 1440', (p) => (p.events[1].units = 1441)],
    ['negative units', (p) => (p.events[1].units = -1)],
    ['phone handling with 0 units', (p) => p.events.push(event(9, { type: 'phone_handling', tier: 'moderate', units: 0 }))],
    ['measured speed over 250 mph', (p) => (p.events[0].measured.speedMph = 250.1)],
    ['measured limit over 120 mph', (p) => (p.events[0].measured.limitMph = 120.1)],
    ['measured peak over 10 g', (p) => (p.events[0].measured.peakG = 10.1)],
    ['maxSpeedMph over 300', (p) => (p.integrity.maxSpeedMph = 300.1)],
    ['a removed status (only the server removes events)', (p) => (p.events[1].status = 'removed')],
    ['a polyline with non-ASCII characters', (p) => (p.polyline = '_p~iFé')],
    ['a polyline with characters below "?" (other than the run separator)', (p) => (p.polyline = '_p~iF\t~ps')],
    ['a route with a doubled space between runs', (p) => (p.polyline = '_p~iF~ps|U  _ulLnnqC')],
    ['a route with a leading space', (p) => (p.polyline = ' _p~iF~ps|U')],
    ['a route with a trailing space', (p) => (p.polyline = '_p~iF~ps|U ')],
    ['a route of only a space', (p) => (p.polyline = ' ')],
    [`a route in more than ${MAX_POLYLINE_RUNS} runs`, (p) => (p.polyline = Array.from({ length: MAX_POLYLINE_RUNS + 1 }, () => '_p~iF~ps|U').join(' '))],
  ])('%s', (_name, fn) => expect(ok(mutate(fn))).toBe(false));
});

const breakdown: DriveBreakdown = {
  scored: true,
  safeMiles: 11.8,
  creditedMiles: 11.8,
  milePoints: 118,
  cleanBonus: 0,
  streakMult: 1.2,
  gains: 142,
  shortScale: 1,
  events: [{ id: uuid(1001), penalty: 10 }],
  penalties: 10,
  net: 132,
  ratingPenalty: 10,
  activeEventCount: 1,
};

const response = (): FinalizeTripResponseV3 => ({
  tripId: uuid(9),
  clientTripId: uuid(1),
  mergedInto: null,
  scored: true,
  reason: null,
  breakdown,
  net: 132,
  streak: { before: 10, after: 11, outcome: 'grew', nextMult: 1.22, atRisk: false, freezes: 2, freezeEarned: false },
  progress: { points: 1200, lifetime: 1500, level: 4, levelUp: true, safetyRating: 92.5, ranked: true },
  achievements: ['streak_10'],
  challenges: [{ id: 'c1', title: '5 drives with 0 phone pickups' }],
  league: { tier: 'bronze', placed: true },
});

describe('FinalizeTripResponseV3Schema', () => {
  test('round-trips a response', () => expect(FinalizeTripResponseV3Schema.parse(response())).toEqual(response()));

  test('accepts an unscored, merged drive', () => {
    const r = { ...response(), scored: false, reason: 'too_short', mergedInto: uuid(2), breakdown: { ...breakdown, scored: false, reason: 'too_short' } };
    expect(FinalizeTripResponseV3Schema.safeParse(r).success).toBe(true);
  });

  test('rejects an unknown streak outcome', () => {
    const r = response() as Record<string, any>;
    r.streak.outcome = 'lost';
    expect(FinalizeTripResponseV3Schema.safeParse(r).success).toBe(false);
  });
});

// Compile-time: the wire shapes and the scoring types stay assignable both ways.
const asDriveEvent = (e: PayloadEventV3): DriveEvent => e;
const asBreakdown = (r: FinalizeTripResponseV3): DriveBreakdown => r.breakdown;
const fromBreakdown = (b: DriveBreakdown): FinalizeTripResponseV3['breakdown'] => b;
test('wire types are assignable to the scoring types', () => {
  expect(asDriveEvent(event(1)).type).toBe('hard_brake');
  expect(fromBreakdown(asBreakdown(response()))).toEqual(breakdown);
});
