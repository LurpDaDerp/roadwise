-- 0003_drives + 0023 + 0032: the drive engine. One happy path, idempotency, every upload its own
-- drive (2 min / 100 m after the last, mergeInto ignored), "Wasn't driving" (any drive, 24 h, 2 a month, its "Not driving?" never ran
-- out, flagging), reports (type match, the 3-a-week quota, a repeat, clean recounted), the
-- envelope's invariants, the rating and the client reads.
create extension if not exists pgtap with schema extensions;

begin;
select plan(66);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- every drive is anchored 6 hours ago so the 24-hour rules are deterministic
create temporary table t as select date_trunc('minute', now()) - interval '6 hours' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
grant select on t to authenticated;
grant execute on function pg_temp.t0() to authenticated;
create function pg_temp.a() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.trip(p_client uuid) returns uuid language sql stable as $$ select id from public.trips where client_trip_id = p_client $$;

-- a drive through apply_drive: events are [{id, type, tier?, status?, measured?}] shorthand. p_extra
-- is merged into the payload (origin, notDrivingExpired, exposure, polyline); p_env into the envelope.
create function pg_temp.drive(p_user uuid, p_client uuid, p_started timestamptz, p_minutes int, p_miles numeric, p_events jsonb,
  p_merge uuid default null, p_extra jsonb default '{}'::jsonb, p_env jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', floor(extract(epoch from p_started + interval '1 minute') * 1000)::bigint, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb), 'status', coalesce(e ->> 'status', 'active'))), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', p_merge,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + make_interval(mins => p_minutes)) * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'nightMiles', 0,
      'durationS', p_minutes * 60, 'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', 'poly', 'appVersion', '3.0.0',
      'origin', 'auto', 'notDrivingExpired', false) || p_extra,
    'scored', true, 'reason', null, 'events', v_ev, 'scoringVersion', 7) || p_env);
end $$;
create function pg_temp.ctx(p_client uuid, p_started timestamptz, p_lat double precision, p_lng double precision) returns jsonb
language sql as $$
  select private.drive_context(pg_temp.a(), p_client, p_started, (p_started at time zone 'America/New_York')::date, p_lat, p_lng, p_started + interval '10 minutes')
$$;

-- ---------------------------------------------------------------------------
-- context + first drive
-- ---------------------------------------------------------------------------
select is(pg_temp.ctx('11111111-1111-4111-8111-111111111111', pg_temp.t0(), 47.6, -122.3),
  '{"version": 23, "phoneUse": true, "existing": null, "merge": null}'::jsonb, 'a fresh context: version 23, phone use stored (0026), nothing stored');

create temporary table r1 as select pg_temp.drive(pg_temp.a(), '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 12,
  '[{"id":"22222222-2222-4222-8222-222222222222","type":"hard_brake"}]', null,
  '{"exposure": {"slowdowns": 18, "speedups": 17, "turns": 11, "limitS": 1200, "movingS": 1650}}') as r;
select is((select array(select jsonb_object_keys(r) order by 1) from r1),
  array['achievements', 'challenges', 'clientTripId', 'eventIds', 'mergedInto', 'rating', 'reason', 'scored', 'tripId'],
  'the answer holds exactly the v4 keys');
