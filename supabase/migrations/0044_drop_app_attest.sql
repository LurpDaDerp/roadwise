-- 0044_drop_app_attest: App Attest is gone from the app and the server, so the objects 0031 made for
-- it go too. Nothing a driver sees changes; every object dropped has no caller left in the app, the
-- edge functions or another SQL function.
--
-- Numbered 0044: 0042 and 0043 were taken by migrations that were later dropped from the repo, so a
-- database that recorded either version still runs this one.
--
--   * The functions only the app-attest and finalize-trip functions called:
--     app_attest_issue_challenge, app_attest_take_challenge, app_attest_save_key,
--     app_attest_context, app_attest_advance, and stamp_ios (the account's iPhone time).
--   * The tables they kept: private.app_attest_challenges, private.app_attest_keys (with its
--     app_attest_keys_user_idx) and private.ios_activity. 0031 gave no grant, policy, trigger or
--     cron job on them, so nothing else goes with them.
--   * The rate-limit rows those functions kept (keys app_attest_challenge and app_attest_attest).
--   * register_device, a shared object 0031 changed, is redefined from its latest definition (0032)
--     without its call to private.stamp_ios, which would otherwise fail every iPhone registration
--     once stamp_ios is dropped. Everything else in it stays as it is, including the refusal to turn
--     an install this account registered as 'ios' into an Android one: no real install meets it (a
--     phone's platform never changes), so leaving it changes nothing. Same signature, owner, grants,
--     security and search_path (CREATE OR REPLACE keeps the ACL).
--
-- Deploy order: redeploy finalize-trip (the one that no longer reads App Attest) and delete the
-- app-attest function FIRST, then push this migration. The finalize-trip before this one calls
-- private.app_attest_context and private.app_attest_advance under enforcement and on any upload
-- that carries App Attest headers, and the app-attest function calls the challenge and key
-- functions; on a database without them those calls fail.

-- ---------------------------------------------------------------------------
-- register_device: as 0032, without the iPhone time
-- ---------------------------------------------------------------------------
create or replace function public.register_device(p_device_id text, p_platform text, p_push_token text default null::text, p_live_activity_token text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_known boolean;
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
  -- an install registered as an iPhone stays one
  if p_platform = 'android' and exists (select 1 from public.devices d where d.user_id = v_uid and d.device_id = p_device_id and d.platform = 'ios') then
    raise exception 'an iOS device cannot become an Android device' using errcode = 'invalid_parameter_value';
  end if;
  if not v_known then
    perform private.require_rate_limit(v_uid, 'register_device_new', interval '1 day', 10);
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
    update public.devices set live_activity_token = null, live_activity_drive = null, live_activity_leg = null, live_activity_sent_at = null
      where live_activity_token = p_live_activity_token and not (user_id = v_uid and device_id = p_device_id);
  end if;
  -- at most 10 device rows per account: the least recently seen go
  delete from public.devices d where d.user_id = v_uid and d.device_id in (
    select x.device_id from public.devices x where x.user_id = v_uid order by x.last_seen_at desc, x.device_id offset 10);
  return jsonb_build_object('league_eligible', coalesce((select p.league_eligible from public.profiles p where p.id = v_uid), false));
end $function$;

-- ---------------------------------------------------------------------------
-- App Attest: functions, then the tables they used
-- ---------------------------------------------------------------------------
drop function if exists private.app_attest_issue_challenge(uuid, bytea);
drop function if exists private.app_attest_take_challenge(uuid, bytea);
drop function if exists private.app_attest_save_key(uuid, text, bytea, text);
drop function if exists private.app_attest_context(uuid, text);
drop function if exists private.app_attest_advance(uuid, text, bigint);
drop function if exists private.stamp_ios(uuid);

drop table if exists private.app_attest_challenges;
drop table if exists private.app_attest_keys;
drop table if exists private.ios_activity;

-- the rate-limit rows only the challenge and attestation functions kept
delete from public.rate_limits where key in ('app_attest_challenge', 'app_attest_attest');

notify pgrst, 'reload schema';
