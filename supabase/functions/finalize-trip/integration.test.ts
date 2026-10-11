// Integration: the real handlers against the local stack (migrations 0001–0009) over the real
// engine. Runs only when FUNCTIONS_IT_DB_URL is readable — `npm run functions:test` has no env
// permission and skips it; run it with
//
//   FUNCTIONS_IT_DB_URL=postgresql://postgres:postgres@127.0.0.1:54622/postgres \
//     deno test -A --config supabase/functions/deno.json supabase/functions/finalize-trip/integration.test.ts
//
// Each run creates its own auth user and deletes it at the end (every table cascades).
import { assert, assertEquals } from '@std/assert';
import postgres from 'postgres';
import { createEngine } from '../_shared/engine.ts';
import { DASHCAM, EVENT, lineOfMiles, payload, STARTED_AT, TRIP, TRIP_2 } from '../_shared/testing/v3_fixtures.ts';
import { handleTripAction } from '../trip-actions/handler.ts';
import { handleFinalizeTrip } from './handler.ts';

const envState = (await Deno.permissions.query({ name: 'env', variable: 'FUNCTIONS_IT_DB_URL' })).state;
const DB_URL = envState === 'granted' ? Deno.env.get('FUNCTIONS_IT_DB_URL') : undefined;

const quiet = { warn: () => {}, error: () => {} };
const USER = crypto.randomUUID();
const EVENT_B = 'abababab-abab-4bab-8bab-abababababab';

