-- 0012_family: family groups, join codes, location sharing (off by default, one overwritten row, 24 h),
-- family places, the admin handover and dissolution, the account cascade and the under-13 minimisation.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file runnable
-- alone. Section 0 opens real sessions over dblink (test-only, local-only guard, dropped at the end) and
-- calls every client write path as the first statement of a fresh session; its fixtures are committed
-- and deleted again (a run that dies midway leaves them, and the next run deletes them first).
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0012_family.test.sql runs only against the local Supabase stack';
  end if;
  create extension if not exists dblink with schema extensions;
end $$;

begin;
select plan(107);

-- ---------------------------------------------------------------------------
-- builders
-- ---------------------------------------------------------------------------
create function pg_temp.u(n int) returns uuid language sql immutable as $$
  select ('c9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.mkuser(n int, p_birth date default date '1990-01-01') returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email, created_at) values (pg_temp.u(n), 'r9-' || n || '@example.com', now());
  update public.private_profiles set birth_date = p_birth where user_id = pg_temp.u(n);
  return pg_temp.u(n);
end $$;
create function pg_temp.conn() returns text language sql as $$
  select 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
$$;
create function pg_temp.remote(p_conn text, p_sql text) returns text language plpgsql as $$
begin
  return extensions.dblink_exec(p_conn, p_sql);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- one fresh connection signed in as F: p_sql's first row, or the error; rolled back, disconnected
create function pg_temp.fresh_client(p_sql text, p_exec boolean default false) returns text language plpgsql as $$
declare
  v text;
begin
  perform extensions.dblink_connect('rw12_client', pg_temp.conn());
  perform extensions.dblink_exec('rw12_client', $q$begin; set local role authenticated;
    set local request.jwt.claims = '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000901"}'$q$);
  begin
    if p_exec then
      v := extensions.dblink_exec('rw12_client', p_sql);
    else
      select r into v from extensions.dblink('rw12_client', p_sql) as t(r text);
    end if;
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  perform extensions.dblink_exec('rw12_client', 'rollback');
  perform extensions.dblink_disconnect('rw12_client');
  return v;
end $$;

-- redemption happens now (real time), so qualifying drives are on the days after today, and settlement
-- runs ten days on

-- a call as p_user (the RPCs are definers: auth.uid() comes from the claims); '' for a void result
create function pg_temp.run(p_user uuid, p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
  execute p_sql into v;
  perform set_config('request.jwt.claims', '', true);
  return coalesce(v, '');
end $$;
create function pg_temp.refusal(p_code text, p_message text) returns jsonb language sql immutable as $$
  select jsonb_build_object('code', p_code, 'details', null, 'hint', null, 'message', p_message)
$$;
create function pg_temp.fam(p_user uuid) returns uuid language sql as $$ select family_id from public.family_members where user_id = p_user $$;
create function pg_temp.code(p_family uuid) returns text language sql as $$ select code from public.families where id = p_family $$;
create function pg_temp.snap(p_user uuid) returns jsonb language sql as $$
  select pg_temp.run(p_user, 'select public.family_snapshot()::text')::jsonb
$$;
create function pg_temp.budget(p_user uuid) returns int language sql as $$
  select coalesce((select count from public.rate_limits where user_id = p_user and key = 'family_join'), 0)
$$;

-- ---------------------------------------------------------------------------
-- 0. fresh sessions (dblink): every client write path as the first statement of its own session
-- ---------------------------------------------------------------------------
select extensions.dblink_connect('rw12_pg', pg_temp.conn());
select extensions.dblink_exec('rw12_pg', $q$delete from auth.users where id in ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select extensions.dblink_exec('rw12_pg', $q$insert into auth.users (id, email, created_at) values ('c9000000-0000-4000-8000-000000000901', 'f12-a@example.com', now()),
  ('c9000000-0000-4000-8000-000000000902', 'f12-b@example.com', now())$q$);
select extensions.dblink_exec('rw12_pg', $q$update public.private_profiles set birth_date = date '1990-01-01' where user_id in
  ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select extensions.dblink_exec('rw12_pg', $q$insert into public.families (id, name, code, code_expires_at)
  values ('c1200000-0000-4000-8000-000000000001', 'Fresh', 'ABCD23', now() + interval '7 days')$q$);
select extensions.dblink_exec('rw12_pg', $q$insert into public.family_members (family_id, user_id, role)
  values ('c1200000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000902', 'admin')$q$);
select is(pg_temp.fresh_client($q$select public.family_snapshot()::text$q$)::jsonb, '{"family": null}'::jsonb,
  'family_snapshot succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.create_family('Fresh two')::text$q$)::jsonb ? 'familyId', true,
  'create_family succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.join_family('abcd-23')::text$q$)::jsonb,
  '{"familyId": "c1200000-0000-4000-8000-000000000001"}'::jsonb, 'join_family succeeds as the first statement of a fresh session');
-- 901 joins for the rest, as the admin; 902 becomes a member who shares
select extensions.dblink_exec('rw12_pg', $q$update public.family_members set role = 'member', sharing_location = true
  where user_id = 'c9000000-0000-4000-8000-000000000902'$q$);
select extensions.dblink_exec('rw12_pg', $q$insert into public.family_members (family_id, user_id, role, sharing_location)
  values ('c1200000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000901', 'admin', true)$q$);
select extensions.dblink_exec('rw12_pg', $q$insert into public.family_places (id, family_id, name, lat, lng)
  values ('c1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000001', 'School', 47.6, -122.3)$q$);
select is(pg_temp.fresh_client($q$do $d$ begin perform public.set_location_sharing(false); end $d$$q$, true), 'DO',
  'set_location_sharing succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.post_my_location(47.61, -122.33, 12, false)::text$q$)::jsonb, '{"accepted": true}'::jsonb,
  'post_my_location succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.save_family_place(null, 'Home', '1 Main St', 47.6, -122.3, 150)::text$q$)::jsonb ? 'id', true,
  'save_family_place succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$do $d$ begin perform public.delete_family_place('c1200000-0000-4000-8000-000000000002'); end $d$$q$, true), 'DO',
  'delete_family_place succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.rotate_family_code()::text$q$)::jsonb ->> 'code' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', true,
  'rotate_family_code succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$do $d$ begin perform public.remove_family_member('c9000000-0000-4000-8000-000000000902'); end $d$$q$, true), 'DO',
  'remove_family_member succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$do $d$ begin perform public.leave_family(); end $d$$q$, true), 'DO',
  'leave_family succeeds as the first statement of a fresh session');
select extensions.dblink_exec('rw12_pg', $q$delete from public.families where id = 'c1200000-0000-4000-8000-000000000001'$q$);
select extensions.dblink_exec('rw12_pg', $q$delete from auth.users where id in ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select is((select n from extensions.dblink('rw12_pg', $q$select (select count(*) from auth.users where id::text like 'c9000000-0000-4000-8000-00000000090_')::int
    + (select count(*) from public.families where name like 'Fresh%')::int$q$) as t(n int)), 0, 'the committed fixtures are gone again');
select extensions.dblink_disconnect('rw12_pg');

-- ---------------------------------------------------------------------------
-- 1. structure and conventions
-- ---------------------------------------------------------------------------
select columns_are('public', 'families', array['id', 'name', 'code', 'code_expires_at', 'created_at', 'updated_at']::name[], 'families has exactly its columns (no user reference)');
select columns_are('public', 'family_members', array['family_id', 'user_id', 'role', 'sharing_location', 'created_at', 'updated_at']::name[],
  'family_members has exactly its columns');
select columns_are('public', 'member_locations', array['user_id', 'lat', 'lng', 'accuracy_m', 'driving', 'updated_at']::name[],
  'member_locations has exactly its columns: one row per person, no history');
select columns_are('public', 'family_places', array['id', 'family_id', 'name', 'address', 'lat', 'lng', 'radius_m', 'created_at', 'updated_at']::name[],
  'family_places has exactly its columns');
select policies_are('public', 'families', '{}'::name[], 'families: no policy');
select policies_are('public', 'family_members', '{}'::name[], 'family_members: no policy');
select policies_are('public', 'member_locations', '{}'::name[], 'member_locations: no policy');
select policies_are('public', 'family_places', '{}'::name[], 'family_places: no policy');
select is((select count(*)::int from unnest(array['families', 'family_members', 'member_locations', 'family_places']) t,
    unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege(r, ('public.' || t)::regclass, p)), 0,
  'no API role, the service role included, holds any privilege on the four family tables');
select has_index('public', 'member_locations', 'member_locations_updated_idx', 'member_locations (updated_at), the purge''s scan');
select has_index('public', 'family_places', 'family_places_family_idx', 'family_places (family_id)');
select col_is_unique('public', 'family_members', 'user_id', 'one family per person');
select col_is_unique('public', 'families', 'code', 'codes are unique');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'
    and tablename in ('families', 'family_members', 'member_locations', 'family_places')), 0, 'no family table is in the Realtime publication');
select is((select count(*)::int from pg_proc p where p.oid in ('public.create_family(text)'::regprocedure, 'public.join_family(text)'::regprocedure,
    'public.leave_family()'::regprocedure, 'public.remove_family_member(uuid)'::regprocedure, 'public.rotate_family_code()'::regprocedure,
    'public.set_location_sharing(boolean)'::regprocedure, 'public.post_my_location(double precision, double precision, real, boolean)'::regprocedure,
    'public.family_snapshot()'::regprocedure, 'public.save_family_place(uuid, text, text, double precision, double precision, int)'::regprocedure,
    'public.delete_family_place(uuid)'::regprocedure)
    and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public', 'lock_timeout=2s']), 10,
  'the ten RPCs are definer, owned by postgres, proconfig exactly search_path=public, lock_timeout=2s');
select is((select count(*)::int from pg_proc p where p.oid in ('public.family_new_code()'::regprocedure, 'public.family_check_eligible(uuid)'::regprocedure,
    'public.family_of(uuid)'::regprocedure, 'public.family_check_place(text, text, double precision, double precision, int)'::regprocedure,
    'public.purge_member_locations()'::regprocedure)
    and not p.prosecdef and p.proconfig = array['search_path=public']), 5, 'the helpers are invoker, pinning search_path');
select is((select row(p.prosecdef, p.proowner = 'postgres'::regrole, p.proconfig)::text from pg_proc p
    where p.oid = 'public.family_members_after_delete()'::regprocedure), row(true, true, array['search_path=public'])::text,
  'the delete trigger is definer, owned by postgres, pinning search_path');
select is(array(select has_function_privilege('authenticated', f, 'execute') from unnest(array['public.create_family(text)', 'public.join_family(text)',
    'public.leave_family()', 'public.remove_family_member(uuid)', 'public.rotate_family_code()', 'public.set_location_sharing(boolean)',
    'public.post_my_location(double precision, double precision, real, boolean)', 'public.family_snapshot()',
    'public.save_family_place(uuid, text, text, double precision, double precision, int)', 'public.delete_family_place(uuid)']::regprocedure[]) f),
  array[true, true, true, true, true, true, true, true, true, true], 'authenticated executes the ten RPCs');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'service_role']) r,
    unnest(array['public.create_family(text)', 'public.join_family(text)', 'public.family_snapshot()',
      'public.post_my_location(double precision, double precision, real, boolean)']::regprocedure[]) f), false,
  'anon and the service role execute none of them');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.family_new_code()', 'public.family_check_eligible(uuid)', 'public.family_of(uuid)',
      'public.family_check_place(text, text, double precision, double precision, int)', 'public.purge_member_locations()',
      'public.family_members_after_delete()']::regprocedure[]) f), false, 'no API role executes a helper');
