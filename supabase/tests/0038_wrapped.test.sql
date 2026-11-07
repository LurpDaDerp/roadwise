-- 0038_wrapped: the monthly Wrapped. Eligibility (3 or more scored drives, none marked "Wasn't
-- driving", in the month), the month's stats and drive scores, the archetype's every rule,
-- percentiles (strictly worse over N - 1, ties not worse, null under 25 drivers and under 10, the
-- driver's own row computed live), the archive and its kept lines (24 at most), the share snapshot
-- (no clock times, places or habits beyond the busiest weekday; one per month, refreshed on
-- sharing again; unsharing; blocks), rate limits, time zones (the drive's own, local days at a
-- month's edge), the monthly push (the UTC window's edges, eligibility, the cohort refreshed first)
-- and its switch, the cohort job, grants and the export.
create extension if not exists pgtap with schema extensions;

begin;
select plan(107);

-- ava (01) drives September 2026 in New York; bo (02) and 28 more drivers (03..30) fill the cohort.
-- 31..36 never join September's cohort: 31 has 2 September drives and one in October; 32 is set to
-- Tokyo but drives in Los Angeles in June; 33 climbs in May; 34 drove 26 past months; 35
-- (Kiritimati, UTC+14) and 36 (Etc/GMT+12, UTC-12) drove in August.
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 36) g;
update public.profiles set username = 'ava' where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'bob' where id = '00000000-0000-0000-0000-000000000002';
insert into public.notification_prefs (user_id, tz) values ('00000000-0000-0000-0000-000000000001', 'America/New_York'),
  ('00000000-0000-0000-0000-000000000032', 'Asia/Tokyo'), ('00000000-0000-0000-0000-000000000035', 'Pacific/Kiritimati'),
  ('00000000-0000-0000-0000-000000000036', 'Etc/GMT+12');

-- a scored 20-minute drive at a local time in p_tz (New York) with p_brakes minor hard brakes (each
-- weighs 1; 20 slowdowns then, else 10), 10 speed-ups, 5 turns, 600 s under a limit, no phone time
create function pg_temp.trip(p_user int, p_local timestamp, p_miles numeric, p_brakes int default 0, p_tz text default 'America/New_York') returns uuid
language plpgsql as $$
declare
  v_uid uuid := ('00000000-0000-0000-0000-0000000000' || lpad(p_user::text, 2, '0'))::uuid;
  v_start timestamptz := p_local at time zone p_tz;
  v_id uuid;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, n_hard_brake, clean, slowdowns, speedups, turns, limit_s, moving_s, scoring_version)
    values (v_uid, gen_random_uuid(), v_start, v_start + interval '20 minutes', p_local::date, private.league_week(v_start), p_tz,
      p_miles, 0, 1200, true, p_brakes, p_brakes, p_brakes = 0, case when p_brakes > 0 then 20 else 10 end, 10, 5, 600, 1000, 11)
    returning id into v_id;
  insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    select v_id, gen_random_uuid(), v_uid, 'hard_brake', 'minor', v_start + make_interval(secs => g * 60), 1 from generate_series(1, p_brakes) g;
  return v_id;
end $$;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000' || lpad(p::text, 2, '0') || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
-- opens a share p_n times (the rate limit)
create function pg_temp.open_n(p_n int) returns int language plpgsql as $$
begin
  for i in 1..p_n loop
    perform public.get_shared_wrapped('AAAAAAAAAAAA');
  end loop;
  return p_n;
end $$;
grant execute on function pg_temp.open_n(int) to authenticated;
create function pg_temp.arch(p_rating_end numeric, p_rating_start numeric, p_categories jsonb, p_clean float8, p_drives int, p_avg float8,
  p_longest float8, p_rush float8, p_early float8, p_weekend float8) returns text language sql as $$
  select a ->> 'style' || ' ' || (a ->> 'pattern') from (select private.wrapped_archetype(p_rating_end, p_rating_start, p_categories, p_clean,
    p_drives, p_avg, p_longest, p_rush, p_early, p_weekend) as a) x
$$;

