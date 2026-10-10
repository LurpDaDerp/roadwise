import { assert, assertEquals } from '@std/assert';
import type { ApplyDriveEnvelope } from '../_shared/engine.ts';
import { PgError } from '../_shared/pg.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import { EVENT, EVENT_2, mergeTarget, payload, response, STARTED_AT, TRIP, TRIP_2, USER } from '../_shared/testing/v3_fixtures.ts';
import { handleFinalizeTrip, MAX_UPLOADS_PER_DAY, TZ_REFUSAL, UPLOAD_LIMIT_KEY } from './handler.ts';

const quiet = { warn: () => {}, error: () => {} };
const freshContext = {
  existing: null,
  week: '2026-W41',
  leagueEligible: true,
  streak: { streak: 10, atRisk: false, freezes: 2, cleanRun: 0 },
  safeMilesEarlierToday: 0,
  loopDrivesToday: 0,
  merge: null,
};

function harness(script: FakeEngineScript = {}, auth: 'good' | 'bad' | 'down' = 'good') {
  const fake = fakeEngine({ context: freshContext, apply: (e: ApplyDriveEnvelope) => response({ net: e.net, scored: e.scored, reason: e.reason, breakdown: e.breakdown }), ...script });
  const verifyJwt = (token: string) => {
    if (auth === 'down') return Promise.reject(new Error('auth down'));
    return Promise.resolve(auth === 'good' && token === 'good' ? USER : null);
  };
  return { fake, deps: { verifyJwt, engine: fake.engine, log: quiet } };
}

const post = (body: unknown, token = 'good', init: RequestInit = {}) =>
  new Request('http://local/functions/v1/finalize-trip', {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    body: init.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const envelopeOf = (h: ReturnType<typeof harness>): ApplyDriveEnvelope => h.fake.calls.find((c) => c.fn === 'applyDrive')!.args as ApplyDriveEnvelope;

Deno.test('happy path: the spec example scores 142 − 10 = 132 inside one transaction and the stored response is returned', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.net, body.scored, body.clientTripId], [132, true, TRIP]);
  assertEquals(h.fake.transactions, { opened: 1, failed: 0 });
  assertEquals(h.fake.calls.map((c) => c.fn), ['driveContext', 'takeRateLimit', 'applyDrive']);
  assertEquals(h.fake.calls[0].args, { userId: USER, clientTripId: TRIP, startedAt: STARTED_AT, endedAt: STARTED_AT + 30 * 60_000, localDay: '2026-10-05', start: { lat: 40.7128, lng: -74.006 } });
  assertEquals(h.fake.calls[1].args, { userId: USER, key: UPLOAD_LIMIT_KEY, window: '1 day', max: MAX_UPLOADS_PER_DAY });
  const e = envelopeOf(h);
  assertEquals([e.user, e.mergeInto, e.scored, e.reason, e.net], [USER, null, true, null, 132]);
  assertEquals(e.breakdown.gains, 142);
  assertEquals(e.breakdown.events, [{ id: EVENT, penalty: 10 }]);
  assertEquals(e.streak, { before: { streak: 10 }, after: { streak: 11, atRisk: false, freezes: 2, cleanRun: 0 }, outcome: 'grew', freezeEarned: false });
  // the uploaded event goes in active whatever the device said, with its position and measurements
  assertEquals(e.events.map((x) => [x.id, x.status, x.lat, x.measured]), [[EVENT, 'active', 40.72, { peakG: 0.42 }]]);
  assertEquals([e.isLoop, e.loopRepeat, e.safeMilesEarlierToday, e.payload.localDay, e.payload.end], [false, false, 0, '2026-10-05', { lat: 40.7306, lng: -73.9352 }]);
  assertEquals(res.headers.get('x-replayed'), null);
});

Deno.test('a replay returns the stored response from the context and applies nothing', async () => {
  const stored = response({ net: 999 });
  const h = harness({ context: { existing: stored } });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), stored);
  assertEquals(res.headers.get('x-replayed'), 'true');
  assertEquals(h.fake.calls.map((c) => c.fn), ['driveContext']);
});

