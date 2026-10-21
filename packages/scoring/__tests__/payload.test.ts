// The upload contract lives in src/data/sync/payload.ts (zod only, mirrored to the edge
// functions). It is tested here, beside the scoring types it must stay assignable to.
import {
  DISPUTE_REASONS,
  DisputeActionSchema,
  DisputeResultSchema,
  EVENT_TYPES,
  FinalizeTripPayloadV3Schema,
  FinalizeTripPayloadV4Schema,
  FinalizeTripResponseSchema,
  MAX_EVENTS,
  MAX_POLYLINE_RUNS,
  NotDrivingActionSchema,
  NotDrivingResultSchema,
  TripActionSchema,
  parseFinalizeUpload,
  upgradePayloadV3,
  type ExposureWire,
  type FinalizeTripPayloadV3,
  type FinalizeTripPayloadV4,
  type FinalizeTripResponse,
  type PayloadEvent,
  type PayloadEventV3,
} from '../../../src/data/sync/payload';
import type { DriveEvent, EventType, Exposure } from '../src';

const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const event = (n: number, p: Partial<PayloadEvent> = {}): PayloadEvent => ({
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

const valid = (): FinalizeTripPayloadV4 => ({
  v: 4,
  clientTripId: uuid(1),
  startedAt: T0,
  endedAt: T0 + 20 * 60_000,
  tz: 'America/New_York',
  localDay: '2026-10-05',
  miles: 12,
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
      zone: null,
      status: 'active',
      measured: { speedMph: 41, limitMph: 30, overMphS: 120.5 },
    }),
  ],
  appVersion: '3.0.0',
  origin: 'auto',
  notDrivingExpired: false,
  exposure: { slowdowns: 30, speedups: 29, turns: 18, limitS: 900, movingS: 1100 },
});

const ok = (p: unknown) => FinalizeTripPayloadV4Schema.safeParse(p).success;
const mutate = (fn: (p: Record<string, any>) => void) => {
  const p = valid() as Record<string, any>;
  fn(p);
  return p;
};

describe('FinalizeTripPayloadV4Schema: accepts', () => {
  test('a full valid payload', () => expect(FinalizeTripPayloadV4Schema.parse(valid())).toEqual(valid()));
  test('null start/end and no events', () => expect(ok(mutate((p) => ((p.start = null), (p.end = null), (p.events = []))))).toBe(true));
  test('nightMiles equal to miles', () => expect(ok(mutate((p) => (p.nightMiles = 12)))).toBe(true));
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
          p.events[1].measured = { speedMph: 41, limitMph: 30, overMphS: 1_000_000 };
          p.integrity.maxSpeedMph = 300;
          p.polyline = '?~'.repeat(10);
        })
      )
    ).toBe(true));
  test('a route in several visible runs, up to the run cap', () => {
    expect(ok(mutate((p) => (p.polyline = '_p~iF~ps|U _ulLnnqC')))).toBe(true);
    expect(ok(mutate((p) => (p.polyline = Array.from({ length: MAX_POLYLINE_RUNS }, () => '_p~iF~ps|U').join(' '))))).toBe(true);
    expect(ok(mutate((p) => (p.polyline = '')))).toBe(true);
  });
  test('localDay a day either side of the UTC date (time zones)', () => {
    expect(ok(mutate((p) => (p.localDay = '2026-10-04')))).toBe(true);
    expect(ok(mutate((p) => (p.localDay = '2026-10-06')))).toBe(true);
  });
  test('a manual drive whose "Not driving?" ran out', () =>
    expect(ok(mutate((p) => ((p.origin = 'manual'), (p.notDrivingExpired = true))))).toBe(true));
  test('exposure is optional, and may be all zeros or limitS equal to movingS', () => {
    expect(ok(mutate((p) => delete p.exposure))).toBe(true);
    expect(ok(mutate((p) => (p.exposure = { slowdowns: 0, speedups: 0, turns: 0, limitS: 0, movingS: 0 })))).toBe(true);
    expect(ok(mutate((p) => (p.exposure = { slowdowns: 20_000, speedups: 20_000, turns: 20_000, limitS: 1205, movingS: 1205 })))).toBe(true);
  });
});