-- ava, September: Tue 1st 07:30 (10 mi, clean), Wed 2nd 17:00 (12 mi, one hard brake), Sat 5th 12:00
-- (8 mi, clean), Tue 8th 08:15 (30 mi, clean); July 3 drives of 2 mi (eligible); August 2 drives of 1 mi
-- (not); 3 drives today (this month, never in the archive)
select pg_temp.trip(1, '2026-09-01 07:30', 10);
select pg_temp.trip(1, '2026-09-02 17:00', 12, 1);
select pg_temp.trip(1, '2026-09-05 12:00', 8);
select pg_temp.trip(1, '2026-09-08 08:15', 30);
select pg_temp.trip(1, timestamp '2026-07-06 12:00' + make_interval(days => g), 2) from generate_series(1, 3) g;
select pg_temp.trip(1, timestamp '2026-08-10 12:00' + make_interval(days => g), 1) from generate_series(1, 2) g;
select pg_temp.trip(1, (now() at time zone 'America/New_York')::date + time '00:00' + make_interval(mins => g), 1) from generate_series(1, 3) g;
-- a fourth August drive marked "Wasn't driving" and an unscored one never count
select pg_temp.trip(1, '2026-08-20 12:00', 5);
select pg_temp.trip(1, '2026-08-21 12:00', 5);
update public.trips set not_driving = true, not_driving_at = now() where user_id = '00000000-0000-0000-0000-000000000001' and local_day = '2026-08-20';
update public.trips set scored = false where user_id = '00000000-0000-0000-0000-000000000001' and local_day = '2026-08-21';
-- bo: 3 drives of 1 mi; driver k (3..30): 3 drives of k mi, k 3..12 with one hard brake on the first
select pg_temp.trip(2, timestamp '2026-09-14 12:00' + make_interval(days => g), 1) from generate_series(1, 3) g;
select pg_temp.trip(k, timestamp '2026-09-14 12:00' + make_interval(days => g), k, case when g = 1 and k <= 12 then 1 else 0 end)
  from generate_series(3, 30) k, generate_series(1, 3) g;
-- badges: one in September, one at 23:00 on the 30th in New York (03:00 UTC on 1 October), one on
-- 1 October in New York
insert into public.user_achievements (user_id, achievement_id, unlocked_at) values
  ('00000000-0000-0000-0000-000000000001', 'first_drive', timestamptz '2026-09-01 12:00 America/New_York'),
  ('00000000-0000-0000-0000-000000000001', 'clean_100', timestamptz '2026-10-01 03:00 UTC'),
  ('00000000-0000-0000-0000-000000000001', 'perfect_week', timestamptz '2026-10-01 05:00 UTC');
-- goals: two done in weeks whose Sunday is in September, one not done, one done in a week ending in October
insert into public.weekly_challenges (user_id, league_week, slot, template_id, completed_at) values
  ('00000000-0000-0000-0000-000000000001', to_char(date '2026-09-06', 'IYYY-"W"IW'), 1, 'clean', now()),
  ('00000000-0000-0000-0000-000000000001', to_char(date '2026-09-06', 'IYYY-"W"IW'), 2, 'smooth', null),
  ('00000000-0000-0000-0000-000000000001', to_char(date '2026-09-27', 'IYYY-"W"IW'), 1, 'clean', now()),
  ('00000000-0000-0000-0000-000000000001', to_char(date '2026-10-04', 'IYYY-"W"IW'), 1, 'clean', now());
-- 31: 2 September drives and one on 1 October (drove lately, not eligible last month)
select pg_temp.trip(31, timestamp '2026-09-20 12:00' + make_interval(days => g), 4) from generate_series(1, 2) g;
select pg_temp.trip(31, '2026-10-01 08:00', 4);
-- 32: Mondays 1, 8 and 15 June at 20:00 in Los Angeles (Tuesday noon in Tokyo) and Tuesday 30 June
-- at 23:30 (already 1 July in UTC and in Tokyo): a June of 4 drives, no July
select pg_temp.trip(32, timestamp '2026-06-01 20:00' + make_interval(days => 7 * g), 5, 0, 'America/Los_Angeles') from generate_series(0, 2) g;
select pg_temp.trip(32, '2026-06-30 23:30', 5, 0, 'America/Los_Angeles');
-- 33: 29 and 30 April, 5 mi with 10 hard brakes each (ranked on 1 May, about 74.7), then a clean
-- 1 mi drive every day of May (about 89.8 on 1 June)
select pg_temp.trip(33, timestamp '2026-04-29 12:00' + make_interval(days => g), 5, 10) from generate_series(0, 1) g;
select pg_temp.trip(33, timestamp '2026-05-01 12:00' + make_interval(days => g), 1) from generate_series(0, 30) g;
-- 34: 3 drives in each month from January 2024 to February 2026 (26 months)
select pg_temp.trip(34, timestamp '2024-01-10 12:00' + make_interval(months => m, days => g), 2) from generate_series(0, 25) m, generate_series(0, 2) g;
-- 35 and 36: 3 August drives each, in their own zones
select pg_temp.trip(35, timestamp '2026-08-10 12:00' + make_interval(days => g), 3, 0, 'Pacific/Kiritimati') from generate_series(0, 2) g;
select pg_temp.trip(36, timestamp '2026-08-10 12:00' + make_interval(days => g), 3, 0, 'Etc/GMT+12') from generate_series(0, 2) g;

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select is((select array_agg(c.relrowsecurity order by c.relname) from pg_class c
    where c.oid in ('public.wrapped_shares'::regclass, 'private.monthly_stats'::regclass, 'private.wrapped_archive'::regclass)), array[true, true, true],
  'the three new tables have RLS enabled');
select is((select count(*)::int from information_schema.role_table_grants g where g.grantee in ('anon', 'authenticated')
    and g.table_name in ('wrapped_shares', 'monthly_stats', 'wrapped_archive')), 0, 'none has a client grant');
