import { assert, assertAlmostEquals, assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import { scoreTrip } from '../_shared/scoring/index';
import { emptyDayRow, type DayRow } from '../_shared/aggregate.ts';
import { createDb, type ApplyTripEnvelope } from '../_shared/db.ts';
import { tripMetrics } from '../_shared/plausibility.ts';
import { fakeSupabase, type RpcError } from '../_shared/testing/fake_supabase.ts';
import {
  baselineTripRow,
  CLIENT_TRIP_ID,
  dayRowRecord,
  event,
  NOW,
  payload,
  T0,
  TRIP_DAY,
  tripRow,
  UID,
  workedExample,
} from '../_shared/testing/fixtures.ts';
import { handleFinalizeTrip, MAX_BODY_BYTES, MAX_TRIPS_PER_24H, type FinalizeDeps } from './handler.ts';

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const GOOD_TOKEN = 'good-token';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Harness {
  deps: FinalizeDeps;
  fake: ReturnType<typeof fakeSupabase>;
  warnings: unknown[][];
  errors: unknown[][];
}

function harness(
  opts: {
    tables?: Record<string, Record<string, unknown>[]>;
    rpcError?: RpcError;
    rpcReplayed?: boolean;
    now?: number;
  } = {}
): Harness {
  const fake = fakeSupabase({
    tables: opts.tables ?? { trips: [], trip_events: [], score_daily: [] },
    rpc: (_fn, args) => {
      if (opts.rpcError) return { error: opts.rpcError };
      const p = args.p as ApplyTripEnvelope;
      return {
        data: {
          trip_id: 'new-trip-id',
          score: p.scored.score,
          status: p.scored.status,
          day: p.day[0].day,
          replayed: opts.rpcReplayed === true,
        },
      };
    },
  });
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const deps: FinalizeDeps = {
    verifyJwt: (token) => Promise.resolve(token === GOOD_TOKEN ? UID : null),
    db: createDb(fake.client),
    now: () => opts.now ?? NOW,
    log: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) },
  };
  return { deps, fake, warnings, errors };
}

const post = (body: unknown, token: string | null = GOOD_TOKEN, headers: Record<string, string> = {}) =>
  new Request('http://local/finalize-trip', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

const envelope = (h: Harness): ApplyTripEnvelope => {
  assertEquals(h.fake.rpcCalls.length, 1);
  assertEquals(h.fake.rpcCalls[0].fn, 'apply_trip');
  return h.fake.rpcCalls[0].args.p as ApplyTripEnvelope;
};

/** A payload dated `daysAgo` days before the fixture trip, events moved with it. */
const dated = (startedAt: number) =>
  payload({ startedAt, endedAt: startedAt + 1_320_000, events: [event({ startedAt: startedAt + 300_000 })] });

Deno.test('anything but POST is 405', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(new Request('http://local/finalize-trip', { method: 'GET' }), h.deps);
  assertEquals(await json(res), { status: 405, body: { code: 'method_not_allowed' } });
  assertEquals(res.headers.get('allow'), 'POST');
});

