-- 0003_drives + 0008_engine: the drive engine. One happy path, idempotency, the merge and its
-- exact revert, "wasn't driving" (latest only, 24 h, 2 a month, DMS face, flagging), disputes
-- (type match, 3-a-week quota, mounted rule, delta credit), the rating, the client reads.
create extension if not exists pgtap with schema extensions;

begin;
select plan(83);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- every drive is anchored at 02:00 New York today so local days and the merge gap are deterministic
create temporary table t as select (date_trunc('day', now() at time zone 'America/New_York') + interval '2 hours') at time zone 'America/New_York' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
grant select on t to authenticated;
grant execute on function pg_temp.t0() to authenticated;

-- a scored drive through apply_drive: events are [{id, type, tier, penalty}] shorthand
create function pg_temp.drive(p_user uuid, p_client uuid, p_started timestamptz, p_minutes int, p_miles numeric, p_net int, p_events jsonb,
  p_merge uuid default null, p_extra jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
  v_bd jsonb;
  v_streak int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', floor(extract(epoch from p_started + interval '1 minute') * 1000)::bigint, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb), 'status', coalesce(e ->> 'status', 'active'))), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'penalty', coalesce((e ->> 'penalty')::int, 10))), '[]'::jsonb) into v_bd from jsonb_array_elements(p_events) e
    where coalesce(e ->> 'status', 'active') = 'active';
  if p_merge is null then
    select streak into v_streak from public.progress where user_id = p_user;
  else
    select (progress_before ->> 'streak')::int into v_streak from public.trips where id = p_merge;
  end if;
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', p_merge,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + make_interval(mins => p_minutes)) * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'safeMiles', p_miles, 'nightMiles', 0,
      'durationS', p_minutes * 60, 'dmsOn', false, 'dmsFaceSeen', coalesce((p_extra ->> 'face')::boolean, false),
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', 'poly', 'appVersion', '3.0.0'),
    'scored', coalesce((p_extra ->> 'scored')::boolean, true), 'reason', p_extra ->> 'reason', 'net', p_net,
    'breakdown', jsonb_build_object('scored', true, 'net', p_net, 'ratingPenalty', coalesce((p_extra ->> 'ratingPenalty')::int, 0), 'events', v_bd),
    'events', v_ev,
    'streak', jsonb_build_object('before', jsonb_build_object('streak', v_streak), 'after', jsonb_build_object('streak', case when p_net > 0 then v_streak + 1 else v_streak end, 'atRisk', p_net < 0, 'freezes', 2, 'cleanRun', 0),
      'outcome', case when p_net > 0 then 'grew' when p_net < 0 then 'at_risk' else 'none' end, 'freezeEarned', false),
    'isLoop', false, 'loopRepeat', false, 'safeMilesEarlierToday', 0, 'scoringVersion', 3) || p_extra);
end $$;

-- ---------------------------------------------------------------------------
-- context + first drive
-- ---------------------------------------------------------------------------
select is((private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), (pg_temp.t0() at time zone 'America/New_York')::date, 47.6, -122.3)) - 'week',
  '{"merge": null, "streak": {"atRisk": false, "streak": 0, "freezes": 2, "cleanRun": 0}, "existing": null, "leagueEligible": true, "loopDrivesToday": 0, "safeMilesEarlierToday": 0}'::jsonb,
  'a fresh context: no merge, zero streak, 2 freezes, eligible');