select is((select bool_and(p.prosecdef and r.rolname = 'postgres' and 'search_path=public' = any(p.proconfig)
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
    from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid in ('public.list_my_wrapped()'::regprocedure, 'public.get_my_wrapped(text)'::regprocedure,
      'public.create_wrapped_share(text)'::regprocedure, 'public.get_shared_wrapped(text)'::regprocedure,
      'public.delete_wrapped_share(text)'::regprocedure)), true,
  'the five RPCs are definers owned by postgres with search_path pinned, for authenticated only');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (p.proname like 'wrapped%' or p.proname in ('refresh_monthly_stats', 'refresh_monthly_stats_daily', 'new_share_id', 'produce_monthly_wrapped'))
    and (p.prosecdef or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'the private helpers run as their caller and are closed to the API roles');
select is((select array_agg(jobname || ' ' || schedule order by jobname) from cron.job where jobname in ('monthly-stats', 'monthly-wrapped')),
  array['monthly-stats 30 4 * * *', 'monthly-wrapped 10 * * * *'], 'the cohort runs daily at 04:30 UTC and the push hourly');

-- ---------------------------------------------------------------------------
-- eligibility and the month's drives
-- ---------------------------------------------------------------------------
select is(array[private.wrapped_eligible('00000000-0000-0000-0000-000000000001', '2026-09'), private.wrapped_eligible('00000000-0000-0000-0000-000000000001', '2026-07'),
    private.wrapped_eligible('00000000-0000-0000-0000-000000000001', '2026-08')], array[true, true, false],
  '3 or more scored drives make a month; "Wasn''t driving" and unscored drives never count');
select is((select array_agg(score order by started_at) from private.wrapped_trips('2026-09', '00000000-0000-0000-0000-000000000001')),
  array[100, 91, 100, 100]::float8[], 'drive scores as scoring driveScore: clean 100, one hard brake in 20 slowdowns 91');
-- bo, June: one drive with every kind of event, DashPal watching half of it; scoring driveScore gives 76
with t as (
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, clean, slowdowns, speedups, turns, limit_s, moving_s, phone_s, dashcam_moving_s, dashcam_covered_s, scoring_version)
    values ('00000000-0000-0000-0000-000000000002', gen_random_uuid(), timestamptz '2026-06-10 12:00 UTC', timestamptz '2026-06-10 12:20 UTC', '2026-06-10',
      private.league_week(timestamptz '2026-06-10 12:00 UTC'), 'America/New_York', 10, 0, 1200, true, 3, false, 15, 12, 6, 800, 1000, 900, 1000, 500, 11)
    returning id)
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured)
  select t.id, x.cid::uuid, '00000000-0000-0000-0000-000000000002', x.type, x.tier, timestamptz '2026-06-10 12:00 UTC' + make_interval(secs => x.s), x.d, x.m::jsonb
  from t, (values ('00000000-0000-4000-8000-000000000001', 'speeding', 'moderate', 60, 30, '{"overMphS": 240}'),
                  ('00000000-0000-4000-8000-000000000002', 'phone_pickup', 'severe', 120, 20, '{"maxSpeedMph": 40}'),
                  ('00000000-0000-4000-8000-000000000003', 'hard_accel', 'severe', 180, 1, '{"peakG": 0.5}'),
                  ('00000000-0000-4000-8000-000000000004', 'eyes_off', 'severe', 240, 6, '{"speedMph": 30}')) x(cid, type, tier, s, d, m);
select is((select array_agg(array[score, n_hard, n_speeding, n_pickup]) from private.wrapped_trips('2026-06', '00000000-0000-0000-0000-000000000002')),
  array[array[76, 1, 1, 1]]::float8[], 'the drive score matches the TypeScript on speeding, a pickup, a measured hard start and DashPal; each kind counted');
select throws_ok($$ select private.wrapped_stats('00000000-0000-0000-0000-000000000001', '2026-9') $$, '22023', 'month must be YYYY-MM', 'a month is YYYY-MM');
select is(private.wrapped_stats('00000000-0000-0000-0000-000000000001', '2026-08'), null, 'no stats for a month under 3 drives');

-- ---------------------------------------------------------------------------
-- the stats
-- ---------------------------------------------------------------------------
create temporary table s as select private.wrapped_stats('00000000-0000-0000-0000-000000000001', '2026-09') as s;
grant select on s to authenticated;
select is((select jsonb_build_object('drives', s -> 'drives', 'miles', s -> 'miles', 'durationS', s -> 'durationS', 'avgDriveMiles', s -> 'avgDriveMiles',
    'longestDriveMiles', s -> 'longestDriveMiles') from s),
  '{"drives": 4, "miles": 60.0, "durationS": 4800, "avgDriveMiles": 15.0, "longestDriveMiles": 30.0}'::jsonb, 'totals');
select is((select jsonb_build_object('avgScore', s -> 'avgScore', 'cleanDrives', s -> 'cleanDrives', 'cleanShare', s -> 'cleanShare',
    'longestCleanDriveMiles', s -> 'longestCleanDriveMiles') from s),
  '{"avgScore": 98, "cleanDrives": 3, "cleanShare": 0.750, "longestCleanDriveMiles": 30.0}'::jsonb, 'safety: the average drive score (97.75 rounds to 98) and the clean drives');
