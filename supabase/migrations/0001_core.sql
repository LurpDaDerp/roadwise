-- 0001_core: default-deny posture, extensions, the private schema, profiles, consents, devices,
-- device league claims, progress, rate limits, app_config, the shared helpers, and the account
-- RPCs (username, onboarding, profile, device registration).
--
-- Conventions (.agent/backend-conventions.md, v3 subset):
--   * every table: RLS on; owner-only policies written `col = (select auth.uid())`, `to authenticated`;
--     explicit revoke-then-grant per table; per-column grants wherever a column is server-owned
--   * SECURITY DEFINER functions: owned by postgres, `set search_path = public`, every name
--     schema-qualified, `auth.uid()` guard first, fixed error codes (22023 bad input, 42501 not
--     allowed, P0002 not found) with fixed messages
--   * the `private` schema holds what only the edge functions (direct connection as postgres, or
--     the service role) may call; the Data API never exposes it
--   * teen safety: nothing about a user reaches another user except through a definer RPC that
--     checks the relationship and blocks (0005); usernames are the only identity

-- default deny for everything postgres creates in public from here on
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema extensions grant execute on functions to public;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- private: server-only functions (edge functions over a direct connection, or service_role)
-- ---------------------------------------------------------------------------
create schema private;
revoke all on schema private from public;
grant usage on schema private to service_role;
alter default privileges for role postgres in schema private revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private grant execute on functions to service_role;

-- the extension schemas: nothing for the API roles
revoke usage on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
revoke usage on schema cron from public, anon, authenticated;
revoke all on all functions in schema cron from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.require_service_role(p_fn text) returns void
language plpgsql stable set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception '% requires the service role', p_fn using errcode = 'insufficient_privilege';
  end if;
end $$;

-- an IANA zone the server knows (the posix/ and right/ copies are refused)
create or replace function private.is_known_tz(p_tz text) returns boolean
language sql stable set search_path = public as $$
  select p_tz is not null
    and char_length(p_tz) between 1 and 64
    and p_tz ~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$'
    and p_tz !~ '^(posix|right)/'
    and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz)
$$;

-- league week (plan decision 11): ISO week of the America/New_York local date, 'IYYY-Www'
create or replace function private.league_week(p_at timestamptz) returns text
language sql immutable set search_path = public as $$
  select to_char((p_at at time zone 'America/New_York')::date, 'IYYY-"W"IW')
$$;

-- Monday 00:00 New York of the week a moment falls in, and the next Monday 00:00
create or replace function private.week_start(p_at timestamptz) returns timestamptz
language sql immutable set search_path = public as $$
  select (((p_at at time zone 'America/New_York')::date
           - (extract(isodow from (p_at at time zone 'America/New_York')::date)::int - 1))::timestamp
          at time zone 'America/New_York')
$$;
create or replace function private.week_end(p_at timestamptz) returns timestamptz
language sql immutable set search_path = public as $$
  select (((p_at at time zone 'America/New_York')::date
           - (extract(isodow from (p_at at time zone 'America/New_York')::date)::int - 1) + 7)::timestamp
          at time zone 'America/New_York')
$$;

-- the Monday 00:00 New York that ends a week key ('IYYY-Www'): Jan 4 is always in ISO week 1
create or replace function private.week_key_end(p_week text) returns timestamptz
language sql immutable set search_path = public as $$
  select ((make_date(substr(p_week, 1, 4)::int, 1, 4)
           - (extract(isodow from make_date(substr(p_week, 1, 4)::int, 1, 4))::int - 1)
           + 7 * (substr(p_week, 7, 2)::int - 1) + 7)::timestamp at time zone 'America/New_York')
$$;

-- level n is reached at 250 * n(n-1)/2 lifetime points, capped at 50 (plan §2 levelFor)
create or replace function private.level_for(p_lifetime int) returns int
language sql immutable set search_path = public as $$
  select greatest(1, least(50, floor((1 + sqrt(1 + 8 * greatest(p_lifetime, 0) / 250.0)) / 2)::int))
$$;
create or replace function private.level_floor(p_level int) returns int
language sql immutable set search_path = public as $$
  select 250 * p_level * (p_level - 1) / 2
$$;

