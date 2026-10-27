-- 0029_privacy_and_bounds: no point where a drive ended is kept; drive_overlaps finds a drive that
-- overlaps another of the same driver by more than a minute (never its own replay, never another
-- driver's, judged where apply_drive will store it), and such an upload is stored unscored; at most 5
-- friend-request pushes a day for one recipient while every request is still recorded; leave_clan is
-- server-only.
create extension if not exists pgtap with schema extensions;

begin;
select plan(36);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com'),
  ('00000000-0000-0000-0000-000000000005', 'e@example.com'),
  ('00000000-0000-0000-0000-000000000006', 'f@example.com'),
  ('00000000-0000-0000-0000-000000000007', 'g@example.com'),
  ('00000000-0000-0000-0000-000000000008', 'h@example.com'),
  ('00000000-0000-0000-0000-000000000009', 'i@example.com');
update public.profiles set username = 'usr' || right(id::text, 1), onboarded_at = now()
  where id::text like '00000000-0000-0000-0000-00000000000_';

-- the first drive's start, on a whole second
create temporary table clock as select date_trunc('second', now()) - interval '3 hours' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from clock $$;

-- a drive through apply_drive as finalize-trip sends it now (no end point): started p_start, p_dur
-- seconds long, p_miles, no events; p_env is merged into the envelope (scored, reason), p_payload
-- into the payload (an older finalize-trip's end point)
create function pg_temp.drive(p_user uuid, p_client uuid, p_start timestamptz, p_dur int, p_miles numeric, p_env jsonb default '{}'::jsonb,
  p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ms bigint := floor(extract(epoch from p_start) * 1000)::bigint;
begin
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', null, 'dashcam', null,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', v_ms, 'endedAt', v_ms + p_dur * 1000::bigint, 'tz', 'America/Los_Angeles',
      'localDay', to_char(p_start at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'miles', p_miles, 'nightMiles', 0, 'durationS', p_dur,
      'end', null, 'polyline', '', 'appVersion', '3.2.0', 'origin', 'auto', 'notDrivingExpired', false) || p_payload,
    'scored', true, 'reason', null, 'events', '[]'::jsonb, 'scoringVersion', 9) || p_env);
end $$;
create function pg_temp.t(p_client uuid) returns public.trips language sql stable as $$ select * from public.trips where client_trip_id = p_client $$;

-- ---------------------------------------------------------------------------
-- where a drive ended is not kept
-- ---------------------------------------------------------------------------
-- (scripts/seed-demo.js stores the synthetic demo account's drives with an end point: not a person's)
select is((select count(*)::int from public.progress g
    where (g.last_end_lat is not null or g.last_end_lng is not null)
      and g.user_id not in (select u.id from auth.users u where u.email = 'demo@roadwise.app')), 0,
  'no progress row holds the point where a drive ended');
-- a drive an older finalize-trip sent with its end point keeps it, until the driver's next drive
select pg_temp.drive('00000000-0000-0000-0000-000000000003', 'c0000000-0000-4000-8000-0000000000c1', now() - interval '2 days', 1200, 8, '{}'::jsonb,
  '{"end": {"lat": 47.6101, "lng": -122.3402}}'::jsonb);
select is((select array[last_end_lat, last_end_lng]::float8[] from public.progress where user_id = '00000000-0000-0000-0000-000000000003'),
  array[47.6101, -122.3402]::float8[], 'an older finalize-trip''s end point is the one 0029 clears');
select pg_temp.drive('00000000-0000-0000-0000-000000000003', 'c0000000-0000-4000-8000-0000000000c2', now() - interval '1 day', 1200, 8);
select is((select array[last_end_lat is null, last_end_lng is null, last_end_at is not null] from public.progress where user_id = '00000000-0000-0000-0000-000000000003'),
  array[true, true, true], 'the next drive, uploaded with no end point, clears it; the time of its end stays');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a1', pg_temp.t0(), 1800, 12);
select is((select array[scored, merged_into is null] from pg_temp.t('a0000000-0000-4000-8000-0000000000a1')), array[true, true], 'the first drive is stored scored');

-- ---------------------------------------------------------------------------
-- drive_overlaps: the first drive runs t0 .. t0 + 30 min
-- ---------------------------------------------------------------------------
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() + interval '10 minutes', pg_temp.t0() + interval '40 minutes'),
  true, 'a drive starting inside another overlaps it');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() + interval '5 minutes', pg_temp.t0() + interval '5 minutes 40 seconds'),
  true, 'a drive lying inside another overlaps it, however short');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() - interval '10 minutes', pg_temp.t0() + interval '50 minutes'),
  true, 'a drive around another overlaps it');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a1', pg_temp.t0(), pg_temp.t0() + interval '30 minutes'),
  false, 'a replay of the stored drive (its own clientTripId) is no overlap');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() + interval '29 minutes 30 seconds', pg_temp.t0() + interval '60 minutes'),
  false, 'a start under a minute before the other ended is slack, not an overlap');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() + interval '28 minutes', pg_temp.t0() + interval '60 minutes'),
  true, 'two minutes before it ended is');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() + interval '30 minutes', pg_temp.t0() + interval '60 minutes'),
  false, 'a drive starting as the other ends does not overlap it');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() - interval '60 minutes', pg_temp.t0() + interval '30 seconds'),
  false, 'a drive ending under a minute after the other started does not overlap it');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000002', gen_random_uuid(), pg_temp.t0() + interval '10 minutes', pg_temp.t0() + interval '40 minutes'),
  false, 'another driver''s drive is never this one''s overlap');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), pg_temp.t0() - interval '13 hours', pg_temp.t0() - interval '1 hour'),
  false, 'a drive long before is no overlap');
