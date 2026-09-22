-- 0008_purge_trace_objects: the listing of traces past the dispute window (by object metadata,
-- independent of trips rows), the job lease, dispatch_purge_traces and its cron job.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. now() is the transaction's start throughout, so "older" is simulated by
-- backdating an object's created_at. Local stack only: dispatch_purge_traces writes vault secrets
-- and queues a pg_net request inside the rolled-back transaction (pg_net's worker only ever sees
-- committed rows).
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0008_purge_trace_objects.test.sql runs only against the local Supabase stack';
  end if;
end $$;

begin;
select plan(90);

-- ---------------------------------------------------------------------------
-- fixtures (as the migration owner, with no JWT)
--   A adult with a live drive and its fresh trace; O an adult whose trips rows are gone but whose
--   15-day-old trace is still in the bucket (the orphan); C a blocked child's object; a second
--   bucket holding an old object the traces rule must never touch.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, email, raw_user_meta_data) values
  ('b8000000-0000-4000-8000-000000000001', 'a8@example.com', '{"display_name":"Ada"}'),
  ('b8000000-0000-4000-8000-000000000002', 'o8@example.com', '{"display_name":"Oz"}'),
  ('b8000000-0000-4000-8000-000000000003', 'c8@example.com', '{"display_name":"Cy"}');
update public.private_profiles set birth_date = date '1990-01-01' where user_id in ('b8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000002');
update public.private_profiles set birth_date = current_date - interval '10 years' where user_id = 'b8000000-0000-4000-8000-000000000003';

insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  ('b8000000-0000-4000-8000-000000000001', 'a-trip', now() - interval '1 day', now() - interval '1 day' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short');
update public.trips set trace_path = 'b8000000-0000-4000-8000-000000000001/a-trip.bin.gz' where client_trip_id = 'a-trip';

insert into storage.buckets (id, name, public) values ('b8-other', 'b8-other', false);
insert into storage.objects (bucket_id, name, owner_id, created_at) values
  ('traces', 'b8000000-0000-4000-8000-000000000001/a-trip.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('traces', 'b8000000-0000-4000-8000-000000000001/a-13d.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '13 days 23 hours'),
  ('traces', 'b8000000-0000-4000-8000-000000000002/orphan-2.bin.gz', 'b8000000-0000-4000-8000-000000000002', now() - interval '15 days'),
  ('traces', 'b8000000-0000-4000-8000-000000000002/orphan-1.bin.gz', 'b8000000-0000-4000-8000-000000000002', now() - interval '40 days'),
  ('b8-other', 'b8000000-0000-4000-8000-000000000001/old.bin', 'b8000000-0000-4000-8000-000000000001', now() - interval '90 days');

-- every table (outside vault and the catalogs) whose rows contain p_needle; a table postgres cannot
-- read is reported as unreadable:<name>
create function pg_temp.tables_containing(p_needle text) returns text[]
language plpgsql as $$
declare
  r record;
  n int;
  v_out text[] := '{}';
begin
  for r in select c.oid::regclass::text as t from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'm') and ns.nspname not in ('vault', 'pg_catalog', 'information_schema', 'pg_toast')
      and ns.nspname not like 'pg_temp%' loop
    begin
      execute format('select count(*) from %s x where x::text like %L', r.t, '%' || p_needle || '%') into n;
      if n > 0 then
        v_out := v_out || r.t;
      end if;
    exception when insufficient_privilege then
      v_out := v_out || ('unreadable:' || r.t);
    end;
  end loop;
  return v_out;
end $$;

-- the plan text of a query (EXPLAIN, no execution)
create function pg_temp.plan_of(p_sql text) returns text
language plpgsql as $$
declare
  r record;
  v text := '';
begin
  for r in execute 'explain ' || p_sql loop
    v := v || r."QUERY PLAN" || E'\n';
  end loop;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 1. structure, grants, hygiene
