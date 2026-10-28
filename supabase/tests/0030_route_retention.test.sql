-- 0030_route_retention: drives that ended more than 183 days ago lose their route and their events'
-- places; a kept, scored drive's route moves into the driver's route pool (a line with no date and no
-- drive), nothing else's does; every number the stats read stays, so the all-time sums are the same
-- after the job as before it; the job is idempotent and also deletes the wrong-limit places past the
-- 183 days; the pool is readable only through list_my_route_pool (the caller's own) and the export;
-- get_heatmap still serves the last 90 days and no pool line; deleting the account deletes its lines.
create extension if not exists pgtap with schema extensions;

begin;
select plan(43);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'usr' || right(id::text, 1), onboarded_at = now()
  where id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');

-- a stored drive ending at p_ended (30 minutes long, 12 mi): client_trip_id = id
create function pg_temp.trip(p_id uuid, p_user uuid, p_ended timestamptz, p_poly text, p_scored boolean default true,
  p_not_driving boolean default false, p_reason text default null, p_merged uuid default null) returns void
language sql as $$
  insert into public.trips (id, user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
      polyline, scored, reason, not_driving, merged_into, clean, n_events, n_speeding, n_dashcam, origin,
      slowdowns, speedups, turns, limit_s, moving_s)
    values (p_id, p_user, p_id, p_ended - interval '30 minutes', p_ended, (p_ended - interval '30 minutes')::date,
      private.league_week(p_ended - interval '30 minutes'), 'America/Los_Angeles', 12, 2, 1800,
      p_poly, p_scored, p_reason, p_not_driving, p_merged, p_scored and not p_not_driving, 1, 1, 0, 'auto',
      20, 20, 10, 1200, 1500);
$$;
create function pg_temp.t(p_id uuid) returns public.trips language sql stable as $$ select * from public.trips where id = p_id $$;

-- A: an old kept scored drive (a speeding event and a DashPal event, both with a place), an old
-- "Wasn't driving", an old unscored one, a leg merged into the first, one at 182 days and a recent one
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', now() - interval '200 days', 'A_OLD');
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000001', now() - interval '190 days', 'A_NOT_DRIVING', true, true);
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a3', '00000000-0000-0000-0000-000000000001', now() - interval '195 days', 'A_SHORT', false, false, 'too_short');
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a6', '00000000-0000-0000-0000-000000000001', now() - interval '201 days', 'A_MERGED', false, false, null,
  'a0000000-0000-4000-8000-0000000000a1');
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a5', '00000000-0000-0000-0000-000000000001', now() - interval '182 days', 'A_182');
select pg_temp.trip('a0000000-0000-4000-8000-0000000000a4', '00000000-0000-0000-0000-000000000001', now() - interval '10 days', 'A_RECENT');
-- B: an old scored drive and a recent one
select pg_temp.trip('b0000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000002', now() - interval '300 days', 'B_OLD');
select pg_temp.trip('b0000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000002', now() - interval '3 days', 'B_RECENT');

insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, lat, lng, measured) values
  ('a0000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'speeding', 'minor',
    now() - interval '200 days 20 minutes', 8, 47.6101, -122.3402, '{"speedMph": 41, "limitMph": 35, "overMphS": 9}'),
  ('a0000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'eyes_off', 'severe',
    now() - interval '200 days 10 minutes', 3, 47.6201, -122.3502, '{"source": "dashcam"}'),
  ('a0000000-0000-4000-8000-0000000000a4', 'e0000000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000001', 'hard_brake', 'minor',
    now() - interval '10 days 10 minutes', 2, 47.6001, -122.3002, '{"peakG": 0.5}');
-- wrong-limit places: one past the 183 days, one inside them
insert into public.map_feedback (lat, lng, limit_mph, speed_mph, created_at) values
  (47.6101, -122.3402, 35, 41, now() - interval '200 days'),
  (47.7101, -122.4402, 25, 33, now() - interval '20 days');

-- ---------------------------------------------------------------------------
-- the pool's shape, RLS and grants; the job's functions and schedule
-- ---------------------------------------------------------------------------
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'route_pool'),
  array['id', 'user_id', 'polyline'], 'the pool holds a random id, the driver and the line: no time, no drive, no order');