describe('FinalizeTripPayloadV4Schema: DashPal', () => {
  const dashcam = { deviceId: 'a4c1380f2b7e', movingS: 1100, coveredS: 990, synced: true };
  const drowsy = (n: number, p: Partial<PayloadEvent> = {}) =>
    event(n, { type: 'drowsy', tier: 'severe', durationS: 4, measured: { source: 'dashcam', speedMph: 52 }, ...p });

  test('the dashcam block and both DashPal event types', () => {
    const p = mutate((x) => {
      x.dashcam = { ...dashcam };
      x.events.push(drowsy(7), drowsy(8, { type: 'eyes_off' }));
    });
    expect(FinalizeTripPayloadV4Schema.parse(p)).toEqual(p);
  });
  test.each<[string, (p: Record<string, any>) => void]>([
    ['coveredS over movingS', (p) => (p.dashcam = { ...dashcam, coveredS: 1101 })],
    ['movingS over 12 h', (p) => (p.dashcam = { ...dashcam, movingS: 43_201, coveredS: 0 })],
    ['an uppercase device id', (p) => (p.dashcam = { ...dashcam, deviceId: 'A4C1380F2B7E' })],
    ['a null dashcam block', (p) => (p.dashcam = null)],
    ['a DashPal event without source dashcam', (p) => p.events.push(drowsy(7, { measured: { speedMph: 52 } }))],
    ['source dashcam on a phone-detected event', (p) => (p.events[0].measured.source = 'dashcam')],
    ['a minor eyes_off', (p) => p.events.push(drowsy(7, { type: 'eyes_off', tier: 'minor' }))],
  ])('rejects %s', (_name, fn) => expect(ok(mutate(fn))).toBe(false));
});

describe('FinalizeTripPayloadV4Schema: rejects', () => {
  test.each<[string, (p: Record<string, any>) => void]>([
    ['v other than 4', (p) => (p.v = 3)],
    ['a missing origin', (p) => delete p.origin],
    ['an unknown origin', (p) => (p.origin = 'passive')],
    ['a missing notDrivingExpired', (p) => delete p.notDrivingExpired],
    ['safeMiles (gone in v4)', (p) => (p.safeMiles = 1)],
    ['a phone pickup', (p) => p.events.push(event(9, { type: 'phone_pickup' as PayloadEvent['type'], tier: 'severe' }))],
    ['a phone handling event', (p) => p.events.push(event(9, { type: 'phone_handling' as PayloadEvent['type'], tier: 'moderate' }))],
    ['units on an event', (p) => (p.events[1].units = 1)],
    ['stoppedInTraffic on an event', (p) => (p.events[0].stoppedInTraffic = true)],
    ['a measured mounted', (p) => (p.events[0].measured.mounted = true)],
    ['a measured maxSpeedMph', (p) => (p.events[0].measured.maxSpeedMph = 30)],
    ['exposure limitS over movingS', (p) => (p.exposure.limitS = 1101)],
    ['fractional exposure', (p) => (p.exposure.turns = 1.5)],
    ['negative exposure', (p) => (p.exposure.slowdowns = -1)],
    ['a count over 20 000', (p) => (p.exposure.speedups = 20_001)],
    ['exposure seconds over 12 h', (p) => ((p.exposure.movingS = 43_201), (p.exposure.limitS = 0))],
    ['exposure movingS more than 5 s over the drive', (p) => (p.exposure.movingS = 1206)],
    ['an unknown exposure key', (p) => (p.exposure.stops = 3)],
    ['a null exposure', (p) => (p.exposure = null)],
    ['a non-uuid clientTripId', (p) => (p.clientTripId = 'trip-1')],
    ['duplicate event ids', (p) => (p.events[1].id = p.events[0].id)],
    ['endedAt equal to startedAt', (p) => (p.endedAt = p.startedAt)],
    ['a drive over 12 h', (p) => (p.endedAt = T0 + 12 * 3_600_000 + 1)],
    ['a fractional epoch', (p) => (p.startedAt = T0 + 0.5)],
    ['miles over 1000', (p) => (p.miles = 1000.1)],
    ['nightMiles over miles', (p) => (p.nightMiles = 13)],
    ['an offset instead of a tz name', (p) => (p.tz = '+05:00')],
    ['an impossible localDay', (p) => (p.localDay = '2026-02-30')],
    ['a localDay far from startedAt', (p) => (p.localDay = '2026-10-08')],
    ['start not rounded to 4 dp', (p) => (p.start = { lat: 40.71281, lng: -74.006 })],
    ['a polyline over 16 KB', (p) => (p.polyline = '?'.repeat(16_385))],
    ['missing integrity flags', (p) => delete p.integrity.mockLocation],
    [`more than ${MAX_EVENTS} events`, (p) => (p.events = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event(i)))],
    ['an unknown event type', (p) => (p.events[0].type = 'tailgating')],
    ['a tier the type cannot have', (p) => (p.events[0].tier = 'moderate')],
    ['an unknown zone', (p) => (p.events[1].zone = 'hospital')],
    ['an event before the drive started', (p) => (p.events[0].startedAt = T0 - 1)],
    ['an event after the drive ended', (p) => (p.events[0].startedAt = T0 + 20 * 60_000 + 1)],
    ['an unknown measured key', (p) => (p.events[0].measured.overMps = 3)],
    ['a negative overMphS', (p) => (p.events[1].measured.overMphS = -0.1)],
    ['an unknown top-level key', (p) => (p.distanceM = 1)],
    ['durationS more than 5 s over the wall span', (p) => (p.durationS = 1205.1)],
    ['a removed status (only the server removes events)', (p) => (p.events[1].status = 'removed')],
    ['a route with a doubled space between runs', (p) => (p.polyline = '_p~iF~ps|U  _ulLnnqC')],
    [`a route in more than ${MAX_POLYLINE_RUNS} runs`, (p) => (p.polyline = Array.from({ length: MAX_POLYLINE_RUNS + 1 }, () => '_p~iF~ps|U').join(' '))],
  ])('%s', (_name, fn) => expect(ok(mutate(fn))).toBe(false));
});

