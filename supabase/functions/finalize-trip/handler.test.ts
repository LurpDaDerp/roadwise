import { assert, assertEquals } from '@std/assert';
import type { ApplyDriveEnvelope } from '../_shared/engine.ts';
import { PgError } from '../_shared/pg.ts';
import { fakeEngine, type FakeEngineScript } from '../_shared/testing/fake_engine.ts';
import {
  DASHCAM,
  EVENT,
  EVENT_2,
  EVENT_3,
  payload,
  payloadV3,
  payloadV4,
  pickup,
  PICKUP,
  response,
  STARTED_AT,
  TRIP,
  TRIP_2,
  USER,
} from '../_shared/testing/v5_fixtures.ts';
import { buildStoredDrive, clampMeasured, dashcamOf, handleFinalizeTrip, MAX_UPLOADS_PER_DAY, TZ_REFUSAL, UPLOAD_LIMIT_KEY } from './handler.ts';

const quiet = { warn: () => {}, error: () => {} };
const freshContext = { version: 23, phoneUse: true, existing: null, merge: null };
/** What `drive_context` still answers for an upload 2 min and 100 m after the drive before: read by nothing. */
const JOINABLE = {
  tripId: '99999999-9999-4999-8999-999999999999',
  clientTripId: TRIP_2,
  reason: null,
  miles: 3,
  durationS: 2280,
  events: [{ id: EVENT_2, type: 'eyes_off', tier: 'severe', startedAt: STARTED_AT - 20 * 60_000, durationS: 3, zone: null, status: 'removed', lat: null, lng: null, measured: { source: 'dashcam', speedMph: 30 } }],
  dashcam: { deviceId: DASHCAM, movingS: 600, coveredS: 600, synced: true },
};
const joinable = { ...freshContext, merge: JOINABLE };

function harness(script: FakeEngineScript = {}, auth: 'good' | 'bad' | 'down' = 'good') {
  const fake = fakeEngine({
    context: freshContext,
    apply: (e: ApplyDriveEnvelope) => response({ scored: e.scored, reason: e.reason, eventIds: e.events.map((x) => x.id) }),
    ...script,
  });
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

/** Every key the envelope may hold: nothing of points, streaks, levels, loops or safe miles. */
const ENVELOPE_KEYS = ['dashcam', 'events', 'mergeInto', 'payload', 'reason', 'scored', 'scoringVersion', 'user'];
const PAYLOAD_KEYS = [
  'appVersion', 'clientTripId', 'dashcam', 'durationS', 'end', 'endedAt', 'exposure', 'localDay', 'miles', 'nightMiles',
  'notDrivingExpired', 'origin', 'polyline', 'startedAt', 'tz',
];

Deno.test('happy path: a v5 upload is stored in one transaction with its origin, its "Not driving?" flag and its counters, and the stored answer is returned', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, response({ eventIds: [EVENT] }));
  assertEquals(h.fake.transactions, { opened: 1, failed: 0 });
  assertEquals(h.fake.calls.map((c) => c.fn), ['driveContext', 'takeRateLimit', 'driveOverlaps', 'applyDrive']);
  // the upload's start point goes no further (the fixture sends one, as an older build does)
  assertEquals(h.fake.calls[0].args, { userId: USER, clientTripId: TRIP, startedAt: STARTED_AT, endedAt: STARTED_AT + 30 * 60_000, localDay: '2026-10-05' });
  assertEquals(h.fake.calls[1].args, { userId: USER, key: UPLOAD_LIMIT_KEY, window: '1 day', max: MAX_UPLOADS_PER_DAY });
  assertEquals(h.fake.calls[2].args, { userId: USER, clientTripId: TRIP, startedAt: STARTED_AT, endedAt: STARTED_AT + 30 * 60_000 });
  const e = envelopeOf(h);
  assertEquals(Object.keys(e).sort(), ENVELOPE_KEYS);
  assertEquals(Object.keys(e.payload).sort(), PAYLOAD_KEYS);
  assertEquals([e.user, e.mergeInto, e.scored, e.reason, e.scoringVersion], [USER, null, true, null, 9]);
  assertEquals([e.payload.origin, e.payload.notDrivingExpired], ['auto', false]);
  assertEquals(e.payload.exposure, { slowdowns: 18, speedups: 17, turns: 11, limitS: 1200, movingS: 1650, phoneS: 1500 });
  // the uploaded event goes in active whatever the device said, with its position and measurements
  assertEquals(e.events.map((x) => [x.id, x.status, x.lat, x.measured]), [[EVENT, 'active', 40.72, { peakG: 0.42 }]]);
  // nor its end point: apply_drive never keeps where a drive ended
  assertEquals([e.payload.localDay, e.payload.end], ['2026-10-05', null]);
  assertEquals(JSON.stringify(h.fake.calls).match(/40\.7128|40\.7306/), null);
  assertEquals(JSON.stringify(e).match(/"(net|breakdown|streak|safeMiles|isLoop|loopRepeat|safeMilesEarlierToday)"/), null);
  assertEquals(res.headers.get('x-replayed'), null);
});

