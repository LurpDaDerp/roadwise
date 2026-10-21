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
  // 283 − 8 − 10 (the second brake at ×1.25)
  oldNet: 265,
  quotaLeft: 3,
  rescore: {
    input: {
      miles: 12,
      safeMiles: 11.8,
      loopRepeat: false,
      dashcam: false,
      durationS: 1800,
      scoringVersion: 6,
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
  net: e.net ?? 265,
  delta: (e.net ?? 265) - 265,
  progress: { points: 132, lifetime: 142, level: 1, levelUp: false, safetyRating: 92, ranked: false },
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
  // one minor hard brake left of two: 283 − 8
  assertEquals(e.net, 275);
  assertEquals(e.breakdown?.events, [{ id: EVENT_2, penalty: 8 }]);
  assertEquals([e.breakdown?.streakMult, e.breakdown?.pointsPerMile], [1.2, 20]);
  assertEquals(body.breakdown.events, [{ id: EVENT_2, penalty: 8 }]);
  assertEquals([body.breakdown.net, body.delta], [275, 10]);
});

Deno.test('a drive first scored before the earn rate doubled keeps its rules: the re-score moves the net by the shed penalty, never by the new rate', async () => {
  // stored under version 5: 11.8 × 10 × 1.2 = 141.6 → 142, minus 8 and 10 = 124; the first brake goes, the other becomes first-of-type (8)
  const h = harness({ disputeContext: { ...disputeAccepted, oldNet: 124, rescore: { ...disputeAccepted.rescore!, input: { ...disputeAccepted.rescore!.input, scoringVersion: 5 } } } });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  assertEquals(res.status, 200);
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.breakdown?.gains, e.breakdown?.pointsPerMile, e.breakdown?.penalties, e.net], [142, 10, 8, 134]);
  assertEquals(e.net! - 124, 10);
  // a version 5 drive with a phone pickup at 50 mph: the pickup stays 32 (no speed multiplier) once the brake is gone
  const PICKUP = 'abababab-abab-4bab-8bab-abababababab';
  const h2 = harness({
    disputeContext: {
      ...disputeAccepted,
      oldNet: 124,
      rescore: {
        ...disputeAccepted.rescore!,
        input: {
          ...disputeAccepted.rescore!.input,
          scoringVersion: 5,
          events: [
            disputeAccepted.rescore!.input.events[0],
            { ...disputeAccepted.rescore!.input.events[1], id: PICKUP, type: 'phone_pickup', tier: 'severe', measured: { speedMph: 50, maxSpeedMph: 50 } },
          ],
        },
      },
    },
  });
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h2.deps);
  const e2 = h2.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e2.breakdown?.events, e2.net], [[{ id: PICKUP, penalty: 32 }], 110]);
  // the same drive stored under version 6 pays 283 and charges the pickup ×2 at 50 mph
  const v6 = harness({
    disputeContext: {
      ...disputeAccepted,
      rescore: {
        ...disputeAccepted.rescore!,
        input: {
          ...disputeAccepted.rescore!.input,
          events: [
            disputeAccepted.rescore!.input.events[0],
            { ...disputeAccepted.rescore!.input.events[1], id: PICKUP, type: 'phone_pickup', tier: 'severe', measured: { speedMph: 50, maxSpeedMph: 50 } },
          ],
        },
      },
    },
  });
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), v6.deps);
  const e3 = v6.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e3.breakdown?.gains, e3.breakdown?.events, e3.net], [283, [{ id: PICKUP, penalty: 64 }], 219]);
});

Deno.test('the stored length reaches the re-score: a short drive that was scored for its minutes stays scored', async () => {
  // 0.3 mi in 6 min, one brake (the only event) removed: scored, 0.3 × 20 × 1.2 = 7.2 → 7, no bonus under 2 mi
  const ctx: DisputeContext = {
    ...disputeAccepted,
    oldNet: 3,
    rescore: { ...disputeAccepted.rescore!, input: { ...disputeAccepted.rescore!.input, miles: 0.3, safeMiles: 0.3, durationS: 360, events: [disputeAccepted.rescore!.input.events[0]] } },
  };
  const h = harness({ disputeContext: ctx });
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.breakdown?.scored, e.breakdown?.reason, e.breakdown?.cleanBonus, e.net], [true, undefined, 0, 7]);
});

