-- 0007_leagues: placement (30 a group, eligibility), the close (promotion needs 3 drives,
-- demotion bottom 5, tier bounds, idempotent, results pushed), the three boards.
create extension if not exists pgtap with schema extensions;

begin;
select plan(36);

-- 40 users: u01..u40, all onboarded and eligible
insert into auth.users (id, email) select ('b0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'u' || i || '@example.com' from generate_series(1, 40) i;
update public.profiles set username = 'user' || substr(id::text, 25, 12)::int, onboarded_at = now(), league_eligible = true where id::text like 'b0000000%';
create temporary table wk as select private.league_week(now()) as week;
grant select on wk to authenticated;
create function pg_temp.u(p int) returns uuid language sql immutable as $$ select ('b0000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid $$;
grant execute on function pg_temp.u(int) to authenticated;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"' || pg_temp.u(p) || '","role":"authenticated"}', true)
$$;
grant execute on function pg_temp.as_user(int) to authenticated;
-- a kept scored trip in a given week with given points
create function pg_temp.trip(p_user uuid, p_week_at timestamptz, p_net int, p_miles numeric default 5) returns void language sql as $$
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s, scored, points_net, clean)
    values (p_user, gen_random_uuid(), p_week_at, p_week_at + interval '20 minutes', (p_week_at at time zone 'America/New_York')::date, private.league_week(p_week_at),
      'America/New_York', p_miles, p_miles, 0, 1200, true, p_net, p_net > 0)
$$;

select is(private.week_key_end('2026-W41'), timestamptz '2026-10-12 04:00:00+00', 'a week key ends the next Monday 00:00 New York');
select is(private.week_key_end('2027-W01'), timestamptz '2027-01-11 05:00:00+00', 'ISO week 1 of 2027 (starting Jan 4) ends Jan 11 (EST)');

-- ---------------------------------------------------------------------------
-- placement in the current week
-- ---------------------------------------------------------------------------
select is((select count(*)::int from (select private.place_in_league(pg_temp.u(i), private.league_week(now())) from generate_series(1, 31) i) x), 31, '31 users placed');
select is((select array_agg(member_count order by created_at) from public.league_groups where week = private.league_week(now())), array[30, 1], 'a group fills to 30, the 31st opens a new one');
select is(private.place_in_league(pg_temp.u(1), private.league_week(now())), '{"tier": "bronze", "placed": true}'::jsonb, 'placing again is a no-op');
update public.profiles set league_eligible = false where id = pg_temp.u(40);
select is(private.place_in_league(pg_temp.u(40), private.league_week(now())), '{"tier": "bronze", "placed": false}'::jsonb, 'an ineligible user is not placed');
select is((select count(*)::int from public.league_members where week = private.league_week(now())), 31, 'still 31 members');
select is(private.place_in_league(pg_temp.u(32), private.league_week(now() - interval '7 days')), '{"tier": "bronze", "placed": false}'::jsonb, 'a late upload for a closed week scores but is not placed');
select is((select count(*)::int from public.league_groups where week = private.league_week(now() - interval '7 days')), 0, 'and opens no group');

-- ---------------------------------------------------------------------------
-- close: a silver group of 12 last week
-- ---------------------------------------------------------------------------
create temporary table lw as select private.league_week(now() - interval '7 days') as week, private.week_start(now() - interval '7 days') + interval '2 hours' as at;
grant select on lw to authenticated;
update public.progress set league_tier = 'silver' where user_id in (select pg_temp.u(i) from generate_series(1, 12) i);
insert into public.league_groups (id, week, tier, member_count) values ('c0000000-0000-4000-8000-000000000001', (select week from lw), 'silver', 12);
insert into public.league_members (week, user_id, group_id, tier, joined_at) select (select week from lw), pg_temp.u(i), 'c0000000-0000-4000-8000-000000000001', 'silver', now() - interval '7 days' + make_interval(mins => i) from generate_series(1, 12) i;
-- u1: 300 points over 3 drives; u2: 290 in 2 drives (not enough drives); u3..u7: 200 - 10 i in 3 drives; u8..u12: 50 - i in 1 drive
select pg_temp.trip(pg_temp.u(1), (select at from lw), 100), pg_temp.trip(pg_temp.u(1), (select at from lw) + interval '1 hour', 100), pg_temp.trip(pg_temp.u(1), (select at from lw) + interval '2 hours', 100);
select pg_temp.trip(pg_temp.u(2), (select at from lw), 145), pg_temp.trip(pg_temp.u(2), (select at from lw) + interval '1 hour', 145);
select pg_temp.trip(pg_temp.u(i), (select at from lw), 200 - 10 * i), pg_temp.trip(pg_temp.u(i), (select at from lw) + interval '1 hour', 0), pg_temp.trip(pg_temp.u(i), (select at from lw) + interval '2 hours', 0) from generate_series(3, 7) i;
select pg_temp.trip(pg_temp.u(i), (select at from lw), 50 - i) from generate_series(8, 12) i;
select is((select array_agg(s.user_id order by s.rank) from private.league_standings('c0000000-0000-4000-8000-000000000001') s), (select array_agg(pg_temp.u(i) order by i) from generate_series(1, 12) i),
  'standings rank by week points');