select is((select row(schedule, command)::text from cron.job where jobname = 'purge-member-locations'),
  row('20 * * * *', 'select public.purge_member_locations()')::text, 'the 24 h purge runs hourly');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe12 (id int);
create function public.zz_probe12_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe12', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe12_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe12_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe12_fn();
drop table public.zz_probe12;
select is((select coalesce(array_agg(t.relname::text order by t.relname), '{}') from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relkind = 'r' and t.relname not in ('profiles', 'private_profiles')
      and (exists (select 1 from pg_constraint c where c.conrelid = t.oid and c.contype = 'f' and c.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'user_id' and not a.attisdropped))
      and not exists (select 1 from pg_proc p where p.oid in ('public.minimise_underage_account()'::regprocedure,
                        'public.minimise_underage_notifications()'::regprocedure, 'public.minimise_underage_rewards()'::regprocedure)
                      and p.prosrc ~ ('delete from public\.' || t.relname || ' where'))), '{}'::text[],
  'every user-referencing public table (family_members and member_locations included) is deleted by the under-13 minimisation');
create function pg_temp.client_reach(r text) returns table (via text, fn regprocedure, can_execute boolean)
language plpgsql as $$
begin
  return query
  with recursive writable as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'storage')
      and (has_any_column_privilege(r, c.oid, 'INSERT') or has_any_column_privilege(r, c.oid, 'UPDATE')
           or has_table_privilege(r, c.oid, 'DELETE'))
  ),
  -- trigger functions that run as the writer (invoker), on client-writable tables
  inv_trig as (
    select t.tgrelid::regclass::text || '.' || t.tgname as via, t.tgfoid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and not p.prosecdef
  ),
  -- direct expression dependencies: trigger WHEN, policies, CHECKs, defaults (pg_depend)
  expr as (
    select 'trigger WHEN ' || t.tgrelid::regclass::text || '.' || t.tgname as via, d.refobjid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid
    join pg_depend d on d.classid = 'pg_trigger'::regclass and d.objid = t.oid and d.refclassid = 'pg_proc'::regclass
    where not t.tgisinternal and d.refobjid <> t.tgfoid
    union all
    select 'policy ' || pol.polrelid::regclass::text || '.' || pol.polname, d.refobjid
    from pg_policy pol join writable w on w.oid = pol.polrelid
      and (pol.polroles @> array[r::regrole::oid] or pol.polroles = array[0::oid])
    join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'check ' || con.conrelid::regclass::text || '.' || con.conname, d.refobjid
    from pg_constraint con join writable w on w.oid = con.conrelid
    join pg_depend d on d.classid = 'pg_constraint'::regclass and d.objid = con.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'default ' || ad.adrelid::regclass::text, d.refobjid
    from pg_attrdef ad join writable w on w.oid = ad.adrelid
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_proc'::regclass
  ),
  -- calls from invoker function bodies: ANY schema-qualified `<schema>.<name>(` (fix round 5, n1),
  -- resolved through pg_namespace + pg_proc to EVERY overload of that name, followed through invoker
  -- callees (a definer callee is still checked for EXECUTE, but runs as its owner beyond that).
  -- Unqualified calls are not seen: the conventions require every name to be schema-qualified.
  body_calls(via, caller, callee) as (
    select it.via, it.fid, p2.oid
    from inv_trig it join pg_proc p on p.oid = it.fid
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
    union
    select bc.via, bc.callee, p2.oid
    from body_calls bc join pg_proc p on p.oid = bc.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  ),
  expr_calls(via, callee) as (
    select e.via, e.fid from expr e
    union
    select ec.via, p2.oid
    from expr_calls ec join pg_proc p on p.oid = ec.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  )
  select distinct x.via, x.callee::regprocedure, has_function_privilege(r, x.callee, 'execute')
  from (select b.via, b.callee from body_calls b union select e.via, e.callee from expr_calls e) x
  order by 1, 2;