-- ---------------------------------------------------------------------------
select has_table('public', 'job_leases', 'job_leases exists');
select is((select relrowsecurity from pg_class where oid = 'public.job_leases'::regclass), true, 'RLS is enabled on job_leases');
select policies_are('public', 'job_leases', '{}'::name[], 'job_leases has no policies (server only)');
select table_privs_are('public', 'job_leases', 'anon', '{}'::name[], 'anon has no privileges on job_leases');
select table_privs_are('public', 'job_leases', 'authenticated', '{}'::name[], 'authenticated has no privileges on job_leases');
select table_privs_are('public', 'job_leases', 'service_role', '{}'::name[], 'service_role has no direct privileges on job_leases (only the lease functions)');
select has_trigger('public', 'job_leases', 'job_leases_touch', 'job_leases.updated_at is maintained');
select throws_ok($$ insert into public.job_leases (job, holder, expires_at) values ('Bad Name', gen_random_uuid(), now()) $$, '23514', null,
  'a job name outside the pattern is refused by the table');

select is((select count(*)::int from pg_proc p where p.oid in ('public.take_job_lease(text, uuid, integer)'::regprocedure, 'public.release_job_lease(text, uuid)'::regprocedure,
    'public.clear_trace_paths(text[])'::regprocedure)
    and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public']), 3,
  'the lease functions and clear_trace_paths are security definer, owned by postgres, pinning exactly search_path=public');
select is((select count(*)::int from pg_proc p where p.oid in ('public.expired_trace_object_keys(integer, text)'::regprocedure,
    'public.underage_object_keys_after(integer, text, text)'::regprocedure, 'public.underage_object_keys(integer)'::regprocedure,
    'public.purge_traces_signature(bigint, text)'::regprocedure, 'public.dispatch_purge_traces()'::regprocedure,
    'public.stamp_scored_without_trace()'::regprocedure)
    and not p.prosecdef and p.proconfig = array['search_path=public']), 6,
  'the listings, the signature, the dispatcher and the flag trigger are security invoker pinning exactly search_path=public');
select is(array[has_function_privilege('service_role', 'public.expired_trace_object_keys(integer, text)', 'execute'),
                has_function_privilege('service_role', 'public.underage_object_keys_after(integer, text, text)', 'execute'),
                has_function_privilege('service_role', 'public.underage_object_keys(integer)', 'execute'),
                has_function_privilege('service_role', 'public.clear_trace_paths(text[])', 'execute'),
                has_function_privilege('service_role', 'public.take_job_lease(text, uuid, integer)', 'execute'),
                has_function_privilege('service_role', 'public.release_job_lease(text, uuid)', 'execute')],
  array[true, true, true, true, true, true], 'service_role runs the listings, clear_trace_paths and the lease functions');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated']) r, unnest(array[
    'public.expired_trace_object_keys(integer, text)', 'public.underage_object_keys_after(integer, text, text)', 'public.underage_object_keys(integer)',
    'public.clear_trace_paths(text[])', 'public.stamp_scored_without_trace()',
    'public.take_job_lease(text, uuid, integer)', 'public.release_job_lease(text, uuid)',
    'public.purge_traces_signature(bigint, text)', 'public.dispatch_purge_traces()']) f),
  false, 'anon and authenticated execute nothing this migration creates or replaces');
select has_index('public', 'profiles', 'profiles_u13_idx', 'the u13 side of the child listing is a partial index');
select is(array[has_function_privilege('service_role', 'public.dispatch_purge_traces()', 'execute'),
                has_function_privilege('service_role', 'public.purge_traces_signature(bigint, text)', 'execute')],
  array[false, false], 'service_role runs neither the dispatcher nor the signature');
select is((select row(schedule, command, username)::text from cron.job where jobname = 'purge-trace-objects'),
  row('*/15 * * * *', 'select public.dispatch_purge_traces()', 'postgres')::text, 'pg_cron wakes the purge every 15 minutes as postgres');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe8 (id int);
create function public.zz_probe8_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe8', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe8_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe8_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe8_fn();
drop table public.zz_probe8;

-- ---------------------------------------------------------------------------
-- 2. the listing: traces past 14 days, by metadata, whether or not a trips row exists
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.expired_trace_object_keys(10, null) $$, '42501', 'expired_trace_object_keys requires the service role',
  'no JWT: the listing refuses first');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b8000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.expired_trace_object_keys(10, null) $$, '42501', null, 'authenticated cannot list');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.expired_trace_object_keys(0, null) $$, '22023', 'limit must be between 1 and 1000', 'a limit of 0 is refused');
