-- 0034_passenger_rides: the rides table's posture, the in-drive claim (idempotent, its day bounded),
-- the notification's mark (an automatic drive, its "Not driving?" never run out, within 35 minutes
-- of the later of its end and its upload; no monthly mark used), "Wasn't driving" recording a ride
-- through the trigger, and the month's count for the rider and their friends only.
create extension if not exists pgtap with schema extensions;

begin;
select plan(37);

-- ava (1) rides; fay (2) is her friend; sam (3) is a stranger
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'f@example.com'),
  ('00000000-0000-0000-0000-000000000003', 's@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'fay', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'sam', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000003';
insert into public.friendships (user_a, user_b) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');

create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/New_York')::date $$;
grant execute on function pg_temp.today() to authenticated;
-- one of ava's drives: how it started, whether its "Not driving?" ran out, when it ended and when it first reached the server
create function pg_temp.trip(p_id uuid, p_origin text, p_expired boolean, p_ended interval, p_uploaded interval) returns void language sql as $$
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, polyline, clean,
      n_events, n_hard_brake, slowdowns, speedups, turns, limit_s, moving_s, origin, not_driving_expired, created_at)
    values ('00000000-0000-0000-0000-000000000001', p_id, now() - p_ended - interval '20 minutes', now() - p_ended, pg_temp.today(),
      private.league_week(now() - p_ended), 'America/New_York', 8, 0, 1200, true, 'poly', true, 0, 0, 12, 11, 7, 600, 1100, p_origin, p_expired, now() - p_uploaded)
$$;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;

select pg_temp.trip('a0000000-0000-4000-8000-000000000001', 'auto', false, interval '10 minutes', interval '9 minutes');   -- just ended
select pg_temp.trip('a0000000-0000-4000-8000-000000000002', 'auto', false, interval '2 hours', interval '2 hours');        -- too late
select pg_temp.trip('a0000000-0000-4000-8000-000000000003', 'auto', false, interval '3 hours', interval '1 minute');       -- uploaded late
select pg_temp.trip('a0000000-0000-4000-8000-000000000004', 'manual', false, interval '10 minutes', interval '9 minutes'); -- a Start drive
select pg_temp.trip('a0000000-0000-4000-8000-000000000005', 'auto', true, interval '10 minutes', interval '9 minutes');    -- "Not driving?" ran out
select pg_temp.trip('a0000000-0000-4000-8000-000000000006', 'manual', false, interval '1 hour', interval '1 hour');        -- three for "Wasn't driving"
select pg_temp.trip('a0000000-0000-4000-8000-000000000007', 'manual', false, interval '1 hour', interval '1 hour');
select pg_temp.trip('a0000000-0000-4000-8000-000000000008', 'manual', false, interval '1 hour', interval '1 hour');
select private.refresh_rating('00000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select has_table('private', 'passenger_rides', 'the rides live in private');
select columns_are('private', 'passenger_rides', array['user_id', 'client_trip_id', 'local_day', 'kind'], 'a ride holds its day and its kind: no time, no route');
select col_is_pk('private', 'passenger_rides', array['user_id', 'client_trip_id'], 'keyed by the rider and the trip id');
select ok((select relrowsecurity from pg_class where oid = 'private.passenger_rides'::regclass), 'RLS is on');
select table_privs_are('private', 'passenger_rides', 'authenticated', '{}'::text[], 'no table privilege for authenticated');
select table_privs_are('private', 'passenger_rides', 'anon', '{}'::text[], 'nor for anon');
select has_trigger('public', 'trips', 'trips_marked_passenger', 'a trip marked not driving records its ride');
select is(array[
    has_function_privilege('authenticated', 'public.record_passenger_ride(uuid, date)', 'execute'),
    has_function_privilege('authenticated', 'public.mark_passenger_ride(uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.get_passenger_rides(uuid)', 'execute'),
    has_function_privilege('anon', 'public.record_passenger_ride(uuid, date)', 'execute'),
    has_function_privilege('anon', 'public.mark_passenger_ride(uuid)', 'execute'),
    has_function_privilege('anon', 'public.get_passenger_rides(uuid)', 'execute')],
  array[true, true, true, false, false, false], 'the three RPCs: authenticated only');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and p.proname in ('trip_marked_passenger', 'record_passenger_ride', 'mark_passenger_ride', 'passenger_rides_this_month', 'not_driving_left')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no API role runs the private halves');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and p.proname in ('trip_marked_passenger', 'record_passenger_ride', 'mark_passenger_ride', 'get_passenger_rides')
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0,
  'the definers are owned by postgres and pin search_path=public');

-- ---------------------------------------------------------------------------
-- the in-drive claim
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
select is(public.record_passenger_ride('b0000000-0000-4000-8000-000000000001', pg_temp.today()),
  jsonb_build_object('clientTripId', 'b0000000-0000-4000-8000-000000000001', 'localDay', to_char(pg_temp.today(), 'YYYY-MM-DD')), 'an in-drive claim is recorded');
