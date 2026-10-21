-- 0024_live_activity: the push-to-start token on the device row (its shape, server-only), register
-- and release, the token moving with the install, and claim_live_activity_start (the caller's own
-- token only, one send per drive and leg in 15 minutes so a re-opened drive gets its activity back,
-- 30 claims an hour, grants).
create extension if not exists pgtap with schema extensions;

begin;
select plan(36);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
create temporary table tok as select repeat('ab', 32) as a, repeat('cd', 32) as c;
grant select on tok to authenticated;

-- ---------------------------------------------------------------------------
-- the column and the grants
-- ---------------------------------------------------------------------------
select has_column('public', 'devices', 'live_activity_token', 'devices hold a push-to-start token');
select has_index('public', 'devices', 'devices_live_activity_token_idx', 'indexed for the move-with-the-install lookup');
select throws_ok($$ insert into public.devices (user_id, device_id, platform, live_activity_token) values ('00000000-0000-0000-0000-000000000001', 'device-zzzzzzzz', 'ios', 'NOT-HEX') $$,
  '23514', null, 'a token that is not lowercase hex is refused by the table');
select throws_ok($$ insert into public.devices (user_id, device_id, platform, live_activity_token) values ('00000000-0000-0000-0000-000000000001', 'device-zzzzzzzz', 'ios', 'abcd') $$,
  '23514', null, 'and one shorter than 32 characters');
select is((select count(*)::int from information_schema.role_table_grants g where g.grantee in ('anon', 'authenticated') and g.table_schema = 'public' and g.table_name = 'devices'), 0,
  'devices still have no client grant (the token is server-only)');
select is(array[has_function_privilege('authenticated', 'public.register_device(text, text, text, text)', 'execute'), has_function_privilege('anon', 'public.register_device(text, text, text, text)', 'execute')],
  array[true, false], 'register_device with the token: authenticated only');
select hasnt_function('public', 'register_device', array['text', 'text', 'text'], 'the three-argument form is gone (a call naming three arguments still resolves)');
select is(array[has_function_privilege('authenticated', 'public.claim_live_activity_start(text, uuid, int)', 'execute'), has_function_privilege('anon', 'public.claim_live_activity_start(text, uuid, int)', 'execute')],
  array[true, false], 'claim_live_activity_start: authenticated only');
select is_definer('public', 'claim_live_activity_start', array['text', 'uuid', 'integer']::name[], 'claim_live_activity_start is security definer');
select hasnt_function('public', 'claim_live_activity_start', array['text', 'uuid'], 'one form only: the leg defaults to 0, so a call naming two arguments still resolves');

-- ---------------------------------------------------------------------------
-- register and release
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
select throws_ok($$ select public.register_device('device-aaaaaaaa', 'ios', null, 'NOT-HEX') $$, '22023', 'invalid live activity token', 'a malformed token is refused');
select throws_ok($$ select public.register_device('device-aaaaaaaa', 'android', null, (select a from tok)) $$, '22023', 'invalid live activity token', 'an Android device has no push-to-start');
select lives_ok($$ select public.register_device('device-aaaaaaaa', 'ios', 'ExponentPushToken[aaaaaaaaaaaa]', (select a from tok)) $$, 'A registers the phone with both tokens');
select lives_ok($$ select public.register_device(p_device_id := 'device-aaaaaaaa', p_platform := 'ios', p_push_token := 'ExponentPushToken[aaaaaaaaaaaa]') $$,
  'a call naming three arguments (an older build) still works');
reset role;
select is((select live_activity_token from public.devices where user_id = '00000000-0000-0000-0000-000000000001' and device_id = 'device-aaaaaaaa'), (select a from tok),
  'a call without the token keeps the one stored');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- the claim
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.claim_live_activity_start('short', gen_random_uuid()) $$, '22023', 'device_id must be 8 to 128 characters', 'a malformed device id is refused');
select throws_ok($$ select public.claim_live_activity_start('device-aaaaaaaa', null) $$, '22023', 'client_trip_id is required', 'a drive is required');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001'), jsonb_build_object('token', (select a from tok), 'duplicate', false),
  'the first claim for a drive hands back the token');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001'), jsonb_build_object('token', (select a from tok), 'duplicate', true),
  'a second claim for the same drive within 15 minutes is a duplicate');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 0) ->> 'duplicate', 'true', 'leg 0 named is the same claim as leg 0 left out');
-- a drive re-opened after a stop: its next leg gets its Live Activity back within the 15 minutes
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 1), jsonb_build_object('token', (select a from tok), 'duplicate', false),
  'the same drive''s leg 1 after leg 0 is a fresh claim');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 1) ->> 'duplicate', 'true', 'the same drive and the same leg within 15 minutes is a duplicate');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 0) ->> 'duplicate', 'true', 'and a late retry of the leg it replaced too');
select throws_ok($$ select public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 51) $$, '22023', 'leg must be 0 to 50', 'a leg past 50 is refused');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000002') ->> 'duplicate', 'false', 'another drive is a fresh claim');
reset role;
update public.devices set live_activity_sent_at = now() - interval '16 minutes' where device_id = 'device-aaaaaaaa';
set local role authenticated;
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000002') ->> 'duplicate', 'false', 'after 15 minutes the same drive may be claimed again');
select is(public.claim_live_activity_start('device-nothing0', 'aaaaaaaa-0000-4000-8000-000000000003'), '{"token": null, "duplicate": false}'::jsonb,
  'a device that registered no token (or is not the caller''s) answers no token');

-- B cannot claim A's device
select pg_temp.as_user(2);
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000004'), '{"token": null, "duplicate": false}'::jsonb,
  'another account claiming A''s device id gets nothing');
-- the token moves with the install: B signs in on that phone
select lives_ok($$ select public.register_device('device-aaaaaaaa', 'ios', null, (select a from tok)) $$, 'B registers on the same install with its token');
reset role;
select is((select array_agg(user_id::text || '=' || coalesce(live_activity_token, '-') order by user_id) from public.devices where device_id = 'device-aaaaaaaa'),
  array['00000000-0000-0000-0000-000000000001=-', '00000000-0000-0000-0000-000000000002=' || (select a from tok)], 'no other row keeps it');
select is((select live_activity_drive from public.devices where user_id = '00000000-0000-0000-0000-000000000001' and device_id = 'device-aaaaaaaa'), null, 'and A''s claim on it is cleared');

-- release clears it
set local role authenticated;
select pg_temp.as_user(2);
select lives_ok($$ select public.release_device('device-aaaaaaaa') $$, 'B signs out');
reset role;
select is((select row(push_token, live_activity_token, live_activity_drive, live_activity_leg, live_activity_sent_at)::text from public.devices where user_id = '00000000-0000-0000-0000-000000000002'),
  row(null::text, null::text, null::uuid, null::int, null::timestamptz)::text, 'release clears the push token, the push-to-start token and its claim');
set local role authenticated;
select pg_temp.as_user(2);
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000005') -> 'token', 'null'::jsonb, 'nothing to claim after sign-out');

-- 30 claims an hour per account
reset role;
update public.devices set live_activity_token = (select c from tok) where user_id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
select is((select count(*)::int from generate_series(1, 28) i where public.claim_live_activity_start('device-aaaaaaaa', gen_random_uuid()) ->> 'token' is not null), 28,
  'B spends the hour''s budget (30 with the two above)');
select throws_ok($$ select public.claim_live_activity_start('device-aaaaaaaa', gen_random_uuid()) $$, '42501', 'too many requests', 'the 31st claim in an hour is refused');
reset role;

select * from finish();
rollback;