select is((select array[r ->> 'scored', r ->> 'mergedInto', r ->> 'reason', r -> 'achievements' #>> '{0}', r -> 'eventIds' #>> '{0}'] from r1),
  array['true', null, null, 'first_drive', '22222222-2222-4222-8222-222222222222'], 'scored, mergedInto null, first_drive unlocked, the event kept');
select is((select r -> 'rating' from r1), (select jsonb_build_object('safetyRating', safety_rating, 'ranked', ranked) from public.progress where user_id = pg_temp.a()),
  'the answer carries the rating as now stored');
select is((select row(miles_90d, ranked)::text from public.progress where user_id = pg_temp.a()), row(12.00, true)::text,
  'progress: the 90-day miles, ranked from 10 mi');
select is((select row(scored, n_events, n_hard_brake, clean, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s, scoring_version)::text
    from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'),
  row(true, 1, 1, false, 'auto', false, 18, 17, 11, 1200, 1650, 7)::text, 'the trip row holds the counts, how it started and its counters');
select is((select count(*)::int from public.weekly_challenges where user_id = pg_temp.a()), 3, 'a scored drive assigns the week''s three goals');
select is((select status from public.trip_events where client_event_id = '22222222-2222-4222-8222-222222222222'), 'active', 'the event row is active');

-- idempotency
select is(pg_temp.ctx('11111111-1111-4111-8111-111111111111', pg_temp.t0(), 47.6, -122.3) -> 'existing', (select r from r1),
  'the context of a stored drive is its stored answer');
select is(pg_temp.drive(pg_temp.a(), '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 12, '[]'), (select r from r1),
  'a replayed apply returns the stored answer and writes nothing');
select is((select count(*)::int from public.trips where user_id = pg_temp.a()), 1, 'one trip row');
select throws_ok($$ select private.apply_drive('{"user":"00000000-0000-0000-0000-000000000001"}') $$, '22023', 'apply_drive needs user, payload, events and scored', 'a malformed envelope is refused');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111112', pg_temp.t0(), current_date, 47.6, null) $$,
  '22023', 'start must be a lat/lng pair on the globe', 'half a start is refused');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000009', '11111111-1111-4111-8111-111111111112', pg_temp.t0(), current_date, null, null) $$,
  'P0002', 'no progress for user', 'an unknown user is refused');

-- ---------------------------------------------------------------------------
-- every upload is its own drive (0032): one starting 2 min after the last one ended, 100 m away,
-- even with an envelope naming mergeInto (the finalize-trip before 0032 sends null; any value is
-- ignored)
-- ---------------------------------------------------------------------------
select is(pg_temp.ctx('33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '32 minutes', 47.6109, -122.31),
  '{"version": 23, "phoneUse": true, "existing": null, "merge": null}'::jsonb, 'a drive 2 min and 100 m after the last one has a fresh context');
create temporary table r2 as select pg_temp.drive(pg_temp.a(), '33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '32 minutes', 10, 3,
  '[{"id":"a2a2a2a2-0000-4000-8000-000000000001","type":"hard_accel"}]',
  pg_temp.trip('11111111-1111-4111-8111-111111111111'),
  '{"origin": "manual", "notDrivingExpired": true, "polyline": "poly2", "exposure": {"slowdowns": 5, "speedups": 4, "turns": 3, "limitS": 300, "movingS": 500}}') as r;
select is((select array[r ->> 'mergedInto', r ->> 'tripId', r ->> 'clientTripId'] from r2),
  array[null, pg_temp.trip('33333333-3333-4333-8333-333333333333')::text, '33333333-3333-4333-8333-333333333333'],
  'the answer is the upload''s own drive, mergedInto null');
select is((select row(miles, duration_s, polyline, n_events, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s)::text
    from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'),
  row(12.00, 1800, 'poly', 1, 'auto', false, 18, 17, 11, 1200, 1650)::text, 'the drive before is untouched');
select is((select row(scored, miles, duration_s, polyline, n_events, n_hard_accel, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s)::text
    from public.trips where client_trip_id = '33333333-3333-4333-8333-333333333333'),
  row(true, 3.00, 600, 'poly2', 1, 1, 'manual', true, 5, 4, 3, 300, 500)::text, 'the upload is stored as its own scored drive with its own facts');
select is((select count(*)::int from public.trips where user_id = pg_temp.a()), 2, 'two drives and no other row');

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'wrong_limit') $$,
  '22023', 'that reason does not apply to this event', 'wrong_limit does not apply to a hard brake');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000002', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard') $$,
  'P0002', 'trip not found', 'B cannot report A''s drive: it is not found');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'mounted') $$,
  '22023', 'that reason does not apply to this event', '"My phone was mounted" is for a phone pickup only (0026)');
