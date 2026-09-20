import { assert, assertEquals, assertMatch } from '@std/assert';
import { createActionsDb, type RecomputeEnvelope } from '../_shared/actions_db.ts';
import { scoreTrip } from '../_shared/scoring/index';
import type { ScorableEvent, ScoredTrip, TripMetrics } from '../_shared/scoring/index';
import { fakeActionsClient, type RecordedCall } from '../_shared/testing/fake_actions_client.ts';
import {
  CLIENT_EVENT_ID,
  EVENT_ID,
  ROWS_DIGEST,
  storedEventRow,
  storedTripRow,
  TRACE_KEY,
  TRIP_ID,
} from '../_shared/testing/action_fixtures.ts';
import { CLIENT_TRIP_ID, T0, TRIP_DAY, tripRow, UID } from '../_shared/testing/fixtures.ts';
import type { RpcError } from '../_shared/testing/fake_supabase.ts';
import { handleTripAction, MAX_BODY_BYTES, MAX_DENIED_PER_DAY, type ActionsDeps } from './handler.ts';

const DAY_MS = 86_400_000;
const GOOD_TOKEN = 'good-token';
const NOW = T0 + 2 * 3_600_000;

type Row = Record<string, unknown>;
type RpcReply = { data?: unknown; error?: RpcError | null };

interface Harness {
  deps: ActionsDeps;
  fake: ReturnType<typeof fakeActionsClient>;
  warnings: unknown[][];
  errors: unknown[][];
}

const allowance = (overrides: Record<string, unknown> = {}) => ({
  used_7d: 0,
  limit_7d: 3,
  remaining_7d: 3,
  disputed_30d: 0,
  scored_30d: 5,
  max_30d: 1,
  remaining_30d: 1,
  remaining_allowance: 1,
  can_auto_accept: true,
  denied_reason: null,
  ...overrides,
});

const accepted = (overrides: Record<string, unknown> = {}) => ({
  dispute_id: 'dispute-1',
  trip_id: TRIP_ID,
  auto_accepted: true,
  consumed: true,
  denied_reason: null,
  remaining_7d: 2,
  remaining_30d: 0,
  remaining_allowance: 0,
  event_status: 'disputed',
  replayed: false,
  ...overrides,
});

/** The writers as the fake answers them; a test overrides one function at a time. */
function writers(overrides: Record<string, (args: Record<string, unknown>) => RpcReply> = {}) {
  return (fn: string, args: Record<string, unknown>): RpcReply => {
    if (overrides[fn]) return overrides[fn](args);
    switch (fn) {
      case 'count_dispute_allowance':
        return { data: allowance() };
      case 'record_dispute':
        return { data: accepted() };
      case 'set_trip_role_row': {
        const driver = args.p_role === 'driver';
        return {
          data: { trip_id: args.p_trip_id, role: args.p_role, status: driver ? 'final' : 'unscored', score: driver ? 90 : null },
        };
      }
      case 'soft_delete_trip':
        return { data: { trip_id: args.p_trip_id, trace_path: TRACE_KEY, replayed: false } };
      case 'apply_recompute': {
        const scored = args.p_scored as ScoredTrip | null;
        return {
          data: { trip_id: args.p_trip_id, score: scored ? scored.score : 90, status: scored ? scored.status : 'final' },
        };
      }
      default:
        return { error: { code: 'XX000', message: `unexpected rpc ${fn}` } };
    }
  };
}

function harness(
  opts: {
    tables?: Record<string, Row[]>;
    rpc?: Record<string, (args: Record<string, unknown>) => RpcReply>;
    storageError?: { message: string } | null;
    now?: number;
  } = {}
): Harness {
  const fake = fakeActionsClient({
    tables: opts.tables ?? { trips: [storedTripRow()], trip_events: [storedEventRow()], event_disputes: [] },
    rpc: writers(opts.rpc),
    storageError: opts.storageError ?? null,
  });
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const deps: ActionsDeps = {
    verifyJwt: (token) => Promise.resolve(token === GOOD_TOKEN ? UID : null),
    db: createActionsDb(fake.client),
    now: () => opts.now ?? NOW,
    log: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) },
  };
  return { deps, fake, warnings, errors };
}

