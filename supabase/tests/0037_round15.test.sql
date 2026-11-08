-- 0037_round15: a drive's weather. public.trips.weather holds one of four words or none (the CHECK
-- refuses anything else); apply_drive stores the upload's payload.weather, stores none when the
-- upload sent none, and ignores (stores none for) a value it does not know rather than refuse the drive.
-- Badges: Clean 500 and Clean 1,000 at 500 and 1,000 clean miles (miles on drives with an event or
-- marked "Wasn't driving" don't count); Rain or Shine for one clean drive in rain, snow or ice (not
-- clear, not unknown); the CHECK takes exactly the 13 ids.
create extension if not exists pgtap with schema extensions;

begin;
select plan(23);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';

-- a 20-minute drive through apply_drive, started p_start; p_payload is merged into the payload
create function pg_temp.drive(p_client uuid, p_start timestamptz, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ms bigint := floor(extract(epoch from p_start) * 1000)::bigint;
begin
  return private.apply_drive(jsonb_build_object(
    'user', '00000000-0000-0000-0000-000000000001', 'dashcam', null,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', v_ms, 'endedAt', v_ms + 1200000, 'tz', 'America/Los_Angeles',
      'localDay', to_char(p_start at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'miles', 8, 'nightMiles', 0, 'durationS', 1200,
      'polyline', '', 'appVersion', '4.0.0', 'origin', 'auto', 'notDrivingExpired', false) || p_payload,
    'scored', true, 'reason', null, 'events', '[]'::jsonb, 'scoringVersion', 12));
end $$;
create function pg_temp.weather(p_client uuid) returns text language sql stable as $$
  select weather from public.trips where client_trip_id = p_client $$;
create temporary table t as select date_trunc('second', now()) - interval '1 day' as t0;

-- ---------------------------------------------------------------------------
-- the column
-- ---------------------------------------------------------------------------
select has_column('public', 'trips', 'weather', 'a drive can hold its weather');
select col_is_null('public', 'trips', 'weather', 'nullable: a drive with no reading, and every drive stored before, has none');
select is((select count(*)::int from public.trips where weather is not null), 0, 'no drive is given a weather by the migration');

-- ---------------------------------------------------------------------------
-- apply_drive
-- ---------------------------------------------------------------------------
select pg_temp.drive('a0000000-0000-4000-8000-000000000001', (select t0 from t), '{"weather": "rain"}');
select pg_temp.drive('a0000000-0000-4000-8000-000000000002', (select t0 from t) + interval '1 hour', '{"weather": "ice"}');
select is(array[pg_temp.weather('a0000000-0000-4000-8000-000000000001'), pg_temp.weather('a0000000-0000-4000-8000-000000000002')],
  array['rain', 'ice'], 'the upload weather is stored');

select pg_temp.drive('a0000000-0000-4000-8000-000000000003', (select t0 from t) + interval '2 hours');
select is(pg_temp.weather('a0000000-0000-4000-8000-000000000003'), null, 'an upload with no weather (an older build, or no reading) stores none');

select lives_ok($$ select pg_temp.drive('a0000000-0000-4000-8000-000000000004', (select t0 from t) + interval '3 hours', '{"weather": "fog"}') $$,
  'a weather word apply_drive does not know never refuses the drive');
select pg_temp.drive('a0000000-0000-4000-8000-000000000005', (select t0 from t) + interval '4 hours', '{"weather": 3}');
select is(array[pg_temp.weather('a0000000-0000-4000-8000-000000000004'), pg_temp.weather('a0000000-0000-4000-8000-000000000005')],
  array[null, null]::text[], 'an unknown word or a non-string is stored as none');

-- ---------------------------------------------------------------------------
-- the CHECK
-- ---------------------------------------------------------------------------
select lives_ok($$ update public.trips set weather = 'snow' where client_trip_id = 'a0000000-0000-4000-8000-000000000003' $$, 'snow is a weather word');
select throws_ok($$ update public.trips set weather = 'Rain' where client_trip_id = 'a0000000-0000-4000-8000-000000000003' $$, '23514', null,
  'any other word is refused');

-- ---------------------------------------------------------------------------
-- badges: Clean 500, Clean 1,000, Rain or Shine
-- ---------------------------------------------------------------------------
-- ava's drives above went through apply_drive: the clean one in rain unlocked Rain or Shine there
select ok(exists (select 1 from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001' and achievement_id = 'rain_or_shine'),
  'a clean drive uploaded in rain unlocks Rain or Shine through apply_drive');

-- bo (2) builds clean miles; cy (3) and dee (4) drive in the weather; fay (5) does it all at once;
-- eve (6) is for the CHECK
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com'),
  ('00000000-0000-0000-0000-000000000005', 'f@example.com'),
  ('00000000-0000-0000-0000-000000000006', 'e@example.com');

-- a scored drive yesterday, inserted directly: clean (no events) or with one hard brake; with a
-- weather or none; "Wasn't driving" when told. Each starts 30 minutes after the driver's last,
-- unless given p_start.
create function pg_temp.trip(p_user int, p_miles numeric, p_clean boolean, p_weather text default null, p_not_driving boolean default false,
    p_start timestamptz default null) returns void
language plpgsql as $$
declare
  v_user uuid := ('00000000-0000-0000-0000-00000000000' || p_user)::uuid;
  v_start timestamptz := coalesce(p_start,
    now() - interval '1 day' + make_interval(mins => 30 * (select count(*) from public.trips t where t.user_id = v_user)::int));
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, n_hard_brake, clean, slowdowns, speedups, turns, limit_s, moving_s, scoring_version, weather, not_driving, not_driving_at)
    values (v_user, gen_random_uuid(), v_start, v_start + interval '20 minutes', (v_start at time zone 'America/New_York')::date,
      private.league_week(v_start), 'America/New_York', p_miles, 0, 1200, true, (not p_clean)::int, (not p_clean)::int, p_clean, 10, 10, 5, 600, 1000, 12,
      p_weather, p_not_driving, case when p_not_driving then now() end);
end $$;
create function pg_temp.unlock(p_user int) returns jsonb language sql as $$
  select private.check_achievements(('00000000-0000-0000-0000-00000000000' || p_user)::uuid, private.league_week(now()))
$$;

select is((select array[p.prosecdef, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')]
    from pg_proc p where p.oid = 'private.check_achievements(uuid, text)'::regprocedure),
  array[false, false, false], 'check_achievements still runs as its caller and is closed to the API roles');

-- clean miles
select pg_temp.trip(2, 300, true);
select pg_temp.trip(2, 199.5, true);
select is(pg_temp.unlock(2), '["first_drive", "clean_100"]'::jsonb, '499.5 clean miles: Clean 100, not yet Clean 500');
-- the drive with an event starts at this league week's Monday 00:00, so bo never has a Perfect Week
-- whatever day the test runs
select pg_temp.trip(2, 600, false, p_start => private.week_start(now()));
select pg_temp.trip(2, 600, true, null, true);
select is(pg_temp.unlock(2), '[]'::jsonb, 'miles on a drive with an event, or on one marked "Wasn''t driving", are not clean miles');
select pg_temp.trip(2, 0.5, true);
select is(pg_temp.unlock(2), '["clean_500"]'::jsonb, '500 clean miles unlock Clean 500');
select pg_temp.trip(2, 499.99, true);
select is(pg_temp.unlock(2), '[]'::jsonb, '999.99 clean miles: not yet Clean 1,000');
select pg_temp.trip(2, 0.01, true);
select is(pg_temp.unlock(2), '["clean_1000"]'::jsonb, '1,000 clean miles unlock Clean 1,000');
select is((select count(*)::int from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000002'), 4, 'each unlocked once');

-- the weather
select pg_temp.trip(3, 10, true, 'clear');
select pg_temp.trip(3, 10, true);
select pg_temp.trip(3, 10, false, 'rain');
select pg_temp.trip(3, 10, true, 'rain', true);
select is(pg_temp.unlock(3), '["first_drive"]'::jsonb,
  'no Rain or Shine for a clear drive, a drive with no weather, a rain drive with an event, or a clean rain drive marked "Wasn''t driving"');
select pg_temp.trip(3, 10, true, 'snow');
select is(pg_temp.unlock(3), '["rain_or_shine"]'::jsonb, 'a clean drive in snow unlocks Rain or Shine');
select pg_temp.trip(4, 10, true, 'ice');
select is(pg_temp.unlock(4), '["first_drive", "rain_or_shine"]'::jsonb, 'so does a clean drive on ice');

-- several at once, in the app's order
select pg_temp.trip(5, 500, true, 'rain');
select pg_temp.trip(5, 500, true);
select is(pg_temp.unlock(5), '["first_drive", "clean_100", "clean_500", "clean_1000", "rain_or_shine"]'::jsonb,
  'badges reached together unlock together, in the app''s order');

-- the CHECK
select throws_ok($$ insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000006', 'clean_250') $$,
  '23514', null, 'an unknown id is refused');
select lives_ok($$ insert into public.user_achievements (user_id, achievement_id)
    select '00000000-0000-0000-0000-000000000006', a from unnest(array['first_drive', 'clean_100', 'clean_500', 'clean_1000', 'perfect_week',
      'rain_or_shine', 'better_speed', 'better_braking', 'better_acceleration', 'better_turning', 'better_phone', 'better_attention', 'spot_cleared']) a $$,
  'every one of the 13 ids is taken');

select * from finish();
rollback;
