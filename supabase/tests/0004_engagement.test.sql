-- 0004_engagement: challenge assignment (new user, weakest stat), completion rewards and freeze
-- progress, the revert of a completing drive, the five achievements.
create extension if not exists pgtap with schema extensions;

begin;
select plan(28);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- a kept scored trip written directly (history for the weakest-stat pick)
create function pg_temp.trip(p_user uuid, p_started timestamptz, p_miles numeric, p_net int, p_speeding int, p_pickups int, p_brake int) returns uuid
language sql as $$
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s, scored, points_net,
      n_events, n_speeding, n_pickup, n_hard_brake, clean)
    values (p_user, gen_random_uuid(), p_started, p_started + interval '20 minutes', (p_started at time zone 'America/New_York')::date, private.league_week(p_started),
      'America/New_York', p_miles, p_miles, 0, 1200, true, p_net, p_speeding + p_pickups + p_brake, p_speeding, p_pickups, p_brake, p_speeding + p_pickups + p_brake = 0)
    returning id
$$;

-- a scored drive through the engine (so completion runs)
create function pg_temp.drive(p_user uuid, p_started timestamptz, p_miles numeric, p_net int, p_events jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb; v_bd jsonb; v_streak int; v_freezes int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', 'minor', 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint, 'durationS', 2)), '[]'::jsonb) into v_ev from jsonb_array_elements(p_events) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'penalty', 10)), '[]'::jsonb) into v_bd from jsonb_array_elements(p_events) e;
  select streak, freezes into v_streak, v_freezes from public.progress where user_id = p_user;
  return private.apply_drive(jsonb_build_object('user', p_user,
    'payload', jsonb_build_object('clientTripId', gen_random_uuid(), 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + interval '20 minutes') * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'safeMiles', p_miles, 'nightMiles', 0, 'durationS', 1200,
      'dmsOn', false, 'dmsFaceSeen', false, 'end', null, 'polyline', '', 'appVersion', '3.0.0'),
    'scored', true, 'reason', null, 'net', p_net, 'breakdown', jsonb_build_object('net', p_net, 'ratingPenalty', 0, 'events', v_bd), 'events', v_ev,
    'streak', jsonb_build_object('before', jsonb_build_object('streak', v_streak), 'after', jsonb_build_object('streak', v_streak + 1, 'atRisk', false, 'freezes', v_freezes, 'cleanRun', 0), 'outcome', 'grew', 'freezeEarned', false),
    'isLoop', false, 'loopRepeat', false, 'safeMilesEarlierToday', 0, 'scoringVersion', 3));
end $$;

select is((select array_agg(id order by sort_order) from public.challenge_templates), array['no_pickups', 'no_speeding', 'smooth', 'clean', 'positive'], 'the five templates are seeded');

