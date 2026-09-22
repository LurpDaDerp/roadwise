-- 0006_onboarding: driving stages, guardian invites (dark behind a flag), the age policy, the hourly
-- age-band re-derivation on the user's local date, and the under-13 minimisation.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * profiles.driving_stage CHECK: unknown, permit, new, developing, experienced, non_driver. The
--     0001 constraint is dropped by the name pg_constraint gives it and re-added under the same name.
--   * public.invites (#1, #9, #10, #11): guardian/family/referral invite codes, stored only as
--     sha256(code). RLS on, no policies, no anon/authenticated grants: every read and write goes
--     through definer RPCs (M6 adds redemption and the family FK).
--   * public.create_guardian_invite() (#5, #6): client RPC, definer. Dark server-side while
--     app_config.feature_flags.guardian_invites is not true (ruling I6); only a 13_17 caller; the
--     caller's private profile locked for update; at most 10 in any rolling 24 h, counted from
--     invites under the caller's `invite_day` rate_limits row (the mutex, like 0002's dispute_7d);
--     earlier live guardian invites revoked; a 6-character code from a 31-letter alphabet by
--     rejection sampling over gen_random_bytes; returns { code, expires_at }.
--   * public.guardian_link_state() (#5): client RPC, definer read of the caller's own link.
--   * public.is_underage(uuid): invoker helper for the storage policy; under RLS it can only ever
--     answer about the caller's own row (false for anyone else), so it is no oracle.
--   * public.refuse_underage_writes() (#7, invoker trigger): a u13 account inserts no device and no
--     consent (any role), and a client (role authenticated) cannot update a u13 profile. The
--     minimisation, the cron pass and a service-role correction run as other roles and pass.
--   * storage_refuse_underage: restrictive insert policy on storage.objects, every bucket.
--   * public.enforce_trip_age_policy() (#7, invoker trigger, runs as postgres inside apply_trip): u13
--     refused; with minor_consent_mode = guardian_consent_required, 13_17 without a linked guardian
--     and unknown are refused. apply_trip's 42501 reaches the device as a terminal 403, so a drive
--     refused now stays refused after a later link: one more reason the mode stays off until M6.
--   * public.minimise_underage_account() (definer trigger): AFTER UPDATE OF age_band on profiles,
--     when the band becomes u13. Deletes the devices and consents, clears the profile, strips the
--     name and picture keys from auth.users.raw_user_meta_data and every auth.identities row. What
--     remains: the auth identity (id, email, provider link), birth_date and age_band. Definer
--     because the invoking role cannot write auth (#3: auth is written only by this function and
--     the two rescrub triggers, owned by postgres, which holds the grant). Convention #5's caller
--     check, adapted for a trigger: it runs only for the account owner's own JWT (set_birth_date),
--     the service role (a support correction), or a session with no JWT user whose login is
--     postgres (the pg_cron pass, an operator); anything else, notably another user's JWT reaching
--     it through some future definer, raises 42501.
--   * public.rescrub_underage_metadata() / public.rescrub_underage_identity() (definer triggers,
--     ruling N-C1): GoTrue itself fires these, as supabase_auth_admin with no JWT, inside every
--     OAuth sign-in that rewrites the metadata, for every user. So, unlike every other definer here,
--     they NEVER raise (any error is caught and logged as a warning carrying only its SQLSTATE) and
--     carry no caller check; they fire only when a stripped key is present (the WHEN clause), skip a
--     nested fire (pg_trigger_depth, the re-fire guard), return at once unless the user is u13, and
--     can only remove keys from the row that fired them. The identities twin also fires on INSERT:
--     linking a second provider inserts an identity carrying the name.
--   * public.underage_object_keys(int) (#12 of the security rules: service-role guard first):
--     { bucket, name } of storage objects under a u13 user's prefix, for M8's retention job. SQL
--     cannot delete object bytes; the child's own device removes them through the Storage API.
--   * public.user_local_date(uuid, timestamptz) and public.derive_age_band_on(date, date) (ruling
--     N-m5): the band turns over on the user's local date, in the zone of their latest live drive
--     (the most recent zone their device reported), UTC only when none is known. 0007 may replace
--     user_local_date to prefer notification_prefs.tz; its signature is the contract.
--   * public.sync_age_band() replaced (0001's trigger on private_profiles.birth_date): derives on
--     the local date too, so the birth-date write and the hourly pass can never disagree and flip a
--     band back and forth around a birthday.
--   * public.rederive_age_bands() (ruling I4): invoker, run hourly by pg_cron as postgres; no API
--     role may execute it. A teen who turns 18 becomes 18_plus; a u13 child who turns 13 becomes
--     13_17 and is released into onboarding with the already-minimised, empty profile.
--   * cron job `age-band-rederive` at minute 15 of every hour (ruling T1): each user rolls over
--     within the hour after their own local midnight, whatever their zone, never before it. The
--     pass is idempotent (it writes only bands that differ), so every other run of the day changes
--     nothing. The pg_cron extension is created here when absent (it installs into pg_catalog and
--     its own cron schema, the one exception to #14).
--   * app_config rows, `on conflict (key) do nothing` (security rule 4): minor_consent_mode,
--     onboarding, legal_urls, store_urls, oem_battery_guides, min_app_version, feature_flags; and
--     guardian_invites merged into an existing feature_flags row only when the key is absent.
--
-- Nothing from 0001-0005 is edited; sync_age_band is replaced with `create or replace`, which keeps
-- its owner, grants and trigger.

-- ---------------------------------------------------------------------------
-- driving stages
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select conname into strict v_name from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%driving_stage%';
  execute format('alter table public.profiles drop constraint %I', v_name);
end $$;
alter table public.profiles add constraint profiles_driving_stage_check
  check (driving_stage in ('unknown', 'permit', 'new', 'developing', 'experienced', 'non_driver'));

-- ---------------------------------------------------------------------------
-- invites
-- ---------------------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  -- sha256 of the code; the code itself is shown once to the issuer and stored nowhere
  code_hash bytea not null unique check (octet_length(code_hash) = 32),
  type text not null check (type in ('family', 'guardian', 'referral')),
  issuer_id uuid not null references auth.users(id) on delete cascade,
  -- the family FK arrives with M6's families table
  family_id uuid null,
  role text null check (role in ('organizer', 'guardian', 'adult', 'teen')),
  expires_at timestamptz not null,
  max_uses int not null default 1 check (max_uses between 1 and 100),
  uses int not null default 0 check (uses >= 0 and uses <= max_uses),
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the issuer's history, the rolling rate-limit count and the on delete cascade from auth.users
create index invites_issuer_type_created_idx on public.invites (issuer_id, type, created_at desc);
create trigger invites_touch before update on public.invites for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- guardian invites: issue, and read the caller's link state
-- ---------------------------------------------------------------------------
create or replace function public.create_guardian_invite() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_band text;
  v_status text;
  v_recent int;
  v_code text;
  v_bytes bytea;
  v_b int;
  v_expires timestamptz := now() + interval '7 days';
  v_retries int := 0;
begin
  if v_uid is null then
    raise exception 'create_guardian_invite requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  -- dark until M6 can redeem a code: a parent must never receive one they cannot use
  if not coalesce((select (value -> 'guardian_invites') = 'true'::jsonb from public.app_config where key = 'feature_flags'), false) then
    raise exception 'guardian invites are not available yet' using errcode = 'insufficient_privilege';
  end if;
  select age_band into v_band from public.profiles where id = v_uid;
  if v_band is distinct from '13_17' then
    raise exception 'guardian invites are for drivers under 18' using errcode = 'insufficient_privilege';
  end if;

  select guardian_link_status into v_status from public.private_profiles where user_id = v_uid for update;
  if not found then
    raise exception 'no private profile for user' using errcode = 'no_data_found';
  end if;
  if v_status = 'linked' then
    raise exception 'guardian already linked' using errcode = 'invalid_parameter_value';
  end if;

  -- at most 10 in any rolling 24 hours; the rate_limits row is the per-user mutex around the count
  insert into public.rate_limits (user_id, key) values (v_uid, 'invite_day') on conflict (user_id, key) do nothing;
  perform 1 from public.rate_limits where user_id = v_uid and key = 'invite_day' for update;
  select count(*) into v_recent from public.invites
    where issuer_id = v_uid and type = 'guardian' and created_at > now() - interval '24 hours';
  if v_recent >= 10 then
    raise exception 'invite limit reached' using errcode = 'insufficient_privilege';
  end if;
  update public.rate_limits set window_start = now() - interval '24 hours', count = v_recent + 1
    where user_id = v_uid and key = 'invite_day';

  -- one live guardian invite at a time
  update public.invites set revoked = true where issuer_id = v_uid and type = 'guardian' and not revoked;

  loop
    -- rejection sampling: bytes 0..247 map evenly onto the 31 letters, 248..255 are discarded
    v_code := '';
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
    begin
      insert into public.invites (code_hash, type, issuer_id, role, expires_at, max_uses)
        values (extensions.digest(v_code, 'sha256'), 'guardian', v_uid, 'guardian', v_expires, 1);
      exit;
    exception when unique_violation then
      v_retries := v_retries + 1;
      if v_retries > 5 then
        raise;
      end if;
    end;
  end loop;

  update public.private_profiles set guardian_link_status = 'pending' where user_id = v_uid;
  return jsonb_build_object('code', v_code, 'expires_at', v_expires);
end $$;

-- `expired`: stored pending, and no live guardian invite that has not passed its expiry (a pending
-- link with nothing redeemable behind it is not honestly pending)
create or replace function public.guardian_link_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'guardian_link_state requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select guardian_link_status into v_status from public.private_profiles where user_id = v_uid;
  if not found then
    raise exception 'no private profile for user' using errcode = 'no_data_found';
  end if;
  if v_status <> 'pending' then
    return jsonb_build_object('status', v_status, 'expires_at', null);
  end if;
  select expires_at into v_expires from public.invites
    where issuer_id = v_uid and type = 'guardian' and not revoked
    order by created_at desc limit 1;
  if v_expires is null or v_expires <= now() then
    return jsonb_build_object('status', 'expired', 'expires_at', v_expires);
  end if;
  return jsonb_build_object('status', 'pending', 'expires_at', v_expires);
end $$;

-- ---------------------------------------------------------------------------
-- age policy: the local date, the band, the refusals
-- ---------------------------------------------------------------------------
-- 0001's derive_age_band rule on an explicit date
create or replace function public.derive_age_band_on(p_birth_date date, p_as_of date) returns text
language sql immutable set search_path = public as $$
  select case
    when p_birth_date is null then 'unknown'
    when p_birth_date > (p_as_of - interval '13 years') then 'u13'
    when p_birth_date > (p_as_of - interval '18 years') then '13_17'
    else '18_plus' end
$$;

-- the user's calendar date at p_at: in the zone of their latest live drive, else UTC. A zone the
-- server no longer knows falls back to UTC rather than failing the hourly pass for everyone.
create or replace function public.user_local_date(p_user uuid, p_at timestamptz default now()) returns date
language plpgsql stable set search_path = public as $$
declare
  v_tz text;
begin
  select t.tz into v_tz from public.trips t
    where t.user_id = p_user and t.deleted_at is null
    order by t.started_at desc limit 1;
  if v_tz is null then
    return (p_at at time zone 'UTC')::date;
  end if;
  begin
    return (p_at at time zone v_tz)::date;
  exception when invalid_parameter_value then
    return (p_at at time zone 'UTC')::date;
  end;
end $$;

-- 0001's trigger, now on the local date (the trips lookup is skipped while there is no birth date)
create or replace function public.sync_age_band() returns trigger
language plpgsql set search_path = public as $$
declare
  v_band text := case when new.birth_date is null then 'unknown'
                      else public.derive_age_band_on(new.birth_date, public.user_local_date(new.user_id)) end;
begin
  update public.profiles set age_band = v_band where id = new.user_id and age_band is distinct from v_band;
  return new;
end $$;

-- hourly, by pg_cron as postgres
create or replace function public.rederive_age_bands() returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  with d as (
    select pp.user_id, public.derive_age_band_on(pp.birth_date, public.user_local_date(pp.user_id)) as band
    from public.private_profiles pp
    where pp.birth_date is not null
  )
  update public.profiles p set age_band = d.band
    from d
    where d.user_id = p.id and p.age_band is distinct from d.band;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.is_underage(p_user uuid) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select p.age_band = 'u13' from public.profiles p where p.id = p_user), false)
$$;

create or replace function public.refuse_underage_writes() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'profiles' then
    -- a direct client write only; the definer minimisation, the cron pass and the service role pass
    if current_user = 'authenticated' and old.age_band = 'u13' then
      raise exception 'account not eligible' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if exists (select 1 from public.profiles p where p.id = new.user_id and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger devices_refuse_underage before insert on public.devices
  for each row execute function public.refuse_underage_writes();
create trigger consents_refuse_underage before insert on public.consents
  for each row execute function public.refuse_underage_writes();
create trigger profiles_refuse_underage before update on public.profiles
  for each row execute function public.refuse_underage_writes();

create or replace function public.enforce_trip_age_policy() returns trigger
language plpgsql set search_path = public as $$
declare
  v_band text;
  v_link text;
begin
  select age_band into v_band from public.profiles where id = new.user_id;
  if v_band = 'u13' then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if (select value from public.app_config where key = 'minor_consent_mode') = '"guardian_consent_required"'::jsonb then
    select guardian_link_status into v_link from public.private_profiles where user_id = new.user_id;
    if v_band is null or v_band = 'unknown' or (v_band = '13_17' and v_link is distinct from 'linked') then
      raise exception 'guardian consent required' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger trips_age_policy before insert on public.trips
  for each row execute function public.enforce_trip_age_policy();

create policy storage_refuse_underage on storage.objects as restrictive for insert to authenticated
  with check (not public.is_underage((select auth.uid())));

-- ---------------------------------------------------------------------------
-- under-13 minimisation
-- ---------------------------------------------------------------------------
create or replace function public.minimise_underage_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_keys constant text[] := array['full_name', 'name', 'display_name', 'avatar_url', 'picture', 'given_name', 'family_name'];
begin
  -- every arm is null-safe: a null auth.uid() must never turn the whole test into null (no raise)
  if not (coalesce(auth.uid() = new.id, false)
          or coalesce(auth.role() = 'service_role', false)
          or (auth.uid() is null and session_user = 'postgres')) then
    raise exception 'minimise_underage_account requires the account owner or the service role' using errcode = 'insufficient_privilege';
  end if;
  delete from public.devices where user_id = new.id;
  delete from public.consents where user_id = new.id;
  update public.profiles
    set display_name = '', avatar_path = null, flags = '{}'::jsonb, driving_stage = 'unknown'
    where id = new.id;
  update auth.users set raw_user_meta_data = raw_user_meta_data - v_keys
    where id = new.id and raw_user_meta_data ?| v_keys;
  update auth.identities set identity_data = identity_data - v_keys
    where user_id = new.id and identity_data ?| v_keys;
  return null;
end $$;
create trigger profiles_minimise_underage after update of age_band on public.profiles
  for each row when (new.age_band = 'u13' and old.age_band is distinct from 'u13')
  execute function public.minimise_underage_account();

-- N-C1: runs inside GoTrue's sign-in for every user. Never raises; see the header.
create or replace function public.rescrub_underage_metadata() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_keys constant text[] := array['full_name', 'name', 'display_name', 'avatar_url', 'picture', 'given_name', 'family_name'];
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  begin
    if not exists (select 1 from public.profiles p where p.id = new.id and p.age_band = 'u13') then
      return null;
    end if;
    update auth.users set raw_user_meta_data = raw_user_meta_data - v_keys
      where id = new.id and raw_user_meta_data ?| v_keys;
  exception when others then
    raise warning 'rescrub_underage_metadata skipped (SQLSTATE %)', sqlstate;
  end;
  return null;
end $$;

create or replace function public.rescrub_underage_identity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_keys constant text[] := array['full_name', 'name', 'display_name', 'avatar_url', 'picture', 'given_name', 'family_name'];
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  begin
    if not exists (select 1 from public.profiles p where p.id = new.user_id and p.age_band = 'u13') then
      return null;
    end if;
    update auth.identities set identity_data = identity_data - v_keys
      where id = new.id and identity_data ?| v_keys;
  exception when others then
    raise warning 'rescrub_underage_identity skipped (SQLSTATE %)', sqlstate;
  end;
  return null;
end $$;

create trigger rescrub_underage_metadata after update of raw_user_meta_data on auth.users
  for each row when (new.raw_user_meta_data ?| array['full_name', 'name', 'display_name', 'avatar_url', 'picture', 'given_name', 'family_name'])
  execute function public.rescrub_underage_metadata();
create trigger rescrub_underage_identity after insert or update of identity_data on auth.identities
  for each row when (new.identity_data ?| array['full_name', 'name', 'display_name', 'avatar_url', 'picture', 'given_name', 'family_name'])
  execute function public.rescrub_underage_identity();

-- leftover objects under a blocked child's prefix, for M8's retention job
create or replace function public.underage_object_keys(p_limit int) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_keys jsonb;
begin
  perform public.require_service_role('underage_object_keys');
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', k.bucket_id, 'name', k.name) order by k.bucket_id, k.name), '[]'::jsonb)
    into v_keys
  from (
    select o.bucket_id, o.name
    from public.profiles p
    join storage.objects o on o.name like p.id::text || '/%'
    where p.age_band = 'u13'
    order by o.bucket_id, o.name
    limit p_limit
  ) k;
  return v_keys;
end $$;

-- ---------------------------------------------------------------------------
-- the hourly pass
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('age-band-rederive', '15 * * * *', 'select public.rederive_age_bands()');

-- ---------------------------------------------------------------------------
-- config rows: an operator's value is never overwritten by a push
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public)
values
  ('minor_consent_mode', '"guardian_link_optional"'::jsonb, true),
  ('onboarding', '{"tos_version":"2026-09-21","privacy_version":"2026-09-21"}'::jsonb, true),
  ('legal_urls', '{}'::jsonb, true),
  ('store_urls', '{}'::jsonb, true),
  ('oem_battery_guides', $json${
    "samsung": {
      "title": "Samsung: let RoadWise run in the background",
      "steps": [
        "Open Settings, then Apps, then RoadWise.",
        "Tap Battery and choose Unrestricted.",
        "Go back to Settings and open Battery (under Device care on some phones), then Background usage limits.",
        "If RoadWise is listed under Sleeping apps or Deep sleeping apps, remove it."
      ]
    },
    "xiaomi": {
      "title": "Xiaomi, Redmi or POCO: let RoadWise run in the background",
      "steps": [
        "Open Settings, then Apps, then Manage apps, then RoadWise.",
        "Turn on Autostart.",
        "Tap Battery saver and choose No restrictions.",
        "Open your recent apps, press and hold RoadWise, and tap the lock so it is not cleared."
      ]
    },
    "oneplus": {
      "title": "OnePlus: let RoadWise run in the background",
      "steps": [
        "Open Settings, then Apps, then RoadWise.",
        "Tap Battery usage (or Battery).",
        "Allow background activity, or choose Don't optimise.",
        "If you see Auto launch, turn it on."
      ]
    },
    "google": {
      "title": "Pixel: let RoadWise run in the background",
      "steps": [
        "Open Settings, then Apps, then RoadWise.",
        "Tap App battery usage.",
        "Choose Unrestricted."
      ]
    },
    "default": {
      "title": "Let RoadWise run in the background",
      "steps": [
        "Open Settings, then Apps, then RoadWise.",
        "Open Battery.",
        "Choose Unrestricted, No restrictions or Don't optimise, whichever your phone shows.",
        "If your phone has an auto-start or background activity setting for RoadWise, turn it on."
      ]
    }
  }$json$::jsonb, true),
  ('min_app_version', '"2.0.0"'::jsonb, true),
  ('feature_flags', '{"auto_detect":true,"camera_beta":false,"referral":false,"guardian_invites":false}'::jsonb, true)
on conflict (key) do nothing;
-- 0005 already created feature_flags on every database: add the new key, dark, only where absent
update public.app_config set value = value || '{"guardian_invites": false}'::jsonb
  where key = 'feature_flags' and not value ? 'guardian_invites';

-- ---------------------------------------------------------------------------
-- grants: nothing on invites for the API roles; per-function revoke, then the few grants
-- ---------------------------------------------------------------------------
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;

revoke all on function public.create_guardian_invite() from public, anon, authenticated;
revoke all on function public.guardian_link_state() from public, anon, authenticated;
revoke all on function public.derive_age_band_on(date, date) from public, anon, authenticated;
revoke all on function public.user_local_date(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.sync_age_band() from public, anon, authenticated;
revoke all on function public.rederive_age_bands() from public, anon, authenticated, service_role;
revoke all on function public.is_underage(uuid) from public, anon, authenticated;
revoke all on function public.refuse_underage_writes() from public, anon, authenticated;
revoke all on function public.enforce_trip_age_policy() from public, anon, authenticated;
revoke all on function public.minimise_underage_account() from public, anon, authenticated;
revoke all on function public.rescrub_underage_metadata() from public, anon, authenticated;
revoke all on function public.rescrub_underage_identity() from public, anon, authenticated;
revoke all on function public.underage_object_keys(int) from public, anon, authenticated;
grant execute on function public.create_guardian_invite() to authenticated;
grant execute on function public.guardian_link_state() to authenticated;
grant execute on function public.is_underage(uuid) to authenticated;
grant execute on function public.underage_object_keys(int) to service_role;
-- sync_age_band runs as the service role on a support correction and reads through these two
grant execute on function public.derive_age_band_on(date, date) to service_role;
grant execute on function public.user_local_date(uuid, timestamptz) to service_role;
-- the RPCs are for signed-in users, not the service role
revoke all on function public.create_guardian_invite() from service_role;
revoke all on function public.guardian_link_state() from service_role;
