-- hosted safety (T5 review): fail fast on a lock rather than queue in front of apply_trip
set lock_timeout = '5s';

-- 0012_family: lean M6, as the user revised it (scope.md, 2026-09-26). Family groups, live location
-- (one overwritten row per person, no history), family-wide saved places, and per-member location
-- sharing that is OFF until the member turns it on.
--
-- Cut: guardian trip summaries and scores, the "finished a drive" push, member trip detail, the
-- digest, the audit, Realtime (viewers poll), emergency contacts, arrive/leave alerts. The M4 A5
-- guardian consent step stays as it is (dark, flagged).
--
-- Objects (every one follows .agent/backend-conventions.md):
--   * public.families: name, code (6 of the 31-letter alphabet, unique), code_expires_at (7 days,
--     rotatable). No user reference.
--   * public.family_members: (family_id, user_id) pk, user_id unique (one family per person), role
--     admin|member (the creator is the admin), sharing_location (default false).
--   * public.member_locations: ONE row per person, overwritten (never a history): lat, lng, accuracy_m,
--     driving, updated_at. Documented exception to #11 (no created_at: the row carries only "now").
--   * public.family_places: family-wide places (name, address as the phone geocoded it, lat, lng,
--     radius_m 50..2000, default 150). At most 20 per family.
--   * All four: RLS on, no policies, no grants for any API role: every read and write is a definer RPC
--     below that checks membership first (convention 12). None is in supabase_realtime.
--   * family_members_after_delete (definer): the leaver's location row goes; a family left with no
--     admin makes its longest-standing member admin; a family left with no one is deleted (places too).
--   * client RPCs (definer, owner postgres, proconfig exactly search_path=public, lock_timeout=2s,
--     auth.uid() first, u13 and unknown ages refused): create_family, join_family, leave_family,
--     remove_family_member, rotate_family_code, set_location_sharing, post_my_location,
--     family_snapshot, save_family_place, delete_family_place.
--   * join_family's attempts are budgeted (10 per 24 h, rate_limits key `family_join`); a wrong, expired
--     or malformed code reads the same ('invalid code'); refusals after the take are RETURNED (0011's
--     referral_refusal: the PostgREST error body and status) so the take commits.
--   * post_my_location is rate-limited server-side: a post within 20 s of the member's last accepted one
--     is not written ({ accepted: false }). Refused while sharing is off or outside a family.
--   * Privacy: a location is visible only to members of the same family, only while its owner shares,
--     and only while under 24 h old; turning sharing off, leaving or being removed deletes the row at
--     once; purge_member_locations (hourly cron `purge-member-locations`) deletes rows older than 24 h.
--   * minimise_underage_rewards (0011's) is replaced once more to delete the user's family_members and
--     member_locations rows (the delete trigger promotes or dissolves).
--
-- Nothing from 0001-0011 is edited except `create or replace` of minimise_underage_rewards.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  code text not null unique check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  code_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  sharing_location boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

-- one overwritten row per person: no history (documented exception to #11: no created_at)
create table public.member_locations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m real not null check (accuracy_m between 0 and 10000),
  driving boolean not null default false,
  updated_at timestamptz not null default now()
);
-- the hourly purge's scan
create index member_locations_updated_idx on public.member_locations (updated_at);

create table public.family_places (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  address text not null default '' check (char_length(address) <= 200),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m int not null default 150 check (radius_m between 50 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index family_places_family_idx on public.family_places (family_id);

create trigger families_touch before update on public.families for each row execute function public.touch_updated_at();
create trigger family_members_touch before update on public.family_members for each row execute function public.touch_updated_at();
create trigger family_places_touch before update on public.family_places for each row execute function public.touch_updated_at();
create trigger family_members_refuse_underage before insert on public.family_members for each row execute function public.refuse_underage_writes();
create trigger member_locations_refuse_underage before insert on public.member_locations for each row execute function public.refuse_underage_writes();

-- whoever leaves (by leaving, removal, account deletion or minimisation): their location row goes; a
-- family without an admin gets its longest-standing member as admin; a family without members ends
create or replace function public.family_members_after_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.member_locations where user_id = old.user_id;
  if not exists (select 1 from public.family_members m where m.family_id = old.family_id) then
    delete from public.families where id = old.family_id;
  elsif not exists (select 1 from public.family_members m where m.family_id = old.family_id and m.role = 'admin') then
    update public.family_members set role = 'admin'
      where family_id = old.family_id
        and user_id = (select m.user_id from public.family_members m where m.family_id = old.family_id
                       order by m.created_at, m.user_id limit 1);
  end if;
  return null;
end $$;
create trigger family_members_after_delete after delete on public.family_members
  for each row execute function public.family_members_after_delete();

-- ---------------------------------------------------------------------------
-- helpers (no API role executes them)
-- ---------------------------------------------------------------------------
-- a fresh 6-character code: rejection sampling (bytes 0..247 map evenly onto the 31 letters)
create or replace function public.family_new_code() returns text
language plpgsql set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_bytes bytea;
  v_b int;
begin
  while char_length(v_code) < 6 loop
    v_bytes := extensions.gen_random_bytes(16);
    for i in 0 .. 15 loop
      v_b := get_byte(v_bytes, i);
      if v_b < 248 then
        v_code := v_code || substr(v_alphabet, (v_b % 31) + 1, 1);
        exit when char_length(v_code) = 6;
      end if;
    end loop;
  end loop;
  return v_code;
end $$;

-- refuses what no family feature serves: under 13, or an age not yet known
create or replace function public.family_check_eligible(p_uid uuid) returns void
language plpgsql stable set search_path = public as $$
begin
  if not exists (select 1 from public.profiles p where p.id = p_uid and p.age_band in ('13_17', '18_plus')) then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- the caller's family id, or a refusal
create or replace function public.family_of(p_uid uuid) returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_family uuid;
begin
  select m.family_id into v_family from public.family_members m where m.user_id = p_uid;
  if v_family is null then
    raise exception 'not in a family' using errcode = 'invalid_parameter_value';
  end if;
  return v_family;
end $$;

-- a valid place name, address and position, or a refusal
create or replace function public.family_check_place(p_name text, p_address text, p_lat double precision, p_lng double precision,
  p_radius_m int) returns void
language plpgsql immutable set search_path = public as $$
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 40 or char_length(coalesce(p_address, '')) > 200
     or p_lat is null or p_lat not between -90 and 90 or p_lng is null or p_lng not between -180 and 180
     or p_radius_m is null or p_radius_m not between 50 and 2000 then
    raise exception 'invalid place' using errcode = 'invalid_parameter_value';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- a new family with the caller as its admin; { familyId }
create or replace function public.create_family(p_name text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_retries int := 0;
begin
  if v_uid is null then
    raise exception 'create_family requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform public.family_check_eligible(v_uid);
  if char_length(v_name) not between 1 and 40 then
    raise exception 'invalid name' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.family_members m where m.user_id = v_uid) then
    raise exception 'already in a family' using errcode = 'invalid_parameter_value';
  end if;
  loop
    begin
      insert into public.families (name, code, code_expires_at)
        values (v_name, public.family_new_code(), now() + interval '7 days')
        returning id into v_id;
      exit;
    exception when unique_violation then
      v_retries := v_retries + 1;
      if v_retries > 5 then
        raise;
      end if;
    end;
  end loop;
  begin
    insert into public.family_members (family_id, user_id, role) values (v_id, v_uid, 'admin');
  exception when unique_violation then
    raise exception 'already in a family' using errcode = 'invalid_parameter_value';
  end;
  return jsonb_build_object('familyId', v_id);
end $$;

-- join by code; { familyId }. Eligibility, then the caller's budget (its row is the mutex), then
-- "already in one", then the code; after the take every refusal is returned, not raised.
create or replace function public.join_family(p_code text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
  v_start timestamptz;
  v_code text;
  v_family uuid;
begin
  if v_uid is null then
    raise exception 'join_family requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform public.family_check_eligible(v_uid);
  insert into public.rate_limits (user_id, key) values (v_uid, 'family_join') on conflict (user_id, key) do nothing;
  select rl.count, rl.window_start into v_count, v_start from public.rate_limits rl
    where rl.user_id = v_uid and rl.key = 'family_join' for update;
  if exists (select 1 from public.family_members m where m.user_id = v_uid) then
    raise exception 'already in a family' using errcode = 'invalid_parameter_value';
  end if;
  if v_start <= now() - interval '24 hours' then
    v_count := 0;
    v_start := now();
  end if;
  if v_count >= 10 then
    raise log 'family join budget exhausted';
    raise exception 'too many attempts' using errcode = 'insufficient_privilege';
  end if;
  update public.rate_limits set count = v_count + 1, window_start = v_start where user_id = v_uid and key = 'family_join';

  -- from here every refusal is returned (the take above must commit)
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    return public.referral_refusal('22023', 'invalid code');
  end if;
  select f.id into v_family from public.families f where f.code = v_code and f.code_expires_at > now() for update;
  if v_family is null then
    return public.referral_refusal('22023', 'invalid code');
  end if;
  if (select count(*) from public.family_members m where m.family_id = v_family) >= 8 then
    return public.referral_refusal('42501', 'family is full');
  end if;
  insert into public.family_members (family_id, user_id, role) values (v_family, v_uid, 'member');
  return jsonb_build_object('familyId', v_family);
end $$;

-- leave the caller's family: their location row goes with them
create or replace function public.leave_family() returns void
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'leave_family requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  delete from public.family_members where user_id = v_uid;
  if not found then
    raise exception 'not in a family' using errcode = 'invalid_parameter_value';
  end if;
end $$;

-- the admin removes another member of their family
create or replace function public.remove_family_member(p_user uuid) returns void
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
begin
  if v_uid is null then
    raise exception 'remove_family_member requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select m.family_id into v_family from public.family_members m where m.user_id = v_uid and m.role = 'admin';
  if v_family is null then
    raise exception 'only the family admin can remove a member' using errcode = 'insufficient_privilege';
  end if;
  if p_user is null or p_user = v_uid then
    raise exception 'use leave_family to leave' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.family_members where family_id = v_family and user_id = p_user;
  if not found then
    raise exception 'not in your family' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- the admin replaces the join code (the old one stops working at once); { code, codeExpiresAt }
create or replace function public.rotate_family_code() returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
  v_retries int := 0;
begin
  if v_uid is null then
    raise exception 'rotate_family_code requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select m.family_id into v_family from public.family_members m where m.user_id = v_uid and m.role = 'admin';
  if v_family is null then
    raise exception 'only the family admin can change the code' using errcode = 'insufficient_privilege';
  end if;
  loop
    begin
      v_code := public.family_new_code();
      update public.families set code = v_code, code_expires_at = v_expires where id = v_family;
      exit;
    exception when unique_violation then
      v_retries := v_retries + 1;
      if v_retries > 5 then
        raise;
      end if;
    end;
  end loop;
  return jsonb_build_object('code', v_code, 'codeExpiresAt', v_expires);
end $$;

-- turn the caller's location sharing on or off; off deletes their location row at once
create or replace function public.set_location_sharing(p_on boolean) returns void
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'set_location_sharing requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_on is null then
    raise exception 'invalid value' using errcode = 'invalid_parameter_value';
  end if;
  update public.family_members set sharing_location = p_on where user_id = v_uid;
  if not found then
    raise exception 'not in a family' using errcode = 'invalid_parameter_value';
  end if;
  if not p_on then
    delete from public.member_locations where user_id = v_uid;
  end if;
end $$;

-- overwrite the caller's one location row; { accepted }. Refused unless the caller is in a family and
-- shares; not written within 20 s of the last accepted post (the server's rate limit).
create or replace function public.post_my_location(p_lat double precision, p_lng double precision, p_accuracy_m real,
  p_driving boolean) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then
    raise exception 'post_my_location requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_lat is null or p_lat not between -90 and 90 or p_lng is null or p_lng not between -180 and 180
     or p_accuracy_m is null or p_accuracy_m not between 0 and 10000 or p_driving is null then
    raise exception 'invalid location' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.family_members m where m.user_id = v_uid and m.sharing_location) then
    raise exception 'location sharing is off' using errcode = 'insufficient_privilege';
  end if;
  insert into public.member_locations as l (user_id, lat, lng, accuracy_m, driving, updated_at)
    values (v_uid, p_lat, p_lng, p_accuracy_m, p_driving, now())
    on conflict (user_id) do update
      set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, driving = excluded.driving,
          updated_at = excluded.updated_at
      where l.updated_at <= now() - interval '20 seconds' or l.updated_at > now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('accepted', v_n > 0);
end $$;

-- the caller's family as the Family tab shows it: { family: null } or { family: { id, name, myRole,
-- mySharing, code, codeExpiresAt (the admin only; null otherwise), members: [{ userId, name, role, isMe,
-- sharing, location: { lat, lng, accuracyM, driving, updatedAt } | null }], places: [{ id, name, address,
-- lat, lng, radiusM }] } }. A location is present only while its owner shares and it is under 24 h old.
create or replace function public.family_snapshot() returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_me public.family_members%rowtype;
  v_family public.families%rowtype;
  v_admin boolean;
begin
  if v_uid is null then
    raise exception 'family_snapshot requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform public.family_check_eligible(v_uid);
  select * into v_me from public.family_members m where m.user_id = v_uid;
  if v_me.user_id is null then
    return jsonb_build_object('family', null);
  end if;
  select * into v_family from public.families f where f.id = v_me.family_id;
  v_admin := v_me.role = 'admin';
  return jsonb_build_object('family', jsonb_build_object(
    'id', v_family.id,
    'name', v_family.name,
    'myRole', v_me.role,
    'mySharing', v_me.sharing_location,
    'code', case when v_admin then v_family.code end,
    'codeExpiresAt', case when v_admin then v_family.code_expires_at end,
    'members', (select jsonb_agg(jsonb_build_object(
        'userId', m.user_id,
        'name', coalesce(p.display_name, ''),
        'role', m.role,
        'isMe', m.user_id = v_uid,
        'sharing', m.sharing_location,
        'location', case when m.sharing_location and l.user_id is not null and l.updated_at > now() - interval '24 hours'
                         then jsonb_build_object('lat', l.lat, 'lng', l.lng, 'accuracyM', l.accuracy_m,
                                                 'driving', l.driving, 'updatedAt', l.updated_at) end)
      order by (m.user_id = v_uid) desc, m.role, m.created_at, m.user_id)
      from public.family_members m
      left join public.profiles p on p.id = m.user_id
      left join public.member_locations l on l.user_id = m.user_id
      where m.family_id = v_family.id),
    'places', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'name', pl.name, 'address', pl.address,
        'lat', pl.lat, 'lng', pl.lng, 'radiusM', pl.radius_m) order by pl.name, pl.id)
      from public.family_places pl where pl.family_id = v_family.id), '[]'::jsonb)));
