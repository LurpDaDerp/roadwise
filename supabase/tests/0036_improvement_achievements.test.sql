-- 0036_improvement_achievements: a category score 10 or more whole points above where it was 30
-- days ago, both windows ranked, unlocks that category's badge, once; no ranked past, no badge.
-- claim_spot_cleared writes Spot Cleared for its caller only, once, and is closed to anon; the
-- client still writes no badge itself, and the CHECK takes exactly the ten ids.
create extension if not exists pgtap with schema extensions;

begin;
select plan(20);

-- ava (1) braked hard 40 days ago and drives smoothly now; bo (2) had only 5 miles back then
-- (unranked); cy (3) has no drive before this month
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com');

-- a scored drive with p_brakes minor hard brakes (no measured peak: each weighs 1); 10 speed-ups,
-- 5 turns and 600 s under a limit, so the other categories barely move
create function pg_temp.trip(p_user uuid, p_started timestamptz, p_miles numeric, p_slowdowns int, p_brakes int) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, n_hard_brake, clean, slowdowns, speedups, turns, limit_s, moving_s)
    values (p_user, gen_random_uuid(), p_started, p_started + interval '20 minutes', (p_started at time zone 'America/New_York')::date,
      private.league_week(p_started), 'America/New_York', p_miles, 0, 1200, true, p_brakes, p_brakes, p_brakes = 0, p_slowdowns, 10, 5, 600, 1000)
    returning id into v_id;
  insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    select v_id, gen_random_uuid(), p_user, 'hard_brake', 'minor', p_started + make_interval(secs => g * 60), 1
    from generate_series(1, p_brakes) g;
  return v_id;
end $$;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
-- a category's whole-number score at an instant
create function pg_temp.score(p_user int, p_at timestamptz, p_key text) returns double precision language sql as $$
  select private.round_half_up((private.rating_at(('00000000-0000-0000-0000-00000000000' || p_user)::uuid, p_at) -> 'scores' ->> p_key)::float8, 0)
$$;

-- ava: braking about 35 then (10 brakes in 20 slowdowns, 10 days old), about 74 now (100 clean slowdowns yesterday)
select pg_temp.trip('00000000-0000-0000-0000-000000000001', now() - interval '40 days', 20, 20, 10);
select pg_temp.trip('00000000-0000-0000-0000-000000000001', now() - interval '1 day', 20, 100, 0);
-- bo: the same drives, but only 5 miles back then
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '40 days', 5, 20, 10);
select pg_temp.trip('00000000-0000-0000-0000-000000000002', now() - interval '1 day', 20, 100, 0);
-- cy: only yesterday's drive
select pg_temp.trip('00000000-0000-0000-0000-000000000003', now() - interval '1 day', 20, 100, 0);

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity), 0,
  'every table in public and private has RLS enabled');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0,
  'every security definer function in public and private is owned by postgres and pins search_path=public');
select is((select p.prosecdef::text || ':' || r.rolname || ':' || array_to_string(p.proconfig, ',') from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.claim_spot_cleared()'::regprocedure),
  'true:postgres:search_path=public', 'claim_spot_cleared is a definer owned by postgres with search_path pinned');
select is(array[has_function_privilege('authenticated', 'public.claim_spot_cleared()', 'execute'),
    has_function_privilege('anon', 'public.claim_spot_cleared()', 'execute')],
  array[true, false], 'claim_spot_cleared: authenticated only');
select is((select array[p.prosecdef, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')]
    from pg_proc p where p.oid = 'private.check_achievements(uuid, text)'::regprocedure),
  array[false, false, false], 'check_achievements still runs as its caller and is closed to the API roles');

-- ---------------------------------------------------------------------------
-- improvement badges
-- ---------------------------------------------------------------------------
select ok(pg_temp.score(1, now(), 'braking') - pg_temp.score(1, now() - interval '30 days', 'braking') >= 10
    and pg_temp.score(1, now(), 'speed') - pg_temp.score(1, now() - interval '30 days', 'speed') < 10
    and pg_temp.score(1, now(), 'acceleration') - pg_temp.score(1, now() - interval '30 days', 'acceleration') < 10
    and pg_temp.score(1, now(), 'turning') - pg_temp.score(1, now() - interval '30 days', 'turning') < 10,
  'the fixture: ava''s Braking rose 10 or more, her other scores less');
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '["first_drive", "better_braking"]'::jsonb,
  'Braking up 10 points on 30 days ago, both windows ranked, unlocks Softer Stops (and nothing for scores that rose less or have none)');
select is(private.check_achievements('00000000-0000-0000-0000-000000000001', private.league_week(now())), '[]'::jsonb, 'nothing new on a re-check');
select is((select array_agg(achievement_id order by achievement_id) from public.user_achievements where user_id = '00000000-0000-0000-0000-000000000001'),
  array['better_braking', 'first_drive'], 'each unlocked once');
select is(private.check_achievements('00000000-0000-0000-0000-000000000002', private.league_week(now())), '["first_drive"]'::jsonb,
  'an unranked window 30 days ago unlocks no improvement badge');
select is(private.check_achievements('00000000-0000-0000-0000-000000000003', private.league_week(now())), '["first_drive"]'::jsonb,
  'nor does having no drives 30 days ago');

-- ---------------------------------------------------------------------------
-- Spot Cleared, claimed by the phone
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
select is(public.claim_spot_cleared(), '["spot_cleared"]'::jsonb, 'the claim unlocks Spot Cleared and says so');
select is(public.claim_spot_cleared(), '[]'::jsonb, 'a repeat changes nothing and answers nothing new');
select pg_temp.as_user(2);
select is(public.claim_spot_cleared(), '["spot_cleared"]'::jsonb, 'another driver''s claim is their own');
select throws_ok($$ insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000002', 'better_speed') $$,
  '42501', null, 'the client still writes no badge itself');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.claim_spot_cleared() $$, '42501', 'claim_spot_cleared requires an authenticated user', 'no user, no claim');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.claim_spot_cleared() $$, '42501', null, 'anon cannot claim');
reset role;
select is((select array_agg(user_id::text order by user_id) from public.user_achievements where achievement_id = 'spot_cleared'),
  array['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'], 'one Spot Cleared for each driver who claimed, none for cy');

-- ---------------------------------------------------------------------------
-- the CHECK
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000003', 'better_parking') $$,
  '23514', null, 'an unknown id is refused');
select lives_ok($$ insert into public.user_achievements (user_id, achievement_id)
    select '00000000-0000-0000-0000-000000000003', a from unnest(array['clean_100', 'perfect_week', 'better_speed', 'better_braking', 'better_acceleration',
      'better_turning', 'better_phone', 'better_attention', 'spot_cleared']) a $$,
  'every one of the ten ids is taken');

select * from finish();
rollback;