end $$;
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach(r) where not can_execute),
  '{}'::text[], 'client-reach audit: ' || r) from unnest(array['anon', 'authenticated', 'service_role']) r;

-- ---------------------------------------------------------------------------
-- 2. creating and joining
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(1);                                                    -- adult, admin
select pg_temp.mkuser(2);                                                    -- adult member
select pg_temp.mkuser(3, (current_date - interval '16 years')::date);        -- teen member
select pg_temp.mkuser(4, (current_date - interval '10 years')::date);        -- under 13
select pg_temp.mkuser(5, null);                                              -- age unknown
select pg_temp.mkuser(n) from generate_series(10, 17) n;                     -- to fill a family
select pg_temp.mkuser(20);                                                   -- another family
select throws_ok($$ select pg_temp.run(pg_temp.u(4), $q$select public.create_family('Kids')$q$) $$, '42501', 'account not eligible', 'under 13: refused');
select throws_ok($$ select pg_temp.run(pg_temp.u(5), $q$select public.join_family('ABCD23')$q$) $$, '42501', 'account not eligible',
  'an age not yet known: refused');
select throws_ok($$ select public.create_family('x') $$, '42501', 'create_family requires an authenticated user', 'no JWT, no family');
select throws_ok($$ select pg_temp.run(pg_temp.u(1), $q$select public.create_family('   ')$q$) $$, '22023', 'invalid name', 'a blank name is refused');
select is(pg_temp.run(pg_temp.u(1), $q$select public.create_family('  The Parks  ')::text$q$)::jsonb ->> 'familyId', pg_temp.fam(pg_temp.u(1))::text,
  'create_family makes a family with its creator in it');
