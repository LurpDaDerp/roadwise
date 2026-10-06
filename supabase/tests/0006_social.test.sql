-- 0006_social: search and profiles behind blocks, the friend flow and its cap, blocks, reports,
-- clans (names, codes, size, roles, hand-over, deletion), heat map visibility, member stats.
create extension if not exists pgtap with schema extensions;

begin;
select plan(87);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'cat', onboarded_at = now(), heatmap_visibility = 'friends' where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'dan', onboarded_at = now(), heatmap_visibility = 'clan' where id = '00000000-0000-0000-0000-000000000004';
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s, scored, points_net, polyline, clean)
  select u, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '20 minutes', current_date, private.league_week(now()), 'America/New_York', 5, 5, 0, 1200, true, 50, 'poly-' || u, true
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
select is(public.get_profile('ben') - 'user_id', '{"clan": null, "level": 1, "ranked": false, "streak": 0, "username": "ben", "league_tier": "bronze", "achievements": [], "relationship": "none", "safety_rating": null, "can_view_stats": false, "can_view_heatmap": false}'::jsonb,
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
select is(public.get_profile('ava') -> 'can_view_stats', 'true'::jsonb, 'friends may see stats');
select pg_temp.as_user(1);
select is(public.get_member_stats('00000000-0000-0000-0000-000000000003') ->> 'drives', '1', 'A reads her friend''s 30-day stats');
select is(public.get_heatmap('00000000-0000-0000-0000-000000000003'), '[{"polyline": "poly-00000000-0000-0000-0000-000000000003"}]'::jsonb, 'cat shares her heat map with friends');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000004') $$, 'P0002', 'profile not found', 'dan shares with his clan only');
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
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000001', 'other', '') $$, '22023', 'kind must be user or clan with a target id', 'self report refused');
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'rude', '') $$, '22023', 'unknown report reason', 'unknown reason refused');
select throws_ok($$ select public.report_target('clan', '00000000-0000-0000-0000-00000000dead', 'other', '') $$, 'P0002', 'clan not found', 'an unknown target is the usual refusal');
select is((select count(*)::int from generate_series(1, 10) i, lateral (select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'harassment', 'note ' || i)) r), 10, 'ten reports go through');
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'harassment', '') $$, '42501', 'too many requests', 'the eleventh in a day is refused');

