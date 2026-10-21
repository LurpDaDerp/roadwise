// Integration: the real handlers against the local stack (migrations 0001–0025) over the real
// engine. Runs only when FUNCTIONS_IT_DB_URL is readable — `npm run functions:test` has no env
// permission and skips it; run it with
//
//   FUNCTIONS_IT_DB_URL=postgresql://postgres:postgres@127.0.0.1:54622/postgres \
//     deno test -A --config supabase/functions/deno.json supabase/functions/finalize-trip/integration.test.ts
//
// Each run creates its own auth user and deletes it at the end (every user-owned table cascades).
import { assert, assertEquals } from '@std/assert';
import postgres from 'postgres';
import { createEngine } from '../_shared/engine.ts';
import { deleteTestUser } from '../_shared/testing/it_cleanup.ts';
import { EVENT, lineOfMiles, payload, payloadV3, TRIP, TRIP_2 } from '../_shared/testing/v5_fixtures.ts';
import { handleTripAction } from '../trip-actions/handler.ts';
import { handleFinalizeTrip } from './handler.ts';

const envState = (await Deno.permissions.query({ name: 'env', variable: 'FUNCTIONS_IT_DB_URL' })).state;
const DB_URL = envState === 'granted' ? Deno.env.get('FUNCTIONS_IT_DB_URL') : undefined;

const quiet = { warn: () => {}, error: () => {} };
const EVENT_B = 'abababab-abab-4bab-8bab-abababababab';
const TRIP_3 = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

