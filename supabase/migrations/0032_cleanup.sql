-- 0032_cleanup: the database objects of features the app no longer has: clans, drive combining
-- and the league leftovers. Nothing here changes what a driver sees; every object dropped has no
-- caller in the app, the edge functions or another SQL function (checked against all of
-- src/, app/, scripts/ and supabase/, and against every commit of the app for get_my_stat_sums).
--
--   * Clans: the clans and clan_members tables, their three triggers (two of them ran on every
--     account delete, through clan_members' cascade), the ten clan RPCs, the four private helpers
--     and the two trigger functions. Reports of a clan are deleted and a report's kind is 'user'
--     only (report_target refuses 'clan', as it now has nothing to look a clan up in). The data
--     export loses its 'clan' key and its trips their merged_into key, so it is format_version 6.
--     get_profile keeps its constant 'clan': null, which an older build reads.
--   * Drive combining (gone since 0026's finalize-trip, which always sends mergeInto: null):
--     drive_context's merge-target lookup, apply_drive's join branch and its merged-away row,
--     progress.last_end_lat / last_end_lng / last_end_at (the end point the merge check read; a
--     location, so it goes) and trips.merged_into. The merged-away rows an older server kept are
--     deleted first: each was an unscored copy of one leg whose miles and events its target holds,
--     hidden from every list and sum by "merged_into is null", which would otherwise count it.
--     Every function that read merged_into is redefined from its latest definition without it
--     (same signature, owner, grants, security and search_path; CREATE OR REPLACE keeps the ACL).
--     apply_drive ignores an envelope's mergeInto (the deployed finalize-trip still sends null),
--     and its answer keeps 'mergedInto': null, which every build of the app requires.
--     drive_context keeps its signature and its version 23 / phoneUse answer, with 'merge' always
--     null (the finalize-trip before this one requires the key; the new one ignores it).
--   * League leftovers: device_league_claims and register_device's upkeep of it and of
--     profiles.league_eligible. The column itself stays (older builds select it) and keeps the
--     value it has; register_device answers it as stored. job_leases with acquire_job_lease and
--     release_job_lease (push-sender never took a lease), get_my_stat_sums, private.watched_miles,
--     and claim_push_batch's arm for the 'league_result' inbox kind, which inbox's check has not
--     allowed since 0023.
--
-- Deploy order: this migration, then finalize-trip and trip-actions (the envelope no longer carries
-- mergeInto or an end point, and drive_context's merge is no longer read). Either order works: this
-- migration answers and accepts what the deployed function expects and sends, and the new function
-- runs on a database at 0031.

-- ---------------------------------------------------------------------------
-- Clans
-- ---------------------------------------------------------------------------
-- the triggers first (dropping clan_members would take them too; named so the intent is plain)
drop trigger if exists clan_members_gone on public.clan_members;
drop trigger if exists clan_leader_required on public.clan_members;
drop trigger if exists clans_touch on public.clans;

drop function if exists public.create_clan(text, text);
drop function if exists public.preview_clan(text);
drop function if exists public.join_clan(text);
drop function if exists public.leave_clan();
drop function if exists public.get_my_clan();
drop function if exists public.regenerate_clan_code();
drop function if exists public.update_clan(text, text);
drop function if exists public.remove_member(uuid);
drop function if exists public.set_member_role(uuid, text);
drop function if exists public.transfer_leadership(uuid);
drop function if exists public.clan_member_gone();
drop function if exists public.clan_leader_required();
drop function if exists private.clan_of(uuid);
drop function if exists private.clan_goal(uuid, text);
drop function if exists private.clan_name_problem(text);
drop function if exists private.new_invite_code();

drop table if exists public.clan_members;
drop table if exists public.clans;

-- a report names a user only
delete from public.reports where target_kind = 'clan';
alter table public.reports drop constraint if exists reports_target_kind_check;
alter table public.reports add constraint reports_target_kind_check check (target_kind = 'user');

create or replace function public.report_target(p_kind text, p_target_id uuid, p_reason text, p_note text default ''::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'report_target requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_kind is null or p_kind <> 'user' or p_target_id is null then
    raise exception 'kind must be user with a target id' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('inappropriate_name', 'harassment', 'cheating', 'impersonation', 'other') then
    raise exception 'unknown report reason' using errcode = 'invalid_parameter_value';
  end if;
  if p_note is null or char_length(p_note) > 500 then
    raise exception 'note must be at most 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_target_id = v_uid then
    raise exception 'kind must be user with a target id' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'report_target', interval '1 day', 10);
  if not exists (select 1 from public.profiles p where p.id = p_target_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  insert into public.reports (reporter_id, target_kind, target_id, reason, note)
    values (v_uid, p_kind, p_target_id, p_reason, regexp_replace(p_note, '[[:cntrl:]]', '', 'g'));
end $function$;

-- ---------------------------------------------------------------------------
-- League leftovers
-- ---------------------------------------------------------------------------
-- register_device as 0031, without the install claims: profiles.league_eligible is no longer
-- written, and the answer is its stored value (no build keeps it; an older one may read the key)
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
  -- an install registered as an iPhone stays one: it cannot be re-labelled to post as Android
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
  if p_platform = 'ios' then
    perform private.stamp_ios(v_uid);
  end if;
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

drop table if exists public.device_league_claims;

drop function if exists public.acquire_job_lease(text, text, integer);
drop function if exists public.release_job_lease(text, text);
drop table if exists public.job_leases;

drop function if exists public.get_my_stat_sums(timestamp with time zone);
drop function if exists private.watched_miles(numeric, integer, integer);

-- claim_push_batch as 0005, without the 'league_result' arm (inbox holds weekly_recap and
-- friend_request only)
create or replace function public.claim_push_batch(p_limit integer, p_lease_seconds integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
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
  with due as (
    select i.id from public.inbox i
    where i.push_state in ('pending', 'deferred') and i.push_after <= now()
    order by i.push_after, i.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.inbox i set push_state = 'sending', push_claimed_at = now(), push_attempts = i.push_attempts + 1
      from due where i.id = due.id
      returning i.id, i.user_id, i.kind, i.payload, i.created_at, i.push_after
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'inbox_id', c.id, 'user_id', c.user_id, 'kind', c.kind, 'payload', c.payload, 'created_at', c.created_at,
      'ctx', jsonb_build_object(
        'tz', private.user_tz(c.user_id),
        'quiet', jsonb_build_object('enabled', coalesce(p.quiet_enabled, true),
          'start', left(coalesce(p.quiet_start, '22:00'::time)::text, 5), 'end', left(coalesce(p.quiet_end, '07:00'::time)::text, 5)),
        'enabled', case c.kind when 'weekly_recap' then coalesce(p.weekly_recap, true)
                                else coalesce(p.social, true) end,
        'tokens', coalesce((select jsonb_agg(d.push_token order by d.last_seen_at desc) from (
                    select d.push_token, d.last_seen_at from public.devices d
                    where d.user_id = c.user_id and d.push_token is not null order by d.last_seen_at desc limit 10) d), '[]'::jsonb)))
      order by c.push_after, c.id), '[]'::jsonb)
    into v_out
  from claimed c left join public.notification_prefs p on p.user_id = c.user_id;
  return v_out;
end $function$;

-- ---------------------------------------------------------------------------
-- Drive combining
-- ---------------------------------------------------------------------------
-- drive_context as 0026, without the merge-target lookup (and the clock shift that only fed it).
-- The start point and end time stay in the signature: the deployed finalize-trip passes them.
create or replace function private.drive_context(p_user uuid, p_client_trip_id uuid, p_started_at timestamp with time zone, p_local_day date, p_start_lat double precision, p_start_lng double precision, p_ended_at timestamp with time zone default null::timestamp with time zone)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_existing jsonb;
begin
  if p_user is null or p_client_trip_id is null or p_started_at is null or p_local_day is null then
    raise exception 'user, clientTripId, startedAt and localDay are required' using errcode = 'invalid_parameter_value';
  end if;
  if (p_start_lat is null) <> (p_start_lng is null)
     or (p_start_lat is not null and (p_start_lat not between -90 and 90 or p_start_lng not between -180 and 180)) then
    raise exception 'start must be a lat/lng pair on the globe' using errcode = 'invalid_parameter_value';
  end if;
  -- the lock every upload of this user waits on, until its transaction ends
  perform 1 from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id;
  -- merge: always null, never a drive to join; the finalize-trip before 0032 requires the key
  return jsonb_build_object('version', 23, 'phoneUse', true, 'existing', v_existing, 'merge', null);
end $function$;

-- apply_drive as 0029, every upload stored as its own drive: no join branch, no merged-away row,
-- no end point kept. An envelope's mergeInto and payload.end are not read.
create or replace function private.apply_drive(p jsonb)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_user uuid;
  pl jsonb;
  ev jsonb;
  ex jsonb;
  v_existing jsonb;
  v_trip uuid;
  v_client uuid;
  v_scored boolean;
  v_reason text;
  v_origin text;
  v_expired boolean;
  v_started timestamptz;
  v_ended timestamptz;
  v_week text;
  v_local_day date;
  v_tz text;
  v_miles numeric; v_night numeric; v_dur int; v_poly text;
  v_n int; v_sp int; v_hb int; v_ha int; v_hc int; v_nd int;
  v_exp record;
  v_slow int; v_up int; v_turn int; v_limit int; v_moving int; v_phone int;
  v_count_cap int;
  v_shift interval := interval '0';
  v_shift_ms numeric := 0;
  v_ev_ms numeric;
  v_challenges jsonb := '[]'::jsonb;
  v_achievements jsonb := '[]'::jsonb;
  v_resp jsonb;
  e jsonb;
  dc jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 1048576 then
    raise exception 'apply_drive needs an object under 1 MB' using errcode = 'invalid_parameter_value';
  end if;
  v_user := (p ->> 'user')::uuid;
  pl := p -> 'payload';
  ev := coalesce(p -> 'events', '[]'::jsonb);
  if v_user is null or jsonb_typeof(pl) is distinct from 'object' or jsonb_typeof(ev) is distinct from 'array'
     or jsonb_typeof(p -> 'scored') is distinct from 'boolean' or jsonb_array_length(ev) > 1000 then
    raise exception 'apply_drive needs user, payload, events and scored' using errcode = 'invalid_parameter_value';
  end if;
  v_client := (pl ->> 'clientTripId')::uuid;
  v_scored := (p ->> 'scored')::boolean;
  v_reason := p ->> 'reason';
  v_tz := pl ->> 'tz';
  -- (finalize-trip matches this message as a time-zone refusal, TZ_REFUSAL: keep it exactly)
  if v_client is null or v_tz is null or not private.is_known_tz(v_tz)
     or (v_reason is not null and v_reason not in ('too_short', 'spoofed', 'implausible'))
     or (pl ->> 'localDay') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'payload needs clientTripId, a known tz, localDay and a valid reason' using errcode = 'invalid_parameter_value';
  end if;
  if (pl ? 'origin' and (jsonb_typeof(pl -> 'origin') is distinct from 'string' or pl ->> 'origin' not in ('auto', 'manual')))
     or (pl ? 'notDrivingExpired' and jsonb_typeof(pl -> 'notDrivingExpired') is distinct from 'boolean') then
    raise exception 'origin must be auto or manual and notDrivingExpired a boolean' using errcode = 'invalid_parameter_value';
  end if;
  v_origin := coalesce(pl ->> 'origin', 'manual');
  v_expired := coalesce((pl ->> 'notDrivingExpired')::boolean, false);
  v_started := to_timestamp((pl ->> 'startedAt')::bigint / 1000.0);
  v_ended := to_timestamp((pl ->> 'endedAt')::bigint / 1000.0);
  v_local_day := (pl ->> 'localDay')::date;
  v_miles := (pl ->> 'miles')::numeric; v_night := (pl ->> 'nightMiles')::numeric;
  v_dur := (pl ->> 'durationS')::int;
  v_poly := coalesce(pl ->> 'polyline', '');
  if v_miles is null or v_night is null or v_dur is null or v_started is null or v_ended is null
     or v_miles not between 0 and 1000 or v_night not between 0 and v_miles
     or v_dur not between 0 and 43200 or char_length(v_poly) > 16384 or v_ended <= v_started or v_ended - v_started > interval '12 hours' then
    raise exception 'payload metrics are out of range' using errcode = 'invalid_parameter_value';
  end if;
  -- the clock: a drive dated to end more than 10 minutes from now would sit outside the rating's
  -- window today and count in full later, so it is moved back, start, end and events together, to
  -- end now (its length kept, its local day and week read again). Nothing is refused, so a phone
  -- with a wrong clock never loses a drive. A drive dated in the past is taken as dated: it weighs
  -- less (or nothing, past 90 days), which is no more than the driver could get by never uploading it.
  if v_ended > now() + interval '10 minutes' then
    v_shift := v_ended - now();
    v_shift_ms := extract(epoch from v_shift) * 1000;
    v_started := v_started - v_shift;
    v_ended := now();
    v_local_day := (v_started at time zone v_tz)::date;
  end if;
  -- DashPal: the stored seconds and their flag (absent = none)
  dc := case when jsonb_typeof(p -> 'dashcam') = 'object' then p -> 'dashcam' else null end;
  if not private.dashcam_valid(p -> 'dashcam', 86400, true) or not private.dashcam_valid(pl -> 'dashcam', 43200, false) then
    raise exception 'dashcam seconds are out of range' using errcode = 'invalid_parameter_value';
  end if;
  -- the upload's own opportunity counters, estimated from its own miles and duration when it sent
  -- none, clamped as scoring clampExposure clamps them
  ex := case when jsonb_typeof(pl -> 'exposure') = 'object' then pl -> 'exposure' else null end;
  if ex is not null and (
       jsonb_typeof(ex -> 'slowdowns') is distinct from 'number' or jsonb_typeof(ex -> 'speedups') is distinct from 'number'
       or jsonb_typeof(ex -> 'turns') is distinct from 'number' or jsonb_typeof(ex -> 'limitS') is distinct from 'number'
       or jsonb_typeof(ex -> 'movingS') is distinct from 'number'
       or (ex ->> 'slowdowns')::numeric not between 0 and 1000000 or (ex ->> 'speedups')::numeric not between 0 and 1000000
       or (ex ->> 'turns')::numeric not between 0 and 1000000 or (ex ->> 'limitS')::numeric not between 0 and 1000000
       or (ex ->> 'movingS')::numeric not between 0 and 1000000
       -- phoneS: a v5 upload's seconds at driving speed; a v4 upload has none (0)
       or (ex ? 'phoneS' and (jsonb_typeof(ex -> 'phoneS') is distinct from 'number' or (ex ->> 'phoneS')::numeric not between 0 and 1000000))) then
    raise exception 'exposure counters are out of range' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_exp from private.estimate_exposure(v_miles, v_dur);
  -- the counters are the phone's word, so each is held to what the drive itself allows (clamped,
  -- never refused, so a real drive is never lost): moving time within the drive's length and limit
  -- time within moving time; a slowdown or a speed-up needs a 12 mph swing (15 s of moving or more
  -- each) and a turn 60 degrees at 10 mph or more (10 s or more each); and no count above 40 a mile.
  -- The estimate's densest knot is 3 slowdowns or speed-ups and 2 turns a mile (a 10 mph average),
  -- and stop-and-go with a stop every 100 m is about 16 a mile, so 40 a mile (one every 40 m) is far
  -- above any real drive and only cuts a count claimed to dilute the drive's event rates.
  -- The times are held to the distance too: moving time accrues only at 5 mph or more (720 s a mile
  -- at most) and limit time and phone time only at 10 mph or more (360 s a mile at most), so moving
  -- time is cut to ceil(miles x 720 x 1.25) + 60 s and limit time and phone time to
  -- ceil(miles x 360 x 1.25) + 60 s, a quarter and a minute above anything a real drive can reach,
  -- and both within moving time. The products are taken in double precision, in the phone's order
  -- (boundExposure), so both cut to the same second. A drive with no counters, and a v4 upload,
  -- has no phone time: it was not watched for phone use.
  v_moving := least(v_dur, 43200, ceil(v_miles::float8 * 720::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'movingS')::numeric)::int, v_exp.moving_s));
  v_limit := least(v_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'limitS')::numeric)::int, v_exp.limit_s));
  v_phone := least(v_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'phoneS')::numeric)::int, 0));
  v_count_cap := least(20000, ceil(v_miles * 40)::int);
  v_slow := least(v_count_cap, greatest(1, ceil(v_moving / 15.0)::int), coalesce(floor((ex ->> 'slowdowns')::numeric)::int, v_exp.slowdowns));
  v_up := least(v_count_cap, greatest(1, ceil(v_moving / 15.0)::int), coalesce(floor((ex ->> 'speedups')::numeric)::int, v_exp.speedups));
  v_turn := least(v_count_cap, greatest(1, ceil(v_moving / 10.0)::int), coalesce(floor((ex ->> 'turns')::numeric)::int, v_exp.turns));

  perform 1 from public.progress where user_id = v_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = v_user and x.client_trip_id = v_client;
  if found then
    return v_existing;
  end if;
  v_week := private.league_week(v_started);

  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
      dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on,
      polyline, scored, reason, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s, phone_s,
      scoring_version, app_version)
    values (v_user, v_client, v_started, v_ended, v_local_day, v_week, v_tz, v_miles, v_night, v_dur,
      dc ->> 'deviceId', coalesce((dc ->> 'movingS')::int, 0), coalesce((dc ->> 'coveredS')::int, 0),
      coalesce((dc ->> 'synced')::boolean, false), coalesce((dc ->> 'on')::boolean, false),
      v_poly, v_scored, v_reason, v_origin, v_expired, v_slow, v_up, v_turn, v_limit, v_moving, v_phone,
      coalesce((p ->> 'scoringVersion')::int, 8), left(pl ->> 'appVersion', 32))
    returning id into v_trip;

  -- events: each new row is active (removal happens in dispute_event alone)
  for e in select x from jsonb_array_elements(ev) x loop
    if (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or e ->> 'type' not in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy')
       or e ->> 'tier' not in ('minor', 'moderate', 'severe') or (e ->> 'startedAt')::numeric is null or (e ->> 'durationS')::numeric is null
       -- a DashPal event is severe only
       or (e ->> 'type' in ('eyes_off', 'drowsy') and e ->> 'tier' <> 'severe') then
      raise exception 'event needs id, type, tier, startedAt and durationS' using errcode = 'invalid_parameter_value';
    end if;
    -- an id the upload already sent once is kept as first stored
    if exists (select 1 from public.trip_events x where x.trip_id = v_trip and x.client_event_id = (e ->> 'id')::uuid) then
      continue;
    end if;
    -- the event, moved with its drive when the clock rule moved it
    v_ev_ms := (e ->> 'startedAt')::numeric - v_shift_ms;
    if v_ev_ms not between extract(epoch from v_started) * 1000 - 60000 and extract(epoch from v_ended) * 1000 + 60000 then
      raise exception 'event starts outside the drive' using errcode = 'invalid_parameter_value';
    end if;
    -- a phone pickup (scoring phonePickupTier: moderate up to 15 s in hand, severe beyond) is in hand
    -- a whole number of seconds, from 1 to the drive's length, and starts inside the drive (no
    -- slack: the phone checked the same before it sent it)
    if e ->> 'type' = 'phone_pickup' and (
         e ->> 'tier' not in ('moderate', 'severe')
         or (e ->> 'durationS')::numeric <> floor((e ->> 'durationS')::numeric)
         or (e ->> 'durationS')::numeric not between 1 and v_dur
         or v_ev_ms not between extract(epoch from v_started) * 1000 and extract(epoch from v_ended) * 1000) then
      raise exception 'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it'
        using errcode = 'invalid_parameter_value';
    end if;
    if jsonb_typeof(e -> 'measured') = 'object' and pg_column_size(e -> 'measured') > 1024 then
      raise exception 'event measured is too large' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, zone, lat, lng, measured, status)
      values (v_trip, (e ->> 'id')::uuid, v_user, e ->> 'type', e ->> 'tier', to_timestamp(v_ev_ms / 1000.0),
        least(43200, greatest(0, (e ->> 'durationS')::numeric)), case when e ->> 'zone' in ('school', 'construction') then e ->> 'zone' end,
        (e ->> 'lat')::double precision, (e ->> 'lng')::double precision,
        case when jsonb_typeof(e -> 'measured') = 'object' then e -> 'measured' else '{}'::jsonb end,
        'active')
    on conflict (trip_id, client_event_id) do nothing;
  end loop;

  -- counts from the stored rows; DashPal events are counted apart, never in n_events or `clean`
  select count(*) filter (where x.type not in ('eyes_off', 'drowsy')), count(*) filter (where x.type = 'speeding'),
         count(*) filter (where x.type = 'hard_brake'), count(*) filter (where x.type = 'hard_accel'),
         count(*) filter (where x.type = 'hard_corner'), count(*) filter (where x.type in ('eyes_off', 'drowsy'))
    into v_n, v_sp, v_hb, v_ha, v_hc, v_nd
    from public.trip_events x where x.trip_id = v_trip and x.status = 'active';
  update public.trips set n_events = v_n, n_speeding = v_sp, n_hard_brake = v_hb, n_hard_accel = v_ha,
      n_hard_corner = v_hc, n_dashcam = v_nd, clean = v_scored and v_n = 0
    where id = v_trip;

  if v_scored then
    perform private.ensure_challenges(v_user, v_week);
    v_challenges := private.sync_challenges(v_user, v_week, v_trip);
    v_achievements := private.check_achievements(v_user, v_week);
  end if;
  perform private.refresh_rating(v_user);

  v_resp := jsonb_build_object(
    'tripId', v_trip, 'clientTripId', v_client,
    -- always null: every build of the app requires the key
    'mergedInto', null,
    'scored', v_scored, 'reason', v_reason,
    'eventIds', coalesce((select jsonb_agg(x.client_event_id order by x.started_at, x.client_event_id)
                          from public.trip_events x where x.trip_id = v_trip), '[]'::jsonb),
    'rating', (select jsonb_build_object('safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = v_user),
    'challenges', v_challenges, 'achievements', v_achievements);
  update public.trips set result = v_resp where id = v_trip;
  return v_resp;
end $function$;

-- export_account as 0030, without the clan; format 6 (no 'clan' key, and trips carry no merged_into)
create or replace function public.export_account(p_user uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_account jsonb;
begin
  perform public.require_service_role('export_account');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  select jsonb_build_object('user_id', u.id, 'email', u.email, 'created_at', u.created_at) into v_account from auth.users u where u.id = p_user;
  if v_account is null then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;
  return jsonb_build_object(
    'format', 'roadwise-export',
    'format_version', 6,
    'exported_at', now(),
    'about', jsonb_build_object('excluded', jsonb_build_array(
      'device push tokens and push delivery receipts', 'rate-limit counters')),
    'account', v_account,
    'profile', (select to_jsonb(p) - 'flagged' from public.profiles p where p.id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'platform', d.platform, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) order by d.created_at)
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'progress', (select to_jsonb(g) from public.progress g where g.user_id = p_user),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.client_event_id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    -- the routes of drives past the 183 days: lines only, in random order
    'route_pool', coalesce((select jsonb_agg(r.polyline order by r.id) from public.route_pool r where r.user_id = p_user), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at) from public.user_achievements a where a.user_id = p_user), '[]'::jsonb),
    'weekly_challenges', coalesce((select jsonb_agg(to_jsonb(w) order by w.league_week, w.slot) from public.weekly_challenges w where w.user_id = p_user), '[]'::jsonb),
    'friends', jsonb_build_object(
      'count', private.friend_count(p_user),
      'outgoing_requests', (select count(*) from public.friend_requests r where r.from_id = p_user),
      'incoming_requests', (select count(*) from public.friend_requests r where r.to_id = p_user),
      'blocked_count', (select count(*) from public.blocks b where b.blocker_id = p_user)),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('target_kind', r.target_kind, 'reason', r.reason, 'note', r.note, 'created_at', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(n) from public.notification_prefs n where n.user_id = p_user),
    'inbox', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'payload', i.payload - 'from_user_id', 'created_at', i.created_at) order by i.created_at)
      from public.inbox i where i.user_id = p_user), '[]'::jsonb));