select throws_ok($$ select private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), now(), null) $$,
  '22023', 'user, clientTripId, startedAt and endedAt are required', 'every argument is required');

-- the clock rule: an upload dated 50..70 min ahead is stored ending now, over a drive that ended 5 min ago
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a2', now() - interval '20 minutes', 900, 5);
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), now() + interval '50 minutes', now() + interval '70 minutes'),
  true, 'a future-dated upload is judged where apply_drive will store it (ending now)');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', gen_random_uuid(), now() + interval '5 minutes', now() + interval '9 minutes'),
  false, 'one under 10 minutes ahead is judged as dated');

-- what finalize-trip stores for an overlapping upload: unscored as implausible, out of the rating
create temporary table before_overlap as select safety_rating, miles_90d from public.progress where user_id = '00000000-0000-0000-0000-000000000001';
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a3', pg_temp.t0() + interval '10 minutes', 1800, 40,
  '{"scored": false, "reason": "implausible"}'::jsonb);
select is((select array[(not scored)::text, reason, (merged_into is null)::text] from pg_temp.t('a0000000-0000-4000-8000-0000000000a3')),
  array['true', 'implausible', 'true'], 'the overlapping upload is stored as its own drive, unscored as implausible');
select is((select row(g.safety_rating, g.miles_90d)::text from public.progress g where g.user_id = '00000000-0000-0000-0000-000000000001'),
  (select row(b.safety_rating, b.miles_90d)::text from before_overlap b), 'and the rating and its miles are as they were');
select is(private.drive_overlaps('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a3', pg_temp.t0() + interval '10 minutes', pg_temp.t0() + interval '40 minutes'),
  true, 'its own replay still finds the first drive (finalize-trip answers a replay before asking)');

-- privileges: the engine's alone
select is(array[has_function_privilege('anon', 'private.drive_overlaps(uuid, uuid, timestamptz, timestamptz)', 'execute'),
    has_function_privilege('authenticated', 'private.drive_overlaps(uuid, uuid, timestamptz, timestamptz)', 'execute'),
    has_function_privilege('service_role', 'private.drive_overlaps(uuid, uuid, timestamptz, timestamptz)', 'execute')],
  array[false, false, true], 'drive_overlaps is server-only');
select is((select row(prosecdef, proconfig)::text from pg_proc where oid = 'private.drive_overlaps(uuid, uuid, timestamptz, timestamptz)'::regprocedure),
  row(false, array['search_path=public'])::text, 'drive_overlaps is an invoker function that pins search_path');

