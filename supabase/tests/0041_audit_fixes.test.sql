-- 0041_audit_fixes: user_tz reads the stored zone without scanning pg_timezone_names and falls back to
-- New York for a zone of the wrong shape or one the server does not know; the friend RPCs refuse a
-- caller who never finished setting up and list_friends leaves such accounts out; a refusal after the
-- rate-limit take is answered (PostgREST's error body and status), so the take stands; a
-- friend-request push whose request was cancelled or ended by a block is skipped at the claim, while a
-- standing one is sent.
create extension if not exists pgtap with schema extensions;

begin;
select plan(20);

-- ann (01), bob (02), cal (03), dee (06) and eve (05) are set up; 04 signed in and stopped there
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-00000000000' || g)::uuid, 'u' || g || '@example.com' from generate_series(1, 6) g;
update public.profiles p set username = v.name, onboarded_at = now()
  from (values ('00000000-0000-0000-0000-000000000001'::uuid, 'ann'), ('00000000-0000-0000-0000-000000000002'::uuid, 'bob'),
               ('00000000-0000-0000-0000-000000000003'::uuid, 'cal'), ('00000000-0000-0000-0000-000000000005'::uuid, 'eve'),
               ('00000000-0000-0000-0000-000000000006'::uuid, 'dee')) v(id, name)
  where p.id = v.id;
insert into public.notification_prefs (user_id, tz) values ('00000000-0000-0000-0000-000000000001', 'America/Chicago'),
  ('00000000-0000-0000-0000-000000000002', 'Mars/Olympus'), ('00000000-0000-0000-0000-000000000003', 'posix/America/Chicago')
  on conflict (user_id) do update set tz = excluded.tz;
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, polyline, clean,
    slowdowns, speedups, turns, limit_s, moving_s)
  values ('00000000-0000-0000-0000-000000000005', gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '20 minutes', current_date,
    private.league_week(now()), 'Europe/Paris', 5, 0, 1200, true, 'poly-eve', true, 5, 5, 3, 600, 1000);

create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
create function pg_temp.taken(p int, p_key text) returns int language sql stable as $$
  select coalesce((select r.count from public.rate_limits r
    where r.user_id = ('00000000-0000-0000-0000-00000000000' || p)::uuid and r.key = p_key), 0)
$$;

-- ---------------------------------------------------------------------------
-- the time zone
-- ---------------------------------------------------------------------------
select is(private.user_tz('00000000-0000-0000-0000-000000000001'), 'America/Chicago', 'a known zone in the prefs is the zone');
select is(private.user_tz('00000000-0000-0000-0000-000000000002'), 'America/New_York', 'a zone the server does not know falls back to New York');
select is(private.user_tz('00000000-0000-0000-0000-000000000003'), 'America/New_York', 'and so does a posix/ copy');
select is(private.user_tz('00000000-0000-0000-0000-000000000005'), 'Europe/Paris', 'without prefs, the latest drive''s zone');
select is(private.user_tz('00000000-0000-0000-0000-000000000004'), 'America/New_York', 'with neither, New York');
select is((select p.prosrc !~ '(pg_timezone_names|is_known_tz)' from pg_proc p where p.oid = 'private.user_tz(uuid)'::regprocedure), true,
  'user_tz never scans the zone list');
select is(array[private.is_known_tz('America/Chicago'), private.is_known_tz('Mars/Olympus'), private.is_known_tz('posix/America/Chicago')],
  array[true, false, false], 'the write-path check is unchanged');

-- ---------------------------------------------------------------------------
-- not set up: no friend RPCs, not listed
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(4);
select throws_ok($$ select public.send_friend_request('00000000-0000-0000-0000-000000000001') $$, '42501', 'finish setting up your account first',
  'an account that never finished setting up cannot send a request');
select throws_ok($$ select public.search_users('ann') $$, '42501', 'finish setting up your account first', 'nor search');
select throws_ok($$ select public.respond_friend_request('00000000-0000-0000-0000-000000000001', true) $$, '42501', 'finish setting up your account first',
  'nor answer a request');
reset role;
insert into public.friend_requests (from_id, to_id) values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001');
set local role authenticated;
select pg_temp.as_user(1);
select is(jsonb_array_length(public.list_friends() -> 'incoming'), 0, 'a request from an account that never finished setting up is not listed');

-- ---------------------------------------------------------------------------
-- refusals after the take stand
-- ---------------------------------------------------------------------------
select is(public.get_profile('nobody'), '{"code": "P0002", "details": null, "hint": null, "message": "profile not found"}'::jsonb,
  'an unknown username is answered with PostgREST''s not-found body');
select is(current_setting('response.status', true), '404', 'and an HTTP 404');
reset role;
select is(pg_temp.taken(1, 'get_profile'), 1, 'the miss counts against the 60 a minute');
set local role authenticated;
select is((select count(*)::int from generate_series(1, 59) g, lateral (select public.get_profile('nobody' || g) as p) x), 59, '59 more misses');
select throws_ok($$ select public.get_profile('bob') $$, '42501', 'too many requests', 'the 61st lookup in a minute is refused, misses included');
select is(public.send_friend_request('00000000-0000-0000-0000-00000000dead'),
  '{"code": "P0002", "details": null, "hint": null, "message": "profile not found"}'::jsonb, 'a request to nobody is answered not found');
reset role;
select is(pg_temp.taken(1, 'send_friend_request'), 1, 'and it costs a request');

-- ---------------------------------------------------------------------------
-- a friend-request push only while the request stands
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
select public.send_friend_request('00000000-0000-0000-0000-000000000002');
select public.send_friend_request('00000000-0000-0000-0000-000000000003');
select public.send_friend_request('00000000-0000-0000-0000-000000000006');
select public.cancel_friend_request('00000000-0000-0000-0000-000000000002');
select pg_temp.as_user(6);
select public.block_user('00000000-0000-0000-0000-000000000001');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table batch as select public.claim_push_batch(100, 60) as b;
select is((select array_agg(x ->> 'user_id' order by x ->> 'user_id') from batch, jsonb_array_elements(b) x where x ->> 'kind' = 'friend_request'),
  array['00000000-0000-0000-0000-000000000003'], 'only the standing request is pushed');
reset role;
select is((select array_agg(row(i.user_id, i.push_state, i.push_reason)::text order by i.user_id) from public.inbox i
    where i.kind = 'friend_request' and i.user_id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000006')),
  array[row('00000000-0000-0000-0000-000000000002'::uuid, 'skipped', 'request_gone')::text, row('00000000-0000-0000-0000-000000000006'::uuid, 'skipped', 'request_gone')::text],
  'a cancelled request and one ended by a block are skipped, their rows kept');

select * from finish();
rollback;
