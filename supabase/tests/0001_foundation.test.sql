-- pgTAP is a test-only dependency: install it outside the test transaction so it
-- persists in the local database without ever appearing in a migration.
create extension if not exists pgtap with schema extensions;

begin;
select plan(142);

-- ---------------------------------------------------------------------------
-- fixtures (run as the migration owner): three auth users (C signs up with a
-- hostile display name), one public and one private config row, one device
-- owned by B that A must never reach
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com', '{"display_name":"Ava"}'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com', '{"display_name":"Ben"}'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com',
    jsonb_build_object('display_name', chr(1) || chr(10) || '  ' || repeat('z', 50000) || chr(8238)));

insert into public.app_config (key, value, is_public) values
  ('test_public', '{"x":1}', true),
  ('test_private', '{"x":2}', false);

insert into public.devices (id, user_id, platform) values ('dev-b', '00000000-0000-0000-0000-000000000002', 'android');

-- new-user bootstrap trigger
select is((select count(*)::int from public.profiles), 3, 'trigger creates a profile per user');
select is((select count(*)::int from public.private_profiles), 3, 'trigger creates a private profile per user');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'Ava', 'display name copied from signup metadata');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'unknown', 'age band unknown until birth date set');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000003'), repeat('z', 40), 'hostile signup name is stripped, trimmed and capped at 40 and the signup still succeeds');
select doesnt_match((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000003'), '[[:cntrl:]‮]', 'signup display name carries no control or bidi characters');

-- ---------------------------------------------------------------------------
-- schema-level posture: RLS on every table, exact policy sets, explicit grants
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), true, 'RLS enabled on profiles');
select is((select relrowsecurity from pg_class where oid = 'public.private_profiles'::regclass), true, 'RLS enabled on private_profiles');
select is((select relrowsecurity from pg_class where oid = 'public.consents'::regclass), true, 'RLS enabled on consents');
select is((select relrowsecurity from pg_class where oid = 'public.devices'::regclass), true, 'RLS enabled on devices');
select is((select relrowsecurity from pg_class where oid = 'public.app_config'::regclass), true, 'RLS enabled on app_config');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'no table in public is missing RLS');

select policies_are('public', 'profiles', array['profiles_select_own', 'profiles_update_own']::name[], 'profiles has exactly its two policies');
select policies_are('public', 'private_profiles', array['private_select_own']::name[], 'private_profiles has exactly one policy');
select policies_are('public', 'consents', array['consents_select_own', 'consents_insert_own']::name[], 'consents has exactly its two policies');
select policies_are('public', 'devices', array['devices_all_own']::name[], 'devices has exactly one policy');
select policies_are('public', 'app_config', array['app_config_public']::name[], 'app_config has exactly one policy');

select table_privs_are('public', 'profiles', 'anon', '{}'::name[], 'anon has no privileges on profiles');
select table_privs_are('public', 'profiles', 'authenticated', array['SELECT']::name[], 'authenticated has only table-level select on profiles (update is per column)');
select table_privs_are('public', 'private_profiles', 'anon', '{}'::name[], 'anon has no privileges on private_profiles');
select table_privs_are('public', 'private_profiles', 'authenticated', array['SELECT']::name[], 'authenticated may only select private_profiles');
select table_privs_are('public', 'consents', 'anon', '{}'::name[], 'anon has no privileges on consents');
select table_privs_are('public', 'consents', 'authenticated', array['SELECT']::name[], 'authenticated has only table-level select on consents (insert is per column)');
select table_privs_are('public', 'devices', 'anon', '{}'::name[], 'anon has no privileges on devices');
select table_privs_are('public', 'devices', 'authenticated', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::name[], 'authenticated has full DML on devices (rows still owner-scoped)');
select table_privs_are('public', 'app_config', 'anon', array['SELECT']::name[], 'anon may only select app_config');
select table_privs_are('public', 'app_config', 'authenticated', array['SELECT']::name[], 'authenticated may only select app_config');