Deno.test('merge: the union is scored with the target context and streak; the removed event stays removed', async () => {
  const h = harness({ context: { ...freshContext, merge: mergeTarget() } });
  const res = await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2 })), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals(e.mergeInto, '99999999-9999-4999-8999-999999999999');
  assertEquals(e.events.map((x) => [x.id, x.status]), [[EVENT_2, 'removed'], [EVENT, 'active']]);
  // 15 miles, 14.8 safe, streak 4 (the target's snapshot): 148 × 1.08 → 159.84 → 160, minus 10
  assertEquals([e.breakdown.safeMiles, e.breakdown.streakMult, e.breakdown.gains, e.net], [14.8, 1.08, 160, 150]);
  assertEquals(e.breakdown.events, [{ id: EVENT, penalty: 10 }]);
  assertEquals(e.streak.before, { streak: 4 });
  assertEquals(e.streak.after, { streak: 5, atRisk: false, freezes: 1, cleanRun: 0 });
  // the payload's own metrics travel; SQL sums the union
  assertEquals([e.payload.miles, e.payload.clientTripId, e.safeMilesEarlierToday], [12, TRIP_2, 0]);
});

Deno.test('integrity: a mock location is stored unscored as spoofed, never merged, with a zeroed breakdown and no streak change', async () => {
  const h = harness({ context: { ...freshContext, merge: mergeTarget() } });
  const p = payload({ integrity: { mockLocation: true, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 50 } });
  const res = await handleFinalizeTrip(post(p), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals([e.scored, e.reason, e.net, e.mergeInto, e.breakdown.gains, e.breakdown.penalties, e.breakdown.events], [false, 'spoofed', 0, null, 0, 0, []]);
  assertEquals(e.streak.outcome, 'none');
  assertEquals(e.streak.after.streak, 10);
  const h2 = harness();
  await handleFinalizeTrip(post(payload({ miles: 300, safeMiles: 300, integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 70 } })), h2.deps);
  assertEquals(envelopeOf(h2).reason, 'implausible');
});

Deno.test('a refused merge target (spoofed / implausible) is never merged into: the drive is scored on its own', async () => {
  for (const reason of ['spoofed', 'implausible'] as const) {
    const h = harness({ context: { ...freshContext, merge: mergeTarget({ reason }) } });
    const res = await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2 })), h.deps);
    assertEquals(res.status, 200);
    const e = envelopeOf(h);
    assertEquals([e.mergeInto, e.events.length, e.streak.before, e.breakdown.safeMiles], [null, 1, { streak: 10 }, 11.8], reason);
  }
  // a too_short target still merges
  const h = harness({ context: { ...freshContext, merge: mergeTarget({ reason: 'too_short' }) } });
  await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2 })), h.deps);
  assertEquals(envelopeOf(h).mergeInto, '99999999-9999-4999-8999-999999999999');
});

Deno.test('miles far beyond the drawn route are stored implausible', async () => {
  const h = harness();
  await handleFinalizeTrip(post(payload({ miles: 40, safeMiles: 40, durationS: 1800, integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 90 } })), h.deps);
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [false, 'implausible']);
});

Deno.test('loop: start and end within 402 m under 5 miles is a loop; the third of the day scores at half and has no clean bonus', async () => {
  const loop = payload({ miles: 2.5, safeMiles: 2.5, end: { lat: 40.7135, lng: -74.0055 }, events: [] });
  const h1 = harness({ context: { ...freshContext, loopDrivesToday: 1 } });
  await handleFinalizeTrip(post(loop), h1.deps);
  assertEquals([envelopeOf(h1).isLoop, envelopeOf(h1).loopRepeat, envelopeOf(h1).breakdown.cleanBonus], [true, false, 25]);
  const h2 = harness({ context: { ...freshContext, loopDrivesToday: 2 } });
  await handleFinalizeTrip(post(loop), h2.deps);
  const e = envelopeOf(h2);
  assertEquals([e.isLoop, e.loopRepeat, e.breakdown.creditedMiles, e.breakdown.cleanBonus], [true, true, 1.25, 0]);
});

