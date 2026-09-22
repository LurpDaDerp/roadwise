-- 0005_app_config_flags: the feature_flags row exists after the migrations alone, has the M3 shape,
-- is readable by anon and authenticated through 0001's policy, and is writable by neither.
--
-- seed.sql no longer inserts feature_flags, so the row this file finds came from 0005; the migration
-- history is checked too. pgTAP is installed by 0001's test file outside its transaction; repeating
-- the statement keeps this file runnable on its own.
create extension if not exists pgtap with schema extensions;

begin;
select plan(17);

-- ---------------------------------------------------------------------------
-- the row, from the migration
-- ---------------------------------------------------------------------------
select is((select count(*)::int from supabase_migrations.schema_migrations
    where version = '0005' and array_to_string(statements, ' ') like '%feature_flags%on conflict (key) do nothing%'), 1,
  'migration 0005 inserts feature_flags with on conflict do nothing');
select is((select count(*)::int from public.app_config where key = 'feature_flags'), 1, 'the feature_flags row exists');
select is((select value from public.app_config where key = 'feature_flags'), '{"camera_beta": true, "auto_detect": true, "referral": true}'::jsonb,
  'it carries the M3 defaults');
select is((select array_agg(k || ':' || jsonb_typeof(value -> k) order by k) from public.app_config, jsonb_object_keys(value) k where key = 'feature_flags'),
  array['auto_detect:boolean', 'camera_beta:boolean', 'referral:boolean'], 'its value is an object of exactly three booleans');
select is((select is_public from public.app_config where key = 'feature_flags'), true, 'it is public');

-- re-running the insert never overwrites an operator's value
update public.app_config set value = '{"camera_beta": false, "auto_detect": false, "referral": false}' where key = 'feature_flags';
insert into public.app_config (key, value, is_public)
values ('feature_flags', '{"camera_beta": true, "auto_detect": true, "referral": true}'::jsonb, true)
on conflict (key) do nothing;
select is((select value ->> 'auto_detect' from public.app_config where key = 'feature_flags'), 'false', 'the migration''s insert leaves an existing value alone');
update public.app_config set value = '{"camera_beta": true, "auto_detect": true, "referral": true}' where key = 'feature_flags';

-- the posture 0001 set is unchanged
select policies_are('public', 'app_config', array['app_config_public']::name[], 'app_config still has exactly its one read policy');
select table_privs_are('public', 'app_config', 'anon', array['SELECT']::name[], 'anon may still only select app_config');
select table_privs_are('public', 'app_config', 'authenticated', array['SELECT']::name[], 'authenticated may still only select app_config');

-- ---------------------------------------------------------------------------
-- clients read it and cannot write it
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select value from public.app_config where key = 'feature_flags'), '{"camera_beta": true, "auto_detect": true, "referral": true}'::jsonb, 'anon reads the flags');
select throws_ok($$ update public.app_config set value = '{}' where key = 'feature_flags' $$, '42501', null, 'anon cannot update the flags');
select throws_ok($$ delete from public.app_config where key = 'feature_flags' $$, '42501', null, 'anon cannot delete the flags');
select throws_ok($$ insert into public.app_config (key, value, is_public) values ('feature_flags_2', '{}', true) $$, '42501', null, 'anon cannot insert a config row');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5"}', true);
select is((select value from public.app_config where key = 'feature_flags'), '{"camera_beta": true, "auto_detect": true, "referral": true}'::jsonb, 'authenticated reads the flags');
select throws_ok($$ update public.app_config set value = '{}' where key = 'feature_flags' $$, '42501', null, 'authenticated cannot update the flags');
select throws_ok($$ delete from public.app_config where key = 'feature_flags' $$, '42501', null, 'authenticated cannot delete the flags');
select throws_ok($$ insert into public.app_config (key, value, is_public) values ('feature_flags', '{}', true) on conflict (key) do update set value = excluded.value $$, '42501', null,
  'authenticated cannot upsert over the flags');
reset role;

select * from finish();
rollback;