-- server-owned columns are read-only for clients
select column_privs_are('public', 'profiles', 'id', 'authenticated', array['SELECT']::name[], 'profiles.id is read-only for clients');
select column_privs_are('public', 'profiles', 'age_band', 'authenticated', array['SELECT']::name[], 'profiles.age_band is read-only for clients');
select column_privs_are('public', 'profiles', 'level', 'authenticated', array['SELECT']::name[], 'profiles.level is read-only for clients');
select column_privs_are('public', 'profiles', 'created_at', 'authenticated', array['SELECT']::name[], 'profiles.created_at is read-only for clients');
select column_privs_are('public', 'profiles', 'updated_at', 'authenticated', array['SELECT']::name[], 'profiles.updated_at is read-only for clients');
select column_privs_are('public', 'profiles', 'display_name', 'authenticated', array['SELECT', 'UPDATE']::name[], 'profiles.display_name is client-editable');
select column_privs_are('public', 'consents', 'user_id', 'authenticated', array['SELECT', 'INSERT']::name[], 'consents.user_id is client-insertable');
select column_privs_are('public', 'consents', 'actor', 'authenticated', array['SELECT']::name[], 'consents.actor is server-owned');
select column_privs_are('public', 'consents', 'granted_at', 'authenticated', array['SELECT']::name[], 'consents.granted_at is server-owned');
select column_privs_are('public', 'consents', 'revoked_at', 'authenticated', array['SELECT']::name[], 'consents.revoked_at is server-owned');

select has_index('public', 'consents', 'consents_user_id_idx', 'consents indexed by owner');
select has_index('public', 'private_profiles', 'private_profiles_guardian_user_id_idx', 'guardian FK indexed for the set-null cascade');

-- function privileges
select is(has_function_privilege('anon', 'public.set_birth_date(date)', 'execute'), false, 'anon cannot execute set_birth_date');
select is(has_function_privilege('authenticated', 'public.set_birth_date(date)', 'execute'), true, 'authenticated can execute set_birth_date');
select is(has_function_privilege('anon', 'public.derive_age_band(date)', 'execute'), false, 'anon cannot execute derive_age_band');
select is(has_function_privilege('authenticated', 'public.handle_new_user()', 'execute'), false, 'authenticated cannot call handle_new_user');
select is(has_function_privilege('authenticated', 'public.touch_updated_at()', 'execute'), false, 'authenticated cannot call touch_updated_at');
select is(has_function_privilege('authenticated', 'public.sync_age_band()', 'execute'), false, 'authenticated cannot call sync_age_band');