end $function$;

-- every other reader of trips.merged_into, as its latest definition without the filter
create or replace function private.archive_old_routes(p_batch integer default 500)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ids uuid[];
  v_users uuid[];
begin
  if p_batch is null or p_batch not between 1 and 5000 then
    raise exception 'batch must be between 1 and 5000' using errcode = 'invalid_parameter_value';
  end if;
  v_ids := array(
    select t.id from public.trips t
    where t.archived_at is null and t.ended_at < now() - private.route_retention()
    order by t.ended_at
    limit p_batch
    for update skip locked);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  -- the routes pooled: a kept, scored drive's (what the phone's All trips map draws)
  v_users := array(
    select distinct t.user_id from public.trips t
    where t.id = any(v_ids) and t.scored and not t.not_driving and t.polyline <> '');
  if cardinality(v_users) > 0 then
    -- the order by builds the whole set first, so every old row is deleted before any is written again
    with moved as (
      delete from public.route_pool r where r.user_id = any(v_users)
      returning r.id, r.user_id, r.polyline)
    insert into public.route_pool (id, user_id, polyline)
      select x.id, x.user_id, x.polyline from (
        select m.id, m.user_id, m.polyline from moved m
        union all
        select gen_random_uuid(), t.user_id, t.polyline from public.trips t
        where t.id = any(v_ids) and t.scored and not t.not_driving and t.polyline <> '') x
      order by random();
  end if;
  update public.trip_events set lat = null, lng = null
    where trip_id = any(v_ids) and (lat is not null or lng is not null);
  update public.trips set polyline = '', archived_at = now() where id = any(v_ids);
  return cardinality(v_ids);