end $$;

-- add (p_id null) or edit a family place; any member. { id }
create or replace function public.save_family_place(p_id uuid, p_name text, p_address text, p_lat double precision,
  p_lng double precision, p_radius_m int) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'save_family_place requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  v_family := public.family_of(v_uid);
  perform public.family_check_place(p_name, p_address, p_lat, p_lng, p_radius_m);
  if p_id is null then
    perform 1 from public.families where id = v_family for update;
    if (select count(*) from public.family_places pl where pl.family_id = v_family) >= 20 then
      raise exception 'too many places' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.family_places (family_id, name, address, lat, lng, radius_m)
      values (v_family, btrim(p_name), coalesce(p_address, ''), p_lat, p_lng, p_radius_m)
      returning id into v_id;
  else
    update public.family_places
      set name = btrim(p_name), address = coalesce(p_address, ''), lat = p_lat, lng = p_lng, radius_m = p_radius_m
      where id = p_id and family_id = v_family
      returning id into v_id;
    if v_id is null then
      raise exception 'not in your family' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- delete a family place; any member
create or replace function public.delete_family_place(p_id uuid) returns void
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
begin
  if v_uid is null then
    raise exception 'delete_family_place requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  v_family := public.family_of(v_uid);
  delete from public.family_places where id = p_id and family_id = v_family;
  if not found then
    raise exception 'not in your family' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- retention: no location older than 24 h is kept