-- definer mechanism the signup and birth-date paths depend on
select is_definer('public', 'handle_new_user', '{}'::name[], 'handle_new_user is security definer (signup runs as supabase_auth_admin)');
select function_owner_is('public', 'handle_new_user', '{}'::name[], 'postgres', 'handle_new_user owned by postgres (bypassrls)');
select is((select proconfig from pg_proc where oid = 'public.handle_new_user()'::regprocedure), array['search_path=public'], 'handle_new_user pins search_path');
select is_definer('public', 'set_birth_date', array['date']::name[], 'set_birth_date is security definer');
select function_owner_is('public', 'set_birth_date', array['date']::name[], 'postgres', 'set_birth_date owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.set_birth_date(date)'::regprocedure), array['search_path=public'], 'set_birth_date pins search_path');
select is(
  (select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
select volatility_is('public', 'derive_age_band', array['date']::name[], 'stable', 'derive_age_band is stable, never immutable');
select is(has_table_privilege('supabase_auth_admin', 'public.profiles', 'insert'), false, 'auth admin has no direct table access; signup relies on the definer trigger');
select is(has_schema_privilege('authenticated', 'public', 'create'), false, 'authenticated cannot create objects in public');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'), 0, 'no table streams through realtime');

-- default privileges: anything postgres creates in public from now on is default-deny
create table public.zz_probe (id int);
create sequence public.zz_probe_seq;
create function public.zz_probe_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege('anon', 'public.zz_probe', p)) from unnest(array['select', 'insert', 'update', 'delete']) as p), false, 'a new table grants anon nothing');
select is((select bool_or(has_table_privilege('authenticated', 'public.zz_probe', p)) from unnest(array['select', 'insert', 'update', 'delete']) as p), false, 'a new table grants authenticated nothing');
select is(has_table_privilege('service_role', 'public.zz_probe', 'select'), true, 'service_role keeps access to new tables');
select is((select bool_or(has_sequence_privilege('anon', 'public.zz_probe_seq', p)) from unnest(array['usage', 'select', 'update']) as p), false, 'a new sequence grants anon nothing');
select is((select bool_or(has_sequence_privilege('authenticated', 'public.zz_probe_seq', p)) from unnest(array['usage', 'select', 'update']) as p), false, 'a new sequence grants authenticated nothing');
select is(has_function_privilege('anon', 'public.zz_probe_fn()', 'execute'), false, 'a new function grants anon nothing');
select is(has_function_privilege('authenticated', 'public.zz_probe_fn()', 'execute'), false, 'a new function grants authenticated nothing');
select is(has_function_privilege('authenticated', 'extensions.st_point(double precision, double precision)', 'execute'), true, 'the global function default-deny leaves extension helpers callable');
drop function public.zz_probe_fn();
drop sequence public.zz_probe_seq;
drop table public.zz_probe;

-- ---------------------------------------------------------------------------
-- act as user A (authenticated)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid, 'auth.uid() resolves to A');

-- reads are owner-only
select is((select count(*)::int from public.profiles), 1, 'A sees only own profile row');
select is((select count(*)::int from public.private_profiles), 1, 'A sees only own private row');