select throws_ok($$ select public.expired_trace_object_keys(1001, null) $$, '22023', 'limit must be between 1 and 1000', 'a limit over 1000 is refused');
select throws_ok($$ select public.expired_trace_object_keys(null, null) $$, '22023', 'limit must be between 1 and 1000', 'a null limit is refused');
select is(public.expired_trace_object_keys(100, null),
  '[{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000002/orphan-1.bin.gz"},{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000002/orphan-2.bin.gz"}]'::jsonb,
  'exactly the traces past 14 days, in name order: no fresh or 13-day trace, nothing from another bucket');
select is((select count(*)::int from public.trips where user_id = 'b8000000-0000-4000-8000-000000000002'), 0,
  'and the orphan''s owner has no trips row at all: found by object metadata alone');
select is(public.expired_trace_object_keys(1, null), '[{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000002/orphan-1.bin.gz"}]'::jsonb,
  'the limit bounds a batch, in name order');
select is(public.expired_trace_object_keys(100, 'b8000000-0000-4000-8000-000000000002/orphan-1.bin.gz'),
  '[{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000002/orphan-2.bin.gz"}]'::jsonb,
  'the cursor moves past a key, so a key that cannot be removed never stalls the list (M-1)');
reset role;
-- A's live drive is past the window too once its trace is: the metadata decides, not the row
update storage.objects set created_at = now() - interval '14 days 1 minute' where name = 'b8000000-0000-4000-8000-000000000001/a-trip.bin.gz';
set local role service_role;
select is(jsonb_array_length(public.expired_trace_object_keys(100, null)), 3, 'a trace with a live trips row is listed once it passes 14 days too');
reset role;
update storage.objects set created_at = now() - interval '1 day' where name = 'b8000000-0000-4000-8000-000000000001/a-trip.bin.gz';

-- retention counts from the DRIVE when a trips row exists (M-2): a trace uploaded 2 days ago of a
-- drive that ended 20 days ago is past retention; one uploaded 2 days ago of a 2-day-old drive is not
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason, trace_path) values
  ('b8000000-0000-4000-8000-000000000001', 'late-trip', now() - interval '20 days', now() - interval '20 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short',
    'b8000000-0000-4000-8000-000000000001/late-trip.bin.gz'),
  ('b8000000-0000-4000-8000-000000000001', 'recent-trip', now() - interval '2 days', now() - interval '2 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short',
    'b8000000-0000-4000-8000-000000000001/recent-trip.bin.gz');
insert into storage.objects (bucket_id, name, owner_id, created_at) values
  ('traces', 'b8000000-0000-4000-8000-000000000001/late-trip.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('traces', 'b8000000-0000-4000-8000-000000000001/recent-trip.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '2 days');
set local role service_role;
select is((select array_agg(e->>'name' order by e->>'name') from jsonb_array_elements(public.expired_trace_object_keys(100, null)) e where e->>'name' like 'b8000000-0000-4000-8000-000000000001/%'),
  array['b8000000-0000-4000-8000-000000000001/late-trip.bin.gz'],
  'a late upload of a 20-day-old drive is past retention; a fresh upload of a 2-day-old drive is not');
select is(jsonb_array_length(public.expired_trace_object_keys(100, null)),
  (select count(distinct e->>'name')::int from jsonb_array_elements(public.expired_trace_object_keys(100, null)) e),
  'an object both old and named by an old drive is listed once (the union is deduplicated)');
reset role;

-- review B6 r1 n1: the steady-state probe and the listing make no trips lookup per object
select has_index('public', 'trips', 'trips_trace_expiry_idx', 'half (b) reads trips past retention through a partial index');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'trace_drive_ended_at'), 0,
  'the per-object drive-end helper is gone');
select ok(pg_get_functiondef('public.dispatch_purge_traces()'::regprocedure) ~ 'split_part\(o\.name, ''/'', 1\) = p\.id::text'
      and pg_get_functiondef('public.dispatch_purge_traces()'::regprocedure) ~ 'o\.name ~>=~ \(p\.id::text \|\| ''/''\) and o\.name ~<~ \(p\.id::text \|\| ''0''\)',
  'the dispatcher''s child probe joins on the first path segment beside the byte range (review B6 r2 n4)');
select ok(pg_get_functiondef('public.dispatch_purge_traces()'::regprocedure) !~* ' like ',
  'and uses no LIKE');
select ok(pg_get_functiondef('public.dispatch_purge_traces()'::regprocedure) !~ 'trips t\s+where t\.user_id'
      and pg_get_functiondef('public.expired_trace_object_keys(integer, text)'::regprocedure) !~ 'trace_drive_ended_at',
  'neither the probe nor the listing looks a drive up per object');