select is((select row(f.name, f.code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', f.code_expires_at = now() + interval '7 days', m.role, m.sharing_location)::text
    from public.families f join public.family_members m on m.family_id = f.id where m.user_id = pg_temp.u(1)),
  row('The Parks', true, true, 'admin', false)::text, 'trimmed name, a 6-character code for 7 days, the creator admin, sharing off by default');
select throws_ok($$ select pg_temp.run(pg_temp.u(1), $q$select public.create_family('Again')$q$) $$, '22023', 'already in a family', 'one family per person');
create temp table fam1 as select pg_temp.fam(pg_temp.u(1)) as id, pg_temp.code(pg_temp.fam(pg_temp.u(1))) as code;
select is(pg_temp.run(pg_temp.u(2), format('select public.join_family(%L)::text', ' ' || lower(substr((select code from fam1), 1, 3)) || '-'
    || lower(substr((select code from fam1), 4)) || ' '))::jsonb, jsonb_build_object('familyId', (select id from fam1)),
  'a code typed in lower case with a dash and spaces joins');
select is((select role from public.family_members where user_id = pg_temp.u(2)), 'member', 'a joiner is a member');
select is(pg_temp.budget(pg_temp.u(2)), 1, 'a join spends one attempt');
select is(pg_temp.run(pg_temp.u(3), $q$select public.join_family('ZZZZ22')::text$q$)::jsonb, pg_temp.refusal('22023', 'invalid code'),
  'a well-formed code that does not exist: invalid code');
select is(pg_temp.run(pg_temp.u(3), $q$select public.join_family('not a code!')::text$q$)::jsonb, pg_temp.refusal('22023', 'invalid code'),
  'a malformed code: the same answer');
select is(pg_temp.budget(pg_temp.u(3)), 2, 'each wrong code spends one attempt (the refusal is returned, so the take commits)');
update public.families set code_expires_at = now() - interval '1 second' where id = (select id from fam1);
select is(pg_temp.run(pg_temp.u(3), format('select public.join_family(%L)::text', (select code from fam1)))::jsonb, pg_temp.refusal('22023', 'invalid code'),
  'an expired code: the same answer');
update public.families set code_expires_at = now() + interval '7 days' where id = (select id from fam1);
select throws_ok($$ select pg_temp.run(pg_temp.u(2), $q$select public.join_family('ZZZZ22')$q$) $$, '22023', 'already in a family',
  'a member cannot join another family');
select is(pg_temp.budget(pg_temp.u(2)), 1, 'and that refusal spends no attempt');
select pg_temp.run(pg_temp.u(3), format('select public.join_family(%L)::text', 'ZZZZ2' || n)) from generate_series(2, 8) n;
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(3), format('select public.join_family(%L)', (select code from fam1))), '42501', 'too many attempts',
  'the 11th attempt in 24 h is refused, even with the right code');
