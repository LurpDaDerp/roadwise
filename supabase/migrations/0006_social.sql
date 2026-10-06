-- 0006_social: friends, blocks, reports, clans, and every RPC that shows one user to another.
--
-- Nothing about a user reaches another user except through these definer RPCs, each of which
-- checks the relationship (friend / clanmate / self) AND blocks in both directions before it
-- answers. Usernames are the only identity shown. A blocked user is "not found" everywhere.

create table public.friend_requests (
  from_id uuid not null references auth.users(id) on delete cascade,
  to_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  constraint friend_requests_not_self check (from_id <> to_id)
);
create index friend_requests_to_idx on public.friend_requests (to_id);

create table public.friendships (
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered check (user_a < user_b)
);
create index friendships_b_idx on public.friendships (user_b);

create table public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('user', 'clan')),
  target_id uuid not null,
  reason text not null check (reason in ('inappropriate_name', 'harassment', 'cheating', 'impersonation', 'other')),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index reports_reporter_idx on public.reports (reporter_id, created_at desc);

create table public.clans (
  id uuid primary key default gen_random_uuid(),
  name extensions.citext not null unique check (char_length(name::text) between 3 and 24 and name::text ~ '^[A-Za-z0-9][A-Za-z0-9 _.''-]*[A-Za-z0-9.]$'),
  banner text not null check (banner in ('navy', 'gold', 'sunset', 'forest', 'ocean', 'violet', 'ember', 'slate')),
  invite_code text not null unique check (invite_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger clans_touch before update on public.clans for each row execute function public.touch_updated_at();

create table public.clan_members (
  clan_id uuid not null references public.clans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('leader', 'coleader', 'member')),
  joined_at timestamptz not null default now(),
  primary key (user_id),
  constraint clan_members_clan_user unique (clan_id, user_id)
);
create index clan_members_clan_idx on public.clan_members (clan_id, joined_at);
-- exactly one leader per clan, checked at commit
create unique index clan_members_one_leader on public.clan_members (clan_id) where role = 'leader';

-- ---------------------------------------------------------------------------
-- clan leadership: hand-over when the leader's row goes (leave or account delete); an empty
-- clan is deleted
-- ---------------------------------------------------------------------------
create or replace function public.clan_member_gone() returns trigger
language plpgsql set search_path = public as $$
declare
  v_next uuid;
begin
  if not exists (select 1 from public.clans c where c.id = old.clan_id) then
    return null;
  end if;
  if not exists (select 1 from public.clan_members m where m.clan_id = old.clan_id) then
    delete from public.clans where id = old.clan_id;
    return null;
  end if;
  if old.role = 'leader' and not exists (select 1 from public.clan_members m where m.clan_id = old.clan_id and m.role = 'leader') then
    select m.user_id into v_next from public.clan_members m
      where m.clan_id = old.clan_id
      order by (m.role = 'coleader') desc, m.joined_at, m.user_id
      limit 1;
    update public.clan_members set role = 'leader' where user_id = v_next;
  end if;
  return null;
end $$;
create trigger clan_members_gone after delete on public.clan_members for each row execute function public.clan_member_gone();

create or replace function public.clan_leader_required() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.clans c where c.id = coalesce(new.clan_id, old.clan_id))
     and not exists (select 1 from public.clan_members m where m.clan_id = coalesce(new.clan_id, old.clan_id) and m.role = 'leader') then
    raise exception 'a clan needs a leader' using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger clan_leader_required after insert or update or delete on public.clan_members
  deferrable initially deferred for each row execute function public.clan_leader_required();

-- ---------------------------------------------------------------------------
-- relationship helpers
-- ---------------------------------------------------------------------------
create or replace function private.blocked_either(p_a uuid, p_b uuid) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from public.blocks b where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a))
$$;
create or replace function private.are_friends(p_a uuid, p_b uuid) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from public.friendships f where f.user_a = least(p_a, p_b) and f.user_b = greatest(p_a, p_b))
$$;
create or replace function private.clan_of(p_user uuid) returns uuid
language sql stable set search_path = public as $$
  select m.clan_id from public.clan_members m where m.user_id = p_user