select has_column('public', 'trips', 'archived_at', 'trips say when a drive was archived');
select ok((select relrowsecurity from pg_class where oid = 'public.route_pool'::regclass), 'RLS is on for the pool');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'route_pool'), 0, 'with no policy: no row through the API');
select ok(not has_table_privilege('anon', 'public.route_pool', 'SELECT, INSERT, UPDATE, DELETE'), 'anon has no privilege on the pool');
select ok(not has_table_privilege('authenticated', 'public.route_pool', 'SELECT, INSERT, UPDATE, DELETE'), 'nor does a signed-in driver');
select is(private.route_retention(), interval '183 days', 'routes and places are kept 183 days');
select ok((select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid = 'private.archive_old_routes(int)'::regprocedure),
  'archive_old_routes runs as its owner with its search_path pinned');
select ok((select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid = 'private.archive_old_routes_daily()'::regprocedure),
  'so does the daily run');
select ok(not has_function_privilege('authenticated', 'private.archive_old_routes(int)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.archive_old_routes_daily()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.archive_old_routes_daily()', 'EXECUTE'), 'no API role runs the job');
select is((select array[schedule, command] from cron.job where jobname = 'route-archive'),
  array['10 4 * * *', 'select private.archive_old_routes_daily()'], 'the job runs daily at 04:10 UTC');
select ok(has_function_privilege('authenticated', 'public.list_my_route_pool(uuid, int)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_my_route_pool(uuid, int)', 'EXECUTE'), 'a signed-in driver reads their own pool; anon cannot');
select throws_ok($$ select private.archive_old_routes(0) $$, '22023', 'batch must be between 1 and 5000', 'the batch is bounded');

-- ---------------------------------------------------------------------------
-- the job
-- ---------------------------------------------------------------------------
create temporary table sums_before as select
  private.stat_sums('00000000-0000-0000-0000-000000000001', null) as a_all,
  private.stat_sums('00000000-0000-0000-0000-000000000001', now() - interval '365 days') as a_year,
  private.stat_sums('00000000-0000-0000-0000-000000000002', null) as b_all;

select is(private.archive_old_routes_daily(), 5, 'the five drives that ended more than 183 days ago are archived (A''s four, B''s one)');
select is((select array_agg(t.polyline = '' and t.archived_at is not null order by t.id) from public.trips t
    where t.id in ('a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-0000000000a3',
                   'a0000000-0000-4000-8000-0000000000a6', 'b0000000-0000-4000-8000-0000000000b1')),
  array[true, true, true, true, true], 'each has no route left and is stamped archived');
select is((select array[polyline, (archived_at is null)::text] from pg_temp.t('a0000000-0000-4000-8000-0000000000a5')), array['A_182', 'true'],
  'a drive that ended 182 days ago keeps its route');
select is((select array[polyline, (archived_at is null)::text] from pg_temp.t('a0000000-0000-4000-8000-0000000000a4')), array['A_RECENT', 'true'],
  'a recent drive keeps its route');
select is((select count(*)::int from public.trip_events where trip_id = 'a0000000-0000-4000-8000-0000000000a1' and (lat is not null or lng is not null)), 0,
  'the archived drive''s events keep no place, the DashPal one included');
select is((select array_agg(type || ':' || tier || ':' || measured::text order by started_at) from public.trip_events where trip_id = 'a0000000-0000-4000-8000-0000000000a1'),
  array['speeding:minor:{"limitMph": 35, "overMphS": 9, "speedMph": 41}', 'eyes_off:severe:{"source": "dashcam"}'],
  'and keep everything else: their type, tier and measurements');
select is((select array[lat, lng]::float8[] from public.trip_events where client_event_id = 'e0000000-0000-4000-8000-0000000000e3'),
  array[47.6001, -122.3002]::float8[], 'a recent drive''s event keeps its place');
select is((select array_agg(polyline order by polyline) from public.route_pool where user_id = '00000000-0000-0000-0000-000000000001'), array['A_OLD'],
  'A''s pool holds the kept scored drive''s route only (not "Wasn''t driving", unscored or merged away)');