update public.rate_limits set count = 0 where user_id = pg_temp.u(3) and key = 'family_join';
select is(pg_temp.run(pg_temp.u(3), format('select public.join_family(%L)::text', (select code from fam1)))::jsonb ? 'familyId', true,
  'a teen can join');
-- full at eight
select pg_temp.run(pg_temp.u(n), format('select public.join_family(%L)::text', (select code from fam1))) from generate_series(10, 14) n;
select is((select count(*)::int from public.family_members where family_id = (select id from fam1)), 8, 'eight members');
select is(pg_temp.run(pg_temp.u(15), format('select public.join_family(%L)::text', (select code from fam1)))::jsonb, pg_temp.refusal('42501', 'family is full'),
  'a ninth is refused: family is full');
select is(pg_temp.fam(pg_temp.u(15)), null, 'and is not added');
-- the other family
select pg_temp.run(pg_temp.u(20), $q$select public.create_family('Others')::text$q$);

-- ---------------------------------------------------------------------------
-- 3. what a member sees
-- ---------------------------------------------------------------------------
select is(pg_temp.snap(pg_temp.u(16)), '{"family": null}'::jsonb, 'outside a family: null');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.snap(pg_temp.u(1)) -> 'family') k),
  array['code', 'codeExpiresAt', 'id', 'members', 'myRole', 'mySharing', 'name', 'places'], 'the snapshot has exactly its keys');