select is((select array[s ->> 'ratingStart', s ->> 'ratingChange'] from s), array[null, null]::text[],
  'unranked at the month''s start (8 mi in the 90 days): no rating then and no change');
select is((select (s ->> 'ratingEnd')::numeric from s),
  (select (r ->> 'rating')::numeric from (select private.rating_at('00000000-0000-0000-0000-000000000001', timestamptz '2026-10-01 00:00 America/New_York') as r) x),
  'the rating at the month''s end is the Safety Rating at local midnight on the 1st');
select is((select array(select jsonb_object_keys(s -> 'categories') order by 1) from s), array['acceleration', 'attention', 'braking', 'phone', 'speed', 'turning'],
  'every category is there');
select is((select array[s -> 'categories' -> 'attention', s -> 'categories' -> 'phone'] from s), array['null'::jsonb, 'null'::jsonb],
  'Attention without DashPal miles and Phone use without phone time have no score');
select is((select jsonb_build_object('hardPer100', s -> 'hardPer100', 'speedingPer100', s -> 'speedingPer100', 'pickupsPer100', s -> 'pickupsPer100') from s),
  '{"hardPer100": 1.7, "speedingPer100": 0, "pickupsPer100": 0}'::jsonb, 'events per 100 miles');
select is((select jsonb_build_object('busiestWeekday', s -> 'busiestWeekday', 'busiestBandStartHour', s -> 'busiestBandStartHour',
    'weekdayDrives', s -> 'weekdayDrives', 'weekendDrives', s -> 'weekendDrives', 'earlyShare', s -> 'earlyShare', 'rushShare', s -> 'rushShare') from s),
  '{"busiestWeekday": 2, "busiestBandStartHour": 6, "weekdayDrives": 3, "weekendDrives": 1, "earlyShare": 0.500, "rushShare": 0.750}'::jsonb,
  'habits in the drive''s zone: Tuesdays, 06:00-08:59, 3 weekday and 1 weekend, early 2 of 4, rush 3 of 4');
select is((select s -> 'badges' from s), '["first_drive", "clean_100"]'::jsonb, 'badges unlocked in the month, in the driver''s zone');
select is((select (s ->> 'goalsCompleted')::int from s), 2, 'goals done in the weeks ending in the month');
select is((select s -> 'archetype' ->> 'pattern' from s), 'commuter', 'three of four drives in rush hour: a Commuter');
select is((select s -> 'archetype' ->> 'style' from s), 'steady',
  'every category 80 or more, 3 of 4 drives clean, unranked at the start: Speed best (it ties Acceleration and goes first), a Steady');

-- the drive's own zone and its local day: 32 is set to Tokyo but drove in Los Angeles
create temporary table s32 as select private.wrapped_stats('00000000-0000-0000-0000-000000000032', '2026-06') as s;
select is((select jsonb_build_object('drives', s -> 'drives', 'busiestWeekday', s -> 'busiestWeekday', 'busiestBandStartHour', s -> 'busiestBandStartHour',
    'weekendDrives', s -> 'weekendDrives', 'rushShare', s -> 'rushShare') from s32),
  '{"drives": 4, "busiestWeekday": 1, "busiestBandStartHour": 18, "weekendDrives": 0, "rushShare": 0.000}'::jsonb,
  'Mondays 18:00-20:59 in Los Angeles, not Tuesday noon in Tokyo; the 23:30 drive on 30 June counts in June');
select is(private.wrapped_eligible('00000000-0000-0000-0000-000000000032', '2026-07'), false, 'and not in July, though it was July in UTC');

-- a climb: ranked on 1 May, up 5 or more by 1 June
create temporary table s33 as select private.wrapped_stats('00000000-0000-0000-0000-000000000033', '2026-05') as s;
select ok((select (s ->> 'ratingStart') is not null and (s ->> 'ratingChange')::numeric >= 5
    and (s ->> 'ratingChange')::numeric = round((s ->> 'ratingEnd')::numeric - (s ->> 'ratingStart')::numeric, 1) from s33),
  'ranked at the month''s start: a start rating and the change to the end');
select is((select s -> 'archetype' ->> 'style' || ' ' || (s -> 'archetype' ->> 'pattern') from s33), 'rising city_hopper',
  'up 5 or more with no category under 60: Rising; 31 short drives: a City Hopper');

-- ---------------------------------------------------------------------------
-- the archetype
-- ---------------------------------------------------------------------------
select is(pg_temp.arch(70, null, '{"speed": 55, "phone": 70, "braking": 58, "acceleration": 80, "turning": 90}', 0.9, 5, 10, 20, 0, 0, 0),
  'lead_footed cruiser', 'a category under 60: the lowest decides, Speed is Lead-Footed');
select is(pg_temp.arch(70, null, '{"speed": 70, "phone": 70, "braking": 50, "acceleration": 80, "turning": 90}', 0.9, 5, 10, 20, 0, 0, 0),
  'jumpy cruiser', 'Braking lowest: Jumpy');