const post = (body: unknown, token: string | null = GOOD_TOKEN) =>
  new Request('http://local/trip-actions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

const dispute = (overrides: Record<string, unknown> = {}) => ({
  action: 'dispute',
  clientEventId: CLIENT_EVENT_ID,
  reason: 'passenger_phone',
  ...overrides,
});
const setRole = (role: string) => ({ action: 'set-role', clientTripId: CLIENT_TRIP_ID, role });
const del = () => ({ action: 'delete', clientTripId: CLIENT_TRIP_ID });

const rpcNames = (h: Harness) => h.fake.calls.filter((c) => c.kind === 'rpc').map((c) => c.name);
const rpcArgs = (h: Harness, fn: string) => {
  const call = h.fake.rpcCalls.find((c) => c.fn === fn);
  assert(call, `${fn} was not called; calls: ${rpcNames(h).join(', ')}`);
  return call.args;
};
const recompute = (h: Harness): RecomputeEnvelope => {
  const a = rpcArgs(h, 'apply_recompute');
  return {
    userId: a.p_user as string,
    tripId: a.p_trip_id as string,
    scored: a.p_scored as ScoredTrip | null,
    events: a.p_events as RecomputeEnvelope['events'],
    day: a.p_day as RecomputeEnvelope['day'],
    baselines: a.p_baselines as RecomputeEnvelope['baselines'],
  };
};

/** The scorer's own answer over the stored rows, for the assertions to compare against. */
const storedMetrics = (role: TripMetrics['role'] = 'driver', imuPresent = true): TripMetrics => ({
  distanceM: 13_200,
  durationS: 1320,
  validGnssPct: ROWS_DIGEST.validGnssPct,
  imuPresent,
  role,
  maxSustainedSpeedMps: ROWS_DIGEST.maxSustainedSpeedMps,
});
const storedEvent = (status: ScorableEvent['status'] = 'scored'): ScorableEvent => ({
  id: CLIENT_EVENT_ID,
  category: 'phone',
  startedAt: T0 + 300_000,
  durationS: 12,
  q: 0.9,
  corrected: false,
  status,
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
});

// --- request plumbing ---------------------------------------------------------------------------

Deno.test('anything but POST is 405', async () => {
  const h = harness();
  const res = await handleTripAction(new Request('http://local/trip-actions', { method: 'GET' }), h.deps);
  assertEquals(await json(res), { status: 405, body: { code: 'method_not_allowed' } });
  assertEquals(res.headers.get('allow'), 'POST');
});

Deno.test('a missing or unverifiable bearer token is 401 and nothing is read', async () => {
  const h = harness();
  assertEquals(await json(await handleTripAction(post(del(), null), h.deps)), {
    status: 401,
    body: { code: 'unauthorized' },
  });
  assertEquals(await json(await handleTripAction(post(del(), 'forged'), h.deps)), {
    status: 401,
    body: { code: 'unauthorized' },
  });
  assertEquals(h.fake.queries.length, 0);
  assertEquals(h.fake.calls.length, 0);
});

Deno.test('malformed JSON is 400 and an oversized body is 413', async () => {
  const h = harness();
  assertEquals(await json(await handleTripAction(post('{nope'), h.deps)), {
    status: 400,
    body: { code: 'invalid_json' },
  });
  const big = `{"pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
  assertEquals(await json(await handleTripAction(post(big), h.deps)), {
    status: 413,
    body: { code: 'payload_too_large' },
  });
});

Deno.test('each action is checked against its strict contract', async () => {
  const h = harness();
  const cases: [unknown, string][] = [
    [{ action: 'explode', clientTripId: CLIENT_TRIP_ID }, 'action'],
    [dispute({ reason: 'because' }), 'reason'],
    [dispute({ statedLimitMph: 4 }), 'statedLimitMph'],
    [dispute({ statedLimitMph: 35.5 }), 'statedLimitMph'],
    [dispute({ note: 'x'.repeat(501) }), 'note'],
    [dispute({ clientEventId: '' }), 'clientEventId'],
    [setRole('unknown'), 'role'],
    [{ action: 'set-role', clientTripId: 'not/a/key', role: 'driver' }, 'clientTripId'],
    [{ ...del(), userId: UID }, 'userId'],
    [{ action: 'delete' }, 'clientTripId'],
  ];
  for (const [body, path] of cases) {
    const { status, body: reply } = await json(await handleTripAction(post(body), h.deps));
    assertEquals(status, 400, JSON.stringify(body));
    assertEquals(reply.code, 'invalid_payload');
    const paths = (reply.issues as { path: string }[]).map((i) => i.path);
    assert(paths.some((p) => p === path || p === ''), `${JSON.stringify(body)}: ${paths.join(', ')}`);
  }
  assertEquals(h.fake.queries.length, 0);
  assertEquals(h.fake.calls.length, 0);
});

// --- lookups ------------------------------------------------------------------------------------

Deno.test('an event the user does not have is 404 and nothing is written', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow()],
      trip_events: [storedEventRow({ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
      event_disputes: [],
    },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 404,
    body: { code: 'not_found' },
  });
  assertEquals(h.fake.calls.length, 0);
});

Deno.test('a trip the user does not have is 404 for set-role and delete', async () => {
  const h = harness({
    tables: { trips: [storedTripRow({ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })], trip_events: [], event_disputes: [] },
  });
  assertEquals(await json(await handleTripAction(post(setRole('passenger')), h.deps)), {
    status: 404,
    body: { code: 'not_found' },
  });
  assertEquals(await json(await handleTripAction(post(del()), h.deps)), { status: 404, body: { code: 'not_found' } });
  assertEquals(h.fake.calls.length, 0);
});

Deno.test('a client event id that matches two stored events is an integrity failure', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow()],
      trip_events: [storedEventRow(), storedEventRow({ id: 'event-0002', trip_id: 'trip-0002' })],
      event_disputes: [],
    },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 409,
    body: { code: 'ambiguous_event' },
  });
  assertEquals(h.errors.length, 1);
  assertEquals(h.fake.calls.length, 0);
});

// --- dispute ------------------------------------------------------------------------------------

Deno.test('an accepted dispute records it, re-scores with the event removed and applies the recompute as the JWT user', async () => {
  const h = harness();
  const res = await handleTripAction(post(dispute({ note: 'my sister had it', statedLimitMph: null })), h.deps);
  const before = scoreTrip(storedMetrics(), [storedEvent('scored')]);
  const after = scoreTrip(storedMetrics(), [storedEvent('removed')]);
  assert((before.score as number) < (after.score as number));
  assertEquals(await json(res), {
    status: 200,
    body: {
      tripId: TRIP_ID,
      score: after.score,
      status: 'final',
      autoAccepted: true,
      remainingAllowance: 0,
      reason: null,
      replayed: false,
    },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute', 'apply_recompute']);
  assertEquals(rpcArgs(h, 'count_dispute_allowance'), { p_user: UID });
  assertEquals(rpcArgs(h, 'record_dispute'), {
    p_user: UID,
    p_event_id: EVENT_ID,
    p_reason: 'passenger_phone',
    p_note: 'my sister had it',
    p_stated_limit_mph: null,
  });
  const e = recompute(h);
  assertEquals(e.userId, UID);
  assertEquals(e.tripId, TRIP_ID);
  assertEquals(e.scored, after);
  assertEquals(e.events, [{ id: EVENT_ID, status: 'removed', deduction: 0 }]);
  assertEquals(e.day.length, 1);
  assertEquals(e.day[0].day, TRIP_DAY);
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].drivingS, 1320);
  assertEquals(e.day[0].exposure, after.exposure);
  // the disputed pickup was the day's only phone event
  assertEquals(e.day[0].phoneFreeDay, true);
  assertEquals(e.day[0].longTermScore, null);
  assertEquals(e.baselines?.medians.score, after.score);
  assertEquals(e.baselines?.medians.phone, 0);
  assertEquals(h.fake.storageCalls.length, 0);
  assertEquals(h.warnings.length, 0);
});

Deno.test('the stored trips around the disputed one feed the long-term score, the day and the baselines with the new score', async () => {
  const others = [1, 2, 3].map((i) =>
    tripRow({
      id: `other-${i}`,
      score: 80,
      duration_s: 1500,
      exposure: 1.5,
      ended_at: new Date(T0 - i * DAY_MS).toISOString(),
      local_day: i === 1 ? TRIP_DAY : `2023-11-1${4 - i}`,
      category_deductions: { phone: 6, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    })
  );
  const h = harness({
    tables: {
      trips: [storedTripRow(), ...others],
      trip_events: [storedEventRow(), { trip_id: 'other-1', category: 'phone', status: 'scored' }],
      event_disputes: [],
    },
  });
  const res = await handleTripAction(post(dispute()), h.deps);
  assertEquals(res.status, 200);
  const e = recompute(h);
  const after = scoreTrip(storedMetrics(), [storedEvent('removed')]);
  assert(typeof e.day[0].longTermScore === 'number');
  assertEquals(e.day[0].provisional, false);
  assertEquals(e.day[0].tripsScored, 2);
  assertEquals(e.day[0].drivingS, 1500 + 1320);
  // other-1 still has its scored phone event
  assertEquals(e.day[0].phoneFreeDay, false);
  // medians over the three stored trips and the re-scored one: phone 6, 6, 6, 0 and score 80, 80,
  // 80, 100 — the sorted middle pairs are 6/6 and 80/80
  assert((after.score as number) > 80);
  assertEquals(e.baselines?.medians.phone, 6);
  assertEquals(e.baselines?.medians.score, 80);
});

Deno.test("a dispute synced on a later day also refreshes today's row", async () => {
  const h = harness({ now: T0 + 3 * DAY_MS });
  assertEquals((await handleTripAction(post(dispute()), h.deps)).status, 200);
  const e = recompute(h);
  assertEquals(
    e.day.map((d) => d.day),
    [TRIP_DAY, '2023-11-17']
  );
  assertEquals(e.day[1].tripsScored, 0);
  assertEquals(e.day[1].longTermScore, e.day[0].longTermScore);
});

Deno.test("a denied dispute answers with the writer's reason and does not recompute", async () => {
  const h = harness({
    rpc: {
      count_dispute_allowance: () => ({
        data: allowance({ used_7d: 3, remaining_7d: 0, remaining_allowance: 0, can_auto_accept: false, denied_reason: 'allowance_7d' }),
      }),
      record_dispute: () => ({
        data: accepted({
          auto_accepted: false,
          consumed: false,
          denied_reason: 'allowance_7d',
          remaining_7d: 0,
          remaining_allowance: 0,
          event_status: 'scored',
        }),
      }),
    },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 200,
    body: {
      tripId: TRIP_ID,
      score: 90,
      status: 'final',
      autoAccepted: false,
      remainingAllowance: 0,
      reason: 'allowance_7d',
      replayed: false,
    },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute']);
});

Deno.test('a replayed dispute whose event is already removed answers from the stored trip without a recompute', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow({ score: 96 })],
      trip_events: [storedEventRow({ status: 'removed', deduction: 0 })],
      event_disputes: [],
    },
    rpc: { record_dispute: () => ({ data: accepted({ event_status: 'removed', replayed: true, remaining_allowance: 0 }) }) },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, score: 96, status: 'final', autoAccepted: true, remainingAllowance: 0, reason: null, replayed: true },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute']);
});

Deno.test('a replayed accepted dispute whose recompute never landed finishes it', async () => {
  const h = harness({
    tables: { trips: [storedTripRow()], trip_events: [storedEventRow({ status: 'disputed' })], event_disputes: [] },
    rpc: { record_dispute: () => ({ data: accepted({ event_status: 'disputed', replayed: true }) }) },
  });
  const { status, body } = await json(await handleTripAction(post(dispute()), h.deps));
  assertEquals(status, 200);
  assertEquals(body.replayed, true);
  assertEquals(body.score, scoreTrip(storedMetrics(), [storedEvent('removed')]).score);
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute', 'apply_recompute']);
  assertEquals(recompute(h).events, [{ id: EVENT_ID, status: 'removed', deduction: 0 }]);
});

Deno.test('a dispute on a trip the user has since deleted is 200 replayed and writes nothing', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow({ deleted_at: new Date(T0 + DAY_MS).toISOString(), trace_path: null })],
      trip_events: [storedEventRow()],
      event_disputes: [],
    },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, score: 90, status: 'final', autoAccepted: false, remainingAllowance: 1, reason: null, replayed: true },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance']);
});

Deno.test('a user out of allowance with 20 denied disputes in 24 hours is 429 before the writer', async () => {
  const denied = Array.from({ length: MAX_DENIED_PER_DAY }, (_, i) => ({
    id: `d${i}`,
    user_id: UID,
    auto_accepted: false,
    created_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
  }));
  const exhausted = {
    count_dispute_allowance: () => ({
      data: allowance({ used_7d: 3, remaining_7d: 0, remaining_allowance: 0, can_auto_accept: false, denied_reason: 'allowance_7d' }),
    }),
  };
  const h = harness({ tables: { trips: [storedTripRow()], trip_events: [storedEventRow()], event_disputes: denied }, rpc: exhausted });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 429,
    body: { code: 'too_many_disputes' },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance']);

  // denials older than a day, and accepted disputes, do not count
  const stale = denied.map((d) => ({ ...d, created_at: new Date(NOW - 25 * 3_600_000).toISOString() }));
  const acceptedRows = denied.map((d) => ({ ...d, auto_accepted: true }));
  for (const rows of [stale, acceptedRows]) {
    const ok = harness({ tables: { trips: [storedTripRow()], trip_events: [storedEventRow()], event_disputes: rows }, rpc: exhausted });
    assertEquals((await handleTripAction(post(dispute()), ok.deps)).status, 200);
    assertEquals(rpcNames(ok), ['count_dispute_allowance', 'record_dispute', 'apply_recompute']);
  }
});

Deno.test('a user with allowance left is not held back by old denials', async () => {
  const denied = Array.from({ length: MAX_DENIED_PER_DAY + 5 }, (_, i) => ({
    id: `d${i}`,
    user_id: UID,
    auto_accepted: false,
    created_at: new Date(NOW - (i + 1) * 60_000).toISOString(),
  }));
  const h = harness({ tables: { trips: [storedTripRow()], trip_events: [storedEventRow()], event_disputes: denied } });
  assertEquals((await handleTripAction(post(dispute()), h.deps)).status, 200);
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute', 'apply_recompute']);
  // the count query was never made
  assertEquals(
    h.fake.queries.some((q) => q.table === 'event_disputes'),
    false
  );
});

Deno.test("the writer's not-scored and window-closed refusals are 422", async () => {
  const cases: [string, string][] = [
    ['trip is not scored', 'trip_not_scored'],
    ['event is not scored', 'event_not_scored'],
    ['dispute window closed', 'dispute_window_closed'],
  ];
  for (const [message, code] of cases) {
    const h = harness({ rpc: { record_dispute: () => ({ error: { code: '22023', message } }) } });
    assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), { status: 422, body: { code } });
    assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute']);
  }
});

Deno.test('a stored digest the contract does not recognise is an integrity failure before any recompute', async () => {
  const h = harness({
    tables: { trips: [storedTripRow({ rows_digest: {} })], trip_events: [storedEventRow()], event_disputes: [] },
  });
  assertEquals(await json(await handleTripAction(post(dispute()), h.deps)), {
    status: 500,
    body: { code: 'rows_digest_invalid' },
  });
  assertEquals(rpcNames(h), ['count_dispute_allowance', 'record_dispute']);
  assertEquals(h.errors.length, 1);
});

Deno.test('a trip stored without a trace is re-scored at grade B at best, and a grade drift is logged', async () => {
  const h = harness({
    tables: { trips: [storedTripRow({ trace_path: null, data_quality: 'A' })], trip_events: [storedEventRow()], event_disputes: [] },
  });
  assertEquals((await handleTripAction(post(dispute()), h.deps)).status, 200);
  const e = recompute(h);
  assertEquals(e.scored?.dataQuality, 'B');
  assertEquals(e.scored, scoreTrip(storedMetrics('driver', false), [storedEvent('removed')]));
  assertEquals(h.warnings.length, 1);
  assertMatch(String(h.warnings[0][0]), /quality/);
});

Deno.test('the re-score takes severity and context from the stored measurements, not from the stored columns', async () => {
  // a night phone pickup at 30 mph, stored with a client-asserted severity of 0 and multiplier of 1
  const h = harness({
    tables: {
      trips: [storedTripRow()],
      trip_events: [
        storedEventRow(),
        storedEventRow({
          id: 'event-0002',
          client_event_id: 'p2',
          started_at: new Date(T0 + 900_000).toISOString(),
          measured: { speedMps: 13.4112 },
          context: { night: true, precipitation: false },
          severity: 0,
          context_multiplier: 1,
          deduction: 0,
        }),
      ],
      event_disputes: [],
    },
  });
  assertEquals((await handleTripAction(post(dispute()), h.deps)).status, 200);
  const e = recompute(h);
  const night: ScorableEvent = {
    ...storedEvent('scored'),
    id: 'p2',
    startedAt: T0 + 900_000,
    measured: { speedMps: 13.4112 },
    context: { night: true, precipitation: false },
  };
  const expected = scoreTrip(storedMetrics(), [storedEvent('removed'), night]);
  assertEquals(e.scored, expected);
  assert(expected.eventDeductions.p2 > 0);
  assertEquals(e.events, [
    { id: EVENT_ID, status: 'removed', deduction: 0 },
    { id: 'event-0002', status: 'scored', deduction: expected.eventDeductions.p2 },
  ]);
});

// --- set-role -----------------------------------------------------------------------------------

Deno.test('set-role passenger unscores the trip and applies an unscored envelope with the day refreshed', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow(), tripRow({ id: 'same-day', score: 80, duration_s: 1500, exposure: 1.5 })],
      trip_events: [storedEventRow()],
      event_disputes: [],
    },
  });
  assertEquals(await json(await handleTripAction(post(setRole('passenger')), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, role: 'passenger', score: null, status: 'unscored', replayed: false },
  });
  assertEquals(rpcNames(h), ['set_trip_role_row', 'apply_recompute']);
  assertEquals(rpcArgs(h, 'set_trip_role_row'), { p_user: UID, p_trip_id: TRIP_ID, p_role: 'passenger' });
  const e = recompute(h);
  assertEquals(e.userId, UID);
  assertEquals(e.scored?.status, 'unscored');
  assertEquals(e.scored?.reason, 'passenger');
  assertEquals(e.scored?.score, null);
  assertEquals(e.events, [{ id: EVENT_ID, status: 'scored', deduction: null }]);
  // only the other trip counts for the day now
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].drivingS, 1500);
  assertEquals(e.baselines?.medians.score, 80);
});

Deno.test('set-role driver re-scores from the stored digest and events', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow({ role: 'passenger', status: 'unscored', score: null })],
      trip_events: [storedEventRow({ deduction: null })],
      event_disputes: [],
    },
  });
  const expected = scoreTrip(storedMetrics('driver'), [storedEvent('scored')]);
  assertEquals(await json(await handleTripAction(post(setRole('driver')), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, role: 'driver', score: expected.score, status: 'final', replayed: false },
  });
  assertEquals(rpcNames(h), ['set_trip_role_row', 'apply_recompute']);
  const e = recompute(h);
  assertEquals(e.scored, expected);
  assertEquals(e.events, [{ id: EVENT_ID, status: 'scored', deduction: expected.eventDeductions[CLIENT_EVENT_ID] }]);
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].phoneFreeDay, false);
});

Deno.test('set-role on a trip the user has since deleted is 200 replayed and writes nothing', async () => {
  const h = harness({
    tables: { trips: [storedTripRow({ deleted_at: new Date(T0 + DAY_MS).toISOString() })], trip_events: [], event_disputes: [] },
  });
  assertEquals(await json(await handleTripAction(post(setRole('passenger')), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, role: 'driver', score: 90, status: 'final', replayed: true },
  });
  assertEquals(h.fake.calls.length, 0);
});

// --- delete -------------------------------------------------------------------------------------

Deno.test('delete removes the trace object before the writer, then refreshes the day without the trip', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow(), tripRow({ id: 'same-day', score: 80, duration_s: 1500, exposure: 1.5 })],
      trip_events: [storedEventRow()],
      event_disputes: [],
    },
  });
  assertEquals(await json(await handleTripAction(post(del()), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, deleted: true, replayed: false },
  });
  const order = h.fake.calls.map((c: RecordedCall) => `${c.kind}:${c.name}`);
  assertEquals(order, ['storage:traces.remove', 'rpc:soft_delete_trip', 'rpc:apply_recompute']);
  assertEquals(h.fake.storageCalls, [{ bucket: 'traces', keys: [TRACE_KEY] }]);
  assertEquals(rpcArgs(h, 'soft_delete_trip'), { p_user: UID, p_trip_id: TRIP_ID });
  const e = recompute(h);
  assertEquals(e.userId, UID);
  assertEquals(e.tripId, TRIP_ID);
  assertEquals(e.scored, null);
  assertEquals(e.events, null);
  assertEquals(e.day[0].tripsScored, 1);
  assertEquals(e.day[0].drivingS, 1500);
  assertEquals(e.baselines?.medians.score, 80);
});

Deno.test('the object is removed even when the stored row no longer names it', async () => {
  const h = harness({ tables: { trips: [storedTripRow({ trace_path: null })], trip_events: [], event_disputes: [] } });
  assertEquals((await handleTripAction(post(del()), h.deps)).status, 200);
  assertEquals(h.fake.storageCalls, [{ bucket: 'traces', keys: [TRACE_KEY] }]);
});

Deno.test('a delete replay is 200 replayed and still refreshes the day', async () => {
  const h = harness({
    tables: {
      trips: [storedTripRow({ deleted_at: new Date(T0 + DAY_MS).toISOString(), trace_path: null })],
      trip_events: [],
      event_disputes: [],
    },
    rpc: { soft_delete_trip: (args) => ({ data: { trip_id: args.p_trip_id, trace_path: null, replayed: true } }) },
  });
  assertEquals(await json(await handleTripAction(post(del()), h.deps)), {
    status: 200,
    body: { tripId: TRIP_ID, deleted: true, replayed: true },
  });
  assertEquals(
    h.fake.calls.map((c) => `${c.kind}:${c.name}`),
    ['storage:traces.remove', 'rpc:soft_delete_trip', 'rpc:apply_recompute']
  );
});

Deno.test('a storage failure on delete is 503 retry and the writer is not called', async () => {
  const h = harness({ storageError: { message: 'storage is down' } });
  const res = await handleTripAction(post(del()), h.deps);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('retry-after'), '2');
  assertEquals((await res.json()).code, 'retry');
  assertEquals(rpcNames(h), []);
  assertEquals(h.errors.length, 1);
});

// --- writer errors ------------------------------------------------------------------------------

Deno.test('a writer lock or serialization failure is 503 with Retry-After', async () => {
  for (const code of ['55P03', '40P01', '40001']) {
    const h = harness({ rpc: { soft_delete_trip: () => ({ error: { code, message: 'busy' } }) } });
    const res = await handleTripAction(post(del()), h.deps);
    assertEquals(res.status, 503, code);
    assertEquals(res.headers.get('retry-after'), '2');
    assertEquals((await res.json()).code, 'retry');
  }
});

Deno.test("the writers' authorization refusals map to 403, 409 and 500", async () => {
  const notOwned = harness({
    rpc: { set_trip_role_row: () => ({ error: { code: '42501', message: 'trip not owned by user' } }) },
  });
  assertEquals(await json(await handleTripAction(post(setRole('driver')), notOwned.deps)), {
    status: 403,
    body: { code: 'forbidden' },
  });
  const gone = harness({ rpc: { apply_recompute: () => ({ error: { code: '42501', message: 'trip already deleted' } }) } });
  assertEquals(await json(await handleTripAction(post(setRole('driver')), gone.deps)), {
    status: 409,
    body: { code: 'trip_deleted' },
  });
  const role = harness({
    rpc: { soft_delete_trip: () => ({ error: { code: '42501', message: 'soft_delete_trip requires the service role' } }) },
  });
  assertEquals(await json(await handleTripAction(post(del()), role.deps)), {
    status: 500,
    body: { code: 'misconfigured' },
  });
  assertEquals(role.errors.length, 1);
});

Deno.test('an envelope the writer refuses is 400 with the message, and anything else is 500 without detail', async () => {
  const drift = harness({
    rpc: { apply_recompute: () => ({ error: { code: '22023', message: 'apply_recompute payload is missing day[0].band' } }) },
  });
  assertEquals(await json(await handleTripAction(post(del()), drift.deps)), {
    status: 400,
    body: { code: 'invalid_envelope', message: 'apply_recompute payload is missing day[0].band' },
  });
  assertEquals(drift.errors.length, 1);
  const boom = harness({ rpc: { record_dispute: () => ({ error: { code: 'XX000', message: 'kaboom' } }) } });
  assertEquals(await json(await handleTripAction(post(dispute()), boom.deps)), {
    status: 500,
    body: { code: 'internal' },
  });
  assertEquals(boom.errors.length, 1);
});