select is(array[pg_temp.snap(pg_temp.u(1)) -> 'family' ->> 'code', pg_temp.snap(pg_temp.u(2)) -> 'family' ->> 'code'], array[(select code from fam1), null],
  'the code is shown to the admin only');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.snap(pg_temp.u(1)) -> 'family' -> 'members' -> 0) k),
  array['isMe', 'location', 'name', 'role', 'sharing', 'userId'], 'a member has exactly its keys');
select is((select array_agg(e ->> 'userId' order by ord) from jsonb_array_elements(pg_temp.snap(pg_temp.u(2)) -> 'family' -> 'members') with ordinality x(e, ord))
    [1:2], array[pg_temp.u(2)::text, pg_temp.u(1)::text], 'the caller first, then the admin');
select is((select count(*)::int from jsonb_array_elements(pg_temp.snap(pg_temp.u(20)) -> 'family' -> 'members')), 1,
  'another family sees only its own member');

-- ---------------------------------------------------------------------------
-- 4. location: sharing off by default, the rate limit, 24 h, off deletes
-- ---------------------------------------------------------------------------
select throws_ok($$ select pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(47.6, -122.3, 10, false)$q$) $$, '42501', 'location sharing is off',
  'nothing is posted while sharing is off');
select throws_ok($$ select pg_temp.run(pg_temp.u(16), $q$select public.post_my_location(47.6, -122.3, 10, false)$q$) $$, '42501', 'location sharing is off',
  'nor outside a family');
select throws_ok($$ select pg_temp.run(pg_temp.u(16), $q$select public.set_location_sharing(true)$q$) $$, '22023', 'not in a family',
  'sharing needs a family');
select pg_temp.run(pg_temp.u(2), $q$select public.set_location_sharing(true)$q$);
select throws_ok($$ select pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(91, -122.3, 10, false)$q$) $$, '22023', 'invalid location',
  'a latitude off the globe is refused');
select is(pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(47.61, -122.33, 12.5, true)::text$q$)::jsonb, '{"accepted": true}'::jsonb,
  'sharing on: the post is accepted');
select is(pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(47.70, -122.40, 8, false)::text$q$)::jsonb, '{"accepted": false}'::jsonb,
  'a second post within 20 s is not written (the rate limit)');
select is((select row(lat, lng, accuracy_m, driving)::text from public.member_locations where user_id = pg_temp.u(2)),
  row(47.61::double precision, -122.33::double precision, 12.5::real, true)::text, 'one row, still the first post');
update public.member_locations set updated_at = now() - interval '21 seconds' where user_id = pg_temp.u(2);
select is(pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(47.70, -122.40, 8, false)::text$q$)::jsonb, '{"accepted": true}'::jsonb,
  'after 20 s it is written again');
select is((select count(*)::int from public.member_locations where user_id = pg_temp.u(2)), 1, 'still one row: overwritten, never a history');
select is((select (e -> 'location') - 'updatedAt' from jsonb_array_elements(pg_temp.snap(pg_temp.u(1)) -> 'family' -> 'members') e
    where e ->> 'userId' = pg_temp.u(2)::text), '{"lat": 47.70, "lng": -122.40, "accuracyM": 8, "driving": false}'::jsonb,
  'the family sees the shared location');
select is((select e -> 'location' from jsonb_array_elements(pg_temp.snap(pg_temp.u(20)) -> 'family' -> 'members') e
    where e ->> 'userId' = pg_temp.u(2)::text), null, 'another family never sees it');