select is((select count(*)::int from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'), 3, 'the context assigns the week''s challenges');

create temporary table r1 as select pg_temp.drive('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 12, 167,
  '[{"id":"22222222-2222-4222-8222-222222222222","type":"hard_brake","penalty":10}]', null, '{"ratingPenalty": 10}') as r;
select is((select r -> 'progress' from r1), '{"level": 1, "points": 167, "ranked": false, "levelUp": false, "lifetime": 167, "safetyRating": 91.7}'::jsonb, 'the response carries the new progress');
select is((select r -> 'streak' from r1), '{"after": 1, "atRisk": false, "before": 0, "freezes": 2, "outcome": "grew", "nextMult": 1.02, "freezeEarned": false}'::jsonb, 'and the streak block');
select is((select array[r ->> 'scored', r ->> 'mergedInto', r -> 'achievements' #>> '{0}', r -> 'league' ->> 'placed'] from r1), array['true', null, 'first_drive', 'true'], 'scored, not merged, first_drive unlocked, placed in a league');
select is((select row(points, lifetime, level, streak, phone_free_run, miles_30d, safety_rating, ranked, last_end_lat, last_end_lng)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'),
  row(167, 167, 1, 1, 1, 12.00, 91.7, false, 47.61, -122.31)::text, 'progress: points, lifetime, streak, phone-free run, 30-day miles, rating, the end point');
select is((select row(scored, points_net, n_events, n_hard_brake, clean, rating_penalty, rev, streak_before)::text from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'),
  row(true, 167, 1, 1, false, 10, 1, 0)::text, 'the trip row holds the derived counts');
select is((select progress_before from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111') - 'freezes_granted_at',
  '{"level": 1, "points": 0, "streak": 0, "at_risk": false, "freezes": 2, "lifetime": 0, "clean_run": 0, "last_end_at": null, "last_end_lat": null, "last_end_lng": null, "phone_free_run": 0, "freeze_progress": 0}'::jsonb,
  'progress_before is the snapshot taken before the drive');
select is((select row(penalty, status)::text from public.trip_events where client_event_id = '22222222-2222-4222-8222-222222222222'), row(10, 'active')::text, 'the event row carries its penalty');
select is((select array_agg(key || '=' || amount order by created_at) from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001'),
  array['drive:' || (select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111') || ':1=167'], 'one ledger row, keyed by trip and revision');

-- idempotency
select is((private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), (pg_temp.t0() at time zone 'America/New_York')::date, 47.6, -122.3)) -> 'existing',
  (select r from r1), 'a replayed clientTripId returns the stored response from the context');
select is(pg_temp.drive('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 12, 999, '[]'), (select r from r1),
  'and from apply_drive, without applying anything');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), 167, 'points unchanged by the replay');
select throws_ok($$ select private.apply_drive('{"user":"00000000-0000-0000-0000-000000000001"}') $$, '22023', 'apply_drive needs user, payload, events, breakdown, streak and scored', 'a malformed envelope is refused');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111112', pg_temp.t0(), current_date, 47.6, null) $$, '22023', 'start must be a lat/lng pair on the globe', 'half a start point is refused');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000009', '11111111-1111-4111-8111-111111111112', pg_temp.t0(), current_date, null, null) $$, 'P0002', 'no progress for user', 'an unknown user has no context');

-- ---------------------------------------------------------------------------
-- merge: a drive starting 2 min after the last one ended, 100 m away
-- ---------------------------------------------------------------------------
create temporary table c2 as select private.drive_context('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '32 minutes', (pg_temp.t0() at time zone 'America/New_York')::date, 47.6105, -122.3105) as c;
select is((select c -> 'merge' ->> 'clientTripId' from c2), '11111111-1111-4111-8111-111111111111', 'the context names the latest drive as the merge target');
select is((select c -> 'merge' -> 'streak' from c2), '{"atRisk": false, "streak": 0, "freezes": 2, "cleanRun": 0}'::jsonb, 'with the streak state from before that drive');
select is((select jsonb_array_length(c -> 'merge' -> 'events') from c2), 1, 'and its stored events');
select is((select c -> 'safeMilesEarlierToday' from c2), '12.00'::jsonb, 'safe miles earlier today count the first drive');
select is((private.drive_context('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333334', pg_temp.t0() + interval '40 minutes', (pg_temp.t0() at time zone 'America/New_York')::date, 47.6105, -122.3105)) -> 'merge', 'null'::jsonb,
  'a start more than 300 s after the end is not merged');
select is((private.drive_context('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333334', pg_temp.t0() + interval '32 minutes', (pg_temp.t0() at time zone 'America/New_York')::date, 47.62, -122.33)) -> 'merge', 'null'::jsonb,
  'nor a start more than 402 m away');

create temporary table r2 as select pg_temp.drive('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '32 minutes', 18, 3, 200,
  '[{"id":"22222222-2222-4222-8222-222222222222","type":"hard_brake","penalty":10}]',
  (select (c -> 'merge' ->> 'tripId')::uuid from c2), '{"ratingPenalty": 10}') as r;
select is((select array[r ->> 'mergedInto', r ->> 'tripId'] from r2), array['11111111-1111-4111-8111-111111111111', (select id::text from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111')],
  'the response says which drive it merged into');
select is((select row(miles, safe_miles, duration_s, points_net, rev, polyline, scored)::text from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'),
  row(15.00, 15.00, 2880, 200, 2, 'polypoly', true)::text, 'the target row now holds the union');
select is((select row(merged_into = (select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'), scored, points_net, miles)::text from public.trips where client_trip_id = '33333333-3333-4333-8333-333333333333'),
  row(true, false, 0, 3.00)::text, 'the merged-away payload keeps an unscored row pointing at the target');
select is((select row(points, lifetime, streak, miles_30d)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(200, 200, 1, 15.00)::text,
  'progress reflects the union only (the first drive was reverted first)');
select is((select array_agg(kind || '=' || amount order by created_at) from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001'), array['drive=167', 'revert=-167', 'drive=200'],
  'the ledger shows the revert and the re-apply');
select is((select count(*)::int from public.trip_events where trip_id = (select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111')), 1, 'the shared event is not duplicated');

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.dispute_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'wrong_limit') $$,
  '22023', 'that reason does not apply to this event', 'wrong_limit does not apply to a hard brake');
select throws_ok($$ select private.dispute_context('00000000-0000-0000-0000-000000000002', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard') $$,
  'P0002', 'trip not found', 'another user cannot dispute A''s event');
create temporary table d1 as select private.dispute_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard') as d;
select is((select array[d ->> 'status', d ->> 'quotaLeft', d -> 'rescore' -> 'ctx' ->> 'streak', d -> 'rescore' -> 'input' -> 'events' #>> '{0,status}'] from d1), array['accepted', '3', '0', 'removed'],
  'a hazard dispute is accepted with the stored context and the event marked removed');
create temporary table a1 as select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select d ->> 'tripId' from d1),
  'eventId', '22222222-2222-4222-8222-222222222222', 'reason', 'hazard', 'status', 'accepted',
  'breakdown', '{"net": 210, "ratingPenalty": 0, "events": []}'::jsonb, 'net', 210)) as a;
select is((select array[a ->> 'status', a ->> 'delta', a -> 'progress' ->> 'points', a -> 'progress' ->> 'lifetime', a -> 'progress' ->> 'safetyRating'] from a1), array['accepted', '10', '210', '210', '100.0'],
  'the delta is credited to points and lifetime and the rating refreshed');
select is((select row(status, penalty)::text from public.trip_events where client_event_id = '22222222-2222-4222-8222-222222222222'), row('removed', 0)::text, 'the event is removed');
select is((select row(points_net, n_events, clean, rating_penalty)::text from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'), row(210, 0, true, 0)::text, 'the trip is re-scored and now clean');
select throws_ok($$ select private.dispute_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard') $$,
  '42501', 'already disputed', 'an event is disputed once');

-- quota: 3 accepted hazard/wrong_limit per league week
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', pg_temp.t0() + interval '60 minutes', 10, 4, 10,
  '[{"id":"a1a1a1a1-0000-4000-8000-000000000001","type":"speeding","penalty":15,"measured":{"limitMph":25,"speedMph":35}},{"id":"a1a1a1a1-0000-4000-8000-000000000002","type":"hard_brake"},{"id":"a1a1a1a1-0000-4000-8000-000000000003","type":"hard_brake"},{"id":"a1a1a1a1-0000-4000-8000-000000000004","type":"phone_pickup","tier":"severe","durationS":20,"measured":{"mounted":true}},{"id":"a1a1a1a1-0000-4000-8000-000000000005","type":"phone_pickup","tier":"severe","durationS":5,"measured":{"mounted":true}}]');
select is((select private.dispute_context('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000001', 'wrong_limit')) ->> 'status', 'accepted', 'second of the week accepted');
select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'),
  'eventId', 'a1a1a1a1-0000-4000-8000-000000000001', 'reason', 'wrong_limit', 'status', 'accepted'));
select is((select row(lat, lng, limit_mph, speed_mph)::text from public.map_feedback), row(47.6, -122.3, 25, 35)::text, 'a wrong-limit report is logged to map_feedback without a user');
select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'),
  'eventId', 'a1a1a1a1-0000-4000-8000-000000000002', 'reason', 'hazard', 'status', 'accepted'));
select is((select private.dispute_context('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000003', 'hazard')) - 'rescore' - 'tripId' - 'clientTripId' - 'oldNet' - 'scored',
  '{"status": "rejected", "reason": "hazard", "eventId": "a1a1a1a1-0000-4000-8000-000000000003", "quotaLeft": 0, "rejectReason": "quota"}'::jsonb, 'the fourth of the week is rejected: quota');
select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'),
  'eventId', 'a1a1a1a1-0000-4000-8000-000000000003', 'reason', 'hazard', 'status', 'rejected', 'rejectReason', 'quota'));
select is((select row(status, penalty)::text from public.trip_events where client_event_id = 'a1a1a1a1-0000-4000-8000-000000000003'), row('active', 10)::text, 'a rejected dispute leaves the event active');
delete from public.event_disputes where client_event_id = 'a1a1a1a1-0000-4000-8000-000000000003';
select is((private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'),
  'eventId', 'a1a1a1a1-0000-4000-8000-000000000003', 'reason', 'hazard', 'status', 'accepted', 'breakdown', '{"net": 100, "ratingPenalty": 0, "events": [], "activeEventCount": 3}'::jsonb, 'net', 100))) - 'progress' - 'tripId',
  '{"net": 10, "delta": 0, "status": "rejected", "eventId": "a1a1a1a1-0000-4000-8000-000000000003", "rejectReason": "quota"}'::jsonb,
  'an accepted decision past the quota is re-counted under the lock and stored rejected');
delete from public.event_disputes where client_event_id = 'a1a1a1a1-0000-4000-8000-000000000003';
select throws_ok($$ select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'),
  'eventId', 'a1a1a1a1-0000-4000-8000-000000000005', 'reason', 'mounted', 'status', 'accepted', 'breakdown', '{"net": 100, "ratingPenalty": 0, "events": [], "activeEventCount": 1}'::jsonb, 'net', 100)) $$,
  '40001', 'stale breakdown', 'a breakdown scored over a different set of active events is a retry');
select is((select private.dispute_context('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000004', 'mounted')) ->> 'rejectReason', 'not_mounted',
  'mounted: a 20 s pickup is rejected even when mounted');
select is((select private.dispute_context('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000005', 'mounted')) ->> 'status', 'accepted',
  'mounted: a 5 s mounted pickup is accepted (outside the weekly quota)');
update public.trips set ended_at = now() - interval '8 days', started_at = now() - interval '8 days 10 minutes' where client_trip_id = '44444444-4444-4444-8444-444444444444';
select throws_ok($$ select private.dispute_context('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000005', 'mounted') $$,
  '42501', 'the drive is older than 7 days', 'disputes close after 7 days');
update public.trips set ended_at = pg_temp.t0() + interval '70 minutes', started_at = pg_temp.t0() + interval '60 minutes' where client_trip_id = '44444444-4444-4444-8444-444444444444';

-- ---------------------------------------------------------------------------
-- "wasn't driving"
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111') $$,
  '42501', 'only your latest drive can be marked', 'only the latest drive');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333') $$,
  'P0002', 'trip not found', 'a merged-away payload is not a drive');
select is((select row(points, lifetime, streak)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(220, 220, 2)::text, 'before: the union plus the 4-mile drive');
create temporary table nd as select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444') as n;
select is((select n -> 'progress' from nd), '{"level": 1, "atRisk": false, "points": 210, "ranked": false, "streak": 1, "freezes": 2, "lifetime": 210, "safetyRating": 100.0}'::jsonb,
  'progress is restored to exactly what it was before that drive');
select is((select n ->> 'notDrivingLeft' from nd), '1', 'one use left this month');
select is((select row(not_driving, points_net, not_driving_at = now())::text from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'), row(true, 0, true)::text, 'the trip is marked');
select is((select sum(amount)::int from public.points_ledger where trip_id = (select id from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444')), 0, 'its ledger nets to zero');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444') $$,
  '42501', 'already marked as not driving', 'marking twice is refused');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '55555555-5555-4555-8555-555555555555', pg_temp.t0() + interval '80 minutes', 10, 2, 20, '[]', null, '{"face": true}');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '55555555-5555-4555-8555-555555555555') $$,
  '42501', 'the camera saw a driver on this drive', 'refused when DMS saw a face');
update public.trips set dms_face_seen = false where client_trip_id = '55555555-5555-4555-8555-555555555555';
select lives_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '55555555-5555-4555-8555-555555555555') $$, 'the second use this month');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666', pg_temp.t0() + interval '100 minutes', 10, 2, 20, '[]');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666') $$,
  '42501', 'no uses left this month', 'the third use in a month is refused');
update public.trips set ended_at = ended_at - interval '26 hours', started_at = started_at - interval '26 hours' where user_id = '00000000-0000-0000-0000-000000000001';
update public.progress set last_end_at = last_end_at - interval '26 hours' where user_id = '00000000-0000-0000-0000-000000000001';
update public.trips set not_driving_at = now() - interval '40 days' where client_trip_id in ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666') $$,
  '42501', 'the drive is older than 24 hours', 'and a drive older than 24 h cannot be marked');
select is((select flagged from public.profiles where id = '00000000-0000-0000-0000-000000000001'), false, 'not flagged: only one of the two uses had events');
-- flagging: 3 of the last 4 uses on drives with events
update public.trips set n_events = 2 where client_trip_id = '55555555-5555-4555-8555-555555555555';
update public.trips set ended_at = ended_at + interval '26 hours', started_at = started_at + interval '26 hours' where user_id = '00000000-0000-0000-0000-000000000001';
update public.progress set last_end_at = last_end_at + interval '26 hours' where user_id = '00000000-0000-0000-0000-000000000001';
update public.trips set n_events = 1 where client_trip_id = '66666666-6666-4666-8666-666666666666';
select lives_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666') $$, 'a third use (new month)');
select is((select flagged from public.profiles where id = '00000000-0000-0000-0000-000000000001'), true, 'three of the last uses were on drives with events: flagged');

-- an older drive applied after a newer one makes the newer one's snapshot stale: it can no longer be reverted
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '88888888-8888-4888-8888-888888888888', pg_temp.t0() + interval '300 minutes', 10, 2, 20, '[]');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '89898989-8989-4989-8989-898989898989', pg_temp.t0() + interval '200 minutes', 10, 2, 20, '[]');
select throws_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '88888888-8888-4888-8888-888888888888') $$,
  '42501', 'only your latest drive can be marked', 'the newer-started drive is not the last applied: refused');
