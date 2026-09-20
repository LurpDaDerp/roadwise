import type { ScorableEvent, ScoredTrip } from '@scoring';
import {
  FinalizeTripPayloadSchema,
  type FinalizeTripPayload,
  type PayloadEvent,
} from '@/data/sync/payload';

const T0 = 1_700_000_000_000;

const event = (overrides: Partial<PayloadEvent> = {}): PayloadEvent => ({
  id: 'p1',
  category: 'phone',
  startedAt: T0 + 300_000,
  durationS: 12,
  durationMs: 12_000,
  q: 0.9,
  corrected: false,
  status: 'scored',
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
  contextMultiplier: 1,
  severity: 1,
  deduction: 14.545,
  lat: 37.775,
  lng: -122.385,
  alertShown: true,
  source: 'os',
  ...overrides,
});

const provisional: ScoredTrip = {
  score: 74,
  status: 'final',
  exposure: 1.1,
  dataQuality: 'A',
  categoryDeductions: {
    phone: 14.545,
    speeding: 6.818,
    braking: 4.773,
    accel: 0,
    cornering: 0,
    focus: 0,
  },
  eventDeductions: { p1: 14.545 },
  scoringVersion: 1,
};

const payload = (overrides: Partial<FinalizeTripPayload> = {}): FinalizeTripPayload => ({
  clientTripId: '123e4567-e89b-42d3-a456-426614174000',
  startedAt: T0,
  endedAt: T0 + 1_320_000,
  tz: 'America/Los_Angeles',
  distanceM: 13_200,
  durationS: 1320,
  role: 'driver',
  roleConfidence: null,
  roleSource: 'manual',
  mode: 'mounted',
  cameraSession: false,
  provisional,
  events: [event()],
  rowsDigest: {
    count: 1320,
    validGnssPct: 98.03,
    imuPresent: true,
    maxSustainedSpeedMps: 10,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  startGeohash5: '9q8yy',
  endGeohash5: '9q8yz',
  polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  tracePath: '123e4567-e89b-42d3-a456-426614174000.bin.gz',
  hadSevereEvent: false,
  ...overrides,
});

test('a valid payload round-trips through the schema unchanged, JSON included', () => {
  const p = payload();
  expect(FinalizeTripPayloadSchema.parse(p)).toEqual(p);
  expect(FinalizeTripPayloadSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
});

test('an unscored payload carries a null score, a reason and a null trace path', () => {
  const p = payload({
    provisional: {
      ...provisional,
      score: null,
      status: 'unscored',
      reason: 'passenger',
      eventDeductions: {},
    },
    events: [event({ deduction: null, alertShown: false })],
    tracePath: null,
    role: 'passenger',
  });
  expect(FinalizeTripPayloadSchema.parse(p)).toEqual(p);
});

test('an empty trip is valid: no events, no path, no geohash, a digest over zero rows', () => {
  const p = payload({
    events: [],
    polyline: '',
    startGeohash5: null,
    endGeohash5: null,
    rowsDigest: {
      count: 0,
      validGnssPct: 0,
      imuPresent: false,
      maxSustainedSpeedMps: 0,
      sha256: '0'.repeat(64),
    },
    provisional: {
      ...provisional,
      score: null,
      status: 'unscored',
      reason: 'too_short',
      eventDeductions: {},
    },
  });
  expect(FinalizeTripPayloadSchema.parse(p)).toEqual(p);
});

describe('rejects', () => {
  const rejects = (name: string, bad: unknown) =>
    test(name, () => expect(FinalizeTripPayloadSchema.safeParse(bad).success).toBe(false));

  const missing = (): unknown => {
    const { rowsDigest: _drop, ...rest } = payload();
    return rest;
  };
  const digest = (sha256: string) => ({ ...payload().rowsDigest, sha256 });

  rejects('a missing field', missing());
  rejects('a digest that is not 64 hex characters', payload({ rowsDigest: digest('abc') }));
  rejects('an upper-case digest', payload({ rowsDigest: digest('A'.repeat(64)) }));
  rejects('a negative distance', payload({ distanceM: -1 }));
  rejects('a non-finite duration', payload({ durationS: Number.POSITIVE_INFINITY }));
  rejects('an end before the start', payload({ endedAt: T0 - 1 }));
  rejects('an unknown role', payload({ role: 'other' as never }));
  rejects('an unknown mode', payload({ mode: 'dash' as never }));
  rejects(
    'a score on an unscored trip',
    payload({ provisional: { ...provisional, status: 'unscored', score: 74 } })
  );
  rejects('no score on a final trip', payload({ provisional: { ...provisional, score: null } }));
  rejects('a score above 100', payload({ provisional: { ...provisional, score: 101 } }));
  rejects(
    'a scoring version other than 1',
    payload({ provisional: { ...provisional, scoringVersion: 2 as never } })
  );
  rejects(
    'a category missing from the deductions',
    payload({ provisional: { ...provisional, categoryDeductions: { phone: 1 } as never } })
  );
  rejects(
    'an event whose durationMs disagrees with durationS',
    payload({ events: [event({ durationMs: 11_000 })] })
  );
  rejects('an event confidence above 1', payload({ events: [event({ q: 1.2 })] }));
  rejects(
    'an event status outside the four',
    payload({ events: [event({ status: 'pending' as never })] })
  );
  rejects(
    'an unknown measured key',
    payload({ events: [event({ measured: { foo: 1 } as never })] })
  );
  rejects(
    'a context multiplier above the cap',
    payload({ events: [event({ contextMultiplier: 1.6 })] })
  );
  rejects('a latitude out of range', payload({ events: [event({ lat: 91 })] }));
  rejects('a four-character geohash', payload({ startGeohash5: '9q8y' }));
  rejects('a polyline that is not a string', payload({ polyline: null as never }));
  rejects('an empty trace path (null is the way to say none)', payload({ tracePath: '' }));
  rejects('an empty client trip id', payload({ clientTripId: '' }));
});

test('the parsed types are structurally the scoring package types, so the server can re-score', () => {
  const p = FinalizeTripPayloadSchema.parse(payload());
  // Compile-time: a payload event is a ScorableEvent and the provisional result is a ScoredTrip.
  const scorable: ScorableEvent[] = p.events;
  const scored: ScoredTrip = p.provisional;
  // And the other way round, so nothing the scorer produces is unrepresentable.
  const back: FinalizeTripPayload['provisional'] = scored;
  expect(scorable).toHaveLength(1);
  expect(back.score).toBe(74);
});
