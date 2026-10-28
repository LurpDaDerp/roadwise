-- 0031_app_attest: the App Attest challenges (one use, 5 minutes, 20 a user an hour) and keys (one
-- user's each, at most 10 a user, 10 attestations a user a day), the counter that only moves up,
-- the Android flag finalize-trip reads, and both tables closed to every API role and gone with
-- the account.
create extension if not exists pgtap with schema extensions;

begin;
select plan(50);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com');

-- a 32-byte challenge hash and a 44-character key id from a small number; a 65-byte EC point
create function pg_temp.h(n int) returns bytea language sql immutable as $$ select extensions.digest('challenge-' || n, 'sha256') $$;
create function pg_temp.k(n int) returns text language sql immutable as $$ select encode(extensions.digest('key-' || n, 'sha256'), 'base64') $$;
create function pg_temp.pk(n int) returns bytea language sql immutable as $$
  select '\x04'::bytea || extensions.digest('x-' || n, 'sha256') || extensions.digest('y-' || n, 'sha256') $$;

-- ---------------------------------------------------------------------------
-- closed to the API roles
-- ---------------------------------------------------------------------------
select is((select array_agg(c.relrowsecurity order by c.relname) from pg_class c
    where c.relnamespace = 'private'::regnamespace and c.relname in ('app_attest_challenges', 'app_attest_keys')),
  array[true, true], 'both tables have RLS on');
select is((select count(*)::int from information_schema.role_table_grants g
    where g.table_schema = 'private' and g.table_name in ('app_attest_challenges', 'app_attest_keys') and g.grantee in ('anon', 'authenticated', 'public')), 0,
  'no API role holds a privilege on either table');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'app\_attest\_%'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no app_attest function is executable by a client role');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'app\_attest\_%' and p.prosecdef), 0,
  'every app_attest function runs as its caller');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'app\_attest\_%'
    and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')), 0,
  'every app_attest function pins its search_path');
set local role authenticated;
select throws_ok($$ select count(*) from private.app_attest_keys $$, '42501', null, 'a signed-in client cannot read the keys');
reset role;

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
select is(private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(1)), true, 'a challenge is issued');
select is((select expires_at - now() from private.app_attest_challenges where challenge_hash = pg_temp.h(1)), interval '5 minutes',
  'it lives 5 minutes');
select throws_ok($$ select private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', '\x00'::bytea) $$, '22023',
  'user and a 32-byte challenge hash are required', 'a hash that is not 32 bytes is refused');
select is(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000002', pg_temp.h(1)), 'unknown', 'another user cannot use it');
select is(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(1)), 'taken', 'its user uses it');
select is(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(1)), 'unknown', 'once');
select is((select count(*)::int from private.app_attest_challenges where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'a used challenge is gone');

-- an expired challenge is not taken, and the next issue clears the user's expired ones
select private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(2));
update private.app_attest_challenges set expires_at = now() - interval '1 second' where challenge_hash = pg_temp.h(2);
select is(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(2)), 'unknown', 'an expired challenge is not taken');
select private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(3));
update private.app_attest_challenges set expires_at = now() - interval '1 second' where challenge_hash = pg_temp.h(3);
select private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(4));
select is((select array_agg(challenge_hash = pg_temp.h(4)) from private.app_attest_challenges where user_id = '00000000-0000-0000-0000-000000000001'),
  array[true], 'issuing clears the user''s expired challenges');

-- 20 an hour: this user has had 4; 16 more, then no more until the hour is out
select is((select bool_and(private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(100 + n))) from generate_series(1, 16) n),
  true, 'up to 20 challenges an hour');
select is(private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(200)), false, 'the 21st in the hour is refused');
select is((select count(*)::int from private.app_attest_challenges where challenge_hash = pg_temp.h(200)), 0, 'and not stored');
update public.rate_limits set window_start = now() - interval '61 minutes'
  where user_id = '00000000-0000-0000-0000-000000000001' and key = 'app_attest_challenge';
