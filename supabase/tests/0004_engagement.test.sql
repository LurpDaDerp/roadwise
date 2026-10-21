-- 0004_engagement + 0023: the three weekly goals (assignment for a new driver and by the weakest
-- stat, completion that rewards nothing, a goal unchecked when its drives no longer reach it), the
-- three achievements.
create extension if not exists pgtap with schema extensions;

begin;
select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- a kept scored trip written directly (history for the weakest-stat pick)
create function pg_temp.trip(p_user uuid, p_started timestamptz, p_miles numeric, p_speeding int, p_brake int) returns uuid
language sql as $$
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, n_speeding, n_hard_brake, clean, slowdowns, speedups, turns, limit_s, moving_s)
    values (p_user, gen_random_uuid(), p_started, p_started + interval '20 minutes', (p_started at time zone 'America/New_York')::date, private.league_week(p_started),
      'America/New_York', p_miles, 0, 1200, true, p_speeding + p_brake, p_speeding, p_brake, p_speeding + p_brake = 0, 10, 10, 5, 600, 1000)
    returning id
$$;

-- a scored drive through the engine (so the goals are synced)
create function pg_temp.drive(p_user uuid, p_client uuid, p_started timestamptz, p_miles numeric, p_events jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', 'minor', 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint, 'durationS', 2)), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  return private.apply_drive(jsonb_build_object('user', p_user,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + interval '20 minutes') * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'nightMiles', 0, 'durationS', 1200,
      'end', null, 'polyline', '', 'appVersion', '3.0.0', 'origin', 'manual', 'notDrivingExpired', false),
    'scored', true, 'reason', null, 'events', v_ev, 'scoringVersion', 7));
end $$;

select is((select array_agg(id || ': ' || title || ' / ' || description || ' / ' || target order by sort_order) from public.challenge_templates),
  array['no_speeding: Easy does it / 4 drives with no speeding / 4', 'smooth: Smooth operator / 4 drives with no hard stops, starts or turns / 4', 'clean: Clean sweep / 3 drives with no events / 3'],
  'three goals are left, worded as the app shows them');

-- ---------------------------------------------------------------------------
-- assignment
-- ---------------------------------------------------------------------------
select private.ensure_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()));
select is((select array_agg(template_id order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'), array['no_speeding', 'smooth', 'clean'],
  'a driver with no history gets all three in template order');
select private.ensure_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()));
select is((select count(*)::int from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'), 3, 'assignment happens once per week');
select private.ensure_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now() - interval '14 days'));
select is((select count(*)::int from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001' and league_week = private.league_week(now() - interval '14 days')), 0,
  'a week that has ended gets no goals');

-- B: 100 miles in the last 30 days with heavy speeding and one hard brake
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '10 days', 50, 6, 0);
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '9 days', 50, 6, 1);
select private.ensure_challenges('00000000-0000-0000-0000-000000000002', private.league_week(now()));
select is((select array_agg(template_id order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000002'), array['no_speeding', 'clean', 'smooth'],
  'weakest first: speeding (12 per 100 mi), then clean (0 % clean drives), then smooth (1 per 100 mi)');
select is(private.challenges_json('00000000-0000-0000-0000-000000000002', private.league_week(now())) -> 0,
  '{"id": "no_speeding", "slot": 1, "title": "Easy does it", "target": 4, "progress": 0, "completed": false, "description": "4 drives with no speeding"}'::jsonb,
  'challenges_json carries the goal and its progress');

-- ---------------------------------------------------------------------------
-- completion: A drives three clean drives this week; nothing is rewarded
-- ---------------------------------------------------------------------------
create temporary table w as select private.week_start(now()) as w0;
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000001', (select w0 from w) + interval '1 hour', 3, '[]');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000002', (select w0 from w) + interval '2 hours', 3, '[]');
select is((select (private.challenges_json('00000000-0000-0000-0000-000000000001', private.league_week(now())) -> 2) - 'description' - 'title'),
  '{"id": "clean", "slot": 3, "target": 3, "progress": 2, "completed": false}'::jsonb, 'two of three after two clean drives');
create temporary table r3 as select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000003', (select w0 from w) + interval '3 hours', 3, '[]') as r;
select is((select r -> 'challenges' from r3), '[{"id": "clean", "title": "Clean sweep"}]'::jsonb, 'the third clean drive completes the clean goal');
select is((select completed_by_trip = (r ->> 'tripId')::uuid from public.weekly_challenges, r3 where user_id = '00000000-0000-0000-0000-000000000001' and template_id = 'clean'), true,
  'the completing drive is recorded');
select hasnt_table('public', 'points_ledger', 'there is no ledger to pay into');
select is((select array(select jsonb_object_keys(to_jsonb(g)) order by 1) from public.progress g where user_id = '00000000-0000-0000-0000-000000000001'),
  array['created_at', 'last_end_at', 'last_end_lat', 'last_end_lng', 'miles_90d', 'ranked', 'rating_updated_at', 'rating_week_ago', 'safety_rating', 'updated_at', 'user_id'],
  'progress holds the rating (and the rating a week before) and the last end, nothing a goal could pay into');
select is(private.sync_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()), null), '[]'::jsonb, 'a second sync completes nothing again');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000004', (select w0 from w) + interval '4 hours', 3, '[]');
select is((select array_agg(template_id order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001' and completed_at is not null),
  array['no_speeding', 'smooth', 'clean'], 'four clean drives reach all three goals');

-- one of them no longer counts (as "Wasn't driving" leaves it): the 4-drive goals are unchecked, the clean one stays (3 left)
update public.trips set not_driving = true, not_driving_at = now() where client_trip_id = 'a0000000-0000-4000-8000-000000000004';
select private.sync_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()), null);
select is((select array_agg(template_id || '=' || (completed_at is not null) order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'),
  array['no_speeding=false', 'smooth=false', 'clean=true'], 'a goal its drives no longer reach is unchecked');
select is((select completed_by_trip from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001' and template_id = 'smooth'), null, 'and forgets its drive');
-- a week that has ended is left as it was
select is(private.sync_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now() - interval '14 days'), null), '[]'::jsonb, 'a closed week is not synced');

-- ---------------------------------------------------------------------------
-- achievements
-- ---------------------------------------------------------------------------
select is((select array_agg(achievement_id order by achievement_id) from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), array['first_drive', 'perfect_week'],
  'first_drive and perfect_week (3 or more drives this week, all clean) are unlocked');
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '[]'::jsonb, 'nothing new on a re-check');
select pg_temp.trip('00000000-0000-0000-0000-000000000001', now() - interval '20 days', 95, 0, 0);
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '["clean_100"]'::jsonb, '100 clean miles unlock clean_100');
select is((select count(*)::int from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), 3, 'all three, each once');
select is(private.check_achievements('00000000-0000-0000-0000-000000000002', private.league_week(now())), '["first_drive"]'::jsonb, 'B has scored drives: first_drive only (speeding drives are not clean)');
select throws_ok($$ insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000002', 'streak_10') $$,
  '23514', null, 'streak_10 is no achievement any more');

-- client posture
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from public.user_achievements), 3, 'the owner reads their achievements');
select throws_ok($$ select count(*) from public.weekly_challenges $$, '42501', null, 'goals are read through the summary only');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'B cannot see A''s achievements');
reset role;

select * from finish();
rollback;
