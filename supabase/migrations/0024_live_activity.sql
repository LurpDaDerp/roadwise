-- 0024_live_activity: a drive noticed in the background shows its Live Activity on the lock screen
-- through an ActivityKit push-to-start (iOS 17.2 and later).
--
--   * Each device row may hold the app's push-to-start token (`live_activity_token`, the hex the
--     phone hands over through register_device), the drive it last started an activity for and
--     when. The token is server-only like the push token: no API role reads devices, the account
--     export leaves it out, and it moves with the install (no other row keeps it).
--   * release_device (sign-out) clears it with the push token.
--   * claim_live_activity_start(device, drive) is what the live-activity-start edge function asks
--     before it sends: the caller's own device token, at most one send per drive in 15 minutes
--     (a repeat answers `duplicate`), and at most 30 claims an hour per account.

alter table public.devices
  add column live_activity_token text check (live_activity_token ~ '^[0-9a-f]{32,200}$'),
  add column live_activity_drive uuid,
  add column live_activity_sent_at timestamptz;
-- the token lookup in register_device (a token moves with the install)
create index devices_live_activity_token_idx on public.devices (live_activity_token) where live_activity_token is not null;

-- register_device(p_device_id, p_platform, p_push_token, p_live_activity_token) -> { league_eligible }
-- As 0001, plus the push-to-start token: kept when the call carries none, taken from any other row
-- that held it. The first account to register a device claims it for leagues (the claim plumbing
-- is unchanged).
drop function if exists public.register_device(text, text, text);
create or replace function public.register_device(p_device_id text, p_platform text, p_push_token text default null,
  p_live_activity_token text default null) returns jsonb
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
  if p_live_activity_token is not null and (p_platform <> 'ios' or p_live_activity_token !~ '^[0-9a-f]{32,200}$') then
    raise exception 'invalid live activity token' using errcode = 'invalid_parameter_value';
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
  insert into public.devices (user_id, device_id, platform, push_token, live_activity_token, last_seen_at)
    values (v_uid, p_device_id, p_platform, p_push_token, p_live_activity_token, now())
  on conflict (user_id, device_id) do update
    set platform = excluded.platform,
        push_token = coalesce(excluded.push_token, public.devices.push_token),
        live_activity_token = coalesce(excluded.live_activity_token, public.devices.live_activity_token),
        last_seen_at = now();
  -- a token moves with the device: no other account keeps it
  if p_push_token is not null then
    update public.devices set push_token = null where push_token = p_push_token and user_id <> v_uid;
  end if;
  -- the push-to-start token belongs to one install: no other row keeps it
  if p_live_activity_token is not null then
    update public.devices set live_activity_token = null, live_activity_drive = null, live_activity_sent_at = null
      where live_activity_token = p_live_activity_token and not (user_id = v_uid and device_id = p_device_id);
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

-- release_device(p_device_id): on sign-out the phone drops its push token and its push-to-start
-- token, so the next account on the device (or nobody) is who gets its pushes. Acts only on the
-- caller's own (user, device) row; a missing row is a no-op (never an existence oracle).
create or replace function public.release_device(p_device_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'release_device requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  update public.devices set push_token = null, live_activity_token = null, live_activity_drive = null, live_activity_sent_at = null
    where user_id = v_uid and device_id = p_device_id
      and (push_token is not null or live_activity_token is not null or live_activity_drive is not null);
end $$;

-- claim_live_activity_start(p_device_id, p_client_trip_id) -> { token, duplicate }
-- The caller's own device's push-to-start token, claimed for one drive: token null when the device
-- has none (or is not the caller's); duplicate true when this drive was already claimed in the last
-- 15 minutes (nothing changes); else the claim is recorded and the token handed back for one send.
-- 30 claims an hour per account.
create or replace function public.claim_live_activity_start(p_device_id text, p_client_trip_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  d public.devices%rowtype;
begin
  if v_uid is null then
    raise exception 'claim_live_activity_start requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_client_trip_id is null then
    raise exception 'client_trip_id is required' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'live_activity_start', interval '1 hour', 30);
  select * into d from public.devices x where x.user_id = v_uid and x.device_id = p_device_id for update;
  if not found or d.live_activity_token is null then
    return jsonb_build_object('token', null, 'duplicate', false);
  end if;
  if d.live_activity_drive = p_client_trip_id and d.live_activity_sent_at > now() - interval '15 minutes' then
    return jsonb_build_object('token', d.live_activity_token, 'duplicate', true);
  end if;
  update public.devices set live_activity_drive = p_client_trip_id, live_activity_sent_at = now()
    where user_id = v_uid and device_id = p_device_id;
  return jsonb_build_object('token', d.live_activity_token, 'duplicate', false);
end $$;

revoke all on function public.register_device(text, text, text, text) from public, anon, authenticated;
revoke all on function public.release_device(text) from public, anon, authenticated;
revoke all on function public.claim_live_activity_start(text, uuid) from public, anon, authenticated;
grant execute on function public.register_device(text, text, text, text) to authenticated;
grant execute on function public.release_device(text) to authenticated;
grant execute on function public.claim_live_activity_start(text, uuid) to authenticated;
notify pgrst, 'reload schema';