select is(pg_temp.arch(70, null, '{"speed": 70, "phone": 70, "braking": 80, "acceleration": 80, "turning": 59}', 0.9, 5, 10, 20, 0, 0, 0),
  'jumpy cruiser', 'Turning lowest: Jumpy');
select is(pg_temp.arch(70, null, '{"speed": 70, "phone": 40, "braking": 80, "acceleration": 80, "turning": 90, "attention": 75}', 0.9, 5, 10, 20, 0, 0, 0),
  'phone_happy cruiser', 'Phone use lowest: Phone-Happy');
select is(pg_temp.arch(85, null, '{"speed": 90, "phone": 85, "braking": 85, "acceleration": 85, "turning": 85, "attention": 30}', 0.9, 5, 10, 20, 0, 0, 0),
  'bumpy cruiser', 'Attention under 60 is negative too; Attention lowest names no category: Bumpy');
select is(pg_temp.arch(59.5, null, '{"speed": 62, "phone": 62, "braking": 62, "acceleration": 62, "turning": 62, "attention": 40}', 0.9, 5, 10, 20, 0, 0, 0),
  'bumpy cruiser', 'a rating under 60 that Attention pulled down: Bumpy, not Lead-Footed');
select is(pg_temp.arch(70, null, '{"speed": 50, "phone": 70, "braking": 80, "acceleration": 80, "turning": 90, "attention": 50}', 0.9, 5, 10, 20, 0, 0, 0),
  'lead_footed cruiser', 'Attention ties last: Speed at 50 before Attention at 50');
select is(pg_temp.arch(70, null, '{"speed": 59, "phone": 59, "braking": 80, "acceleration": 80, "turning": 90}', 0.9, 5, 10, 20, 0, 0, 0),
  'lead_footed cruiser', 'a tie goes to Speed before Phone use');
select is(pg_temp.arch(59.9, null, '{"speed": 62, "phone": 70, "braking": 61, "acceleration": 80, "turning": 90}', 0.9, 5, 10, 20, 0, 0, 0),
  'jumpy cruiser', 'a Safety Rating under 60 is negative too, from the lowest category');
select is(pg_temp.arch(80, null, '{"speed": 85, "phone": 85, "braking": 85, "acceleration": 85, "turning": 85}', 0.29, 5, 10, 20, 0, 0, 0),
  'bumpy cruiser', 'no category under 60 but a clean share under 30%: Bumpy');
select is(pg_temp.arch(85, 80, '{"speed": 90, "phone": null, "braking": 85, "acceleration": 85, "turning": 85}', 0.9, 5, 10, 20, 0, 0, 0),
  'rising cruiser', 'the rating up 5 on the month''s start: Rising, before Spotless');
select is(pg_temp.arch(84.9, 80, '{"speed": 90, "phone": null, "braking": 85, "acceleration": 85, "turning": 85}', 0.8, 5, 10, 20, 0, 0, 0),
  'spotless cruiser', 'up 4.9 with a clean share of 80%: Spotless');
select is(pg_temp.arch(85, null, '{"speed": 90, "phone": null, "braking": 85, "acceleration": 85, "turning": 85}', 0.7, 5, 10, 20, 0, 0, 0),
  'steady cruiser', 'Speed best at 80 or more: Steady');
select is(pg_temp.arch(85, null, '{"speed": 80, "phone": 80, "braking": 85, "acceleration": 85, "turning": 80}', 0.7, 5, 10, 20, 0, 0, 0),
  'smooth cruiser', 'Braking best: Smooth');
select is(pg_temp.arch(85, null, '{"speed": 81, "phone": 82, "braking": 80, "acceleration": 80, "turning": 80}', 0.7, 5, 10, 20, 0, 0, 0),
  'focused cruiser', 'Phone use best: Focused');
select is(pg_temp.arch(75, null, '{"speed": 79, "phone": 79, "braking": 79, "acceleration": 79, "turning": 79}', 0.7, 5, 10, 20, 0, 0, 0),
  'easygoing cruiser', 'nothing at 80: Easygoing');
select is(pg_temp.arch(null, null, null, 0.5, 5, 10, 20, 0, 0, 0), 'easygoing cruiser', 'unranked, half clean: Easygoing');
select is(array[pg_temp.arch(null, null, null, 0.5, 3, 20, 30, 0.9, 0.9, 0.9), pg_temp.arch(null, null, null, 0.5, 3, 5, 100, 0.9, 0.9, 0.9),
    pg_temp.arch(null, null, null, 0.5, 3, 19.9, 99.9, 0.5, 0.9, 0.9), pg_temp.arch(null, null, null, 0.5, 3, 10, 20, 0.49, 0.4, 0.9),
    pg_temp.arch(null, null, null, 0.5, 3, 10, 20, 0.49, 0.39, 0.5), pg_temp.arch(null, null, null, 0.5, 12, 4.9, 20, 0, 0, 0.49),
    pg_temp.arch(null, null, null, 0.5, 11, 4.9, 20, 0, 0, 0.49)],
  array['easygoing road_tripper', 'easygoing road_tripper', 'easygoing commuter', 'easygoing early_bird', 'easygoing weekend_cruiser',
    'easygoing city_hopper', 'easygoing cruiser'],
  'patterns in order: Road Tripper (20 mi average or a 100 mi drive), Commuter, Early Bird, Weekend Cruiser, City Hopper (12 drives under 5 mi), Cruiser');

