-- 0025_friend_sharing: each sharing setting gates exactly its part of what a friend sees (the
-- category scores only with the Safety Rating shared too, since they average to it), the
-- defaults (rating on, the rest off), the driver always seeing all of their own, a non-friend never
-- seeing a rating (search, requests, profile), the board leaving out a friend who keeps their rating
-- to themselves, update_profile and the summary, grants and the catch-alls.
create extension if not exists pgtap with schema extensions;

begin;
select plan(45);

-- ava (1) views; fay (2) is her friend; sam (3) is a stranger; rex (4) asked ava to be friends
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'f@example.com'),
  ('00000000-0000-0000-0000-000000000003', 's@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'r@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'fay', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'sam', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'rex', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000004';
insert into public.friendships (user_a, user_b) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
insert into public.friend_requests (from_id, to_id) values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001');
-- everyone has 12 ranked miles, a polyline and a first-drive badge
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, polyline, clean,
    n_events, n_hard_brake, slowdowns, speedups, turns, limit_s, moving_s)
  select u, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', current_date, private.league_week(now() - interval '2 days'),
    'America/New_York', 12, 0, 1800, true, 'poly-' || u, false, 1, 1, 18, 17, 11, 1200, 1650
  from unnest(array['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004']::uuid[]) u;
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
  select t.id, gen_random_uuid(), t.user_id, 'hard_brake', 'minor', t.started_at + interval '5 minutes', 2 from public.trips t;
insert into public.user_achievements (user_id, achievement_id) select id, 'first_drive' from auth.users;
select private.refresh_rating(id) from auth.users;

create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000' || p || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
create function pg_temp.set(p_col text, p_val boolean) returns void language plpgsql as $$
begin
  execute format('update public.profiles set %I = %L where id = %L', p_col, p_val, '00000000-0000-0000-0000-000000000002');
end $$;

-- ---------------------------------------------------------------------------
-- the columns, the defaults, the grants
-- ---------------------------------------------------------------------------
select is((select array_agg(column_name::text || '=' || column_default order by column_name::text) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name like 'share_%'),
  array['share_achievements=false', 'share_categories=false', 'share_rating=true', 'share_stats=false'], 'the Safety Rating is shared by default, the rest are not');
select is((select array_agg(c.column_name::text order by c.column_name::text) from information_schema.column_privileges c
    where c.grantee = 'authenticated' and c.table_schema = 'public' and c.table_name = 'profiles' and c.column_name like 'share_%' and c.privilege_type = 'SELECT'),
  array['share_achievements', 'share_categories', 'share_rating', 'share_stats'], 'the owner reads their own settings');
select is((select count(*)::int from information_schema.column_privileges c where c.grantee = 'authenticated' and c.table_schema = 'public' and c.table_name = 'profiles' and c.privilege_type <> 'SELECT'), 0,
  'and writes them only through update_profile');
select hasnt_function('public', 'update_profile', array['text', 'text', 'text'], 'the three-argument update_profile is gone');
select hasnt_function('private', 'public_card', array['uuid'], 'the card without a viewer is gone');
select is(array[has_function_privilege('authenticated', 'public.update_profile(text, text, text, boolean, boolean, boolean, boolean)', 'execute'),
    has_function_privilege('anon', 'public.update_profile(text, text, text, boolean, boolean, boolean, boolean)', 'execute')], array[true, false], 'update_profile: authenticated only');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0, 'no API role executes anything in private (shares_with, public_card)');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0, 'every definer function still pins search_path=public');

-- ---------------------------------------------------------------------------
-- with the defaults: a friend sees the rating and nothing else
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(1);
create temporary table fay0 as select public.get_profile('fay') as p;
select is((select array[p ->> 'relationship', (p -> 'safety_rating' is not null and p ->> 'safety_rating' is not null)::text, p ->> 'ranked'] from fay0), array['friend', 'true', 'true'],
  'a friend''s rating shows by default');
select is((select array[p -> 'achievements', p -> 'scores', p -> 'can_view_stats', p -> 'can_view_heatmap'] from fay0), array['[]'::jsonb, 'null'::jsonb, 'false'::jsonb, 'false'::jsonb],
  'but not her badges, category scores, stats or heat map');