update public.member_locations set updated_at = now() - interval '25 hours' where user_id = pg_temp.u(2);
select is((select e -> 'location' from jsonb_array_elements(pg_temp.snap(pg_temp.u(1)) -> 'family' -> 'members') e
    where e ->> 'userId' = pg_temp.u(2)::text), 'null'::jsonb, 'a location over 24 h old is not shown');
select pg_temp.mkuser(21);
insert into public.member_locations (user_id, lat, lng, accuracy_m, updated_at) values (pg_temp.u(21), 1, 1, 1, now() - interval '23 hours');
select is(public.purge_member_locations(), 1, 'the purge deletes a row over 24 h old');
select is((select count(*)::int from public.member_locations where user_id = pg_temp.u(21)), 1, 'and keeps a 23 h one');
select pg_temp.run(pg_temp.u(2), $q$select public.post_my_location(47.70, -122.40, 8, false)::text$q$);
select pg_temp.run(pg_temp.u(2), $q$select public.set_location_sharing(false)$q$);
select is(array[(select count(*)::int from public.member_locations where user_id = pg_temp.u(2)),
    (select sharing_location::int from public.family_members where user_id = pg_temp.u(2))], array[0, 0], 'turning sharing off deletes the row at once');
select is((select e -> 'location' from jsonb_array_elements(pg_temp.snap(pg_temp.u(1)) -> 'family' -> 'members') e
    where e ->> 'userId' = pg_temp.u(2)::text), 'null'::jsonb, 'and the family sees none');

-- ---------------------------------------------------------------------------
-- 5. places
-- ---------------------------------------------------------------------------
create temp table place1 as select (pg_temp.run(pg_temp.u(2), $q$select public.save_family_place(null, ' School ', '1 School Rd', 47.6, -122.3, 200)::text$q$)::jsonb ->> 'id')::uuid as id;
select is((select row(name, address, radius_m)::text from public.family_places where id = (select id from place1)), row('School', '1 School Rd', 200)::text,
  'any member adds a place, name trimmed');
select pg_temp.run(pg_temp.u(3), format('select public.save_family_place(%L, %L, %L, 47.61, -122.31, 150)::text', (select id from place1), 'High school', ''));
select is((select row(name, address, radius_m)::text from public.family_places where id = (select id from place1)), row('High school', '', 150)::text,
  'and any member edits it');