const eventV3 = (n: number, p: Partial<PayloadEventV3> = {}): PayloadEventV3 => ({ ...event(n), ...p }) as PayloadEventV3;

const validV3 = (): FinalizeTripPayloadV3 => ({
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
    eventV3(1, { measured: { peakG: 0.42, speedMph: 30, mounted: true } }),
    eventV3(2, { type: 'speeding', tier: 'moderate', durationS: 40, units: 1, zone: null, status: 'active', measured: { speedMph: 41, limitMph: 30, overMphS: 120.5 } }),
    eventV3(3, { type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true, lat: null, lng: null, measured: { mounted: false, maxSpeedMph: 20 } }),
    eventV3(4, { type: 'phone_handling', tier: 'moderate', units: 2, measured: { maxSpeedMph: 33 } }),
    eventV3(5, { type: 'drowsy', tier: 'severe', durationS: 4, measured: { source: 'dashcam', speedMph: 52 } }),
  ],
  appVersion: '2.0.0',
  dashcam: { deviceId: 'a4c1380f2b7e', movingS: 1100, coveredS: 990, synced: true },
});

describe('the v3 contract an older build sends', () => {
  const okV3 = (p: unknown) => FinalizeTripPayloadV3Schema.safeParse(p).success;
  test('a full v3 payload with phone events still parses as v3', () => expect(FinalizeTripPayloadV3Schema.parse(validV3())).toEqual(validV3()));
  test.each<[string, (p: Record<string, any>) => void]>([
    ['v other than 3', (p) => (p.v = 4)],
    ['safeMiles over miles', (p) => (p.safeMiles = 12.01)],
    ['a moderate phone pickup', (p) => (p.events[2].tier = 'moderate')],
    ['phone handling with 0 units', (p) => (p.events[3].units = 0)],
    ['units over 1440', (p) => (p.events[1].units = 1441)],
    ['endedAt before startedAt', (p) => (p.endedAt = T0 - 1)],
    ['origin (a v4 key)', (p) => (p.origin = 'manual')],
  ])('rejects %s', (_name, fn) => {
    const p = validV3() as Record<string, any>;
    fn(p);
    expect(okV3(p)).toBe(false);
  });
});

describe('upgradePayloadV3', () => {
  test('phone events and the fields only they used go; safeMiles goes; the v4 defaults are set', () => {
    const up = upgradePayloadV3(validV3());
    expect(up.v).toBe(4);
    expect(up.origin).toBe('manual');
    expect(up.notDrivingExpired).toBe(false);
    expect(up).not.toHaveProperty('safeMiles');
    expect(up).not.toHaveProperty('exposure');
    expect(up.events.map((e) => e.type)).toEqual(['hard_brake', 'speeding', 'drowsy']);
    expect(up.events[0]).toEqual(event(1, { measured: { peakG: 0.42, speedMph: 30 } }));
    expect(up.events[1]).not.toHaveProperty('units');
    expect(up.events[1]?.measured).toEqual({ speedMph: 41, limitMph: 30, overMphS: 120.5 });
    expect(up.dashcam).toEqual(validV3().dashcam);
    expect(FinalizeTripPayloadV4Schema.parse(up)).toEqual(up);
  });

  test('pure: the v3 payload is not changed', () => {
    const p = validV3();
    const copy = JSON.parse(JSON.stringify(p));
    upgradePayloadV3(p);
    expect(p).toEqual(copy);
  });
});

describe('parseFinalizeUpload', () => {
  test('v4 is read as is', () => {
    const r = parseFinalizeUpload(valid());
    expect(r.success && r.data).toEqual(valid());
  });

  test('v3 is validated as v3 and upgraded', () => {
    const r = parseFinalizeUpload(validV3());
    expect(r.success && r.data).toEqual(upgradePayloadV3(validV3()));
  });

  test('an invalid v3 body is refused', () => {
    const p = validV3() as Record<string, any>;
    p.safeMiles = 13;
    expect(parseFinalizeUpload(p).success).toBe(false);
  });

  test('an unknown version is refused with an issue on the path v (an older server says the same of v4)', () => {
    const r = parseFinalizeUpload({ ...valid(), v: 5 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'v')).toBe(true);
    for (const body of [null, 'x', 42, {}]) expect(parseFinalizeUpload(body).success).toBe(false);
  });

  test('an invalid v4 body never names the path v', () => {
    const r = parseFinalizeUpload(mutate((p) => (p.miles = -1)));
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'v')).toBe(false);
  });
});