select ok(pg_temp.plan_of($q$select 1 from storage.objects o where o.bucket_id = 'traces' and o.created_at < now() - interval '14 days'$q$) !~ 'trips',
  'half (a) of the probe is a filter on the bucket alone');
select is(pg_get_indexdef('public.trips_trace_expiry_idx'::regclass),
  'CREATE INDEX trips_trace_expiry_idx ON public.trips USING btree (ended_at) WHERE (trace_path IS NOT NULL)',
  'half (b) reads trips past retention through (ended_at) where trace_path is not null');

-- the other list the function deletes: 0006's, every bucket, a blocked child's prefix
insert into storage.objects (bucket_id, name, owner_id) values
  ('traces', 'b8000000-0000-4000-8000-000000000003/c-trip.bin.gz', 'b8000000-0000-4000-8000-000000000003'),
  ('b8-other', 'b8000000-0000-4000-8000-000000000003/avatar.png', 'b8000000-0000-4000-8000-000000000003'),
  -- look-alikes a careless prefix match would take: a longer first segment, and no folder at all
  ('traces', 'b8000000-0000-4000-8000-000000000003x/not-the-child.bin.gz', 'b8000000-0000-4000-8000-000000000001'),
  ('traces', 'b8000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000001');
set local role service_role;
select is(public.underage_object_keys(100),
  '[{"bucket":"b8-other","name":"b8000000-0000-4000-8000-000000000003/avatar.png"},{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000003/c-trip.bin.gz"}]'::jsonb,
  'underage_object_keys (0006''s, replaced) lists the child''s objects in every bucket and no look-alike prefix');
select is(public.underage_object_keys_after(100, 'b8-other', 'b8000000-0000-4000-8000-000000000003/avatar.png'),
  '[{"bucket":"traces","name":"b8000000-0000-4000-8000-000000000003/c-trip.bin.gz"}]'::jsonb, 'its cursor moves past (bucket, name)');
select throws_ok($$ select public.underage_object_keys_after(100, 'traces', null) $$, '22023', 'a cursor needs both its bucket and its name',
  'half a cursor is refused');
select throws_ok($$ select public.underage_object_keys_after(1001, null, null) $$, '22023', 'limit must be between 1 and 1000', 'its limit is bounded');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.underage_object_keys_after(10, null, null) $$, '42501', 'underage_object_keys_after requires the service role',
  'no JWT: the child listing refuses first');
-- review B6 I1: never a LIKE built per row (one comparison per object per child). The join is on
-- the first path segment, which a hash or merge join can use, beside a byte range per child that
-- storage's name_prefix_search index serves. Plans on the fixture's handful of rows depend on the
-- statistics, so the shape is read from the definition and the index from a constant range; the
-- report carries EXPLAIN ANALYZE at 60 000 objects.
select ok(pg_get_functiondef('public.underage_object_keys_after(integer, text, text)'::regprocedure) ~ 'split_part\(o\.name, ''/'', 1\) = p\.id::text'
      and pg_get_functiondef('public.underage_object_keys_after(integer, text, text)'::regprocedure) ~ 'o\.name ~>=~ \(p\.id::text \|\| ''/''\) and o\.name ~<~ \(p\.id::text \|\| ''0''\)'
      and pg_get_functiondef('public.underage_object_keys_after(integer, text, text)'::regprocedure) !~* ' like ',
  'the child listing joins on the first path segment beside a byte range, and uses no LIKE');
select is((select array_agg(c.opcname::text) from pg_index i join pg_opclass c on c.oid = any(i.indclass::oid[])
    where i.indexrelid = 'storage.name_prefix_search'::regclass), array['text_pattern_ops'],
  'and storage''s name_prefix_search is text_pattern_ops, so each child''s ~>=~ / ~<~ byte range is an index condition');

-- after a delete: the trips row stops naming the trace (ruling B6 retention)
select throws_ok($$ select public.clear_trace_paths(array['b8000000-0000-4000-8000-000000000001/a-trip.bin.gz']) $$, '42501',
  'clear_trace_paths requires the service role', 'no JWT: clear_trace_paths refuses first');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.clear_trace_paths(null) $$, '22023', 'clear_trace_paths takes at most 1000 keys', 'a null list is refused');