const post = (path: string, body: unknown) =>
  new Request(`http://local/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    body: JSON.stringify(body),
  });

const nyDay = (t: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

Deno.test({
  name: 'finalize-trip + trip-actions against the local stack: v4 answer, replay, merge at 2 min / 100 m, report, "Wasn\'t driving"',
  ignore: !DB_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(DB_URL!, { max: 1, prepare: false });
    const engine = createEngine(DB_URL!);
    const user = crypto.randomUUID();
    const deps = { verifyJwt: () => Promise.resolve(user), engine, log: quiet };
    const started = Date.now() - 3 * 3_600_000;
    const base = payload({
      startedAt: started,
      endedAt: started + 30 * 60_000,
      localDay: nyDay(started),
      events: [{ ...payload().events[0], startedAt: started + 10 * 60_000 }],
    });
    try {
      await sql`insert into auth.users (id, email) values (${user}::uuid, ${`it-${user}@example.com`})`;
      await sql`update public.profiles set username = ${'it_' + user.slice(0, 8)}, onboarded_at = now() where id = ${user}::uuid`;

      // 1. a v4 upload: the answer is the v4 shape, nothing about points
      const first = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals(first.status, 200);
      const r1 = await first.json();
      assertEquals(Object.keys(r1).sort(), ['achievements', 'challenges', 'clientTripId', 'eventIds', 'mergedInto', 'rating', 'reason', 'scored', 'tripId']);
      assertEquals([r1.scored, r1.reason, r1.mergedInto, r1.eventIds, r1.achievements, r1.rating.ranked], [true, null, null, [EVENT], ['first_drive'], true]);
      assert(typeof r1.rating.safetyRating === 'number');
      const [t1] = await sql`select origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s from public.trips where id = ${r1.tripId}::uuid`;
      assertEquals([t1.origin, t1.not_driving_expired, t1.slowdowns, t1.speedups, t1.turns, t1.limit_s, t1.moving_s], ['auto', false, 18, 17, 11, 1200, 1650]);

      // 2. replay: the stored answer, nothing applied twice
      const again = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals([again.status, again.headers.get('x-replayed')], [200, 'true']);
      assertEquals(await again.json(), r1);
      const [{ n }] = await sql`select count(*)::int as n from public.trips where user_id = ${user}::uuid`;
      assertEquals(n, 1);

      // 3. merge: starts 2 minutes after the first ended, about 100 m from its end; no counters (estimated)
      const second = payload({
        clientTripId: TRIP_2,
        startedAt: base.endedAt + 2 * 60_000,
        endedAt: base.endedAt + 20 * 60_000,
        durationS: 1080,
        localDay: nyDay(base.endedAt + 2 * 60_000),
        miles: 3,
        start: { lat: 40.7315, lng: -73.9352 },
        end: { lat: 40.75, lng: -73.95 },
        polyline: lineOfMiles(3, 40.7315, -73.9352),
        origin: 'manual',
        notDrivingExpired: true,
        exposure: undefined,
        events: [{ id: EVENT_B, type: 'hard_brake', tier: 'minor', startedAt: base.endedAt + 5 * 60_000, durationS: 2, lat: null, lng: null, measured: {} }],
      });
      const merged = await handleFinalizeTrip(post('finalize-trip', second), deps);
      assertEquals(merged.status, 200);
      const r2 = await merged.json();
      assertEquals([r2.mergedInto, r2.clientTripId, r2.tripId, r2.eventIds.length], [TRIP, TRIP_2, r1.tripId, 2]);
      const [union] = await sql`select miles, n_hard_brake, polyline, duration_s, scoring_version, origin, not_driving_expired, slowdowns from public.trips where id = ${r1.tripId}::uuid`;
      // the union keeps the first leg's origin, ORs the "Not driving?" flag and sums the counters (3 mi in 18 min, 10 mph, estimates 9 slowdowns)
      assertEquals([Number(union.miles), union.n_hard_brake, union.duration_s, union.scoring_version, union.origin, union.not_driving_expired, union.slowdowns], [15, 2, 2880, 7, 'auto', true, 27]);
      assertEquals(union.polyline, `${base.polyline} ${second.polyline}`);

      // 4. report the first hard brake as a hazard: accepted, the event removed, one brake left
      const dispute = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals(dispute.status, 200);
      const d = await dispute.json();
      assertEquals([d.action, d.status, d.rejectReason, d.quotaLeft, d.clean], ['dispute', 'accepted', null, 2, false]);
      const twice = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals([twice.status, await twice.json()], [200, d]);
      const other = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'wrong_limit' }), deps);
      assertEquals([other.status, (await other.json()).code], [409, 'already_disputed']);
      const mismatch = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT_B, reason: 'wrong_limit' }), deps);
      assertEquals([mismatch.status, (await mismatch.json()).code], [400, 'reason_mismatch']);
      const brake2 = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT_B, reason: 'hazard' }), deps);
      assertEquals((await brake2.json()).clean, true);

      // 5. the merged drive's "Not driving?" ran out: "Wasn't driving" is refused with its own code
      const expired = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP }), deps);
      assertEquals([expired.status, (await expired.json()).code], [403, 'not_driving_expired']);

      // 6. an older build's v3 upload of a later drive: upgraded, its phone pickup gone, then marked as not driving
      const later = Date.now() - 60 * 60_000;
      const v3 = payloadV3({
        clientTripId: TRIP_3,
        startedAt: later,
        endedAt: later + 30 * 60_000,
        localDay: nyDay(later),
        events: payloadV3().events.map((e, i) => ({ ...e, startedAt: later + (5 + i) * 60_000 })),
      });
      const old = await handleFinalizeTrip(post('finalize-trip', v3), deps);
      assertEquals(old.status, 200);
      const r3 = await old.json();
      assertEquals(r3.eventIds.length, 2);
      const [t3] = await sql`select origin, not_driving_expired from public.trips where id = ${r3.tripId}::uuid`;
      assertEquals([t3.origin, t3.not_driving_expired], ['manual', false]);
      const nd = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP_3 }), deps);
      assertEquals(nd.status, 200);
      const ndBody = await nd.json();
      assertEquals([ndBody.action, ndBody.clientTripId, ndBody.notDrivingLeft], ['not_driving', TRIP_3, 1]);
      const ndAgain = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP_3 }), deps);
      assertEquals([ndAgain.status, await ndAgain.json()], [200, ndBody]);
    } finally {
      await deleteTestUser(sql, user);
      await engine.close();
      await sql.end({ timeout: 5 });
    }
  },
});