select is((select array_agg(polyline) from public.route_pool where user_id = '00000000-0000-0000-0000-000000000002'), array['B_OLD'], 'B''s pool is B''s own');
select is((select array[private.stat_sums('00000000-0000-0000-0000-000000000001', null), private.stat_sums('00000000-0000-0000-0000-000000000001', now() - interval '365 days'),
      private.stat_sums('00000000-0000-0000-0000-000000000002', null)] from sums_before),
  (select array[a_all, a_year, b_all] from sums_before), 'every all-time and year sum is the same after the job as before it');
select is((select count(*)::int from public.map_feedback), 1, 'the wrong-limit place past the 183 days is deleted');
select is((select lat from public.map_feedback), 47.7101::float8, 'the one inside them stays');
select is(private.archive_old_routes_daily(), 0, 'a second run finds nothing to do');
select is((select count(*)::int from public.route_pool), 2, 'and pools nothing twice');

-- ---------------------------------------------------------------------------
-- what a driver reads
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select array[d -> 'archived', d -> 'polyline', d #> '{events,0,lat}', d #> '{events,0,lng}', d #> '{events,0,type}']
    from jsonb_array_elements(public.list_my_drives(null, 20)) d where d ->> 'tripId' = 'a0000000-0000-4000-8000-0000000000a1'),
  array['true', '""', 'null', 'null', '"speeding"']::jsonb[], 'list_my_drives: an archived drive says so, with no route and positionless events');
select is((select array[d -> 'archived', d -> 'polyline'] from jsonb_array_elements(public.list_my_drives(null, 20)) d
    where d ->> 'tripId' = 'a0000000-0000-4000-8000-0000000000a4'),
  array['false', '"A_RECENT"']::jsonb[], 'a recent drive is not archived');
select is((select d -> 'miles' from jsonb_array_elements(public.list_my_drives(null, 20)) d where d ->> 'tripId' = 'a0000000-0000-4000-8000-0000000000a1'),
  '12.00'::jsonb, 'an archived drive keeps its numbers');
select is((select array_agg(x ->> 'polyline') from jsonb_array_elements(public.list_my_route_pool()) x), array['A_OLD'], 'list_my_route_pool: the caller''s own lines');
select is((select array(select jsonb_object_keys(x) order by 1) from jsonb_array_elements(public.list_my_route_pool()) x), array['id', 'polyline'],
  'each with its random id and nothing else');
select is(public.list_my_route_pool((select (x ->> 'id')::uuid from jsonb_array_elements(public.list_my_route_pool()) x), 100), '[]'::jsonb,
  'the page after the last line is empty');
select throws_ok($$ select public.list_my_route_pool(null, 0) $$, '22023', 'limit must be between 1 and 200', 'the page size is bounded');
select is(public.get_heatmap('00000000-0000-0000-0000-000000000001'), '[{"polyline": "A_RECENT"}]'::jsonb,
  'get_heatmap still serves the last 90 days of routes, never a pool line');
select throws_ok($$ select * from public.route_pool $$, '42501', null, 'the pool cannot be read directly');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select array_agg(x ->> 'polyline') from jsonb_array_elements(public.list_my_route_pool()) x), array['B_OLD'], 'B reads B''s lines, never A''s');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.list_my_route_pool() $$, '42501', null, 'anon cannot read a pool');
reset role;

-- ---------------------------------------------------------------------------
-- the export, and deleting the account
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table ex as select public.export_account('00000000-0000-0000-0000-000000000001') as e;
select is((select e -> 'format_version' from ex), '5'::jsonb, 'the export is format 5');
select is((select e -> 'route_pool' from ex), '["A_OLD"]'::jsonb, 'with the driver''s pooled lines');
select is((select position('B_OLD' in e::text) from ex), 0, 'and nothing of another driver''s');
reset role;

delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.route_pool where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'deleting the account deletes its lines');
select is((select count(*)::int from public.route_pool), 1, 'and only its own');

select * from finish();
rollback;
