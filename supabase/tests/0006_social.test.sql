-- 0006_social: search and profiles behind blocks, the friend flow and its cap, blocks, reports
-- (a user only, 0032), heat map visibility, member stats.
create extension if not exists pgtap with schema extensions;

begin;
select plan(48);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'cat', onboarded_at = now(), heatmap_visibility = 'friends' where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'dan', onboarded_at = now(), heatmap_visibility = 'only_me' where id = '00000000-0000-0000-0000-000000000004';
-- ava and cat share their driving stats with friends (0025: off until turned on)
update public.profiles set share_stats = true where id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, polyline, clean,
    slowdowns, speedups, turns, limit_s, moving_s)
  select u, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '20 minutes', current_date, private.league_week(now()), 'America/New_York', 5, 0, 1200, true, 'poly-' || u, true,
    5, 5, 3, 600, 1000
  from unnest(array['00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004']::uuid[]) u;

create temporary table wk as select private.league_week(now()) as week;
grant select on wk to authenticated;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- search and profiles
-- ---------------------------------------------------------------------------
select pg_temp.as_user(1);
select throws_ok($$ select public.search_users('av') $$, '22023', 'query must be 3 to 20 letters, digits or underscores', 'a 2-character query is refused');
select is((select array_agg(x ->> 'username') from jsonb_array_elements(public.search_users('ben')) x), array['ben'], 'A finds ben');
select is((select x -> 'safety_rating' from jsonb_array_elements(public.search_users('ben')) x), 'null'::jsonb, 'an unranked driver shows no rating in search');
select is((select array_agg(x ->> 'username') from jsonb_array_elements(public.search_users('ava')) x), null, 'never herself');
select is(public.get_profile('ben') - 'user_id', '{"clan": null, "level": 1, "ranked": false, "scores": null, "streak": 0, "username": "ben", "league_tier": "bronze", "achievements": [], "relationship": "none", "safety_rating": null, "can_view_stats": false, "can_view_heatmap": false}'::jsonb,
  'a stranger''s public card: no stats, no heat map');
select is(public.get_profile('ava') ->> 'relationship', 'self', 'own profile is self');
select throws_ok($$ select public.get_profile('nobody') $$, 'P0002', 'profile not found', 'an unknown username is not found');
select throws_ok($$ select public.get_member_stats('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'a stranger''s stats are not found');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000003') $$, 'P0002', 'profile not found', 'a stranger''s heat map is not found');

-- ---------------------------------------------------------------------------
-- friends
-- ---------------------------------------------------------------------------
select is(public.send_friend_request('00000000-0000-0000-0000-000000000003'), '{"status": "requested"}'::jsonb, 'A asks cat');
select throws_ok($$ select public.send_friend_request('00000000-0000-0000-0000-000000000001') $$, '22023', 'user_id must be another user', 'not herself');
select is(public.get_profile('cat') ->> 'relationship', 'outgoing', 'A sees an outgoing request');
select pg_temp.as_user(3);
select is(public.get_profile('ava') ->> 'relationship', 'incoming', 'cat sees it incoming');
select is((select array_agg(x ->> 'username') from jsonb_array_elements(public.list_friends() -> 'incoming') x), array['ava'], 'and in her list');
select is(public.send_friend_request('00000000-0000-0000-0000-000000000001'), '{"status": "friends"}'::jsonb, 'the reverse request auto-accepts');
select is(public.get_profile('ava') ->> 'relationship', 'friend', 'now friends');
select is((select count(*)::int from jsonb_array_elements(public.list_friends() -> 'incoming')), 0, 'the request is gone');
select is(public.get_profile('ava') -> 'can_view_stats', 'true'::jsonb, 'a friend may see the stats ava shares');
select pg_temp.as_user(1);
select is(public.get_member_stats('00000000-0000-0000-0000-000000000003') ->> 'drives', '1', 'A reads her friend''s 30-day stats');
select is(public.get_heatmap('00000000-0000-0000-0000-000000000003'), '[{"polyline": "poly-00000000-0000-0000-0000-000000000003"}]'::jsonb, 'cat shares her heat map with friends');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000004') $$, 'P0002', 'profile not found', 'dan keeps his heat map to himself');
select is(public.send_friend_request('00000000-0000-0000-0000-000000000002'), '{"status": "requested"}'::jsonb, 'A asks ben');
select pg_temp.as_user(2);
select lives_ok($$ select public.respond_friend_request('00000000-0000-0000-0000-000000000001', false) $$, 'ben declines');
select throws_ok($$ select public.respond_friend_request('00000000-0000-0000-0000-000000000001', true) $$, 'P0002', 'no such request', 'a declined request is gone');
select pg_temp.as_user(1);
select is(public.get_profile('ben') ->> 'relationship', 'none', 'back to none');
select lives_ok($$ select public.remove_friend('00000000-0000-0000-0000-000000000003') $$, 'A removes cat');
select throws_ok($$ select public.remove_friend('00000000-0000-0000-0000-000000000003') $$, 'P0002', 'not friends', 'twice is an error, not a no-op');
select is(public.send_friend_request('00000000-0000-0000-0000-000000000003'), '{"status": "requested"}'::jsonb, 'A asks cat again');
select lives_ok($$ select public.cancel_friend_request('00000000-0000-0000-0000-000000000003') $$, 'and cancels');
select is((select count(*)::int from jsonb_array_elements(public.list_friends() -> 'outgoing')), 0, 'no outgoing request left');