-- plan §2 safetyRating: null below 1 mile of data, ranked at 25 miles
create or replace function private.safety_rating(p_penalty numeric, p_miles numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when coalesce(p_miles, 0) <= 0 then null
    else round(greatest(0, least(100, 100 - (p_penalty / p_miles * 100) / 10)), 1) end
$$;

-- the profanity filter: lower-case, digits-for-letters, separators stripped, a bounded word list.
-- Substring words are unambiguous; the exact list holds short words that are common inside clean
-- words (class, document, analysis), so they match only as the whole name.
create or replace function private.is_clean_name(p_name text) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  v text;
  v_sub text[] := array['fuck','shit','cunt','nigg','fagg','faggot','bitch','dick','cock','pussy','whore','slut','rape',
    'rapist','nazi','hitler','kike','spic','chink','retard','wank','twat','jizz','porn','penis','vagina','boob','tits',
    'blowjob','handjob','dildo','orgasm','cumshot','pedo','molest','kkk','nigga','negro','tranny','dyke','wetback',
    'gook','raghead','towelhead','beaner','coon','heil','isis'];
  v_exact text[] := array['ass','cum','anal','hell','damn','sex','tit','hoe','kys','suck','fag','nig','ho','butt','poop',
    'pee','crap','piss','nude','naked','drug','meth','weed','cocaine','heroin','kill','die','death','suicide'];
  w text;
begin
  if p_name is null then
    return false;
  end if;
  v := lower(p_name);
  v := translate(v, '0134578@$!|', 'oieastbasii');
  v := regexp_replace(v, '[^a-z]', '', 'g');
  if v = '' then
    return true;
  end if;
  foreach w in array v_sub loop
    if position(w in v) > 0 then
      return false;
    end if;
  end loop;
  -- also check the exact list against the whole name and against the dotted/underscored parts
  foreach w in array v_exact loop
    if v = w then
      return false;
    end if;
  end loop;
  foreach w in array v_exact loop
    if exists (select 1 from regexp_split_to_table(lower(translate(p_name, '0134578@$', 'oieastbas')), '[^a-z]+') part where part = w) then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext unique check (char_length(username::text) between 3 and 20 and username::text ~ '^[a-z0-9_]+$'),
  license_stage text check (license_stage in ('permit', 'intermediate', 'full')),
  units text not null default 'mi' check (units in ('mi', 'km')),
  state char(2) check (state ~ '^[A-Z]{2}$'),
  heatmap_visibility text not null default 'only_me' check (heatmap_visibility in ('only_me', 'clan', 'friends')),
  league_eligible boolean not null default false,
  flagged boolean not null default false,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the global board's optional state filter
create index profiles_state_idx on public.profiles (state) where state is not null;
-- search_users' prefix match (`username::text like 'abc%'`)
create index profiles_username_text_idx on public.profiles ((username::text) text_pattern_ops);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('terms_13_plus')),
  version text not null check (char_length(version) between 1 and 32),
  created_at timestamptz not null default now()
);
create index consents_user_idx on public.consents (user_id, created_at desc);

