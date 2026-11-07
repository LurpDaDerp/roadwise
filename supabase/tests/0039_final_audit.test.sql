-- 0039_final_audit: the route archive runs every 5 minutes, 03:00-05:55 UTC, one bounded batch a run, so a
-- backlog past one batch drains on the next runs; the daily rating refresh writes every due driver
-- in one UPDATE after computing them all (the same numbers as refresh_rating) instead of one UPDATE
-- per driver, each holding its row until the end of the run; the weekly recap reads no drive in the
-- hours when Sunday 18:xx is nowhere on Earth and still goes out at UTC+14 and UTC-12; the Wrapped
-- archive computes a month again when one of its drives changed after the kept line (an accepted
-- report flips a drive's clean flag without changing the drives or miles).
create extension if not exists pgtap with schema extensions;

begin;
select plan(25);

-- a (01): 1 001 drives past 183 days; b (02): two recent drives; c (03, Kiritimati, UTC+14) and d
-- (04, Etc/GMT+12, UTC-12): a July 2026 drive each; e (05, New York): 3 drives two months ago
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 5) g;
insert into public.notification_prefs (user_id, tz) values ('00000000-0000-0000-0000-000000000003', 'Pacific/Kiritimati'),
  ('00000000-0000-0000-0000-000000000004', 'Etc/GMT+12'), ('00000000-0000-0000-0000-000000000005', 'America/New_York')
  on conflict (user_id) do update set tz = excluded.tz;

-- a scored 20-minute drive starting at p_start in p_tz with p_brakes minor hard brakes, 10
-- speed-ups, 5 turns, 600 s under a limit, no phone time
create function pg_temp.trip(p_user int, p_start timestamptz, p_miles numeric, p_tz text, p_brakes int default 0) returns uuid
language plpgsql as $$
declare
  v_uid uuid := ('00000000-0000-0000-0000-0000000000' || lpad(p_user::text, 2, '0'))::uuid;
  v_id uuid;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, n_hard_brake, clean, slowdowns, speedups, turns, limit_s, moving_s, scoring_version)
    values (v_uid, gen_random_uuid(), p_start, p_start + interval '20 minutes', (p_start at time zone p_tz)::date, private.league_week(p_start), p_tz,
      p_miles, 0, 1200, true, p_brakes, p_brakes, p_brakes = 0, case when p_brakes > 0 then 20 else 10 end, 10, 5, 600, 1000, 11)
    returning id into v_id;
  insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    select v_id, gen_random_uuid(), v_uid, 'hard_brake', 'minor', p_start + make_interval(secs => g * 60), 1 from generate_series(1, p_brakes) g;
  return v_id;
end $$;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000' || lpad(p::text, 2, '0') || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
-- how often this transaction has read public.trips (sequential and index scans)
create function pg_temp.trip_scans() returns bigint language sql volatile as $$
  select coalesce(seq_scan, 0) + coalesce(idx_scan, 0) from pg_stat_xact_user_tables where relid = 'public.trips'::regclass
$$;
create function pg_temp.archived(p_user int) returns int language sql stable as $$
  select count(*)::int from public.trips
  where user_id = ('00000000-0000-0000-0000-0000000000' || lpad(p_user::text, 2, '0'))::uuid and archived_at is not null
$$;
-- the first day of the month two months back in New York
create function pg_temp.e_month() returns timestamp language sql stable as $$
  select date_trunc('month', now() at time zone 'America/New_York') - interval '2 months'
$$;

select pg_temp.trip(1, now() - interval '200 days' - make_interval(mins => g * 30), 1, 'America/New_York') from generate_series(1, 1001) g;
select pg_temp.trip(2, now() - interval '3 days', 12, 'America/New_York');
select pg_temp.trip(2, now() - interval '10 days', 12, 'America/New_York', 2);
-- Friday 10 July 2026 at noon, local (week 2026-W28 in New York for both)
select pg_temp.trip(3, timestamptz '2026-07-10 12:00 Pacific/Kiritimati', 5, 'Pacific/Kiritimati');
select pg_temp.trip(4, timestamptz '2026-07-10 12:00 Etc/GMT+12', 5, 'Etc/GMT+12');
select pg_temp.trip(5, (pg_temp.e_month() + interval '4 days 12 hours' + make_interval(days => g)) at time zone 'America/New_York', 10,
  'America/New_York', case when g = 0 then 1 else 0 end) from generate_series(0, 2) g;

