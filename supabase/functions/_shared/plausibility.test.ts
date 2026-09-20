import { assert, assertEquals } from '@std/assert';
import type { FinalizeTripPayload } from './payload.ts';
import { checkPlausibility, tripMetrics, type PlausibilityCode } from './plausibility.ts';
import { event, payload, T0 } from './testing/fixtures.ts';

const failure = (p: FinalizeTripPayload): { code: PlausibilityCode; field: string } => {
  const r = checkPlausibility(p);
  if (r.ok) throw new Error('expected a plausibility failure');
  return r.failure;
};
const downgrades = (p: FinalizeTripPayload): string[] => {
  const r = checkPlausibility(p);
  if (!r.ok) throw new Error(`unexpected failure ${r.failure.code}`);
  return r.downgrades;
};
const digest = (overrides: Partial<FinalizeTripPayload['rowsDigest']>) => ({
  ...payload().rowsDigest,
  ...overrides,
});

Deno.test('a consistent upload passes with no downgrade', () => {
  assertEquals(checkPlausibility(payload()), { ok: true, downgrades: [] });
});

Deno.test('the client trip id must match the storage-key character class', () => {
  assertEquals(failure(payload({ clientTripId: '../x' })), {
    code: 'invalid_client_trip_id',
    field: 'clientTripId',
  });
  assert(checkPlausibility(payload({ clientTripId: 'a-b_C9' })).ok);
});

Deno.test('event ids must be unique', () => {
  assertEquals(failure(payload({ events: [event(), event({ startedAt: T0 + 400_000 })] })), {
    code: 'duplicate_event_id',
    field: 'events.1.id',
  });
});

Deno.test('event ids must be 1 to 64 characters (the table bound)', () => {
  assertEquals(failure(payload({ events: [event({ id: 'x'.repeat(65) })] })), {
    code: 'invalid_event_id',
    field: 'events.0.id',
  });
});

Deno.test('more than 500 events is refused even if the schema were bypassed', () => {
  const events = Array.from({ length: 501 }, (_, i) => event({ id: `e${i}`, startedAt: T0 + 1000 + i }));
  assertEquals(failure(payload({ events })), { code: 'too_many_events', field: 'events' });
});

Deno.test('an unknown IANA zone is refused before the database sees it', () => {
  assertEquals(failure(payload({ tz: 'Mars/Olympus' })), { code: 'invalid_timezone', field: 'tz' });
});

Deno.test('sustained speed above 100 mph is implausible', () => {
  assertEquals(failure(payload({ rowsDigest: digest({ maxSustainedSpeedMps: 44.8 }) })), {
    code: 'implausible_speed',
    field: 'rowsDigest.maxSustainedSpeedMps',
  });
  assert(checkPlausibility(payload({ rowsDigest: digest({ maxSustainedSpeedMps: 44.7 }) })).ok);
});

Deno.test('an average above 45 m/s is implausible; zero over zero is not', () => {
  assertEquals(failure(payload({ distanceM: 60_000, durationS: 1320 })), {
    code: 'implausible_distance',
    field: 'distanceM',
  });
  assertEquals(failure(payload({ distanceM: 10, durationS: 0 })), {
    code: 'implausible_distance',
    field: 'distanceM',
  });
  const empty = payload({
    distanceM: 0,
    durationS: 0,
    events: [],
    rowsDigest: digest({ count: 0, maxSustainedSpeedMps: 0 }),
  });
  assert(checkPlausibility(empty).ok);
});

Deno.test('events must start and end inside the trip window', () => {
  assertEquals(failure(payload({ events: [event({ startedAt: T0 - 1 })] })), {
    code: 'event_outside_trip',
    field: 'events.0.startedAt',
  });
  // starts inside, ends 1 ms after the trip
  assertEquals(failure(payload({ events: [event({ startedAt: T0 + 1_320_000 - 11_999 })] })), {
    code: 'event_outside_trip',
    field: 'events.0.startedAt',
  });
  assert(checkPlausibility(payload({ events: [event({ startedAt: T0 + 1_320_000 - 12_000 })] })).ok);
  assert(checkPlausibility(payload({ events: [event({ startedAt: T0 })] })).ok);
});

Deno.test('row density below 70 % of the driving time fails a grade-A or grade-B trip', () => {
  assertEquals(failure(payload({ rowsDigest: digest({ count: 923 }) })), {
    code: 'sparse_rows',
    field: 'rowsDigest.count',
  });
  assert(checkPlausibility(payload({ rowsDigest: digest({ count: 924 }) })).ok);
  // grade B (no IMU) is held to the same density
  assertEquals(failure(payload({ rowsDigest: digest({ count: 923, imuPresent: false }) })).code, 'sparse_rows');
});

Deno.test('row density is not required of a grade-C trip', () => {
  assert(checkPlausibility(payload({ rowsDigest: digest({ count: 10, validGnssPct: 50 }) })).ok);
});

Deno.test('a recovered (incomplete) trip skips the density rule and is capped at grade B', () => {
  assertEquals(downgrades(payload({ incomplete: true, rowsDigest: digest({ count: 30 }) })), ['incomplete']);
});

Deno.test('a trip without a trace is accepted and capped at grade B', () => {
  assertEquals(downgrades(payload({ tracePath: null })), ['no_trace']);
});

Deno.test('a distance the measured speeds cannot account for downgrades, never rejects', () => {
  // 13.2 km in 1320 s is 10 m/s average; the sustained maximum says 6 m/s
  assertEquals(downgrades(payload({ rowsDigest: digest({ maxSustainedSpeedMps: 6 }) })), [
    'distance_exceeds_speed',
  ]);
});

Deno.test('driving time beyond the wall span downgrades, never rejects', () => {
  assertEquals(downgrades(payload({ durationS: 1322 })), ['duration_exceeds_span']);
  assertEquals(downgrades(payload({ durationS: 1321 })), []);
});

Deno.test('downgrades accumulate in rule order', () => {
  assertEquals(downgrades(payload({ tracePath: null, incomplete: true })), ['no_trace', 'incomplete']);
});

Deno.test('tripMetrics carries the digest verbatim, minus the IMU when the quality is capped', () => {
  const p = payload();
  assertEquals(tripMetrics(p, []), {
    distanceM: 13_200,
    durationS: 1320,
    validGnssPct: 98.03,
    imuPresent: true,
    role: 'driver',
    maxSustainedSpeedMps: 20,
  });
  assertEquals(tripMetrics(p, ['no_trace']).imuPresent, false);
});
