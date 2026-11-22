-- 0046_store_audit: server fixes from the pre-submission audit. The only thing a driver can see
-- change is the weekly recap push's "up N" / "down N", which now always matches the line Home
-- shows when the push is opened.
--
--   * private.rating_at sums each drive's events once (`ev as materialized`). A session falls onto
--     its cached generic plan after 5 calls (the cron job, a warm finalize-trip connection, a pooled
--     PostgREST connection); that plan guesses one drive in the window and ran the whole per-drive
--     event aggregate again for every drive, so the cost grew with drives x events. Every answer is
--     the same: each sum is ordered on unique keys.
--   * Per-account budgets on three RPCs that had none, far above what the app sends:
--     - accept_terms: 10 new versions a day. A version already stored takes nothing; the app only
--       ever sends the one terms version it ships with, once per sign-in.
--     - set_notification_prefs: 30 time zones an hour. Only a zone other than the stored one is
--       checked against the server's zone list (a read of every zone file) and takes from the
--       budget; the stored zone was checked when it was written, so the zone the app sends with
--       every save takes nothing. An unknown zone is answered, not raised (PostgREST's error body
--       and the 400 the raise gave, so the app reads the same error), so its take stands.
--     - get_heatmap: 60 a minute (the app asks once per profile opened, kept 10 minutes).
--   * private.take_auth_mail drops the stale rows after it has locked its own (inbox, then pair,
--     then IP) instead of before. Dropped first, one call could lock a stale row another call was
--     about to take while that call held this inbox's row; the two then waited on each other until
--     send-email's 1 s lock timeout refused both. The caps and the answers are unchanged.
--   * 'auth-mail-purge', hourly at :25, deletes the send-email cap rows whose day started more than
--     47 hours ago, so a hash is gone at most 2 days after the last mail (before, only when the
--     next mail was sent, however long that took). Such a row has had no mail for at least 23 hours
--     (any mail a day after day_start starts the day again), so both its windows are over and
--     take_auth_mail treats its absence exactly as it treats the row: no cap changes.
--   * register_device: a push token belongs to one install. An iPhone reinstall keeps its Expo
--     token but mints a new install id, so the old install's row kept the token under the same
--     account, and a sign-out (which clears only the current row) left recaps, Wrapped and friend
--     request pushes going to the signed-out phone. Registering now clears the token from every
--     other row, the account's own included, as it already did for the push-to-start token; the
--     rows already sharing a token keep it only on the most recently seen. The phone still gets
--     each push once, through its current row.
--   * private.produce_weekly_recaps sends the change Home and Profile show: the stored rating less
--     the stored rating a week before it (get_my_summary's rating_trend), instead of the rating as
--     of the recap's time a week back, which counted a different week whenever the last refresh
--     was not at the recap's hour.
--   * trips_user_not_driving_idx: the month's "Wasn't driving" count (get_my_summary on every Home
--     open, mark_not_driving, mark_passenger_ride) reads the driver's marked drives instead of
--     every drive they ever recorded.
--
-- Same signatures, owners, security and search_paths; the grants are restated as they stand.
--
-- Deploy: this migration alone. No edge function or app change goes with it (send-email calls
-- take_auth_mail as before, push-sender reads the same recap payload).