-- a diamond group of 1 and a bronze group of 6, same week, to pin the tier bounds
update public.progress set league_tier = 'diamond' where user_id = pg_temp.u(13);
insert into public.league_groups (id, week, tier, member_count) values ('c0000000-0000-4000-8000-000000000002', (select week from lw), 'diamond', 1);
insert into public.league_members (week, user_id, group_id, tier) values ((select week from lw), pg_temp.u(13), 'c0000000-0000-4000-8000-000000000002', 'diamond');
select pg_temp.trip(pg_temp.u(13), (select at from lw) + make_interval(mins => 10 * i), 10) from generate_series(1, 3) i;
insert into public.league_groups (id, week, tier, member_count) values ('c0000000-0000-4000-8000-000000000003', (select week from lw), 'bronze', 6);
insert into public.league_members (week, user_id, group_id, tier, joined_at) select (select week from lw), pg_temp.u(i), 'c0000000-0000-4000-8000-000000000003', 'bronze', now() - interval '7 days' + make_interval(mins => i) from generate_series(14, 19) i;

select is(private.close_leagues(), 3, 'three groups of the ended week close');
select is((select array_agg(result order by user_id) from public.league_members where group_id = 'c0000000-0000-4000-8000-000000000001'),
  array['promoted', 'stayed', 'promoted', 'promoted', 'promoted', 'promoted', 'promoted', 'demoted', 'demoted', 'demoted', 'demoted', 'demoted'],
  'top 7 promote except the one with 2 drives; the bottom 5 demote');
select is((select array_agg(final_rank order by user_id) from public.league_members where group_id = 'c0000000-0000-4000-8000-000000000001'), array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'final ranks stored');
select is((select array_agg(distinct league_tier) from public.progress where user_id in (select pg_temp.u(i) from generate_series(3, 7) i)), array['gold'], 'promoted silver players are gold');
select is((select league_tier from public.progress where user_id = pg_temp.u(2)), 'silver', 'the stayer stays silver');
select is((select array_agg(distinct league_tier) from public.progress where user_id in (select pg_temp.u(i) from generate_series(8, 12) i)), array['bronze'], 'demoted silver players are bronze');
select is((select row(result, league_tier)::text from public.league_members m join public.progress g on g.user_id = m.user_id where m.user_id = pg_temp.u(13) and m.week = (select week from lw)), row('stayed', 'diamond')::text, 'diamond cannot promote');
select is((select array_agg(result order by user_id) from public.league_members where group_id = 'c0000000-0000-4000-8000-000000000003'), array['stayed', 'stayed', 'stayed', 'stayed', 'stayed', 'stayed'],
  'bronze cannot demote; nobody with 0 drives promotes');
select is((select count(*)::int from public.inbox where kind = 'league_result' and dedupe_key = 'league_result:' || (select week from lw)), 19, 'every member gets one league_result row');
select is((select payload - 'week' from public.inbox where user_id = pg_temp.u(1) and kind = 'league_result'), '{"tier": "silver", "result": "promoted", "new_tier": "gold", "final_rank": 1, "week_points": 300}'::jsonb, 'with the facts');
select is(private.close_leagues(), 0, 'closing again does nothing');
select is((select count(*)::int from public.league_groups where closed_at is null), 2, 'the current week''s groups stay open');