select is(private.app_attest_issue_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(200)), true, 'a new hour issues again');

-- 10 attestations a day: this user has made 3; 7 more, then 'limited' (the challenge stays)
select is((select array_agg(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(100 + n)) order by n) from generate_series(1, 7) n),
  array['taken', 'taken', 'taken', 'taken', 'taken', 'taken', 'taken'], 'up to 10 attestations a day');
select is(private.app_attest_take_challenge('00000000-0000-0000-0000-000000000001', pg_temp.h(108)), 'limited', 'the 11th in the day is refused');
select is((select count(*)::int from private.app_attest_challenges where challenge_hash = pg_temp.h(108)), 1, 'its challenge is left for later');

-- ---------------------------------------------------------------------------
-- keys
-- ---------------------------------------------------------------------------
select is(private.app_attest_save_key('00000000-0000-0000-0000-000000000001', pg_temp.k(1), pg_temp.pk(1), 'production'), 'saved', 'a verified key is saved');
select is((select array[counter::text, environment] from private.app_attest_keys where key_id = pg_temp.k(1)), array['0', 'production'],
  'with counter 0 and its environment');
select is(private.app_attest_save_key('00000000-0000-0000-0000-000000000001', pg_temp.k(1), pg_temp.pk(9), 'development'), 'known',
  'the same key again is known');
select is((select array[public_key = pg_temp.pk(1), environment = 'production'] from private.app_attest_keys where key_id = pg_temp.k(1)),
  array[true, true], 'and kept as it was');
select is(private.app_attest_save_key('00000000-0000-0000-0000-000000000002', pg_temp.k(1), pg_temp.pk(1), 'production'), 'taken',
  'another user''s key cannot be saved');
select throws_ok($$ select private.app_attest_save_key('00000000-0000-0000-0000-000000000001', 'not a key id', pg_temp.pk(1), 'production') $$,
  '22023', 'user, key id, a 65-byte key and an environment are required', 'a malformed key id is refused');
select throws_ok($$ select private.app_attest_save_key('00000000-0000-0000-0000-000000000001', pg_temp.k(2), pg_temp.pk(2), 'staging') $$,
  '22023', 'user, key id, a 65-byte key and an environment are required', 'an unknown environment is refused');
select throws_ok($$ insert into private.app_attest_keys (key_id, user_id, public_key, environment)
    values (pg_temp.k(3), '00000000-0000-0000-0000-000000000001', '\x05'::bytea || substring(pg_temp.pk(3) from 2), 'production') $$,
  '23514', null, 'a key that is not an uncompressed point is refused by the table');

-- at most 10 keys a user: the least recently used go
update private.app_attest_keys set last_used_at = now() - interval '1 day' where key_id = pg_temp.k(1);
select private.app_attest_save_key('00000000-0000-0000-0000-000000000003', pg_temp.k(300 + n), pg_temp.pk(300 + n), 'production') from generate_series(1, 9) n;
update private.app_attest_keys set last_used_at = now() - interval '2 days' where key_id = pg_temp.k(301);
select private.app_attest_save_key('00000000-0000-0000-0000-000000000003', pg_temp.k(310), pg_temp.pk(310), 'production');
select is((select count(*)::int from private.app_attest_keys where user_id = '00000000-0000-0000-0000-000000000003'), 10, 'ten keys are kept');
select private.app_attest_save_key('00000000-0000-0000-0000-000000000003', pg_temp.k(311), pg_temp.pk(311), 'production');
select is((select array[count(*)::int, count(*) filter (where key_id = pg_temp.k(301))::int, count(*) filter (where key_id = pg_temp.k(311))::int]
    from private.app_attest_keys where user_id = '00000000-0000-0000-0000-000000000003'), array[10, 0, 1],
  'the eleventh pushes out the least recently used, never the new one');

