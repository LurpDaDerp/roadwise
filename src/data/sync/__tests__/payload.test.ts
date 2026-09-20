import type { ScorableEvent, ScoredTrip } from '@scoring';
import {
  FinalizeTripPayloadSchema,
  MAX_EVENTS,
  MAX_POLYLINE_BYTES,
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
  // The trace is always `<clientTripId>.bin.gz`; anything else is a client-supplied name the
  // server must not trust (§4.7), least of all one that tries to carry a directory.
  rejects('a trace path that is not the trip id', payload({ tracePath: 'other.bin.gz' }));
  rejects(
    'a trace path with a directory prefix',
    payload({ tracePath: `someone-else/${payload().clientTripId}.bin.gz` })
  );
  rejects('an empty client trip id', payload({ clientTripId: '' }));

  // The M2 plausibility caps, enforced here so the device never queues what the server rejects.
  rejects(
    'more than MAX_EVENTS events',
    payload({ events: Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event({ id: `e${i}` })) })
  );
  rejects('a polyline over MAX_POLYLINE_BYTES', payload({ polyline: 'a'.repeat(MAX_POLYLINE_BYTES + 1) }));

  // Strict at every level: a key the contract does not know is drift, not data.
  rejects('an unknown top-level key', { ...payload(), extra: 1 });
  rejects('an unknown key in provisional', payload({ provisional: { ...provisional, extra: 1 } as never }));
  rejects(
    'an unknown category in the deductions',
    payload({
      provisional: {
        ...provisional,
        categoryDeductions: { ...provisional.categoryDeductions, parking: 1 } as never,
      },
    })
  );
  rejects(
    'an unknown key in the digest',
    payload({ rowsDigest: { ...payload().rowsDigest, extra: 1 } as never })
  );
  rejects('an unknown key in an event', payload({ events: [{ ...event(), extra: 1 } as never] }));
  rejects(
    'an unknown key in an event context',
    payload({ events: [event({ context: { night: false, precipitation: false, fog: true } as never })] })
  );

  // Coordinates arrive already rounded to 3 dp (§4.2 lat/lng numeric(8,3)).
  rejects('an unrounded latitude', payload({ events: [event({ lat: 37.7749 })] }));
  rejects('an unrounded longitude', payload({ events: [event({ lng: -122.41945 })] }));
});

test('tracePath is exactly <clientTripId>.bin.gz, or null', () => {
  const id = 'abc-123';
  const named = payload({ clientTripId: id, tracePath: `${id}.bin.gz` });
  expect(FinalizeTripPayloadSchema.parse(named)).toEqual(named);
  const none = payload({ clientTripId: id, tracePath: null });
  expect(FinalizeTripPayloadSchema.parse(none)).toEqual(none);
});

test('the caps are exported for the finalizer and are the M2 numbers', () => {
  expect(MAX_EVENTS).toBe(500);
  expect(MAX_POLYLINE_BYTES).toBe(16_384);
  const full = payload({
    events: Array.from({ length: MAX_EVENTS }, (_, i) => event({ id: `e${i}` })),
    polyline: 'a'.repeat(MAX_POLYLINE_BYTES),
  });
  expect(FinalizeTripPayloadSchema.safeParse(full).success).toBe(true);
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