select throws_ok($$ select public.get_member_stats('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'her stats are refused');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'her heat map too');
select is((select x -> 'miles_90d' from jsonb_array_elements(public.get_friends_board()) x where x ->> 'username' = 'fay'), 'null'::jsonb, 'the board shows her rating without her distance');
select is((select x -> 'miles_90d' from jsonb_array_elements(public.get_friends_board()) x where x ->> 'username' = 'ava'), '12.00'::jsonb, 'the driver always sees her own distance');
select isnt((select x -> 'safety_rating' from jsonb_array_elements(public.list_friends() -> 'friends') x where x ->> 'username' = 'fay'), 'null'::jsonb, 'the friends list shows her rating');

-- ---------------------------------------------------------------------------
-- each setting gates exactly its part
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.set('share_categories', true);
set local role authenticated;
select is((select array(select jsonb_object_keys(p -> 'scores') order by 1) from (select public.get_profile('fay') as p) x), array['acceleration', 'attention', 'braking', 'speed', 'turning'],
  'categories on: the five category scores show');
select is((select array[p -> 'scores' -> 'attention', to_jsonb((p -> 'scores' ->> 'braking')::numeric = round((p -> 'scores' ->> 'braking')::numeric))] from (select public.get_profile('fay') as p) x),
  array['null'::jsonb, 'true'::jsonb], 'as whole numbers, Attention null without DashPal');
select is((select array[p -> 'achievements', p -> 'can_view_stats'] from (select public.get_profile('fay') as p) x), array['[]'::jsonb, 'false'::jsonb], 'and still no badges or stats');
reset role;
select pg_temp.set('share_categories', false);
select pg_temp.set('share_achievements', true);
set local role authenticated;
select is((select array[p -> 'achievements', p -> 'scores', p -> 'can_view_stats'] from (select public.get_profile('fay') as p) x), array['["first_drive"]'::jsonb, 'null'::jsonb, 'false'::jsonb],
  'achievements on: her badges show, nothing else');
reset role;
select pg_temp.set('share_achievements', false);
select pg_temp.set('share_stats', true);
set local role authenticated;
select is((select array[p -> 'can_view_stats', p -> 'achievements', p -> 'scores'] from (select public.get_profile('fay') as p) x), array['true'::jsonb, '[]'::jsonb, 'null'::jsonb],
  'driving stats on: her stats open, nothing else');
select is(public.get_member_stats('00000000-0000-0000-0000-000000000002') ->> 'drives', '1', 'get_member_stats reads them');
select is((select x -> 'miles_90d' from jsonb_array_elements(public.get_friends_board()) x where x ->> 'username' = 'fay'), '12.00'::jsonb, 'and the board shows her 90-day distance');
select throws_ok($$ select public.get_heatmap('00000000-0000-0000-0000-000000000002') $$, 'P0002', 'profile not found', 'the heat map keeps its own setting');
reset role;
update public.profiles set heatmap_visibility = 'friends' where id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
select is(public.get_heatmap('00000000-0000-0000-0000-000000000002'), '[{"polyline": "poly-00000000-0000-0000-0000-000000000002"}]'::jsonb, 'heat map shared with friends: it shows');
select is(public.get_profile('fay') -> 'can_view_heatmap', 'true'::jsonb, 'and the profile says so');
reset role;
select pg_temp.set('share_rating', false);
set local role authenticated;
select is((select array[p -> 'safety_rating', p -> 'ranked'] from (select public.get_profile('fay') as p) x), array['null'::jsonb, 'false'::jsonb], 'Safety Rating off: her rating is gone from her profile');
select is((select array_agg(x ->> 'username' order by x ->> 'username') from jsonb_array_elements(public.get_friends_board()) x), array['ava'], 'and she leaves the board');
select is((select x -> 'safety_rating' from jsonb_array_elements(public.list_friends() -> 'friends') x where x ->> 'username' = 'fay'), 'null'::jsonb, 'and the friends list');
-- the rating is the weighted mean of the categories: with the rating kept back, the categories are too
reset role;
select pg_temp.set('share_categories', true);
set local role authenticated;
select is((select array[p -> 'scores', p -> 'safety_rating'] from (select public.get_profile('fay') as p) x), array['null'::jsonb, 'null'::jsonb],
  'Safety Rating off, Category scores on: her category scores stay hidden too (they would give the rating away)');
select pg_temp.as_user(2);
select is((select jsonb_typeof(p -> 'scores') from (select public.get_profile('fay') as p) x), 'object', 'while fay still sees her own');
select pg_temp.as_user(1);
reset role;
select pg_temp.set('share_categories', false);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- a non-friend never sees a rating; the driver always sees all of their own
-- ---------------------------------------------------------------------------
select is((select array[p -> 'safety_rating', p -> 'ranked', p -> 'achievements', p -> 'scores', p -> 'can_view_stats'] from (select public.get_profile('sam') as p) x),
  array['null'::jsonb, 'false'::jsonb, '[]'::jsonb, 'null'::jsonb, 'false'::jsonb], 'a stranger''s profile: no rating, badges, scores or stats, whatever they share');
reset role;
update public.profiles set share_categories = true, share_achievements = true, share_stats = true where id = '00000000-0000-0000-0000-000000000003';
set local role authenticated;
select is((select array[p -> 'safety_rating', p -> 'achievements', p -> 'scores', p -> 'can_view_stats'] from (select public.get_profile('sam') as p) x),
  array['null'::jsonb, '[]'::jsonb, 'null'::jsonb, 'false'::jsonb], 'even with every setting on, a stranger sees nothing');
select throws_ok($$ select public.get_member_stats('00000000-0000-0000-0000-000000000003') $$, 'P0002', 'profile not found', 'nor a stranger''s stats');
select is((select x -> 'safety_rating' from jsonb_array_elements(public.search_users('sam')) x), 'null'::jsonb, 'a search result shows no rating');
select is((select x -> 'safety_rating' from jsonb_array_elements(public.list_friends() -> 'incoming') x where x ->> 'username' = 'rex'), 'null'::jsonb, 'nor an incoming request');
select pg_temp.as_user(4);
select is((select x -> 'safety_rating' from jsonb_array_elements(public.list_friends() -> 'outgoing') x where x ->> 'username' = 'ava'), 'null'::jsonb, 'nor an outgoing one');
select pg_temp.as_user(2);
select is((select array[p -> 'safety_rating' is not null and p ->> 'safety_rating' is not null, (p -> 'scores') is not null and jsonb_typeof(p -> 'scores') = 'object', p -> 'can_view_stats' = 'true'::jsonb]
    from (select public.get_profile('fay') as p) x), array[true, true, true], 'fay, with everything off, still sees all of her own');
select is((select array_agg(x ->> 'username' order by x ->> 'username') from jsonb_array_elements(public.get_friends_board()) x), array['ava', 'fay'], 'and is on her own board (beside ava, who shares hers)');

-- ---------------------------------------------------------------------------
-- update_profile and the summary
-- ---------------------------------------------------------------------------
select pg_temp.as_user(1);
select is((select p - 'user_id' - 'onboarded_at' from (select public.get_my_summary() -> 'profile' as p) x),
  '{"username": "ava", "units": "mi", "state": null, "heatmap_visibility": "only_me", "league_eligible": false, "share_rating": true, "share_categories": false, "share_achievements": false, "share_stats": false}'::jsonb,
  'the summary carries the four settings');
select lives_ok($$ select public.update_profile(p_share_rating := false, p_share_stats := true) $$, 'ava turns her rating off and her stats on');
select is((select array[p ->> 'share_rating', p ->> 'share_categories', p ->> 'share_achievements', p ->> 'share_stats', p ->> 'units'] from (select public.get_my_summary() -> 'profile' as p) x),
  array['false', 'false', 'false', 'true', 'mi'], 'only those two change (null is unchanged)');
select lives_ok($$ select public.update_profile(p_units := 'km') $$, 'a units change leaves the settings alone');
select is((select array[p ->> 'share_rating', p ->> 'share_stats', p ->> 'units'] from (select public.get_my_summary() -> 'profile' as p) x), array['false', 'true', 'km'], 'as stored');
select throws_ok($$ select public.update_profile(p_heatmap_visibility := 'clan') $$, '22023', 'heatmap_visibility must be only_me or friends', 'the heat map is only me or friends');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.update_profile(p_share_rating := true) $$, '42501', 'update_profile requires an authenticated user', 'a JWT without sub is refused');
reset role;

select * from finish();
rollback;