select is((pg_temp.snap(pg_temp.u(1)) -> 'family' -> 'places' -> 0) - 'id',
  '{"name": "High school", "address": "", "lat": 47.61, "lng": -122.31, "radiusM": 150}'::jsonb, 'the family sees the place');
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(20), format('select public.save_family_place(%L, ''Mine'', '''', 1, 1, 150)', (select id from place1))),
  '42501', 'not in your family', 'another family cannot edit it');
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(20), format('select public.delete_family_place(%L)', (select id from place1))),
  '42501', 'not in your family', 'nor delete it');
select throws_ok($$ select pg_temp.run(pg_temp.u(2), $q$select public.save_family_place(null, 'Home', '', 1, 1, 10)$q$) $$, '22023', 'invalid place',
  'a radius under 50 m is refused');
select throws_ok($$ select pg_temp.run(pg_temp.u(16), $q$select public.save_family_place(null, 'Home', '', 1, 1, 150)$q$) $$, '22023', 'not in a family',
  'outside a family: refused');
select pg_temp.run(pg_temp.u(1), format('select public.save_family_place(null, %L, %L, 1, 1, 150)::text', 'P' || n, '')) from generate_series(1, 19) n;
select throws_ok($$ select pg_temp.run(pg_temp.u(1), $q$select public.save_family_place(null, 'One more', '', 1, 1, 150)$q$) $$, '22023', 'too many places',
  'at most 20 places a family');
select pg_temp.run(pg_temp.u(1), format('select public.delete_family_place(%L)', (select id from place1)));
select is((select count(*)::int from public.family_places where id = (select id from place1)), 0, 'a member deletes a place');

-- ---------------------------------------------------------------------------
-- 6. the code, removing, leaving, the admin handover, the account cascade, under 13
-- ---------------------------------------------------------------------------
select throws_ok($$ select pg_temp.run(pg_temp.u(2), $q$select public.rotate_family_code()$q$) $$, '42501', 'only the family admin can change the code',
  'a member cannot change the code');
create temp table rot as select pg_temp.run(pg_temp.u(1), $q$select public.rotate_family_code()::text$q$)::jsonb as r;
select is(array[(select r ->> 'code' from rot) = pg_temp.code((select id from fam1)), (select r ->> 'code' from rot) <> (select code from fam1)], array[true, true],
  'the admin rotates the code');
select is(pg_temp.run(pg_temp.u(16), format('select public.join_family(%L)::text', (select code from fam1)))::jsonb, pg_temp.refusal('22023', 'invalid code'),
  'the old code no longer joins');
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(2), format('select public.remove_family_member(%L)', pg_temp.u(3))), '42501',
  'only the family admin can remove a member', 'a member cannot remove anyone');
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(1), format('select public.remove_family_member(%L)', pg_temp.u(1))), '22023',
  'use leave_family to leave', 'the admin does not remove themselves');
select throws_ok(format('select pg_temp.run(%L::uuid, %L)', pg_temp.u(1), format('select public.remove_family_member(%L)', pg_temp.u(20))), '42501',
  'not in your family', 'nor someone from another family');
select pg_temp.run(pg_temp.u(3), $q$select public.set_location_sharing(true)$q$);
select pg_temp.run(pg_temp.u(3), $q$select public.post_my_location(1, 1, 5, false)::text$q$);
select pg_temp.run(pg_temp.u(1), format('select public.remove_family_member(%L)', pg_temp.u(3)));
select is(array[(select count(*)::int from public.family_members where user_id = pg_temp.u(3)),
    (select count(*)::int from public.member_locations where user_id = pg_temp.u(3))], array[0, 0], 'a removed member and their location are gone');
select pg_temp.run(pg_temp.u(1), $q$select public.leave_family()$q$);
select is((select role from public.family_members where user_id = pg_temp.u(2)), 'admin', 'the admin leaving makes the longest-standing member admin');
select throws_ok($$ select pg_temp.run(pg_temp.u(1), $q$select public.leave_family()$q$) $$, '22023', 'not in a family', 'leaving twice is refused');
-- the account cascade: the new admin's auth user is deleted
select pg_temp.run(pg_temp.u(10), $q$select public.set_location_sharing(true)$q$);
select pg_temp.run(pg_temp.u(10), $q$select public.post_my_location(1, 1, 5, false)::text$q$);
delete from auth.users where id = pg_temp.u(10);
select is(array[(select count(*)::int from public.member_locations where user_id = pg_temp.u(10)),
    (select count(*)::int from public.family_members where family_id = (select id from fam1))], array[0, 5],
  'a deleted account''s membership and location go with it');
delete from auth.users where id = pg_temp.u(2);
select is((select count(*)::int from public.family_members where family_id = (select id from fam1) and role = 'admin'), 1,
  'the last admin''s account deleted: another member becomes admin');
-- under 13: a member's age corrected
update public.private_profiles set birth_date = null where user_id = pg_temp.u(11);
select pg_temp.run(pg_temp.u(11), $q$select public.set_location_sharing(true)$q$);
select pg_temp.run(pg_temp.u(11), $q$select public.post_my_location(1, 1, 5, false)::text$q$);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000011"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'a member gives a child''s birth date');
select throws_ok($$ select public.family_snapshot() $$, '42501', 'account not eligible', 'and can no longer read the family');
reset role;
select set_config('request.jwt.claims', '', true);
select is(array[(select count(*)::int from public.family_members where user_id = pg_temp.u(11)),
    (select count(*)::int from public.member_locations where user_id = pg_temp.u(11))], array[0, 0], 'the under-13 transition deletes the membership and the location');
select throws_ok($$ insert into public.family_members (family_id, user_id, role) values ((select id from fam1), pg_temp.u(11), 'member') $$, '42501', 'account not eligible',
  'no membership can be written for them');
-- the last members leave: the family and its places end
select pg_temp.run(pg_temp.u(n), $q$select public.leave_family()$q$) from generate_series(12, 14) n;
select is(array[(select count(*)::int from public.families where id = (select id from fam1)),
    (select count(*)::int from public.family_places where family_id = (select id from fam1))], array[0, 0], 'the last member leaving ends the family and its places');

select * from finish();
rollback;
drop extension if exists dblink;