end $function$
;

create or replace function private.challenge_count(p_user uuid, p_week text, p_template text)
 returns integer
 language sql
 stable
 set search_path to 'public'
as $function$
  select count(*)::int from public.trips t
  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving
    and case p_template
          when 'no_speeding' then t.n_speeding = 0
          when 'smooth' then t.n_hard_brake + t.n_hard_accel + t.n_hard_corner = 0
          when 'clean' then t.clean
          else false end
$function$
;

create or replace function private.check_achievements(p_user uuid, p_week text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_new jsonb := '[]'::jsonb;
  v_id text;
begin
  for v_id in
    select a from unnest(array['first_drive', 'clean_100', 'perfect_week']) with ordinality as x(a, n)
    where not exists (select 1 from public.user_achievements u where u.user_id = p_user and u.achievement_id = a)
    order by n
  loop
    if (case v_id
         when 'first_drive' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and not t.not_driving)
         when 'clean_100' then coalesce((select sum(t.miles) from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving), 0) >= 100
         when 'perfect_week' then coalesce((select count(*) >= 3 and bool_and(t.clean) from public.trips t
                                   where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving), false)
         else false end)
    then
      insert into public.user_achievements (user_id, achievement_id) values (p_user, v_id) on conflict do nothing;
      v_new := v_new || to_jsonb(v_id);
    end if;
  end loop;
  return v_new;