select throws_ok($$ select public.clear_trace_paths(array_fill('b8000000-0000-4000-8000-000000000001/a-trip.bin.gz'::text, array[1001])) $$, '22023',
  'clear_trace_paths takes at most 1000 keys', 'more than 1000 keys are refused');
select throws_ok($$ select public.clear_trace_paths(array['../b8000000-0000-4000-8000-000000000001/a-trip.bin.gz']) $$, '22023',
  'clear_trace_paths keys must be trace keys', 'a key that is not a trace key is refused');
select is(public.clear_trace_paths(array['b8000000-0000-4000-8000-000000000001/a-trip.bin.gz', 'b8000000-0000-4000-8000-000000000002/orphan-1.bin.gz']), 1,
  'the live trip''s trace_path is cleared; an orphan''s key clears nothing');
reset role;
select is((select trace_path from public.trips where client_trip_id = 'a-trip'), null, 'the trips row no longer names the deleted trace');
set local role service_role;
select is(public.clear_trace_paths(array['b8000000-0000-4000-8000-000000000001/a-trip.bin.gz']), 0, 'clearing again is a no-op (idempotent)');
reset role;

-- ---------------------------------------------------------------------------
-- trips.scored_without_trace (ruling B6 r2): the recording as it was scored
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select has_column('public', 'trips', 'scored_without_trace', 'trips carries scored_without_trace');
select col_type_is('public', 'trips', 'scored_without_trace', 'boolean', 'it is a boolean');
select col_not_null('public', 'trips', 'scored_without_trace', 'it is never null');
select col_default_is('public', 'trips', 'scored_without_trace', 'false', 'it defaults to false');
select column_privs_are('public', 'trips', 'scored_without_trace', 'authenticated', array['SELECT']::name[], 'a client may read it and never write it');
select column_privs_are('public', 'trips', 'scored_without_trace', 'anon', '{}'::name[], 'anon has nothing on it');
select has_trigger('public', 'trips', 'trips_scored_without_trace', 'a trigger stamps it for every writer');

-- the backfill: the migration's own statement, run again over rows that predate the column
select ok((select min(u.idx) filter (where u.st ~ 'update public\.trips set scored_without_trace = \(trace_path is null\)')
         < least(min(u.idx) filter (where u.st ~ 'create trigger trips_scored_without_trace'),
                 min(u.idx) filter (where u.st ~ 'create or replace function public\.clear_trace_paths'))
    from supabase_migrations.schema_migrations m, unnest(m.statements) with ordinality as u(st, idx) where m.version = '0008'),
  'the backfill runs before the flag is pinned and before anything in 0008 can clear a path');
alter table public.trips disable trigger trips_scored_without_trace;
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason, trace_path) values
  ('b8000000-0000-4000-8000-000000000001', 'old-untraced', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short', null),
  ('b8000000-0000-4000-8000-000000000001', 'old-traced', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short',
    'b8000000-0000-4000-8000-000000000001/old-traced.bin.gz');
update public.trips set scored_without_trace = false where client_trip_id in ('old-untraced', 'old-traced');
do $$
begin
  execute (select substring(u.st from 'update public\.trips set scored_without_trace[^;]*')
           from supabase_migrations.schema_migrations m, unnest(m.statements) u(st)
           where m.version = '0008' and u.st ~ 'update public\.trips set scored_without_trace' limit 1);
end $$;
alter table public.trips enable trigger trips_scored_without_trace;
select is((select array_agg(client_trip_id || ':' || scored_without_trace order by client_trip_id) from public.trips where client_trip_id in ('old-untraced', 'old-traced')),
  array['old-traced:false', 'old-untraced:true'], 'the backfill sets the flag from trace_path for rows that predate it');

-- apply_trip stamps it from the payload on insert (parity with finalize-trip's no_trace: tracePath null)
create function pg_temp.envelope(p_client text, p_trace boolean) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', 'b8000000-0000-4000-8000-000000000001',
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from now() - interval '2 days') * 1000)::bigint,
      'endedAt', floor(extract(epoch from now() - interval '2 days' + interval '15 minutes') * 1000)::bigint,
      'tz', 'UTC', 'distanceM', 12500.5, 'durationS', 900,
      'role', 'driver', 'roleConfidence', null, 'roleSource', 'manual', 'mode', 'mounted', 'cameraSession', false,
      'events', '[]'::jsonb,
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true, 'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb', 'polyline', '_p~iF~ps|U',
      'tracePath', case when p_trace then p_client || '.bin.gz' end,
      'hadSevereEvent', false, 'incomplete', false),
    'scored', jsonb_build_object('score', 80, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":20,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', '{}'::jsonb, 'scoringVersion', 1),
    'day', jsonb_build_object('day', ((now() - interval '2 days') at time zone 'UTC')::date,
      'longTermScore', 80, 'band', 'good', 'provisional', false, 'safeDay', false, 'goodDay', true, 'phoneFreeDay', true,
      'cameraDay', false, 'exposure', 1.25, 'drivingS', 900, 'tripsScored', 1, 'severeEvents', 0),
    'baselines', jsonb_build_object('medians', '{"speeding": 1.2}'::jsonb))
