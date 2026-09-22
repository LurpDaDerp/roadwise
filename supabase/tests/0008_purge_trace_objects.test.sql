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
select plan(66);

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
    'public.trace_drive_ended_at(text)'::regprocedure,
    'public.purge_traces_signature(bigint, text)'::regprocedure, 'public.dispatch_purge_traces()'::regprocedure)
    and not p.prosecdef and p.proconfig = array['search_path=public']), 6,
  'the listings, the drive-end helper, the signature and the dispatcher are security invoker pinning exactly search_path=public');
select is(array[has_function_privilege('service_role', 'public.expired_trace_object_keys(integer, text)', 'execute'),
                has_function_privilege('service_role', 'public.underage_object_keys_after(integer, text, text)', 'execute'),
                has_function_privilege('service_role', 'public.underage_object_keys(integer)', 'execute'),
                has_function_privilege('service_role', 'public.clear_trace_paths(text[])', 'execute'),
                has_function_privilege('service_role', 'public.take_job_lease(text, uuid, integer)', 'execute'),
                has_function_privilege('service_role', 'public.release_job_lease(text, uuid)', 'execute')],
  array[true, true, true, true, true, true], 'service_role runs the listings, clear_trace_paths and the lease functions');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated']) r, unnest(array[
    'public.expired_trace_object_keys(integer, text)', 'public.underage_object_keys_after(integer, text, text)', 'public.underage_object_keys(integer)',
    'public.trace_drive_ended_at(text)', 'public.clear_trace_paths(text[])',
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
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  ('b8000000-0000-4000-8000-000000000001', 'late-trip', now() - interval '20 days', now() - interval '20 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  ('b8000000-0000-4000-8000-000000000001', 'recent-trip', now() - interval '2 days', now() - interval '2 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short');
insert into storage.objects (bucket_id, name, owner_id, created_at) values
  ('traces', 'b8000000-0000-4000-8000-000000000001/late-trip.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('traces', 'b8000000-0000-4000-8000-000000000001/recent-trip.bin.gz', 'b8000000-0000-4000-8000-000000000001', now() - interval '2 days');
set local role service_role;
select is((select array_agg(e->>'name' order by e->>'name') from jsonb_array_elements(public.expired_trace_object_keys(100, null)) e where e->>'name' like 'b8000000-0000-4000-8000-000000000001/%'),
  array['b8000000-0000-4000-8000-000000000001/late-trip.bin.gz'],
  'a late upload of a 20-day-old drive is past retention; a fresh upload of a 2-day-old drive is not');
reset role;

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
-- review B6 I1: never a nested loop comparing every object with every child; a hash or merge join
-- on the first path segment, or storage's own name_prefix_search index per child
select ok(pg_temp.plan_of($q$select o.bucket_id, o.name from public.profiles p join storage.objects o
    on split_part(o.name, '/', 1) = p.id::text and o.name ~>=~ (p.id::text || '/') and o.name ~<~ (p.id::text || '0')
    where p.age_band = 'u13'$q$) ~ '((Hash|Merge) Cond: \(+split_part\(o\.name|name_prefix_search)',
  'the child listing plans as a hash or merge join on the first segment, or an index scan on name_prefix_search');
set local enable_seqscan = off;
select ok(pg_temp.plan_of($q$select o.bucket_id, o.name from public.profiles p join storage.objects o
    on split_part(o.name, '/', 1) = p.id::text and o.name ~>=~ (p.id::text || '/') and o.name ~<~ (p.id::text || '0')
    where p.age_band = 'u13'$q$) like '%name_prefix_search%',
  'and name_prefix_search can serve it, one range per child, once the bucket is large');
reset enable_seqscan;

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

select * from finish();
rollback;
