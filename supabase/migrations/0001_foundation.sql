-- 0001_foundation: profiles, private profiles, consents, devices, app_config.
--
-- Conventions every later migration follows:
--   * every table ends the migration with RLS enabled; policies are owner-only, written as
--     `col = (select auth.uid())` (one InitPlan per statement, not one call per row), `to authenticated`
--   * default deny: this migration flips postgres's default privileges in public so new tables,
--     sequences and functions grant anon/authenticated nothing; each migration still ends with an
--     explicit revoke-then-grant block, and grants are per column wherever a column is server-owned
--   * SECURITY DEFINER functions are owned by postgres, pin search_path = public, schema-qualify every
--     name, and refuse to run without auth.uid(); they are the only write path for server-derived data
--     (private_profiles.birth_date, profiles.age_band)
--   * server-derived columns are maintained by triggers on their source table so service_role writes
--     stay consistent with RPC writes
--   * extensions live in the extensions schema so public only ever holds our own RLS-guarded tables

-- default deny for everything postgres creates in public from here on (Supabase's stock default
-- privileges hand anon and authenticated full DML/EXECUTE on every new object)
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- functions also carry Postgres's hardwired EXECUTE-to-PUBLIC default, which a schema-scoped entry cannot
-- remove (schema entries merge additively onto the global default): revoke it globally for functions
-- postgres creates, and restore the stock contract only in extensions (extension objects themselves are
-- installed as supabase_admin and are unaffected)
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema extensions grant execute on functions to public;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

-- helper: age band derived from a birth date (stable, not immutable: it reads current_date)
create or replace function public.derive_age_band(birth_date date)
returns text language sql stable set search_path = public as $$
  select case
    when birth_date is null then 'unknown'
    when birth_date > (current_date - interval '13 years') then 'u13'
    when birth_date > (current_date - interval '18 years') then '13_17'
    else '18_plus' end
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  avatar_path text,
  age_band text not null default 'unknown' check (age_band in ('unknown','u13','13_17','18_plus')),
  driving_stage text not null default 'unknown' check (driving_stage in ('unknown','permit','new','experienced')),
  units text not null default 'mph' check (units in ('mph','kmh')),
  locale text not null default 'en-US',
  profile_visibility text not null default 'private' check (profile_visibility in ('private','friends')),
  level int not null default 1,
  flags jsonb not null default '{}'::jsonb check (jsonb_typeof(flags) = 'object' and pg_column_size(flags) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.private_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birth_date date,
  guardian_link_status text not null default 'none' check (guardian_link_status in ('none','pending','linked','declined')),
  guardian_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the on delete set null cascade from auth.users walks this FK
create index private_profiles_guardian_user_id_idx on public.private_profiles (guardian_user_id) where guardian_user_id is not null;

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('tos','privacy','location','background_location','motion','camera','notifications','guardian_link','analytics')),
  version text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  actor text not null default 'self'
);
-- every policy-scoped read of consents filters on user_id
create index consents_user_id_idx on public.consents (user_id, granted_at desc);

create table public.devices (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios','android')),
  model text, os_version text, app_version text,
  push_token text,
  permissions jsonb not null default '{}'::jsonb,
  capability_tier text not null default 'unknown',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table public.app_config (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger private_profiles_touch before update on public.private_profiles for each row execute function public.touch_updated_at();

-- age band follows birth_date whichever path writes it (rpc, service_role, a future guardian flow)
create or replace function public.sync_age_band() returns trigger
language plpgsql set search_path = public as $$
declare
  v_band text := public.derive_age_band(new.birth_date);
begin
  update public.profiles set age_band = v_band where id = new.user_id and age_band is distinct from v_band;
  return new;
end $$;
create trigger private_profiles_age_band
  after insert or update of birth_date on public.private_profiles
  for each row execute function public.sync_age_band();

-- new user bootstrap (fires as supabase_auth_admin, which has no grants on our tables: definer is required).
-- Signup metadata is client-chosen: strip control, bidi and zero-width characters, trim, cap at 40 so the
-- CHECK on profiles.display_name can never fail inside the signup transaction.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  v_name := left(btrim(regexp_replace(
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    '[[:cntrl:]​-‏‪-‮⁦-⁩]', '', 'g')), 40);
  insert into public.profiles (id, display_name) values (new.id, v_name);
  insert into public.private_profiles (user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- birth date via rpc: validated, write-once for the client (corrections are a support/guardian flow),
-- never a silent no-op. The band itself is derived by private_profiles_age_band.
create or replace function public.set_birth_date(p_birth_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_existing date;
begin
  if v_uid is null then
    raise exception 'set_birth_date requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_birth_date is null or p_birth_date > current_date or p_birth_date < current_date - interval '120 years' then
    raise exception 'birth_date must be a date between 120 years ago and today' using errcode = 'check_violation';
  end if;
  select birth_date into v_existing from public.private_profiles where user_id = v_uid for update;
  if not found then
    raise exception 'no private profile for user' using errcode = 'no_data_found';
  end if;
  if v_existing is not null then
    raise exception 'birth date already set' using errcode = 'insufficient_privilege';
  end if;
  update public.private_profiles set birth_date = p_birth_date where user_id = v_uid;
end $$;

-- function grants: only client-callable RPCs are executable by authenticated; anon gets nothing.
-- Trigger functions need no caller privilege (execute is checked at create trigger time only).
revoke all on function public.derive_age_band(date) from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.sync_age_band() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_birth_date(date) from public, anon, authenticated;
grant execute on function public.derive_age_band(date) to authenticated;
grant execute on function public.set_birth_date(date) to authenticated;

-- RLS: default deny, owner only
alter table public.profiles enable row level security;
alter table public.private_profiles enable row level security;
alter table public.consents enable row level security;
alter table public.devices enable row level security;
alter table public.app_config enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
-- which columns a client may update is a column-level grant below; the policy only scopes rows
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy private_select_own on public.private_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy consents_select_own on public.consents for select to authenticated
  using (user_id = (select auth.uid()));
-- guardian_link is the parental-consent record: server-only
create policy consents_insert_own on public.consents for insert to authenticated
  with check (user_id = (select auth.uid()) and type <> 'guardian_link');
create policy devices_all_own on public.devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy app_config_public on public.app_config for select to anon, authenticated
  using (is_public);

-- lock down grants: no anon/authenticated access beyond RLS-governed DML, per column where any
-- column is server-owned (profiles: id, age_band, level, created_at, updated_at; consents: id, actor,
-- granted_at, revoked_at)
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_path, driving_stage, units, locale, profile_visibility, flags) on public.profiles to authenticated;
grant select on public.private_profiles to authenticated;
grant select on public.consents to authenticated;
grant insert (user_id, type, version) on public.consents to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select on public.app_config to anon, authenticated;