$$;
create temp table fx8 (name text primary key, p jsonb not null);
insert into fx8 values ('traced', pg_temp.envelope('flag-traced', true)), ('untraced', pg_temp.envelope('flag-untraced', false));
grant select on fx8 to service_role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$ select public.apply_trip((select p from fx8 where name = 'traced')) $$, 'a traced drive is stored');
select lives_ok($$ select public.apply_trip((select p from fx8 where name = 'untraced')) $$, 'an untraced drive is stored');
reset role;
select is((select array_agg(client_trip_id || ':' || scored_without_trace || ':' || (trace_path is null) order by client_trip_id)
    from public.trips where client_trip_id in ('flag-traced', 'flag-untraced')),
  array['flag-traced:false:false', 'flag-untraced:true:true'],
  'apply_trip stores scored_without_trace = (payload tracePath is null), the condition finalize-trip downgrades on');

-- it never flips: not when the purge clears the path, not for any later writer
set local role service_role;
select is(public.clear_trace_paths(array['b8000000-0000-4000-8000-000000000001/flag-traced.bin.gz']), 1, 'the purge clears the traced drive''s path');
reset role;
select is((select row(trace_path is null, scored_without_trace)::text from public.trips where client_trip_id = 'flag-traced'), row(true, false)::text,
  'clear_trace_paths leaves scored_without_trace alone: the drive was scored with its trace');
update public.trips set scored_without_trace = true where client_trip_id = 'flag-traced';
update public.trips set scored_without_trace = false, trace_path = null where client_trip_id = 'flag-untraced';
select is((select array_agg(client_trip_id || ':' || scored_without_trace order by client_trip_id) from public.trips where client_trip_id in ('flag-traced', 'flag-untraced')),
  array['flag-traced:false', 'flag-untraced:true'], 'no later update, even the owner''s, flips it either way');
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 3. the lease
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.take_job_lease('purge-trace-objects', gen_random_uuid(), 600) $$, '42501', 'take_job_lease requires the service role',
  'no JWT: the lease refuses first');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.take_job_lease('Bad Name', gen_random_uuid(), 600) $$, '22023', 'job must be a job name', 'a bad job name is refused');
select throws_ok($$ select public.take_job_lease('purge-trace-objects', null, 600) $$, '22023', 'holder is required', 'a missing holder is refused');
select throws_ok($$ select public.take_job_lease('purge-trace-objects', gen_random_uuid(), 29) $$, '22023', 'lease must be between 30 and 3600 seconds', 'a lease under 30 s is refused');
select throws_ok($$ select public.take_job_lease('purge-trace-objects', gen_random_uuid(), 3601) $$, '22023', 'lease must be between 30 and 3600 seconds', 'a lease over an hour is refused');
select is(public.take_job_lease('purge-trace-objects', 'a0000000-0000-4000-8000-00000000000a', 600), true, 'the first run takes the lease');
select is(public.take_job_lease('purge-trace-objects', 'b0000000-0000-4000-8000-00000000000b', 600), false, 'a second run while it is held does not');
select is(public.release_job_lease('purge-trace-objects', 'b0000000-0000-4000-8000-00000000000b'), false, 'another holder cannot release it');
select is(public.release_job_lease('purge-trace-objects', 'a0000000-0000-4000-8000-00000000000a'), true, 'its holder releases it');
select is(public.take_job_lease('purge-trace-objects', 'b0000000-0000-4000-8000-00000000000b', 600), true, 'then the next run takes it');
reset role;
update public.job_leases set expires_at = now() - interval '1 second' where job = 'purge-trace-objects';
set local role service_role;
select is(public.take_job_lease('purge-trace-objects', 'c0000000-0000-4000-8000-00000000000c', 600), true, 'a crashed run''s expired lease is taken over');
reset role;
select is((select holder from public.job_leases where job = 'purge-trace-objects'), 'c0000000-0000-4000-8000-00000000000c'::uuid, 'by the new holder');
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 4. the signature (the contract purge-trace-objects verifies) and the dispatcher
-- ---------------------------------------------------------------------------
select is(public.purge_traces_signature(1790000000, 'rw-test-vector-key-0123456789abcdef'),
  '1790000000.b1d7bb3aa71f004baa5812ff8e039210f30da2d2e7c40a38e735c4364c5f09a3',
  'the signature matches an independently computed HMAC-SHA256 test vector');
