// The upload contract lives in src/data/sync/payload.ts (zod only, mirrored to the edge
// functions). It is tested here, beside the scoring types it must stay assignable to.
import {
  DISPUTE_REASONS,
  DisputeActionSchema,
  DisputeResultSchema,
  EVENT_TYPES,
  EVENT_TYPES_V4,
  FinalizeTripPayloadV3Schema,
  FinalizeTripPayloadV4Schema,
  FinalizeTripPayloadV5Schema,
  FinalizeTripResponseSchema,
  MAX_EVENTS,
  MAX_POLYLINE_RUNS,
  NotDrivingActionSchema,
  NotDrivingResultSchema,
  TripActionSchema,
  parseFinalizeUpload,
  upgradePayloadV3,
  upgradePayloadV4,
  type ExposureWire,
  type FinalizeTripPayloadV3,
  type FinalizeTripPayloadV4,
  type FinalizeTripPayloadV5,
  type FinalizeTripResponse,
  type PayloadEvent,
  type PayloadEventV3,
  type PayloadEventV4,
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

const eventV4 = (n: number, p: Partial<PayloadEventV4> = {}): PayloadEventV4 => ({
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

/** A phone pickup: 24 s in hand from 31.2 mph, at most 38.4 mph. */
const pickup = (n: number, p: Partial<PayloadEvent> = {}): PayloadEvent =>
  event(n, { type: 'phone_pickup', tier: 'severe', durationS: 24, measured: { speedMph: 31.2, maxSpeedMph: 38.4 }, ...p });

const valid = (): FinalizeTripPayloadV5 => ({
  v: 5,
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
    pickup(3),
  ],
  appVersion: '3.1.0',
  origin: 'auto',
  notDrivingExpired: false,
  exposure: { slowdowns: 30, speedups: 29, turns: 18, limitS: 900, movingS: 1100, phoneS: 1000 },
});

const validV4 = (): FinalizeTripPayloadV4 => ({
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
    eventV4(1),
    eventV4(2, { type: 'speeding', tier: 'moderate', durationS: 40, zone: null, status: 'active', measured: { speedMph: 41, limitMph: 30, overMphS: 120.5 } }),
  ],
  appVersion: '3.0.0',
  origin: 'auto',
  notDrivingExpired: false,
  exposure: { slowdowns: 30, speedups: 29, turns: 18, limitS: 900, movingS: 1100 },
});

const ok = (p: unknown) => FinalizeTripPayloadV5Schema.safeParse(p).success;
const mutate = (fn: (p: Record<string, any>) => void) => {
  const p = valid() as Record<string, any>;
  fn(p);
  return p;
};

describe('FinalizeTripPayloadV5Schema: accepts', () => {
  test('a full valid payload', () => expect(FinalizeTripPayloadV5Schema.parse(valid())).toEqual(valid()));
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
  test('exposure is optional, and may be all zeros or limitS and phoneS equal to movingS', () => {
    expect(ok(mutate((p) => delete p.exposure))).toBe(true);
    expect(ok(mutate((p) => (p.exposure = { slowdowns: 0, speedups: 0, turns: 0, limitS: 0, movingS: 0, phoneS: 0 })))).toBe(true);
    expect(ok(mutate((p) => (p.exposure = { slowdowns: 20_000, speedups: 20_000, turns: 20_000, limitS: 1205, movingS: 1205, phoneS: 1205 })))).toBe(true);
  });
});

describe('FinalizeTripPayloadV5Schema: phone pickups', () => {
  test('a moderate and a severe pickup, with or without their speeds', () => {
    const p = mutate((x) =>
      x.events.push(pickup(4, { tier: 'moderate', durationS: 1, measured: {} }), pickup(5, { tier: 'moderate', durationS: 15, measured: { speedMph: 12.4 } }))
    );
    expect(FinalizeTripPayloadV5Schema.parse(p)).toEqual(p);
  });
  test('in hand as long as the drive itself (its whole seconds)', () => {
    expect(ok(mutate((p) => (p.events[2] = pickup(3, { startedAt: T0, durationS: 1200 }))))).toBe(true);
    expect(ok(mutate((p) => ((p.durationS = 1199.6), (p.events[2] = pickup(3, { startedAt: T0, durationS: 1200 })))))).toBe(true);
  });
  test.each<[string, (p: Record<string, any>) => void]>([
    ['a minor pickup', (p) => (p.events[2].tier = 'minor')],
    ['a pickup in hand 0 s', (p) => (p.events[2].durationS = 0)],
    ['a pickup in hand a fraction of a second', (p) => (p.events[2].durationS = 2.5)],
    ['a pickup in hand longer than the drive', (p) => (p.events[2] = pickup(3, { startedAt: T0, durationS: 1201 }))],
    ['a pickup before the drive started', (p) => (p.events[2].startedAt = T0 - 1)],
    ['a pickup after the drive ended', (p) => (p.events[2].startedAt = T0 + 20 * 60_000 + 1)],
    ['a pickup carrying source dashcam', (p) => (p.events[2].measured.source = 'dashcam')],
    ['a maxSpeedMph over 250', (p) => (p.events[2].measured.maxSpeedMph = 250.1)],
    ['a negative maxSpeedMph', (p) => (p.events[2].measured.maxSpeedMph = -1)],
    ['phone handling (gone since v4)', (p) => p.events.push(event(9, { type: 'phone_handling' as PayloadEvent['type'], tier: 'moderate' }))],
    ['a missing phoneS', (p) => delete p.exposure.phoneS],
    ['phoneS over movingS', (p) => (p.exposure.phoneS = 1101)],
    ['a fractional phoneS', (p) => (p.exposure.phoneS = 10.5)],
    ['a negative phoneS', (p) => (p.exposure.phoneS = -1)],
    ['a null phoneS', (p) => (p.exposure.phoneS = null)],
  ])('rejects %s', (_name, fn) => expect(ok(mutate(fn))).toBe(false));
});

describe('FinalizeTripPayloadV5Schema: DashPal', () => {
  const dashcam = { deviceId: 'a4c1380f2b7e', movingS: 1100, coveredS: 990, synced: true };
  const drowsy = (n: number, p: Partial<PayloadEvent> = {}) =>
    event(n, { type: 'drowsy', tier: 'severe', durationS: 4, measured: { source: 'dashcam', speedMph: 52 }, ...p });

  test('the dashcam block and both DashPal event types', () => {
    const p = mutate((x) => {
      x.dashcam = { ...dashcam };
      x.events.push(drowsy(7), drowsy(8, { type: 'eyes_off' }));
    });
    expect(FinalizeTripPayloadV5Schema.parse(p)).toEqual(p);
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

describe('FinalizeTripPayloadV5Schema: rejects', () => {
  test.each<[string, (p: Record<string, any>) => void]>([
    ['v other than 5', (p) => (p.v = 4)],
    ['a missing origin', (p) => delete p.origin],
    ['an unknown origin', (p) => (p.origin = 'passive')],
    ['a missing notDrivingExpired', (p) => delete p.notDrivingExpired],
    ['safeMiles (gone in v4)', (p) => (p.safeMiles = 1)],
    ['a phone handling event', (p) => p.events.push(event(9, { type: 'phone_handling' as PayloadEvent['type'], tier: 'moderate' }))],
    ['units on an event', (p) => (p.events[1].units = 1)],
    ['stoppedInTraffic on an event', (p) => (p.events[0].stoppedInTraffic = true)],
    ['a measured mounted', (p) => (p.events[0].measured.mounted = true)],
    ['exposure limitS over movingS', (p) => (p.exposure.limitS = 1101)],
    ['fractional exposure', (p) => (p.exposure.turns = 1.5)],
    ['negative exposure', (p) => (p.exposure.slowdowns = -1)],
    ['a count over 20 000', (p) => (p.exposure.speedups = 20_001)],
    ['exposure seconds over 12 h', (p) => ((p.exposure.movingS = 43_201), (p.exposure.limitS = 0), (p.exposure.phoneS = 0))],
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

describe('the v4 contract a build from before phone tracking sends', () => {
  const okV4 = (p: unknown) => FinalizeTripPayloadV4Schema.safeParse(p).success;
  const mutateV4 = (fn: (p: Record<string, any>) => void) => {
    const p = validV4() as Record<string, any>;
    fn(p);
    return p;
  };
  test('a full v4 payload still parses as v4', () => expect(FinalizeTripPayloadV4Schema.parse(validV4())).toEqual(validV4()));
  test('the v4 event types are those of v5 without the pickup', () => {
    expect(EVENT_TYPES_V4).toEqual(['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'eyes_off', 'drowsy']);
    expect(EVENT_TYPES.filter((t) => t !== 'phone_pickup')).toEqual([...EVENT_TYPES_V4]);
  });
  test.each<[string, (p: Record<string, any>) => void]>([
    ['v other than 4', (p) => (p.v = 5)],
    ['a phone pickup', (p) => p.events.push(eventV4(9, { type: 'phone_pickup' as PayloadEventV4['type'], tier: 'severe', durationS: 4 }))],
    ['a measured maxSpeedMph', (p) => (p.events[0].measured.maxSpeedMph = 30)],
    ['phoneS (a v5 key)', (p) => (p.exposure.phoneS = 0)],
    ['exposure limitS over movingS', (p) => (p.exposure.limitS = 1101)],
    ['a missing origin', (p) => delete p.origin],
  ])('rejects %s', (_name, fn) => expect(okV4(mutateV4(fn))).toBe(false));
});

describe('upgradePayloadV4', () => {
  test('v5 with no phone seconds; everything else as sent', () => {
    const up = upgradePayloadV4(validV4());
    const { v: _v, exposure, ...rest } = validV4();
    expect(up).toEqual({ ...rest, v: 5, exposure: { ...exposure, phoneS: 0 } });
    expect(FinalizeTripPayloadV5Schema.parse(up)).toEqual(up);
  });
  test('no counters stay no counters (the server estimates them, with no phone seconds)', () => {
    const p = validV4();
    delete p.exposure;
    const up = upgradePayloadV4(p);
    expect(up).not.toHaveProperty('exposure');
    expect(up.v).toBe(5);
  });
  test('pure: the v4 payload is not changed', () => {
    const p = validV4();
    const copy = JSON.parse(JSON.stringify(p));
    upgradePayloadV4(p);
    expect(p).toEqual(copy);
  });
});

const eventV3 = (n: number, p: Partial<PayloadEventV3> = {}): PayloadEventV3 => ({ ...eventV4(n), ...p }) as PayloadEventV3;

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
    expect(up.events[0]).toEqual(eventV4(1, { measured: { peakG: 0.42, speedMph: 30 } }));
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
  test('v5 is read as is', () => {
    const r = parseFinalizeUpload(valid());
    expect(r.success && r.data).toEqual(valid());
  });

  test('v4 is validated as v4 and upgraded (no phone seconds)', () => {
    const r = parseFinalizeUpload(validV4());
    expect(r.success && r.data).toEqual(upgradePayloadV4(validV4()));
    expect(r.success && r.data.exposure?.phoneS).toBe(0);
  });

  test('v3 is validated as v3 and upgraded through v4', () => {
    const r = parseFinalizeUpload(validV3());
    expect(r.success && r.data).toEqual(upgradePayloadV4(upgradePayloadV3(validV3())));
    expect(r.success && r.data.v).toBe(5);
  });

  test('an invalid v3 or v4 body is refused, never on the path v', () => {
    const p = validV3() as Record<string, any>;
    p.safeMiles = 13;
    expect(parseFinalizeUpload(p).success).toBe(false);
    const q = validV4() as Record<string, any>;
    q.events.push(eventV4(9, { type: 'phone_pickup' as PayloadEventV4['type'], tier: 'severe', durationS: 4 }));
    const r = parseFinalizeUpload(q);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'v')).toBe(false);
  });

  test('an unknown version is refused with an issue on the path v (an older server says the same of v5)', () => {
    for (const v of [6, 2, '5', undefined]) {
      const r = parseFinalizeUpload({ ...valid(), v });
      expect(r.success).toBe(false);
      expect(r.error?.issues.some((i) => i.path.join('.') === 'v')).toBe(true);
    }
    for (const body of [null, 'x', 42, {}]) expect(parseFinalizeUpload(body).success).toBe(false);
  });

  test('an older server (v3 and v4 only) refuses a v5 upload on the path v', () => {
    const r = FinalizeTripPayloadV4Schema.safeParse(valid());
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'v')).toBe(true);
  });

  test('an invalid v5 body never names the path v', () => {
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
  test('the report reasons, "mounted" for a phone pickup', () =>
    expect(DISPUTE_REASONS).toEqual(['hazard', 'wrong_limit', 'camera_wrong', 'mounted', 'not_driving']));
  test('a dispute and a not-driving request', () => {
    const dispute = { action: 'dispute', clientTripId: uuid(1), eventId: uuid(2), reason: 'camera_wrong' };
    expect(DisputeActionSchema.parse(dispute)).toEqual(dispute);
    expect(TripActionSchema.parse({ action: 'not_driving', clientTripId: uuid(1) })).toEqual({ action: 'not_driving', clientTripId: uuid(1) });
    expect(DisputeActionSchema.parse({ ...dispute, reason: 'mounted' })).toEqual({ ...dispute, reason: 'mounted' });
    expect(DisputeActionSchema.safeParse({ ...dispute, reason: 'passenger' }).success).toBe(false);
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
  expect(asDriveEvent(pickup(2)).measured?.maxSpeedMph).toBe(38.4);
  expect(EVENT_TYPES.map(asEventType).map(asWireType)).toEqual(['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy']);
  const e = { slowdowns: 1, speedups: 2, turns: 3, limitS: 4, movingS: 5, phoneS: 4 };
  expect(asExposureWire(asExposure(e))).toEqual(e);
});
