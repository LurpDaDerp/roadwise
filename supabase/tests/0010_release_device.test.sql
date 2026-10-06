-- 0010_release_device: the caller's own token goes; nothing else moves; anon is refused.
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
insert into public.devices (user_id, device_id, platform, push_token) values
  ('00000000-0000-0000-0000-000000000001', 'device-aaaaaaaa', 'ios', 'ExponentPushToken[aaaaaaaaaaaa]'),
  ('00000000-0000-0000-0000-000000000002', 'device-aaaaaaaa', 'ios', 'ExponentPushToken[bbbbbbbbbbbb]'),
  ('00000000-0000-0000-0000-000000000001', 'device-cccccccc', 'android', 'ExponentPushToken[cccccccccccc]');
insert into public.device_league_claims (device_id, user_id) values ('device-aaaaaaaa', '00000000-0000-0000-0000-000000000001');

select is_definer('public', 'release_device', array['text']::name[], 'release_device is security definer');
select is(array[has_function_privilege('anon', 'public.release_device(text)', 'execute'), has_function_privilege('authenticated', 'public.release_device(text)', 'execute')],
  array[false, true], 'executable by authenticated only');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.release_device('short') $$, '22023', 'device_id must be 8 to 128 characters', 'a malformed id is refused');
select lives_ok($$ select public.release_device('device-aaaaaaaa') $$, 'A releases the phone');
select lives_ok($$ select public.release_device('device-aaaaaaaa') $$, 'releasing again is a no-op');
select lives_ok($$ select public.release_device('device-nobody00') $$, 'an unknown device is the same no-op (no existence oracle)');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.release_device('device-aaaaaaaa') $$, '42501', 'release_device requires an authenticated user', 'a JWT without sub is refused');
set local role anon;
select throws_ok($$ select public.release_device('device-aaaaaaaa') $$, '42501', null, 'anon is refused');
reset role;

select is((select array_agg(coalesce(push_token, '-') order by user_id, device_id) from public.devices),
  array['-', 'ExponentPushToken[cccccccccccc]', 'ExponentPushToken[bbbbbbbbbbbb]'],
  'only A''s token on that device is cleared: A''s other device and B''s row on the same device keep theirs; the claim stays');

select * from finish();
rollback;