$$;
create or replace function private.friend_count(p_user uuid) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.friendships f where f.user_a = p_user or f.user_b = p_user
$$;
-- 8 characters from an unambiguous alphabet (no 0/O, 1/I)
create or replace function private.new_invite_code() returns text
language sql volatile set search_path = public as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(extensions.gen_random_bytes(8), i) % 32), 1), '')
  from generate_series(0, 7) i
$$;
-- the public card of one user (the caller has already been checked)
create or replace function private.public_card(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'user_id', p.id, 'username', p.username, 'level', g.level,
    'safety_rating', g.safety_rating, 'ranked', g.ranked, 'league_tier', g.league_tier, 'streak', g.streak)
  from public.profiles p join public.progress g on g.user_id = p.id
  where p.id = p_user
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- search_users(p_query >= 3 chars) -> up to 20 { user_id, username, level, safety_rating }, prefix
-- match, onboarded users only, never self or anyone blocked either way; 30/min
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
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'username', p.username, 'level', g.level,
        'safety_rating', case when g.ranked then g.safety_rating end, 'ranked', g.ranked) order by p.username)
    from (
      select p.id, p.username from public.profiles p
      where p.username::text like replace(v_q, '_', '\_') || '%' and p.id <> v_uid and p.onboarded_at is not null
        and not private.blocked_either(v_uid, p.id)
      order by p.username
      limit 20
    ) p join public.progress g on g.user_id = p.id), '[]'::jsonb);
end $$;

-- get_profile(p_username): the public profile, or "not found" (also when blocked either way)
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_rel text;
  v_friend boolean;
  v_clanmate boolean;
  v_vis text;
  v_clan uuid;
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
  v_clan := private.clan_of(v_other);
  v_clanmate := coalesce(v_clan = private.clan_of(v_uid), false);
  v_rel := case
    when v_other = v_uid then 'self'
    when v_friend then 'friend'
    when exists (select 1 from public.friend_requests r where r.from_id = v_other and r.to_id = v_uid) then 'incoming'
    when exists (select 1 from public.friend_requests r where r.from_id = v_uid and r.to_id = v_other) then 'outgoing'
    else 'none' end;
  return private.public_card(v_other) || jsonb_build_object(
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_other), '[]'::jsonb),
    'clan', (select jsonb_build_object('id', c.id, 'name', c.name) from public.clans c where c.id = v_clan),
    'relationship', v_rel,
    'can_view_stats', v_other = v_uid or v_friend or v_clanmate,
    'can_view_heatmap', v_other = v_uid or (v_vis = 'friends' and v_friend) or (v_vis = 'clan' and v_clanmate));
end $$;

