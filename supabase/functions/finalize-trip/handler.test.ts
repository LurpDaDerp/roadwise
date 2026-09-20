import { assert, assertEquals, assertMatch } from '@std/assert';
import { scoreTrip } from '../_shared/scoring/index';
import { createDb, type ApplyTripEnvelope } from '../_shared/db.ts';
import { tripMetrics } from '../_shared/plausibility.ts';
import { fakeSupabase, type RpcError } from '../_shared/testing/fake_supabase.ts';
import { CLIENT_TRIP_ID, event, payload, T0, TRIP_DAY, tripRow, UID } from '../_shared/testing/fixtures.ts';
import { handleFinalizeTrip, MAX_BODY_BYTES, MAX_TRIPS_PER_DAY, type FinalizeDeps } from './handler.ts';

const DAY_MS = 86_400_000;
const GOOD_TOKEN = 'good-token';

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
    now?: number;
  } = {}
): Harness {
  const fake = fakeSupabase({
    tables: opts.tables ?? { trips: [], trip_events: [] },
    rpc: (_fn, args) => {
      if (opts.rpcError) return { error: opts.rpcError };
      const p = args.p as ApplyTripEnvelope;
      return {
        data: {
          trip_id: 'new-trip-id',
          score: p.scored.score,
          status: p.scored.status,
          day: p.day[0].day,
          replayed: false,
        },
      };
    },
  });
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const deps: FinalizeDeps = {
    verifyJwt: (token) => Promise.resolve(token === GOOD_TOKEN ? UID : null),
    db: createDb(fake.client),
    now: () => opts.now ?? T0 + 2 * 3_600_000,
    log: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) },
  };
  return { deps, fake, warnings, errors };
}

