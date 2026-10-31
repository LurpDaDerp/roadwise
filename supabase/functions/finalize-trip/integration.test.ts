// Integration: the real handlers against the local stack (migrations 0001–0032) over the real
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
import { EVENT, lineOfMiles, payload, payloadV3, payloadV4, pickup, PICKUP, TRIP, TRIP_2 } from '../_shared/testing/v5_fixtures.ts';
import { handleTripAction } from '../trip-actions/handler.ts';
import { handleFinalizeTrip } from './handler.ts';

const envState = (await Deno.permissions.query({ name: 'env', variable: 'FUNCTIONS_IT_DB_URL' })).state;
const DB_URL = envState === 'granted' ? Deno.env.get('FUNCTIONS_IT_DB_URL') : undefined;

const quiet = { warn: () => {}, error: () => {} };
const EVENT_B = 'abababab-abab-4bab-8bab-abababababab';
const TRIP_3 = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const TRIP_4 = 'efefefef-efef-4fef-8fef-efefefefefef';

const post = (path: string, body: unknown) =>
  new Request(`http://local/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    body: JSON.stringify(body),
  });

const nyDay = (t: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

Deno.test({
  name: 'finalize-trip + trip-actions against the local stack: v5 answer with a pickup, replay, a drive of its own at 2 min / 100 m, reports ("mounted" too), "Wasn\'t driving", a v4 upload, an overlapping drive, no end point kept',
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
      events: [{ ...payload().events[0], startedAt: started + 10 * 60_000 }, pickup({ startedAt: started + 12 * 60_000 })],
    });
    try {
      await sql`insert into auth.users (id, email) values (${user}::uuid, ${`it-${user}@example.com`})`;
      await sql`update public.profiles set username = ${'it_' + user.slice(0, 8)}, onboarded_at = now() where id = ${user}::uuid`;

      // 1. a v5 upload with a phone pickup: the answer is the v4 shape, nothing about points
      const first = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals(first.status, 200);
      const r1 = await first.json();
      assertEquals(Object.keys(r1).sort(), ['achievements', 'challenges', 'clientTripId', 'eventIds', 'mergedInto', 'rating', 'reason', 'scored', 'tripId']);
      assertEquals([r1.scored, r1.reason, r1.mergedInto, r1.eventIds, r1.achievements, r1.rating.ranked], [true, null, null, [EVENT, PICKUP], ['first_drive'], true]);
      assert(typeof r1.rating.safetyRating === 'number');
      const [t1] = await sql`select origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s, phone_s, n_events, scoring_version from public.trips where id = ${r1.tripId}::uuid`;
      assertEquals([t1.origin, t1.not_driving_expired, t1.slowdowns, t1.speedups, t1.turns, t1.limit_s, t1.moving_s, t1.phone_s, t1.n_events, t1.scoring_version], ['auto', false, 18, 17, 11, 1200, 1650, 1500, 2, 10]);
      const [p1] = await sql`select type, tier, duration_s, measured from public.trip_events where client_event_id = ${PICKUP}::uuid`;
      assertEquals([p1.type, p1.tier, Number(p1.duration_s), p1.measured], ['phone_pickup', 'severe', 24, { speedMph: 31.2, maxSpeedMph: 38.4 }]);
      const [rating] = await sql`select private.rating_at(${user}::uuid, now()) -> 'scores' ->> 'phone' as phone`;
      assert(Number(rating.phone) > 0 && Number(rating.phone) < 100, 'Phone use is scored');

      // 2. replay: the stored answer, nothing applied twice
      const again = await handleFinalizeTrip(post('finalize-trip', base), deps);
      assertEquals([again.status, again.headers.get('x-replayed')], [200, 'true']);
      assertEquals(await again.json(), r1);
      const [{ n }] = await sql`select count(*)::int as n from public.trips where user_id = ${user}::uuid`;
      assertEquals(n, 1);

      // 3. a drive of its own: starts 2 minutes after the first ended, about 100 m from its end; no counters (estimated)
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
      const own = await handleFinalizeTrip(post('finalize-trip', second), deps);
      assertEquals(own.status, 200);
      const r2 = await own.json();
      assertEquals([r2.mergedInto, r2.clientTripId, r2.eventIds], [null, TRIP_2, [EVENT_B]]);
      assert(r2.tripId !== r1.tripId);
      const drives = await sql`select id, miles, n_hard_brake, duration_s, origin, not_driving_expired from public.trips where user_id = ${user}::uuid order by started_at`;
      assertEquals(
        drives.map((t) => [t.id, Number(t.miles), t.n_hard_brake, t.duration_s, t.origin, t.not_driving_expired]),
        [
          [r1.tripId, 12, 1, 1800, 'auto', false],
          [r2.tripId, 3, 1, 1080, 'manual', true],
        ]
      );

      // 4. report the first hard brake as a hazard: accepted, the event removed, one brake left
      const dispute = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals(dispute.status, 200);
      const d = await dispute.json();
      assertEquals([d.action, d.status, d.rejectReason, d.quotaLeft, d.clean], ['dispute', 'accepted', null, 2, false]);
      const twice = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'hazard' }), deps);
      assertEquals([twice.status, await twice.json()], [200, d]);
      const other = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: EVENT, reason: 'wrong_limit' }), deps);
      assertEquals([other.status, (await other.json()).code], [409, 'already_disputed']);
      const mismatch = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP_2, eventId: EVENT_B, reason: 'wrong_limit' }), deps);
      assertEquals([mismatch.status, (await mismatch.json()).code], [400, 'reason_mismatch']);
      const notMounted = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP_2, eventId: EVENT_B, reason: 'mounted' }), deps);
      assertEquals([notMounted.status, (await notMounted.json()).code], [400, 'reason_mismatch']);
      // "My phone was mounted" on the pickup: accepted from the same weekly three; the first drive is clean then
      const mounted = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP, eventId: PICKUP, reason: 'mounted' }), deps);
      assertEquals(mounted.status, 200);
      const md = await mounted.json();
      assertEquals([md.status, md.rejectReason, md.quotaLeft, md.clean], ['accepted', null, 1, true]);
      const brake2 = await handleTripAction(post('trip-actions', { action: 'dispute', clientTripId: TRIP_2, eventId: EVENT_B, reason: 'hazard' }), deps);
      assertEquals((await brake2.json()).clean, true);

      // 5. the second drive's "Not driving?" ran out: "Wasn't driving" is refused with its own code
      const expired = await handleTripAction(post('trip-actions', { action: 'not_driving', clientTripId: TRIP_2 }), deps);
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

      // 7. a build from before phone tracking (v4): stored with no phone seconds
      const v4At = Date.now() - 30 * 60_000;
      const v4 = payloadV4({
        clientTripId: TRIP_4,
        startedAt: v4At,
        endedAt: v4At + 20 * 60_000,
        durationS: 1200,
        localDay: nyDay(v4At),
        start: { lat: 41.0, lng: -74.5 },
        events: [],
        exposure: { slowdowns: 10, speedups: 10, turns: 6, limitS: 800, movingS: 1100 },
      });
      const fromV4 = await handleFinalizeTrip(post('finalize-trip', v4), deps);
      assertEquals(fromV4.status, 200);
      const r4 = await fromV4.json();
      assertEquals(r4.mergedInto, null);
      const [t4] = await sql`select phone_s, moving_s, scoring_version from public.trips where id = ${r4.tripId}::uuid`;
      assertEquals([t4.phone_s, t4.moving_s, t4.scoring_version], [0, 1100, 10]);

      // 8. a drive that overlaps the first by 20 minutes: stored, unscored as implausible
      const overlapping = payload({
        clientTripId: crypto.randomUUID(),
        startedAt: started + 10 * 60_000,
        endedAt: started + 40 * 60_000,
        localDay: nyDay(started + 10 * 60_000),
        events: [],
      });
      const both = await handleFinalizeTrip(post('finalize-trip', overlapping), deps);
      assertEquals(both.status, 200);
      const r5 = await both.json();
      assertEquals([r5.scored, r5.reason], [false, 'implausible']);

      // 9. no upload left a point behind: every one sent its start and end, none is kept
      // (0032: progress has no column for one; the start and end points are 40.7128 and 40.7306)
      const [g] = await sql`select to_jsonb(p)::text as progress, (select string_agg(to_jsonb(t)::text, ' ') from public.trips t where t.user_id = ${user}::uuid) as trips
        from public.progress p where p.user_id = ${user}::uuid`;
      assertEquals([g.progress.includes('last_end'), /40\.7128|40\.7306/.test(g.progress + g.trips)], [false, false]);
    } finally {
      await deleteTestUser(sql, user);
      await engine.close();
      await sql.end({ timeout: 5 });
    }
  },
});