const post = (path: string, body: unknown) =>
  new Request(`http://local/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    body: JSON.stringify(body),
  });

Deno.test({
  name: 'finalize-trip + trip-actions against the local stack: happy path, replay, merge, dispute, not-driving',
  ignore: !DB_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(DB_URL!, { max: 1, prepare: false });
    const engine = createEngine(DB_URL!);
    const deps = { verifyJwt: () => Promise.resolve(USER), engine, log: quiet };
    // today in New York, so the drive counts as "today" on the server too
    const now = Date.now();
    const started = now - 90 * 60_000;
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(started));
    const base = payload({
      startedAt: started,
      endedAt: started + 30 * 60_000,
      localDay,
      events: [{ ...payload().events[0], startedAt: started + 10 * 60_000 }],
    });
    try {
      await sql`insert into auth.users (id, email) values (${USER}::uuid, ${`it-${USER}@example.com`})`;
      await sql`update public.profiles set username = ${'it_' + USER.slice(0, 8)}, onboarded_at = now(), league_eligible = true where id = ${USER}::uuid`;

      // 1. happy path
      const first = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals(first.status, 200);
      const r1 = await first.json();
      // a fresh user: streak 0 → 118, minus the minor hard brake
      assertEquals([r1.scored, r1.net, r1.streak.after, r1.progress.points, r1.achievements, r1.league.placed], [true, 108, 1, 108, ['first_drive'], true]);
      assertEquals(r1.clientTripId, TRIP);

      // 2. replay: byte-identical stored response, nothing applied twice
      const again = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals(again.status, 200);
      assertEquals(again.headers.get('x-replayed'), 'true');
      assertEquals(await again.json(), r1);
      const [{ n }] = await sql`select count(*)::int as n from public.trips where user_id = ${USER}::uuid`;
      assertEquals(n, 1);

      // 3. merge: starts 2 minutes after the first ended, 100 m from its end
      const second = payload({
        clientTripId: TRIP_2,
        startedAt: base.endedAt + 2 * 60_000,
        endedAt: base.endedAt + 20 * 60_000,
        durationS: 1080,
        localDay,
        miles: 3,
        safeMiles: 3,
        start: { lat: 40.7311, lng: -73.9358 },
        end: { lat: 40.75, lng: -73.95 },
        polyline: lineOfMiles(3, 40.7311, -73.9358),
        events: [{ id: EVENT_B, type: 'hard_brake', tier: 'minor', startedAt: base.endedAt + 5 * 60_000, durationS: 2, lat: null, lng: null, measured: {} }],
      });
      const merged = await handleFinalizeTrip(post('finalize-trip', second), deps);
      assertEquals(merged.status, 200);
      const r2 = await merged.json();
      assertEquals([r2.mergedInto, r2.clientTripId, r2.tripId], [TRIP, TRIP_2, r1.tripId]);
      // 15 mi, 14.8 safe, two minor hard brakes (10 + 12.5 → 10 + 13 = 23), streak 0: 148 → 125
      assertEquals([r2.breakdown.safeMiles, r2.breakdown.gains, r2.breakdown.penalties, r2.net, r2.streak.before, r2.streak.after], [14.8, 148, 23, 125, 0, 1]);
      const [trip] = await sql`select miles, points_net, rev, n_hard_brake, polyline from public.trips where id = ${r1.tripId}::uuid`;
      assertEquals([Number(trip.miles), trip.points_net, trip.rev, trip.n_hard_brake], [15, 125, 2, 2]);
      // the union's route is both drives' runs, space-joined and otherwise untouched: two runs, no line across the stop
      assertEquals(trip.polyline, `${base.polyline} ${second.polyline}`);
      const [{ points, lifetime }] = await sql`select points, lifetime from public.progress where user_id = ${USER}::uuid`;
      assertEquals([points, lifetime], [125, 125]);

      // 4. dispute the first hard brake as a hazard: accepted, re-scored, +13 credited (the repeat multiplier moves to the other brake)
      const dispute = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals(dispute.status, 200);
      const d = await dispute.json();
      assertEquals([d.status, d.net, d.delta, d.progress.points, d.quotaLeft], ['accepted', 138, 13, 138, 2]);
      // the itemised list the device shows now sums to the net: one hard brake left at its first-of-type penalty
      assertEquals(d.breakdown.events, [{ id: EVENT_B, penalty: 10 }]);
      assertEquals([d.breakdown.net, d.breakdown.penalties], [138, 10]);
      const twice = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals([twice.status, (await twice.json()).code], [409, 'already_disputed']);
      const mismatch = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT_B, reason: 'wrong_limit' }), deps);
      assertEquals([mismatch.status, (await mismatch.json()).code], [400, 'reason_mismatch']);

      // 5. "wasn't driving" on the merged drive restores progress to before it
      const nd = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP }), deps);
      assertEquals(nd.status, 200);
      const ndBody = await nd.json();
      assertEquals([ndBody.action, ndBody.notDrivingLeft, ndBody.progress.points, ndBody.progress.lifetime, ndBody.progress.streak], ['not_driving', 1, 0, 0, 0]);
      const second_nd = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP }), deps);
      assertEquals([second_nd.status, (await second_nd.json()).code], [409, 'already_marked']);
      const [{ s }] = await sql`select coalesce(sum(amount), 0)::int as s from public.points_ledger where user_id = ${USER}::uuid`;
      assertEquals(s, 0);
      assert(r1.tripId !== TRIP);
      assertEquals(typeof STARTED_AT, 'number');
    } finally {
      await sql`delete from auth.users where id = ${USER}::uuid`;
      await engine.close();
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: 'DashPal against the local stack: the x1.25, the stored seconds, a drowsy kept out of clean, hazard and camera_wrong disputes',
  ignore: !DB_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(DB_URL!, { max: 1, prepare: false });
    const engine = createEngine(DB_URL!);
    const user = crypto.randomUUID();
    const deps = { verifyJwt: () => Promise.resolve(user), engine, log: quiet };
    const DROWSY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const started = Date.now() - 90 * 60_000;
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(started));
    const drive = payload({
      startedAt: started,
      endedAt: started + 30 * 60_000,
      localDay,
      events: [
        { ...payload().events[0], startedAt: started + 10 * 60_000 },
        { id: DROWSY, type: 'drowsy', tier: 'severe', startedAt: started + 20 * 60_000, durationS: 4, lat: 40.725, lng: -73.96, measured: { source: 'dashcam', speedMph: 48 } },
      ],
      dashcam: { deviceId: DASHCAM, movingS: 1500, coveredS: 1350, synced: true },
    });
    try {
      await sql`insert into auth.users (id, email) values (${user}::uuid, ${`it-${user}@example.com`})`;
      await sql`update public.profiles set username = ${'dp_' + user.slice(0, 8)}, onboarded_at = now() where id = ${user}::uuid`;

      // streak 0, DashPal: 118 x 1.25 = 147.5 -> 148, minus 10 (brake) and 50 (drowsy)
      const res = await handleFinalizeTrip(post('finalize-trip', drive), deps);
      assertEquals(res.status, 200);
      const r = await res.json();
      assertEquals([r.net, r.breakdown.dashcamMult, r.breakdown.mult, r.breakdown.gains, r.breakdown.penalties, r.breakdown.ratingPenalty, r.breakdown.activeEventCount], [88, 1.25, 1.25, 148, 60, 10, 1]);
      const [t1] = await sql`select dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on, n_events, n_dashcam, clean, rating_penalty, scoring_version
        from public.trips where id = ${r.tripId}::uuid`;
      assertEquals(
        [t1.dashcam_device_id, t1.dashcam_moving_s, t1.dashcam_covered_s, t1.dashcam_synced, t1.dashcam_on, t1.n_events, t1.n_dashcam, t1.clean, t1.rating_penalty, t1.scoring_version],
        [DASHCAM, 1500, 1350, true, true, 1, 1, false, 10, 4]
      );

      // the brake was a hazard: the drowsy stays charged and no longer stands between the drive and clean
      const hazard = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals(hazard.status, 200);
      const h = await hazard.json();
      // (118 + 25) x 1.25 = 178.75 -> 179, minus 50
      assertEquals([h.status, h.net, h.delta, h.quotaLeft, h.breakdown.cleanBonus, h.breakdown.dashcamMult], ['accepted', 129, 41, 2, 25, 1.25]);
      const [t2] = await sql`select n_events, n_dashcam, clean from public.trips where id = ${r.tripId}::uuid`;
      assertEquals([t2.n_events, t2.n_dashcam, t2.clean], [0, 1, true]);

      // "DashPal got it wrong": its own quota, re-scored as the DashPal drive it was
      const wrong = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: DROWSY, reason: 'camera_wrong' }), deps);
      assertEquals(wrong.status, 200);
      const w = await wrong.json();
      assertEquals([w.status, w.net, w.delta, w.quotaLeft, w.breakdown.gains], ['accepted', 179, 50, 2, 179]);
      const [t3] = await sql`select n_dashcam, points_net from public.trips where id = ${r.tripId}::uuid`;
      assertEquals([t3.n_dashcam, t3.points_net], [0, 179]);
      const again = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'camera_wrong' }), deps);
      assertEquals([again.status, (await again.json()).code], [409, 'already_disputed']);
    } finally {
      await sql`delete from auth.users where id = ${user}::uuid`;
      await engine.close();
      await sql.end({ timeout: 5 });
    }
  },
});
