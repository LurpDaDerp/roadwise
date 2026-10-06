-- 0007_leagues: weekly league groups (30 players of one tier), placement on the first scored
-- drive of the week, the Monday close (promotion top 7 with >= 3 drives, demotion bottom 5), and
-- the three boards (league, friends & clan, global).
--
-- Week points are derived from trips (private.week_points, 0003), never stored per member.

create table public.league_groups (
  id uuid primary key default gen_random_uuid(),
  week text not null check (week ~ '^[0-9]{4}-W[0-5][0-9]$'),
  tier text not null check (tier in ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  member_count int not null default 0 check (member_count between 0 and 30),
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
-- the open-group lookup
create index league_groups_open_idx on public.league_groups (week, tier, created_at) where member_count < 30;
create index league_groups_week_idx on public.league_groups (week) where closed_at is null;

create table public.league_members (
  week text not null check (week ~ '^[0-9]{4}-W[0-5][0-9]$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.league_groups(id) on delete cascade,
  tier text not null check (tier in ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  joined_at timestamptz not null default now(),
  result text check (result in ('promoted', 'stayed', 'demoted')),
  final_rank int check (final_rank between 1 and 30),
  primary key (week, user_id)
);
create index league_members_group_idx on public.league_members (group_id);
create index league_members_user_idx on public.league_members (user_id, week desc);

-- the Monday 00:00 New York that ends a week key ('IYYY-Www'): Jan 4 is always in ISO week 1
create or replace function private.week_key_end(p_week text) returns timestamptz
language sql immutable set search_path = public as $$
  select ((make_date(substr(p_week, 1, 4)::int, 1, 4)
           - (extract(isodow from make_date(substr(p_week, 1, 4)::int, 1, 4))::int - 1)
           + 7 * (substr(p_week, 7, 2)::int - 1) + 7)::timestamp at time zone 'America/New_York')
$$;

-- ---------------------------------------------------------------------------
-- placement (called inside apply_drive for a league-eligible user's first scored drive of the week)
-- ---------------------------------------------------------------------------
create or replace function private.place_in_league(p_user uuid, p_week text) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_tier text;
  v_eligible boolean;
  v_group uuid;
begin
  select g.league_tier, p.league_eligible into v_tier, v_eligible
    from public.progress g join public.profiles p on p.id = g.user_id where g.user_id = p_user;
  if exists (select 1 from public.league_members m where m.week = p_week and m.user_id = p_user) then
    return jsonb_build_object('tier', v_tier, 'placed', true);
  end if;
  if not coalesce(v_eligible, false) then
    return jsonb_build_object('tier', v_tier, 'placed', false);
  end if;
  select g.id into v_group from public.league_groups g
    where g.week = p_week and g.tier = v_tier and g.member_count < 30 and g.closed_at is null
    order by g.created_at
    limit 1
    for update skip locked;
  if v_group is null then
    insert into public.league_groups (week, tier) values (p_week, v_tier) returning id into v_group;
  end if;
  insert into public.league_members (week, user_id, group_id, tier) values (p_week, p_user, v_group, v_tier);
  update public.league_groups set member_count = member_count + 1 where id = v_group;
  return jsonb_build_object('tier', v_tier, 'placed', true);
end $$;

-- the standings of one group: rank by week points, then drives, then joining order
create or replace function private.league_standings(p_group uuid) returns table (rank int, user_id uuid, week_points int, drives int)
language sql stable set search_path = public as $$
  select (row_number() over (order by x.week_points desc, x.drives desc, x.joined_at, x.user_id))::int, x.user_id, x.week_points, x.drives
  from (
    select m.user_id, m.joined_at, private.week_points(m.user_id, m.week) as week_points, private.week_drives(m.user_id, m.week) as drives
    from public.league_members m where m.group_id = p_group
  ) x
$$;

-- ---------------------------------------------------------------------------
-- close: every open group whose week has ended
-- ---------------------------------------------------------------------------
create or replace function private.close_leagues() returns int
language plpgsql volatile set search_path = public as $$
declare
  g record;
  s record;
  v_size int;
  v_result text;
  v_new_tier text;
  v_tiers text[] := array['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  v_idx int;
  v_n int := 0;
begin
  for g in
    select l.id, l.week, l.tier from public.league_groups l
    where l.closed_at is null and private.week_key_end(l.week) <= now()
    order by l.created_at
    for update skip locked
  loop
    select count(*) into v_size from public.league_members m where m.group_id = g.id;
    v_idx := array_position(v_tiers, g.tier);
    for s in select * from private.league_standings(g.id) loop
      if s.rank <= 7 and s.drives >= 3 and v_idx < 5 then
        v_result := 'promoted';
        v_new_tier := v_tiers[v_idx + 1];
      elsif s.rank > 7 and s.rank > v_size - 5 and v_idx > 1 then
        v_result := 'demoted';
        v_new_tier := v_tiers[v_idx - 1];
      else
        v_result := 'stayed';
        v_new_tier := g.tier;
      end if;
      update public.league_members set result = v_result, final_rank = least(s.rank, 30) where week = g.week and user_id = s.user_id;
      update public.progress set league_tier = v_new_tier where user_id = s.user_id;
      insert into public.inbox (user_id, kind, payload, dedupe_key)
        values (s.user_id, 'league_result',
          jsonb_build_object('week', g.week, 'result', v_result, 'final_rank', s.rank, 'tier', g.tier, 'new_tier', v_new_tier, 'week_points', s.week_points),
          'league_result:' || g.week)
        on conflict (user_id, dedupe_key) do nothing;
    end loop;
    update public.league_groups set closed_at = now() where id = g.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
-- Monday 00:05 New York is 04:05 UTC (EDT) or 05:05 UTC (EST); the close is idempotent and only
-- touches groups whose week has ended, so it runs at both and once more as a backstop
select cron.schedule('league-close', '5 4-6 * * 1', 'select private.close_leagues()');

-- ---------------------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------------------
-- get_my_league() -> { week, ends_at, tier, eligible, placed, group_id, members[], promote,
-- demote, min_drives_to_promote, last_result }
create or replace function public.get_my_league() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  v_group uuid;
  v_tier text;
  v_eligible boolean;
begin
  if v_uid is null then
    raise exception 'get_my_league requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select g.league_tier, p.league_eligible into v_tier, v_eligible
    from public.progress g join public.profiles p on p.id = g.user_id where g.user_id = v_uid;
  select m.group_id into v_group from public.league_members m where m.week = v_week and m.user_id = v_uid;
  return jsonb_build_object(
    'week', v_week,
    'ends_at', private.week_end(now()),
    'tier', v_tier,
    'eligible', coalesce(v_eligible, false),
    'placed', v_group is not null,
    'group_id', v_group,
    'members', case when v_group is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('rank', s.rank, 'user_id', s.user_id, 'username', p.username, 'level', g.level,
          'week_points', s.week_points, 'drives', s.drives, 'is_me', s.user_id = v_uid) order by s.rank)
      from private.league_standings(v_group) s
      join public.profiles p on p.id = s.user_id join public.progress g on g.user_id = s.user_id
      where not private.blocked_either(v_uid, s.user_id)), '[]'::jsonb) end,
    'size', coalesce((select l.member_count from public.league_groups l where l.id = v_group), 0),
    'promote', 7, 'demote', 5, 'min_drives_to_promote', 3,
    'last_result', (select jsonb_build_object('week', m.week, 'result', m.result, 'final_rank', m.final_rank, 'tier', m.tier)
                    from public.league_members m where m.user_id = v_uid and m.result is not null
                    order by m.week desc limit 1));
end $$;

-- get_friends_board(p_metric week|rating) -> [{ rank, user_id, username, level, value, ranked, is_me }]
-- for self + friends + clanmates (blocked omitted)
create or replace function public.get_friends_board(p_metric text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  v_clan uuid;
begin
  if v_uid is null then
    raise exception 'get_friends_board requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_metric is null or p_metric not in ('week', 'rating') then
    raise exception 'metric must be week or rating' using errcode = 'invalid_parameter_value';
  end if;
  v_clan := private.clan_of(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object('rank', x.rank, 'user_id', x.user_id, 'username', x.username, 'level', x.level,
        'value', x.value, 'ranked', x.ranked, 'is_me', x.user_id = v_uid) order by x.rank)
    from (
      select (row_number() over (order by y.value desc nulls last, y.username))::int as rank, y.*
      from (
        select p.id as user_id, p.username, g.level, g.ranked,
          case when p_metric = 'week' then private.week_points(p.id, v_week)::numeric else g.safety_rating end as value
        from (
          select v_uid as id
          union
          select case when f.user_a = v_uid then f.user_b else f.user_a end from public.friendships f where f.user_a = v_uid or f.user_b = v_uid
          union
          select m.user_id from public.clan_members m where v_clan is not null and m.clan_id = v_clan
        ) u
        join public.profiles p on p.id = u.id join public.progress g on g.user_id = u.id
        where u.id = v_uid or not private.blocked_either(v_uid, u.id)
      ) y
    ) x), '[]'::jsonb);
end $$;

-- get_global_board(p_state) -> { top[<= 100] { rank, user_id, username, safety_rating, clean_miles },
-- me { rank, percentile, eligible, safety_rating } }; eligible = >= 100 mi in 30 days
create or replace function public.get_global_board(p_state text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rating numeric;
  v_clean numeric;
  v_eligible boolean;
  v_my_state text;
  v_rank int;
  v_total int;
begin
  if v_uid is null then
    raise exception 'get_global_board requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_state is not null and p_state !~ '^[A-Z]{2}$' then
    raise exception 'state must be a two-letter US state code' using errcode = 'invalid_parameter_value';
  end if;
  select g.safety_rating, g.clean_miles_30d, g.miles_30d >= 100 and g.safety_rating is not null, p.state
    into v_rating, v_clean, v_eligible, v_my_state
    from public.progress g join public.profiles p on p.id = g.user_id where g.user_id = v_uid;
  if v_eligible and (p_state is null or p_state = v_my_state) then
    select count(*) + 1 into v_rank from public.progress g join public.profiles p on p.id = g.user_id
      where g.miles_30d >= 100 and g.safety_rating is not null and (p_state is null or p.state = p_state)
        and (g.safety_rating > v_rating or (g.safety_rating = v_rating and g.clean_miles_30d > v_clean));
    select count(*) into v_total from public.progress g join public.profiles p on p.id = g.user_id
      where g.miles_30d >= 100 and g.safety_rating is not null and (p_state is null or p.state = p_state);
  end if;
  return jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(jsonb_build_object('rank', x.rank, 'user_id', x.user_id, 'username', x.username,
          'safety_rating', x.safety_rating, 'clean_miles', x.clean_miles_30d) order by x.rank)
      from (
        select (row_number() over (order by g.safety_rating desc, g.clean_miles_30d desc, g.user_id))::int as rank,
          g.user_id, p.username, g.safety_rating, g.clean_miles_30d
        from public.progress g join public.profiles p on p.id = g.user_id
        where g.miles_30d >= 100 and g.safety_rating is not null and p.username is not null
          and (p_state is null or p.state = p_state)
        order by g.safety_rating desc, g.clean_miles_30d desc, g.user_id
        limit 100
      ) x
      where x.user_id = v_uid or not private.blocked_either(v_uid, x.user_id)), '[]'::jsonb),
    'me', jsonb_build_object(
      'rank', v_rank,
      'percentile', case when v_rank is null or v_total is null or v_total = 0 then null else greatest(1, ceil(100.0 * v_rank / v_total))::int end,
      'eligible', coalesce(v_eligible, false),
      'safety_rating', v_rating));
end $$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.league_groups enable row level security;
alter table public.league_members enable row level security;
revoke all on public.league_groups, public.league_members from anon, authenticated;

revoke all on function public.get_my_league() from public, anon, authenticated;
revoke all on function public.get_friends_board(text) from public, anon, authenticated;
revoke all on function public.get_global_board(text) from public, anon, authenticated;
grant execute on function public.get_my_league() to authenticated;
grant execute on function public.get_friends_board(text) to authenticated;
grant execute on function public.get_global_board(text) to authenticated;