-- ---------------------------------------------------------------------------
create or replace function public.purge_member_locations() returns int
language plpgsql set search_path = public as $$
declare
  v_n int;
begin
  delete from public.member_locations where updated_at < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
select cron.schedule('purge-member-locations', '20 * * * *', 'select public.purge_member_locations()');

-- ---------------------------------------------------------------------------
-- 0011's minimisation, also covering the family tables (the delete trigger promotes or dissolves)
-- ---------------------------------------------------------------------------
create or replace function public.minimise_underage_rewards() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce(auth.uid() = new.id, false)
          or coalesce(auth.role() = 'service_role', false)
          or (auth.uid() is null and session_user = 'postgres')) then
    raise exception 'minimise_underage_rewards requires the account owner or the service role' using errcode = 'insufficient_privilege';
  end if;
  delete from public.family_members where user_id = new.id;
  delete from public.member_locations where user_id = new.id;
  delete from public.referrals where referrer_id = new.id or invitee_id = new.id;
  delete from public.referral_codes where user_id = new.id;
  delete from public.push_token_seen where user_id = new.id;
  delete from public.user_badges where user_id = new.id;
  delete from public.user_challenges where user_id = new.id;
  delete from public.points_ledger where user_id = new.id;
  delete from public.reward_days where user_id = new.id;
  delete from public.weekly_goals where user_id = new.id;
  delete from public.reward_due where user_id = new.id;
  delete from public.reward_contradictions where user_id = new.id;
  delete from public.progress where user_id = new.id;
  update public.profiles set level = 1 where id = new.id and level <> 1;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.member_locations enable row level security;