-- ---------------------------------------------------------------------------
-- friend requests: every request recorded, at most 5 pushes a day for one recipient
-- ---------------------------------------------------------------------------
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
create function pg_temp.pushes() returns int language sql stable as $$
  select count(*)::int from public.inbox where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'friend_request'
$$;
create function pg_temp.requests() returns int language sql stable as $$
  select count(*)::int from public.friend_requests where to_id = '00000000-0000-0000-0000-000000000001'
$$;

set local role authenticated;
select pg_temp.as_user(2);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
select pg_temp.as_user(3);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
select pg_temp.as_user(4);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
select pg_temp.as_user(5);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
select pg_temp.as_user(6);
select is(public.send_friend_request('00000000-0000-0000-0000-000000000001'), '{"status": "requested"}'::jsonb, 'the fifth request is sent');
reset role;
select is(array[pg_temp.requests(), pg_temp.pushes()], array[5, 5], 'five requests, five pushes');

set local role authenticated;
select pg_temp.as_user(7);
select is(public.send_friend_request('00000000-0000-0000-0000-000000000001'), '{"status": "requested"}'::jsonb, 'a sixth request in the day is still sent');
select pg_temp.as_user(8);
select is(public.send_friend_request('00000000-0000-0000-0000-000000000001'), '{"status": "requested"}'::jsonb, 'and a seventh');
reset role;
select is(array[pg_temp.requests(), pg_temp.pushes()], array[7, 5], 'both are recorded, neither pushes');
select is((select array_agg(r.from_id order by r.from_id) from public.friend_requests r where r.to_id = '00000000-0000-0000-0000-000000000001'
    and r.from_id in ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000008')),
  array['00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000008']::uuid[], 'the unpushed requests wait in Friends like any other');

-- deleting a sender takes their request and its push row (profile_gone), but gives no push back
delete from auth.users where id = '00000000-0000-0000-0000-000000000002';
select is(array[pg_temp.requests(), pg_temp.pushes()], array[6, 4], 'a deleted sender''s request and push row go with the account');
set local role authenticated;
select pg_temp.as_user(9);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
reset role;
select is(array[pg_temp.requests(), pg_temp.pushes()], array[7, 4], 'and free no push: the recipient''s count is their own');

-- a day later the count starts again; a re-sent request then pushes, and a second re-send spends nothing
update public.rate_limits set window_start = now() - interval '25 hours'
  where user_id = '00000000-0000-0000-0000-000000000001' and key = 'friend_request_push';
set local role authenticated;
select pg_temp.as_user(7);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
reset role;
select is(array[pg_temp.requests(), pg_temp.pushes()], array[7, 5], 'past the 24-hour window a request pushes again');
set local role authenticated;
select pg_temp.as_user(7);
select public.send_friend_request('00000000-0000-0000-0000-000000000001');
reset role;
select is((select count from public.rate_limits where user_id = '00000000-0000-0000-0000-000000000001' and key = 'friend_request_push'), 1,
  'a request already pushed, sent again, spends no push');

-- the cap is the recipient's: another driver is pushed as before
set local role authenticated;
select pg_temp.as_user(4);
select public.send_friend_request('00000000-0000-0000-0000-000000000003');
reset role;
select is((select count(*)::int from public.inbox where user_id = '00000000-0000-0000-0000-000000000003' and kind = 'friend_request'), 1,
  'another recipient gets their push');
select is(has_function_privilege('authenticated', 'public.send_friend_request(uuid)', 'execute'), true, 'send_friend_request is still the client''s to call');

-- ---------------------------------------------------------------------------
-- leave_clan: server-only like every clan RPC
-- ---------------------------------------------------------------------------
select is(array[has_function_privilege('anon', 'public.leave_clan()', 'execute'), has_function_privilege('authenticated', 'public.leave_clan()', 'execute')],
  array[false, false], 'no client role may call leave_clan');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%clan%'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no clan function in public is executable by a client role');

select * from finish();
rollback;