-- registered devices: server-only (never readable by anyone through the API)
create table public.devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 128),
  platform text not null check (platform in ('ios', 'android')),
  push_token text check (push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- the first account to register a device claims it; league_eligible = owns at least one claim
create table public.device_league_claims (
  device_id text primary key check (char_length(device_id) between 1 and 128),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index device_league_claims_user_idx on public.device_league_claims (user_id);

-- the only stateful row (plan decision 8). last_end_* are server-only: the end of the latest
-- drive, kept only for the merge check, never granted to any API role.
create table public.progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points int not null default 0,
  lifetime int not null default 0 check (lifetime >= 0),
  level int not null default 1 check (level between 1 and 50),
  streak int not null default 0 check (streak >= 0),
  at_risk boolean not null default false,
  freezes int not null default 2 check (freezes between 0 and 3),
  freezes_granted_at timestamptz not null default now(),
  clean_run int not null default 0 check (clean_run >= 0),
  freeze_progress int not null default 0 check (freeze_progress between 0 and 2),
  phone_free_run int not null default 0 check (phone_free_run >= 0),
  safety_rating numeric(4,1) check (safety_rating between 0 and 100),
  ranked boolean not null default false,
  miles_30d numeric(8,2) not null default 0 check (miles_30d >= 0),
  clean_miles_30d numeric(8,2) not null default 0 check (clean_miles_30d >= 0),
  rating_penalty_30d numeric(10,2) not null default 0 check (rating_penalty_30d >= 0),
  rating_updated_at timestamptz,
  league_tier text not null default 'bronze' check (league_tier in ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  last_end_lat double precision check (last_end_lat between -90 and 90),
  last_end_lng double precision check (last_end_lng between -180 and 180),
  last_end_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the global board: top 100 by rating, ties by clean miles, among the eligible (>= 100 mi / 30 d)
create index progress_global_board_idx on public.progress (safety_rating desc, clean_miles_30d desc, user_id)
  where miles_30d >= 100 and safety_rating is not null;

create table public.rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  window_start timestamptz not null default now(),
  count int not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.app_config (
  key text primary key check (char_length(key) between 1 and 64),
  value jsonb not null check (pg_column_size(value) <= 8192),
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger devices_touch before update on public.devices for each row execute function public.touch_updated_at();
create trigger progress_touch before update on public.progress for each row execute function public.touch_updated_at();
create trigger rate_limits_touch before update on public.rate_limits for each row execute function public.touch_updated_at();
create trigger app_config_touch before update on public.app_config for each row execute function public.touch_updated_at();

-- new user bootstrap (fires as supabase_auth_admin: definer). Nothing from signup metadata is
-- copied: usernames are chosen in onboarding and real names are never stored.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id);
  insert into public.progress (user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- rate limits: one take from a per-user budget; false when it is spent
-- ---------------------------------------------------------------------------
create or replace function private.take_rate_limit(p_user uuid, p_key text, p_window interval, p_max int) returns boolean
language plpgsql volatile set search_path = public as $$
declare
  v_start timestamptz;
  v_count int;
begin
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'key must be a rate-limit key' using errcode = 'invalid_parameter_value';
  end if;
  if p_window is null or p_window < interval '1 second' or p_window > interval '31 days' then
    raise exception 'window must be between 1 second and 31 days' using errcode = 'invalid_parameter_value';
  end if;
  if p_max is null or p_max < 1 or p_max > 100000 then
    raise exception 'max must be between 1 and 100000' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.rate_limits (user_id, key, window_start, count) values (p_user, p_key, now(), 0)
    on conflict (user_id, key) do nothing;
  select window_start, count into v_start, v_count
    from public.rate_limits where user_id = p_user and key = p_key for update;
  if v_start + p_window <= now() then
    v_start := now();
    v_count := 0;
  end if;
  if v_count >= p_max then
    update public.rate_limits set window_start = v_start, count = v_count where user_id = p_user and key = p_key;
    return false;
  end if;
  update public.rate_limits set window_start = v_start, count = v_count + 1 where user_id = p_user and key = p_key;
  return true;
end $$;

-- the service-role wrapper the speed-limits edge function calls through the Data API
create or replace function public.take_rate_limit(p_user uuid, p_key text, p_window interval, p_max int) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_service_role('take_rate_limit');
  return private.take_rate_limit(p_user, p_key, p_window, p_max);
end $$;

-- a definer RPC's own budget check: raises the fixed 'too many requests' refusal
create or replace function private.require_rate_limit(p_user uuid, p_key text, p_window interval, p_max int) returns void
language plpgsql volatile set search_path = public as $$
begin
  if not private.take_rate_limit(p_user, p_key, p_window, p_max) then
    raise exception 'too many requests' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- freezes: 2 every 30 days since freezes_granted_at, cap 3, applied lazily (plan decision 12)
-- ---------------------------------------------------------------------------
create or replace function private.apply_freeze_grant(p_user uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_periods int;
begin
  select floor(extract(epoch from (now() - freezes_granted_at)) / (30 * 86400))::int into v_periods
    from public.progress where user_id = p_user for update;
  if v_periods is null or v_periods < 1 then
    return;
  end if;
  update public.progress
    set freezes = least(3, freezes + 2 * v_periods),
        freezes_granted_at = freezes_granted_at + make_interval(days => 30 * v_periods)
    where user_id = p_user;
end $$;

-- ---------------------------------------------------------------------------
-- username
-- ---------------------------------------------------------------------------
create or replace function private.username_problem(p text) returns text
language plpgsql stable set search_path = public as $$
declare
  v text := lower(coalesce(p, ''));
begin
  if char_length(v) < 3 or char_length(v) > 20 then
    return 'length';
  end if;
  if v !~ '^[a-z0-9_]+$' then
    return 'characters';
  end if;
  if v in ('admin', 'administrator', 'roadwise', 'support', 'moderator', 'mod', 'system', 'null', 'undefined', 'staff', 'official', 'help') then
    return 'reserved';
  end if;
  if not private.is_clean_name(v) then
    return 'not_allowed';
  end if;
  if exists (select 1 from public.profiles where username operator(extensions.=) v::extensions.citext) then
    return 'taken';
  end if;
  return null;
end $$;

-- check_username(p) -> { available, reason }: rate-limited 30/min (an enumeration oracle)
create or replace function public.check_username(p text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  if v_uid is null then
    raise exception 'check_username requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p is null or char_length(p) > 64 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'check_username', interval '1 minute', 30);
  v_problem := private.username_problem(p);
  return jsonb_build_object('available', v_problem is null, 'reason', v_problem);
end $$;

-- claim_username(p): lower-cased, validated; once set a username can be changed only once a day
create or replace function public.claim_username(p text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_current extensions.citext;
begin
  if v_uid is null then
    raise exception 'claim_username requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p is null or char_length(p) > 64 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'claim_username', interval '1 day', 5);
  select username into v_current from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
  if v_current is not null and lower(v_current::text) = lower(p) then
    return;
  end if;
  v_problem := private.username_problem(p);
  if v_problem = 'taken' then
    raise exception 'username is taken' using errcode = 'unique_violation';
  elsif v_problem is not null then
    raise exception 'username must be 3 to 20 letters, digits or underscores' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set username = lower(p)::extensions.citext where id = v_uid;
end $$;

-- accept_terms(p_version): records the 13+ and terms attestation (append-only)
create or replace function public.accept_terms(p_version text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'accept_terms requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_version is null or p_version !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception 'version must be 1 to 32 characters' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.consents where user_id = v_uid and kind = 'terms_13_plus' and version = p_version) then
    insert into public.consents (user_id, kind, version) values (v_uid, 'terms_13_plus', p_version);
  end if;
end $$;

-- complete_onboarding(p_license_stage, p_terms_version): needs a username and the consent
create or replace function public.complete_onboarding(p_license_stage text, p_terms_version text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_username extensions.citext;
begin
  if v_uid is null then
    raise exception 'complete_onboarding requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_license_stage is null or p_license_stage not in ('permit', 'intermediate', 'full') then
    raise exception 'license_stage must be permit, intermediate or full' using errcode = 'invalid_parameter_value';
  end if;
  perform public.accept_terms(p_terms_version);
  select username into v_username from public.profiles where id = v_uid for update;
  if v_username is null then
    raise exception 'pick a username first' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set license_stage = p_license_stage, onboarded_at = coalesce(onboarded_at, now()) where id = v_uid;
end $$;

-- update_profile: each argument null = unchanged
create or replace function public.update_profile(p_license_stage text default null, p_units text default null, p_state text default null, p_heatmap_visibility text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'update_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_license_stage is not null and p_license_stage not in ('permit', 'intermediate', 'full') then
    raise exception 'license_stage must be permit, intermediate or full' using errcode = 'invalid_parameter_value';
  end if;
  if p_units is not null and p_units not in ('mi', 'km') then
    raise exception 'units must be mi or km' using errcode = 'invalid_parameter_value';
  end if;
  if p_state is not null and p_state <> '' and p_state !~ '^[A-Z]{2}$' then
    raise exception 'state must be a two-letter US state code' using errcode = 'invalid_parameter_value';
  end if;
  if p_heatmap_visibility is not null and p_heatmap_visibility not in ('only_me', 'clan', 'friends') then
    raise exception 'heatmap_visibility must be only_me, clan or friends' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set
    license_stage = coalesce(p_license_stage, license_stage),
    units = coalesce(p_units, units),
    state = case when p_state is null then state when p_state = '' then null else p_state end,
    heatmap_visibility = coalesce(p_heatmap_visibility, heatmap_visibility)
  where id = v_uid;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
end $$;

-- register_device(p_device_id, p_platform, p_push_token) -> { league_eligible }
-- The first account to register a device claims it for leagues (one league-eligible account per
-- device). A later account on the same device still registers (for push) but earns no claim.
-- The id is client-supplied, so this is a speed bump, bounded three ways: at most 10 new ids a
-- day and 10 device rows per account (the oldest seen go), at most 3 claims per account, a claim is
-- released once its claimant has not been seen on that device for 90 days, and an account whose
-- push token just moved from an account that holds a claim on that install earns no claim.
create or replace function public.register_device(p_device_id text, p_platform text, p_push_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_eligible boolean;
  v_known boolean;
  v_token_claimed boolean := false;
  v_released uuid;
begin
  if v_uid is null then
    raise exception 'register_device requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'platform must be ios or android' using errcode = 'invalid_parameter_value';
  end if;
  if p_push_token is not null and p_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid push token' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'register_device', interval '1 hour', 60);
  v_known := exists (select 1 from public.devices d where d.user_id = v_uid and d.device_id = p_device_id);
  if not v_known then
    perform private.require_rate_limit(v_uid, 'register_device_new', interval '1 day', 10);
  end if;
  -- the token's previous holder owns a claim on that install: this account gets none for it
  if p_push_token is not null then
    v_token_claimed := exists (
      select 1 from public.devices d join public.device_league_claims c on c.user_id = d.user_id and c.device_id = d.device_id
      where d.push_token = p_push_token and d.user_id <> v_uid);
  end if;
  insert into public.devices (user_id, device_id, platform, push_token, last_seen_at)
    values (v_uid, p_device_id, p_platform, p_push_token, now())
  on conflict (user_id, device_id) do update
    set platform = excluded.platform,
        push_token = coalesce(excluded.push_token, public.devices.push_token),
        last_seen_at = now();
  -- a token moves with the device: no other account keeps it
  if p_push_token is not null then
    update public.devices set push_token = null where push_token = p_push_token and user_id <> v_uid;
  end if;
  -- at most 10 device rows per account: the least recently seen go
  delete from public.devices d where d.user_id = v_uid and d.device_id in (
    select x.device_id from public.devices x where x.user_id = v_uid order by x.last_seen_at desc, x.device_id offset 10);
  -- a claim whose holder has not been seen on the device for 90 days is released
  delete from public.device_league_claims c
    where c.device_id = p_device_id and c.user_id <> v_uid
      and not exists (select 1 from public.devices d where d.user_id = c.user_id and d.device_id = c.device_id and d.last_seen_at > now() - interval '90 days')
    returning c.user_id into v_released;
  if v_released is not null then
    update public.profiles set league_eligible = exists (select 1 from public.device_league_claims c where c.user_id = v_released) where id = v_released;
  end if;
  if not v_token_claimed and (select count(*) from public.device_league_claims c where c.user_id = v_uid) < 3 then
    insert into public.device_league_claims (device_id, user_id) values (p_device_id, v_uid)
      on conflict (device_id) do nothing;
  end if;
  v_eligible := exists (select 1 from public.device_league_claims c where c.user_id = v_uid);
  update public.profiles set league_eligible = v_eligible where id = v_uid and league_eligible is distinct from v_eligible;
  return jsonb_build_object('league_eligible', v_eligible);
end $$;

-- ---------------------------------------------------------------------------
-- config rows (an operator's value is never overwritten)
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public) values
  ('feature_flags', '{}'::jsonb, true),
  ('min_app_version', '"3.0.0"'::jsonb, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.consents enable row level security;
alter table public.devices enable row level security;
alter table public.device_league_claims enable row level security;
alter table public.progress enable row level security;
alter table public.rate_limits enable row level security;
alter table public.app_config enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy consents_select_own on public.consents for select to authenticated using (user_id = (select auth.uid()));
create policy progress_select_own on public.progress for select to authenticated using (user_id = (select auth.uid()));
create policy app_config_public on public.app_config for select to anon, authenticated using (is_public);

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.consents, public.devices, public.device_league_claims, public.progress,
  public.rate_limits, public.app_config from anon, authenticated;
-- flagged is moderation state: never shown to its owner
grant select (id, username, license_stage, units, state, heatmap_visibility, league_eligible, onboarded_at, created_at, updated_at)
  on public.profiles to authenticated;
grant select on public.consents to authenticated;
grant select (user_id, points, lifetime, level, streak, at_risk, freezes, freezes_granted_at, clean_run, freeze_progress,
  phone_free_run, safety_rating, ranked, miles_30d, clean_miles_30d, rating_updated_at, league_tier, created_at, updated_at)
  on public.progress to authenticated;
grant select on public.app_config to anon, authenticated;

revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.require_service_role(text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.take_rate_limit(uuid, text, interval, int) from public, anon, authenticated;
revoke all on function public.check_username(text) from public, anon, authenticated;
revoke all on function public.claim_username(text) from public, anon, authenticated;
revoke all on function public.accept_terms(text) from public, anon, authenticated;
revoke all on function public.complete_onboarding(text, text) from public, anon, authenticated;
revoke all on function public.update_profile(text, text, text, text) from public, anon, authenticated;
revoke all on function public.register_device(text, text, text) from public, anon, authenticated;
grant execute on function public.take_rate_limit(uuid, text, interval, int) to service_role;
grant execute on function public.check_username(text) to authenticated;
grant execute on function public.claim_username(text) to authenticated;
grant execute on function public.accept_terms(text) to authenticated;
grant execute on function public.complete_onboarding(text, text) to authenticated;
grant execute on function public.update_profile(text, text, text, text) to authenticated;
grant execute on function public.register_device(text, text, text) to authenticated;