-- get_member_stats(p_user_id) -> StatSums for the last 30 days: self, friends and clanmates only
create or replace function public.get_member_stats(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
begin
  if v_uid is null then
    raise exception 'get_member_stats requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  v_clan := private.clan_of(p_user_id);
  if p_user_id <> v_uid and (private.blocked_either(v_uid, p_user_id)
     or not (private.are_friends(v_uid, p_user_id) or (v_clan is not null and v_clan = private.clan_of(v_uid)))) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  return private.stat_sums(p_user_id, now() - interval '30 days');
end $$;

-- get_heatmap(p_user_id) -> [{ polyline }] of up to 200 kept drives from the last 90 days: self
-- always; others only as their heatmap_visibility and the relationship allow
create or replace function public.get_heatmap(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_vis text;
  v_clan uuid;
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
    v_clan := private.clan_of(p_user_id);
    v_allowed := v_vis is not null and not private.blocked_either(v_uid, p_user_id) and (
      (v_vis = 'friends' and private.are_friends(v_uid, p_user_id))
      or (v_vis = 'clan' and v_clan is not null and v_clan = private.clan_of(v_uid)));
  end if;
  if not v_allowed then
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

-- ---------------------------------------------------------------------------
-- friends
-- ---------------------------------------------------------------------------
-- send_friend_request(p_user_id): auto-accepts when the reverse request exists; refused when
-- blocked either way (as "not found"), when already friends, or over the 200-friend cap; 20/h
create or replace function public.send_friend_request(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'send_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another user' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'send_friend_request', interval '1 hour', 20);
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.onboarded_at is not null)
     or private.blocked_either(v_uid, p_user_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if private.are_friends(v_uid, p_user_id) then
    return jsonb_build_object('status', 'friends');
  end if;
  if private.friend_count(v_uid) >= 200 then
    raise exception 'you have reached the friend limit' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.friend_requests r where r.from_id = p_user_id and r.to_id = v_uid) then
    if private.friend_count(p_user_id) >= 200 then
      raise exception 'that user has reached the friend limit' using errcode = 'insufficient_privilege';
    end if;
    delete from public.friend_requests where (from_id = p_user_id and to_id = v_uid) or (from_id = v_uid and to_id = p_user_id);
    insert into public.friendships (user_a, user_b) values (least(v_uid, p_user_id), greatest(v_uid, p_user_id)) on conflict do nothing;
    return jsonb_build_object('status', 'friends');
  end if;
  insert into public.friend_requests (from_id, to_id) values (v_uid, p_user_id) on conflict do nothing;
  insert into public.inbox (user_id, kind, payload, dedupe_key)
    values (p_user_id, 'friend_request', jsonb_build_object('from_user_id', v_uid), 'friend_request:' || v_uid)
    on conflict (user_id, dedupe_key) do nothing;
  return jsonb_build_object('status', 'requested');
end $$;

create or replace function public.respond_friend_request(p_user_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'respond_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_accept is null then
    raise exception 'user_id and accept are required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.friend_requests where from_id = p_user_id and to_id = v_uid;
  if not found then
    raise exception 'no such request' using errcode = 'no_data_found';
  end if;
  if p_accept then
    if private.blocked_either(v_uid, p_user_id) then
      raise exception 'profile not found' using errcode = 'no_data_found';
    end if;
    if private.friend_count(v_uid) >= 200 or private.friend_count(p_user_id) >= 200 then
      raise exception 'you have reached the friend limit' using errcode = 'insufficient_privilege';
    end if;
    insert into public.friendships (user_a, user_b) values (least(v_uid, p_user_id), greatest(v_uid, p_user_id)) on conflict do nothing;
    delete from public.friend_requests where from_id = v_uid and to_id = p_user_id;
  end if;
end $$;

create or replace function public.cancel_friend_request(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'cancel_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.friend_requests where from_id = v_uid and to_id = p_user_id;
  if not found then
    raise exception 'no such request' using errcode = 'no_data_found';
  end if;
end $$;

create or replace function public.remove_friend(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'remove_friend requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.friendships where user_a = least(v_uid, p_user_id) and user_b = greatest(v_uid, p_user_id);
  if not found then
    raise exception 'not friends' using errcode = 'no_data_found';
  end if;
end $$;

-- list_friends() -> { friends[], incoming[], outgoing[] } of public cards (blocked omitted)
create or replace function public.list_friends() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_friends requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'friends', coalesce((select jsonb_agg(private.public_card(x.other) order by x.created_at desc)
      from (select case when f.user_a = v_uid then f.user_b else f.user_a end as other, f.created_at from public.friendships f
            where f.user_a = v_uid or f.user_b = v_uid) x
      where not private.blocked_either(v_uid, x.other)), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(private.public_card(r.from_id) order by r.created_at desc) from (
      select q.from_id, q.created_at from public.friend_requests q where q.to_id = v_uid and not private.blocked_either(v_uid, q.from_id)
      order by q.created_at desc limit 200) r), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(private.public_card(r.to_id) order by r.created_at desc) from (
      select q.to_id, q.created_at from public.friend_requests q where q.from_id = v_uid and not private.blocked_either(v_uid, q.to_id)
      order by q.created_at desc limit 200) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- blocks and reports
-- ---------------------------------------------------------------------------
create or replace function public.block_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'block_user requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another user' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.blocks b where b.blocker_id = v_uid) >= 500 then
    raise exception 'you have reached the block limit' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_user_id) on conflict do nothing;
  delete from public.friendships where user_a = least(v_uid, p_user_id) and user_b = greatest(v_uid, p_user_id);
  delete from public.friend_requests where (from_id = v_uid and to_id = p_user_id) or (from_id = p_user_id and to_id = v_uid);
end $$;

create or replace function public.unblock_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unblock_user requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.blocks where blocker_id = v_uid and blocked_id = p_user_id;
  if not found then
    raise exception 'not blocked' using errcode = 'no_data_found';
  end if;
end $$;

-- list_blocked() -> [{ user_id, username }]
create or replace function public.list_blocked() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_blocked requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'username', p.username) order by b.created_at desc)
    from public.blocks b join public.profiles p on p.id = b.blocked_id where b.blocker_id = v_uid), '[]'::jsonb);