reset role;
update public.trips set not_driving_at = now() - interval '40 days' where not_driving;
select lives_ok($$ select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '89898989-8989-4989-8989-898989898989') $$, 'the last applied one can be');

-- envelope invariants: a fresh event is stored active whatever it says; bounds are fixed 22023s
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a', pg_temp.t0() + interval '320 minutes', 10, 2, 20,
  '[{"id":"c1c1c1c1-0000-4000-8000-000000000001","type":"hard_brake","status":"removed"}]');
select is((select status from public.trip_events where client_event_id = 'c1c1c1c1-0000-4000-8000-000000000001'), 'active',
  'an uploaded event marked removed is stored active (only apply_dispute removes)');
select is((select row(n_events, clean)::text from public.trips where client_trip_id = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a'), row(1, false)::text, 'and counted');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '340 minutes', 10, 2, 50000, '[]') $$,
  '22023', 'net or ratingPenalty is out of range', 'a net outside ±20000 is refused');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '340 minutes', 10, 2, 20, '[]', null, '{"streak": {"before": {"streak": 3}, "after": {"streak": 9, "atRisk": false, "freezes": 2, "cleanRun": 0}, "outcome": "grew", "freezeEarned": false}}') $$,
  '22023', 'streak.after is not a streak transition', 'a streak jump is refused');
