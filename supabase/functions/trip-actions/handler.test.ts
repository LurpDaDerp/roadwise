import { assertEquals } from '@std/assert';
import { PgError } from '../_shared/pg.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import { EVENT, TRIP, USER } from '../_shared/testing/v4_fixtures.ts';
import { ACTION_LIMIT_KEY, handleTripAction, MAX_ACTIONS_PER_HOUR, REFUSALS } from './handler.ts';

const quiet = { warn: () => {}, error: () => {} };
const TRIP_ID = '99999999-9999-4999-8999-999999999999';

const notDriving = {
  tripId: TRIP_ID,
  clientTripId: TRIP,
  notDrivingLeft: 1,
  rating: { safetyRating: null, ranked: false },
};

const disputeAnswer = (args: { reason: string }) => ({
  tripId: TRIP_ID,
  eventId: EVENT,
  status: 'accepted',
  rejectReason: null,
  quotaLeft: args.reason === 'camera_wrong' ? 2 : 1,
  clean: true,
  rating: { safetyRating: 91.4, ranked: true },
});

function harness(script: FakeEngineScript = {}, auth: 'good' | 'bad' = 'good') {
  const fake = fakeEngine({ notDriving, dispute: disputeAnswer, ...script });
  const verifyJwt = (token: string) => Promise.resolve(auth === 'good' && token === 'good' ? USER : null);
  return { fake, deps: { verifyJwt, engine: fake.engine, log: quiet } };
}

const post = (body: unknown, token = 'good') =>
  new Request('http://local/functions/v1/trip-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

Deno.test('not_driving: one transaction, the budget, one call to mark_not_driving; the answer is passed through', async () => {
  const h = harness();
  const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { action: 'not_driving', ...notDriving });
  assertEquals(h.fake.calls.map((c) => c.fn), ['takeRateLimit', 'markNotDriving']);
  assertEquals(h.fake.calls[0].args, { userId: USER, key: ACTION_LIMIT_KEY, window: '1 hour', max: MAX_ACTIONS_PER_HOUR });
  assertEquals(h.fake.calls[1].args, { userId: USER, clientTripId: TRIP });
  // a report with reason not_driving is the same action
  const h2 = harness();
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'not_driving' }), h2.deps);
  assertEquals(h2.fake.calls.map((c) => c.fn), ['takeRateLimit', 'markNotDriving']);
});

Deno.test('dispute: one call to dispute_event with the reason; the stored answer comes back with the trip id', async () => {
  for (const reason of ['hazard', 'wrong_limit', 'camera_wrong']) {
    const h = harness();
    const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason }), h.deps);
    assertEquals(res.status, 200, reason);
    const body = await res.json();
    assertEquals(body, { action: 'dispute', clientTripId: TRIP, ...disputeAnswer({ reason }) });
    assertEquals(h.fake.calls.map((c) => c.fn), ['takeRateLimit', 'disputeEvent']);
    assertEquals(h.fake.calls[1].args, { userId: USER, clientTripId: TRIP, eventId: EVENT, reason });
  }
});

Deno.test('a rejected report (the week\'s quota) passes through with its reason', async () => {
  const rejected = { ...disputeAnswer({ reason: 'hazard' }), status: 'rejected', rejectReason: 'quota', quotaLeft: 0, clean: false };
  const h = harness({ dispute: rejected });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { action: 'dispute', clientTripId: TRIP, ...rejected });
});

Deno.test('"My phone was mounted" is no longer a reason: refused by the contract before the engine', async () => {
  for (const reason of ['mounted', 'camera']) {
    const h = harness();
    assertEquals((await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason }), h.deps)).status, 400, reason);
    assertEquals(h.fake.calls, []);
  }
});

Deno.test('an answer outside the contract (an older database\'s points document) is a 500, never passed on', async () => {
  const old = { tripId: TRIP_ID, clientTripId: TRIP, notDrivingLeft: 1, progress: { points: 0, level: 1 } };
  const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), harness({ notDriving: old }).deps);
  assertEquals([res.status, (await res.json()).code], [500, 'internal']);
  const res2 = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), harness({ dispute: { net: 4 } }).deps);
  assertEquals(res2.status, 500);
});

Deno.test("the writers' fixed refusals become codes; everything else maps as usual", async () => {
  const cases: [PgError, number, string][] = [
    [new PgError('P0002', 'trip not found'), 404, 'not_found'],
    [new PgError('P0002', 'event not found'), 404, 'not_found'],
    [new PgError('42501', 'the not driving option expired'), 403, 'not_driving_expired'],
    [new PgError('42501', 'the drive is older than 24 hours'), 403, 'too_old'],
    [new PgError('42501', 'the drive is older than 7 days'), 403, 'too_old'],
    [new PgError('42501', 'no uses left this month'), 403, 'no_uses_left'],
    [new PgError('42501', 'already disputed'), 409, 'already_disputed'],
    [new PgError('22023', 'that reason does not apply to this event'), 400, 'reason_mismatch'],
    [new PgError('40001', 'could not serialize'), 503, 'retry'],
    [new PgError('42501', 'too many requests'), 403, 'forbidden'],
    [new PgError('42501', 'something new'), 403, 'forbidden'],
  ];
  for (const [err, status, code] of cases) {
    const res = await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }), harness({ notDriving: err }).deps);
    assertEquals(res.status, status, err.message);
    assertEquals((await res.json()).code, code, err.message);
  }
  // the old latest-only and already-marked refusals are gone: a repeat answers the stored document
  assertEquals(['only your latest drive can be marked', 'already marked as not driving'].some((m) => m in REFUSALS), false);
});

Deno.test('a 40001 (two actions on one drive raced) is retried once, then surfaces as 503', async () => {
  let calls = 0;
  const flaky = harness({
    dispute: (args: { reason: string }) => {
      calls++;
      if (calls === 1) throw new PgError('40001', 'could not serialize');
      return disputeAnswer(args);
    },
  });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), flaky.deps);
  assertEquals(res.status, 200);
  assertEquals(flaky.fake.transactions, { opened: 2, failed: 1 });
  assertEquals(flaky.fake.calls.map((c) => c.fn), ['takeRateLimit', 'disputeEvent', 'takeRateLimit', 'disputeEvent']);
  const always = harness({ dispute: new PgError('40001', 'could not serialize') });
  const res2 = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), always.deps);
  assertEquals([res2.status, (await res2.json()).code, always.fake.transactions.opened], [503, 'retry', 2]);
});

Deno.test('refusals before the engine: method, token, contract, size; the budget answers 429', async () => {
  const h = harness();
  assertEquals((await handleTripAction(new Request('http://local/x', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }, ''), h.deps)).status, 401);
  assertEquals((await handleTripAction(post({ action: 'not_driving', clientTripId: TRIP }, 'bad'), harness({}, 'bad').deps)).status, 401);
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
