-- pgTAP is a test-only dependency: install it outside the test transaction so it
-- persists in the local database without ever appearing in a migration.
create extension if not exists pgtap with schema extensions;

begin;
select plan(70);

-- ---------------------------------------------------------------------------
-- fixtures (run as the migration owner): two auth users, one public and one
-- private config row
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com', '{"display_name":"Ava"}'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com', '{"display_name":"Ben"}');

insert into public.app_config (key, value, is_public) values
  ('test_public', '{"x":1}', true),
  ('test_private', '{"x":2}', false);

-- new-user bootstrap trigger
select is((select count(*)::int from public.profiles), 2, 'trigger creates a profile per user');
select is((select count(*)::int from public.private_profiles), 2, 'trigger creates a private profile per user');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'Ava', 'display name copied from signup metadata');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'unknown', 'age band unknown until birth date set');

-- ---------------------------------------------------------------------------
-- schema-level posture: RLS on every table, explicit grants only
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

select table_privs_are('public', 'profiles', 'anon', '{}'::name[], 'anon has no privileges on profiles');
select table_privs_are('public', 'profiles', 'authenticated', array['SELECT', 'UPDATE']::name[], 'authenticated may only select and update profiles');
select table_privs_are('public', 'private_profiles', 'anon', '{}'::name[], 'anon has no privileges on private_profiles');
select table_privs_are('public', 'private_profiles', 'authenticated', array['SELECT']::name[], 'authenticated may only select private_profiles');
select table_privs_are('public', 'consents', 'anon', '{}'::name[], 'anon has no privileges on consents');
select table_privs_are('public', 'consents', 'authenticated', array['SELECT', 'INSERT']::name[], 'authenticated may only select and insert consents');
select table_privs_are('public', 'devices', 'anon', '{}'::name[], 'anon has no privileges on devices');
select table_privs_are('public', 'devices', 'authenticated', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::name[], 'authenticated has full DML on devices (rows still owner-scoped)');
select table_privs_are('public', 'app_config', 'anon', array['SELECT']::name[], 'anon may only select app_config');
select table_privs_are('public', 'app_config', 'authenticated', array['SELECT']::name[], 'authenticated may only select app_config');

select is(has_function_privilege('anon', 'public.set_birth_date(date)', 'execute'), false, 'anon cannot execute set_birth_date');
select is(has_function_privilege('authenticated', 'public.set_birth_date(date)', 'execute'), true, 'authenticated can execute set_birth_date');
select is(has_function_privilege('anon', 'public.derive_age_band(date)', 'execute'), false, 'anon cannot execute derive_age_band');

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

-- birth date only via the rpc; the band is derived server-side
select lives_ok($$ select public.set_birth_date(date '2010-06-01') $$, 'A sets birth date via rpc');
select is((select birth_date from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001'), date '2010-06-01', 'birth date stored in private profile');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '13_17', 'age band derived from birth date');
select is(public.derive_age_band(date '2015-01-01'), 'u13', 'under-13 band');
select is(public.derive_age_band(date '2000-01-01'), '18_plus', '18-plus band');
select is(public.derive_age_band(null), 'unknown', 'null birth date is the unknown band');

-- own profile: editable fields yes; age_band no; re-keying no
select lives_ok($$ update public.profiles set display_name = 'Ava Prime', units = 'kmh' where id = '00000000-0000-0000-0000-000000000001' $$, 'A updates own profile fields');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'Ava Prime', 'A display name changed');
select throws_ok($$ update public.profiles set age_band = '18_plus' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot change own age_band');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '13_17', 'age band unchanged after rejected update');
select throws_ok($$ update public.profiles set id = '00000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot re-key own profile to B');

-- B's rows are invisible and untouchable: the using clause filters B's row out, so this
-- touches nothing (asserted from B's side below, since A cannot read B's row to check)
update public.profiles set display_name = 'pwned' where id = '00000000-0000-0000-0000-000000000002';

-- consents: append-only, own rows only
select lives_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000001', 'tos', '1') $$, 'A can record own consent');
select throws_ok($$ insert into public.consents (user_id, type, version) values ('00000000-0000-0000-0000-000000000002', 'tos', '1') $$, '42501', null, 'A cannot record a consent for B');
select throws_ok($$ update public.consents set revoked_at = now() where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot update consents');
select throws_ok($$ delete from public.consents where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot delete consents');
select is((select count(*)::int from public.consents), 1, 'A sees own consent');

-- devices: full DML, own rows only
select lives_ok($$ insert into public.devices (id, user_id, platform) values ('dev-a', '00000000-0000-0000-0000-000000000001', 'ios') $$, 'A registers own device');
select lives_ok($$ update public.devices set push_token = 'tok' where user_id = '00000000-0000-0000-0000-000000000001' and id = 'dev-a' $$, 'A updates own device');
select throws_ok($$ insert into public.devices (id, user_id, platform) values ('dev-b', '00000000-0000-0000-0000-000000000002', 'android') $$, '42501', null, 'A cannot register a device for B');
select throws_ok($$ update public.devices set user_id = '00000000-0000-0000-0000-000000000002' where id = 'dev-a' $$, '42501', null, 'A cannot hand own device to B');

-- app_config: public rows only, read-only
select is((select count(*)::int from public.app_config where key like 'test\_%'), 1, 'A sees only public app_config rows');
select is((select count(*)::int from public.app_config where key = 'test_private'), 0, 'private app_config row hidden from A');
select throws_ok($$ insert into public.app_config (key, value) values ('k', '{}') $$, '42501', null, 'A cannot insert app_config');
select throws_ok($$ update public.app_config set value = '{}' where key = 'test_public' $$, '42501', null, 'A cannot update app_config');

-- ---------------------------------------------------------------------------
-- act as user B: A's data must be invisible from the other side too
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.profiles), 1, 'B sees only own profile row');
select is((select id from public.profiles), '00000000-0000-0000-0000-000000000002'::uuid, 'the profile B sees is B');
select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'Ben', 'A update did not reach B profile');
select is((select age_band from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'unknown', 'A birth date did not touch B band');
select is((select count(*)::int from public.consents), 0, 'B cannot see A consent');
select is((select count(*)::int from public.devices), 0, 'B cannot see A device');
select is((select count(*)::int from public.private_profiles where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'B cannot see A private profile');

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

reset role;
select * from finish();
rollback;