type Stored = DisputeContext['rescore'] extends infer R ? (R extends { input: { events: (infer E)[] } } ? E : never) : never;
const stored = (id: string, type: 'drowsy' | 'hard_brake', status: 'active' | 'removed', at: number): Stored => ({
  id,
  type,
  tier: type === 'hard_brake' ? 'minor' : 'severe',
  startedAt: STARTED_AT + at,
  durationS: 2,
  units: null,
  stoppedInTraffic: null,
  zone: null,
  status,
  lat: null,
  lng: null,
  measured: type === 'drowsy' ? { source: 'dashcam' } : {},
  penalty: 0,
});

Deno.test('camera_wrong on a DashPal drive: re-scored with the ×1.25 kept, so the dispute never lowers the net', async () => {
  const DROWSY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  // 40 mi, streak 10: gains 600 at ×1.50 (DashPal); 480 at ×1.20 would be a −70 "refund"
  const ctx = (events: Stored[], oldNet: number, reason: 'camera_wrong' | 'hazard'): DisputeContext => ({
    ...disputeAccepted,
    reason,
    eventId: events[0].id,
    oldNet,
    rescore: { input: { miles: 40, safeMiles: 40, loopRepeat: false, dashcam: true, durationS: 3600, scoringVersion: 6, events }, ctx: { streak: 10, safeMilesEarlierToday: 0 } },
  });
  // before: 1200 − 40 (drowsy) − 8 (brake) = 1152; the drowsy was wrong → 1200 − 8 = 1192
  const h = harness({ disputeContext: ctx([stored(DROWSY, 'drowsy', 'removed', 1000), stored(EVENT_2, 'hard_brake', 'active', 2000)], 1152, 'camera_wrong') });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: DROWSY, reason: 'camera_wrong' }), h.deps);
  assertEquals(res.status, 200);
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.reason, e.breakdown?.dashcamMult, e.breakdown?.mult, e.breakdown?.gains, e.net], ['camera_wrong', 1.25, 1.5, 1200, 1192]);
  assertEquals(e.net! - 1152 >= 0, true);
  // a hazard on a DashPal drive that also has a drowsy: the brake goes, the drowsy stays charged and does not
  // break the now-clean drive: (800 + 50) × 1.5 = 1275, − 40
  const h2 = harness({ disputeContext: ctx([stored(EVENT, 'hard_brake', 'removed', 1000), stored(DROWSY, 'drowsy', 'active', 2000)], 1152, 'hazard') });
  await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h2.deps);
  const e2 = h2.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e2.breakdown?.activeEventCount, e2.breakdown?.cleanBonus, e2.breakdown?.penalties, e2.net], [0, 50, 40, 1235]);
  assertEquals(e2.net! - 1152 >= 0, true);
});

Deno.test('every reason the sheet offers passes the contract; anything else is a 400 before the engine', async () => {
  for (const reason of ['hazard', 'wrong_limit', 'mounted', 'camera_wrong']) {
    const h = harness();
    const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason }), h.deps);
    assertEquals(res.status, 200, reason);
    assertEquals((h.fake.calls.find((c) => c.fn === 'disputeContext')!.args as { reason: string }).reason, reason);
  }
  const h = harness();
  assertEquals((await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'camera' }), h.deps)).status, 400);
  assertEquals(h.fake.calls, []);
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

Deno.test('a repeated accepted dispute (0016: the context comes back with nothing to re-score) is not re-scored; the stored outcome passes through', async () => {
  const stored = { tripId: TRIP_ID, eventId: EVENT, status: 'accepted', rejectReason: null, quotaLeft: 2, net: 132, delta: 13, breakdown: null,
    progress: { points: 132, lifetime: 142, level: 1, levelUp: false, safetyRating: 92, ranked: false } };
  const h = harness({ disputeContext: { ...disputeAccepted, quotaLeft: 2, rescore: null }, applyDispute: () => stored });
  const res = await handleTripAction(post({ action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { action: 'dispute', clientTripId: TRIP, ...stored });
  const e = h.fake.calls.find((c) => c.fn === 'applyDispute')!.args as ApplyDisputeEnvelope;
  assertEquals([e.status, e.breakdown, e.net], ['accepted', undefined, undefined]);
});

Deno.test("the writers' fixed refusals become codes; everything else maps as usual", async () => {
  const cases: [PgError, number, string][] = [
    [new PgError('P0002', 'trip not found'), 404, 'not_found'],
    [new PgError('42501', 'already marked as not driving'), 409, 'already_marked'],
    [new PgError('42501', 'only your latest drive can be marked'), 403, 'not_latest'],
    [new PgError('42501', 'the drive is older than 24 hours'), 403, 'too_old'],
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