create temporary table d1 as select private.dispute_event(pg_temp.a(), '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard') as d;
select is((select d - 'rating' from d1),
  jsonb_build_object('tripId', pg_temp.trip('11111111-1111-4111-8111-111111111111'), 'eventId', '22222222-2222-4222-8222-222222222222',
    'status', 'accepted', 'rejectReason', null, 'quotaLeft', 2, 'clean', true), 'a hazard on a hard brake is accepted (the drive is clean again)');
select is((select status from public.trip_events where client_event_id = '22222222-2222-4222-8222-222222222222'), 'removed', 'the event is removed');
select is((select row(n_events, n_hard_brake, clean)::text from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'), row(0, 0, true)::text, 'the counts are recounted');
select is(private.dispute_event(pg_temp.a(), '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'hazard'), (select d from d1),
  'a repeat (the first answer was lost) answers the stored outcome');
select is((select count(*)::int from public.event_disputes where user_id = pg_temp.a()), 1, 'and writes nothing');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'wrong_limit') $$,
  '42501', 'already disputed', 'the same event for another reason is refused');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', 'f0f0f0f0-0000-4000-8000-000000000001', 'hazard') $$,
  'P0002', 'event not found', 'an unknown event is not found');

-- quota: 3 accepted hazard / wrong_limit per week, a wrong-limit report logged as map data
select pg_temp.drive(pg_temp.a(), '44444444-4444-4444-8444-444444444444', pg_temp.t0() + interval '60 minutes', 10, 4,
  '[{"id":"a1a1a1a1-0000-4000-8000-000000000001","type":"speeding","measured":{"limitMph":25,"speedMph":35}},{"id":"a1a1a1a1-0000-4000-8000-000000000002","type":"hard_brake"},{"id":"a1a1a1a1-0000-4000-8000-000000000003","type":"hard_brake"}]');
select is((private.dispute_event(pg_temp.a(), '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000001', 'wrong_limit')) ->> 'quotaLeft', '1',
  'second of the week: one left');
select is((select row(lat, lng, limit_mph, speed_mph)::text from public.map_feedback), row(47.6, -122.3, 25, 35)::text, 'a wrong-limit report is logged to map_feedback without a user');
select is((private.dispute_event(pg_temp.a(), '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000002', 'hazard')) ->> 'quotaLeft', '0', 'third of the week: none left');
create temporary table d4 as select private.dispute_event(pg_temp.a(), '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000003', 'hazard') as d;
select is((select array[d ->> 'status', d ->> 'rejectReason', d ->> 'quotaLeft', d ->> 'clean'] from d4), array['rejected', 'quota', '0', 'false'], 'the fourth is rejected for the quota');
select is((select status from public.trip_events where client_event_id = 'a1a1a1a1-0000-4000-8000-000000000003'), 'active', 'a rejected report leaves the event active');
select is(private.dispute_event(pg_temp.a(), '44444444-4444-4444-8444-444444444444', 'a1a1a1a1-0000-4000-8000-000000000003', 'hazard'), (select d from d4), 'and its repeat answers the same');

-- ---------------------------------------------------------------------------
-- "Wasn't driving"
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333') $$,
  '42501', 'the not driving option expired', 'a drive whose "Not driving?" ran out cannot be marked');
-- an older drive (not the latest) within 24 h
create temporary table nd as select private.mark_not_driving(pg_temp.a(), '44444444-4444-4444-8444-444444444444') as n;
select is((select n - 'rating' from nd), jsonb_build_object('tripId', pg_temp.trip('44444444-4444-4444-8444-444444444444'), 'clientTripId', '44444444-4444-4444-8444-444444444444', 'notDrivingLeft', 1),
  'any drive within 24 h may be marked: one use left this month');