-- no client insert/delete path on profiles, no client write path on private_profiles
select throws_ok($$ insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-000000000002', 'x') $$, '42501', null, 'A cannot insert a profile for B');
select throws_ok($$ insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-000000000001', 'x') $$, '42501', null, 'A cannot insert a profile even for self');
select throws_ok($$ delete from public.profiles where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot delete own profile');
select throws_ok($$ insert into public.private_profiles (user_id) values ('00000000-0000-0000-0000-000000000001') $$, '42501', null, 'A cannot insert a private profile');
select throws_ok($$ update public.private_profiles set birth_date = date '2000-01-01' where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot write private_profiles directly');
select throws_ok($$ delete from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot delete own private profile');

-- birth date only via the rpc: validated, write-once, band derived server-side
select throws_ok($$ select public.set_birth_date(date '2999-12-31') $$, '23514', 'birth_date must be a date between 120 years ago and today', 'future birth date rejected');
select throws_ok($$ select public.set_birth_date(date '1800-01-01') $$, '23514', 'birth_date must be a date between 120 years ago and today', 'birth date older than 120 years rejected');
select throws_ok($$ select public.set_birth_date(null) $$, '23514', 'birth_date must be a date between 120 years ago and today', 'null birth date rejected');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'unknown', 'band untouched by rejected calls');
select lives_ok($$ select public.set_birth_date(date '2010-06-01') $$, 'A sets birth date via rpc');
select is((select birth_date from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001'), date '2010-06-01', 'birth date stored in private profile');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '13_17', 'age band derived from birth date');
select throws_ok($$ select public.set_birth_date(date '2000-01-01') $$, '42501', 'birth date already set', 'birth date is write-once for the client');
select is((select birth_date from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001'), date '2010-06-01', 'birth date unchanged by the second call');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '13_17', 'band unchanged by the second call');
select is(public.derive_age_band(date '2015-01-01'), 'u13', 'under-13 band');
select is(public.derive_age_band(date '2000-01-01'), '18_plus', '18-plus band');
select is(public.derive_age_band(null), 'unknown', 'null birth date is the unknown band');

-- own profile: editable columns yes; server-owned columns no; bounds enforced
select lives_ok($$ update public.profiles set display_name = 'Ava Prime', units = 'kmh' where id = '00000000-0000-0000-0000-000000000001' $$, 'A updates own profile fields');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'Ava Prime', 'A display name changed');
select throws_ok($$ update public.profiles set age_band = '18_plus' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot change own age_band');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '13_17', 'age band unchanged after rejected update');
select throws_ok($$ update public.profiles set level = 99 where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot set own level');
select is((select level from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 1, 'level unchanged after rejected update');
select throws_ok($$ update public.profiles set created_at = '1970-01-01' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot rewrite created_at');
select is((select created_at from public.profiles where id = '00000000-0000-0000-0000-000000000001'), now(), 'created_at unchanged after rejected update');
select throws_ok($$ update public.profiles set id = '00000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot re-key own profile to B');
select throws_ok($$ update public.profiles set display_name = repeat('a', 41) where id = '00000000-0000-0000-0000-000000000001' $$, '23514', null, 'client display name is bounded at 40');
select throws_ok($$ update public.profiles set flags = '[1, 2]' where id = '00000000-0000-0000-0000-000000000001' $$, '23514', null, 'flags must be a JSON object');
select throws_ok($$ update public.profiles set flags = (select jsonb_object_agg('k' || i, md5(i::text)) from generate_series(1, 200) i) where id = '00000000-0000-0000-0000-000000000001' $$, '23514', null, 'oversize flags rejected');
select lives_ok($$ update public.profiles set flags = '{"camera_beta": true}' where id = '00000000-0000-0000-0000-000000000001' $$, 'small flags object accepted');

-- B's rows are invisible and untouchable
select is_empty($$ update public.profiles set display_name = 'pwned' where id = '00000000-0000-0000-0000-000000000002' returning id $$, 'A update of B profile touches nothing');

-- consents: append-only, own rows only, server-stamped
select lives_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000001', 'tos', '1') $$, 'A can record own consent');
select throws_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000002', 'tos', '1') $$, '42501', null, 'A cannot record a consent for B');
select throws_ok($$ insert into public.consents (user_id, type, version, actor) values ('00000000-0000-0000-0000-000000000001', 'tos', '1', 'guardian') $$, '42501', null, 'client cannot set consent actor');
select throws_ok($$ insert into public.consents (user_id, type, version, granted_at) values ('00000000-0000-0000-0000-000000000001', 'tos', '1', '2020-01-01') $$, '42501', null, 'client cannot set granted_at');
select throws_ok($$ insert into public.consents (user_id, type, version, revoked_at) values ('00000000-0000-0000-0000-000000000001', 'tos', '1', '2020-01-01') $$, '42501', null, 'client cannot set revoked_at');
select throws_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000001', 'guardian_link', '1') $$, '42501', null, 'guardian_link consent is server-only');
select throws_ok($$ update public.consents set revoked_at = now() where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot update consents');
select throws_ok($$ delete from public.consents where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot delete consents');
select is((select count(*)::int from public.consents), 1, 'A sees own consent');
select is((select actor from public.consents where user_id = '00000000-0000-0000-0000-000000000001'), 'self', 'consent actor is server-defaulted');
select is((select granted_at from public.consents where user_id = '00000000-0000-0000-0000-000000000001'), now(), 'consent granted_at is server time');

-- devices: full DML, own rows only, including the upsert paths PostgREST uses
select lives_ok($$ insert into public.devices (id, user_id, platform) values ('dev-a', '00000000-0000-0000-0000-000000000001', 'ios') $$, 'A registers own device');
select lives_ok($$ update public.devices set push_token = 'tok' where user_id = '00000000-0000-0000-0000-000000000001' and id = 'dev-a' $$, 'A updates own device');
select lives_ok($$ insert into public.devices (id, user_id, platform) values ('dev-a', '00000000-0000-0000-0000-000000000001', 'ios') on conflict (user_id, id) do update set last_seen_at = now() $$, 'A upserts own device');
select throws_ok($$ insert into public.devices (id, user_id, platform) values ('dev-x', '00000000-0000-0000-0000-000000000002', 'android') $$, '42501', null, 'A cannot register a device for B');
select throws_ok($$ insert into public.devices (id, user_id, platform) values ('dev-b', '00000000-0000-0000-0000-000000000002', 'android') on conflict (user_id, id) do update set push_token = 'x' $$, '42501', null, 'A cannot upsert onto B device');
select throws_ok($$ update public.devices set user_id = '00000000-0000-0000-0000-000000000002' where id = 'dev-a' $$, '42501', null, 'A cannot hand own device to B');
select is_empty($$ update public.devices set push_token = 'x' where user_id = '00000000-0000-0000-0000-000000000002' returning id $$, 'A cannot touch B device');
select is_empty($$ delete from public.devices where user_id = '00000000-0000-0000-0000-000000000002' returning id $$, 'A cannot delete B device');
select is((select count(*)::int from public.devices), 1, 'A sees only own device');

-- app_config: public rows only, read-only
select is((select count(*)::int from public.app_config where key like 'test\_%'), 1, 'A sees only public app_config rows');
select is((select count(*)::int from public.app_config where key = 'test_private'), 0, 'private app_config row hidden from A');
select throws_ok($$ insert into public.app_config (key, value) values ('k', '{}') $$, '42501', null, 'A cannot insert app_config');
select throws_ok($$ update public.app_config set value = '{}' where key = 'test_public' $$, '42501', null, 'A cannot update app_config');

-- ---------------------------------------------------------------------------
-- act as user B: A's data must be invisible from the other side too, and
-- nothing A tried against B landed
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.profiles), 1, 'B sees only own profile row');
select is((select id from public.profiles), '00000000-0000-0000-0000-000000000002'::uuid, 'the profile B sees is B');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'Ben', 'A update did not reach B profile');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'unknown', 'A birth date did not touch B band');
select is((select count(*)::int from public.consents), 0, 'B cannot see A consent');
select is((select count(*)::int from public.devices), 1, 'B sees only own device');
select is((select push_token from public.devices where user_id = '00000000-0000-0000-0000-000000000002' and id = 'dev-b'), null, 'A upsert/update did not reach B device');
select is((select count(*)::int from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'B cannot see A private profile');

-- ---------------------------------------------------------------------------
-- authenticated role with a JWT that carries no sub: the rpc must refuse, not no-op
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.set_birth_date(date '2000-01-01') $$, '42501', 'set_birth_date requires an authenticated user', 'rpc refuses a JWT without sub');

-- ---------------------------------------------------------------------------
-- act as anon: nothing but public config
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.app_config where key like 'test\_%'), 1, 'anon sees only public app_config rows');
select throws_ok($$ select count(*) from public.profiles $$, '42501', null, 'anon cannot read profiles');
select throws_ok($$ select count(*) from public.private_profiles $$, '42501', null, 'anon cannot read private_profiles');
select throws_ok($$ select count(*) from public.consents $$, '42501', null, 'anon cannot read consents');
select throws_ok($$ select count(*) from public.devices $$, '42501', null, 'anon cannot read devices');
select throws_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000001', 'tos', '1') $$, '42501', null, 'anon cannot insert consents');
select throws_ok($$ select public.set_birth_date(date '2010-06-01') $$, '42501', null, 'anon cannot call set_birth_date');

-- ---------------------------------------------------------------------------
-- server-side writes (owner / service_role path): the band follows birth_date
-- through the trigger, not only through the rpc
-- ---------------------------------------------------------------------------
reset role;
update public.private_profiles set birth_date = date '2015-01-01' where user_id = '00000000-0000-0000-0000-000000000002';
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'u13', 'a server write of birth_date re-derives the band');
update public.private_profiles set birth_date = null where user_id = '00000000-0000-0000-0000-000000000002';
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'unknown', 'clearing birth_date server-side resets the band');

select * from finish();
rollback;