Deno.test('a manual drive whose "Not driving?" ran out, and one with no counters (the server estimates them)', async () => {
  const h = harness();
  const { exposure: _e, ...noExposure } = payload({ origin: 'manual', notDrivingExpired: true });
  assertEquals((await handleFinalizeTrip(post(noExposure), h.deps)).status, 200);
  const e = envelopeOf(h);
  assertEquals([e.payload.origin, e.payload.notDrivingExpired, e.payload.exposure], ['manual', true, null]);
});

Deno.test('a phone pickup travels to apply_drive as uploaded: its tier, its seconds in hand, its speeds; it breaks nothing else', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payload({ events: [...payload().events, pickup()] })), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals(
    e.events.map((x) => [x.id, x.type, x.tier, x.durationS, x.status, x.measured]),
    [
      [EVENT, 'hard_brake', 'minor', 2, 'active', { peakG: 0.42 }],
      [PICKUP, 'phone_pickup', 'severe', 24, 'active', { speedMph: 31.2, maxSpeedMph: 38.4 }],
    ]
  );
  assertEquals([e.scored, e.reason, e.payload.exposure?.phoneS], [true, null, 1500]);
});

Deno.test('the contract refuses a pickup the phone could not have recorded', async () => {
  const h = harness();
  for (const bad of [
    pickup({ tier: 'minor' }),
    pickup({ durationS: 0 }),
    pickup({ durationS: 2.5 }),
    pickup({ durationS: 1801 }),
    pickup({ startedAt: STARTED_AT - 1 }),
    pickup({ startedAt: STARTED_AT + 30 * 60_000 + 1 }),
    pickup({ measured: { source: 'dashcam' } }),
  ]) {
    assertEquals((await handleFinalizeTrip(post(payload({ events: [bad] })), h.deps)).status, 400);
  }
  assertEquals(h.fake.calls, []);
});

Deno.test('a v4 upload from a build before phone tracking is upgraded: no phone seconds, everything else as sent', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payloadV4()), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals(e.payload.exposure, { slowdowns: 18, speedups: 17, turns: 11, limitS: 1200, movingS: 1650, phoneS: 0 });
  assertEquals([e.payload.origin, e.payload.appVersion, e.events.map((x) => x.id)], ['auto', '3.0.0', [EVENT]]);
  const { exposure: _e, ...noCounters } = payloadV4();
  const none = harness();
  assertEquals((await handleFinalizeTrip(post(noCounters), none.deps)).status, 200);
  assertEquals(envelopeOf(none).payload.exposure, null);
  // a v4 body still refuses a pickup (only v5 carries one)
  const refused = harness();
  const withPickup = { ...payloadV4(), events: [{ ...pickup(), measured: { speedMph: 31.2 } }] };
  assertEquals((await handleFinalizeTrip(post(withPickup), refused.deps)).status, 400);
});

Deno.test('a v3 upload from an older build is upgraded: phone events and their fields go, origin manual, "Not driving?" never ran out, no safe miles', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(post(payloadV3()), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals(e.events.map((x) => [x.id, x.type]), [[EVENT, 'hard_brake'], [EVENT_2, 'speeding']]);
  assertEquals(e.events.some((x) => x.id === EVENT_3), false);
  // maxSpeedMph (a phone-use field) leaves the speeding event's measurements
  assertEquals(e.events[1].measured, { speedMph: 41, limitMph: 35, overMphS: 30 });
  assertEquals([e.payload.origin, e.payload.notDrivingExpired, e.payload.exposure, e.scored], ['manual', false, null, true]);
  assertEquals(Object.keys(e.payload).includes('safeMiles'), false);
  assertEquals(e.payload.appVersion, '2.0.0');
});