-- ---------------------------------------------------------------------------
-- the cohort and percentiles
-- ---------------------------------------------------------------------------
select is(private.refresh_monthly_stats('2026-09'), 30, 'September''s cohort: the 30 eligible drivers');
select is((select array[drives::text, miles::text, avg_score::text, clean_share::text, hard_per100::text] from private.monthly_stats
    where month = '2026-09' and user_id = '00000000-0000-0000-0000-000000000003'),
  array['3', '9.0', '97.0', '0.6667', '11.11'], 'a row: drives, miles, average drive score, clean share, hard events per 100 mi');
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000001', '2026-09'),
  '{"miles": 62, "avgScore": 34, "cleanShare": 34, "hardPer100": 34, "speedingPer100": null, "pickupsPer100": null}'::jsonb,
  'others strictly worse over N - 1: 18 of 29 drove fewer miles (the 60-mile driver ties), 10 of 29 did worse on the rest; none worse on speeding or pickups');
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000003', '2026-09') ->> 'miles', null,
  'driver 3''s 9 mi beat only bo''s 3: 3%, hidden under 10');
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000003', '2026-09') -> 'hardPer100', 'null'::jsonb, 'the most hard events: nobody worse, no chip');
delete from private.monthly_stats where month = '2026-09' and user_id = '00000000-0000-0000-0000-000000000001';
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000001', '2026-09') ->> 'miles', '62', 'the driver''s own row is computed live when missing');
delete from private.monthly_stats where month = '2026-09' and user_id in (select ('00000000-0000-0000-0000-0000000000' || g)::uuid from generate_series(25, 30) g);
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000001', '2026-09'),
  '{"miles": null, "avgScore": null, "cleanShare": null, "hardPer100": null, "speedingPer100": null, "pickupsPer100": null}'::jsonb,
  '24 drivers with the driver: no percentiles');
select is(private.wrapped_percentiles('00000000-0000-0000-0000-000000000001', '2026-08') ->> 'miles', null, 'nor for a month the driver is not eligible');
select is(private.refresh_monthly_stats_daily(timestamptz '2026-10-05 04:30 UTC'), 30, 'on days 1 to 10 the job refreshes the month before too');
select is(private.refresh_monthly_stats_daily(timestamptz '2026-10-15 04:30 UTC'), 0, 'later in the month only the current month');

-- ---------------------------------------------------------------------------
-- the RPCs
-- ---------------------------------------------------------------------------
select pg_temp.as_user(1);
create temporary table share as select public.create_wrapped_share('2026-09') as id;
grant select on share to authenticated;
set local role authenticated;
select is((select jsonb_agg(x - 'archetype') from jsonb_array_elements(public.list_my_wrapped()) x),
  '[{"month": "2026-09", "drives": 4, "miles": 60.0}, {"month": "2026-07", "drives": 3, "miles": 6.0}]'::jsonb,
  'the archive: eligible past months, newest first (not August, not this month)');
select is((select array(select jsonb_object_keys(x -> 'archetype') order by 1) from jsonb_array_elements(public.list_my_wrapped()) x limit 1),
  array['pattern', 'style'], 'each with its archetype');
select is(public.get_my_wrapped('2026-09') - 'percentiles', (select s from s), 'get_my_wrapped: the month''s stats');
select is(public.get_my_wrapped('2026-09') -> 'percentiles' ->> 'miles', '62', 'with its percentiles');
select is(public.get_my_wrapped('2026-08'), null, 'null for a month under 3 drives');
select is(public.get_my_wrapped(to_char(now() at time zone 'America/New_York', 'YYYY-MM')), null, 'null for this month, still under way');
select throws_ok($$ select public.get_my_wrapped('2026-13') $$, '22023', 'month must be YYYY-MM', 'a bad month is refused');

-- the archive's kept lines: read while they match the month's drives and miles, computed again when not
reset role;
select is((select array_agg(month order by month) from private.wrapped_archive where user_id = '00000000-0000-0000-0000-000000000001'),
  array['2026-07', '2026-09'], 'the archive keeps a line for each month it lists');
update private.wrapped_archive set archetype = '{"style": "kept", "pattern": "kept"}' where user_id = '00000000-0000-0000-0000-000000000001' and month = '2026-07';
set local role authenticated;
select is((select x -> 'archetype' ->> 'style' from jsonb_array_elements(public.list_my_wrapped()) x where x ->> 'month' = '2026-07'), 'kept',
  'a line that still matches the month is read, not computed');