-- ---------------------------------------------------------------------------
-- an upload's check: the key, whether the account may post as Android, the counter
-- ---------------------------------------------------------------------------
select is(private.app_attest_context('00000000-0000-0000-0000-000000000001', pg_temp.k(1)),
  jsonb_build_object('key', jsonb_build_object('publicKey', encode(pg_temp.pk(1), 'hex'), 'counter', 0, 'environment', 'production'), 'androidOnly', false),
  'the user''s key, by id');
select is(private.app_attest_context('00000000-0000-0000-0000-000000000002', pg_temp.k(1)) -> 'key', 'null'::jsonb, 'never another user''s key');
select is(private.app_attest_context('00000000-0000-0000-0000-000000000001', pg_temp.k(77)) -> 'key', 'null'::jsonb, 'an unknown key is null');
select is(private.app_attest_context('00000000-0000-0000-0000-000000000001', null) -> 'key', 'null'::jsonb, 'no key named is null');

-- posting as Android needs an Android device and never an iPhone: no iOS device registered, no App Attest key
create function pg_temp.android_only(p int) returns boolean language sql as $$
  select (private.app_attest_context(('00000000-0000-0000-0000-00000000000' || p)::uuid, null) ->> 'androidOnly')::boolean $$;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true) $$;
grant execute on function pg_temp.as_user(int) to authenticated;
insert into public.devices (user_id, device_id, platform) values ('00000000-0000-0000-0000-000000000002', 'device-android-2', 'android'),
  ('00000000-0000-0000-0000-000000000003', 'device-android-3', 'android');
select is(pg_temp.android_only(2), true, 'an account with only an Android device may post as Android');
select is(pg_temp.android_only(3), false, 'an account with an App Attest key attests every upload, whatever else it registers');
select is(pg_temp.android_only(1), false, 'an account with no Android device has nothing to post as');

-- register_device: an iPhone's row stays an iPhone's, so an account cannot re-label its phone
set local role authenticated;
select pg_temp.as_user(2);
select lives_ok($$ select public.register_device('device-ios-0002', 'ios') $$, 'the Android account registers an iPhone');
select throws_ok($$ select public.register_device('device-ios-0002', 'android') $$, '22023', 'an iOS device cannot become an Android device',
  'that iPhone cannot be registered again as Android');
select lives_ok($$ select public.register_device('device-android-2', 'android') $$, 'its Android device registers as before');
reset role;
select is((select platform from public.devices where user_id = '00000000-0000-0000-0000-000000000002' and device_id = 'device-ios-0002'), 'ios',
  'the row stays ios');
select is(pg_temp.android_only(2), false, 'an account with an iPhone registered attests every upload');

select is(private.app_attest_advance('00000000-0000-0000-0000-000000000001', pg_temp.k(1), 3), true, 'a higher counter is stored');
select is(private.app_attest_advance('00000000-0000-0000-0000-000000000001', pg_temp.k(1), 3), false, 'the same counter again is refused');
select is(private.app_attest_advance('00000000-0000-0000-0000-000000000001', pg_temp.k(1), 2), false, 'a lower one too');
select is(private.app_attest_advance('00000000-0000-0000-0000-000000000002', pg_temp.k(1), 9), false, 'another user cannot move it');
select is((select array[counter::int, (last_used_at = now())::int] from private.app_attest_keys where key_id = pg_temp.k(1)), array[3, 1],
  'the key holds the highest counter, used now');

-- ---------------------------------------------------------------------------
-- gone with the account
-- ---------------------------------------------------------------------------
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is((select count(*)::int from private.app_attest_keys where user_id = '00000000-0000-0000-0000-000000000001')
    + (select count(*)::int from private.app_attest_challenges where user_id = '00000000-0000-0000-0000-000000000001'), 0,
  'deleting the account deletes its keys and challenges');

select * from finish();
rollback;