Deno.test('the counters are clamped as scoring clampExposure clamps them; limit or phone time over moving time is refused by the contract', async () => {
  const h = harness();
  // limitS or phoneS above movingS is refused by the contract; a counter at the cap is kept
  const bad = await handleFinalizeTrip(post(payload({ exposure: { slowdowns: 5, speedups: 5, turns: 5, limitS: 900, movingS: 800, phoneS: 0 } })), h.deps);
  assertEquals(bad.status, 400);
  const badPhone = await handleFinalizeTrip(post(payload({ exposure: { slowdowns: 5, speedups: 5, turns: 5, limitS: 0, movingS: 800, phoneS: 801 } })), h.deps);
  assertEquals(badPhone.status, 400);
  const noPhone = { ...payload(), exposure: { slowdowns: 5, speedups: 5, turns: 5, limitS: 0, movingS: 800 } };
  assertEquals((await handleFinalizeTrip(post(noPhone), h.deps)).status, 400);
  assertEquals(h.fake.calls, []);
  const ok = harness();
  await handleFinalizeTrip(post(payload({ exposure: { slowdowns: 20_000, speedups: 0, turns: 0, limitS: 0, movingS: 1800, phoneS: 1800 } })), ok.deps);
  assertEquals(envelopeOf(ok).payload.exposure, { slowdowns: 20_000, speedups: 0, turns: 0, limitS: 0, movingS: 1800, phoneS: 1800 });
});

// ---------------------------------------------------------------------------------------------
// DashPal
// ---------------------------------------------------------------------------------------------
type Dashcam = NonNullable<ReturnType<typeof payload>['dashcam']>;
const covered = (over: Partial<Dashcam> = {}): Dashcam => ({ deviceId: DASHCAM, movingS: 1500, coveredS: 1350, synced: true, ...over });

Deno.test('a DashPal drive: the seconds and the derived flag go to apply_drive; under 80 %, under 60 s or not synced is no DashPal drive', async () => {
  const h = harness();
  await handleFinalizeTrip(post(payload({ dashcam: covered() })), h.deps);
  assertEquals(envelopeOf(h).dashcam, { deviceId: DASHCAM, movingS: 1500, coveredS: 1350, synced: true, on: true });
  assertEquals(envelopeOf(h).payload.dashcam, covered());
  const cases: [Dashcam, string][] = [
    [covered({ coveredS: 1199 }), 'coverage 79.9 %'],
    [covered({ movingS: 59, coveredS: 59 }), 'moving 59 s'],
    [covered({ synced: false }), 'not synced'],
  ];
  for (const [dc, why] of cases) {
    const c = harness();
    assertEquals((await handleFinalizeTrip(post(payload({ dashcam: dc })), c.deps)).status, 200, why);
    assertEquals(envelopeOf(c).dashcam.on, false, why);
  }
  const none = harness();
  await handleFinalizeTrip(post(payload()), none.deps);
  assertEquals([envelopeOf(none).dashcam, envelopeOf(none).payload.dashcam], [{ deviceId: null, movingS: 0, coveredS: 0, synced: false, on: false }, null]);
});

Deno.test('a replay returns the stored answer from the context and applies nothing', async () => {
  const stored = response({ achievements: [] });
  const h = harness({ context: { version: 23, phoneUse: true, existing: stored, merge: null } });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), stored);
  assertEquals(res.headers.get('x-replayed'), 'true');
  assertEquals(h.fake.calls.map((c) => c.fn), ['driveContext']);
});

Deno.test('every upload is stored as its own drive: one 2 min and 100 m after the drive before keeps mergeInto null, its own events, seconds and length', async () => {
  const h = harness({ context: joinable });
  const res = await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2, events: [...payload().events, pickup()] })), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).mergedInto, null);
  const e = envelopeOf(h);
  assertEquals(e.mergeInto, null);
  assertEquals(e.events.map((x) => [x.id, x.status]), [[EVENT, 'active'], [PICKUP, 'active']]);
  assertEquals(e.dashcam, { deviceId: null, movingS: 0, coveredS: 0, synced: false, on: false });
  assertEquals([e.payload.miles, e.payload.clientTripId, e.payload.exposure?.slowdowns], [12, TRIP_2, 18]);
  assertEquals([e.scored, e.reason], [true, null]);
  // short on its own is too short, whatever the drive before it held
  const short = harness({ context: joinable });
  await handleFinalizeTrip(post(payload({ clientTripId: TRIP_2, events: [], exposure: undefined, miles: 0.2, durationS: 60, endedAt: STARTED_AT + 60_000 })), short.deps);
  assertEquals([envelopeOf(short).scored, envelopeOf(short).reason, envelopeOf(short).mergeInto], [false, 'too_short', null]);
  // the DashPal seconds are the upload's own
  assertEquals(dashcamOf(payload({ dashcam: { deviceId: DASHCAM, movingS: 100, coveredS: 90, synced: true } })), { deviceId: DASHCAM, movingS: 100, coveredS: 90, synced: true, on: true });
});