select is((private.drive_context('00000000-0000-0000-0000-000000000001', '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c', pg_temp.t0() + interval '332 minutes', (pg_temp.t0() at time zone 'America/New_York')::date, 47.61, -122.31, pg_temp.t0() + interval '17 hours 21 minutes')) -> 'merge', 'null'::jsonb,
  'a merge whose union would exceed 12 hours is refused: scored as a separate drive');
select isnt((private.drive_context('00000000-0000-0000-0000-000000000001', '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c', pg_temp.t0() + interval '332 minutes', (pg_temp.t0() at time zone 'America/New_York')::date, 47.61, -122.31, pg_temp.t0() + interval '6 hours')) -> 'merge', 'null'::jsonb,
  'within 12 hours it merges');

-- ---------------------------------------------------------------------------
-- rating and stats
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '77777777-7777-4777-8777-777777777777', pg_temp.t0() + interval '120 minutes', 10, 10, 50,
  '[{"id":"b1b1b1b1-0000-4000-8000-000000000001","type":"phone_pickup","tier":"severe","penalty":40}]', null, '{"ratingPenalty": 40}');
select is((select row(miles_30d, clean_miles_30d, rating_penalty_30d, safety_rating, ranked)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'),
  row(29.00, 17.00, 40.00, 86.2, true)::text, '29 miles: ranked; R = 40/29*100 = 138 -> 86.2; clean miles exclude the drives with events');
select is(private.stat_sums('00000000-0000-0000-0000-000000000001', null), '{"miles": 29.00, "drives": 4, "drowsy": 0, "eyesOff": 0, "pickups": 1, "durationS": 4680, "hardAccel": 0, "hardBrake": 1, "speeding": 0, "handlingS": 0, "hardCorner": 0, "nightMiles": 0.00, "cleanDrives": 2}'::jsonb,
  'stat sums cover the kept scored drives only');
update public.trips set started_at = started_at - interval '32 days', ended_at = ended_at - interval '32 days' where client_trip_id = '77777777-7777-4777-8777-777777777777';
update public.progress set rating_updated_at = now() - interval '21 hours' where user_id = '00000000-0000-0000-0000-000000000001';
select is(private.refresh_ratings_daily(), 1, 'the daily refresh picks the user whose rating is 20 h old');
select is((select row(miles_30d, safety_rating, ranked)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(19.00, 100.0, false)::text, 'the daily refresh (driven from progress) ages drives out of the window');
select is((select round(private.rating_as_of('00000000-0000-0000-0000-000000000001', now() - interval '30 days'), 1)), 60.0, 'rating_as_of sees only the drive inside its window (one pickup per 10 mi)');

-- ---------------------------------------------------------------------------
-- client reads
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select jsonb_array_length(public.list_my_drives(null, 10))), 8, 'A lists the eight drives (the merged-away payload is not a drive)');
select is((select array_agg(d ->> 'clientTripId' order by (d ->> 'startedAt')::bigint desc) from jsonb_array_elements(public.list_my_drives(pg_temp.t0() + interval '10 minutes', 2)) d), array['11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777'], 'the cursor and limit apply');
select is((select d -> 'events' #>> '{0,status}' from jsonb_array_elements(public.list_my_drives(null, 10)) d where d ->> 'clientTripId' = '11111111-1111-4111-8111-111111111111'), 'removed', 'events carry their status');
select is((select d ? 'progress_before' from jsonb_array_elements(public.list_my_drives(null, 10)) d limit 1), false, 'progress_before is never sent');
select throws_ok($$ select public.list_my_drives(null, 51) $$, '22023', 'limit must be between 1 and 50', 'the limit is bounded');
select is(public.get_my_stat_sums(now() - interval '20 days') ->> 'drives', '3', 'stat sums since a moment');
select throws_ok($$ select count(*) from public.trips $$, '42501', null, 'trips are not readable directly');
select throws_ok($$ select count(*) from public.trip_events $$, '42501', null, 'nor trip_events');
select throws_ok($$ select count(*) from public.points_ledger $$, '42501', null, 'nor the ledger');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', now(), current_date, null, null) $$, '42501', null, 'the engine is not callable by a client');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(public.list_my_drives(null, 10), '[]'::jsonb, 'B sees none of A''s drives');
reset role;

select * from finish();
rollback;
