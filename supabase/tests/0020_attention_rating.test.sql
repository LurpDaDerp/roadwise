-- 0020_attention_rating (+ 0023): Attention from DashPal per watched mile (floored at 10), only for
-- a driver DashPal watched, beside the per-opportunity categories; a removed event counts nothing;
-- list_my_drives hands the DashPal seconds back. The values are scoring ratingAt's for the same drive
-- (2 days old, 20 mi, exposure {40, 40, 25, 2400, 3200}, a severe speeding of 30 s at 12 mph over
-- and a minor hard brake; the DashPal events at no measured speed, 3 s long, weigh their base), to
-- the digit (scoring version 9: every second over the line counts).
create extension if not exists pgtap with schema extensions;

begin;
select plan(10);
-- the scores travel in jsonb: read them back exactly (the test runner's session prints 15 digits)
set local extra_float_digits = 1;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
create temporary table t as select date_trunc('second', now()) - interval '2 days' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
create function pg_temp.r() returns jsonb language sql stable as $$
  select private.rating_at('00000000-0000-0000-0000-000000000001', pg_temp.t0() + interval '2 days') $$;
create function pg_temp.trip() returns uuid language sql stable as $$
  select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111' $$;

select private.apply_drive(jsonb_build_object(
  'user', '00000000-0000-0000-0000-000000000001', 'mergeInto', null,
  'payload', jsonb_build_object('clientTripId', '11111111-1111-4111-8111-111111111111', 'startedAt', floor(extract(epoch from pg_temp.t0()) * 1000)::bigint,
    'endedAt', floor(extract(epoch from pg_temp.t0() + interval '60 minutes') * 1000)::bigint, 'tz', 'America/New_York',
    'localDay', to_char(pg_temp.t0() at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', 20, 'nightMiles', 0, 'durationS', 3600,
    'end', null, 'polyline', 'poly', 'appVersion', '3.0.0', 'origin', 'auto', 'notDrivingExpired', false,
    'exposure', jsonb_build_object('slowdowns', 40, 'speedups', 40, 'turns', 25, 'limitS', 2400, 'movingS', 3200)),
  'scored', true, 'reason', null, 'scoringVersion', 7,
  'events', jsonb_build_array(
    jsonb_build_object('id', 'a1a1a1a1-0000-4000-8000-000000000001', 'type', 'speeding', 'tier', 'severe', 'startedAt', floor(extract(epoch from pg_temp.t0() + interval '1 minute') * 1000)::bigint,
      'durationS', 30, 'lat', null, 'lng', null, 'measured', '{"overMphS": 360}'::jsonb),
    jsonb_build_object('id', 'a1a1a1a1-0000-4000-8000-000000000003', 'type', 'hard_brake', 'tier', 'minor', 'startedAt', floor(extract(epoch from pg_temp.t0() + interval '1 minute') * 1000)::bigint,
      'durationS', 2, 'lat', null, 'lng', null, 'measured', '{}'::jsonb))));

select is(pg_temp.r() - 'scores', '{"miles": 20.00, "rating": 85.1, "ranked": true}'::jsonb, 'the phone''s categories alone: 85.1');
select is(array[(pg_temp.r() -> 'scores' ->> 'speed')::float8, (pg_temp.r() -> 'scores' ->> 'braking')::float8], array[84.21415492821761::float8, 78.2358180731074],
  'speed and braking to the digit');

-- an eyes-off look on a drive DashPal never watched counts nothing
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured)
  values (pg_temp.trip(), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '00000000-0000-0000-0000-000000000001', 'eyes_off', 'severe', pg_temp.t0() + interval '5 minutes', 3, '{"source": "dashcam"}');
select is(pg_temp.r() -> 'scores' -> 'attention', 'null'::jsonb, 'no watched miles: Attention has no score');
select is((pg_temp.r() ->> 'rating')::numeric, 85.1, 'and takes nothing');

-- watched all 20 miles: Attention 40 over 20 watched mi joins the mean
update public.trips set dashcam_moving_s = 1000, dashcam_covered_s = 1000 where id = pg_temp.trip();
select is((pg_temp.r() -> 'scores' ->> 'attention')::float8, 88.88888888888889::float8, 'watched: Attention scores 40 over 20 mi');
select is((pg_temp.r() ->> 'rating')::numeric, 85.7, 'and joins the mean');

-- watched 2 of the 20 miles: Attention is over at least 10 watched miles
update public.trips set dashcam_covered_s = 100 where id = pg_temp.trip();
select is((pg_temp.r() -> 'scores' ->> 'attention')::float8, 81.03563542067624::float8, 'a short watched stretch counts as 10 miles');

-- a drowsy event (50) in place of the removed eyes-off
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured)
  values (pg_temp.trip(), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '00000000-0000-0000-0000-000000000001', 'drowsy', 'severe', pg_temp.t0() + interval '9 minutes', 3, '{"source": "dashcam"}');
update public.trip_events set status = 'removed' where client_event_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select is(array[(pg_temp.r() -> 'scores' ->> 'attention')::float8, (pg_temp.r() ->> 'rating')::float8], array[77.36756848238679::float8, 83.8],
  'a removed event counts nothing, a drowsy one 50');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select d ->> 'dashcamMovingS' from jsonb_array_elements(public.list_my_drives(null, 10)) d), '1000', 'list_my_drives hands back the moving seconds');
select is((select d ->> 'dashcamCoveredS' from jsonb_array_elements(public.list_my_drives(null, 10)) d), '100', 'and the covered ones');

select * from finish();
rollback;