const post = (body: unknown, token: string | null = GOOD_TOKEN, init: RequestInit = {}) =>
  new Request('http://local/finalize-trip', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

const envelope = (h: Harness): ApplyTripEnvelope => {
  assertEquals(h.fake.rpcCalls.length, 1);
  assertEquals(h.fake.rpcCalls[0].fn, 'apply_trip');
  return h.fake.rpcCalls[0].args.p as ApplyTripEnvelope;
};

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

Deno.test('a body over 1 MB is 413', async () => {
  const h = harness();
  const big = `{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
  assertEquals(await json(await handleFinalizeTrip(post(big), h.deps)), {
    status: 413,
    body: { code: 'payload_too_large' },
  });
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
  const bad = { ...payload(), events: [event({ durationMs: 999 })], extra: 1 };
  const { status, body } = await json(await handleFinalizeTrip(post(bad), h.deps));
  assertEquals(status, 400);
  assertEquals(body.code, 'invalid_payload');
  const paths = (body.issues as { path: string }[]).map((i) => i.path);
  assert(paths.includes('events.0.durationMs'), `paths: ${paths.join(', ')}`);
  assert(paths.some((p) => p === '' || p === 'extra'), `unknown key not reported: ${paths.join(', ')}`);
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('an implausible trip is 400 with the rule code and field, before any lookup', async () => {
  const h = harness();
  const p = payload({ rowsDigest: { ...payload().rowsDigest, maxSustainedSpeedMps: 60 } });
  assertEquals(await json(await handleFinalizeTrip(post(p), h.deps)), {
    status: 400,
    body: { code: 'implausible_speed', field: 'rowsDigest.maxSustainedSpeedMps' },
  });
  assertEquals(h.fake.queries.length, 0);
});

Deno.test('the happy path re-scores, builds the envelope from the JWT user and answers with the writer result', async () => {
  const h = harness();
  const p = payload();
  const res = await handleFinalizeTrip(post({ ...p, userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), h.deps);
  // the smuggled key is refused by the strict contract, so send the clean payload
  assertEquals(res.status, 400);
  const ok = await handleFinalizeTrip(post(p), h.deps);
  const expected = scoreTrip(tripMetrics(p, []), p.events);
  assertEquals(await json(ok), {
    status: 200,
    body: {
      tripId: 'new-trip-id',
      score: expected.score,
      status: 'final',
      day: TRIP_DAY,
      provisionalMismatch: false,
      replayed: false,
    },
  });
  const e = envelope(h);
  assertEquals(e.userId, UID);
  assertEquals(e.payload, p);
  assertEquals(e.scored, expected);
  assertEquals(e.day.length, 1);
  assertEquals(e.day[0].day, TRIP_DAY);
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].drivingS, 1320);
  assertEquals(e.day[0].exposure, expected.exposure);
  assertEquals(e.day[0].phoneFreeDay, false);
  // one trip: the long-term score is withheld, the day row says so
  assertEquals(e.day[0].longTermScore, null);
  assertEquals(e.day[0].provisional, true);
  assertEquals(e.baselines?.medians.score, expected.score);
  assertEquals(e.conditions, { night: false, precipitation: false });
  assertEquals(e.limitCoveragePct, null);
  assertEquals(h.warnings.length, 0);
  assertEquals(h.fake.storageTouched(), false);
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
  const h = harness({ tables: { trips: stored, trip_events: [{ trip_id: 's0', category: 'phone', status: 'scored' }] } });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const e = envelope(h);
  assertEquals(e.day.length, 1);
  assert(typeof e.day[0].longTermScore === 'number');
  assertEquals(e.day[0].provisional, false);
  assertEquals(e.day[0].tripsScored, 2); // s0 and the new trip
  assertEquals(e.day[0].drivingS, 1500 + 1320);
  assertEquals(e.day[0].phoneFreeDay, false);
  assertEquals(e.baselines?.medians.phone, 3); // median of 0, 2, 4 and the new trip's own ~10.2
});

Deno.test('a trip synced on a later day also writes today\'s row', async () => {
  const h = harness({ now: T0 + 3 * DAY_MS });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const e = envelope(h);
  assertEquals(
    e.day.map((d) => d.day),
    [TRIP_DAY, '2023-11-17']
  );
  assertEquals(e.day[1].tripsScored, 0);
  assertEquals(e.day[1].longTermScore, e.day[0].longTermScore);
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

Deno.test('a trip already stored replays its result without calling the writer', async () => {
  const h = harness({
    tables: {
      trips: [tripRow({ id: 'stored', client_trip_id: CLIENT_TRIP_ID, score: 77, trace_path: `${UID}/${CLIENT_TRIP_ID}.bin.gz` })],
    },
  });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 200,
    body: { tripId: 'stored', score: 77, status: 'final', day: TRIP_DAY, provisionalMismatch: false, replayed: true },
  });
  assertEquals(h.fake.rpcCalls.length, 0);
});

Deno.test('a replay for a trip the user has since deleted is still 200 replayed', async () => {
  const h = harness({
    tables: {
      trips: [tripRow({ id: 'gone', client_trip_id: CLIENT_TRIP_ID, deleted_at: new Date(T0).toISOString() })],
    },
  });
  const { status, body } = await json(await handleFinalizeTrip(post(payload()), h.deps));
  assertEquals(status, 200);
  assertEquals(body.replayed, true);
  assertEquals(body.tripId, 'gone');
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

Deno.test('the 201st trip of a local day is 429', async () => {
  const many = Array.from({ length: MAX_TRIPS_PER_DAY }, (_, i) => tripRow({ client_trip_id: `t${i}` }));
  const h = harness({ tables: { trips: many, trip_events: [] } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
    status: 429,
    body: { code: 'too_many_trips' },
  });
  assertEquals(h.fake.rpcCalls.length, 0);
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

Deno.test('a writer envelope or row refusal is 400 with the writer\'s message', async () => {
  const shape = harness({ rpcError: { code: '22023', message: 'apply_trip day does not match the trip' } });
  assertEquals(await json(await handleFinalizeTrip(post(payload()), shape.deps)), {
    status: 400,
    body: { code: 'invalid_envelope', message: 'apply_trip day does not match the trip' },
  });
  for (const code of ['23514', '23505', '22P02', '23502']) {
    const h = harness({ rpcError: { code, message: 'row refused' } });
    assertEquals(await json(await handleFinalizeTrip(post(payload()), h.deps)), {
      status: 400,
      body: { code: 'invalid_event_rows', message: 'row refused' },
    });
  }
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
