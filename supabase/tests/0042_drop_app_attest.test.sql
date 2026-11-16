-- 0042_drop_app_attest: the App Attest tables, functions and rate-limit rows are gone, nothing left
-- reads them, and register_device still registers an iPhone (with no iPhone time to stamp) and an
-- Android phone as before: the same grants, definer, search_path and refusals.
create extension if not exists pgtap with schema extensions;

begin;
select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com');

-- ---------------------------------------------------------------------------
-- what is gone
-- ---------------------------------------------------------------------------
select hasnt_table('private', 'app_attest_challenges', 'the App Attest challenges are gone');
select hasnt_table('private', 'app_attest_keys', 'the App Attest keys are gone');
select hasnt_table('private', 'ios_activity', 'the account''s iPhone time is gone');
select is((select count(*)::int from pg_class c where c.relname = 'app_attest_keys_user_idx'), 0, 'the keys'' index went with them');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and (p.proname like 'app\_attest\_%' or p.proname = 'stamp_ios')), 0,
  'no app_attest function or stamp_ios is left');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and (p.prosrc like '%app\_attest%' or p.prosrc like '%stamp\_ios%' or p.prosrc like '%ios\_activity%')), 0,
  'no function reads a dropped table or calls a dropped function');
select is((select count(*)::int from public.rate_limits where key in ('app_attest_challenge', 'app_attest_attest')), 0,
  'no App Attest rate-limit row is kept');

-- ---------------------------------------------------------------------------
-- register_device: as before, without the iPhone time
-- ---------------------------------------------------------------------------
select is(array[has_function_privilege('authenticated', 'public.register_device(text, text, text, text)', 'execute'),
    has_function_privilege('anon', 'public.register_device(text, text, text, text)', 'execute')],
  array[true, false], 'register_device: authenticated only');
select is((select array[p.prosecdef::text, array_to_string(p.proconfig, ',')] from pg_proc p where p.oid = 'public.register_device(text, text, text, text)'::regprocedure),
  array['true', 'search_path=public'], 'register_device runs as its definer with search_path public');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.register_device('device-ios-0001', 'ios', 'ExponentPushToken[abcdefgh12345]') $$, 'an iPhone registers');
select throws_ok($$ select public.register_device('device-ios-0001', 'android') $$, '22023', 'an iOS device cannot become an Android device',
  'that install still cannot be registered again as Android');
select lives_ok($$ select public.register_device('device-android-1', 'android') $$, 'an Android phone registers');
reset role;
select is((select array_agg(row(device_id, platform, push_token)::text order by device_id) from public.devices
    where user_id = '00000000-0000-0000-0000-000000000001'),
  array[row('device-android-1', 'android', null::text)::text, row('device-ios-0001', 'ios', 'ExponentPushToken[abcdefgh12345]')::text],
  'both rows are stored as registered');

-- ---------------------------------------------------------------------------
-- an account delete still runs
-- ---------------------------------------------------------------------------
select lives_ok($$ delete from auth.users where id = '00000000-0000-0000-0000-000000000001' $$, 'deleting the account runs');
select is((select count(*)::int from public.devices where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'and its devices go with it');

select * from finish();
rollback;