// The DashPal speed gate on the server: every episode at 10 mph or more counts.
const dcId = (n: number): string => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MIN = 60_000;
/** An uploaded DashPal event `m` minutes after the upload's start; `speedMph` null = not measured. */
const dcEvent = (n: number, type: 'drowsy' | 'eyes_off', m: number, speedMph: number | null = 40) => ({
  id: dcId(n),
  type,
  tier: 'severe' as const,
  startedAt: STARTED_AT + m * MIN,
  durationS: 4,
  lat: null,
  lng: null,
  measured: speedMph === null ? { source: 'dashcam' as const } : { source: 'dashcam' as const, speedMph },
});
Deno.test('every DashPal episode counts, however close to another; the phone\'s own events are never touched', async () => {
  const h = harness();
  const upload = payload({
    events: [
      ...payload().events, // the hard brake: the phone's own event, never touched
      dcEvent(3, 'drowsy', 1),
      dcEvent(4, 'eyes_off', 1),
      dcEvent(5, 'eyes_off', 2),
      dcEvent(6, 'drowsy', 5),
      dcEvent(7, 'drowsy', 14.9),
    ],
  });
  const res = await handleFinalizeTrip(post(upload), h.deps);
  assertEquals(res.status, 200);
  assertEquals(
    envelopeOf(h).events.map((x) => [x.id, x.status]),
    [
      [EVENT, 'active'],
      [dcId(3), 'active'],
      [dcId(4), 'active'],
      [dcId(5), 'active'],
      [dcId(6), 'active'],
      [dcId(7), 'active'],
    ]
  );
});

Deno.test('an upload keeps both drowsy episodes, in input order', async () => {
  const fresh = harness();
  await handleFinalizeTrip(post(payload({ events: [dcEvent(4, 'drowsy', 2), dcEvent(3, 'drowsy', 1)] })), fresh.deps);
  assertEquals(envelopeOf(fresh).events.map((x) => x.id), [dcId(4), dcId(3)]);
});

Deno.test('a DashPal event under 10 mph or with no measured speed is dropped, not the drive', async () => {
  const h = harness();
  const res = await handleFinalizeTrip(
    post(payload({ events: [...payload().events, dcEvent(1, 'drowsy', 2, 9.9), dcEvent(2, 'eyes_off', 3, null), dcEvent(3, 'eyes_off', 20, 10)] })),
    h.deps
  );
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals(e.events.map((x) => x.id), [EVENT, dcId(3)]);
  assertEquals(e.scored, true);
  assertEquals(e.events[0].measured, { peakG: 0.42 });
});

Deno.test('integrity: a mock location is stored unscored as spoofed, on its own; an implausible drive the same', async () => {
  const h = harness({ context: joinable });
  const res = await handleFinalizeTrip(post(payload({ integrity: { mockLocation: true, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 50 } })), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals([e.scored, e.reason, e.mergeInto, e.events.length], [false, 'spoofed', null, 1]);
  const h2 = harness();
  await handleFinalizeTrip(post(payload({ miles: 300, integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 70 } })), h2.deps);
  assertEquals([envelopeOf(h2).scored, envelopeOf(h2).reason], [false, 'implausible']);
  const h3 = harness();
  await handleFinalizeTrip(post(payload({ miles: 40, integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 90 } })), h3.deps);
  assertEquals([envelopeOf(h3).scored, envelopeOf(h3).reason], [false, 'implausible']);
});