end $$;

-- report_target(p_kind, p_target_id, p_reason, p_note): 10/day; an unknown target is the same fixed
-- refusal as everywhere else (the budget is taken first, so the answer costs a report)
create or replace function public.report_target(p_kind text, p_target_id uuid, p_reason text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'report_target requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_kind is null or p_kind not in ('user', 'clan') or p_target_id is null then
    raise exception 'kind must be user or clan with a target id' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('inappropriate_name', 'harassment', 'cheating', 'impersonation', 'other') then
    raise exception 'unknown report reason' using errcode = 'invalid_parameter_value';
  end if;
  if p_note is null or char_length(p_note) > 500 then
    raise exception 'note must be at most 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_kind = 'user' and p_target_id = v_uid then
    raise exception 'kind must be user or clan with a target id' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'report_target', interval '1 day', 10);
  if p_kind = 'user' and not exists (select 1 from public.profiles p where p.id = p_target_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if p_kind = 'clan' and not exists (select 1 from public.clans c where c.id = p_target_id) then
    raise exception 'clan not found' using errcode = 'no_data_found';
  end if;
  insert into public.reports (reporter_id, target_kind, target_id, reason, note)
    values (v_uid, p_kind, p_target_id, p_reason, regexp_replace(p_note, '[[:cntrl:]]', '', 'g'));
end $$;

-- ---------------------------------------------------------------------------
-- clans
-- ---------------------------------------------------------------------------
create or replace function private.clan_name_problem(p text) returns text
language plpgsql stable set search_path = public as $$
declare
  v text := btrim(coalesce(p, ''));
begin
  if char_length(v) < 3 or char_length(v) > 24 then
    return 'length';
  end if;
  if v !~ '^[A-Za-z0-9][A-Za-z0-9 _.''-]*[A-Za-z0-9.]$' or v ~ '  ' then
    return 'characters';
  end if;
  if not private.is_clean_name(v) then
    return 'not_allowed';
  end if;
  if exists (select 1 from public.clans c where c.name operator(extensions.=) v::extensions.citext) then
    return 'taken';
  end if;
  return null;
end $$;

-- create_clan(p_name, p_banner) -> { id, name, banner, invite_code }: the caller becomes leader
create or replace function public.create_clan(p_name text, p_banner text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_id uuid;
  v_code text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then
    raise exception 'create_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_name is null or char_length(p_name) > 64 then
    raise exception 'name must be 3 to 24 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_banner is null or p_banner not in ('navy', 'gold', 'sunset', 'forest', 'ocean', 'violet', 'ember', 'slate') then
    raise exception 'unknown banner' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'create_clan', interval '1 day', 5);
  if private.clan_of(v_uid) is not null then
    raise exception 'you are already in a clan' using errcode = 'insufficient_privilege';
  end if;
  v_problem := private.clan_name_problem(v_name);
  if v_problem = 'taken' then
    raise exception 'clan name is taken' using errcode = 'unique_violation';
  elsif v_problem is not null then
    raise exception 'name must be 3 to 24 characters' using errcode = 'invalid_parameter_value';
  end if;
  loop
    v_code := private.new_invite_code();
    exit when not exists (select 1 from public.clans c where c.invite_code = v_code);
  end loop;
  insert into public.clans (name, banner, invite_code) values (v_name::extensions.citext, p_banner, v_code) returning id into v_id;
  insert into public.clan_members (clan_id, user_id, role) values (v_id, v_uid, 'leader');
  return jsonb_build_object('id', v_id, 'name', v_name, 'banner', p_banner, 'invite_code', v_code);
end $$;

-- preview_clan(p_code) -> { name, banner, member_count, full }; 20/min (codes are unguessable but
-- the preview is still an oracle)
create or replace function public.preview_clan(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'preview_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_code is null or upper(btrim(p_code)) !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$' then
    raise exception 'code must be 8 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'preview_clan', interval '1 minute', 20);
  select jsonb_build_object('id', c.id, 'name', c.name, 'banner', c.banner,
      'member_count', (select count(*) from public.clan_members m where m.clan_id = c.id),
      'full', (select count(*) from public.clan_members m where m.clan_id = c.id) >= 30)
    into v_out
  from public.clans c where c.invite_code = upper(btrim(p_code));
  if v_out is null then
    raise exception 'clan not found' using errcode = 'no_data_found';
  end if;
  return v_out;
end $$;

-- join_clan(p_code) -> { id, name }: one clan per user, 30 members, no joining a clan whose
-- members you have blocked or who have blocked you is refused too
create or replace function public.join_clan(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_name text;
  v_n int;
begin
  if v_uid is null then
    raise exception 'join_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_code is null or upper(btrim(p_code)) !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$' then
    raise exception 'code must be 8 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'join_clan', interval '1 minute', 10);
  if private.clan_of(v_uid) is not null then
    raise exception 'you are already in a clan' using errcode = 'insufficient_privilege';
  end if;
  select c.id, c.name into v_id, v_name from public.clans c where c.invite_code = upper(btrim(p_code)) for update;
  if v_id is null then
    raise exception 'clan not found' using errcode = 'no_data_found';
  end if;
  select count(*) into v_n from public.clan_members m where m.clan_id = v_id;
  if v_n >= 30 then
    raise exception 'this clan is full' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.clan_members m where m.clan_id = v_id and private.blocked_either(v_uid, m.user_id)) then
    raise exception 'you cannot join this clan' using errcode = 'insufficient_privilege';
  end if;
  insert into public.clan_members (clan_id, user_id, role) values (v_id, v_uid, 'member');
  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

create or replace function public.leave_clan() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'leave_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  delete from public.clan_members where user_id = v_uid;
  if not found then
    raise exception 'you are not in a clan' using errcode = 'no_data_found';
  end if;
end $$;

-- the weekly clan goal: max(50, 25 x members) clean miles rounded to 10; progress = this week's
-- clean scored miles of the current members
create or replace function private.clan_goal(p_clan uuid, p_week text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'week', p_week,
    'target_clean_miles', greatest(50, round(25 * (select count(*) from public.clan_members m where m.clan_id = p_clan) / 10.0) * 10)::int,
    'clean_miles', coalesce((select sum(t.miles) from public.trips t join public.clan_members m on m.user_id = t.user_id
      where m.clan_id = p_clan and t.league_week = p_week and t.scored and t.clean and not t.not_driving and t.merged_into is null), 0))
$$;

-- get_my_clan() -> null, or { clan, my_role, goal, members[] } (blocked members omitted)
create or replace function public.get_my_clan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
  v_role text;
  v_week text := private.league_week(now());
begin
  if v_uid is null then
    raise exception 'get_my_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select m.clan_id, m.role into v_clan, v_role from public.clan_members m where m.user_id = v_uid;
  if v_clan is null then
    return null;
  end if;
  return jsonb_build_object(
    'clan', (select jsonb_build_object('id', c.id, 'name', c.name, 'banner', c.banner,
               'invite_code', case when v_role in ('leader', 'coleader') then c.invite_code else null end,
               'member_count', (select count(*) from public.clan_members m where m.clan_id = c.id))
             from public.clans c where c.id = v_clan),
    'my_role', v_role,
    'goal', private.clan_goal(v_clan, v_week),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'user_id', p.id, 'username', p.username, 'role', m.role, 'joined_at', m.joined_at,
          'level', g.level, 'safety_rating', g.safety_rating, 'ranked', g.ranked, 'points', g.points,
          'week_points', private.week_points(p.id, v_week), 'miles_30d', g.miles_30d,
          'clean_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where t.clean) / count(*)) end
                        from public.trips t where t.user_id = p.id and t.scored and not t.not_driving and t.merged_into is null
                          and t.started_at > now() - interval '30 days'),
          'streak', g.streak) order by m.joined_at)
      from public.clan_members m join public.profiles p on p.id = m.user_id join public.progress g on g.user_id = m.user_id
      where m.clan_id = v_clan and not private.blocked_either(v_uid, m.user_id)), '[]'::jsonb));