Deno.test('a missing or unverifiable bearer token is 401 and nothing is read', async () => {
  const h = harness();
  assertEquals(await json(await handleFinalizeTrip(post(payload(), null), h.deps)), {
    status: 401,
    body: { code: 'unauthorized' },
  });
  assertEquals(await json(await handleFinalizeTrip(post(payload(), 'forged'), h.deps)), {
    status: 401,
    body: { code: 'unauthorized' },
  });
  assertEquals(h.fake.queries.length, 0);
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a token check that fails on Auth itself is 503 retry, logged, with nothing read', async () => {
  const h = harness();
  h.deps.verifyJwt = () => Promise.reject(new TypeError('fetch failed'));
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('retry-after'), '2');
  assertMatch(res.headers.get('x-request-id') ?? '', UUID);
  assertEquals(await res.json(), { code: 'retry' });
  assertEquals(h.errors.length, 1);
  assertEquals(h.fake.queries.length, 0);
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a body over 1 MB is 413, by its declared length or by what actually arrives', async () => {
  const h = harness();
  const big = `{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
  assertEquals(await json(await handleFinalizeTrip(post(big), h.deps)), {
    status: 413,
    body: { code: 'payload_too_large' },
  });
  // a lying Content-Length is refused without reading
  assertEquals(
    (await handleFinalizeTrip(post(payload(), GOOD_TOKEN, { 'content-length': String(MAX_BODY_BYTES + 1) }), h.deps)).status,
    413
  );
  // a chunked body with no length is cut off at the cap
  let pulled = 0;
  const chunk = new Uint8Array(65_536).fill(0x78);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const req = new Request('http://local/finalize-trip', {
    method: 'POST',
    headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    body: stream,
  });
  assertEquals((await handleFinalizeTrip(req, h.deps)).status, 413);
  assert(pulled < 64, `read the whole stream (${pulled} chunks) instead of stopping at the cap`);
});

Deno.test('malformed JSON is 400 invalid_json', async () => {
  const h = harness();
  assertEquals(await json(await handleFinalizeTrip(post('{not json'), h.deps)), {
    status: 400,
    body: { code: 'invalid_json' },
  });
});

Deno.test('a payload the contract refuses is 400 with the failing fields', async () => {
  const h = harness();
  const bad = { ...payload(), events: [event({ durationMs: 999 })] };
  const { status, body } = await json(await handleFinalizeTrip(post(bad), h.deps));
  assertEquals(status, 400);
  assertEquals(body.code, 'invalid_payload');
  const paths = (body.issues as { path: string }[]).map((i) => i.path);
  assertEquals(paths, ['events.0.durationMs']);
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a key the contract does not know is refused, so a smuggled user id never reaches the envelope', async () => {
  const h = harness();
  const { status, body } = await json(
    await handleFinalizeTrip(post({ ...payload(), userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), h.deps)
  );
  assertEquals(status, 400);
  assertEquals(body.code, 'invalid_payload');
  assert((body.issues as { message: string }[]).some((i) => /userId/.test(i.message)));
  assertEquals(h.fake.queries.length, 0);
});

Deno.test('an implausible trip is 400 with the rule code and field; only the replay lookup ran', async () => {
  const h = harness();
  const p = payload({ rowsDigest: { ...payload().rowsDigest, maxSustainedSpeedMps: 60 } });
  assertEquals(await json(await handleFinalizeTrip(post(p), h.deps)), {
    status: 400,
    body: { code: 'implausible_speed', field: 'rowsDigest.maxSustainedSpeedMps' },
  });
  assertEquals(
    h.fake.queries.map((q) => q.table),
    ['trips']
  );
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('the happy path re-scores, builds the envelope from the JWT user and answers with the writer result and the day row', async () => {
  const h = harness();
  const p = payload();
  const res = await handleFinalizeTrip(post(p), h.deps);
  const expected = scoreTrip(tripMetrics(p, []), p.events);
  const e = envelope(h);
  assertEquals(await json(res), {
    status: 200,
    body: {
      tripId: 'new-trip-id',
      score: expected.score,
      status: 'final',
      day: e.day[0],
      // The device's row follows the server's arithmetic, not its own finalizer's.
      trip: {
        categoryDeductions: expected.categoryDeductions,
        exposure: expected.exposure,
        dataQuality: expected.dataQuality,
        hadSevereEvent: p.hadSevereEvent,
        limitCoveragePct: p.limitCoveragePct,
      },
      provisionalMismatch: false,
      replayed: false,
    },
  });
  assertMatch(res.headers.get('x-request-id') ?? '', UUID);
  assertEquals(e.userId, UID);
  assertEquals(e.payload, p); // a consistent device sends exactly what the server derives
  assertEquals(e.scored, expected);
  assertEquals(e.day.length, 1);
  assertEquals(e.day[0], {
    day: TRIP_DAY,
    longTermScore: null, // one trip: the long-term score is withheld
    band: null,
    provisional: true,
    safeDay: true,
    goodDay: false,
    phoneFreeDay: false,
    cameraDay: false,
    exposure: expected.exposure,
    drivingS: 1320,
    tripsScored: 1,
    severeEvents: 0,
  });
  // the trip is in the current four weeks, and the baseline is the eight weeks behind them
  assertEquals(e.baselines, { medians: {}, computedAt: new Date(NOW).toISOString() });
  assertEquals(e.conditions, { night: false, precipitation: false });
  assertEquals(e.limitCoveragePct, p.limitCoveragePct);
  assertEquals(h.warnings.length, 0);
  assertEquals(h.fake.storageTouched(), false);
});

Deno.test('fractional device durations reach the writer as integers where it casts', async () => {
  const h = harness({ tables: { trips: [tripRow({ duration_s: 1199.6 })], trip_events: [], score_daily: [] } });
  const p = payload({ durationS: 1320.417 });
  const { status, body } = await json(await handleFinalizeTrip(post(p), h.deps));
  assertEquals(status, 200);
  const e = envelope(h);
  assertEquals(e.day[0].drivingS, 2520);
  for (const k of ['drivingS', 'tripsScored', 'severeEvents'] as const) {
    assert(Number.isInteger(e.day[0][k]), `${k} = ${e.day[0][k]}`);
  }
  assert(e.day[0].longTermScore === null || Number.isInteger(e.day[0].longTermScore));
  assertEquals(e.payload.durationS, 1320.417); // the trip's own numeric column keeps the fraction
  assertEquals(body.day, e.day[0]);
});

Deno.test('the stored trips feed the long-term score, the day row and the baselines', async () => {
  const stored = [0, 1, 2].map((i) =>
    tripRow({
      id: `s${i}`,
      score: 80 + i,
      duration_s: 1500,
      exposure: 1.5,
      ended_at: new Date(T0 - (i + 1) * DAY_MS).toISOString(),
      local_day: i === 0 ? TRIP_DAY : `2023-11-1${3 - i}`,
      category_deductions: { phone: 2 * i, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    })
  );
  // the baseline window is the eight weeks before the current four, so only these two are in it
  const older = [
    baselineTripRow(40, {
      id: 'b0',
      score: 60,
      category_deductions: { phone: 2, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    }),
    baselineTripRow(60, {
      id: 'b1',
      score: 80,
      category_deductions: { phone: 8, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    }),
  ];
  const h = harness({
    tables: {
      trips: [...stored, ...older],
      trip_events: [{ trip_id: 's0', category: 'phone', status: 'scored' }],
      score_daily: [],
    },
  });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const e = envelope(h);
  assertEquals(e.day.length, 1);
  assert(typeof e.day[0].longTermScore === 'number');
  assertEquals(e.day[0].provisional, false);
  assertEquals(e.day[0].tripsScored, 2); // s0 and the new trip
  assertEquals(e.day[0].drivingS, 1500 + 1320);
  assertEquals(e.day[0].phoneFreeDay, false);
  assertEquals(e.baselines?.medians.phone, 5); // median of 2 and 8, the two inside the window
  assertEquals(e.baselines?.medians.score, 70); // median of 60 and 80
});

Deno.test('a trip synced on a later day also writes today\'s row; the response carries the trip\'s own', async () => {
  const h = harness({ now: T0 + 3 * DAY_MS });
  const { status, body } = await json(await handleFinalizeTrip(post(payload()), h.deps));
  assertEquals(status, 200);
  const e = envelope(h);
  assertEquals(
    e.day.map((d) => d.day),
    [TRIP_DAY, '2023-11-17']
  );
  assertEquals(e.day[1].tripsScored, 0);
  assertEquals(e.day[1].longTermScore, e.day[0].longTermScore);
  assertEquals((body.day as DayRow).day, TRIP_DAY);
});

Deno.test('the §9.4 worked example scores 74 through the handler and the envelope carries the breakdown', async () => {
  const h = harness();
  const p = workedExample();
  const { status, body } = await json(await handleFinalizeTrip(post(p), h.deps));
  assertEquals(status, 200);
  assertEquals(body.score, 74);
  assertEquals(body.status, 'final');
  assertEquals(body.provisionalMismatch, false);
  assertEquals(body.replayed, false);
  const e = envelope(h);
  assertEquals(e.scored.score, 74);
  assertEquals(e.scored.dataQuality, 'A');
  assertAlmostEquals(e.scored.exposure, 1.1, 1e-9);
  const d = e.scored.categoryDeductions;
  assertAlmostEquals(d.phone, 14.545, 0.001);
  assertAlmostEquals(d.speeding, 6.818, 0.001);
  assertAlmostEquals(d.braking, 4.773, 0.001);
  assertEquals([d.accel, d.cornering, d.focus], [0, 0, 0]);
  assertEquals(Object.keys(e.scored.eventDeductions).sort(), ['b1', 'p1', 's1']);
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].drivingS, 1320);
  assertAlmostEquals(e.day[0].exposure, 1.1, 1e-9);
  assertEquals(e.day[0].safeDay, false);
  assertEquals(e.day[0].goodDay, true);
  assertEquals(e.day[0].phoneFreeDay, false);
  assertEquals(e.day[0].cameraDay, false);
  assertEquals(e.day[0].longTermScore, null);
  assertEquals(e.day[0].provisional, true);
  // the trip is today's: it is the current period, never its own baseline
  assertEquals(e.baselines?.medians, {});
  assertEquals(e.conditions, { night: false, precipitation: false });
  assertEquals(body.day, e.day[0]);
  assertEquals(h.warnings.length, 0);
});

Deno.test('the worked example with a device score of 70 is a mismatch of 4; without a trace it is grade B', async () => {
  const off = harness();
  const p = workedExample();
  const { body } = await json(
    await handleFinalizeTrip(post({ ...p, provisional: { ...p.provisional, score: 70 } }), off.deps)
  );
  assertEquals(body.score, 74);
  assertEquals(body.provisionalMismatch, true);
  assertEquals(off.warnings.length, 1);
  assertEquals((off.warnings[0][1] as { delta: number }).delta, 4);
  assertEquals(envelope(off).scored.score, 74);

  const noTrace = harness();
  const res = await json(await handleFinalizeTrip(post(workedExample({ tracePath: null })), noTrace.deps));
  assertEquals(res.body.score, 74);
  const e = envelope(noTrace);
  assertEquals(e.scored.dataQuality, 'B');
  assertEquals(e.payload.rowsDigest.imuPresent, true);
});

Deno.test('per-event severity, multiplier and deduction in the envelope are the server\'s, not the device\'s', async () => {
  const h = harness();
  const p = payload();
  const lying = { ...p, events: [event({ severity: 0, contextMultiplier: 1.5, deduction: 0 })] };
  const { status, body } = await json(await handleFinalizeTrip(post(lying), h.deps));
  assertEquals(status, 200);
  assertEquals(body.provisionalMismatch, false); // the score never read those numbers
  const [e] = envelope(h).payload.events;
  assertEquals(e.severity, 1);
  assertEquals(e.contextMultiplier, 1);
  assertAlmostEquals(e.deduction ?? -1, 14.545, 0.001);
  assertEquals(h.warnings.length, 1);
  assertMatch(String(h.warnings[0][0]), /derived/);
  assertEquals((h.warnings[0][1] as { events: number }).events, 1);
});

Deno.test('hadSevereEvent is at least what the scored speeding events prove', async () => {
  const h = harness();
  const severe = event({
    id: 's1',
    category: 'speeding',
    startedAt: T0 + 600_000,
    durationS: 30,
    durationMs: 30_000,
    measured: { overMps: 9, limitMps: 20 },
    source: 'gnss',
  });
  const p = payload({ events: [event(), severe], hadSevereEvent: false });
  const { status } = await json(await handleFinalizeTrip(post(p), h.deps));
  assertEquals(status, 200);
  const e = envelope(h);
  assertEquals(e.payload.hadSevereEvent, true);
  assertEquals(e.day[0].severeEvents, 1);
  assertEquals(e.day[0].safeDay, false);
  assertEquals(h.warnings.length, 1);
  assertEquals((h.warnings[0][1] as { hadSevereEvent: boolean }).hadSevereEvent, true);
});

Deno.test('per-event night is the trip\'s clock rule in its zone; a device flag saying otherwise is overruled', async () => {
  const start = Date.UTC(2023, 10, 15, 7, 30); // 23:30 in Los Angeles on the 14th
  const h = harness({ now: start + 2 * HOUR });
  // the device scored a 24 s pickup as a daytime event
  const lying = payload({
    startedAt: start,
    endedAt: start + 1_320_000,
    events: [event({ startedAt: start + 300_000, durationS: 24, durationMs: 24_000, context: { night: false, precipitation: false } })],
  });
  assertEquals(lying.events[0].contextMultiplier, 1);
  const { status, body } = await json(await handleFinalizeTrip(post(lying), h.deps));
  assertEquals(status, 200);
  const e = envelope(h);
  assertEquals(e.payload.events[0].context, { night: true, precipitation: false });
  assertEquals(e.payload.events[0].contextMultiplier, 1.2);
  assertEquals(e.conditions.night, true);
  assertEquals(e.day[0].day, TRIP_DAY);
  assertEquals(e.scored.score, 74); // 8 × 1 × 3 × 1 × 1.2 / 1.1 off 100
  assertEquals(lying.provisional.score, 78); // what the device believed
  assertEquals(body.score, 74);
  assertEquals(body.provisionalMismatch, true);
  assertEquals(
    h.warnings.map((w) => String(w[0])),
    ['finalize-trip mismatch', 'finalize-trip derived fields corrected']
  );
});

Deno.test('an auto-detected drive uploaded as role unknown is stored unscored as role_unknown, with no mismatch', async () => {
  const h = harness();
  const unclear = payload({ role: 'unknown', roleConfidence: 0.5, roleSource: 'auto' });
  assertEquals(unclear.provisional.reason, 'role_unknown');
  const { status, body } = await json(await handleFinalizeTrip(post(unclear), h.deps));
  assertEquals(status, 200);
  assertEquals(body.status, 'unscored');
  assertEquals(body.score, null);
  assertEquals(body.provisionalMismatch, false);
  const e = envelope(h);
  assertEquals(e.payload.role, 'unknown');
  assertEquals(e.scored.reason, 'role_unknown');
  assertEquals(e.day[0].tripsScored, 0);
  assertEquals(h.warnings.length, 0);
});

Deno.test('a manual start uploaded as role unknown is refused 400 and nothing is written', async () => {
  const h = harness();
  const manual = payload({ role: 'unknown', roleConfidence: null, roleSource: 'manual' });
  assertEquals(await json(await handleFinalizeTrip(post(manual), h.deps)), {
    status: 400,
    body: { code: 'unknown_role_not_inferred', field: 'role' },
  });
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a mismatch the night boundary explains is flagged nightBoundary, so monitoring can set it apart', async () => {
  // The device flagged the pickup by its own clock; the server applies the clock rule at trip
  // start to every event. A drive that starts at 23:30 and whose device called the event daytime
  // is the legitimate 23:00/05:00 divergence (M2 final review, carry-over 5), not a defect.
  const start = Date.UTC(2023, 10, 15, 7, 30); // 23:30 in Los Angeles on the 14th
  const h = harness({ now: start + 2 * HOUR });
  const crossing = payload({
    startedAt: start,
    endedAt: start + 1_320_000,
    events: [event({ startedAt: start + 300_000, durationS: 24, durationMs: 24_000, context: { night: false, precipitation: false } })],
  });
  assertEquals((await json(await handleFinalizeTrip(post(crossing), h.deps))).body.provisionalMismatch, true);
  const [message, fields] = h.warnings[0] as [string, { nightBoundary: boolean }];
  assertEquals(message, 'finalize-trip mismatch');
  assertEquals(fields.nightBoundary, true);

  // a mismatch with every night flag agreeing is not explained by the boundary
  const off = harness();
  const p = payload();
  await handleFinalizeTrip(post({ ...p, provisional: { ...p.provisional, score: (p.provisional.score as number) - 3 } }), off.deps);
  assertEquals((off.warnings[0][1] as { nightBoundary: boolean }).nightBoundary, false);
});

Deno.test('a provisional score more than 2 points off is reported and logged; the server score wins', async () => {
  const h = harness();
  const p = payload();
  const device = { ...p.provisional, score: (p.provisional.score as number) - 3 };
  const { status, body } = await json(await handleFinalizeTrip(post({ ...p, provisional: device }), h.deps));
  assertEquals(status, 200);
  assertEquals(body.provisionalMismatch, true);
  assertEquals(body.score, p.provisional.score);
  assertEquals(h.warnings.length, 1);
  assertMatch(String(h.warnings[0][0]), /mismatch/);
  assertEquals((h.warnings[0][1] as { clientTripId: string }).clientTripId, CLIENT_TRIP_ID);
  assertEquals((h.warnings[0][1] as { delta: number }).delta, 3);
});

Deno.test('a provisional score within 2 points is not a mismatch', async () => {
  const h = harness();
  const p = payload();
  const device = { ...p.provisional, score: (p.provisional.score as number) - 2 };
  const { body } = await json(await handleFinalizeTrip(post({ ...p, provisional: device }), h.deps));
  assertEquals(body.provisionalMismatch, false);
  assertEquals(h.warnings.length, 0);
});

Deno.test('a device status that differs from the server\'s is a mismatch', async () => {
  const h = harness();
  const p = payload();
  const device = { ...p.provisional, score: null, status: 'unscored' as const, reason: 'too_short' as const };
  const { body } = await json(await handleFinalizeTrip(post({ ...p, provisional: device }), h.deps));
  assertEquals(body.status, 'final');
  assertEquals(body.provisionalMismatch, true);
});

Deno.test('a trip without a trace is scored at grade B at best', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payload({ tracePath: null })), h.deps);
  assertEquals(res.status, 200);
  const e = envelope(h);
  assertEquals(e.payload.tracePath, null);
  assertEquals(e.scored.dataQuality, 'B');
  assertEquals(e.payload.rowsDigest.imuPresent, true); // the digest is stored as sent
});

Deno.test('a trip already stored replays its result and its stored day row without calling the writer', async () => {
  const h = harness({
    tables: {
      trips: [tripRow({ id: 'stored', client_trip_id: CLIENT_TRIP_ID, score: 77, trace_path: `${UID}/${CLIENT_TRIP_ID}.bin.gz` })],
      score_daily: [dayRowRecord()],
    },
  });
  const { status, body } = await json(await handleFinalizeTrip(post(payload()), h.deps));
  assertEquals(status, 200);
  assertEquals(body, {
    tripId: 'stored',
    score: 77,
    status: 'final',
    day: {
      day: TRIP_DAY,
      longTermScore: 81,
      band: 'good',
      provisional: false,
      safeDay: true,
      goodDay: false,
      phoneFreeDay: true,
      cameraDay: false,
      exposure: 2.5,
      drivingS: 2400,
      tripsScored: 2,
      severeEvents: 0,
    },
    trip: {
      categoryDeductions: { phone: 0, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0 },
      exposure: 1,
      dataQuality: 'A',
      hadSevereEvent: false,
      limitCoveragePct: null,
    },
    provisionalMismatch: false,
    replayed: true,
  });
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a replay is answered from the store even if the payload would fail plausibility today', async () => {
  const h = harness({
    tables: { trips: [tripRow({ id: 'stored', client_trip_id: CLIENT_TRIP_ID })], score_daily: [] },
  });
  const p = payload({ rowsDigest: { ...payload().rowsDigest, maxSustainedSpeedMps: 60 } });
  const { status, body } = await json(await handleFinalizeTrip(post(p), h.deps));
  assertEquals(status, 200);
  assertEquals(body.replayed, true);
  assertEquals(body.day, emptyDayRow(TRIP_DAY)); // no stored day row: an empty one, never a missing field
});

Deno.test('a replay for a trip the user has since deleted is still 200 replayed', async () => {
  const h = harness({
    tables: {
      trips: [tripRow({ id: 'gone', client_trip_id: CLIENT_TRIP_ID, deleted_at: new Date(T0).toISOString() })],
      score_daily: [],
    },
  });
  const { status, body } = await json(await handleFinalizeTrip(post(payload()), h.deps));
  assertEquals(status, 200);
  assertEquals(body.replayed, true);
  assertEquals(body.tripId, 'gone');
});

Deno.test('the loser of a concurrent first upload gets the stored day row with replayed: true', async () => {
  const h = harness({ rpcReplayed: true, tables: { trips: [], trip_events: [], score_daily: [dayRowRecord({ long_term_score: 66 })] } });
  const { status, body } = await json(await handleFinalizeTrip(post(payload()), h.deps));
  assertEquals(status, 200);
  assertEquals(body.replayed, true);
  assertEquals((body.day as DayRow).longTermScore, 66);
});

Deno.test('a stored trace path that is not the derived key is an integrity failure, not a client error', async () => {
  const h = harness({
    tables: { trips: [tripRow({ id: 'odd', client_trip_id: CLIENT_TRIP_ID, trace_path: `${UID}/other.bin.gz` })] },
  });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 500,
    body: { code: 'trace_path_mismatch' },
  });
  assertEquals(h.errors.length, 1);
});

Deno.test('the 201st upload in 24 hours is 429, whatever day the trip is dated', async () => {
  const recent = Array.from({ length: MAX_TRIPS_PER_24H }, (_, i) =>
    tripRow({ client_trip_id: `t${i}`, created_at: new Date(NOW - i * 60_000).toISOString(), local_day: '2023-10-01' })
  );
  const h = harness({ tables: { trips: recent, trip_events: [], score_daily: [] } });
  const backdated = dated(T0 - 3 * DAY_MS);
  assertEquals(await json(await handleFinalizeTrip(post(backdated), h.deps)), {
    status: 429,
    body: { code: 'too_many_trips' },
  });
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('uploads older than 24 hours no longer count against the cap', async () => {
  const old = Array.from({ length: MAX_TRIPS_PER_24H }, (_, i) =>
    tripRow({ client_trip_id: `t${i}`, created_at: new Date(NOW - 25 * HOUR - i * 60_000).toISOString() })
  );
  const h = harness({ tables: { trips: old, trip_events: [], score_daily: [] } });
  assertEquals((await handleFinalizeTrip(post(payload()), h.deps)).status, 200);
});

Deno.test('a client-supplied request id is ignored: the log id is generated and returned', async () => {
  const h = harness();
  const p = payload();
  const device = { ...p.provisional, score: (p.provisional.score as number) - 5 };
  const res = await handleFinalizeTrip(post({ ...p, provisional: device }, GOOD_TOKEN, { 'x-request-id': 'evil' }), h.deps);
  assertEquals(res.status, 200);
  const id = (h.warnings[0][1] as { requestId: string }).requestId;
  assertNotEquals(id, 'evil');
  assertMatch(id, UUID);
  assertEquals(res.headers.get('x-request-id'), id);
});

Deno.test('a writer lock or serialization failure is 503 with Retry-After', async () => {
  for (const code of ['55P03', '40P01', '40001']) {
    const h = harness({ rpcError: { code, message: 'busy' } });
    const res = await handleFinalizeTrip(post(payload()), h.deps);
    assertEquals(res.status, 503, code);
    assertEquals(res.headers.get('retry-after'), '2');
    assertEquals((await res.json()).code, 'retry');
  }
});

Deno.test('a writer envelope or row refusal is 400 with the code only; the message goes to the log', async () => {
  const shape = harness({ rpcError: { code: '22023', message: 'apply_trip day does not match the trip' } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), shape.deps)), {
    status: 400,
    body: { code: 'invalid_envelope' },
  });
  assertEquals(shape.errors.length, 1);
  const logged = shape.errors[0][1] as { message: string; tz: string };
  assertEquals(logged.message, 'apply_trip day does not match the trip');
  assertEquals(logged.tz, 'America/Los_Angeles');
  for (const code of ['23514', '23505', '22P02', '23502', '22003']) {
    const h = harness({ rpcError: { code, message: 'new row for relation "trips" violates check constraint "x"' } });
    assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
      status: 400,
      body: { code: 'invalid_event_rows' },
    });
    assertEquals(h.errors.length, 1);
  }
});

Deno.test('a drive from an account with no age answer yet is retryable (0006), never a 403', async () => {
  const h = harness({ rpcError: { code: '55000', message: 'age not confirmed yet' } });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('retry-after'), '900');
  assertEquals(await res.json(), { code: 'age_pending' });
});

Deno.test('a drive from an under-13 account is refused for good (0006)', async () => {
  const h = harness({ rpcError: { code: '42501', message: 'account not eligible' } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 403,
    body: { code: 'forbidden' },
  });
});

Deno.test('a writer that refuses the service role is a server misconfiguration', async () => {
  const h = harness({ rpcError: { code: '42501', message: 'apply_trip requires the service role' } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 500,
    body: { code: 'misconfigured' },
  });
  assertEquals(h.errors.length, 1);
});

Deno.test('any other failure is 500 with no detail', async () => {
  const h = harness({ rpcError: { code: 'XX000', message: 'kaboom' } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 500,
    body: { code: 'internal' },
  });
  assertEquals(h.errors.length, 1);
});