-- ---------------------------------------------------------------------------
-- assignment
-- ---------------------------------------------------------------------------
select private.ensure_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()));
select is((select array_agg(template_id order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'), array['no_pickups', 'no_speeding', 'clean'],
  'a user with no history gets no_pickups, no_speeding, clean');
select private.ensure_challenges('00000000-0000-0000-0000-000000000001', private.league_week(now()));
select is((select count(*)::int from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001'), 3, 'assignment happens once per week');

-- B: 100 miles in the last 30 days with heavy speeding, nothing else
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '10 days', 50, 100, 6, 0, 0);
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '9 days', 50, 100, 6, 0, 1);
select private.ensure_challenges('00000000-0000-0000-0000-000000000002', private.league_week(now()));
select is((select template_id from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000002' and slot = 1), 'no_speeding', 'slot 1 targets the weakest stat (12 speeding per 100 mi)');
select is((select array_agg(template_id order by slot) from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000002'), array['no_speeding', 'clean', 'smooth'],
  'then clean (0% clean drives) and smooth (1 harsh per 100 mi), the next weakest');
select is(private.challenges_json('00000000-0000-0000-0000-000000000002', private.league_week(now())) -> 0, '{"id": "no_speeding", "slot": 1, "title": "Easy does it", "target": 4, "progress": 0, "completed": false, "description": "4 drives with no speeding"}'::jsonb,
  'challenges_json carries the template and derived progress');

-- ---------------------------------------------------------------------------
-- completion: A drives 3 clean drives this week
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000001', private.week_start(now()) + interval '1 hour', 3, 30, '[]');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', private.week_start(now()) + interval '2 hours', 3, 30, '[]');
select is((select (private.challenges_json('00000000-0000-0000-0000-000000000001', private.league_week(now())) -> 2) - 'description' - 'title'), '{"id": "clean", "slot": 3, "target": 3, "progress": 2, "completed": false}'::jsonb, 'two of three after two clean drives');
create temporary table r3 as select pg_temp.drive('00000000-0000-0000-0000-000000000001', private.week_start(now()) + interval '3 hours', 3, 30, '[]') as r;
select is((select r -> 'challenges' from r3), '[{"id": "clean", "title": "Clean sweep"}]'::jsonb, 'the third clean drive completes the clean challenge');
select is((select row(points, lifetime, freeze_progress, freezes)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(190, 190, 1, 2)::text,
  '+100 points and lifetime, freeze progress 1 of 3');
select is((select row(amount, kind, league_week)::text from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'challenge'), row(100, 'challenge', private.league_week(now()))::text,
  'a challenge ledger row keyed to the week');
select is(private.week_points('00000000-0000-0000-0000-000000000001', private.league_week(now())), 190, 'week points include the drives and the reward');
select is((select completed_by_trip = (r ->> 'tripId')::uuid from public.weekly_challenges, r3 where user_id = '00000000-0000-0000-0000-000000000001' and slot = 3), true, 'the completing drive is recorded');

-- the fourth and fifth clean drives complete no_pickups (5) and no_speeding (4) -> a freeze
update public.progress set freezes = 1 where user_id = '00000000-0000-0000-0000-000000000001';
select pg_temp.drive('00000000-0000-0000-0000-000000000001', private.week_start(now()) + interval '4 hours', 3, 30, '[]');
select is((select row(freeze_progress, freezes)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(2, 1)::text, 'no_speeding (4 drives) completes: progress 2');
create temporary table r5 as select pg_temp.drive('00000000-0000-0000-0000-000000000001', private.week_start(now()) + interval '5 hours', 3, 30, '[]') as r;
select is((select r -> 'challenges' from r5), '[{"id": "no_pickups", "title": "Hands off"}]'::jsonb, 'the fifth drive completes no_pickups');
select is((select row(freeze_progress, freezes, points)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(0, 2, 450)::text,
  'the third completed challenge turns progress into a freeze');

-- revert of the completing drive takes the challenge back
select private.revert_trip('00000000-0000-0000-0000-000000000001', (select (r ->> 'tripId')::uuid from r5));
select is((select row(completed_at is null, completed_by_trip)::text from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000001' and template_id = 'no_pickups'), row(true, null)::text,
  'the challenge is open again');
select is((select count(*)::int from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'challenge'), 2, 'its ledger row is gone');
select is((select row(freeze_progress, freezes, points)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(2, 1, 320)::text, 'progress is back to before that drive');

-- ---------------------------------------------------------------------------
-- achievements
-- ---------------------------------------------------------------------------
select is((select array_agg(achievement_id order by achievement_id) from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), array['first_drive', 'perfect_week'],
  'first_drive and perfect_week (3+ clean drives this week) are unlocked');
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '[]'::jsonb, 'nothing new on a re-check');
update public.progress set streak = 10, phone_free_run = 25 where user_id = '00000000-0000-0000-0000-000000000001';
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '["phone_free_25", "streak_10"]'::jsonb, 'streak 10 and 25 phone-free drives unlock their achievements');
select pg_temp.trip('00000000-0000-0000-0000-000000000001', now() - interval '20 days', 90, 900, 0, 0, 0);
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '["clean_100"]'::jsonb, '100 clean miles unlock clean_100');
select is((select count(*)::int from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), 5, 'all five, each once');
select is(private.check_achievements('00000000-0000-0000-0000-000000000002', private.league_week(now())), '["first_drive"]'::jsonb, 'B has a scored drive: first_drive only (speeding drives are not clean)');

-- client posture
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from public.user_achievements), 5, 'the owner reads their achievements');
select throws_ok($$ select count(*) from public.weekly_challenges $$, '42501', null, 'challenges are read through the summary only');
select throws_ok($$ select count(*) from public.challenge_templates $$, '42501', null, 'templates too');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'B cannot see A''s achievements');
reset role;

select * from finish();
rollback;
