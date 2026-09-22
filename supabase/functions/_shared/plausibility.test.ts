import { assert, assertEquals } from '@std/assert';
import type { FinalizeTripPayload } from './payload.ts';
import { checkPlausibility, tripMetrics, type PlausibilityCode } from './plausibility.ts';
import { event, NOW, payload, T0 } from './testing/fixtures.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const failure = (p: FinalizeTripPayload, now = NOW): { code: PlausibilityCode; field: string } => {
  const r = checkPlausibility(p, now);
  if (r.ok) throw new Error('expected a plausibility failure');
  return r.failure;
};
const downgrades = (p: FinalizeTripPayload, now = NOW): string[] => {
  const r = checkPlausibility(p, now);
  if (!r.ok) throw new Error(`unexpected failure ${r.failure.code}`);
  return r.downgrades;
};
const passes = (p: FinalizeTripPayload, now = NOW): boolean => checkPlausibility(p, now).ok;
const digest = (overrides: Partial<FinalizeTripPayload['rowsDigest']>) => ({
  ...payload().rowsDigest,
  ...overrides,
});

Deno.test('a consistent upload passes with no downgrade', () => {
  assertEquals(checkPlausibility(payload(), NOW), { ok: true, downgrades: [] });
});

Deno.test('role unknown is accepted only from a drive whose role was inferred (auto or moving start), never from a manual start', () => {
  for (const roleSource of ['auto', 'moving_start']) {
    assert(passes(payload({ role: 'unknown', roleSource })), roleSource);
  }
  for (const roleSource of ['manual', null, 'tap', 'AUTO']) {
    assertEquals(failure(payload({ role: 'unknown', roleSource })), { code: 'unknown_role_not_inferred', field: 'role' }, String(roleSource));
  }
  // the rule is about `unknown` only: a manual driver or passenger upload is untouched
  assert(passes(payload({ role: 'driver', roleSource: 'manual' })));
  assert(passes(payload({ role: 'passenger', roleSource: 'manual' })));
});

Deno.test('the client trip id must match the storage-key character class', () => {
  assertEquals(failure(payload({ clientTripId: '../x' })), {
    code: 'invalid_client_trip_id',
    field: 'clientTripId',
  });
  assert(passes(payload({ clientTripId: 'a-b_C9' })));
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

Deno.test('the device\'s deduction map is bounded like the event list', () => {
  const p = payload();
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`e${i}`, 0]));
  assertEquals(failure({ ...p, provisional: { ...p.provisional, eventDeductions: many } }), {
    code: 'invalid_event_deductions',
    field: 'provisional.eventDeductions',
  });
  const longKey = { ...p.provisional, eventDeductions: { ['k'.repeat(65)]: 1 } };
  assertEquals(failure({ ...p, provisional: longKey }).code, 'invalid_event_deductions');
  // ids the server never received (trimmed by the device) are fine
  assert(passes({ ...p, provisional: { ...p.provisional, eventDeductions: { p1: 1, gone: 2 } } }));
});

Deno.test('an unknown IANA zone is refused before the database sees it', () => {
  assertEquals(failure(payload({ tz: 'Mars/Olympus' })), { code: 'invalid_timezone', field: 'tz' });
});

Deno.test('a trip more than thirty days old, or ahead of the server clock, is implausible in time', () => {
  const old = NOW - 30 * DAY - 60_000;
  assertEquals(failure(payload({ startedAt: old, endedAt: old + 1_320_000, events: [event({ startedAt: old + 1000 })] })), {
    code: 'implausible_time',
    field: 'startedAt',
  });
  const month = NOW - 30 * DAY + 60_000;
  assert(passes(payload({ startedAt: month, endedAt: month + 1_320_000, events: [event({ startedAt: month + 1000 })] })));
  // a week-old backlog (a Wi-Fi-only device away from home) is fine
  const week = NOW - 8 * DAY;
  assert(passes(payload({ startedAt: week, endedAt: week + 1_320_000, events: [event({ startedAt: week + 1000 })] })));
  const future = NOW + HOUR + 1000;
  assertEquals(
    failure(payload({ startedAt: future, endedAt: future + 1_320_000, events: [event({ startedAt: future + 1000 })] })),
    { code: 'implausible_time', field: 'startedAt' }
  );
  // starts inside the skew allowance but ends beyond it
  const late = NOW + 30 * 60_000;
  assertEquals(
    failure(payload({ startedAt: late, endedAt: late + HOUR, events: [event({ startedAt: late + 1000 })] })),
    { code: 'implausible_time', field: 'endedAt' }
  );
});

Deno.test('a span longer than 48 hours is implausible in time', () => {
  const start = NOW - 3 * DAY;
  assertEquals(
    failure(payload({ startedAt: start, endedAt: start + 48 * HOUR + 1, events: [event({ startedAt: start + 1000 })] })),
    { code: 'implausible_time', field: 'endedAt' }
  );
});

Deno.test('an epoch past the Date range is refused as a time failure, not thrown', () => {
  assertEquals(failure(payload({ startedAt: 8_640_000_000_000_001, endedAt: 8_640_000_000_000_002, events: [] })).code, 'implausible_time');
});

Deno.test('the table ceilings are mirrored so the refusal names the field', () => {
  assertEquals(failure(payload({ durationS: 172_801 })), { code: 'duration_out_of_range', field: 'durationS' });
  assertEquals(failure(payload({ distanceM: 2_000_001 })), { code: 'distance_out_of_range', field: 'distanceM' });
  assertEquals(
    failure(payload({ events: [event({ durationS: 172_801, durationMs: 172_801_000 })] })).code,
    'event_duration_out_of_range'
  );
});

Deno.test('the polyline is bounded in bytes, not code units', () => {
  // 16 384 code units of a two-byte character: passes the contract, exceeds octet_length
  assertEquals(failure(payload({ polyline: 'é'.repeat(16_384) })), { code: 'polyline_too_long', field: 'polyline' });
  assert(passes(payload({ polyline: '_'.repeat(16_384) })));
});

Deno.test('sustained speed above 100 mph is implausible', () => {
  assertEquals(failure(payload({ rowsDigest: digest({ maxSustainedSpeedMps: 44.8 }) })), {
    code: 'implausible_speed',
    field: 'rowsDigest.maxSustainedSpeedMps',
  });
  assert(passes(payload({ rowsDigest: digest({ maxSustainedSpeedMps: 44.7 }) })));
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
  assert(passes(empty));
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
  assert(passes(payload({ events: [event({ startedAt: T0 + 1_320_000 - 12_000 })] })));
  assert(passes(payload({ events: [event({ startedAt: T0 })] })));
});

Deno.test('row density below 70 % of the driving time fails a grade-A or grade-B trip', () => {
  assertEquals(failure(payload({ rowsDigest: digest({ count: 923 }) })), {
    code: 'sparse_rows',
    field: 'rowsDigest.count',
  });
  assert(passes(payload({ rowsDigest: digest({ count: 924 }) })));
  // grade B (no IMU) is held to the same density
  assertEquals(failure(payload({ rowsDigest: digest({ count: 923, imuPresent: false }) })).code, 'sparse_rows');
});

Deno.test('row density is not required of a grade-C trip', () => {
  assert(passes(payload({ rowsDigest: digest({ count: 10, validGnssPct: 50 }) })));
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