reset role;
update private.wrapped_archive set drives = 99 where user_id = '00000000-0000-0000-0000-000000000001' and month = '2026-07';
set local role authenticated;
select is((select x ->> 'drives' from jsonb_array_elements(public.list_my_wrapped()) x where x ->> 'month' = '2026-07'), '3', 'the month as it is');
reset role;
select is((select jsonb_build_object('drives', drives, 'archetype', archetype) from private.wrapped_archive
    where user_id = '00000000-0000-0000-0000-000000000001' and month = '2026-07'),
  jsonb_build_object('drives', 3, 'archetype', private.wrapped_stats('00000000-0000-0000-0000-000000000001', '2026-07') -> 'archetype'),
  'a line that no longer matches is computed again and kept');
set local role authenticated;
select pg_temp.as_user(34);
select is((select array[jsonb_array_length(l)::text, l -> 0 ->> 'month', l -> 23 ->> 'month'] from (select public.list_my_wrapped() as l) x),
  array['24', '2026-02', '2024-03'], 'the archive holds the newest 24 of 26 months');
select pg_temp.as_user(1);

select matches((select id from share), '^[A-Za-z0-9]{12}$', 'a share id is 12 base62 characters');
select is(public.create_wrapped_share('2026-09'), (select id from share), 'sharing again keeps the id');
select throws_ok($$ select public.create_wrapped_share('2026-08') $$, 'P0002', 'wrapped not found', 'no share for a month without a Wrapped');
select throws_ok($$ select public.create_wrapped_share(to_char(now() at time zone 'America/New_York', 'YYYY-MM')) $$, 'P0002', 'wrapped not found',
  'nor for this month, still under way');
select is((select array(select jsonb_object_keys(public.get_shared_wrapped((select id from share))) order by 1)),
  array['archetype', 'avgDriveMiles', 'avgScore', 'badges', 'badgesCount', 'bestCategory', 'busiestWeekday', 'categories', 'cleanDrives', 'cleanShare',
    'drives', 'durationS', 'hardPer100', 'id', 'longestCleanDriveMiles', 'longestDriveMiles', 'miles', 'mine', 'month', 'percentiles', 'pickupsPer100',
    'ratingChange', 'ratingEnd', 'ratingStart', 'speedingPer100', 'username'],
  'the shared copy: no clock times (no time band, early or rush share), no weekday split, no goals, no places or routes');
select is((select array[x ->> 'username', x ->> 'mine', x ->> 'busiestWeekday', x ->> 'badgesCount'] from (select public.get_shared_wrapped((select id from share)) as x) y),
  array['ava', 'true', '2', '2'], 'the owner sees their own share');
select pg_temp.as_user(3);
select is((select array[x ->> 'username', x ->> 'mine', x ->> 'month'] from (select public.get_shared_wrapped((select id from share)) as x) y),
  array['ava', 'false', '2026-09'], 'any signed-in driver opens it');
select is(array[public.get_shared_wrapped('AAAAAAAAAAAA'), public.get_shared_wrapped('nope'), public.get_shared_wrapped(null)], array[null, null, null]::jsonb[],
  'an unknown or malformed id is null');
reset role;
insert into public.blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004');
set local role authenticated;
select pg_temp.as_user(2);
select is(public.get_shared_wrapped((select id from share)), null, 'a driver who blocked the owner gets nothing');
select pg_temp.as_user(4);
select is(public.get_shared_wrapped((select id from share)), null, 'nor does one the owner blocked');
-- a share is a snapshot: sharing again after a change shows the month as it is now; unsharing ends the link
reset role;
insert into public.user_achievements (user_id, achievement_id, unlocked_at)
  values ('00000000-0000-0000-0000-000000000001', 'clean_500', timestamptz '2026-09-15 12:00 America/New_York');
set local role authenticated;
select pg_temp.as_user(1);
select is((select x ->> 'badgesCount' from (select public.get_shared_wrapped((select id from share)) as x) y), '2', 'the link shows the snapshot');
select is(public.create_wrapped_share('2026-09'), (select id from share), 'sharing again after a new badge keeps the id');
select is((select x ->> 'badgesCount' from (select public.get_shared_wrapped((select id from share)) as x) y), '3', 'and refreshes what the link shows');
select is(public.delete_wrapped_share('2026-09'), true, 'unsharing deletes the share');
select is(array[public.get_shared_wrapped((select id from share))::text, public.delete_wrapped_share('2026-09')::text], array[null, 'false'],
  'the link no longer opens, and there is nothing left to delete');
select isnt(public.create_wrapped_share('2026-09'), (select id from share), 'sharing the month again makes a new link');
-- every RPC has a budget: 60 opens a minute
select pg_temp.as_user(5);
select is(pg_temp.open_n(60), 60, '60 opens in a minute pass');
select throws_ok($$ select public.get_shared_wrapped('AAAAAAAAAAAA') $$, '42501', 'too many requests', 'the 61st is refused');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.list_my_wrapped() $$, '42501', 'list_my_wrapped requires an authenticated user', 'no user, no archive');
select throws_ok($$ select public.get_my_wrapped('2026-09') $$, '42501', 'get_my_wrapped requires an authenticated user', 'nor a Wrapped');
select throws_ok($$ select public.create_wrapped_share('2026-09') $$, '42501', 'create_wrapped_share requires an authenticated user', 'nor a share');
select throws_ok($$ select public.delete_wrapped_share('2026-09') $$, '42501', 'delete_wrapped_share requires an authenticated user', 'nor an unshare');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.get_shared_wrapped('AAAAAAAAAAAA') $$, '42501', null, 'anon opens no share');
reset role;
select is((select count(*)::int from public.wrapped_shares), 1, 'one share row per driver and month');

