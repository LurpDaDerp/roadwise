-- 0007_inbox_push: the inbox, notification preferences, push registrations and deliveries, a device
-- drive-state column, the producers, the client RPCs, the service-role writers push-sender uses,
-- and the pg_cron sweep that calls push-sender through pg_net.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * extensions: pg_net `with schema extensions` (its objects live in its own `net` schema); pg_cron
--     is 0006's (pg_catalog + its own `cron` schema, the documented #14 exception). The migration
--     revokes usage on `net` and `cron` and execute on their functions from public, anon and
--     authenticated. NOTE: on Supabase those grants are made by supabase_admin (pg_net's event
--     trigger `extensions.grant_pg_net_access`, and pg_cron's install), so postgres's revoke is a
--     no-op with a WARNING for every grant it did not make; `cron` is unusable by the API roles
--     anyway (no schema usage), `net` stays reachable only through SQL, never through the API
--     (config.toml exposes public and graphql_public, search path public, extensions). The test
--     file pins both facts.
--   * public.notification_prefs (#1, #4, #9, #10, #11): one row per user, keyed by user_id (an
--     upsert onto another user's key fails the insert policy). `categories`: missing key = on,
--     only the eight catalog categories, boolean values. Quiet hours and tz null = "use
--     app_config.notification_defaults", so the config row keeps governing everyone who never
--     changed them; quiet_start = quiet_end means quiet hours are off. local_sent_day/count: the
--     phone's count of non-family notifications it showed on its local day (rev1: C1), the device
--     half of the §11.1 daily cap. A non-definer validation trigger raises fixed 22023 messages.
--   * public.inbox (#1, #4, #10, #11): notification history. Facts, never strings: the copy is
--     rendered from current state by the app (ruling I9). Two times (ruling T2 I1): deliver_after is
--     set once at insert and is ONLY the inbox visibility gate (the policy, mark_inbox_read,
--     dismiss_inbox); push_after is when push-sender may next consider the row (the claim, the due
--     index, dispatch_push's probe, every deferral), so deferring a push never hides a row the
--     driver can already see. Only pushed_at among the push_* columns is readable (rev1: C1: the
--     phone counts the server's half of the day's cap). No client writes: read/dismiss go through
--     definer RPCs.
--   * public.push_registrations (#1, #9, #10, #11): Expo push tokens, keyed by the token itself. A
--     token registered by a new user is taken from the previous one (the documented reassignment
--     trade: a token is a device's, and the device now belongs to the new account). Composite FK to
--     devices, so deleting a device (or the u13 minimisation) removes its tokens. devices.push_token
--     (0001) is read by no server path.
--   * public.push_deliveries (#10, #11): one row per Expo ticket; server only (RLS on, no policies,
--     no client grants).
--   * public.devices.drive_state / drive_state_at: the phone reports `recording` and `idle`;
--     drive_state_at is the server's time drive_state was last written, whatever the client sends
--     (security M-1: a client value of drive_state_at is ignored on every insert and update), and a
--     claim reads `recording` as driving for 6 h at most, clamped to now().
--   * producers (#7), deduped on (user_id, dedupe_key) (the summary `do nothing`; the lapse see below), payloads only from
--     CHECK-constrained columns:
--       - enqueue_trip_summary (non-definer; fires as postgres inside apply_trip): the drive-summary
--         history row, created already push_state skipped / push_reason local (rev1: C1: the phone
--         notified locally; push-sender never pushes it). Never for a discarded or deleted drive,
--         and never for a too-short one (rev1: I9), whatever its role: the phone's notifier skips
--         every drive under the scoring minimums (src/drive/policy.ts isShortDrive), so the mirror
--         does too (public.is_short_drive, the scorer's MIN_SCORED_DISTANCE_M / _DURATION_S).
--         scorableIfDriver (ruling T4 r1) = the scoring gate re-run with role 'driver': not short
--         and not grade C.
--       - enqueue_permission_lapse (DEFINER: fires under the client's devices PATCH and writes
--         inbox, which the client cannot): a lapse is a transition of devices.permissions (location
--         always -> foreground = location_always; always|foreground -> denied = location; motion
--         granted -> denied = motion; a missing key is unknown, never a lapse); none when the phone
--         says `ack: true`; pending only when `reportedFrom: 'background'`, else skipped/inbox_only.
--         At most one row per (user, device, kind, the user's local day) (security M-2).
--         A background lapse later the same day upgrades that day's inbox_only row to pending
--         (ruling T2 n1); a row in any other state is never touched.
--         Trigger adaptation of #5: runs only for the device owner's JWT or the service role.
--   * public.minimise_underage_notifications() (non-definer trigger beside 0006's
--     minimise_underage_account, same event): a blocked child's deliveries, inbox, registrations
--     and preferences are deleted in the same transaction; refuse_underage_writes (0006) guards
--     inserts into notification_prefs, inbox and push_registrations.
--   * client RPCs (#5, #6; definer, auth.uid() first, fixed codes): mark_inbox_read, dismiss_inbox,
--     register_push_token, unregister_push_token, merge_own_profile_flags (ruling T17 (4)).
--   * service-role writers (security rule 12; definer, require_service_role first):
--     claim_push_batch, record_push_outcomes, push_receipts_due, record_push_receipts.
--   * public.dispatch_push() (non-definer, pg_cron as postgres, no API role may execute it) and two
--     cron jobs: `push-sender-sweep` every minute, `cron-log-purge` daily at 03:30. The request
--     carries no key: an HMAC-SHA256 over a timestamp, keyed by the vault secret
--     push_sender_hmac_key (ruling T2 concern 1, condition 4), so no secret ever sits in
--     net.http_request_queue.
--   * user_local_date (0006) is replaced with the same signature to read public.user_tz, which
--     prefers notification_prefs.tz over the latest drive's zone (T1 report §2).
--   * app_config `notification_defaults`, `on conflict do nothing` (security rule 4).
--
-- Nothing from 0001-0006 is edited except: two columns and two triggers on devices, a comment on
-- devices.push_token, the new triggers on trips and profiles, and `create or replace` of
-- user_local_date (which keeps its owner, grants and invoker flag).

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
-- an IANA zone name the server knows: the wire schema's TZ_NAME_PATTERN (security M-4) and a row in
-- pg_timezone_names; the posix/ and right/ copies are refused (a phone's Intl does not know them)
create or replace function public.is_known_tz(p_tz text) returns boolean
language sql stable set search_path = public as $$
  select p_tz is not null
    and char_length(p_tz) between 1 and 64
    and p_tz ~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$'
    and p_tz !~ '^(posix|right)/'
    and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz)
$$;

-- the scorer's minimums (_shared/scoring/constants.ts: MIN_SCORED_DISTANCE_M = 0.5 mile =
-- 804.672 m, MIN_SCORED_DURATION_S = 120). Under either, a drive is "too short to score" whatever
-- its role, which is exactly when the phone shows no summary (src/drive/policy.ts isShortDrive).
create or replace function public.is_short_drive(p_distance_m numeric, p_duration_s numeric) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_distance_m, 0) < 804.672 or coalesce(p_duration_s, 0) < 120
$$;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.notification_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- missing key = on; keys and values are checked by notification_prefs_validate
  categories jsonb not null default '{}'::jsonb
    check (jsonb_typeof(categories) = 'object' and pg_column_size(categories) <= 1024),
  -- null = app_config.notification_defaults; quiet_start = quiet_end = off
  quiet_enabled boolean null,
  quiet_start time null,
  quiet_end time null,
  tz text null check (char_length(tz) between 1 and 64),
  -- the phone's count of non-family notifications it showed on local_sent_day (its local day)
  local_sent_day date null,
  local_sent_count int not null default 0 check (local_sent_count between 0 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('trip_summary', 'permission_lapsed')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 2048),
  -- the subject (trips.id for a summary); not a FK: a deleted subject is a fact push-sender reads
  ref_id uuid null,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 128),
  -- the inbox visibility gate only: set once at insert, never moved
  deliver_after timestamptz not null default now(),
  -- when push-sender may next consider the row: the claim and every deferral
  push_after timestamptz not null default now(),
  read_at timestamptz null,
  dismissed_at timestamptz null,
  push_state text not null default 'pending'
    check (push_state in ('pending', 'sending', 'sent', 'deferred', 'skipped', 'failed')),
  push_reason text check (char_length(push_reason) <= 32),
  push_attempts int not null default 0 check (push_attempts >= 0),
  push_claimed_at timestamptz null,
  pushed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbox_user_dedupe_key unique (user_id, dedupe_key)
);
-- the owner's list (and the auth.users cascade)
create index inbox_user_created_idx on public.inbox (user_id, created_at desc);
-- the claim's due scan
create index inbox_due_idx on public.inbox (push_after) where push_state in ('pending', 'deferred');
-- the lease expiry scan
create index inbox_sending_idx on public.inbox (push_claimed_at) where push_state = 'sending';
-- ctx.recent and the phone's count of today's server pushes
create index inbox_user_sent_idx on public.inbox (user_id, pushed_at) where push_state = 'sent';

create table public.push_registrations (
  token text primary key check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  user_id uuid not null,
  device_id text not null check (char_length(device_id) <= 128),
  platform text not null check (platform in ('ios', 'android')),
  last_registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_registrations_device_fkey foreign key (user_id, device_id)
    references public.devices (user_id, id) on delete cascade
);
-- the owner policy and ctx.tokens
create index push_registrations_user_idx on public.push_registrations (user_id);
-- the composite FK's cascade from devices, and "the caller's other tokens for that device"
create index push_registrations_user_device_idx on public.push_registrations (user_id, device_id);

create table public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references public.inbox(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text null references public.push_registrations(token) on delete set null,
  ticket_id text check (char_length(ticket_id) <= 128),
  error text check (char_length(error) <= 64),
  receipt_status text check (receipt_status in ('ok', 'error')),
  receipt_error text check (char_length(receipt_error) <= 64),
  receipt_checked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_deliveries_inbox_idx on public.push_deliveries (inbox_id);
create index push_deliveries_user_idx on public.push_deliveries (user_id);
create index push_deliveries_token_idx on public.push_deliveries (token) where token is not null;
-- receipts still owed
create index push_deliveries_receipt_due_idx on public.push_deliveries (created_at)
  where ticket_id is not null and receipt_status is null;

create trigger notification_prefs_touch before update on public.notification_prefs for each row execute function public.touch_updated_at();
create trigger inbox_touch before update on public.inbox for each row execute function public.touch_updated_at();
create trigger push_registrations_touch before update on public.push_registrations for each row execute function public.touch_updated_at();
create trigger push_deliveries_touch before update on public.push_deliveries for each row execute function public.touch_updated_at();

-- a u13 account writes none of these, whoever writes (0006's rule)
create trigger notification_prefs_refuse_underage before insert on public.notification_prefs
  for each row execute function public.refuse_underage_writes();
create trigger inbox_refuse_underage before insert on public.inbox
  for each row execute function public.refuse_underage_writes();
create trigger push_registrations_refuse_underage before insert on public.push_registrations
  for each row execute function public.refuse_underage_writes();

-- ---------------------------------------------------------------------------
-- notification_prefs validation (non-definer: it reads nothing the writer cannot)
-- ---------------------------------------------------------------------------
create or replace function public.notification_prefs_validate() returns trigger
language plpgsql set search_path = public as $$
declare
  v_key text;
  v_value jsonb;
begin
  -- a non-object is left to the CHECK (23514)
  if jsonb_typeof(new.categories) = 'object' then
    for v_key, v_value in select e.key, e.value from jsonb_each(new.categories) e loop
      if v_key not in ('trip_summaries', 'recording', 'rewards', 'family', 'safety', 'product', 'weekly_recap', 'crews') then
        raise exception 'unknown notification category' using errcode = 'invalid_parameter_value';
      end if;
      if jsonb_typeof(v_value) <> 'boolean' then
        raise exception 'category values must be true or false' using errcode = 'invalid_parameter_value';
      end if;
    end loop;
  end if;
  if new.tz is not null and not public.is_known_tz(new.tz) then
    raise exception 'unknown time zone' using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;
create trigger notification_prefs_validate before insert or update on public.notification_prefs
  for each row execute function public.notification_prefs_validate();

-- ---------------------------------------------------------------------------
-- the user's zone and local date
-- ---------------------------------------------------------------------------
-- notification_prefs.tz, else the zone of the latest live drive (an IANA name), else null; a zone
-- the server no longer knows reads as null rather than failing a caller
create or replace function public.user_tz(p_user uuid) returns text
language plpgsql stable set search_path = public as $$
declare
  v_tz text;
begin
  select p.tz into v_tz from public.notification_prefs p where p.user_id = p_user;
  if v_tz is null then
    select t.tz into v_tz from public.trips t
      where t.user_id = p_user and t.deleted_at is null
        and t.tz ~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$'
      order by t.started_at desc limit 1;
  end if;
  if v_tz is null then
    return null;
  end if;
  begin
    perform now() at time zone v_tz;
    return v_tz;
  exception when invalid_parameter_value then
    return null;
  end;
end $$;

-- 0006's contract, same signature: now in public.user_tz's zone, UTC when none is known
create or replace function public.user_local_date(p_user uuid, p_at timestamptz default now()) returns date
language plpgsql stable set search_path = public as $$
begin
  return (p_at at time zone coalesce(public.user_tz(p_user), 'UTC'))::date;
end $$;

-- app_config.notification_defaults, each key taken only when well formed, else the migration's value
create or replace function public.notification_defaults() returns jsonb
language sql stable set search_path = public as $$
  with c as (
    select coalesce((select a.value from public.app_config a where a.key = 'notification_defaults'
                     and jsonb_typeof(a.value) = 'object'), '{}'::jsonb) as v
  )
  select jsonb_build_object(
    'quiet_enabled', case when jsonb_typeof(v -> 'quiet_enabled') = 'boolean' then v -> 'quiet_enabled' else 'true'::jsonb end,
    'quiet_start', case when v ->> 'quiet_start' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v -> 'quiet_start' else '"22:00"'::jsonb end,
    'quiet_end', case when v ->> 'quiet_end' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v -> 'quiet_end' else '"07:00"'::jsonb end,
    'tz', case when jsonb_typeof(v -> 'tz') = 'string' and public.is_known_tz(v ->> 'tz') then v -> 'tz' else '"America/Los_Angeles"'::jsonb end)
  from c
$$;

-- ---------------------------------------------------------------------------
-- devices: drive state
-- ---------------------------------------------------------------------------
alter table public.devices
  add column drive_state text not null default 'idle' check (drive_state in ('idle', 'recording')),
  add column drive_state_at timestamptz null;
comment on column public.devices.push_token is
  'Legacy (0001). Read by no server path: push tokens live in public.push_registrations (0007).';

-- drive_state_at is the server's (security M-1). Two BEFORE triggers, which fire in name order:
--   devices_drive_state_at_pin (every update): a client value is discarded, the stored one kept;
--   devices_drive_state_stamp (insert, or an update whose SET list names drive_state, including a
--     re-sent `recording`): now().
-- So drive_state_at is always the server time drive_state was last written.
create or replace function public.pin_drive_state_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.drive_state_at := old.drive_state_at;
  return new;
end $$;
create or replace function public.stamp_drive_state() returns trigger
language plpgsql set search_path = public as $$
begin
  new.drive_state_at := now();
  return new;
end $$;
create trigger devices_drive_state_at_pin before update on public.devices
  for each row execute function public.pin_drive_state_at();
create trigger devices_drive_state_stamp before insert or update of drive_state on public.devices
  for each row execute function public.stamp_drive_state();

-- ---------------------------------------------------------------------------
-- producers
-- ---------------------------------------------------------------------------
-- the drive-summary history row (rev1: C1): already skipped/local, so push-sender never sees it.
-- Fires as postgres inside apply_trip (definer); non-definer.
create or replace function public.enqueue_trip_summary() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into public.inbox (user_id, type, payload, ref_id, dedupe_key, deliver_after, push_after, push_state, push_reason)
  values (
    new.user_id, 'trip_summary',
    jsonb_build_object(
      'clientTripId', new.client_trip_id,
      'startedAt', to_char(new.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endedAt', to_char(new.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'distanceM', new.distance_m,
      'status', new.status,
      'roleUnknown', new.role = 'unknown',
      -- ruling T4 r1: the scoring gate re-run with role 'driver' (not short, not grade C)
      'scorableIfDriver', not public.is_short_drive(new.distance_m, new.duration_s) and new.data_quality <> 'C'),
    new.id, 'trip_summary:' || new.id,
    greatest(now(), new.ended_at + interval '2 minutes'),
    greatest(now(), new.ended_at + interval '2 minutes'),
    'skipped', 'local')
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end $$;
create trigger trips_enqueue_summary after insert on public.trips
  for each row
  when (new.status <> 'discarded' and new.deleted_at is null and new.unscored_reason is distinct from 'too_short'
        and not public.is_short_drive(new.distance_m, new.duration_s))
  execute function public.enqueue_trip_summary();

-- a permission lapse, reported by the phone in devices.permissions (src/core/permissions/serverShape.ts:
-- location, motion, reportedFrom, ack). DEFINER: it writes inbox under the client's own PATCH.
create or replace function public.enqueue_permission_lapse() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := coalesce(old.permissions, '{}'::jsonb);
  v_new jsonb := coalesce(new.permissions, '{}'::jsonb);
  v_kinds text[] := '{}';
  v_kind text;
  v_background boolean;
  v_device_key text;
  v_day text;
begin
  -- #5 adapted for a trigger: the device owner's own JWT, or the service role
  if not (coalesce(new.user_id = auth.uid(), false) or coalesce(auth.role() = 'service_role', false)) then
    raise exception 'enqueue_permission_lapse requires the device owner or the service role' using errcode = 'insufficient_privilege';
  end if;
  -- the phone saw the change on return from B2's own Open Settings: a choice, not a fault
  if v_new ->> 'ack' = 'true' then
    return null;
  end if;
  if v_old ->> 'location' = 'always' and v_new ->> 'location' = 'foreground' then
    v_kinds := array_append(v_kinds, 'location_always');
  end if;
  if v_old ->> 'location' in ('always', 'foreground') and v_new ->> 'location' = 'denied' then
    v_kinds := array_append(v_kinds, 'location');
  end if;
  if v_old ->> 'motion' = 'granted' and v_new ->> 'motion' = 'denied' then
    v_kinds := array_append(v_kinds, 'motion');
  end if;
  if cardinality(v_kinds) = 0 then
    return null;
  end if;
  v_background := v_new ->> 'reportedFrom' = 'background';
  -- one row per (user, device, kind, the user's local day) (security M-2): a script flipping a
  -- permission creates at most one row a day per kind per device. The key stays within 128
  -- characters for any device id (ids over 64 characters are hashed).
  v_device_key := case when char_length(new.id) <= 64 then new.id else 'md5-' || md5(new.id) end;
  v_day := public.user_local_date(new.user_id)::text;
  foreach v_kind in array v_kinds loop
    insert into public.inbox (user_id, type, payload, dedupe_key, push_state, push_reason)
    values (
      new.user_id, 'permission_lapsed',
      jsonb_build_object('permission', v_kind, 'platform', new.platform, 'deviceId', new.id),
      'permission_lapsed:' || v_device_key || ':' || v_kind || ':' || v_day,
      case when v_background then 'pending' else 'skipped' end,
      case when v_background then null else 'inbox_only' end)
    -- still one row a day, but a background lapse later the same day upgrades a foreground
    -- (inbox_only) row to push-eligible (ruling T2 n1); a row in any other state (pending,
    -- sending, deferred, sent, failed) is never touched, so nothing already pushed is downgraded
    -- or pushed twice. deliver_after and read/dismissed stay as they were.
    on conflict (user_id, dedupe_key) do update
      set push_state = 'pending', push_reason = null, push_after = now()
      where excluded.push_state = 'pending'
        and public.inbox.push_state = 'skipped' and public.inbox.push_reason = 'inbox_only';
  end loop;
  return null;
end $$;
create trigger devices_enqueue_permission_lapse after update of permissions on public.devices
  for each row when (old.permissions is distinct from new.permissions)
  execute function public.enqueue_permission_lapse();

-- the under-13 minimisation, extended to this migration's user tables (0006 security I-1 (a)).
-- Non-definer: it runs as the role that moved the band (postgres inside set_birth_date or the cron
-- pass, service_role on a support correction), after 0006's definer trigger has checked the caller.
create or replace function public.minimise_underage_notifications() returns trigger
language plpgsql set search_path = public as $$
begin
  delete from public.push_deliveries where user_id = new.id;
  delete from public.inbox where user_id = new.id;
  delete from public.push_registrations where user_id = new.id;
  delete from public.notification_prefs where user_id = new.id;
  return null;
end $$;
create trigger profiles_minimise_underage_notifications after update of age_band on public.profiles
  for each row when (new.age_band = 'u13' and old.age_band is distinct from 'u13')
  execute function public.minimise_underage_notifications();

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- Read and dismiss: the caller's due rows among p_ids; returns how many matched (already-read rows
-- included). Ids matching none of the caller's rows are ignored and show only in the count: the
-- documented exception to "nothing silently no-ops", because a replayed offline batch after an
-- item expired must not wedge the client.
create or replace function public.mark_inbox_read(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'mark_inbox_read requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids, null) is not null then
    raise exception 'ids must be 1 to 100 inbox ids' using errcode = 'invalid_parameter_value';
  end if;
  update public.inbox set read_at = coalesce(read_at, now())
    where user_id = v_uid and id = any(p_ids) and deliver_after <= now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.dismiss_inbox(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'dismiss_inbox requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids, null) is not null then
    raise exception 'ids must be 1 to 100 inbox ids' using errcode = 'invalid_parameter_value';
  end if;
  update public.inbox set dismissed_at = coalesce(dismissed_at, now())
    where user_id = v_uid and id = any(p_ids) and deliver_after <= now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- One token, one holder: a token registered by a new user is taken from the previous one (the only
-- cross-user effect in this migration; security #12). The caller's other tokens for the same
-- device are removed (a rotation). The platform comes from the caller's devices row.
create or replace function public.register_push_token(p_device_id text, p_token text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_platform text;
begin
  if v_uid is null then
    raise exception 'register_push_token requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid push token' using errcode = 'invalid_parameter_value';
  end if;
  select d.platform into v_platform from public.devices d
    where d.user_id = v_uid and d.id = p_device_id for update;
  if not found then
    raise exception 'unknown device' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.push_registrations (token, user_id, device_id, platform, last_registered_at)
  values (p_token, v_uid, p_device_id, v_platform, now())
  on conflict (token) do update
    set user_id = excluded.user_id, device_id = excluded.device_id, platform = excluded.platform,
        last_registered_at = excluded.last_registered_at;
  delete from public.push_registrations
    where user_id = v_uid and device_id = p_device_id and token <> p_token;
end $$;

-- Deletes the caller's registration of p_token. Returns whether one existed: a false is
-- informative (already gone, or never the caller's), not an error, like mark_inbox_read's count.
create or replace function public.unregister_push_token(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'unregister_push_token requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid push token' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.push_registrations where token = p_token and user_id = v_uid;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- Ruling T17 (4): the caller's profiles.flags = flags || patch, in one statement (no client
-- read-modify-write). Only the flags the app writes: disclaimerAcknowledged (the version string,
-- 1..32 characters), onboarded (boolean), onboardingVersion (integer 1..1000). A preference, never
-- an entitlement (entitlements derive from age_band only). A blocked (u13) profile is read-only.
create or replace function public.merge_own_profile_flags(patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_value jsonb;
  v_ok boolean;
  v_band text;
  v_flags jsonb;
begin
  if v_uid is null then
    raise exception 'merge_own_profile_flags requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if patch is null or jsonb_typeof(patch) <> 'object' or patch = '{}'::jsonb or pg_column_size(patch) > 1024 then
    raise exception 'patch must be a non-empty JSON object of profile flags' using errcode = 'invalid_parameter_value';
  end if;
  for v_key, v_value in select e.key, e.value from jsonb_each(patch) e loop
    v_ok := case v_key
      when 'disclaimerAcknowledged' then jsonb_typeof(v_value) = 'string' and char_length(v_value #>> '{}') between 1 and 32
      when 'onboarded' then jsonb_typeof(v_value) = 'boolean'
      when 'onboardingVersion' then jsonb_typeof(v_value) = 'number'
        and (v_value #>> '{}')::numeric = trunc((v_value #>> '{}')::numeric)
        and (v_value #>> '{}')::numeric between 1 and 1000
      else null end;
    if v_ok is null then
      raise exception 'unknown profile flag' using errcode = 'invalid_parameter_value';
    end if;
    if not v_ok then
      raise exception 'invalid profile flag value' using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  select p.age_band into v_band from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
  if v_band = 'u13' then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  update public.profiles set flags = flags || patch where id = v_uid returning flags into v_flags;
  return v_flags;
end $$;

-- ---------------------------------------------------------------------------
-- service-role writers (push-sender)
-- ---------------------------------------------------------------------------
-- Whether an item's subject is gone: a summary whose trip is deleted; a lapse whose device is gone
-- or whose permission is no longer lapsed on that device (T3 re-checks a cap-deferred lapse this way).
create or replace function public.inbox_subject_gone(p_user uuid, p_type text, p_ref uuid, p_payload jsonb) returns boolean
language sql stable set search_path = public as $$
  select case p_type
    when 'trip_summary' then not exists (
      select 1 from public.trips t where t.id = p_ref and t.user_id = p_user and t.deleted_at is null)
    when 'permission_lapsed' then not exists (
      select 1 from public.devices d
      where d.user_id = p_user and d.id = p_payload ->> 'deviceId'
        and case p_payload ->> 'permission'
              when 'location_always' then coalesce(d.permissions ->> 'location' <> 'always', true)
              when 'location' then coalesce(d.permissions ->> 'location' not in ('always', 'foreground'), true)
              when 'motion' then coalesce(d.permissions ->> 'motion' <> 'granted', true)
              else true end)
    else false end
$$;

-- claim_push_batch(p_limit 1..500, p_lease_seconds 30..3600) returns jsonb:
--   first marks every `sending` row whose lease has run out `failed / lease_expired` (at most once:
--   a push that may have gone out is never sent twice); then claims up to p_limit due
--   pending/deferred rows (push_after <= now(), oldest push_after first, for update skip locked), sets them
--   `sending` (push_claimed_at = now(), push_attempts + 1) and returns, oldest first:
--   [{ inbox_id: uuid, user_id: uuid, type: text, payload: object, created_at: timestamptz,
--      read: boolean, dismissed: boolean, subject_gone: boolean, ctx }]
--   ctx (computed once per distinct user in the batch) = {
--     tz: text                       notification_prefs.tz -> latest live drive's zone ->
--                                    notification_defaults.tz (always an IANA name)
--     quiet: { enabled: boolean, start: 'HH:MM', end: 'HH:MM' }
--                                    each field from prefs, or notification_defaults where null;
--                                    start = end means off
--     categories: object             prefs.categories ({} when no row); a missing key is on
--     driving_since: timestamptz|null the newest drive_state_at of a device in `recording` within
--                                    the last 6 h, clamped to now() (security M-1)
--     recent: [{ type, pushed_at, lapse_key? }]
--                                    up to 50 of the user's `sent` rows from the last 8 days,
--                                    newest first; lapse_key only on permission_lapsed rows:
--                                    payload.deviceId || ':' || payload.permission (the raw device
--                                    id, never the hashed form; ruling T3 (2)), which push-sender
--                                    rebuilds from a claimed lapse's payload to dedupe across sweeps
--     local_sent_today: int          prefs.local_sent_count when local_sent_day is today in tz, else 0
--     tokens: text[]                 up to 10 Expo tokens, most recently registered first
--   }
create or replace function public.claim_push_batch(p_limit int, p_lease_seconds int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_defaults jsonb;
  v_out jsonb;
begin
  perform public.require_service_role('claim_push_batch');
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'limit must be between 1 and 500' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease must be between 30 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;

  update public.inbox set push_state = 'failed', push_reason = 'lease_expired'
    where push_state = 'sending' and push_claimed_at < now() - make_interval(secs => p_lease_seconds);

  v_defaults := public.notification_defaults();

  with due as (
    select i.id from public.inbox i
    where i.push_state in ('pending', 'deferred') and i.push_after <= now()
    order by i.push_after, i.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.inbox i
      set push_state = 'sending', push_claimed_at = now(), push_attempts = i.push_attempts + 1
      from due where i.id = due.id
      returning i.id, i.user_id, i.type, i.payload, i.ref_id, i.created_at, i.push_after, i.read_at, i.dismissed_at
  ), base as (
    select u.user_id, p.categories, p.quiet_enabled, p.quiet_start, p.quiet_end, p.local_sent_day, p.local_sent_count,
      coalesce(public.user_tz(u.user_id), v_defaults ->> 'tz') as tz
    from (select distinct c.user_id from claimed c) u
    left join public.notification_prefs p on p.user_id = u.user_id
  ), ctx as (
    select b.user_id, jsonb_build_object(
      'tz', b.tz,
      'quiet', jsonb_build_object(
        'enabled', coalesce(b.quiet_enabled, (v_defaults ->> 'quiet_enabled')::boolean),
        'start', coalesce(left(b.quiet_start::text, 5), v_defaults ->> 'quiet_start'),
        'end', coalesce(left(b.quiet_end::text, 5), v_defaults ->> 'quiet_end')),
      'categories', coalesce(b.categories, '{}'::jsonb),
      'driving_since', (select case when max(d.drive_state_at) is null then null else least(max(d.drive_state_at), now()) end
                        from public.devices d
                        where d.user_id = b.user_id and d.drive_state = 'recording'
                          and d.drive_state_at > now() - interval '6 hours'),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object('type', r.type, 'pushed_at', r.pushed_at)
                   || case when r.type = 'permission_lapsed' and jsonb_typeof(r.payload -> 'deviceId') = 'string'
                             and jsonb_typeof(r.payload -> 'permission') = 'string'
                           then jsonb_build_object('lapse_key', (r.payload ->> 'deviceId') || ':' || (r.payload ->> 'permission'))
                           else '{}'::jsonb end
                   order by r.pushed_at desc), '[]'::jsonb)
                 from (select s.type, s.pushed_at, s.payload from public.inbox s
                       where s.user_id = b.user_id and s.push_state = 'sent' and s.pushed_at > now() - interval '8 days'
                       order by s.pushed_at desc limit 50) r),
      'local_sent_today', case when b.local_sent_day = (now() at time zone b.tz)::date then b.local_sent_count else 0 end,
      'tokens', (select coalesce(jsonb_agg(t.token order by t.last_registered_at desc, t.token), '[]'::jsonb)
                 from (select r.token, r.last_registered_at from public.push_registrations r
                       where r.user_id = b.user_id order by r.last_registered_at desc, r.token limit 10) t)
    ) as ctx
    from base b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'inbox_id', c.id, 'user_id', c.user_id, 'type', c.type, 'payload', c.payload, 'created_at', c.created_at,
      'read', c.read_at is not null, 'dismissed', c.dismissed_at is not null,
      'subject_gone', public.inbox_subject_gone(c.user_id, c.type, c.ref_id, c.payload),
      'ctx', x.ctx) order by c.push_after, c.id), '[]'::jsonb)
    into v_out
  from claimed c join ctx x on x.user_id = c.user_id;
  return v_out;
end $$;

-- record_push_outcomes({ outcomes: [{ inbox_id, state, reason, push_after?, deliveries? }] }) returns int
--   at most 500 outcomes; state sent | deferred | skipped | failed; reason from the fixed list;
--   deferred needs push_after <= now() + 7 days (it moves push_after only: the row stays visible); every inbox_id must be `sending` (claimed and not
--   yet settled) or the whole call is refused; deliveries (<= 10 per item) are
--   { token?, ticket_id?, error? }, one push_deliveries row each (the token is linked only while it
--   is still registered to the item's user); error DeviceNotRegistered deletes that registration.
--   sent stamps pushed_at. Returns the number of outcomes applied.
create or replace function public.record_push_outcomes(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_o jsonb;
  v_d jsonb;
  v_id uuid;
  v_state text;
  v_reason text;
  v_after timestamptz;
  v_user uuid;
  v_current text;
  v_token text;
  v_ticket text;
  v_error text;
  v_count int := 0;
begin
  perform public.require_service_role('record_push_outcomes');
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'outcomes') is distinct from 'array'
     or jsonb_array_length(p -> 'outcomes') > 500 then
    raise exception 'outcomes must be an array of at most 500 items' using errcode = 'invalid_parameter_value';
  end if;
  for v_o in select e.value from jsonb_array_elements(p -> 'outcomes') e loop
    v_id := null;
    if jsonb_typeof(v_o) = 'object' and jsonb_typeof(v_o -> 'inbox_id') = 'string' then
      begin
        v_id := (v_o ->> 'inbox_id')::uuid;
      exception when invalid_text_representation then
        v_id := null;
      end;
    end if;
    if v_id is null then
      raise exception 'outcome must be an object with a uuid inbox_id' using errcode = 'invalid_parameter_value';
    end if;
    v_state := v_o ->> 'state';
    if v_state is null or v_state not in ('sent', 'deferred', 'skipped', 'failed') then
      raise exception 'unknown outcome state' using errcode = 'invalid_parameter_value';
    end if;
    v_reason := v_o ->> 'reason';
    if v_reason is null or v_reason not in ('ok', 'driving', 'quiet_hours', 'window', 'expo_unavailable', 'local',
        'inbox_only', 'category_off', 'capped', 'weekly_limit', 'no_device', 'stale', 'already_read', 'dismissed',
        'subject_gone', 'unknown_type', 'bad_payload', 'expo_error') then
      raise exception 'unknown outcome reason' using errcode = 'invalid_parameter_value';
    end if;
    v_after := null;
    if v_state = 'deferred' then
      if jsonb_typeof(v_o -> 'push_after') = 'string' then
        begin
          v_after := (v_o ->> 'push_after')::timestamptz;
        exception when others then
          v_after := null;
        end;
      end if;
      if v_after is null or v_after > now() + interval '7 days' then
        raise exception 'deferred outcome needs push_after within 7 days' using errcode = 'invalid_parameter_value';
      end if;
    end if;
    if v_o ? 'deliveries' and jsonb_typeof(v_o -> 'deliveries') <> 'null'
       and (jsonb_typeof(v_o -> 'deliveries') <> 'array' or jsonb_array_length(v_o -> 'deliveries') > 10) then
      raise exception 'deliveries must be an array of at most 10 items' using errcode = 'invalid_parameter_value';
    end if;

    select i.user_id, i.push_state into v_user, v_current from public.inbox i where i.id = v_id for update;
    if not found or v_current <> 'sending' then
      raise exception 'outcome for an unclaimed item' using errcode = 'invalid_parameter_value';
    end if;

    update public.inbox set
      push_state = v_state,
      push_reason = v_reason,
      pushed_at = case when v_state = 'sent' then now() else pushed_at end,
      push_after = case when v_state = 'deferred' then v_after else push_after end
    where id = v_id;

    if jsonb_typeof(v_o -> 'deliveries') = 'array' then
      for v_d in select e.value from jsonb_array_elements(v_o -> 'deliveries') e loop
        if jsonb_typeof(v_d) <> 'object'
           or coalesce(jsonb_typeof(v_d -> 'token'), 'null') not in ('string', 'null')
           or coalesce(jsonb_typeof(v_d -> 'ticket_id'), 'null') not in ('string', 'null')
           or coalesce(jsonb_typeof(v_d -> 'error'), 'null') not in ('string', 'null')
           or char_length(coalesce(v_d ->> 'token', '')) > 256
           or char_length(coalesce(v_d ->> 'ticket_id', '')) > 128
           or char_length(coalesce(v_d ->> 'error', '')) > 64 then
          raise exception 'delivery must be an object with bounded token, ticket_id and error' using errcode = 'invalid_parameter_value';
        end if;
        v_token := v_d ->> 'token';
        v_ticket := v_d ->> 'ticket_id';
        v_error := v_d ->> 'error';
        insert into public.push_deliveries (inbox_id, user_id, token, ticket_id, error)
        values (v_id, v_user,
          (select r.token from public.push_registrations r where r.token = v_token and r.user_id = v_user),
          v_ticket, v_error);
        if v_error = 'DeviceNotRegistered' and v_token is not null then
          delete from public.push_registrations where token = v_token and user_id = v_user;
        end if;
      end loop;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- push_receipts_due(p_limit 1..1000) returns [{ delivery_id: uuid, ticket_id: text }]:
--   first stamps every delivery whose ticket is older than 24 h and still has no receipt
--   `error / expired` (rev1: I13: Expo keeps receipts about a day; an absent one never arrives), then
--   returns up to p_limit deliveries with a ticket and no receipt, created at least 15 minutes ago
--   and not checked in the last 15 minutes (a receipt Expo has not produced yet is asked for again
--   at most every 15 minutes, not every sweep), oldest first.
create or replace function public.push_receipts_due(p_limit int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  perform public.require_service_role('push_receipts_due');
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  update public.push_deliveries
    set receipt_status = 'error', receipt_error = 'expired', receipt_checked_at = now()
    where ticket_id is not null and receipt_status is null and created_at < now() - interval '24 hours';
  select coalesce(jsonb_agg(jsonb_build_object('delivery_id', q.id, 'ticket_id', q.ticket_id) order by q.created_at, q.id), '[]'::jsonb)
    into v_out
  from (
    select d.id, d.ticket_id, d.created_at from public.push_deliveries d
    where d.ticket_id is not null and d.receipt_status is null
      and d.created_at <= now() - interval '15 minutes'
      and (d.receipt_checked_at is null or d.receipt_checked_at <= now() - interval '15 minutes')
    order by d.created_at, d.id
    limit p_limit
  ) q;
  return v_out;
end $$;

-- record_push_receipts({ receipts: [{ delivery_id, status, error }] }) returns int
--   at most 1000; status ok | error | null (null: Expo returned no receipt for the ticket yet);
--   error <= 64 characters or null. Every named delivery that exists is stamped receipt_checked_at,
--   found by Expo or not; a status sets receipt_status/receipt_error; DeviceNotRegistered deletes
--   the delivery's registration. Returns the number of deliveries stamped.
create or replace function public.record_push_receipts(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_r jsonb;
  v_id uuid;
  v_status text;
  v_error text;
  v_token text;
  v_user uuid;
  v_count int := 0;
begin
  perform public.require_service_role('record_push_receipts');
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'receipts') is distinct from 'array'
     or jsonb_array_length(p -> 'receipts') > 1000 then
    raise exception 'receipts must be an array of at most 1000 items' using errcode = 'invalid_parameter_value';
  end if;
  for v_r in select e.value from jsonb_array_elements(p -> 'receipts') e loop
    v_id := null;
    if jsonb_typeof(v_r) = 'object' and jsonb_typeof(v_r -> 'delivery_id') = 'string' then
      begin
        v_id := (v_r ->> 'delivery_id')::uuid;
      exception when invalid_text_representation then
        v_id := null;
      end;
    end if;
    if v_id is null
       or coalesce(jsonb_typeof(v_r -> 'status'), 'null') not in ('string', 'null')
       or coalesce(v_r ->> 'status', 'ok') not in ('ok', 'error')
       or coalesce(jsonb_typeof(v_r -> 'error'), 'null') not in ('string', 'null')
       or char_length(coalesce(v_r ->> 'error', '')) > 64 then
      raise exception 'receipt must be { delivery_id, status ok|error|null, error }' using errcode = 'invalid_parameter_value';
    end if;
    v_status := v_r ->> 'status';
    v_error := v_r ->> 'error';
    update public.push_deliveries set
      receipt_status = coalesce(v_status, receipt_status),
      receipt_error = case when v_status is null then receipt_error else v_error end,
      receipt_checked_at = now()
    where id = v_id
    returning token, user_id into v_token, v_user;
    if found then
      v_count := v_count + 1;
      if v_error = 'DeviceNotRegistered' and v_token is not null then
        delete from public.push_registrations where token = v_token and user_id = v_user;
      end if;
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- the sweep: pg_cron -> dispatch_push -> pg_net -> push-sender
-- ---------------------------------------------------------------------------
-- Non-definer, run by pg_cron as postgres; no API role may execute it. Reads the vault secrets
-- push_sender_url and push_sender_hmac_key (a dedicated random secret of at least 32 bytes, never the
-- service-role key or the JWT secret; push-sender holds the same value as a function secret). The key
-- itself is never sent, logged or returned (ruling T2 concern 1, condition 4). Returns:
--   'unconfigured' the URL is missing or empty, or the key is missing or shorter than 32 bytes;
--   'idle'         no due inbox row (pending/deferred with push_after <= now(), or a `sending` row
--                  past the longest lease, 1 h) and no due receipt (the 24-h expiry in
--                  push_receipts_due guarantees receipts drain);
--   'dispatched'   one net.http_post to push-sender, body {"reason":"sweep"}, timeout 10 s, headers
--                    Content-Type: application/json
--                    X-Sweep-Signature: <ts>.<sig>
--                  where <ts> = the unix time in whole seconds (decimal, no sign, no padding) and
--                  <sig> = lower-case hex of HMAC-SHA256(key = the UTF-8 bytes of push_sender_hmac_key,
--                  message = the UTF-8 bytes of 'push-sender-sweep:' || <ts>). push-sender verifies it
--                  in constant time and accepts |now - ts| <= 120 s.
create or replace function public.push_sweep_signature(p_ts bigint, p_key text) returns text
language sql immutable set search_path = public as $$
  select p_ts::text || '.' || encode(extensions.hmac('push-sender-sweep:' || p_ts::text, p_key, 'sha256'), 'hex')
$$;

create or replace function public.dispatch_push() returns text
language plpgsql set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'push_sender_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'push_sender_hmac_key';
  if coalesce(v_url, '') = '' or octet_length(coalesce(v_key, '')) < 32 then
    return 'unconfigured';
  end if;
  if not exists (select 1 from public.inbox i where i.push_state in ('pending', 'deferred') and i.push_after <= now())
     and not exists (select 1 from public.inbox i where i.push_state = 'sending' and i.push_claimed_at < now() - interval '1 hour')
     and not exists (select 1 from public.push_deliveries d
                     where d.ticket_id is not null and d.receipt_status is null
                       and d.created_at <= now() - interval '15 minutes'
                       and (d.receipt_checked_at is null or d.receipt_checked_at <= now() - interval '15 minutes')) then
    return 'idle';
  end if;
  perform net.http_post(
    url := v_url,
    body := '{"reason":"sweep"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Sweep-Signature', public.push_sweep_signature(floor(extract(epoch from now()))::bigint, v_key)),
    timeout_milliseconds := 10000);
  return 'dispatched';
end $$;

select cron.schedule('push-sender-sweep', '* * * * *', 'select public.dispatch_push()');
select cron.schedule('cron-log-purge', '30 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$);

-- ---------------------------------------------------------------------------
-- config: an operator's value is never overwritten by a push
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public)
values ('notification_defaults', '{"quiet_enabled":true,"quiet_start":"22:00","quiet_end":"07:00","tz":"America/Los_Angeles"}'::jsonb, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- RLS, policies, grants
-- ---------------------------------------------------------------------------
alter table public.notification_prefs enable row level security;
alter table public.inbox enable row level security;
alter table public.push_registrations enable row level security;
alter table public.push_deliveries enable row level security;

create policy notification_prefs_select_own on public.notification_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_prefs_insert_own on public.notification_prefs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy notification_prefs_update_own on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy inbox_select_own on public.inbox for select to authenticated
  using (user_id = (select auth.uid()) and deliver_after <= now());
create policy push_registrations_select_own on public.push_registrations for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.notification_prefs from anon, authenticated;
revoke all on public.inbox from anon, authenticated;
revoke all on public.push_registrations from anon, authenticated;
revoke all on public.push_deliveries from anon, authenticated;
grant select on public.notification_prefs to authenticated;
grant insert (user_id, categories, quiet_enabled, quiet_start, quiet_end, tz, local_sent_day, local_sent_count)
  on public.notification_prefs to authenticated;
grant update (categories, quiet_enabled, quiet_start, quiet_end, tz, local_sent_day, local_sent_count)
  on public.notification_prefs to authenticated;
-- pushed_at is the only push_* column a client reads (rev1: C1)
grant select (id, user_id, type, payload, ref_id, deliver_after, read_at, dismissed_at, pushed_at, created_at)
  on public.inbox to authenticated;
grant select on public.push_registrations to authenticated;

revoke all on function public.is_known_tz(text) from public, anon, authenticated;
revoke all on function public.is_short_drive(numeric, numeric) from public, anon, authenticated;
revoke all on function public.notification_prefs_validate() from public, anon, authenticated;
revoke all on function public.user_tz(uuid) from public, anon, authenticated;
revoke all on function public.notification_defaults() from public, anon, authenticated;
revoke all on function public.stamp_drive_state() from public, anon, authenticated;
revoke all on function public.pin_drive_state_at() from public, anon, authenticated;
revoke all on function public.push_sweep_signature(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_trip_summary() from public, anon, authenticated;
revoke all on function public.enqueue_permission_lapse() from public, anon, authenticated;
revoke all on function public.minimise_underage_notifications() from public, anon, authenticated;
revoke all on function public.inbox_subject_gone(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.mark_inbox_read(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.dismiss_inbox(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.register_push_token(text, text) from public, anon, authenticated, service_role;
revoke all on function public.unregister_push_token(text) from public, anon, authenticated, service_role;
revoke all on function public.merge_own_profile_flags(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_push_batch(int, int) from public, anon, authenticated;
revoke all on function public.record_push_outcomes(jsonb) from public, anon, authenticated;
revoke all on function public.push_receipts_due(int) from public, anon, authenticated;
revoke all on function public.record_push_receipts(jsonb) from public, anon, authenticated;
revoke all on function public.dispatch_push() from public, anon, authenticated, service_role;
grant execute on function public.mark_inbox_read(uuid[]) to authenticated;
grant execute on function public.dismiss_inbox(uuid[]) to authenticated;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
grant execute on function public.merge_own_profile_flags(jsonb) to authenticated;
grant execute on function public.claim_push_batch(int, int) to service_role;
grant execute on function public.record_push_outcomes(jsonb) to service_role;
grant execute on function public.push_receipts_due(int) to service_role;
grant execute on function public.record_push_receipts(jsonb) to service_role;
-- sync_age_band runs as the service role on a support correction: user_local_date -> user_tz
grant execute on function public.user_tz(uuid) to service_role;

-- the extension schemas: nothing for the API roles (see the header for what postgres can revoke)
revoke usage on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
revoke usage on schema cron from public, anon, authenticated;
revoke all on all functions in schema cron from public, anon, authenticated;
