import { assertEquals } from '@std/assert';
import type { ApplyDisputeEnvelope, DisputeContext } from '../_shared/engine.ts';
import { PgError } from '../_shared/pg.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import { EVENT, EVENT_2, STARTED_AT, TRIP, USER } from '../_shared/testing/v3_fixtures.ts';
import { ACTION_LIMIT_KEY, handleTripAction, MAX_ACTIONS_PER_HOUR } from './handler.ts';

const quiet = { warn: () => {}, error: () => {} };
const TRIP_ID = '99999999-9999-4999-8999-999999999999';

const notDriving = {
  tripId: TRIP_ID,
  clientTripId: TRIP,
  notDrivingLeft: 1,
  progress: { points: 0, lifetime: 0, level: 1, streak: 0, atRisk: false, freezes: 2, safetyRating: null, ranked: false },
};

const disputeAccepted: DisputeContext = {
  tripId: TRIP_ID,
  clientTripId: TRIP,
  eventId: EVENT,
  reason: 'hazard',
  status: 'accepted',
  rejectReason: null,
  scored: true,
  oldNet: 167,
  quotaLeft: 3,
  rescore: {
    input: {
      miles: 12,
      safeMiles: 11.8,
      dmsOn: true,
      loopRepeat: false,
      events: [
        { id: EVENT, type: 'hard_brake', tier: 'minor', startedAt: STARTED_AT, durationS: 2, units: null, stoppedInTraffic: null, zone: null, status: 'removed', lat: null, lng: null, measured: {}, penalty: 10 },
        { id: EVENT_2, type: 'hard_brake', tier: 'minor', startedAt: STARTED_AT + 1000, durationS: 2, units: null, stoppedInTraffic: null, zone: null, status: 'active', lat: null, lng: null, measured: {}, penalty: 10 },
      ],
    },
    ctx: { streak: 10, safeMilesEarlierToday: 0 },
  },
};

const disputeResult = (e: ApplyDisputeEnvelope) => ({
  tripId: e.tripId,
  eventId: e.eventId,
  status: e.status,
  rejectReason: e.rejectReason ?? null,
  quotaLeft: e.status === 'accepted' ? 2 : 0,
  breakdown: e.breakdown ?? null,
  net: e.net ?? 167,
  delta: (e.net ?? 167) - 167,
  progress: { points: 177, lifetime: 177, level: 1, levelUp: false, safetyRating: 92, ranked: false },
});

function harness(script: FakeEngineScript = {}, auth: 'good' | 'bad' = 'good') {
  const fake = fakeEngine({ revert: notDriving, disputeContext: disputeAccepted, applyDispute: disputeResult, ...script });
  const verifyJwt = (token: string) => Promise.resolve(auth === 'good' && token === 'good' ? USER : null);
  return { fake, deps: { verifyJwt, engine: fake.engine, log: quiet } };
}

const post = (body: unknown, token = 'good') =>
  new Request('http://local/functions/v1/trip-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

Deno.test('not_driving: one transaction, the budget, the revert; the result is passed through', async () => {
  const h = harness();
  const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { action: 'not_driving', ...notDriving });
  assertEquals(h.fake.calls.map((c) => c.fn), ['takeRateLimit', 'revertNotDriving']);
  assertEquals(h.fake.calls[0].args, { userId: USER, key: ACTION_LIMIT_KEY, window: '1 hour', max: MAX_ACTIONS_PER_HOUR });
  assertEquals(h.fake.calls[1].args, { userId: USER, clientTripId: TRIP });
  // a dispute with reason not_driving is the same action
  const h2 = harness();
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'not_driving' }), h2.deps);
  assertEquals(h2.fake.calls.map((c) => c.fn), ['takeRateLimit', 'revertNotDriving']);
});

