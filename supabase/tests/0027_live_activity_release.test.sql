-- 0027_live_activity_release: a failed push-to-start hands its claim back (the caller's own device,
-- only while the row still records that drive and leg), so the retry is a fresh claim; another
-- drive's or a newer leg's claim stays; grants; refusals.
create extension if not exists pgtap with schema extensions;

begin;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
insert into public.devices (user_id, device_id, platform, live_activity_token) values
  ('00000000-0000-0000-0000-000000000001', 'device-aaaaaaaa', 'ios', repeat('ab', 32));

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
select is(array[has_function_privilege('authenticated', 'public.release_live_activity_start(text, uuid, int)', 'execute'),
    has_function_privilege('anon', 'public.release_live_activity_start(text, uuid, int)', 'execute')],
  array[true, false], 'release_live_activity_start: authenticated only');
select is_definer('public', 'release_live_activity_start', array['text', 'uuid', 'integer']::name[], 'release_live_activity_start is security definer');

-- ---------------------------------------------------------------------------
-- refusals
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
select throws_ok($$ select public.release_live_activity_start('short', gen_random_uuid()) $$, '22023', 'device_id must be 8 to 128 characters', 'a malformed device id is refused');
select throws_ok($$ select public.release_live_activity_start('device-aaaaaaaa', null) $$, '22023', 'client_trip_id is required', 'a drive is required');
select throws_ok($$ select public.release_live_activity_start('device-aaaaaaaa', gen_random_uuid(), 51) $$, '22023', 'leg must be 0 to 50', 'a leg past 50 is refused');

-- ---------------------------------------------------------------------------
-- a failed send hands its claim back, so the retry goes through
-- ---------------------------------------------------------------------------
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001') ->> 'duplicate', 'false', 'the first claim for a drive');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001') ->> 'duplicate', 'true', 'a repeat is a duplicate');
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001'), true, 'the failed send hands its claim back');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001'), jsonb_build_object('token', repeat('ab', 32), 'duplicate', false),
  'and the retry is a fresh claim with the token');
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 0), true, 'leg 0 named is the claim with the leg left out');
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001'), false, 'a second release finds nothing to hand back');

-- another drive's or a newer leg's claim is left alone
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 1) ->> 'duplicate', 'false', 'the drive re-opened: leg 1 claimed');
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 0), false, 'a late release of leg 0 leaves leg 1''s claim');
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000002', 1), false, 'and so does a release for another drive');
select is(public.claim_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 1) ->> 'duplicate', 'true', 'leg 1 is still claimed');

-- B cannot release A's claim
select pg_temp.as_user(2);
select is(public.release_live_activity_start('device-aaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 1), false, 'another account releasing A''s device gets nothing');
reset role;
select isnt((select live_activity_sent_at from public.devices where user_id = '00000000-0000-0000-0000-000000000001' and device_id = 'device-aaaaaaaa'), null,
  'and A''s claim stands');

select * from finish();
rollback;