-- ---------------------------------------------------------------------------
-- the Safety Rating: each drive's events summed once
-- ---------------------------------------------------------------------------
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
  -- materialized: computed once, whatever the plan (a generic plan that guesses one drive would
  -- otherwise run the whole aggregate again for every drive)
  ev as materialized (
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

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
-- accept_terms(p_version): records the 13+ and terms attestation (append-only); a version not yet
-- stored takes one of 10 a day
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
    perform private.require_rate_limit(v_uid, 'accept_terms', interval '1 day', 10);
    insert into public.consents (user_id, kind, version) values (v_uid, 'terms_13_plus', p_version);
  end if;
end $$;

-- set_notification_prefs(...): each null = unchanged; times as 'HH:MM'. A zone other than the
-- stored one takes one of 30 an hour before the zone list is read; an unknown zone is answered as
-- PostgREST's error body with a 400 (what the raise gave), so the take stands.
create or replace function public.set_notification_prefs(p_weekly_recap boolean default null, p_leagues boolean default null, p_social boolean default null,
  p_quiet_enabled boolean default null, p_quiet_start text default null, p_quiet_end text default null, p_tz text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'set_notification_prefs requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if (p_quiet_start is not null and p_quiet_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     or (p_quiet_end is not null and p_quiet_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'quiet hours must be HH:MM' using errcode = 'invalid_parameter_value';
  end if;
  -- the stored zone was checked when it was written: the zone sent with every save reads no zone file
  if p_tz is not null and not exists (select 1 from public.notification_prefs p where p.user_id = v_uid and p.tz = p_tz) then
    perform private.require_rate_limit(v_uid, 'set_notification_tz', interval '1 hour', 30);
    if not private.is_known_tz(p_tz) then
      return private.refusal('22023', 'unknown time zone', 400);
    end if;
  end if;
  insert into public.notification_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.notification_prefs set
    weekly_recap = coalesce(p_weekly_recap, weekly_recap),
    leagues = coalesce(p_leagues, leagues),
    social = coalesce(p_social, social),
    quiet_enabled = coalesce(p_quiet_enabled, quiet_enabled),
    quiet_start = coalesce(p_quiet_start::time, quiet_start),
    quiet_end = coalesce(p_quiet_end::time, quiet_end),
    tz = coalesce(p_tz, tz)
  where user_id = v_uid;
  return public.get_notification_prefs();
end $$;

-- get_heatmap(p_user_id): the driver's own routes, or a friend's who shares them; 60 a minute
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
  perform private.require_rate_limit(v_uid, 'get_heatmap', interval '1 minute', 60);
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

-- ---------------------------------------------------------------------------
-- the send-email caps: stale rows dropped after the call's own rows are locked, and hourly
-- ---------------------------------------------------------------------------
-- one mail for the inbox, the inbox from this IP and the IP whose SHA-256s are given (pair and ip
-- both null when Auth reported no IP): 'ok' when taken for all of them, else which cap is full
-- ('pair', 'address', then 'ip'), with nothing taken
create or replace function private.take_auth_mail(p_address_hash bytea, p_pair_hash bytea, p_ip_hash bytea) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_address_hour int;
  v_address_day int;
  v_pair_hour int;
  v_pair_day int;
  v_ip_hour int;
  v_ip_day int;
  v_full text;
begin
  if p_address_hash is null or octet_length(p_address_hash) <> 32 then
    raise exception 'a 32-byte address hash is required' using errcode = 'invalid_parameter_value';
  end if;
  if (p_pair_hash is null) <> (p_ip_hash is null) then
    raise exception 'the pair and ip hashes come together or not at all' using errcode = 'invalid_parameter_value';
  end if;
  if p_ip_hash is not null and (octet_length(p_ip_hash) <> 32 or octet_length(p_pair_hash) <> 32
      or p_ip_hash = p_address_hash or p_pair_hash = p_address_hash or p_pair_hash = p_ip_hash) then
    raise exception 'the pair and ip hashes must be 32 bytes and all three different' using errcode = 'invalid_parameter_value';
  end if;
  -- always the inbox first, then the pair, then the IP: two calls never wait on each other in a
  -- circle (the three kinds of key never share a hash)
  select o_hour_count, o_day_count into v_address_hour, v_address_day from private.auth_mail_window(p_address_hash);
  if p_ip_hash is null then
    if v_address_hour >= 5 or v_address_day >= 10 then
      v_full := 'address';
    end if;
  else
    select o_hour_count, o_day_count into v_pair_hour, v_pair_day from private.auth_mail_window(p_pair_hash);
    if v_pair_hour >= 5 or v_pair_day >= 10 then
      v_full := 'pair';
    elsif v_address_hour >= 20 or v_address_day >= 30 then
      v_full := 'address';
    else
      select o_hour_count, o_day_count into v_ip_hour, v_ip_day from private.auth_mail_window(p_ip_hash);
      if v_ip_hour >= 20 or v_ip_day >= 50 then
        v_full := 'ip';
      end if;
    end if;
  end if;
  if v_full is null then
    update private.auth_mail_sends
       set hour_count = hour_count + 1, day_count = day_count + 1
     where key_hash = p_address_hash or key_hash = p_pair_hash or key_hash = p_ip_hash;
  end if;
  -- rows whose day ended more than a day ago, dropped only now that this call holds its own: from
  -- here on it never waits (skip locked), so no call waits on it while it waits on that call.
  -- Dropped first, two calls could each lock a row the other needed next.
  delete from private.auth_mail_sends
   where key_hash in (select key_hash from private.auth_mail_sends
                       where day_start < now() - interval '2 days' for update skip locked);
  return coalesce(v_full, 'ok');
end $$;

-- hourly: a row whose day started more than 47 hours ago goes, so no hash outlives its last mail by
-- more than 2 days; a row a send-email call holds waits for the next run (skip locked)
select cron.schedule('auth-mail-purge', '25 * * * *',
  $$delete from private.auth_mail_sends where key_hash in (select key_hash from private.auth_mail_sends where day_start < now() - interval '47 hours' for update skip locked)$$);

-- ---------------------------------------------------------------------------
-- register_device: a push token on one row only
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
  -- the push token belongs to one install: no other row keeps it, the account's own included (an
  -- iPhone reinstall keeps its Expo token under a new install id)
  if p_push_token is not null then
    update public.devices set push_token = null where push_token = p_push_token and not (user_id = v_uid and device_id = p_device_id);
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

-- a token several rows share stays only on the most recently seen (the phone's current install)
update public.devices d set push_token = null
 where d.push_token is not null
   and exists (select 1 from public.devices o
               where o.push_token = d.push_token
                 and (o.last_seen_at, o.device_id, o.user_id) > (d.last_seen_at, d.device_id, d.user_id));

-- ---------------------------------------------------------------------------
-- the weekly recap: the change Home shows
-- ---------------------------------------------------------------------------
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
  -- Sunday 18:xx somewhere on Earth (UTC+14 .. UTC-12) lies between Sunday 04:00 and Monday 07:00
  -- UTC (Monday before 08:00 kept as a margin); outside that window nothing can be due and the fact
  -- table is not scanned
  if not ((extract(isodow from v_utc) = 7 and extract(hour from v_utc) >= 4)
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
        -- the change Home and Profile show (get_my_summary's rating_trend): the stored rating less
        -- the rating 7 days before it, both written by the same refresh
        'rating_delta', case when g.ranked and g.safety_rating is not null then g.safety_rating - g.rating_week_ago end,
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

-- ---------------------------------------------------------------------------
-- the month's "Wasn't driving" count: the driver's marked drives only
-- ---------------------------------------------------------------------------
create index if not exists trips_user_not_driving_idx on public.trips (user_id, not_driving_at) where not_driving;

-- ---------------------------------------------------------------------------
-- grants, as they stand (a replaced function keeps its owner and grants)
-- ---------------------------------------------------------------------------
revoke all on function private.rating_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.take_auth_mail(bytea, bytea, bytea) from public, anon, authenticated;
revoke all on function private.produce_weekly_recaps(timestamptz) from public, anon, authenticated;
revoke all on function public.accept_terms(text) from public, anon, authenticated;
revoke all on function public.set_notification_prefs(boolean, boolean, boolean, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.get_heatmap(uuid) from public, anon, authenticated;
revoke all on function public.register_device(text, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_terms(text) to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean, boolean, text, text, text) to authenticated;
grant execute on function public.get_heatmap(uuid) to authenticated;
grant execute on function public.register_device(text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