Deno.test('too short: under 0.5 mi is stored unscored with reason too_short', async () => {
  const h = harness();
  await handleFinalizeTrip(post(payload({ miles: 0.3, safeMiles: 0.3, events: [] })), h.deps);
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason, envelopeOf(h).net], [false, 'too_short', 0]);
});

Deno.test('refusals before any database work: method, token, size, JSON, contract, zone, local day', async () => {
  const h = harness();
  assertEquals((await handleFinalizeTrip(post(payload(), 'good', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleFinalizeTrip(post(payload(), ''), h.deps)).status, 401);
  assertEquals((await handleFinalizeTrip(post(payload(), 'bad'), h.deps)).status, 401);
  assertEquals((await handleFinalizeTrip(post(payload()), harness({}, 'down').deps)).status, 503);
  assertEquals((await handleFinalizeTrip(post(payload(), 'good', { headers: { 'content-length': String(600_000) } }), h.deps)).status, 413);
  assertEquals((await handleFinalizeTrip(post(JSON.stringify(payload()) + 'x'.repeat(530_000)), h.deps)).status, 413);
  assertEquals((await handleFinalizeTrip(post('{not json'), h.deps)).status, 400);
  const contract = await handleFinalizeTrip(post({ ...payload(), v: 2 }), h.deps);
  assertEquals(contract.status, 400);
  assertEquals((await contract.json()).code, 'invalid_payload');
  const status = await handleFinalizeTrip(post(payload({ events: [{ ...payload().events[0], status: 'removed' as never }] })), h.deps);
  assertEquals(status.status, 400);
  const tz = await handleFinalizeTrip(post(payload({ tz: 'Mars/Olympus' })), h.deps);
  assertEquals(tz.status, 400);
  assertEquals((await tz.json()).issues, [{ path: 'tz', message: 'unknown time zone' }]);
  const day = await handleFinalizeTrip(post(payload({ localDay: '2026-10-06' })), h.deps);
  assertEquals(day.status, 400);
  assertEquals((await day.json()).issues[0].path, 'localDay');
  // Tokyo at the same instant is already the 6th
  const tokyo = harness();
  assertEquals((await handleFinalizeTrip(post(payload({ tz: 'Asia/Tokyo', localDay: '2026-10-06' })), tokyo.deps)).status, 200);
  assertEquals(h.fake.calls, []);
});

Deno.test('the user is the JWT and nothing in the body; the upload budget answers 429', async () => {
  const h = harness();
  await handleFinalizeTrip(post({ ...payload(), userId: '22222222-2222-4222-8222-222222222222' }), h.deps);
  assertEquals(h.fake.calls, []); // strict contract: an unknown key is refused
  const limited = harness({ rateLimit: false });
  const res = await handleFinalizeTrip(post(payload()), limited.deps);
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { code: 'too_many_trips' });
  assertEquals(limited.fake.calls.map((c) => c.fn), ['driveContext', 'takeRateLimit']);
});

Deno.test('engine failures map to codes only: retryable 503, 22023 400, P0002 500, a response outside the contract 500', async () => {
  const retry = await handleFinalizeTrip(post(payload()), harness({ context: new PgError('55P03', 'lock timeout') }).deps);
  assertEquals([retry.status, retry.headers.get('retry-after')], [503, '2']);
  const envelope = await handleFinalizeTrip(post(payload()), harness({ apply: new PgError('22023', 'payload metrics are out of range') }).deps);
  assertEquals([envelope.status, (await envelope.json()).code], [400, 'invalid_envelope']);
  const skew = await handleFinalizeTrip(post(payload()), harness({ apply: new PgError('22023', TZ_REFUSAL) }).deps);
  assertEquals([skew.status, (await skew.json()).issues], [400, [{ path: 'tz', message: 'unknown time zone' }]]);
  const missing = await handleFinalizeTrip(post(payload()), harness({ context: new PgError('P0002', 'no progress for user') }).deps);
  assertEquals([missing.status, (await missing.json()).code], [500, 'internal']);
  const drift = await handleFinalizeTrip(post(payload()), harness({ apply: { tripId: 'nope' } }).deps);
  assertEquals([drift.status, (await drift.json()).code], [500, 'internal']);
  for (const r of [retry, envelope, missing, drift]) assert(r.headers.get('x-request-id'));
});