Deno.test('dispute accepted: the stored input is re-scored with the event removed and the delta applied', async () => {
  const h = harness();
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.action, body.status, body.quotaLeft, body.clientTripId], ['dispute', 'accepted', 2, TRIP]);
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.user, e.tripId, e.eventId, e.reason, e.status], [USER, TRIP_ID, EVENT, 'hazard', 'accepted']);
  // one minor hard brake left of two: 177 − 10
  assertEquals(e.net, 167);
  assertEquals(e.breakdown?.events, [{ id: EVENT_2, penalty: 10 }]);
  assertEquals(e.breakdown?.streakMult, 1.2);
  assertEquals(body.breakdown.events, [{ id: EVENT_2, penalty: 10 }]);
  assertEquals(body.breakdown.net, 167);
});

Deno.test('dispute rejected: recorded without a re-score; the reason comes back', async () => {
  const h = harness({ disputeContext: { ...disputeAccepted, status: 'rejected', rejectReason: 'quota', quotaLeft: 0, rescore: null } });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.status, body.rejectReason, body.quotaLeft, body.delta], ['rejected', 'quota', 0, 0]);
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.status, e.rejectReason, e.breakdown, e.net], ['rejected', 'quota', undefined, undefined]);
});

Deno.test("the writers' fixed refusals become codes; everything else maps as usual", async () => {
  const cases: [PgError, number, string][] = [
    [new PgError('P0002', 'trip not found'), 404, 'not_found'],
    [new PgError('42501', 'already marked as not driving'), 409, 'already_marked'],
    [new PgError('42501', 'only your latest drive can be marked'), 403, 'not_latest'],
    [new PgError('42501', 'the drive is older than 24 hours'), 403, 'too_old'],
    [new PgError('42501', 'the camera saw a driver on this drive'), 403, 'face_seen'],
    [new PgError('42501', 'no uses left this month'), 403, 'no_uses_left'],
    [new PgError('42501', 'already disputed'), 409, 'already_disputed'],
    [new PgError('22023', 'that reason does not apply to this event'), 400, 'reason_mismatch'],
    [new PgError('40001', 'could not serialize'), 503, 'retry'],
    [new PgError('42501', 'something new'), 403, 'forbidden'],
  ];
  for (const [err, status, code] of cases) {
    const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), harness({ revert: err }).deps);
    assertEquals(res.status, status, err.message);
    assertEquals((await res.json()).code, code, err.message);
  }
});

Deno.test('a 40001 from apply_dispute (a stale breakdown) is retried once from the context, then surfaces as 503', async () => {
  let calls = 0;
  const flaky = harness({
    applyDispute: (e: ApplyDisputeEnvelope) => {
      calls++;
      if (calls === 1) throw new PgError('40001', 'stale breakdown');
      return disputeResult(e);
    },
  });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), flaky.deps);
  assertEquals(res.status, 200);
  assertEquals(flaky.fake.transactions, { opened: 2, failed: 1 });
  assertEquals(flaky.fake.calls.map((c) => c.fn), ['takeRateLimit', 'disputeContext', 'applyDispute', 'takeRateLimit', 'disputeContext', 'applyDispute']);
  const always = harness({ applyDispute: new PgError('40001', 'stale breakdown') });
  const res2 = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), always.deps);
  assertEquals([res2.status, (await res2.json()).code, always.fake.transactions.opened], [503, 'retry', 2]);
});

Deno.test('refusals before the engine: method, token, contract, size; the budget answers 429', async () => {
  const h = harness();
  assertEquals((await handleTripAction(new Request('http://local/x', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }, ''), h.deps)).status, 401);
  assertEquals((await handleTripAction(post({ action: 'delete', clientTripId: TRIP }), h.deps)).status, 400);
  assertEquals((await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: 'e1', reason: 'hazard' }), h.deps)).status, 400);
  assertEquals((await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP, userId: USER }), h.deps)).status, 400);
  assertEquals((await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP, pad: 'x'.repeat(5000) }), h.deps)).status, 413);
  assertEquals(h.fake.calls, []);
  const limited = harness({ rateLimit: false });
  const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), limited.deps);
  assertEquals([res.status, (await res.json()).code], [429, 'too_many_requests']);
  assertEquals(limited.fake.calls.map((c) => c.fn), ['takeRateLimit']);
});
