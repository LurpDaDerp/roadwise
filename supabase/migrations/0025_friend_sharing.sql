-- 0025_friend_sharing: each driver chooses what friends see (Settings › Privacy), and the server
-- enforces it: no RPC hands a friend anything the driver has not shared.
--
--   * The Safety Rating is shared with friends by default (`share_rating`); the category scores,
--     the achievements and the driving stats (with the 90-day distance) are not until the driver
--     turns each on (`share_categories`, `share_achievements`, `share_stats`). The heat map keeps
--     its own setting (`heatmap_visibility`: only_me or friends).
--   * A driver always sees all of their own. Anyone who is not a friend (a search result, a friend
--     request either way) never sees a rating.
--   * The friends board lists the driver and the friends who share their Safety Rating; a friend's
--     row shows 90-day distance only when that friend shares driving stats.
--   * get_profile hands a friend the achievements only when shared, the category scores (whole
--     numbers, the last 90 days) only when shared, and can_view_stats only when stats are shared;
--     get_member_stats refuses a friend who does not share them.

alter table public.profiles
  add column share_rating boolean not null default true,
  add column share_categories boolean not null default false,
  add column share_achievements boolean not null default false,
  add column share_stats boolean not null default false;
-- the owner reads their own settings (profiles_select_own); writes go through update_profile
grant select (share_rating, share_categories, share_achievements, share_stats) on public.profiles to authenticated;