select isnt(public.purge_traces_signature(1790000000, 'rw-test-vector-key-0123456789abcdef'),
  public.push_sweep_signature(1790000000, 'rw-test-vector-key-0123456789abcdef'),
  'its purpose string differs from push-sender''s, so neither signature replays against the other function');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.dispatch_purge_traces() $$, '42501', null, 'service_role cannot run the dispatcher');
reset role;
select set_config('request.jwt.claims', '', true);
select is(public.dispatch_purge_traces(), 'unconfigured', 'no vault secrets: unconfigured');
select vault.create_secret('http://purge.test/functions/v1/purge-trace-objects', 'purge_traces_url');
select is(public.dispatch_purge_traces(), 'unconfigured', 'a URL without a key: still unconfigured');
select vault.create_secret('too-short-key', 'purge_traces_hmac_key');
select is(public.dispatch_purge_traces(), 'unconfigured', 'a key shorter than 32 bytes: still unconfigured');
select vault.update_secret((select id from vault.secrets where name = 'purge_traces_hmac_key'), 'hmac-0008-4e2a9c7d1b3f5a6e8d0c2b4a69788766');
create temp table q0 as select coalesce(max(id), 0) as id from net.http_request_queue;
select is(public.dispatch_purge_traces(), 'dispatched', 'old traces and a blocked child''s object: dispatched');
select is((select array_agg(row(method, url, headers, convert_from(body, 'UTF8')::jsonb, timeout_milliseconds)::text) from net.http_request_queue where id > (select id from q0)),
  array[row('POST', 'http://purge.test/functions/v1/purge-trace-objects',
    jsonb_build_object('Content-Type', 'application/json', 'X-Sweep-Signature',
      floor(extract(epoch from now()))::bigint::text || '.' || encode(extensions.hmac('purge-trace-objects:' || floor(extract(epoch from now()))::bigint::text,
        'hmac-0008-4e2a9c7d1b3f5a6e8d0c2b4a69788766', 'sha256'), 'hex')), '{"reason":"sweep"}'::jsonb, 10000)::text],
  'one POST to the vault URL with a timestamped HMAC signature (no key, no Authorization), a sweep body and a 10 s timeout');
select is(pg_temp.tables_containing('hmac-0008-4e2a9c7d1b3f5a6e8d0c2b4a69788766'), '{}'::text[],
  'the key appears in no table outside Vault (the request queue and the cron log included)');
-- with the old traces gone and the child released, there is nothing to do
-- (SQL cannot delete an object: storage.protect_delete; the fixtures are made young again instead)
update storage.objects set created_at = now() where bucket_id = 'traces' and created_at < now() - interval '14 days';
update public.trips set started_at = now() - interval '20 minutes', ended_at = now() - interval '10 minutes' where client_trip_id = 'late-trip';
select is(public.dispatch_purge_traces(), 'dispatched', 'a blocked child''s object alone still dispatches');
update public.profiles set age_band = '18_plus' where id = 'b8000000-0000-4000-8000-000000000003';
select is(public.dispatch_purge_traces(), 'idle', 'nothing past 14 days and no blocked child''s object: idle');

-- final review m8: this migration's purge is the one retention mechanism
select hasnt_function('public', 'expire_trace_objects', array['interval', 'integer'],
  '0002''s unscheduled expire_trace_objects is dropped: 0008''s purge is the one trace retention mechanism');
select * from finish();
rollback;