-- ---------------------------------------------------------------------------
-- clans
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.create_clan('Sh1t Crew', 'navy') $$, '22023', 'name must be 3 to 24 characters', 'a profane clan name is refused');
select throws_ok($$ select public.create_clan('Night Owls', 'rainbow') $$, '22023', 'unknown banner', 'an unknown banner is refused');
create temporary table clan as select public.create_clan('Night Owls', 'navy') as c;
select matches((select c ->> 'invite_code' from clan), '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$', 'the invite code is 8 unambiguous characters');
select throws_ok($$ select public.create_clan('Other', 'gold') $$, '42501', 'you are already in a clan', 'one clan per user');
select pg_temp.as_user(2);
select throws_ok($$ select public.create_clan('night owls', 'gold') $$, '23505', 'clan name is taken', 'names are unique case-insensitively');
select throws_ok($$ select public.preview_clan('ZZZZZZZZ') $$, 'P0002', 'clan not found', 'an unknown code is not found');
select is(public.preview_clan(lower((select c ->> 'invite_code' from clan))) - 'id', '{"full": false, "name": "Night Owls", "banner": "navy", "member_count": 1}'::jsonb, 'the preview (case-insensitive code)');
select is(public.preview_clan((select c ->> 'invite_code' from clan)) ->> 'id', (select c ->> 'id' from clan), 'the preview names the clan id, so it can be reported');
select is(public.join_clan((select c ->> 'invite_code' from clan)) ->> 'name', 'Night Owls', 'ben joins');
select is(public.get_my_clan() -> 'clan' -> 'invite_code', 'null'::jsonb, 'a member does not see the invite code');
select is(public.get_my_clan() -> 'goal', jsonb_build_object('week', (select week from wk), 'clean_miles', 0, 'target_clean_miles', 50), 'the weekly goal: max(50, 25 x members)');
select throws_ok($$ select public.set_member_role('00000000-0000-0000-0000-000000000001', 'member') $$, '42501', 'only the leader can do that', 'a member cannot set roles');
select throws_ok($$ select public.regenerate_clan_code() $$, '42501', 'only the leader or a co-leader can do that', 'nor regenerate the code');
select pg_temp.as_user(4);
select public.join_clan((select c ->> 'invite_code' from clan));
select pg_temp.as_user(1);
select lives_ok($$ select public.set_member_role('00000000-0000-0000-0000-000000000002', 'coleader') $$, 'the leader makes ben co-leader');
select is((select array_agg(x ->> 'username' order by x ->> 'username') from jsonb_array_elements(public.get_my_clan() -> 'members') x), array['ava', 'ben', 'dan'], 'three members');
select is(public.get_my_clan() -> 'goal' ->> 'target_clean_miles', '80', '25 x 3 = 75 rounds to 80');
select is(public.get_my_clan() -> 'clan' ->> 'invite_code', (select c ->> 'invite_code' from clan), 'the leader sees the code');
select throws_ok($$ select public.update_clan(p_name := 'A') $$, '22023', 'name must be 3 to 24 characters', 'a short name is refused');
select lives_ok($$ select public.update_clan(p_name := 'Day Owls', p_banner := 'gold') $$, 'the leader renames and re-banners');
select is((select row(c -> 'clan' ->> 'name', c -> 'clan' ->> 'banner')::text from public.get_my_clan() c), row('Day Owls', 'gold')::text, 'stored');
select pg_temp.as_user(2);
select isnt(public.regenerate_clan_code() ->> 'invite_code', (select c ->> 'invite_code' from clan), 'a co-leader regenerates the code');
select throws_ok($$ select public.remove_member('00000000-0000-0000-0000-000000000001') $$, '42501', 'only the leader or a co-leader can do that', 'a co-leader cannot remove the leader');
select throws_ok($$ select public.update_clan(p_banner := 'navy') $$, '42501', 'only the leader can do that', 'nor change the clan');
select lives_ok($$ select public.remove_member('00000000-0000-0000-0000-000000000004') $$, 'but removes a member');
select pg_temp.as_user(4);
select is(public.get_my_clan(), null, 'dan is out');
select throws_ok($$ select public.join_clan('ZZZZZZZZ') $$, 'P0002', 'clan not found', 'and cannot rejoin by a wrong code');
select pg_temp.as_user(1);
select lives_ok($$ select public.transfer_leadership('00000000-0000-0000-0000-000000000002') $$, 'ava hands leadership to ben');
reset role;
select is((select array_agg(role order by role) from public.clan_members), array['coleader', 'leader'], 'ava is co-leader, ben leader');
set local role authenticated;
select pg_temp.as_user(2);
select lives_ok($$ select public.leave_clan() $$, 'the leader leaves');
reset role;
select is((select role from public.clan_members where user_id = '00000000-0000-0000-0000-000000000001'), 'leader', 'the longest-serving co-leader is promoted');
set local role authenticated;
select pg_temp.as_user(2);
select throws_ok($$ select public.leave_clan() $$, 'P0002', 'you are not in a clan', 'leaving twice is an error');

-- a full clan: 29 more members then the 31st is refused; a blocked member keeps you out
reset role;
insert into public.clan_members (clan_id, user_id, role) select (select id from public.clans), u.id, 'member' from auth.users u where u.email like 'f%@example.com' limit 28;
insert into public.blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004');
create temporary table code as select invite_code from public.clans;
grant select on code to authenticated;
set local role authenticated;
select pg_temp.as_user(2);
select lives_ok($$ select public.join_clan((select invite_code from code)) $$, 'the 30th member joins');
select pg_temp.as_user(3);
select throws_ok($$ select public.join_clan((select invite_code from code)) $$, '42501', 'this clan is full', 'the 31st is refused');
reset role;
delete from public.clan_members where user_id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.as_user(4);
select throws_ok($$ select public.join_clan((select invite_code from code)) $$, '42501', 'you cannot join this clan', 'a user blocked by a member cannot join');
select pg_temp.as_user(1);
select is((select count(*)::int from jsonb_array_elements(public.get_my_clan() -> 'members')), 29, 'the leader sees 29 members (none blocked among them)');
reset role;

-- leader hand-over on account delete, then the empty clan goes
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.clan_members where role = 'leader'), 1, 'deleting the leader''s account promotes exactly one member');
select is((select user_id from public.clan_members where role = 'leader'), (select user_id from public.clan_members order by joined_at, user_id limit 1), 'the longest-serving one');
delete from public.clan_members;
select is((select count(*)::int from public.clans), 0, 'an emptied clan is deleted');
insert into public.clans (id, name, banner, invite_code) values ('e0000000-0000-4000-8000-000000000001', 'Solo', 'navy', 'ABCDEFGH');
set constraints clan_leader_required immediate;
select throws_ok($$ insert into public.clan_members (clan_id, user_id, role) values ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'member') $$,
  '23514', 'a clan needs a leader', 'a clan cannot be left without a leader (deferred constraint, forced immediate here)');

select * from finish();
rollback;