end $function$
;

create or replace function private.dispute_event(p_user uuid, p_client_trip_id uuid, p_event_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  t public.trips%rowtype;
  e public.trip_events%rowtype;
  v_status text;
  v_n int; v_sp int; v_hb int; v_ha int; v_hc int; v_nd int;
begin
  if p_user is null or p_client_trip_id is null or p_event_id is null then
    raise exception 'user, clientTripId and eventId are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('hazard', 'wrong_limit', 'camera_wrong', 'mounted') then
    raise exception 'reason must be hazard, wrong_limit, camera_wrong or mounted' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select * into t from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id for update;
  if not found or t.not_driving then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  select * into e from public.trip_events x where x.trip_id = t.id and x.client_event_id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  -- a repeat of a stored report (same reason): its answer, nothing written again
  if exists (select 1 from public.event_disputes d
             where d.trip_id = t.id and d.client_event_id = p_event_id and d.user_id = p_user and d.reason = p_reason) then
    return private.dispute_answer(p_user, t.id, p_event_id);
  end if;
  if t.ended_at < now() - interval '7 days' then
    raise exception 'the drive is older than 7 days' using errcode = 'insufficient_privilege';
  end if;
  if e.status <> 'active' or exists (select 1 from public.event_disputes d where d.trip_id = t.id and d.client_event_id = p_event_id) then
    raise exception 'already disputed' using errcode = 'insufficient_privilege';
  end if;
  if (p_reason = 'hazard' and e.type <> 'hard_brake') or (p_reason = 'wrong_limit' and e.type <> 'speeding')
     or (p_reason = 'camera_wrong' and e.type not in ('eyes_off', 'drowsy')) or (p_reason = 'mounted' and e.type <> 'phone_pickup') then
    raise exception 'that reason does not apply to this event' using errcode = 'invalid_parameter_value';
  end if;
  v_status := case when private.dispute_quota_used(p_user, p_reason) < 3 then 'accepted' else 'rejected' end;
  insert into public.event_disputes (trip_id, client_event_id, user_id, reason, status) values (t.id, p_event_id, p_user, p_reason, v_status);
  if v_status = 'accepted' then
    update public.trip_events set status = 'removed' where trip_id = t.id and client_event_id = p_event_id;
    if p_reason = 'wrong_limit' and e.lat is not null and e.lng is not null then
      insert into public.map_feedback (lat, lng, limit_mph, speed_mph)
        values (e.lat, e.lng, least(120, greatest(0, (e.measured ->> 'limitMph')::numeric))::int, least(250, greatest(0, (e.measured ->> 'speedMph')::numeric))::int);
    end if;
    select count(*) filter (where x.type not in ('eyes_off', 'drowsy')), count(*) filter (where x.type = 'speeding'),
           count(*) filter (where x.type = 'hard_brake'), count(*) filter (where x.type = 'hard_accel'),
           count(*) filter (where x.type = 'hard_corner'), count(*) filter (where x.type in ('eyes_off', 'drowsy'))
      into v_n, v_sp, v_hb, v_ha, v_hc, v_nd
      from public.trip_events x where x.trip_id = t.id and x.status = 'active';
    update public.trips set n_events = v_n, n_speeding = v_sp, n_hard_brake = v_hb, n_hard_accel = v_ha,
        n_hard_corner = v_hc, n_dashcam = v_nd, clean = t.scored and v_n = 0
      where id = t.id;
    if t.scored then
      perform private.sync_challenges(p_user, t.league_week, t.id);
      perform private.check_achievements(p_user, t.league_week);
    end if;
    perform private.refresh_rating(p_user);
  end if;
  return private.dispute_answer(p_user, t.id, p_event_id);
end $function$
;

create or replace function private.drive_overlaps(p_user uuid, p_client_trip_id uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone)
 returns boolean
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if p_user is null or p_client_trip_id is null or p_started_at is null or p_ended_at is null then
    raise exception 'user, clientTripId, startedAt and endedAt are required' using errcode = 'invalid_parameter_value';
  end if;
  -- apply_drive's clock rule: a drive dated to end more than 10 minutes from now is stored ending now
  if p_ended_at > now() + interval '10 minutes' then
    p_started_at := p_started_at - (p_ended_at - now());
    p_ended_at := now();
  end if;
  return exists (
    select 1 from public.trips x
    where x.user_id = p_user and x.client_trip_id <> p_client_trip_id
      -- a stored drive lasts at most 12 hours (trips_time_order): the user's index range stays short
      and x.started_at > p_started_at - interval '12 hours'
      and x.started_at < p_ended_at - interval '1 minute'
      and x.ended_at > p_started_at + interval '1 minute');
end $function$
;

create or replace function private.mark_not_driving(p_user uuid, p_client_trip_id uuid)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  t public.trips%rowtype;
  v_uses int;
  v_with_events int;
begin
  if p_user is null or p_client_trip_id is null then
    raise exception 'user and clientTripId are required' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select * into t from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  if not t.not_driving then
    if t.not_driving_expired then
      raise exception 'the not driving option expired' using errcode = 'insufficient_privilege';
    end if;
    if t.ended_at < now() - interval '24 hours' then
      raise exception 'the drive is older than 24 hours' using errcode = 'insufficient_privilege';
    end if;
    if private.not_driving_left(p_user) <= 0 then
      raise exception 'no uses left this month' using errcode = 'insufficient_privilege';
    end if;
    update public.trips set not_driving = true, not_driving_at = now() where id = t.id;
    perform private.sync_challenges(p_user, t.league_week, null);
    perform private.refresh_rating(p_user);
    -- flag an account that mostly uses this on drives with events (DashPal events count too)
    select count(*), count(*) filter (where x.n_events + x.n_dashcam > 0) into v_uses, v_with_events
      from (select n_events, n_dashcam from public.trips x where x.user_id = p_user and x.not_driving order by x.not_driving_at desc limit 4) x;
    if v_uses >= 3 and v_with_events >= 3 then
      update public.profiles set flagged = true where id = p_user and not flagged;
    end if;
  end if;
  return jsonb_build_object('tripId', t.id, 'clientTripId', t.client_trip_id,
    'notDrivingLeft', private.not_driving_left(p_user),
    'rating', (select jsonb_build_object('safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = p_user));
end $function$
;

create or replace function private.produce_weekly_recaps(p_now timestamp with time zone default now())
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  r record;
  v_n int := 0;
  v_tz text;
  v_local timestamp;
  v_week text;
  v_utc timestamp := p_now at time zone 'UTC';
begin
  -- Sunday 18:xx somewhere on Earth lies between Saturday 04:00 and Monday 08:00 UTC; outside that
  -- window nothing can be due and the fact table is not scanned
  if not ((extract(isodow from v_utc) = 6 and extract(hour from v_utc) >= 4) or extract(isodow from v_utc) = 7
          or (extract(isodow from v_utc) = 1 and extract(hour from v_utc) < 8)) then
    return 0;
  end if;
  for r in
    select distinct t.user_id from public.trips t where t.started_at > p_now - interval '7 days'
  loop
    v_tz := private.user_tz(r.user_id);
    v_local := p_now at time zone v_tz;
    if extract(isodow from v_local) <> 7 or extract(hour from v_local) <> 18 then
      continue;
    end if;
    -- the week ending on this local Sunday ('IYYY-Www', the league week's format)
    v_week := to_char(v_local::date, 'IYYY-"W"IW');
    if private.week_drives(r.user_id, v_week) = 0 then
      continue;
    end if;
    insert into public.inbox (user_id, kind, payload, dedupe_key)
    select r.user_id, 'weekly_recap',
      jsonb_build_object(
        'week', v_week,
        -- a driver not ranked yet (under 10 mi in 90 days) is told nothing about a rating
        'rating', case when g.ranked then g.safety_rating end,
        'rating_delta', case when g.ranked and g.safety_rating is not null then g.safety_rating - private.rating_as_of(r.user_id, p_now - interval '7 days') end,
        'drives', private.week_drives(r.user_id, v_week),
        'goals_done', (select count(*)::int from public.weekly_challenges w
                       where w.user_id = r.user_id and w.league_week = v_week and w.completed_at is not null)),
      'weekly_recap:' || v_week
    from public.progress g where g.user_id = r.user_id
    on conflict (user_id, dedupe_key) do nothing;
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$
;

create or replace function private.rating_at(p_user uuid, p_at timestamp with time zone)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_miles numeric;
  bw float8; bo float8; aw float8; ao float8; tw float8; tow float8; sw float8; so float8; pw float8; po float8;
  ap float8; am float8;
  s_b float8; s_a float8; s_t float8; s_s float8; s_att float8; s_p float8;
  v_num float8; v_den float8;
begin
  if p_user is null or p_at is null then
    raise exception 'user and time are required' using errcode = 'invalid_parameter_value';
  end if;
  with d as materialized (
    select t.id, t.client_trip_id, t.started_at, t.miles, t.slowdowns, t.speedups, t.turns, t.limit_s, t.phone_s,
      private.recency_weight(floor(extract(epoch from (p_at - t.started_at)) / 86400)::int) as w,
      -- scoring watchedMiles: miles x the share of the moving seconds the dashcam covered
      case when t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0
           then t.miles::float8 * least(t.dashcam_covered_s, t.dashcam_moving_s)::float8 / t.dashcam_moving_s::float8
           else 0::float8 end as watched
    from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving
      and t.started_at > p_at - interval '2160 hours' and t.started_at <= p_at
  ),
  ev as (
    -- every category's weight, summed in the event order; its count
    select e.trip_id,
      sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_brake') as b_w,
      count(*) filter (where e.type = 'hard_brake') as b_n,
      sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_accel') as a_w,
      count(*) filter (where e.type = 'hard_accel') as a_n,
      sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_corner') as t_w,
      count(*) filter (where e.type = 'hard_corner') as t_n,
      sum(private.speeding_weight(e.duration_s, e.measured, e.tier) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding') as s_w,
      -- scoring speedingChargedS: max(1, duration), every second over the line
      sum(greatest(1::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding') as s_n,
      sum(private.phone_pickup_weight(e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup') as p_w,
      -- scoring phoneInHandS: the seconds in hand clamped to 0..43 200
      sum(least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup') as p_n,
      sum(private.attention_weight(e.type, e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type in ('eyes_off', 'drowsy')) as att
    from d join public.trip_events e on e.trip_id = d.id
    -- (a drive's events are its driver's: the user filter only lets the planner read them by user)
    where e.status = 'active' and e.user_id = p_user
    group by e.trip_id
  ),
  x as (
    select d.client_trip_id, d.started_at, d.miles, d.w, d.watched,
      d.w * coalesce(ev.b_w, 0::float8) as b_w,
      d.w * greatest(coalesce(d.slowdowns, 0), coalesce(ev.b_n, 0))::float8 as b_o,
      d.w * coalesce(ev.a_w, 0::float8) as a_w,
      d.w * greatest(coalesce(d.speedups, 0), coalesce(ev.a_n, 0))::float8 as a_o,
      d.w * coalesce(ev.t_w, 0::float8) as t_w,
      d.w * greatest(coalesce(d.turns, 0), coalesce(ev.t_n, 0))::float8 as t_o,
      d.w * coalesce(ev.s_w, 0::float8) as s_w,
      d.w * greatest(coalesce(d.limit_s, 0)::float8, coalesce(ev.s_n, 0::float8)) as s_o,
      d.w * coalesce(ev.p_w, 0::float8) as p_w,
      d.w * greatest(coalesce(d.phone_s, 0)::float8, coalesce(ev.p_n, 0::float8)) as p_o,
      d.w * coalesce(ev.att, 0::float8) as att
    from d left join ev on ev.trip_id = d.id
  )
  select coalesce(sum(greatest(x.miles, 0)), 0),
    coalesce(sum(x.b_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.b_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.a_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.a_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.t_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.t_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.s_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.s_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.p_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.p_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.att order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.w * x.watched order by x.started_at, x.client_trip_id), 0::float8)
    into v_miles, bw, bo, aw, ao, tw, tow, sw, so, pw, po, ap, am
  from x;
  if v_miles <= 0 then
    return jsonb_build_object('rating', null, 'ranked', false, 'miles', 0, 'scores', jsonb_build_object(
      'acceleration', null, 'braking', null, 'turning', null, 'attention', null, 'phone', null, 'speed', null));
  end if;
  -- scoring BASELINE: braking 0.010 / 60, acceleration 0.008 / 60, turning 0.008 / 60, speed 0.040 / 3600,
  -- phone 0.040 / 3600
  s_b := private.rate_score((bw + 60::float8 * 0.010::float8) / (bo + 60::float8), 0.010::float8);
  s_a := private.rate_score((aw + 60::float8 * 0.008::float8) / (ao + 60::float8), 0.008::float8);
  s_t := private.rate_score((tw + 60::float8 * 0.008::float8) / (tow + 60::float8), 0.008::float8);
  s_s := private.rate_score((sw + 3600::float8 * 0.040::float8) / (so + 3600::float8), 0.040::float8);
  -- not tracked, no score: no phone seconds and no pickup in the window (every drive before 0026)
  s_p := case when po > 0 then private.rate_score((pw + 3600::float8 * 0.040::float8) / (po + 3600::float8), 0.040::float8) end;
  s_att := case when am > 0 then private.category_score(ap, am, 10) end;
  -- the weighted mean in radar order (acceleration, braking, turning, attention, phone, speed), as
  -- weightedScore sums it; a null category adds 0 to the sum (x + 0 is x) and nothing to the weight
  v_num := 1::float8 * s_a + 1::float8 * s_b + 1::float8 * s_t + coalesce(1::float8 * s_att, 0::float8) + coalesce(2::float8 * s_p, 0::float8) + 2::float8 * s_s;
  v_den := (1 + 1 + 1 + case when s_att is null then 0 else 1 end + case when s_p is null then 0 else 2 end + 2)::float8;
  return jsonb_build_object(
    'rating', round(private.round_half_up(least(100::float8, greatest(0::float8, v_num / v_den)), 1)::numeric, 1),
    'ranked', v_miles >= 10, 'miles', v_miles,
    'scores', jsonb_build_object('acceleration', s_a, 'braking', s_b, 'turning', s_t, 'attention', s_att, 'phone', s_p, 'speed', s_s));
end $function$
;

create or replace function private.stat_sums(p_user uuid, p_since timestamp with time zone)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'miles', coalesce(sum(t.miles), 0),
    'durationS', coalesce(sum(t.duration_s), 0),
    'nightMiles', coalesce(sum(t.night_miles), 0),
    'drives', count(*),
    'cleanDrives', count(*) filter (where t.clean),
    'speeding', coalesce(sum(t.n_speeding), 0),
    'hardBrake', coalesce(sum(t.n_hard_brake), 0),
    'hardAccel', coalesce(sum(t.n_hard_accel), 0),
    'hardCorner', coalesce(sum(t.n_hard_corner), 0),
    'dashcamDrives', count(*) filter (where t.dashcam_on),
    'dashcamEvents', coalesce(sum(t.n_dashcam), 0))
  from public.trips t
  where t.user_id = p_user and t.scored and not t.not_driving
    and (p_since is null or t.started_at >= p_since)
$function$
;

create or replace function private.week_drives(p_user uuid, p_week text)
 returns integer
 language sql
 stable
 set search_path to 'public'
as $function$
  select count(*)::int from public.trips t
  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving
$function$
;

create or replace function public.get_heatmap(p_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
      where t.user_id = p_user_id and not t.not_driving and t.polyline <> ''
        and t.started_at > now() - interval '90 days'
      order by t.started_at desc
      limit 200
    ) t), '[]'::jsonb);
end $function$
;

create or replace function public.list_my_drives(p_before timestamp with time zone default null::timestamp with time zone, p_limit integer default 20)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'list_my_drives requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'limit must be between 1 and 50' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg((jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id,
      'startedAt', floor(extract(epoch from t.started_at) * 1000)::bigint,
      'endedAt', floor(extract(epoch from t.ended_at) * 1000)::bigint,
      'tz', t.tz, 'localDay', t.local_day,
      'miles', t.miles, 'nightMiles', t.night_miles, 'durationS', t.duration_s,
      'polyline', t.polyline, 'dashcamOn', t.dashcam_on, 'nDashcam', t.n_dashcam,
      'dashcamMovingS', t.dashcam_moving_s, 'dashcamCoveredS', t.dashcam_covered_s,
      'scored', t.scored, 'reason', t.reason, 'notDriving', t.not_driving, 'clean', t.clean,
      'origin', t.origin, 'notDrivingExpired', t.not_driving_expired,
      'exposure', jsonb_build_object('slowdowns', t.slowdowns, 'speedups', t.speedups, 'turns', t.turns,
                                     'limitS', t.limit_s, 'movingS', t.moving_s, 'phoneS', t.phone_s),
      'result', t.result,
      'archived', t.archived_at is not null,
      'events', private.trip_events_json(t.id))
    -- LEGACY (Phase B removes): keys a build from before 0026 requires
    || jsonb_build_object('pointsNet', null, 'safeMiles', 0)) order by t.started_at desc), '[]'::jsonb)
    into v_out
  from (
    select * from public.trips t
    where t.user_id = v_uid and (p_before is null or t.started_at < p_before)
    order by t.started_at desc
    limit p_limit
  ) t;
  return v_out;
end $function$
;

-- the merged-away rows: an unscored copy of one leg whose target holds its miles and events (no
-- event, dispute or challenge ever pointed at one), then the column, its index and its key
delete from public.trips where merged_into is not null;
alter table public.trips drop column if exists merged_into;

-- the end point the merge check read (its range checks go with it)
alter table public.progress drop column if exists last_end_lat;
alter table public.progress drop column if exists last_end_lng;
alter table public.progress drop column if exists last_end_at;