-- ---------------------------------------------------------------------------
-- posture: schedules, owners, search paths and grants stay as they were
-- ---------------------------------------------------------------------------
select is((select array[schedule, command] from cron.job where jobname = 'route-archive'),
  array['*/5 3-5 * * *', 'select private.archive_old_routes_run()'], 'the route archive runs every 5 minutes from 03:00 to 05:55 UTC, each run its own transaction');
select is((select array[schedule, command] from cron.job where jobname = 'rating-refresh'),
  array['20 4 * * *', 'select private.refresh_ratings_daily()'], 'the rating refresh keeps its schedule');
select is((select bool_and(not p.prosecdef and p.proconfig = array['search_path=public']
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
    from pg_proc p where p.oid in ('private.refresh_ratings_daily()'::regprocedure, 'private.produce_weekly_recaps(timestamptz)'::regprocedure)), true,
  'the rating refresh and the weekly recap run as their caller with search_path pinned, closed to the API roles');
select is((select p.prosecdef and r.rolname = 'postgres' and p.proconfig = array['search_path=public']
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = 'public.list_my_wrapped()'::regprocedure), true,
  'list_my_wrapped stays a definer owned by postgres with search_path pinned, for authenticated only');

-- ---------------------------------------------------------------------------
-- the weekly recap: no drive read when Sunday 18:xx is nowhere
-- ---------------------------------------------------------------------------
create temporary table scans as select pg_temp.trip_scans() as n;
select is(private.produce_weekly_recaps(timestamptz '2026-07-11 12:00 UTC'), 0, 'Saturday noon UTC: no recap');
select is(pg_temp.trip_scans(), (select n from scans), 'and no drive is read (Sunday 18:xx is nowhere on Earth on a Saturday)');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 03:30 UTC'), 0, 'Sunday 03:30 UTC (17:30 in Kiritimati): no recap');
select is(pg_temp.trip_scans(), (select n from scans), 'and still no drive is read');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 04:30 UTC'), 1, 'Sunday 04:30 UTC is 18:30 in Kiritimati: its recap goes out');
select ok(pg_temp.trip_scans() > (select n from scans), 'reading this week''s drivers');
select is((select payload ->> 'week' from public.inbox where user_id = '00000000-0000-0000-0000-000000000003' and kind = 'weekly_recap'), '2026-W28',
  'naming the week that ends on that Sunday');
select is(private.produce_weekly_recaps(timestamptz '2026-07-13 06:30 UTC'), 1, 'Monday 06:30 UTC is Sunday 18:30 at UTC-12: its recap goes out');
select is((select payload ->> 'week' from public.inbox where user_id = '00000000-0000-0000-0000-000000000004' and kind = 'weekly_recap'), '2026-W28',
  'for the same week');

-- ---------------------------------------------------------------------------
-- the route archive: one batch a run, the backlog on the next runs
-- ---------------------------------------------------------------------------
select is(private.archive_old_routes_run(), 1000, 'a run archives one batch of 1 000 due drives, no more');
select ok(pg_temp.archived(1) < 1001, 'a backlog past one batch waits for the next run');
select private.archive_old_routes_run();
select is(pg_temp.archived(1), 1001, 'the next run (5 minutes later) archives the rest');

-- ---------------------------------------------------------------------------
-- the daily rating refresh: computed first, written in one statement
-- ---------------------------------------------------------------------------
-- counts the UPDATE statements on public.progress (created and dropped with this transaction)
create function private.t0039_count_progress_updates() returns trigger language plpgsql as $$
begin
  perform set_config('rw.progress_updates', (coalesce(nullif(current_setting('rw.progress_updates', true), ''), '0')::int + 1)::text, true);
  return null;
end $$;
create trigger t0039_count_progress_updates after update on public.progress for each statement execute function private.t0039_count_progress_updates();
-- b and c are due (a rating 21 h old); b's columns hold numbers the refresh must replace
update public.progress set safety_rating = 1, miles_90d = 1, ranked = false, rating_week_ago = 1, rating_updated_at = now() - interval '21 hours'
  where user_id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
select set_config('rw.progress_updates', '0', true);
select is(private.refresh_ratings_daily(), 2, 'the refresh picks the two drivers whose rating is 20 h old');
select is(current_setting('rw.progress_updates'), '1', 'and writes them in one statement after computing them all, not one per driver');
create temporary table daily as
  select g.user_id, g.miles_90d, g.safety_rating, g.ranked, g.rating_week_ago, g.rating_updated_at from public.progress g
  where g.user_id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
select is((select array[(rating_updated_at = now())::text, ranked::text, (safety_rating is not null)::text, (rating_week_ago is not null)::text, miles_90d::text]
    from daily where user_id = '00000000-0000-0000-0000-000000000002'), array['true', 'true', 'true', 'true', '24.00'],
  'b: ranked on 24 mi with a rating now and a week ago, stamped now');
update public.progress set safety_rating = 1, miles_90d = 1, ranked = false, rating_week_ago = 1, rating_updated_at = now() - interval '21 hours'
  where user_id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
select private.refresh_rating('00000000-0000-0000-0000-000000000002');
select private.refresh_rating('00000000-0000-0000-0000-000000000003');
select is((select array_agg(row(g.user_id, g.miles_90d, g.safety_rating, g.ranked, g.rating_week_ago, g.rating_updated_at)::text order by g.user_id)
    from public.progress g where g.user_id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003')),
  (select array_agg(row(d.user_id, d.miles_90d, d.safety_rating, d.ranked, d.rating_week_ago, d.rating_updated_at)::text order by d.user_id) from daily d),
  'the same numbers refresh_rating writes, driver by driver');
select is(private.refresh_ratings_daily(), 0, 'nobody is due right after');

-- ---------------------------------------------------------------------------
-- the Wrapped archive: a drive changed after the kept line computes the month again
-- ---------------------------------------------------------------------------
create temporary table e as select to_char(pg_temp.e_month(), 'YYYY-MM') as month;
grant select on e to authenticated;
select pg_temp.as_user(5);
set local role authenticated;
select is((select array[jsonb_array_length(l)::text, l -> 0 ->> 'month', l -> 0 ->> 'drives'] from (select public.list_my_wrapped() as l) x),
  array['1', (select month from e), '3'], 'e''s archive: the month two months back, 3 drives');
reset role;
update private.wrapped_archive set archetype = '{"style": "kept", "pattern": "kept"}' where user_id = '00000000-0000-0000-0000-000000000005';
set local role authenticated;
select is((select l -> 0 -> 'archetype' ->> 'style' from (select public.list_my_wrapped() as l) x), 'kept',
  'a line computed at or after the month''s last drive change is read, not computed');
reset role;
-- the line was computed a minute ago; an accepted report then removes the drive's hard brake and
-- the drive turns clean (trips_touch stamps it now), with the same drives and miles
update private.wrapped_archive set computed_at = now() - interval '1 minute' where user_id = '00000000-0000-0000-0000-000000000005';
update public.trip_events set status = 'removed' where user_id = '00000000-0000-0000-0000-000000000005';
update public.trips set n_events = 0, n_hard_brake = 0, clean = true where user_id = '00000000-0000-0000-0000-000000000005';
create temporary table want as
  select private.wrapped_stats('00000000-0000-0000-0000-000000000005', (select month from e)) -> 'archetype' as archetype;
grant select on want to authenticated;
set local role authenticated;
select is((select l -> 0 -> 'archetype' from (select public.list_my_wrapped() as l) x), (select archetype from want),
  'a drive changed after the line: the month is computed again, as its story shows it');
reset role;
select is((select array[(computed_at = now())::text, archetype::text] from private.wrapped_archive where user_id = '00000000-0000-0000-0000-000000000005'),
  array['true', (select archetype::text from want)], 'and kept again');

select * from finish();
rollback;