Deno.test('a drive overlapping another stored drive of the user is stored unscored as implausible; a replay never asks', async () => {
  const h = harness({ overlaps: true });
  const res = await handleFinalizeTrip(post(payload()), h.deps);
  assertEquals(res.status, 200);
  const e = envelopeOf(h);
  assertEquals([e.scored, e.reason, e.events.length], [false, 'implausible', 1]);
  assertEquals((await res.json()).scored, false);
  // integrity's own reason stands; an overlapping short drive is implausible, not too short
  const spoofed = harness({ overlaps: true });
  await handleFinalizeTrip(post(payload({ integrity: { mockLocation: true, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 50 } })), spoofed.deps);
  assertEquals([envelopeOf(spoofed).scored, envelopeOf(spoofed).reason], [false, 'spoofed']);
  const short = harness({ overlaps: true });
  await handleFinalizeTrip(post(payload({ events: [], exposure: undefined, miles: 0.2, durationS: 60, endedAt: STARTED_AT + 60_000 })), short.deps);
  assertEquals([envelopeOf(short).scored, envelopeOf(short).reason], [false, 'implausible']);
  // a replay answers from the context before any overlap is looked for
  const replay = harness({ overlaps: true, context: { version: 23, phoneUse: true, existing: response(), merge: null } });
  assertEquals((await handleFinalizeTrip(post(payload()), replay.deps)).status, 200);
  assertEquals(replay.fake.calls.map((c) => c.fn), ['driveContext']);
  // a failing overlap read is the transaction's failure: retried, nothing stored
  const busy = harness({ overlaps: new PgError('55P03', 'lock timeout') });
  assertEquals((await handleFinalizeTrip(post(payload()), busy.deps)).status, 503);
  assertEquals(busy.fake.calls.map((c) => c.fn), ['driveContext', 'takeRateLimit', 'driveOverlaps']);
});

Deno.test('too short: under 0.5 mi AND under 2 min is stored unscored with reason too_short; either one reached scores it', async () => {
  const short = (over: Partial<ReturnType<typeof payload>>) => payload({ events: [], exposure: undefined, ...over });
  const h = harness();
  await handleFinalizeTrip(post(short({ miles: 0.3, durationS: 119, endedAt: STARTED_AT + 119_000 })), h.deps);
  assertEquals([envelopeOf(h).scored, envelopeOf(h).reason], [false, 'too_short']);
  const slow = harness();
  await handleFinalizeTrip(post(short({ miles: 0.3, durationS: 360, endedAt: STARTED_AT + 360_000 })), slow.deps);
  assertEquals([envelopeOf(slow).scored, envelopeOf(slow).reason], [true, null]);
  const quick = harness();
  await handleFinalizeTrip(post(short({ miles: 0.5, durationS: 90, endedAt: STARTED_AT + 90_000 })), quick.deps);
  assertEquals(envelopeOf(quick).scored, true);
  // the pure rule
  assertEquals(buildStoredDrive(short({ miles: 0.49, durationS: 119, endedAt: STARTED_AT + 119_000 })).short, true);
});

const SPEEDING = '55555555-5555-4555-8555-555555555555';
const speeding = (durationS: number, measured: Record<string, number>) => ({
  id: SPEEDING,
  type: 'speeding' as const,
  tier: 'minor' as const,
  startedAt: STARTED_AT + 5 * 60_000,
  durationS,
  lat: null,
  lng: null,
  measured,
});

Deno.test("a speeding event's overMphS is stored at most 150 mph over per second over the line (the rating reads it)", async () => {
  const h = harness();
  await handleFinalizeTrip(post(payload({ events: [speeding(15, { limitMph: 35, speedMph: 48, overMphS: 999_999 })] })), h.deps);
  assertEquals(envelopeOf(h).events.map((x) => [x.id, x.measured]), [[SPEEDING, { limitMph: 35, speedMph: 48, overMphS: 2250 }]]);
  const ok = harness();
  await handleFinalizeTrip(post(payload({ events: [speeding(15, { limitMph: 35, speedMph: 42, overMphS: 30 })] })), ok.deps);
  assertEquals(envelopeOf(ok).events[0].measured, { limitMph: 35, speedMph: 42, overMphS: 30 });
  const legacy = harness();
  await handleFinalizeTrip(post(payload({ events: [speeding(15, { limitMph: 35, speedMph: 42 })] })), legacy.deps);
  assertEquals(envelopeOf(legacy).events[0].measured, { limitMph: 35, speedMph: 42 });
  assertEquals(clampMeasured(speeding(5, { overMphS: 400 })).overMphS, 400);
  assertEquals(clampMeasured(speeding(2, { overMphS: 400 })).overMphS, 300);
  assertEquals(clampMeasured(speeding(65, { overMphS: 9000 })).overMphS, 9000);
  assertEquals(clampMeasured({ ...speeding(5, { overMphS: 400 }), type: 'hard_brake', tier: 'minor' }).overMphS, 400);
});

