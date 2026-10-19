-- 0012_clan_privacy: clans are gone from the app, so being in a clan no longer shows anyone
-- anything. Heat-map visibility is only_me or friends; a saved 'clan' becomes only_me (it
-- fails closed: the app never offered "Friends" to those drivers, so nobody new sees the map).
-- get_profile, get_member_stats, get_heatmap and get_friends_board check friendship only, and
-- get_profile no longer names the other driver's clan. Every clan RPC that reads or changes a
-- clan is server-only. leave_clan stays callable: it only removes the caller and returns nothing.
-- The clans and clan_members tables, their triggers and the account export keep their rows.

-- ---------------------------------------------------------------------------
-- heat-map visibility: only_me | friends
-- ---------------------------------------------------------------------------
update public.profiles set heatmap_visibility = 'only_me' where heatmap_visibility = 'clan';
alter table public.profiles drop constraint profiles_heatmap_visibility_check;
alter table public.profiles add constraint profiles_heatmap_visibility_check
  check (heatmap_visibility in ('only_me', 'friends'));

-- update_profile: each argument null = unchanged
create or replace function public.update_profile(p_units text default null, p_state text default null, p_heatmap_visibility text default null) returns void
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
    heatmap_visibility = coalesce(p_heatmap_visibility, heatmap_visibility)
  where id = v_uid;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- what one driver sees of another: self and friends only
-- ---------------------------------------------------------------------------
-- get_profile(p_username): the public profile, or "not found" (also when blocked either way).
-- 'clan' is always null.
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_rel text;
  v_friend boolean;
  v_vis text;
begin
  if v_uid is null then
    raise exception 'get_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_username is null or char_length(p_username) > 20 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'get_profile', interval '1 minute', 60);
  select p.id, p.heatmap_visibility into v_other, v_vis from public.profiles p
    where p.username operator(extensions.=) p_username::extensions.citext and p.onboarded_at is not null;
  if v_other is null or private.blocked_either(v_uid, v_other) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  v_friend := private.are_friends(v_uid, v_other);
  v_rel := case
    when v_other = v_uid then 'self'
    when v_friend then 'friend'
    when exists (select 1 from public.friend_requests r where r.from_id = v_other and r.to_id = v_uid) then 'incoming'
    when exists (select 1 from public.friend_requests r where r.from_id = v_uid and r.to_id = v_other) then 'outgoing'
    else 'none' end;
  return private.public_card(v_other) || jsonb_build_object(
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_other), '[]'::jsonb),
    'clan', null,
    'relationship', v_rel,
    'can_view_stats', v_other = v_uid or v_friend,
    'can_view_heatmap', v_other = v_uid or (v_vis = 'friends' and v_friend));
end $$;

-- get_member_stats(p_user_id) -> StatSums for the last 30 days: self and friends only
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
  if p_user_id <> v_uid and (private.blocked_either(v_uid, p_user_id) or not private.are_friends(v_uid, p_user_id)) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  return private.stat_sums(p_user_id, now() - interval '30 days');
end $$;

-- get_heatmap(p_user_id) -> [{ polyline }] of up to 200 kept drives from the last 90 days: self
-- always; a friend only when the owner's heatmap_visibility is friends
create or replace function public.get_heatmap(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_vis text;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'get_heatmap requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id = v_uid then
    v_allowed := true;
  else
    select p.heatmap_visibility into v_vis from public.profiles p where p.id = p_user_id;
    v_allowed := v_vis = 'friends' and not private.blocked_either(v_uid, p_user_id)
      and private.are_friends(v_uid, p_user_id);
  end if;
  if not coalesce(v_allowed, false) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('polyline', t.polyline))
    from (
      select t.polyline from public.trips t
      where t.user_id = p_user_id and t.merged_into is null and not t.not_driving and t.polyline <> ''
        and t.started_at > now() - interval '90 days'
      order by t.started_at desc
      limit 200
    ) t), '[]'::jsonb);
end $$;

-- get_friends_board(p_metric week|rating) -> [{ rank, user_id, username, level, value, ranked, is_me }]
-- for self + friends (blocked omitted)
create or replace function public.get_friends_board(p_metric text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
begin
  if v_uid is null then
    raise exception 'get_friends_board requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_metric is null or p_metric not in ('week', 'rating') then
    raise exception 'metric must be week or rating' using errcode = 'invalid_parameter_value';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('rank', x.rank, 'user_id', x.user_id, 'username', x.username, 'level', x.level,
        'value', x.value, 'ranked', x.ranked, 'is_me', x.user_id = v_uid) order by x.rank)
    from (
      select (row_number() over (order by y.value desc nulls last, y.username))::int as rank, y.*
      from (
        select p.id as user_id, p.username, g.level, g.ranked,
          -- rating: only a ranked driver (25+ mi in 30 days) has a value; the rest sort after, value null
          case when p_metric = 'week' then private.week_points(p.id, v_week)::numeric when g.ranked then g.safety_rating else null end as value
        from (
          select v_uid as id
          union
          select case when f.user_a = v_uid then f.user_b else f.user_a end from public.friendships f where f.user_a = v_uid or f.user_b = v_uid
        ) u
        join public.profiles p on p.id = u.id join public.progress g on g.user_id = u.id
        where u.id = v_uid or not private.blocked_either(v_uid, u.id)
      ) y
    ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- clan RPCs: server-only (no client may create, join, preview, list or manage a clan)
-- ---------------------------------------------------------------------------
revoke all on function public.create_clan(text, text) from public, anon, authenticated;
revoke all on function public.preview_clan(text) from public, anon, authenticated;
revoke all on function public.join_clan(text) from public, anon, authenticated;
revoke all on function public.get_my_clan() from public, anon, authenticated;
revoke all on function public.set_member_role(uuid, text) from public, anon, authenticated;
revoke all on function public.transfer_leadership(uuid) from public, anon, authenticated;
revoke all on function public.remove_member(uuid) from public, anon, authenticated;
revoke all on function public.regenerate_clan_code() from public, anon, authenticated;
revoke all on function public.update_clan(text, text) from public, anon, authenticated;
