import { assert, assertEquals } from '@std/assert';
import type { ApplyDriveEnvelope } from '../_shared/engine.ts';
import { PgError } from '../_shared/pg.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import { DASHCAM, EVENT, EVENT_2, mergeTarget, payload, response, STARTED_AT, TRIP, TRIP_2, USER } from '../_shared/testing/v3_fixtures.ts';
import { dashcamOf, handleFinalizeTrip, MAX_UPLOADS_PER_DAY, TZ_REFUSAL, UPLOAD_LIMIT_KEY } from './handler.ts';

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

// ---------------------------------------------------------------------------------------------
// DashPal
// ---------------------------------------------------------------------------------------------
const DROWSY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
type Dashcam = NonNullable<ReturnType<typeof payload>['dashcam']>;
const covered = (over: Partial<Dashcam> = {}): Dashcam => ({ deviceId: DASHCAM, movingS: 1500, coveredS: 1350, synced: true, ...over });
const drowsyEvent = {
  id: DROWSY,
  type: 'drowsy' as const,
  tier: 'severe' as const,
  startedAt: STARTED_AT + 20 * 60_000,
  durationS: 4,
  lat: 40.725,
  lng: -73.96,
  measured: { source: 'dashcam' as const, speedMph: 48 },
};

Deno.test('a DashPal drive: 118 × 1.50 = 177 − 10 = 167; the seconds and the derived flag go to apply_drive', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payload({ dashcam: covered() })), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals([e.breakdown.streakMult, e.breakdown.dashcamMult, e.breakdown.mult, e.breakdown.gains, e.net], [1.2, 1.25, 1.5, 177, 167]);
  assertEquals(e.dashcam, { deviceId: DASHCAM, movingS: 1500, coveredS: 1350, synced: true, on: true });
  assertEquals(e.payload.dashcam, covered());
  const body = await res.json();
  assertEquals([body.breakdown.dashcamMult, body.breakdown.mult, body.net], [1.25, 1.5, 167]);
});

Deno.test('no bonus under 80 % coverage, under 60 s moving, or not synced at the end; the payload stays valid', async () => {
  const cases: [Dashcam, string][] = [
    [covered({ coveredS: 1199 }), 'coverage 79.9 %'],
    [covered({ movingS: 59, coveredS: 59 }), 'moving 59 s'],
    [covered({ synced: false }), 'not synced'],
  ];
  for (const [dc, why] of cases) {
    const h = harness();
    const res = await handleFinalizeTrip(post(payload({ dashcam: dc })), h.deps);
    assertEquals(res.status, 200, why);
    const e = envelopeOf(h);
    assertEquals([e.dashcam.on, e.breakdown.dashcamMult, e.breakdown.mult, e.net], [false, 1, 1.2, 132], why);
    assertEquals([e.dashcam.movingS, e.dashcam.coveredS, e.dashcam.deviceId], [dc.movingS, dc.coveredS, DASHCAM], why);
  }
  // exactly 80 % earns it
  const h = harness();
  await handleFinalizeTrip(post(payload({ dashcam: covered({ coveredS: 1200 }) })), h.deps);
  assertEquals(envelopeOf(h).dashcam.on, true);
});

Deno.test('a payload without the dashcam block (an older app) scores as before and stores zero seconds', async () => {
  const h = harness();
  await handleFinalizeTrip(post(payload()), h.deps);
  const e = envelopeOf(h);
  assertEquals(e.dashcam, { deviceId: null, movingS: 0, coveredS: 0, synced: false, on: false });
  assertEquals([e.payload.dashcam, e.breakdown.dashcamMult, e.breakdown.mult], [null, 1, 1.2]);
});

Deno.test('a drowsy event costs its points but keeps the clean bonus, adds 0 to the rating and is not counted as an active event', async () => {
  const h = harness({ context: { ...freshContext, streak: { streak: 0, atRisk: false, freezes: 2, cleanRun: 0 } } });
  const res = await handleFinalizeTrip(post(payload({ miles: 5, safeMiles: 5, events: [drowsyEvent] })), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals([e.breakdown.cleanBonus, e.breakdown.gains, e.breakdown.penalties, e.net, e.breakdown.ratingPenalty, e.breakdown.activeEventCount], [25, 75, 50, 25, 0, 0]);
  assertEquals(e.events.map((x) => [x.id, x.type, x.status, x.measured]), [[DROWSY, 'drowsy', 'active', { source: 'dashcam', speedMph: 48 }]]);
  // the streak sees a clean, net-positive drive
  assertEquals([e.streak.outcome, e.streak.after.cleanRun], ['grew', 1]);
});

Deno.test('merge: DashPal seconds are summed over the target and the upload and the flag is derived from the sums, never OR-ed', async () => {
  const target = (dashcam: { deviceId: string | null; movingS: number; coveredS: number; synced: boolean }) => ({ ...freshContext, merge: mergeTarget({ dashcam }) });
  // the target alone was a DashPal drive; the union is not (600 of 3600 s covered)
  const h1 = harness({ context: target({ deviceId: DASHCAM, movingS: 600, coveredS: 600, synced: true }) });
  await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2, dashcam: covered({ movingS: 3000, coveredS: 0 }) })), h1.deps);
  assertEquals(envelopeOf(h1).dashcam, { deviceId: DASHCAM, movingS: 3600, coveredS: 600, synced: true, on: false });
  assertEquals([envelopeOf(h1).breakdown.dashcamMult, envelopeOf(h1).payload.dashcam?.movingS], [1, 3000]);
  // neither part alone, the union does: 500 + 2900 of 600 + 3000 = 94 %
  const h2 = harness({ context: target({ deviceId: DASHCAM, movingS: 600, coveredS: 500, synced: false }) });
  await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2, dashcam: covered({ movingS: 3000, coveredS: 2900 }) })), h2.deps);
  assertEquals(envelopeOf(h2).dashcam, { deviceId: DASHCAM, movingS: 3600, coveredS: 3400, synced: true, on: true });
  // 15 mi, 14.8 safe, streak 4: 148 × (1.08 × 1.25 = 1.35) = 199.8 → 200, minus 10
  assertEquals([envelopeOf(h2).breakdown.mult, envelopeOf(h2).breakdown.gains, envelopeOf(h2).net], [1.35, 200, 190]);
  // synced comes from the upload (the newest part): absent there → not synced, no bonus
  const h3 = harness({ context: target({ deviceId: DASHCAM, movingS: 3000, coveredS: 3000, synced: true }) });
  await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2 })), h3.deps);
  assertEquals(envelopeOf(h3).dashcam, { deviceId: DASHCAM, movingS: 3000, coveredS: 3000, synced: false, on: false });
  // the upload's device id wins over the target's
  const both = dashcamOf(payload({ dashcam: covered({ deviceId: 'ffffffffffff' }) }), mergeTarget({ dashcam: { deviceId: DASHCAM, movingS: 1, coveredS: 1, synced: true } }));
  assertEquals(both.deviceId, 'ffffffffffff');
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