end $$;

-- set_member_role(p_user_id, p_role coleader|member): leader only
create or replace function public.set_member_role(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
begin
  if v_uid is null then
    raise exception 'set_member_role requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_role is null or p_role not in ('coleader', 'member') or p_user_id = v_uid then
    raise exception 'role must be coleader or member for another member' using errcode = 'invalid_parameter_value';
  end if;
  select m.clan_id into v_clan from public.clan_members m where m.user_id = v_uid and m.role = 'leader';
  if v_clan is null then
    raise exception 'only the leader can do that' using errcode = 'insufficient_privilege';
  end if;
  update public.clan_members set role = p_role where user_id = p_user_id and clan_id = v_clan and role <> 'leader';
  if not found then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
end $$;

-- transfer_leadership(p_user_id): leader only; the old leader becomes a co-leader
create or replace function public.transfer_leadership(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
begin
  if v_uid is null then
    raise exception 'transfer_leadership requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another member' using errcode = 'invalid_parameter_value';
  end if;
  select m.clan_id into v_clan from public.clan_members m where m.user_id = v_uid and m.role = 'leader' for update;
  if v_clan is null then
    raise exception 'only the leader can do that' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.clan_members m where m.user_id = p_user_id and m.clan_id = v_clan) then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  update public.clan_members set role = 'coleader' where user_id = v_uid;
  update public.clan_members set role = 'leader' where user_id = p_user_id;
end $$;

-- remove_member(p_user_id): the leader removes any non-leader; a co-leader removes members only
create or replace function public.remove_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
  v_role text;
  v_target_role text;
begin
  if v_uid is null then
    raise exception 'remove_member requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another member' using errcode = 'invalid_parameter_value';
  end if;
  select m.clan_id, m.role into v_clan, v_role from public.clan_members m where m.user_id = v_uid;
  if v_clan is null or v_role not in ('leader', 'coleader') then
    raise exception 'only the leader or a co-leader can do that' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_target_role from public.clan_members m where m.user_id = p_user_id and m.clan_id = v_clan;
  if v_target_role is null then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  if v_target_role = 'leader' or (v_role = 'coleader' and v_target_role <> 'member') then
    raise exception 'only the leader or a co-leader can do that' using errcode = 'insufficient_privilege';
  end if;
  delete from public.clan_members where user_id = p_user_id and clan_id = v_clan;
end $$;

-- regenerate_clan_code() -> { invite_code }: leader or co-leader; 10/h
create or replace function public.regenerate_clan_code() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
  v_code text;
begin
  if v_uid is null then
    raise exception 'regenerate_clan_code requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select m.clan_id into v_clan from public.clan_members m where m.user_id = v_uid and m.role in ('leader', 'coleader');
  if v_clan is null then
    raise exception 'only the leader or a co-leader can do that' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'regenerate_clan_code', interval '1 hour', 10);
  loop
    v_code := private.new_invite_code();
    exit when not exists (select 1 from public.clans c where c.invite_code = v_code);
  end loop;
  update public.clans set invite_code = v_code where id = v_clan;
  return jsonb_build_object('invite_code', v_code);