select is(public.record_passenger_ride('b0000000-0000-4000-8000-000000000001', pg_temp.today() - 1),
  jsonb_build_object('clientTripId', 'b0000000-0000-4000-8000-000000000001', 'localDay', to_char(pg_temp.today(), 'YYYY-MM-DD')), 'a repeat answers the ride as first stored');
select throws_ok($$ select public.record_passenger_ride('b0000000-0000-4000-8000-000000000002', (now() at time zone 'UTC')::date - 61) $$,
  '22023', 'invalid local day', 'a day more than 60 days back is refused');
select throws_ok($$ select public.record_passenger_ride('b0000000-0000-4000-8000-000000000002', (now() at time zone 'UTC')::date + 2) $$,
  '22023', 'invalid local day', 'and a day still to come');
select throws_ok($$ select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000009') $$, 'P0002', 'trip not found', 'the mark needs the trip on the server');
reset role;
select is((select array_agg(kind || '@' || local_day::text) from private.passenger_rides), array['in_drive@' || pg_temp.today()::text], 'one ride, in-drive, on its day');

-- ---------------------------------------------------------------------------
-- the notification's mark
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
create temporary table m1 as select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000001') as m;
select is(public.mark_passenger_ride('a0000000-0000-4000-8000-000000000001'), (select m from m1), 'a repeat answers the same document');
select throws_ok($$ select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000002') $$, '42501', 'the passenger mark came too late',
  'not 2 hours after the drive reached the server');
select lives_ok($$ select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000003') $$, 'a drive uploaded late takes the mark sent right behind it');
select throws_ok($$ select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000004') $$, '42501', 'not an automatic drive', 'a Start drive has no notification mark');
select throws_ok($$ select public.mark_passenger_ride('a0000000-0000-4000-8000-000000000005') $$, '42501', 'the not driving option expired',
  'nor a drive whose "Not driving?" ran out');
reset role;
select is((select m - 'rating' from m1),
  jsonb_build_object('tripId', (select id from public.trips where client_trip_id = 'a0000000-0000-4000-8000-000000000001'), 'clientTripId', 'a0000000-0000-4000-8000-000000000001', 'notDrivingLeft', 2),
  'an automatic drive that just ended is marked, and both "Wasn''t driving" marks are left');
select is((select row(not_driving, not_driving_at = now())::text from public.trips where client_trip_id = 'a0000000-0000-4000-8000-000000000001'), row(true, true)::text, 'the trip is marked not driving');
select is((select kind from private.passenger_rides where client_trip_id = 'a0000000-0000-4000-8000-000000000001'), 'notification', 'its ride is the notification''s');
select is((select array_agg(not_driving order by client_trip_id) from public.trips where client_trip_id in
    ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000005')), array[false, false, false],
  'the refused drives still count');
select is((select miles_90d from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), 48.00, 'the marked drives leave the window''s miles');

-- ---------------------------------------------------------------------------
-- "Wasn't driving": a ride through the trigger, the two marks a month the notification never uses
-- ---------------------------------------------------------------------------
select is(private.mark_not_driving('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000006') ->> 'notDrivingLeft', '1',
  'the first "Wasn''t driving" this month leaves one');
select is((select kind || '@' || local_day::text from private.passenger_rides where client_trip_id = 'a0000000-0000-4000-8000-000000000006'), 'after@' || pg_temp.today()::text,
  'and records its ride');
select lives_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000007') $$, 'the second');
select throws_ok($$ select private.mark_not_driving('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000008') $$,
  '42501', 'no uses left this month', 'the third is refused: four drives marked this month, two of them from the notification');
select is(private.not_driving_left('00000000-0000-0000-0000-000000000001'), 0, 'none left');

-- ---------------------------------------------------------------------------
-- the month's count
-- ---------------------------------------------------------------------------
-- last month's ride is not this month's
insert into private.passenger_rides (user_id, client_trip_id, local_day, kind)
  values ('00000000-0000-0000-0000-000000000001', 'b0000000-0000-4000-8000-000000000003', date_trunc('month', pg_temp.today())::date - 1, 'in_drive');
set local role authenticated;
select pg_temp.as_user(1);
select is(public.get_passenger_rides(), '{"this_month": 5}'::jsonb, 'the rider sees 5 this month: one in-drive, two from the notification, two "Wasn''t driving"');
select throws_ok($$ select * from private.passenger_rides $$, '42501', null, 'the table itself is out of reach');
select pg_temp.as_user(2);
select is(public.get_passenger_rides('00000000-0000-0000-0000-000000000001'), '{"this_month": 5}'::jsonb, 'a friend sees the same');
select pg_temp.as_user(3);
select throws_ok($$ select public.get_passenger_rides('00000000-0000-0000-0000-000000000001') $$, 'P0002', 'profile not found', 'a stranger sees nothing');
reset role;
insert into public.blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
set local role authenticated;
select pg_temp.as_user(2);
select throws_ok($$ select public.get_passenger_rides('00000000-0000-0000-0000-000000000001') $$, 'P0002', 'profile not found', 'nor a friend across a block');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.get_passenger_rides() $$, '42501', 'get_passenger_rides requires an authenticated user', 'a JWT without sub is refused');
reset role;

select * from finish();
rollback;