Deno.test('refusals before any database work: method, token, size, JSON, contract (an unknown version names v), zone, local day', async () => {
  const h = harness();
  assertEquals((await handleFinalizeTrip(post(payload(), 'good', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleFinalizeTrip(post(payload(), ''), h.deps)).status, 401);
  assertEquals((await handleFinalizeTrip(post(payload(), 'bad'), h.deps)).status, 401);
  assertEquals((await handleFinalizeTrip(post(payload()), harness({}, 'down').deps)).status, 503);
  assertEquals((await handleFinalizeTrip(post(payload(), 'good', { headers: { 'content-length': String(600_000) } }), h.deps)).status, 413);
  assertEquals((await handleFinalizeTrip(post(JSON.stringify(payload()) + 'x'.repeat(530_000)), h.deps)).status, 413);
  assertEquals((await handleFinalizeTrip(post('{not json'), h.deps)).status, 400);
  const version = await handleFinalizeTrip(post({ ...payload(), v: 6 }), h.deps);
  assertEquals(version.status, 400);
  const vBody = await version.json();
  assertEquals(vBody.code, 'invalid_payload');
  assert(vBody.issues.some((i: { path: string }) => i.path === 'v'));
  // a body just under the cap that is a quarter of a million bad events: a refusal of a few lines
  const flood = `{"v":5,"events":[${new Array(262_000).fill('0').join(',')}]}`;
  assert(flood.length < 524_288);
  const flooded = await handleFinalizeTrip(post(flood), h.deps);
  assertEquals(flooded.status, 400);
  const floodText = await flooded.text();
  assert(floodText.length < 4096, `refusal of ${floodText.length} bytes`);
  assert(JSON.parse(floodText).issues.length <= 20);
  // v5 refuses what only the old phone use (screen switches) and points carried
  const handling = { ...payload().events[0], id: EVENT_3, type: 'phone_handling', tier: 'severe' };
  for (const bad of [
    { ...payload(), events: [handling] },
    { ...payload(), safeMiles: 11 },
    { ...payload(), events: [{ ...payload().events[0], units: 2 }] },
    { ...payload(), events: [{ ...payload().events[0], measured: { mounted: true } }] },
    (({ origin: _o, ...rest }) => rest)(payload()),
  ]) {
    assertEquals((await handleFinalizeTrip(post(bad), h.deps)).status, 400);
  }
  const status = await handleFinalizeTrip(post(payload({ events: [{ ...payload().events[0], status: 'removed' as never }] })), h.deps);
  assertEquals(status.status, 400);
  const tz = await handleFinalizeTrip(post(payload({ tz: 'Mars/Olympus' })), h.deps);
  assertEquals(tz.status, 400);
  assertEquals((await tz.json()).issues, [{ path: 'tz', message: 'unknown time zone' }]);
  const day = await handleFinalizeTrip(post(payload({ localDay: '2026-10-06' })), h.deps);
  assertEquals(day.status, 400);
  assertEquals((await day.json()).issues[0].path, 'localDay');
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

Deno.test('engine failures map to codes only: an older database (no version 23, or no phone use) 500, retryable 503, 22023 400, P0002 500, an answer outside the contract 500', async () => {
  const old = harness({ context: { existing: null, week: '2026-W41', merge: null } });
  const older = await handleFinalizeTrip(post(payload()), old.deps);
  assertEquals([older.status, (await older.json()).code], [500, 'internal']);
  assertEquals(old.fake.calls.map((c) => c.fn), ['driveContext']);
  // a database without 0026 cannot store a pickup: refused before anything is written (a 500 the phone retries, never a 400)
  const noPhone = harness({ context: { version: 23, existing: null, merge: null } });
  const before0026 = await handleFinalizeTrip(post(payload({ events: [pickup()] })), noPhone.deps);
  assertEquals([before0026.status, (await before0026.json()).code], [500, 'internal']);
  assertEquals(noPhone.fake.calls.map((c) => c.fn), ['driveContext']);
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
  // an old points answer (a replay of a drive stored before 0023 rewrote it) is drift too
  const legacy = await handleFinalizeTrip(post(payload()), harness({ context: { version: 23, phoneUse: true, existing: { tripId: TRIP, net: 4 }, merge: null } }).deps);
  assertEquals(legacy.status, 500);
  for (const r of [older, before0026, retry, envelope, missing, drift, legacy]) assert(r.headers.get('x-request-id'));
});