end $$;

-- update_clan(p_name?, p_banner?): leader only
create or replace function public.update_clan(p_name text default null, p_banner text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
  v_problem text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then
    raise exception 'update_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_banner is not null and p_banner not in ('navy', 'gold', 'sunset', 'forest', 'ocean', 'violet', 'ember', 'slate') then
    raise exception 'unknown banner' using errcode = 'invalid_parameter_value';
  end if;
  if p_name is not null and char_length(p_name) > 64 then
    raise exception 'name must be 3 to 24 characters' using errcode = 'invalid_parameter_value';
  end if;
  select m.clan_id into v_clan from public.clan_members m where m.user_id = v_uid and m.role = 'leader';
  if v_clan is null then
    raise exception 'only the leader can do that' using errcode = 'insufficient_privilege';
  end if;
  if p_name is not null and not exists (select 1 from public.clans c where c.id = v_clan and c.name operator(extensions.=) v_name::extensions.citext) then
    perform private.require_rate_limit(v_uid, 'update_clan', interval '1 day', 5);
    v_problem := private.clan_name_problem(v_name);
    if v_problem = 'taken' then
      raise exception 'clan name is taken' using errcode = 'unique_violation';
    elsif v_problem is not null then
      raise exception 'name must be 3 to 24 characters' using errcode = 'invalid_parameter_value';
    end if;
    update public.clans set name = v_name::extensions.citext where id = v_clan;
  end if;
  if p_banner is not null then
    update public.clans set banner = p_banner where id = v_clan;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS and grants: nothing is read directly
-- ---------------------------------------------------------------------------
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.clans enable row level security;
alter table public.clan_members enable row level security;

revoke all on public.friend_requests, public.friendships, public.blocks, public.reports, public.clans, public.clan_members from anon, authenticated;

revoke all on function public.clan_member_gone() from public, anon, authenticated;
revoke all on function public.clan_leader_required() from public, anon, authenticated;
revoke all on function public.search_users(text) from public, anon, authenticated;
revoke all on function public.get_profile(text) from public, anon, authenticated;
revoke all on function public.get_member_stats(uuid) from public, anon, authenticated;
revoke all on function public.get_heatmap(uuid) from public, anon, authenticated;
revoke all on function public.send_friend_request(uuid) from public, anon, authenticated;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cancel_friend_request(uuid) from public, anon, authenticated;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated;
revoke all on function public.list_friends() from public, anon, authenticated;
revoke all on function public.block_user(uuid) from public, anon, authenticated;
revoke all on function public.unblock_user(uuid) from public, anon, authenticated;
revoke all on function public.list_blocked() from public, anon, authenticated;
revoke all on function public.report_target(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.create_clan(text, text) from public, anon, authenticated;
revoke all on function public.preview_clan(text) from public, anon, authenticated;
revoke all on function public.join_clan(text) from public, anon, authenticated;
revoke all on function public.leave_clan() from public, anon, authenticated;
revoke all on function public.get_my_clan() from public, anon, authenticated;
revoke all on function public.set_member_role(uuid, text) from public, anon, authenticated;
revoke all on function public.transfer_leadership(uuid) from public, anon, authenticated;
revoke all on function public.remove_member(uuid) from public, anon, authenticated;
revoke all on function public.regenerate_clan_code() from public, anon, authenticated;
revoke all on function public.update_clan(text, text) from public, anon, authenticated;
grant execute on function public.search_users(text) to authenticated;
grant execute on function public.get_profile(text) to authenticated;
grant execute on function public.get_member_stats(uuid) to authenticated;
grant execute on function public.get_heatmap(uuid) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.list_friends() to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.list_blocked() to authenticated;
grant execute on function public.report_target(text, uuid, text, text) to authenticated;
grant execute on function public.create_clan(text, text) to authenticated;
grant execute on function public.preview_clan(text) to authenticated;
grant execute on function public.join_clan(text) to authenticated;
grant execute on function public.leave_clan() to authenticated;
grant execute on function public.get_my_clan() to authenticated;
grant execute on function public.set_member_role(uuid, text) to authenticated;
grant execute on function public.transfer_leadership(uuid) to authenticated;
grant execute on function public.remove_member(uuid) to authenticated;
grant execute on function public.regenerate_clan_code() to authenticated;
grant execute on function public.update_clan(text, text) to authenticated;