const response = (): FinalizeTripResponse => ({
  tripId: uuid(9),
  clientTripId: uuid(1),
  mergedInto: null,
  scored: true,
  reason: null,
  eventIds: [uuid(1001), uuid(1002)],
  rating: { safetyRating: 92.5, ranked: true },
  challenges: [{ id: 'c1', title: 'Easy does it' }],
  achievements: ['first_drive'],
});

describe('FinalizeTripResponseSchema', () => {
  test('round-trips a response', () => expect(FinalizeTripResponseSchema.parse(response())).toEqual(response()));
  test('an unscored, merged drive with no rating yet', () => {
    const r = { ...response(), scored: false, reason: 'too_short' as const, mergedInto: uuid(2), rating: { safetyRating: null, ranked: false } };
    expect(FinalizeTripResponseSchema.parse(r)).toEqual(r);
  });
  test('extra keys (an older stored result) are allowed and dropped', () =>
    expect(FinalizeTripResponseSchema.parse({ ...response(), net: 12, league: { tier: 'bronze' } })).toEqual(response()));
  test.each<[string, (r: Record<string, any>) => void]>([
    ['an unknown reason', (r) => (r.reason = 'tired')],
    ['a rating over 100', (r) => (r.rating.safetyRating = 100.1)],
    ['a missing rating', (r) => delete r.rating],
    ['a non-uuid event id', (r) => (r.eventIds = ['e1'])],
  ])('rejects %s', (_name, fn) => {
    const r = response() as Record<string, any>;
    fn(r);
    expect(FinalizeTripResponseSchema.safeParse(r).success).toBe(false);
  });
});

describe('trip actions', () => {
  test('the report reasons, with no "mounted"', () => expect(DISPUTE_REASONS).toEqual(['hazard', 'wrong_limit', 'camera_wrong', 'not_driving']));
  test('a dispute and a not-driving request', () => {
    const dispute = { action: 'dispute', clientTripId: uuid(1), eventId: uuid(2), reason: 'camera_wrong' };
    expect(DisputeActionSchema.parse(dispute)).toEqual(dispute);
    expect(TripActionSchema.parse({ action: 'not_driving', clientTripId: uuid(1) })).toEqual({ action: 'not_driving', clientTripId: uuid(1) });
    expect(DisputeActionSchema.safeParse({ ...dispute, reason: 'mounted' }).success).toBe(false);
    expect(NotDrivingActionSchema.safeParse({ action: 'not_driving', clientTripId: uuid(1), previousStatus: 'scored' }).success).toBe(false);
  });
  test('the answers', () => {
    const nd = { tripId: uuid(9), clientTripId: uuid(1), notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } };
    expect(NotDrivingResultSchema.parse(nd)).toEqual(nd);
    const d = { tripId: uuid(9), eventId: uuid(2), status: 'accepted', rejectReason: null, quotaLeft: 2, clean: true, rating: { safetyRating: 88.1, ranked: true } };
    expect(DisputeResultSchema.parse(d)).toEqual(d);
    expect(DisputeResultSchema.safeParse({ ...d, status: 'rejected', rejectReason: 'quota' }).success).toBe(true);
    expect(DisputeResultSchema.safeParse({ ...d, rejectReason: 'not_mounted' }).success).toBe(false);
    expect(NotDrivingResultSchema.safeParse({ ...nd, notDrivingLeft: -1 }).success).toBe(false);
  });
});

// Compile-time: the wire shapes and the scoring types stay assignable both ways.
type WireType = (typeof EVENT_TYPES)[number];
const asEventType = (t: WireType): EventType => t;
const asWireType = (t: EventType): WireType => t;
const asDriveEvent = (e: PayloadEvent): DriveEvent => e;
const asExposure = (e: ExposureWire): Exposure => e;
const asExposureWire = (e: Exposure): ExposureWire => e;
test('wire types are assignable to the scoring types', () => {
  expect(asDriveEvent(event(1)).type).toBe('hard_brake');
  expect(EVENT_TYPES.map(asEventType).map(asWireType)).toEqual(['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'eyes_off', 'drowsy']);
  const e = { slowdowns: 1, speedups: 2, turns: 3, limitS: 4, movingS: 5 };
  expect(asExposureWire(asExposure(e))).toEqual(e);
});
