-- 0012_clan_privacy: heat-map visibility is only_me or friends, and sharing a clan shows nobody
-- anything: not the heat map, not the stats, not the friends board, not the clan's name. The
-- clan RPCs are server-only; the clan rows stay.
create extension if not exists pgtap with schema extensions;

begin;
select plan(31);

-- ava (1) and ben (2) share a clan and are not friends; cat (3) is ava's friend; dan (4) is in
-- the clan too, with his map shared with friends
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now(), heatmap_visibility = 'friends', share_stats = true where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'cat', onboarded_at = now(), heatmap_visibility = 'friends', share_stats = true where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'dan', onboarded_at = now(), heatmap_visibility = 'friends' where id = '00000000-0000-0000-0000-000000000004';
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, polyline, clean,
    slowdowns, speedups, turns, limit_s, moving_s)
  select u, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '20 minutes', current_date, private.league_week(now()), 'America/New_York', 5, 0, 1200, true, 'poly-' || u, true,
    5, 5, 3, 600, 1000
  from unnest(array['00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004']::uuid[]) u;
insert into public.clans (id, name, banner, invite_code) values ('e0000000-0000-4000-8000-000000000001', 'Owls', 'navy', 'ABCDEFGH');
insert into public.clan_members (clan_id, user_id, role) values
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'leader'),
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'member'),
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000004', 'member');
insert into public.friendships (user_a, user_b) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');

create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;

-- ---------------------------------------------------------------------------
-- the column: only_me | friends, a saved clan is gone
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles where heatmap_visibility not in ('only_me', 'friends')), 0, 'no profile keeps any other visibility');
select is((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.profiles'::regclass and c.conname = 'profiles_heatmap_visibility_check'),
  'CHECK ((heatmap_visibility = ANY (ARRAY[''only_me''::text, ''friends''::text])))', 'the check allows only_me and friends');
select throws_ok($$ update public.profiles set heatmap_visibility = 'clan' where id = '00000000-0000-0000-0000-000000000001' $$, '23514', null, 'clan cannot be stored');
select col_default_is('public', 'profiles', 'heatmap_visibility', 'only_me', 'only_me is still the default');

set local role authenticated;
select pg_temp.as_user(1);
select throws_ok($$ select public.update_profile(p_heatmap_visibility := 'clan') $$, '22023', 'heatmap_visibility must be only_me or friends', 'update_profile refuses clan');
select throws_ok($$ select public.update_profile(p_heatmap_visibility := 'everyone') $$, '22023', 'heatmap_visibility must be only_me or friends', 'and anything else');
select lives_ok($$ select public.update_profile(p_heatmap_visibility := 'friends') $$, 'friends is accepted');
select is(public.get_my_summary() -> 'profile' ->> 'heatmap_visibility', 'friends', 'and stored');
select lives_ok($$ select public.update_profile(p_heatmap_visibility := 'only_me') $$, 'only_me is accepted');
select is(public.get_my_summary() -> 'profile' ->> 'heatmap_visibility', 'only_me', 'and stored');

-- ---------------------------------------------------------------------------
-- a clanmate who is not a friend sees nothing private
-- ---------------------------------------------------------------------------
select is(public.get_profile('ben') -> 'clan', 'null'::jsonb, 'a profile never names the clan');
select is(public.get_profile('ava') -> 'clan', 'null'::jsonb, 'not even your own');
select is(public.get_profile('ben') -> 'can_view_stats', 'false'::jsonb, 'a clanmate''s stats are closed');
select is(public.get_profile('ben') -> 'can_view_heatmap', 'false'::jsonb, 'and their heat map, even shared with friends');
select throws_ok($$ select public.get_member_stats('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'get_member_stats refuses a clanmate');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'get_heatmap refuses a clanmate');
select is((select array_agg(x ->> 'username' order by x ->> 'username') from jsonb_array_elements(public.get_friends_board()) x), array['ava', 'cat'],
  'the friends board holds self and friends, no clanmates');
select hasnt_function('public', 'get_friends_board', array['text'], 'the board takes no metric (it ranks by Safety Rating)');
select pg_temp.as_user(4);
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'clanmates see each other''s map no more than strangers do');

-- ---------------------------------------------------------------------------
-- friends and self are unchanged
-- ---------------------------------------------------------------------------
select pg_temp.as_user(1);
select is(public.get_profile('cat') -> 'can_view_stats', 'true'::jsonb, 'a friend''s stats are open');
select is(public.get_profile('cat') -> 'can_view_heatmap', 'true'::jsonb, 'a friend who shares with friends shows the map');
select is(public.get_member_stats('00000000-0000-0000-0000-000000000003') ->> 'drives', '1', 'get_member_stats reads a friend');
select is(public.get_heatmap('00000000-0000-0000-0000-000000000003'), '[{"polyline": "poly-00000000-0000-0000-0000-000000000003"}]'::jsonb, 'get_heatmap reads a friend who shares');
select pg_temp.as_user(3);
select is(public.get_profile('ava') -> 'can_view_heatmap', 'false'::jsonb, 'a friend who keeps it to herself does not');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000001') $$, 'P0002', 'profile not found', 'only_me is only me');
select pg_temp.as_user(1);
select is(public.get_heatmap('00000000-0000-0000-0000-000000000001'), '[]'::jsonb, 'your own map is always yours');

-- ---------------------------------------------------------------------------
-- clan RPCs are server-only, leave_clan too since 0029; the rows stay
-- ---------------------------------------------------------------------------
reset role;
select is(
  (select array_agg(f order by f) from unnest(array['public.create_clan(text, text)', 'public.preview_clan(text)', 'public.join_clan(text)', 'public.get_my_clan()',
      'public.set_member_role(uuid, text)', 'public.transfer_leadership(uuid)', 'public.remove_member(uuid)', 'public.regenerate_clan_code()', 'public.update_clan(text, text)',
      'public.leave_clan()']) f
    where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  null, 'no client role may call a clan RPC');
set local role authenticated;
select pg_temp.as_user(2);
select throws_ok($$ select public.get_my_clan() $$, '42501', null, 'get_my_clan is refused to a member');
select throws_ok($$ select public.preview_clan('ABCDEFGH') $$, '42501', null, 'preview_clan is refused');
select throws_ok($$ select public.leave_clan() $$, '42501', null, 'leave_clan is refused too (0029)');
reset role;
select is((select array_agg(user_id order by user_id) from public.clan_members),
  array['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004']::uuid[], 'the clan keeps its rows');

select * from finish();
rollback;