select is((select n -> 'rating' from nd), (select jsonb_build_object('safetyRating', safety_rating, 'ranked', ranked) from public.progress where user_id = pg_temp.a()), 'with the rating refreshed');
select is((select row(not_driving, not_driving_at = now())::text from public.trips where client_trip_id = '44444444-4444-4444-8444-444444444444'), row(true, true)::text, 'the trip is marked');
select is(private.mark_not_driving(pg_temp.a(), '44444444-4444-4444-8444-444444444444'), (select n from nd), 'a repeat answers the same document');
select is((select count(*)::int from public.trips where user_id = pg_temp.a() and not_driving), 1, 'and marks nothing more');
select is((select miles_90d from public.progress where user_id = pg_temp.a()), 15.00, 'the marked drive leaves the window''s miles');
-- 24 hours
select pg_temp.drive(pg_temp.a(), '55555555-5555-4555-8555-555555555555', now() - interval '25 hours', 10, 2, '[]');
select throws_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '55555555-5555-4555-8555-555555555555') $$,
  '42501', 'the drive is older than 24 hours', 'a drive that ended more than 24 hours ago cannot be marked');
-- 2 a month
select pg_temp.drive(pg_temp.a(), '66666666-6666-4666-8666-666666666666', pg_temp.t0() + interval '120 minutes', 10, 2, '[{"id":"b6b6b6b6-0000-4000-8000-000000000001","type":"hard_brake"}]');
select pg_temp.drive(pg_temp.a(), '77777777-7777-4777-8777-777777777777', pg_temp.t0() + interval '180 minutes', 10, 2, '[]');
select lives_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666') $$, 'the second use this month');
select throws_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '77777777-7777-4777-8777-777777777777') $$,
  '42501', 'no uses left this month', 'the third in a month is refused');
select is((select flagged from public.profiles where id = pg_temp.a()), false, 'not flagged: the two uses this month are not three');
-- flagging: 3 of the last 4 uses on drives with events
update public.trips set not_driving_at = now() - interval '40 days' where user_id = pg_temp.a() and not_driving;
select lives_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '77777777-7777-4777-8777-777777777777') $$, 'a use in a new month');
select is((select flagged from public.profiles where id = pg_temp.a()), false, 'two of three uses had events: not flagged');
select pg_temp.drive(pg_temp.a(), '88888888-8888-4888-8888-888888888888', pg_temp.t0() + interval '240 minutes', 10, 2, '[{"id":"b8b8b8b8-0000-4000-8000-000000000001","type":"hard_accel"}]');
update public.trips set not_driving_at = now() - interval '40 days' where user_id = pg_temp.a() and not_driving;
select lives_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', '88888888-8888-4888-8888-888888888888') $$, 'another use');
select is((select flagged from public.profiles where id = pg_temp.a()), true, 'three of the last four uses were on drives with events: flagged');

-- ---------------------------------------------------------------------------
-- envelope invariants: a fresh event is stored active whatever it says; bounds are fixed 22023s
-- ---------------------------------------------------------------------------
select pg_temp.drive(pg_temp.a(), '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a', pg_temp.t0() + interval '300 minutes', 10, 2,
  '[{"id":"c1c1c1c1-0000-4000-8000-000000000001","type":"hard_brake","status":"removed"}]');