-- the 200-friend cap
reset role;
insert into auth.users (id, email) select ('a0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'f' || i || '@example.com' from generate_series(1, 200) i;
insert into public.friendships (user_a, user_b) select least(u.id, '00000000-0000-0000-0000-000000000004'::uuid), greatest(u.id, '00000000-0000-0000-0000-000000000004'::uuid)
  from auth.users u where u.email like 'f%@example.com';
set local role authenticated;
select pg_temp.as_user(4);
select throws_ok($$ select public.send_friend_request('00000000-0000-0000-0000-000000000001') $$, '42501', 'you have reached the friend limit', 'dan at 200 friends cannot ask');
select pg_temp.as_user(1);
select public.send_friend_request('00000000-0000-0000-0000-000000000004');
select pg_temp.as_user(4);
select throws_ok($$ select public.respond_friend_request('00000000-0000-0000-0000-000000000001', true) $$, '42501', 'you have reached the friend limit', 'nor accept a 201st friend');
select pg_temp.as_user(1);

-- ---------------------------------------------------------------------------
-- blocks: friendship and requests go, both sides vanish
-- ---------------------------------------------------------------------------
select public.send_friend_request('00000000-0000-0000-0000-000000000003');
select pg_temp.as_user(3);
select public.respond_friend_request('00000000-0000-0000-0000-000000000001', true);
select pg_temp.as_user(1);
select throws_ok($$ select public.block_user('00000000-0000-0000-0000-00000000dead') $$, 'P0002', 'profile not found', 'blocking an unknown id is the usual refusal, not an FK error');
select lives_ok($$ select public.block_user('00000000-0000-0000-0000-000000000003') $$, 'A blocks cat');
select throws_ok($$ select public.get_profile('cat') $$, 'P0002', 'profile not found', 'a blocked user is not found');
select is((select array_agg(x ->> 'username') from jsonb_array_elements(public.search_users('cat')) x), null, 'nor searchable');
select is(public.list_blocked(), jsonb_build_array(jsonb_build_object('user_id', '00000000-0000-0000-0000-000000000003', 'username', 'cat')), 'the blocked list');
select pg_temp.as_user(3);
select throws_ok($$ select public.get_profile('ava') $$, 'P0002', 'profile not found', 'the blocker is not found either');
select throws_ok($$ select public.send_friend_request('00000000-0000-0000-0000-000000000001') $$, 'P0002', 'profile not found', 'and cannot be asked');
select is((select count(*)::int from jsonb_array_elements(public.list_friends() -> 'friends')), 0, 'the friendship is gone');
select pg_temp.as_user(1);
select lives_ok($$ select public.unblock_user('00000000-0000-0000-0000-000000000003') $$, 'A unblocks');
select throws_ok($$ select public.unblock_user('00000000-0000-0000-0000-000000000003') $$, 'P0002', 'not blocked', 'twice is an error');
select is(public.get_profile('cat') ->> 'relationship', 'none', 'cat is visible again, not a friend');

-- reports: 10 a day, never self
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000001', 'other', '') $$, '22023', 'kind must be user with a target id', 'self report refused');
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'rude', '') $$, '22023', 'unknown report reason', 'unknown reason refused');
select throws_ok($$ select public.report_target('clan', '00000000-0000-0000-0000-00000000dead', 'other', '') $$, '22023', 'kind must be user with a target id', 'a report names a user only (0032: clans are gone)');
select is((select count(*)::int from generate_series(1, 10) i, lateral (select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'harassment', 'note ' || i)) r), 10, 'ten reports go through');
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'harassment', '') $$, '42501', 'too many requests', 'the eleventh in a day is refused');

select * from finish();
rollback;
