-- 0001_foundation: profiles, private profiles, consents, devices, app_config.
--
-- Conventions every later migration follows:
--   * every table ends the migration with RLS enabled; policies are owner-only and keyed on auth.uid()
--   * grants are explicit: Supabase's default privileges for anon/authenticated are revoked, then only
--     the listed DML is granted back; anon can read nothing but public app_config rows
--   * SECURITY DEFINER functions pin search_path = public and are the only write path for
--     server-derived data (private_profiles, profiles.age_band)
--   * extensions live in the extensions schema so public only ever holds our own RLS-guarded tables

create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

-- helper: age band derived from a birth date (stable, not immutable: it reads current_date)
create or replace function public.derive_age_band(birth_date date)
returns text language sql stable as $$
  select case
    when birth_date is null then 'unknown'
    when birth_date > (current_date - interval '13 years') then 'u13'
    when birth_date > (current_date - interval '18 years') then '13_17'
    else '18_plus' end
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_path text,
  age_band text not null default 'unknown' check (age_band in ('unknown','u13','13_17','18_plus')),
  driving_stage text not null default 'unknown' check (driving_stage in ('unknown','permit','new','experienced')),
  units text not null default 'mph' check (units in ('mph','kmh')),
  locale text not null default 'en-US',
  profile_visibility text not null default 'private' check (profile_visibility in ('private','friends')),
  level int not null default 1,
  flags jsonb not null default '{}'::jsonb,
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

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('tos','privacy','location','background_location','motion','camera','notifications','guardian_link','analytics')),
  version text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  actor text not null default 'self'
);

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
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger private_profiles_touch before update on public.private_profiles for each row execute function public.touch_updated_at();

-- new user bootstrap
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  insert into public.private_profiles (user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- birth date via rpc so the band is always derived server-side
create or replace function public.set_birth_date(p_birth_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.private_profiles set birth_date = p_birth_date where user_id = auth.uid();
  update public.profiles set age_band = public.derive_age_band(p_birth_date) where id = auth.uid();
end $$;

-- function grants: Supabase's default privileges hand execute on every new public function to
-- anon, authenticated and service_role, so strip them and grant back only what clients call.
-- Trigger functions need no caller privilege (execute is checked at create trigger time only).
revoke all on function public.derive_age_band(date) from public, anon;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_birth_date(date) from public, anon;
grant execute on function public.derive_age_band(date) to authenticated;
grant execute on function public.set_birth_date(date) to authenticated;

-- RLS: default deny, owner only
alter table public.profiles enable row level security;
alter table public.private_profiles enable row level security;
alter table public.consents enable row level security;
alter table public.devices enable row level security;
alter table public.app_config enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
-- with check pins age_band to its current value: only set_birth_date (security definer, run as the
-- table owner, which bypasses RLS) can move it
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and age_band = (select p.age_band from public.profiles p where p.id = auth.uid()));
create policy private_select_own on public.private_profiles for select to authenticated using (user_id = auth.uid());
create policy consents_select_own on public.consents for select to authenticated using (user_id = auth.uid());
create policy consents_insert_own on public.consents for insert to authenticated with check (user_id = auth.uid());
create policy devices_all_own on public.devices for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy app_config_public on public.app_config for select to anon, authenticated using (is_public);

-- lock down grants: no anon/authenticated access beyond RLS-governed DML
revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.private_profiles to authenticated;
grant select, insert on public.consents to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select on public.app_config to anon, authenticated;