select is((select row(status, (select clean from public.trips where client_trip_id = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a'))::text from public.trip_events where client_event_id = 'c1c1c1c1-0000-4000-8000-000000000001'),
  row('active', false)::text, 'a fresh event is stored active and counted, whatever the envelope said');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '320 minutes', 10, 2,
    '[{"id":"c2c2c2c2-0000-4000-8000-000000000001","type":"phone_handling","tier":"severe"}]') $$,
  '22023', 'event needs id, type, tier, startedAt and durationS', 'a phone handling event is refused (phone use is pickups only, 0026)');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '320 minutes', 10, 2, '[]', null, '{"origin": "bus"}') $$,
  '22023', 'origin must be auto or manual and notDrivingExpired a boolean', 'an unknown origin is refused');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '320 minutes', 10, 2, '[]', null, '{"notDrivingExpired": "yes"}') $$,
  '22023', 'origin must be auto or manual and notDrivingExpired a boolean', 'a non-boolean ran-out flag is refused');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '320 minutes', 10, 2, '[]', null, '{"tz": "Mars/Olympus"}') $$,
  '22023', 'payload needs clientTripId, a known tz, localDay and a valid reason', 'an unknown zone is refused');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000001', '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', pg_temp.t0() + interval '320 minutes', 10, 2, '[]', null, '{"exposure": {"slowdowns": -1, "speedups": 0, "turns": 0, "limitS": 0, "movingS": 0}}') $$,
  '22023', 'exposure counters are out of range', 'a negative counter is refused');

-- ---------------------------------------------------------------------------
-- rating, stats and the client reads
-- ---------------------------------------------------------------------------
update public.progress set rating_updated_at = now() - interval '21 hours' where user_id = pg_temp.a();
select is(private.refresh_ratings_daily(), 1, 'the daily refresh picks the user whose rating is 20 h old');
select is(private.stat_sums(pg_temp.a(), null) - 'durationS' - 'nightMiles', '{"miles": 19.00, "drives": 4, "speeding": 0, "hardAccel": 1, "hardBrake": 1, "hardCorner": 0, "cleanDrives": 2, "dashcamDrives": 0, "dashcamEvents": 0}'::jsonb,
  'stat sums over the kept scored drives (the marked ones left out), with no phone counts');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select jsonb_array_length(public.list_my_drives(null, 20))), 8, 'A lists the eight drives');
select is((select array(select jsonb_object_keys(d) order by 1) from jsonb_array_elements(public.list_my_drives(null, 1)) d),
  array['archived', 'clean', 'clientTripId', 'dashcamCoveredS', 'dashcamMovingS', 'dashcamOn', 'durationS', 'endedAt', 'events', 'exposure', 'localDay', 'miles', 'nDashcam',
        'nightMiles', 'notDriving', 'notDrivingExpired', 'origin', 'pointsNet', 'polyline', 'reason', 'result', 'safeMiles', 'scored', 'startedAt', 'tripId', 'tz'],
  'each drive carries its facts, origin, ran-out flag, counters and whether it is archived (pointsNet and safeMiles are LEGACY literals)');
select is((select array[d -> 'exposure', d -> 'pointsNet', d -> 'safeMiles', d -> 'origin'] from jsonb_array_elements(public.list_my_drives(null, 20)) d where d ->> 'clientTripId' = '11111111-1111-4111-8111-111111111111'),
  array['{"turns": 11, "limitS": 1200, "phoneS": 0, "movingS": 1650, "speedups": 17, "slowdowns": 18}'::jsonb, 'null'::jsonb, '0'::jsonb, '"auto"'::jsonb], 'the drive''s counters (no phone seconds: it sent none); the LEGACY keys at their literals');
select is((select d -> 'events' #>> '{0,status}' from jsonb_array_elements(public.list_my_drives(null, 20)) d where d ->> 'clientTripId' = '11111111-1111-4111-8111-111111111111'), 'removed', 'events carry their status');
select throws_ok($$ select public.list_my_drives(null, 51) $$, '22023', 'limit must be between 1 and 50', 'the limit is bounded');
select throws_ok($$ select count(*) from public.trips $$, '42501', null, 'trips are not readable directly');
select throws_ok($$ select private.drive_context('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', now(), current_date, null, null) $$, '42501', null, 'the engine is not callable by a client');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(public.list_my_drives(null, 10), '[]'::jsonb, 'B sees none of A''s drives');
reset role;

select * from finish();
rollback;