-- ---------------------------------------------------------------------------
-- the push
-- ---------------------------------------------------------------------------
-- the window's edges: UTC+14 is due at 20:10 UTC on the month's last day, UTC-12 at 22:10 UTC on the 1st
select is(private.produce_monthly_wrapped(timestamptz '2026-08-31 19:10 UTC'), 0, '09:10 on 1 September in Kiritimati: nothing yet');
select is(private.produce_monthly_wrapped(timestamptz '2026-08-31 20:10 UTC'), 1, '20:10 UTC on 31 August is 10:10 on 1 September in Kiritimati');
select is(private.produce_monthly_wrapped(timestamptz '2026-09-01 22:10 UTC'), 1, '22:10 UTC on 1 September is 10:10 in UTC-12');
select is(private.produce_monthly_wrapped(timestamptz '2026-09-01 23:10 UTC'), 0, 'past the window nothing is due');
select is((select array_agg(right(user_id::text, 2) || ' ' || (payload ->> 'month') order by user_id) from public.inbox where kind = 'monthly_wrapped'),
  array['35 2026-08', '36 2026-08'], 'each for August, the month before their local 1st');
-- inside the window the month just ended is written again before anything is queued
delete from private.monthly_stats where month = '2026-09' and user_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');
select is(private.produce_monthly_wrapped(timestamptz '2026-10-01 09:30 America/New_York'), 0, 'not before 10:00 local on the 1st');
select is((select count(*)::int from private.monthly_stats where month = '2026-09'), 30, 'but September''s cohort is written again, whole');
select is(private.produce_monthly_wrapped(timestamptz '2026-10-01 10:30 America/New_York'), 30, 'at 10:xx on the 1st every driver eligible last month gets one');
select is((select count(*)::int from public.inbox where user_id = '00000000-0000-0000-0000-000000000031'), 0,
  'none for a driver with 2 drives last month, though they drove lately');
select is((select array[kind, payload::text, dedupe_key] from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'),
  array['monthly_wrapped', '{"month": "2026-09"}', 'monthly_wrapped:2026-09'], 'its payload names the month');
select is(private.produce_monthly_wrapped(timestamptz '2026-10-01 10:45 America/New_York') + private.produce_monthly_wrapped(timestamptz '2026-10-02 10:30 America/New_York'),
  0, 'once a month, and only on the 1st');
insert into public.notification_prefs (user_id, weekly_recap) values ('00000000-0000-0000-0000-000000000003', false);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select array_agg(x ->> 'user_id' || '=' || (x -> 'ctx' ->> 'enabled') order by x ->> 'user_id') from jsonb_array_elements(public.claim_push_batch(500, 60)) x
    where x ->> 'user_id' in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003')),
  array['00000000-0000-0000-0000-000000000001=true', '00000000-0000-0000-0000-000000000003=false'], 'the Wrapped push follows the weekly recap switch');
reset role;
select throws_ok($$ insert into public.inbox (user_id, kind, payload, dedupe_key) values ('00000000-0000-0000-0000-000000000002', 'monthly_recap', '{}', 'x') $$,
  '23514', null, 'the inbox takes monthly_wrapped and no other new kind');

-- ---------------------------------------------------------------------------
-- the export, and deleting the account
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table ex as select public.export_account('00000000-0000-0000-0000-000000000001') as e;
select is((select array[e ->> 'format_version', jsonb_array_length(e -> 'wrapped_shares')::text, e -> 'wrapped_shares' -> 0 ->> 'month'] from ex),
  array['8', '1', '2026-09'], 'the export (format 8) holds the driver''s shared Wrapped');
select is((select array[jsonb_array_length(e -> 'monthly_stats')::text, e -> 'monthly_stats' -> 0 ->> 'month', (e -> 'monthly_stats' -> 0 ? 'user_id')::text] from ex),
  array['1', '2026-09', 'false'], 'and their monthly numbers, without their id');
select is((select array[jsonb_array_length(e -> 'wrapped_archive')::text, e -> 'wrapped_archive' -> 0 ->> 'month', (e -> 'wrapped_archive' -> 0 ? 'user_id')::text] from ex),
  array['2', '2026-07', 'false'], 'and the archive''s kept lines');
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.wrapped_shares) + (select count(*)::int from private.monthly_stats where user_id = '00000000-0000-0000-0000-000000000001')
    + (select count(*)::int from private.wrapped_archive where user_id = '00000000-0000-0000-0000-000000000001'), 0,
  'deleting the account deletes its shares, monthly numbers and archive lines');

select * from finish();
rollback;