-- update_profile: each argument null = unchanged
drop function if exists public.update_profile(text, text, text);
create or replace function public.update_profile(p_units text default null, p_state text default null, p_heatmap_visibility text default null,
  p_share_rating boolean default null, p_share_categories boolean default null, p_share_achievements boolean default null,
  p_share_stats boolean default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'update_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_units is not null and p_units not in ('mi', 'km') then
    raise exception 'units must be mi or km' using errcode = 'invalid_parameter_value';
  end if;
  if p_state is not null and p_state <> '' and p_state !~ '^[A-Z]{2}$' then
    raise exception 'state must be a two-letter US state code' using errcode = 'invalid_parameter_value';
  end if;
  if p_heatmap_visibility is not null and p_heatmap_visibility not in ('only_me', 'friends') then
    raise exception 'heatmap_visibility must be only_me or friends' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set
    units = coalesce(p_units, units),
    state = case when p_state is null then state when p_state = '' then null else p_state end,
    heatmap_visibility = coalesce(p_heatmap_visibility, heatmap_visibility),
    share_rating = coalesce(p_share_rating, share_rating),
    share_categories = coalesce(p_share_categories, share_categories),
    share_achievements = coalesce(p_share_achievements, share_achievements),
    share_stats = coalesce(p_share_stats, share_stats)
  where id = v_uid;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
end $$;

-- whether p_viewer may see what p_user shares under one flag: the driver themself always, a friend
-- only when the flag is on, nobody else ever
create or replace function private.shares_with(p_user uuid, p_viewer uuid, p_flag boolean) returns boolean
language sql stable set search_path = public as $$
  select p_user is not null and p_viewer is not null
    and (p_user = p_viewer or (coalesce(p_flag, false) and private.are_friends(p_viewer, p_user)))
$$;

-- the public card of one driver as p_viewer sees it (the caller has already been checked): the
-- rating only for the driver themself or a friend it is shared with
create or replace function private.public_card(p_user uuid, p_viewer uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('user_id', p.id, 'username', p.username,
      'safety_rating', case when s.ok then g.safety_rating end,
      'ranked', s.ok and g.ranked)
    -- LEGACY (Phase B removes): what a build from before 0023 reads
    || jsonb_build_object('level', 1, 'streak', 0, 'league_tier', 'bronze')
  from public.profiles p join public.progress g on g.user_id = p.id
    cross join lateral (select private.shares_with(p.id, p_viewer, p.share_rating) as ok) s
  where p.id = p_user
$$;

-- search_users(p_query >= 3 chars) -> up to 20 cards, prefix match, onboarded users only, never self
-- or anyone blocked either way; 30/min. A result that is not a friend shows no rating.
create or replace function public.search_users(p_query text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_q text := lower(btrim(coalesce(p_query, '')));
begin
  if v_uid is null then
    raise exception 'search_users requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if char_length(v_q) < 3 or char_length(v_q) > 20 or v_q !~ '^[a-z0-9_]+$' then
    raise exception 'query must be 3 to 20 letters, digits or underscores' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'search_users', interval '1 minute', 30);
  return coalesce((
    select jsonb_agg(private.public_card(p.id, v_uid) order by p.username)
    from (
      select p.id, p.username from public.profiles p
      where p.username::text like replace(v_q, '_', '\_') || '%' and p.id <> v_uid and p.onboarded_at is not null
        and not private.blocked_either(v_uid, p.id)
      order by p.username
      limit 20
    ) p), '[]'::jsonb);
end $$;

-- get_profile(p_username): the public profile, or "not found" (also when blocked either way). What a
-- friend sees follows the driver's sharing settings; anyone else sees the name and nothing more.
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_rel text;
  v_friend boolean;
  v_self boolean;
  pr public.profiles%rowtype;
  s jsonb;
  v_scores jsonb := null;
begin
  if v_uid is null then
    raise exception 'get_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_username is null or char_length(p_username) > 20 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'get_profile', interval '1 minute', 60);
  select * into pr from public.profiles p
    where p.username operator(extensions.=) p_username::extensions.citext and p.onboarded_at is not null;
  v_other := pr.id;
  if v_other is null or private.blocked_either(v_uid, v_other) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  v_self := v_other = v_uid;
  v_friend := not v_self and private.are_friends(v_uid, v_other);
  v_rel := case
    when v_self then 'self'
    when v_friend then 'friend'
    when exists (select 1 from public.friend_requests r where r.from_id = v_other and r.to_id = v_uid) then 'incoming'
    when exists (select 1 from public.friend_requests r where r.from_id = v_uid and r.to_id = v_other) then 'outgoing'
    else 'none' end;
  -- the category scores, whole numbers (half up), each null where it has no score. The rating is
  -- computed once, into a variable: an inline subquery would be copied into each of the ten reads.
  if v_self or (v_friend and pr.share_categories) then
    s := private.rating_at(v_other, now()) -> 'scores';
    v_scores := jsonb_build_object(
      'acceleration', case when s ->> 'acceleration' is null then null else private.round_half_up((s ->> 'acceleration')::float8, 0)::int end,
      'braking', case when s ->> 'braking' is null then null else private.round_half_up((s ->> 'braking')::float8, 0)::int end,
      'turning', case when s ->> 'turning' is null then null else private.round_half_up((s ->> 'turning')::float8, 0)::int end,
      'attention', case when s ->> 'attention' is null then null else private.round_half_up((s ->> 'attention')::float8, 0)::int end,
      'speed', case when s ->> 'speed' is null then null else private.round_half_up((s ->> 'speed')::float8, 0)::int end);
  end if;
  return private.public_card(v_other, v_uid) || jsonb_build_object(
    'achievements', case when v_self or (v_friend and pr.share_achievements)
      then coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_other), '[]'::jsonb)
      else '[]'::jsonb end,
    'scores', v_scores,
    -- LEGACY (Phase B removes): clans are server-only; an older build reads the key
    'clan', null,
    'relationship', v_rel,
    'can_view_stats', v_self or (v_friend and pr.share_stats),
    'can_view_heatmap', v_self or (v_friend and pr.heatmap_visibility = 'friends'));
end $$;

-- get_member_stats(p_user_id) -> StatSums for the last 30 days: self, and friends who share their
-- driving stats; anyone else is "not found"
create or replace function public.get_member_stats(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'get_member_stats requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id <> v_uid and (private.blocked_either(v_uid, p_user_id)
     or not private.shares_with(p_user_id, v_uid, (select p.share_stats from public.profiles p where p.id = p_user_id))) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  return private.stat_sums(p_user_id, now() - interval '30 days');
end $$;