-- ---------------------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------------------
select pg_temp.trip(pg_temp.u(1), now() - interval '1 hour', 80), pg_temp.trip(pg_temp.u(2), now() - interval '1 hour', 120);
insert into public.blocks (blocker_id, blocked_id) values (pg_temp.u(1), pg_temp.u(3));
insert into public.friendships (user_a, user_b) values (pg_temp.u(1), pg_temp.u(2)), (pg_temp.u(1), pg_temp.u(3));
-- global eligibility: u2 and u4 have 100+ miles in 30 days; u4 is in WA
update public.progress set miles_30d = 120, clean_miles_30d = 100, safety_rating = 95.0, ranked = true where user_id = pg_temp.u(2);
update public.progress set miles_30d = 150, clean_miles_30d = 80, safety_rating = 95.0, ranked = true where user_id = pg_temp.u(4);
update public.progress set miles_30d = 200, clean_miles_30d = 50, safety_rating = 90.0, ranked = true where user_id = pg_temp.u(5);
update public.progress set miles_30d = 99, clean_miles_30d = 99, safety_rating = 100.0, ranked = true where user_id = pg_temp.u(6);
update public.profiles set state = 'WA' where id in (pg_temp.u(4), pg_temp.u(5));
set local role authenticated;
select pg_temp.as_user(1);
create temporary table ml as select public.get_my_league() as l;
select is((select l - 'members' - 'group_id' - 'ends_at' from ml), jsonb_build_object('week', (select week from wk), 'tier', 'gold', 'eligible', true, 'placed', true, 'size', 30, 'promote', 7, 'demote', 5, 'min_drives_to_promote', 3,
    'last_result', jsonb_build_object('week', (select week from lw), 'result', 'promoted', 'final_rank', 1, 'tier', 'silver')), 'the league header and last result');
select is((select jsonb_array_length(l -> 'members') from ml), 29, 'the blocked member is omitted from the 30');
select is((select l -> 'members' -> 0 from ml), jsonb_build_object('rank', 1, 'user_id', pg_temp.u(2), 'username', 'user2', 'level', 1, 'week_points', 120, 'drives', 1, 'is_me', false), 'ranked by this week''s points');
select is((select l -> 'members' -> 1 ->> 'is_me' from ml), 'true', 'the caller is marked');
select is((select array_agg(x ->> 'username' order by (x ->> 'rank')::int) from jsonb_array_elements(public.get_friends_board('week')) x), array['user2', 'user1'], 'friends board: self and friends, the blocked friend omitted');
select is((select x -> 'value' from jsonb_array_elements(public.get_friends_board('rating')) x where x ->> 'username' = 'user2'), '95.0'::jsonb, 'the rating metric');
select is((select array_agg(coalesce(x ->> 'value', 'null') order by (x ->> 'rank')::int) from jsonb_array_elements(public.get_friends_board('rating')) x), array['95.0', 'null'], 'an unranked driver has no rating value and sorts last');
select throws_ok($$ select public.get_friends_board('points') $$, '22023', 'metric must be week or rating', 'an unknown metric is refused');
create temporary table gb as select public.get_global_board(null) as g;
select is((select array_agg(x ->> 'username' order by (x ->> 'rank')::int) from gb, jsonb_array_elements(g -> 'top') x), array['user2', 'user4', 'user5'], 'the global top: 100+ miles only, ties by clean miles');
select is((select g -> 'me' from gb), '{"rank": null, "eligible": false, "percentile": null, "safety_rating": null}'::jsonb, 'u1 has no rating yet');
select is((select array_agg(x ->> 'username' order by (x ->> 'rank')::int) from jsonb_array_elements(public.get_global_board('WA') -> 'top') x), array['user4', 'user5'], 'the state filter');
select pg_temp.as_user(5);
select is(public.get_global_board(null) -> 'me', '{"rank": 3, "eligible": true, "percentile": 100, "safety_rating": 90.0}'::jsonb, 'u5 is third of three: top 100%');
select is(public.get_global_board('WA') -> 'me' ->> 'percentile', '100', 'and second of two in WA');
select pg_temp.as_user(2);
select is(public.get_global_board(null) -> 'me', '{"rank": 1, "eligible": true, "percentile": 34, "safety_rating": 95.0}'::jsonb, 'u2 is first of three: top 34%');
reset role;

select * from finish();
rollback;
