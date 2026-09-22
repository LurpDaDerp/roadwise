-- 0005_app_config_flags: the feature_flags and min_app_version rows exist after the migrations alone,
-- have their shapes, are readable by anon and authenticated through 0001's policy, and are writable
-- by neither.
--
-- seed.sql inserts no app_config row, so the rows this file finds came from 0005; the migration
-- history is checked too. pgTAP is installed by 0001's test file outside its transaction; repeating
-- the statement keeps this file runnable on its own.
create extension if not exists pgtap with schema extensions;

begin;
select plan(25);

-- ---------------------------------------------------------------------------
-- the row, from the migration
-- ---------------------------------------------------------------------------
select is((select count(*)::int from supabase_migrations.schema_migrations
    where version = '0005' and array_to_string(statements, ' ') like '%feature_flags%on conflict (key) do nothing%'), 1,
  'migration 0005 inserts feature_flags with on conflict do nothing');
select is((select count(*)::int from public.app_config where key = 'feature_flags'), 1, 'the feature_flags row exists');
-- 0006 merges guardian_invites into this row; M3's three flags are asserted independently of it
select is((select value - 'guardian_invites' from public.app_config where key = 'feature_flags'), '{"camera_beta": false, "auto_detect": true, "referral": false}'::jsonb,
  'it carries the M3 defaults');
select is((select array_agg(k || ':' || jsonb_typeof(value -> k) order by k) from public.app_config, jsonb_object_keys(value - 'guardian_invites') k where key = 'feature_flags'),
  array['auto_detect:boolean', 'camera_beta:boolean', 'referral:boolean'], 'apart from 0006''s guardian_invites, its value is an object of exactly three booleans');
select is((select is_public from public.app_config where key = 'feature_flags'), true, 'it is public');
select is((select count(*)::int from supabase_migrations.schema_migrations
    where version = '0005' and array_to_string(statements, ' ') like '%min_app_version%on conflict (key) do nothing%'), 1,
  'migration 0005 inserts min_app_version with on conflict do nothing');
select is((select row(value, jsonb_typeof(value), is_public)::text from public.app_config where key = 'min_app_version'), row('"2.0.0"'::jsonb, 'string', true)::text,
  'min_app_version exists as the public JSON string "2.0.0"');

-- re-running the insert never overwrites an operator's value
update public.app_config set value = '{"camera_beta": false, "auto_detect": false, "referral": false}' where key = 'feature_flags';
insert into public.app_config (key, value, is_public)
values ('feature_flags', '{"camera_beta": false, "auto_detect": true, "referral": false}'::jsonb, true)
on conflict (key) do nothing;
select is((select value ->> 'auto_detect' from public.app_config where key = 'feature_flags'), 'false', 'the migration''s insert leaves an existing value alone');
update public.app_config set value = '{"camera_beta": false, "auto_detect": true, "referral": false}' where key = 'feature_flags';
update public.app_config set value = '"2.1.0"' where key = 'min_app_version';
insert into public.app_config (key, value, is_public) values ('min_app_version', '"2.0.0"'::jsonb, true) on conflict (key) do nothing;
select is((select value #>> '{}' from public.app_config where key = 'min_app_version'), '2.1.0', 'and an operator''s min_app_version too');
update public.app_config set value = '"2.0.0"' where key = 'min_app_version';

-- the posture 0001 set is unchanged
select policies_are('public', 'app_config', array['app_config_public']::name[], 'app_config still has exactly its one read policy');
select table_privs_are('public', 'app_config', 'anon', array['SELECT']::name[], 'anon may still only select app_config');
select table_privs_are('public', 'app_config', 'authenticated', array['SELECT']::name[], 'authenticated may still only select app_config');

-- ---------------------------------------------------------------------------
-- clients read it and cannot write it
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select value from public.app_config where key = 'feature_flags'), '{"camera_beta": false, "auto_detect": true, "referral": false}'::jsonb, 'anon reads the flags');
select throws_ok($$ update public.app_config set value = '{}' where key = 'feature_flags' $$, '42501', null, 'anon cannot update the flags');
select throws_ok($$ delete from public.app_config where key = 'feature_flags' $$, '42501', null, 'anon cannot delete the flags');
select throws_ok($$ insert into public.app_config (key, value, is_public) values ('feature_flags_2', '{}', true) $$, '42501', null, 'anon cannot insert a config row');
select is((select value from public.app_config where key = 'min_app_version'), '"2.0.0"'::jsonb, 'anon reads min_app_version');
select throws_ok($$ update public.app_config set value = '"0.0.1"' where key = 'min_app_version' $$, '42501', null, 'anon cannot update min_app_version');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5"}', true);
select is((select value from public.app_config where key = 'feature_flags'), '{"camera_beta": false, "auto_detect": true, "referral": false}'::jsonb, 'authenticated reads the flags');
select throws_ok($$ update public.app_config set value = '{}' where key = 'feature_flags' $$, '42501', null, 'authenticated cannot update the flags');
select throws_ok($$ delete from public.app_config where key = 'feature_flags' $$, '42501', null, 'authenticated cannot delete the flags');
select throws_ok($$ insert into public.app_config (key, value, is_public) values ('feature_flags', '{}', true) on conflict (key) do update set value = excluded.value $$, '42501', null,
  'authenticated cannot upsert over the flags');
select is((select value from public.app_config where key = 'min_app_version'), '"2.0.0"'::jsonb, 'authenticated reads min_app_version');
select throws_ok($$ update public.app_config set value = '"0.0.1"' where key = 'min_app_version' $$, '42501', null, 'authenticated cannot update min_app_version');
select throws_ok($$ delete from public.app_config where key = 'min_app_version' $$, '42501', null, 'authenticated cannot delete min_app_version');
reset role;

select * from finish();
rollback;