-- list_friends() -> { friends[], incoming[], outgoing[] } of public cards as the caller sees them
-- (blocked omitted; a request either way is not a friend, so it shows no rating)
create or replace function public.list_friends() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_friends requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'friends', coalesce((select jsonb_agg(private.public_card(x.other, v_uid) order by x.created_at desc)
      from (select case when f.user_a = v_uid then f.user_b else f.user_a end as other, f.created_at from public.friendships f
            where f.user_a = v_uid or f.user_b = v_uid) x
      where not private.blocked_either(v_uid, x.other)), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(private.public_card(r.from_id, v_uid) order by r.created_at desc) from (
      select q.from_id, q.created_at from public.friend_requests q where q.to_id = v_uid and not private.blocked_either(v_uid, q.from_id)
      order by q.created_at desc limit 200) r), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(private.public_card(r.to_id, v_uid) order by r.created_at desc) from (
      select q.to_id, q.created_at from public.friend_requests q where q.from_id = v_uid and not private.blocked_either(v_uid, q.to_id)
      order by q.created_at desc limit 200) r), '[]'::jsonb));
end $$;

-- get_friends_board() -> [{ rank, user_id, username, value, ranked, is_me, miles_90d }]: the caller and
-- the friends who share their Safety Rating, by rating, unranked last. miles_90d is the caller's own,
-- or a friend's who shares driving stats; else null.
create or replace function public.get_friends_board() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'get_friends_board requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('rank', x.rank, 'user_id', x.user_id, 'username', x.username,
        'value', x.value, 'ranked', x.ranked, 'is_me', x.user_id = v_uid, 'miles_90d', x.miles_90d) order by x.rank)
    from (
      select (row_number() over (order by y.value desc nulls last, y.username))::int as rank, y.*
      from (
        select p.id as user_id, p.username, g.ranked,
          case when g.ranked then g.safety_rating else null end as value,
          case when u.id = v_uid or p.share_stats then g.miles_90d else null end as miles_90d
        from (select v_uid as id
              union
              select case when f.user_a = v_uid then f.user_b else f.user_a end from public.friendships f where f.user_a = v_uid or f.user_b = v_uid) u
        join public.profiles p on p.id = u.id join public.progress g on g.user_id = u.id
        where u.id = v_uid or (p.share_rating and not private.blocked_either(v_uid, u.id))
      ) y
    ) x), '[]'::jsonb);
end $$;

-- the Home header and the Profile card in one call (also assigns this week's goals when due); the
-- profile carries the four sharing settings
create or replace function public.get_my_summary() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  g public.progress%rowtype;
begin
  if v_uid is null then
    raise exception 'get_my_summary requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select * into g from public.progress where user_id = v_uid;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.weekly_challenges w where w.user_id = v_uid and w.league_week = v_week) then
    perform private.ensure_challenges(v_uid, v_week);
  end if;
  return jsonb_build_object(
    'profile', (select jsonb_build_object('user_id', p.id, 'username', p.username, 'units', p.units,
        'state', p.state, 'heatmap_visibility', p.heatmap_visibility, 'league_eligible', p.league_eligible,
        'onboarded_at', p.onboarded_at, 'share_rating', p.share_rating, 'share_categories', p.share_categories,
        'share_achievements', p.share_achievements, 'share_stats', p.share_stats) from public.profiles p where p.id = v_uid),
    'progress', jsonb_build_object('safety_rating', g.safety_rating, 'ranked', g.ranked, 'miles_90d', g.miles_90d,
        -- the trend: the stored rating less the rating 7 days before it, both written by refresh_rating
        'rating_trend', g.safety_rating - g.rating_week_ago)
      -- LEGACY (Phase B removes): what a build from before 0023 reads, at its starting values
      || jsonb_build_object('points', 0, 'lifetime', 0, 'level', 1, 'level_floor', 0, 'level_next', 250,
        'streak', 0, 'at_risk', false, 'next_mult', 1, 'freezes', 0, 'clean_run', 0, 'freeze_progress', 0,
        'phone_free_run', 0, 'clean_miles_30d', 0, 'league_tier', 'bronze', 'miles_30d', g.miles_90d),
    'not_driving_left', private.not_driving_left(v_uid),
    'challenges', private.challenges_json(v_uid, v_week),
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_uid), '[]'::jsonb));
end $$;

-- the one-argument card read everything regardless of who asked: gone
drop function if exists private.public_card(uuid);

revoke all on function private.shares_with(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function private.public_card(uuid, uuid) from public, anon, authenticated;
revoke all on function public.update_profile(text, text, text, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_profile(text, text, text, boolean, boolean, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';