alter table public.family_places enable row level security;
revoke all on public.families from anon, authenticated, service_role;
revoke all on public.family_members from anon, authenticated, service_role;
revoke all on public.member_locations from anon, authenticated, service_role;
revoke all on public.family_places from anon, authenticated, service_role;

revoke all on function public.family_members_after_delete() from public, anon, authenticated, service_role;
revoke all on function public.family_new_code() from public, anon, authenticated, service_role;
revoke all on function public.family_check_eligible(uuid) from public, anon, authenticated, service_role;
revoke all on function public.family_of(uuid) from public, anon, authenticated, service_role;
revoke all on function public.family_check_place(text, text, double precision, double precision, int) from public, anon, authenticated, service_role;
revoke all on function public.purge_member_locations() from public, anon, authenticated, service_role;
revoke all on function public.create_family(text) from public, anon, authenticated, service_role;
revoke all on function public.join_family(text) from public, anon, authenticated, service_role;
revoke all on function public.leave_family() from public, anon, authenticated, service_role;
revoke all on function public.remove_family_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.rotate_family_code() from public, anon, authenticated, service_role;
revoke all on function public.set_location_sharing(boolean) from public, anon, authenticated, service_role;
revoke all on function public.post_my_location(double precision, double precision, real, boolean) from public, anon, authenticated, service_role;
revoke all on function public.family_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.save_family_place(uuid, text, text, double precision, double precision, int) from public, anon, authenticated, service_role;
revoke all on function public.delete_family_place(uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_family(text) to authenticated;
grant execute on function public.join_family(text) to authenticated;
grant execute on function public.leave_family() to authenticated;
grant execute on function public.remove_family_member(uuid) to authenticated;
grant execute on function public.rotate_family_code() to authenticated;
grant execute on function public.set_location_sharing(boolean) to authenticated;
grant execute on function public.post_my_location(double precision, double precision, real, boolean) to authenticated;
grant execute on function public.family_snapshot() to authenticated;
grant execute on function public.save_family_place(uuid, text, text, double precision, double precision, int) to authenticated;
grant execute on function public.delete_family_place(uuid) to authenticated;
