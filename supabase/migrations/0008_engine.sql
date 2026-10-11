-- 0008_engine: the server-only drive engine the finalize-trip and trip-actions edge functions
-- call over a direct connection, inside ONE transaction per request:
--
--   private.drive_context(...)            lock progress, lazy freeze grant, idempotency, streak
--                                         state, daily-cap and loop context, the merge target
--   private.apply_drive(p)                write trip + events + ledger + progress (reverting a
--                                         merge target first), league placement, challenges,
--                                         achievements, rating; returns the stored response
--   private.revert_latest_not_driving(..) "Wasn't driving" on the latest drive
--   private.dispute_context(...) / private.apply_dispute(p)   event disputes
--   public.get_my_summary()               the Home header, in one call
--
-- Exact signatures and JSON shapes: .agent/v3/backend-interface.md. Scoring itself is TypeScript
-- (packages/scoring); SQL only stores, derives and reverts.

-- metres between two points (spherical)
create or replace function private.distance_m(p_lat1 double precision, p_lng1 double precision, p_lat2 double precision, p_lng2 double precision) returns double precision
language sql immutable set search_path = public as $$
  select extensions.st_distancesphere(extensions.st_makepoint(p_lng1, p_lat1), extensions.st_makepoint(p_lng2, p_lat2))
$$;

create or replace function private.progress_snapshot(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level, 'streak', g.streak, 'at_risk', g.at_risk,
    'freezes', g.freezes, 'freezes_granted_at', g.freezes_granted_at, 'clean_run', g.clean_run, 'freeze_progress', g.freeze_progress,
    'phone_free_run', g.phone_free_run, 'last_end_lat', g.last_end_lat, 'last_end_lng', g.last_end_lng, 'last_end_at', g.last_end_at)
  from public.progress g where g.user_id = p_user
$$;

create or replace function private.restore_progress(p_user uuid, p_snap jsonb) returns void
language plpgsql volatile set search_path = public as $$
begin
  if p_snap is null or p_snap = '{}'::jsonb then
    raise exception 'no progress snapshot to restore' using errcode = 'no_data_found';
  end if;
  update public.progress set
    points = (p_snap ->> 'points')::int,
    lifetime = (p_snap ->> 'lifetime')::int,
    level = (p_snap ->> 'level')::int,
    streak = (p_snap ->> 'streak')::int,
    at_risk = (p_snap ->> 'at_risk')::boolean,
    freezes = (p_snap ->> 'freezes')::int,
    freezes_granted_at = (p_snap ->> 'freezes_granted_at')::timestamptz,
    clean_run = (p_snap ->> 'clean_run')::int,
    freeze_progress = (p_snap ->> 'freeze_progress')::int,
    phone_free_run = (p_snap ->> 'phone_free_run')::int,
    last_end_lat = (p_snap ->> 'last_end_lat')::double precision,
    last_end_lng = (p_snap ->> 'last_end_lng')::double precision,
    last_end_at = (p_snap ->> 'last_end_at')::timestamptz
  where user_id = p_user;
end $$;

-- undo a drive's points: restore the snapshot, cancel its ledger rows, take back its challenges
create or replace function private.revert_trip(p_user uuid, p_trip uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_snap jsonb;
  v_rev int;
  v_sum int;
begin
  select t.progress_before, t.rev into v_snap, v_rev from public.trips t where t.id = p_trip and t.user_id = p_user for update;
  if not found then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  perform private.restore_progress(p_user, v_snap);
  perform private.revert_challenges_of_trip(p_user, p_trip);
  select coalesce(sum(l.amount), 0) into v_sum from public.points_ledger l where l.trip_id = p_trip and l.kind <> 'challenge';
  if v_sum <> 0 then
    insert into public.points_ledger (user_id, key, amount, kind, trip_id)
      values (p_user, 'revert:' || p_trip || ':' || v_rev, -v_sum, 'revert', p_trip)
      on conflict (user_id, key) do nothing;
  end if;
end $$;

-- the progress part of a response
create or replace function private.progress_json(p_user uuid, p_level_up boolean) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level, 'levelUp', p_level_up,
    'safetyRating', g.safety_rating, 'ranked', g.ranked)
  from public.progress g where g.user_id = p_user
$$;

-- accepted disputes this league week in p_reason's auto-accept quota (3 each): camera_wrong
-- ("DashPal got it wrong") has its own; hazard and wrong_limit share one
create or replace function private.dispute_quota_used(p_user uuid, p_reason text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.event_disputes d
  where d.user_id = p_user and d.status = 'accepted' and d.created_at >= private.week_start(now())
    and case when p_reason = 'camera_wrong' then d.reason = 'camera_wrong' else d.reason in ('hazard', 'wrong_limit') end
$$;

create or replace function private.not_driving_left(p_user uuid) returns int
language sql stable set search_path = public as $$
  select greatest(0, 2 - (select count(*)::int from public.trips t
    where t.user_id = p_user and t.not_driving and t.not_driving_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'))
$$;

-- ---------------------------------------------------------------------------
-- drive_context
-- ---------------------------------------------------------------------------
create or replace function private.drive_context(p_user uuid, p_client_trip_id uuid, p_started_at timestamptz, p_local_day date,
  p_start_lat double precision, p_start_lng double precision, p_ended_at timestamptz default null) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  g public.progress%rowtype;
  t public.trips%rowtype;
  v_existing jsonb;
  v_week text;
  v_eligible boolean;
  v_merge jsonb := null;
begin
  if p_user is null or p_client_trip_id is null or p_started_at is null or p_local_day is null then
    raise exception 'user, clientTripId, startedAt and localDay are required' using errcode = 'invalid_parameter_value';
  end if;
  if (p_start_lat is null) <> (p_start_lng is null)
     or (p_start_lat is not null and (p_start_lat not between -90 and 90 or p_start_lng not between -180 and 180)) then
    raise exception 'start must be a lat/lng pair on the globe' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  perform private.apply_freeze_grant(p_user);
  select x.result into v_existing from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id;
  if found then
    return jsonb_build_object('existing', v_existing);
  end if;
  select * into g from public.progress where user_id = p_user;
  select p.league_eligible into v_eligible from public.profiles p where p.id = p_user;
  v_week := private.league_week(p_started_at);
  perform private.ensure_challenges(p_user, v_week);

  -- the merge target: the latest kept drive, ended at most 300 s before this start, whose end
  -- (held only in progress.last_end_*) is within 402 m of this start
  select * into t from public.trips x
    where x.user_id = p_user and x.merged_into is null
    order by x.started_at desc limit 1;
  if found and not t.not_driving and t.reason is distinct from 'spoofed' and t.reason is distinct from 'implausible'
     and t.ended_at <= p_started_at and p_started_at - t.ended_at <= interval '300 seconds'
     and g.last_end_at = t.ended_at and g.last_end_lat is not null and p_start_lat is not null
     and private.distance_m(g.last_end_lat, g.last_end_lng, p_start_lat, p_start_lng) <= 402
     -- the union stays within the 12-hour drive bound; otherwise this is a separate drive
     and (p_ended_at is null or p_ended_at - t.started_at <= interval '12 hours') then
    v_merge := jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id, 'reason', t.reason,
      'startedAt', floor(extract(epoch from t.started_at) * 1000)::bigint,
      'endedAt', floor(extract(epoch from t.ended_at) * 1000)::bigint,
      'tz', t.tz, 'localDay', t.local_day,
      'miles', t.miles, 'safeMiles', t.safe_miles, 'nightMiles', t.night_miles, 'durationS', t.duration_s,
      'polyline', t.polyline,
      'events', private.trip_events_json(t.id),
      'dashcam', jsonb_build_object('deviceId', t.dashcam_device_id, 'movingS', t.dashcam_moving_s,
        'coveredS', t.dashcam_covered_s, 'synced', t.dashcam_synced),
      'isLoop', t.is_loop, 'loopRepeat', t.loop_repeat,
      'safeMilesEarlierToday', t.safe_miles_earlier_today,
      'streak', jsonb_build_object('streak', (t.progress_before ->> 'streak')::int, 'atRisk', (t.progress_before ->> 'at_risk')::boolean,
        'freezes', (t.progress_before ->> 'freezes')::int, 'cleanRun', (t.progress_before ->> 'clean_run')::int));
  end if;

  return jsonb_build_object(
    'existing', null,
    'week', v_week,
    'leagueEligible', coalesce(v_eligible, false),
    'streak', jsonb_build_object('streak', g.streak, 'atRisk', g.at_risk, 'freezes', g.freezes, 'cleanRun', g.clean_run),
    'safeMilesEarlierToday', coalesce((select sum(x.safe_miles) from public.trips x
      where x.user_id = p_user and x.local_day = p_local_day and x.scored and not x.not_driving and x.merged_into is null
        and x.started_at < p_started_at), 0),
    'loopDrivesToday', (select count(*) from public.trips x
      where x.user_id = p_user and x.local_day = p_local_day and x.is_loop and not x.not_driving and x.merged_into is null
        and x.started_at < p_started_at),
    'merge', v_merge);
end $$;

-- ---------------------------------------------------------------------------
-- apply_drive
-- ---------------------------------------------------------------------------
-- p.dashcam = { deviceId, movingS, coveredS, synced, on }: the DashPal seconds of what is stored
-- (the union on a merge, summed by finalize-trip) and the DashPal-drive flag derived from them;
-- p.payload.dashcam = the upload's own (kept on a merged-away row). Both optional: absent = none.
create or replace function private.dashcam_valid(d jsonb, p_max int, p_with_on boolean) returns boolean
language sql immutable set search_path = public as $$
  select d is null or jsonb_typeof(d) = 'null' or (
    jsonb_typeof(d) = 'object'
    and (jsonb_typeof(d -> 'deviceId') = 'null' or d -> 'deviceId' is null or (jsonb_typeof(d -> 'deviceId') = 'string' and (d ->> 'deviceId') ~ '^[0-9a-f]{12}$'))
    and jsonb_typeof(d -> 'movingS') = 'number' and jsonb_typeof(d -> 'coveredS') = 'number' and jsonb_typeof(d -> 'synced') = 'boolean'
    and (d ->> 'movingS')::numeric = trunc((d ->> 'movingS')::numeric) and (d ->> 'coveredS')::numeric = trunc((d ->> 'coveredS')::numeric)
    and (d ->> 'movingS')::numeric between 0 and p_max and (d ->> 'coveredS')::numeric between 0 and (d ->> 'movingS')::numeric
    and (not p_with_on or (jsonb_typeof(d -> 'on') = 'boolean'
      -- the one rule (scoring dashcamDrive): synced, >= 60 s moving, >= 80 % of it covered
      and (d ->> 'on')::boolean = ((d ->> 'synced')::boolean and (d ->> 'movingS')::numeric >= 60
                                   and (d ->> 'coveredS')::numeric * 100 >= 80 * (d ->> 'movingS')::numeric))))
$$;

create or replace function private.apply_drive(p jsonb) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_user uuid;
  pl jsonb;
  ev jsonb;
  bd jsonb;
  st jsonb;
  v_existing jsonb;
  v_merge uuid;
  tgt public.trips%rowtype;
  v_trip uuid;
  v_client uuid;
  v_scored boolean;
  v_reason text;
  v_net int;
  v_started timestamptz;
  v_ended timestamptz;
  v_week text;
  v_local_day date;
  v_tz text;
  v_miles numeric; v_safe numeric; v_night numeric; v_dur int; v_poly text;
  v_rev int := 1;
  v_snap jsonb;
  v_level_before int;
  v_level_after int;
  v_n int; v_sp int; v_pk int; v_hs int; v_hb int; v_ha int; v_hc int; v_nd int;
  v_clean boolean;
  v_after jsonb;
  v_league jsonb;
  v_challenges jsonb := '[]'::jsonb;
  v_achievements jsonb := '[]'::jsonb;
  v_resp jsonb;
  v_end_lat double precision; v_end_lng double precision;
  e jsonb;
  dc jsonb;
  pdc jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 1048576 then
    raise exception 'apply_drive needs an object under 1 MB' using errcode = 'invalid_parameter_value';
  end if;
  v_user := (p ->> 'user')::uuid;
  pl := p -> 'payload';
  ev := coalesce(p -> 'events', '[]'::jsonb);
  bd := coalesce(p -> 'breakdown', '{}'::jsonb);
  st := p -> 'streak';
  if v_user is null or jsonb_typeof(pl) is distinct from 'object' or jsonb_typeof(ev) is distinct from 'array' or jsonb_typeof(bd) is distinct from 'object'
     or jsonb_typeof(st) is distinct from 'object' or jsonb_typeof(p -> 'scored') is distinct from 'boolean' or jsonb_array_length(ev) > 1000 then
    raise exception 'apply_drive needs user, payload, events, breakdown, streak and scored' using errcode = 'invalid_parameter_value';
  end if;
  v_client := (pl ->> 'clientTripId')::uuid;
  v_scored := (p ->> 'scored')::boolean;
  v_reason := p ->> 'reason';
  v_net := case when v_scored then coalesce((p ->> 'net')::int, 0) else 0 end;
  v_merge := (p ->> 'mergeInto')::uuid;
  v_tz := pl ->> 'tz';
  if v_client is null or v_tz is null or not private.is_known_tz(v_tz)
     or (v_reason is not null and v_reason not in ('too_short', 'spoofed', 'implausible'))
     or (pl ->> 'localDay') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'payload needs clientTripId, a known tz, localDay and a valid reason' using errcode = 'invalid_parameter_value';
  end if;
  v_started := to_timestamp((pl ->> 'startedAt')::bigint / 1000.0);
  v_ended := to_timestamp((pl ->> 'endedAt')::bigint / 1000.0);
  v_local_day := (pl ->> 'localDay')::date;
  v_miles := (pl ->> 'miles')::numeric; v_safe := (pl ->> 'safeMiles')::numeric; v_night := (pl ->> 'nightMiles')::numeric;
  v_dur := (pl ->> 'durationS')::int;
  v_poly := coalesce(pl ->> 'polyline', '');
  if v_miles is null or v_safe is null or v_night is null or v_dur is null or v_started is null or v_ended is null
     or v_miles not between 0 and 1000 or v_safe not between 0 and v_miles or v_night not between 0 and v_miles
     or v_dur not between 0 and 43200 or char_length(v_poly) > 16384 or v_ended <= v_started or v_ended - v_started > interval '12 hours' then
    raise exception 'payload metrics are out of range' using errcode = 'invalid_parameter_value';
  end if;
  if pg_column_size(bd) > 65536 then
    raise exception 'breakdown is too large' using errcode = 'invalid_parameter_value';
  end if;
  if v_net not between -20000 and 20000 or coalesce((bd ->> 'ratingPenalty')::numeric, 0) not between 0 and 20000 then
    raise exception 'net or ratingPenalty is out of range' using errcode = 'invalid_parameter_value';
  end if;
  -- DashPal: the stored seconds and their flag (absent = none); the breakdown's x1.25 must agree with the flag
  dc := case when jsonb_typeof(p -> 'dashcam') = 'object' then p -> 'dashcam' else null end;
  pdc := case when jsonb_typeof(pl -> 'dashcam') = 'object' then pl -> 'dashcam' else null end;
  if not private.dashcam_valid(p -> 'dashcam', 86400, true) or not private.dashcam_valid(pl -> 'dashcam', 43200, false)
     or (bd ? 'dashcamMult' and (bd ->> 'dashcamMult')::numeric <> case when coalesce((dc ->> 'on')::boolean, false) then 1.25 else 1 end) then
    raise exception 'dashcam seconds are out of range' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(pl -> 'end') = 'object' then
    v_end_lat := (pl -> 'end' ->> 'lat')::double precision;
    v_end_lng := (pl -> 'end' ->> 'lng')::double precision;
    if v_end_lat is null or v_end_lng is null or v_end_lat not between -90 and 90 or v_end_lng not between -180 and 180 then
      raise exception 'end must be a lat/lng pair on the globe' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  perform 1 from public.progress where user_id = v_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = v_user and x.client_trip_id = v_client;
  if found then
    return v_existing;
  end if;

  -- merge: revert the target, then write the union into its row
  if v_merge is not null then
    select * into tgt from public.trips x where x.id = v_merge and x.user_id = v_user for update;
    if not found or tgt.merged_into is not null or tgt.not_driving or tgt.reason in ('spoofed', 'implausible') then
      raise exception 'merge target not found' using errcode = 'no_data_found';
    end if;
    perform private.revert_trip(v_user, tgt.id);
    v_rev := tgt.rev + 1;
    v_started := tgt.started_at;
    v_local_day := tgt.local_day;
    v_tz := tgt.tz;
    v_miles := tgt.miles + v_miles; v_safe := tgt.safe_miles + v_safe; v_night := tgt.night_miles + v_night;
    v_dur := tgt.duration_s + v_dur;
    -- the route is a list of visible runs (encoded polylines joined by single spaces, each decoded
    -- on its own): the union carries both drives' runs, target first. They are never joined into
    -- one line - that would draw a chord across the stop the trimming hides. Over the column limit
    -- the longer of the two is kept instead.
    v_poly := case when coalesce(tgt.polyline, '') = '' then v_poly
                   when v_poly = '' then tgt.polyline
                   when char_length(tgt.polyline) + 1 + char_length(v_poly) <= 65536 then tgt.polyline || ' ' || v_poly
                   when char_length(v_poly) > char_length(tgt.polyline) then v_poly
                   else tgt.polyline end;
    v_trip := tgt.id;
    if v_ended - v_started > interval '12 hours' then
      raise exception 'merged drive would exceed 12 hours' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_week := private.league_week(v_started);
  v_snap := private.progress_snapshot(v_user);
  v_level_before := (v_snap ->> 'level')::int;

  -- the trip row first (counts follow once the events are stored)
  v_n := 0; v_sp := 0; v_pk := 0; v_hs := 0; v_hb := 0; v_ha := 0; v_hc := 0; v_nd := 0;
  v_clean := false;
  if v_merge is null then
    insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s,
        dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on,
        polyline, scored, reason, is_loop, loop_repeat, safe_miles_earlier_today, points_net, breakdown, rating_penalty,
        n_events, n_speeding, n_pickup, handling_s, n_hard_brake, n_hard_accel, n_hard_corner, n_dashcam, clean, streak_before,
        progress_before, rev, scoring_version, app_version)
      values (v_user, v_client, v_started, v_ended, v_local_day, v_week, v_tz, v_miles, v_safe, v_night, v_dur,
        dc ->> 'deviceId', coalesce((dc ->> 'movingS')::int, 0), coalesce((dc ->> 'coveredS')::int, 0),
        coalesce((dc ->> 'synced')::boolean, false), coalesce((dc ->> 'on')::boolean, false),
        v_poly, v_scored, v_reason, coalesce((p ->> 'isLoop')::boolean, false), coalesce((p ->> 'loopRepeat')::boolean, false),
        coalesce((p ->> 'safeMilesEarlierToday')::numeric, 0), v_net, bd, coalesce((bd ->> 'ratingPenalty')::int, 0),
        v_n, v_sp, v_pk, v_hs, v_hb, v_ha, v_hc, v_nd, v_clean, coalesce((st -> 'before' ->> 'streak')::int, 0),
        v_snap, 1, coalesce((p ->> 'scoringVersion')::int, 3), left(pl ->> 'appVersion', 32))
      returning id into v_trip;
  else
    update public.trips set ended_at = v_ended, miles = v_miles, safe_miles = v_safe, night_miles = v_night, duration_s = v_dur,
        dashcam_device_id = dc ->> 'deviceId', dashcam_moving_s = coalesce((dc ->> 'movingS')::int, 0),
        dashcam_covered_s = coalesce((dc ->> 'coveredS')::int, 0), dashcam_synced = coalesce((dc ->> 'synced')::boolean, false),
        dashcam_on = coalesce((dc ->> 'on')::boolean, false),
        polyline = v_poly, scored = v_scored, reason = v_reason,
        loop_repeat = coalesce((p ->> 'loopRepeat')::boolean, loop_repeat), points_net = v_net, breakdown = bd,
        rating_penalty = coalesce((bd ->> 'ratingPenalty')::int, 0),
        n_events = v_n, n_speeding = v_sp, n_pickup = v_pk, handling_s = v_hs, n_hard_brake = v_hb, n_hard_accel = v_ha, n_hard_corner = v_hc,
        clean = v_clean, streak_before = coalesce((st -> 'before' ->> 'streak')::int, 0),
        progress_before = v_snap, rev = v_rev, scoring_version = coalesce((p ->> 'scoringVersion')::int, scoring_version)
      where id = v_trip;
  end if;

  -- events: penalties from the breakdown by id. A new row is always active; an existing row keeps
  -- `removed` only if it already was (removal happens in apply_dispute alone), whatever the input says.
  for e in select x from jsonb_array_elements(ev) x loop
    if (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or e ->> 'type' not in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'phone_handling', 'eyes_off', 'drowsy')
       or e ->> 'tier' not in ('minor', 'moderate', 'severe') or (e ->> 'startedAt')::numeric is null or (e ->> 'durationS')::numeric is null
       -- a DashPal event is severe only
       or (e ->> 'type' in ('eyes_off', 'drowsy') and e ->> 'tier' <> 'severe') then
      raise exception 'event needs id, type, tier, startedAt and durationS' using errcode = 'invalid_parameter_value';
    end if;
    if (e ->> 'startedAt')::numeric not between extract(epoch from v_started) * 1000 - 60000 and extract(epoch from v_ended) * 1000 + 60000 then
      raise exception 'event starts outside the drive' using errcode = 'invalid_parameter_value';
    end if;
    if jsonb_typeof(e -> 'measured') = 'object' and pg_column_size(e -> 'measured') > 1024 then
      raise exception 'event measured is too large' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, units, stopped_in_traffic, zone, lat, lng, measured, penalty, status)
      values (v_trip, (e ->> 'id')::uuid, v_user, e ->> 'type', e ->> 'tier', to_timestamp((e ->> 'startedAt')::numeric / 1000.0),
        least(43200, greatest(0, (e ->> 'durationS')::numeric)), case when e ->> 'units' is null then null else least(10000, greatest(0, (e ->> 'units')::int)) end,
        (e ->> 'stoppedInTraffic')::boolean, case when e ->> 'zone' in ('school', 'construction') then e ->> 'zone' end,
        (e ->> 'lat')::double precision, (e ->> 'lng')::double precision,
        case when jsonb_typeof(e -> 'measured') = 'object' then e -> 'measured' else '{}'::jsonb end,
        coalesce((select (b ->> 'penalty')::int from jsonb_array_elements(bd -> 'events') b where b ->> 'id' = e ->> 'id'), 0),
        'active')
    on conflict (trip_id, client_event_id) do update
      set penalty = excluded.penalty,
          status = case when public.trip_events.status = 'removed' then 'removed' else 'active' end;
  end loop;

  -- counts from the stored rows (the input's status is never trusted); the breakdown must agree.
  -- DashPal events (eyes_off, drowsy) are counted apart: never in n_events, never break `clean`.
  select count(*) filter (where x.type not in ('eyes_off', 'drowsy')), count(*) filter (where x.type = 'speeding'), count(*) filter (where x.type = 'phone_pickup'),
         least(172800, coalesce(sum(x.duration_s) filter (where x.type = 'phone_handling'), 0))::int,
         count(*) filter (where x.type = 'hard_brake'), count(*) filter (where x.type = 'hard_accel'),
         count(*) filter (where x.type = 'hard_corner'), count(*) filter (where x.type in ('eyes_off', 'drowsy'))
    into v_n, v_sp, v_pk, v_hs, v_hb, v_ha, v_hc, v_nd
    from public.trip_events x where x.trip_id = v_trip and x.status = 'active';
  if v_scored and coalesce((bd ->> 'activeEventCount')::int, v_n) <> v_n then
    raise exception 'events do not match the breakdown' using errcode = 'invalid_parameter_value';
  end if;
  v_clean := v_scored and v_n = 0;
  update public.trips set n_events = v_n, n_speeding = v_sp, n_pickup = v_pk, handling_s = v_hs, n_hard_brake = v_hb, n_hard_accel = v_ha,
      n_hard_corner = v_hc, n_dashcam = v_nd, clean = v_clean
    where id = v_trip;

  -- the merged-away payload keeps its own row (unscored, pointing at the target), with its own DashPal seconds
  if v_merge is not null then
    insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s,
        dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced,
        polyline, scored, merged_into, app_version)
      values (v_user, v_client, to_timestamp((pl ->> 'startedAt')::bigint / 1000.0), v_ended, (pl ->> 'localDay')::date,
        private.league_week(to_timestamp((pl ->> 'startedAt')::bigint / 1000.0)), pl ->> 'tz',
        (pl ->> 'miles')::numeric, (pl ->> 'safeMiles')::numeric, (pl ->> 'nightMiles')::numeric, (pl ->> 'durationS')::int,
        pdc ->> 'deviceId', coalesce((pdc ->> 'movingS')::int, 0), coalesce((pdc ->> 'coveredS')::int, 0), coalesce((pdc ->> 'synced')::boolean, false),
        coalesce(pl ->> 'polyline', ''),
        false, v_trip, left(pl ->> 'appVersion', 32));
  end if;

  -- progress
  v_after := st -> 'after';
  if v_scored then
    if jsonb_typeof(v_after) <> 'object' then
      raise exception 'a scored drive needs streak.after' using errcode = 'invalid_parameter_value';
    end if;
    if (v_after ->> 'streak')::int not in (0, coalesce((st -> 'before' ->> 'streak')::int, 0), coalesce((st -> 'before' ->> 'streak')::int, 0) + 1)
       or coalesce((v_after ->> 'freezes')::int, 0) not between 0 and 3 or coalesce((v_after ->> 'cleanRun')::int, 0) not between 0 and 1000 then
      raise exception 'streak.after is not a streak transition' using errcode = 'invalid_parameter_value';
    end if;
    update public.progress set
      points = points + v_net,
      lifetime = lifetime + greatest(0, v_net),
      level = private.level_for(lifetime + greatest(0, v_net)),
      streak = greatest(0, (v_after ->> 'streak')::int),
      at_risk = coalesce((v_after ->> 'atRisk')::boolean, false),
      freezes = least(3, greatest(0, (v_after ->> 'freezes')::int)),
      clean_run = greatest(0, coalesce((v_after ->> 'cleanRun')::int, 0)),
      phone_free_run = case when v_pk = 0 then phone_free_run + 1 else 0 end,
      last_end_lat = v_end_lat, last_end_lng = v_end_lng, last_end_at = v_ended
    where user_id = v_user;
    insert into public.points_ledger (user_id, key, amount, kind, trip_id, league_week)
      values (v_user, 'drive:' || v_trip || ':' || v_rev, v_net, 'drive', v_trip, v_week)
      on conflict (user_id, key) do nothing;
    v_league := private.place_in_league(v_user, v_week);
    perform private.ensure_challenges(v_user, v_week);
    v_challenges := private.complete_challenges(v_user, v_week, v_trip);
    v_achievements := private.check_achievements(v_user, v_week);
  else
    update public.progress set last_end_lat = v_end_lat, last_end_lng = v_end_lng, last_end_at = v_ended where user_id = v_user;
    select jsonb_build_object('tier', g.league_tier, 'placed', exists (select 1 from public.league_members m where m.week = v_week and m.user_id = v_user))
      into v_league from public.progress g where g.user_id = v_user;
  end if;
  perform private.refresh_rating(v_user);
  select level into v_level_after from public.progress where user_id = v_user;

  v_resp := jsonb_build_object(
    'tripId', v_trip, 'clientTripId', v_client,
    'mergedInto', case when v_merge is null then null else tgt.client_trip_id end,
    'scored', v_scored, 'reason', v_reason, 'breakdown', bd, 'net', v_net,
    'streak', jsonb_build_object(
      'before', coalesce((st -> 'before' ->> 'streak')::int, 0),
      'after', case when v_scored then (v_after ->> 'streak')::int else coalesce((st -> 'before' ->> 'streak')::int, 0) end,
      'outcome', coalesce(st ->> 'outcome', 'none'),
      'nextMult', least(1.30, 1 + 0.02 * (select streak from public.progress where user_id = v_user)),
      'atRisk', (select at_risk from public.progress where user_id = v_user),
      'freezes', (select freezes from public.progress where user_id = v_user),
      'freezeEarned', coalesce((st ->> 'freezeEarned')::boolean, false)),
    'progress', private.progress_json(v_user, v_level_after > v_level_before),
    'achievements', v_achievements, 'challenges', v_challenges, 'league', v_league);
  update public.trips set result = v_resp where user_id = v_user and client_trip_id = v_client;
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------
-- "Wasn't driving": the latest drive only, within 24 h, 2 per UTC month
-- ---------------------------------------------------------------------------
create or replace function private.revert_latest_not_driving(p_user uuid, p_client_trip_id uuid) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  t public.trips%rowtype;
  v_left int;
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
  if not found or t.merged_into is not null then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  if t.not_driving then
    raise exception 'already marked as not driving' using errcode = 'insufficient_privilege';
  end if;
  -- the latest drive is the one applied last: its end is the end progress still holds (a late
  -- upload of an older drive makes the newer one's snapshot stale, so it can no longer be reverted)
  if (select g.last_end_at from public.progress g where g.user_id = p_user) is distinct from t.ended_at then
    raise exception 'only your latest drive can be marked' using errcode = 'insufficient_privilege';
  end if;
  if t.ended_at < now() - interval '24 hours' then
    raise exception 'the drive is older than 24 hours' using errcode = 'insufficient_privilege';
  end if;
  v_left := private.not_driving_left(p_user);
  if v_left <= 0 then
    raise exception 'no uses left this month' using errcode = 'insufficient_privilege';
  end if;
  perform private.revert_trip(p_user, t.id);
  update public.trips set not_driving = true, not_driving_at = now(), points_net = 0 where id = t.id;
  perform private.refresh_rating(p_user);
  -- flag an account that mostly uses this on drives with events (DashPal events count too)
  select count(*), count(*) filter (where x.n_events + x.n_dashcam > 0) into v_uses, v_with_events
    from (select n_events, n_dashcam from public.trips x where x.user_id = p_user and x.not_driving order by x.not_driving_at desc limit 4) x;
  if v_uses >= 3 and v_with_events >= 3 then
    update public.profiles set flagged = true where id = p_user and not flagged;
  end if;
  return jsonb_build_object('tripId', t.id, 'clientTripId', t.client_trip_id,
    'notDrivingLeft', private.not_driving_left(p_user),
    'progress', (select jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level, 'streak', g.streak,
      'atRisk', g.at_risk, 'freezes', g.freezes, 'safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = p_user));
end $$;

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------
-- dispute_context: locks the user's progress row (so two disputes in flight queue and the second
-- reads the first's result), validates and decides; writes nothing. Returns what the function
-- needs to re-score (the stored input and context with the event marked removed, and the drive's
-- stored DashPal flag so the re-score keeps its x1.25). Reasons: hazard (hard_brake), wrong_limit
-- (speeding), mounted (phone events), camera_wrong ("DashPal got it wrong": eyes_off, drowsy).
create or replace function private.dispute_context(p_user uuid, p_client_trip_id uuid, p_event_id uuid, p_reason text) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  t public.trips%rowtype;
  e public.trip_events%rowtype;
  v_status text;
  v_why text := null;
  v_used int;
begin
  if p_user is null or p_client_trip_id is null or p_event_id is null then
    raise exception 'user, clientTripId and eventId are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('hazard', 'wrong_limit', 'mounted', 'camera_wrong') then
    raise exception 'reason must be hazard, wrong_limit, mounted or camera_wrong' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select * into t from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id;
  if not found or t.merged_into is not null or t.not_driving then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  select * into e from public.trip_events x where x.trip_id = t.id and x.client_event_id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  if t.ended_at < now() - interval '7 days' then
    raise exception 'the drive is older than 7 days' using errcode = 'insufficient_privilege';
  end if;
  if e.status <> 'active' or exists (select 1 from public.event_disputes d where d.trip_id = t.id and d.client_event_id = p_event_id) then
    raise exception 'already disputed' using errcode = 'insufficient_privilege';
  end if;
  if (p_reason = 'hazard' and e.type <> 'hard_brake') or (p_reason = 'wrong_limit' and e.type <> 'speeding')
     or (p_reason = 'mounted' and e.type not in ('phone_pickup', 'phone_handling'))
     or (p_reason = 'camera_wrong' and e.type not in ('eyes_off', 'drowsy')) then
    raise exception 'that reason does not apply to this event' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason in ('hazard', 'wrong_limit', 'camera_wrong') then
    v_used := private.dispute_quota_used(p_user, p_reason);
    if v_used < 3 then
      v_status := 'accepted';
    else
      v_status := 'rejected';
      v_why := 'quota';
    end if;
  else
    if coalesce((e.measured ->> 'mounted')::boolean, false) and e.duration_s < 15 then
      v_status := 'accepted';
    else
      v_status := 'rejected';
      v_why := 'not_mounted';
    end if;
  end if;
  return jsonb_build_object(
    'tripId', t.id, 'clientTripId', t.client_trip_id, 'eventId', p_event_id, 'reason', p_reason,
    'status', v_status, 'rejectReason', v_why, 'scored', t.scored, 'oldNet', t.points_net,
    'quotaLeft', case when p_reason in ('hazard', 'wrong_limit', 'camera_wrong') then greatest(0, 3 - v_used) else null end,
    'rescore', case when v_status = 'accepted' and t.scored then jsonb_build_object(
      'input', jsonb_build_object('miles', t.miles, 'safeMiles', t.safe_miles, 'loopRepeat', t.loop_repeat, 'dashcam', t.dashcam_on,
        'events', (select jsonb_agg(case when x ->> 'id' = p_event_id::text then x || '{"status":"removed"}'::jsonb else x end)
                   from jsonb_array_elements(private.trip_events_json(t.id)) x)),
      'ctx', jsonb_build_object('streak', t.streak_before, 'safeMilesEarlierToday', t.safe_miles_earlier_today)) else null end);
end $$;

-- apply_dispute(p): p = { user, tripId, eventId, reason, status, rejectReason?, breakdown?, net? }
--   writes the dispute; an accepted one removes the event and, when a breakdown is given,
--   re-scores the drive with its stored context and credits the delta (streak untouched)
create or replace function private.apply_dispute(p jsonb) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_user uuid := (p ->> 'user')::uuid;
  v_trip uuid := (p ->> 'tripId')::uuid;
  v_event uuid := (p ->> 'eventId')::uuid;
  v_reason text := p ->> 'reason';
  v_status text := p ->> 'status';
  bd jsonb := p -> 'breakdown';
  v_net int;
  v_old int;
  v_delta int := 0;
  t public.trips%rowtype;
  e public.trip_events%rowtype;
  v_n int; v_sp int; v_pk int; v_hs int; v_hb int; v_ha int; v_hc int; v_nd int;
  v_why text := p ->> 'rejectReason';
  v_used int;
  v_left int;
begin
  if v_user is null or v_trip is null or v_event is null or v_reason not in ('hazard', 'wrong_limit', 'mounted', 'camera_wrong')
     or v_status not in ('accepted', 'rejected') or (bd is not null and jsonb_typeof(bd) <> 'object') or pg_column_size(p) > 262144 then
    raise exception 'apply_dispute needs user, tripId, eventId, reason and status' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.progress where user_id = v_user for update;
  select * into t from public.trips x where x.id = v_trip and x.user_id = v_user for update;
  if not found or t.merged_into is not null or t.not_driving then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  select * into e from public.trip_events x where x.trip_id = v_trip and x.client_event_id = v_event;
  if not found then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;
  if e.status <> 'active' or exists (select 1 from public.event_disputes d where d.trip_id = v_trip and d.client_event_id = v_event) then
    raise exception 'already disputed' using errcode = 'insufficient_privilege';
  end if;
  -- the weekly quota, re-counted under the lock: the decision in dispute_context may be stale
  if v_status = 'accepted' and v_reason in ('hazard', 'wrong_limit', 'camera_wrong') then
    v_used := private.dispute_quota_used(v_user, v_reason);
    if v_used >= 3 then
      v_status := 'rejected';
      v_why := 'quota';
    end if;
  end if;
  insert into public.event_disputes (trip_id, client_event_id, user_id, reason, status) values (v_trip, v_event, v_user, v_reason, v_status);
  -- the quota left after this dispute, counted under the lock (camera_wrong's own; otherwise hazard + wrong_limit)
  v_left := greatest(0, 3 - private.dispute_quota_used(v_user, v_reason));
  if v_status = 'rejected' then
    return jsonb_build_object('tripId', v_trip, 'eventId', v_event, 'status', 'rejected', 'rejectReason', v_why, 'quotaLeft', v_left,
      'net', t.points_net, 'delta', 0, 'breakdown', case when t.scored then t.breakdown else null end, 'progress', private.progress_json(v_user, false));
  end if;
  update public.trip_events set status = 'removed' where trip_id = v_trip and client_event_id = v_event;
  if v_reason = 'wrong_limit' and e.lat is not null and e.lng is not null then
    insert into public.map_feedback (lat, lng, limit_mph, speed_mph)
      values (e.lat, e.lng, least(120, greatest(0, (e.measured ->> 'limitMph')::numeric))::int, least(250, greatest(0, (e.measured ->> 'speedMph')::numeric))::int);
  end if;
  if t.scored and bd is not null then
    v_old := t.points_net;
    v_net := coalesce((p ->> 'net')::int, (bd ->> 'net')::int, v_old);
    if v_net not between -20000 and 20000 or coalesce((bd ->> 'ratingPenalty')::numeric, 0) not between 0 and 20000 or pg_column_size(bd) > 65536 then
      raise exception 'net or ratingPenalty is out of range' using errcode = 'invalid_parameter_value';
    end if;
    v_delta := v_net - v_old;
    -- as in apply_drive: DashPal events are counted apart, never in n_events or `clean`
    select count(*) filter (where x.type not in ('eyes_off', 'drowsy')), count(*) filter (where x.type = 'speeding'), count(*) filter (where x.type = 'phone_pickup'),
           least(172800, coalesce(sum(x.duration_s) filter (where x.type = 'phone_handling'), 0))::int,
           count(*) filter (where x.type = 'hard_brake'), count(*) filter (where x.type = 'hard_accel'),
           count(*) filter (where x.type = 'hard_corner'), count(*) filter (where x.type in ('eyes_off', 'drowsy'))
      into v_n, v_sp, v_pk, v_hs, v_hb, v_ha, v_hc, v_nd
      from public.trip_events x where x.trip_id = v_trip and x.status = 'active';
    -- a breakdown scored over a different set of active events (another dispute landed in between): retry
    if coalesce((bd ->> 'activeEventCount')::int, v_n) <> v_n then
      raise exception 'stale breakdown' using errcode = 'serialization_failure';
    end if;
    update public.trip_events x set penalty = coalesce((select (b ->> 'penalty')::int from jsonb_array_elements(bd -> 'events') b where b ->> 'id' = x.client_event_id::text), 0)
      where x.trip_id = v_trip;
    update public.trips set points_net = v_net, breakdown = bd, rating_penalty = coalesce((bd ->> 'ratingPenalty')::int, rating_penalty),
        n_events = v_n, n_speeding = v_sp, n_pickup = v_pk, handling_s = v_hs, n_hard_brake = v_hb, n_hard_accel = v_ha, n_hard_corner = v_hc,
        n_dashcam = v_nd, clean = (v_n = 0)
      where id = v_trip;
    if v_delta <> 0 or greatest(0, v_net) <> greatest(0, v_old) then
      insert into public.points_ledger (user_id, key, amount, kind, trip_id, league_week)
        values (v_user, 'drive_adjust:' || v_trip || ':' || v_event, v_delta, 'drive_adjust', v_trip, t.league_week)
        on conflict (user_id, key) do nothing;
      update public.progress set
        points = points + v_delta,
        lifetime = lifetime + greatest(0, v_net) - greatest(0, v_old),
        level = private.level_for(lifetime + greatest(0, v_net) - greatest(0, v_old))
      where user_id = v_user;
    end if;
    perform private.refresh_rating(v_user);
  else
    v_net := t.points_net;
  end if;
  -- the breakdown as now stored (re-scored, with every remaining event's penalty), so the client's itemised list sums to the net
  return jsonb_build_object('tripId', v_trip, 'eventId', v_event, 'status', 'accepted', 'rejectReason', null, 'quotaLeft', v_left,
    'net', v_net, 'delta', v_delta, 'breakdown', case when t.scored then coalesce(bd, t.breakdown) else null end, 'progress', private.progress_json(v_user, false));
end $$;

-- ---------------------------------------------------------------------------
-- get_my_summary: the Home header in one call (also applies the lazy freeze grant and this
-- week's challenge assignment)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_summary() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  v_group uuid;
  g public.progress%rowtype;
begin
  if v_uid is null then
    raise exception 'get_my_summary requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  -- a read on every Home focus: lock and write only when a freeze grant or this week's challenge
  -- assignment is actually due (both are rare), so a concurrent finalize is never held up
  select * into g from public.progress where user_id = v_uid;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  if g.freezes_granted_at <= now() - interval '30 days' then
    perform 1 from public.progress where user_id = v_uid for update;
    perform private.apply_freeze_grant(v_uid);
    select * into g from public.progress where user_id = v_uid;
  end if;
  if not exists (select 1 from public.weekly_challenges w where w.user_id = v_uid and w.league_week = v_week) then
    perform private.ensure_challenges(v_uid, v_week);
  end if;
  select m.group_id into v_group from public.league_members m where m.week = v_week and m.user_id = v_uid;
  return jsonb_build_object(
    'profile', (select jsonb_build_object('user_id', p.id, 'username', p.username, 'license_stage', p.license_stage, 'units', p.units,
        'state', p.state, 'heatmap_visibility', p.heatmap_visibility, 'league_eligible', p.league_eligible,
        'onboarded_at', p.onboarded_at) from public.profiles p where p.id = v_uid),
    'progress', jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level,
        'level_floor', private.level_floor(g.level), 'level_next', case when g.level >= 50 then null else private.level_floor(g.level + 1) end,
        'streak', g.streak, 'at_risk', g.at_risk, 'next_mult', least(1.30, 1 + 0.02 * g.streak),
        'freezes', g.freezes, 'clean_run', g.clean_run, 'freeze_progress', g.freeze_progress, 'phone_free_run', g.phone_free_run,
        'safety_rating', g.safety_rating, 'ranked', g.ranked, 'miles_30d', g.miles_30d, 'clean_miles_30d', g.clean_miles_30d,
        'rating_trend', case when g.safety_rating is null then null else g.safety_rating - private.rating_as_of(v_uid, now() - interval '7 days') end,
        'league_tier', g.league_tier),
    'league', jsonb_build_object('week', v_week, 'tier', g.league_tier, 'group_id', v_group,
        'rank', case when v_group is null then null else 1 + (select count(*) from public.league_members m where m.group_id = v_group and m.user_id <> v_uid
                  and private.week_points(m.user_id, v_week) > private.week_points(v_uid, v_week)) end,
        'size', coalesce((select l.member_count from public.league_groups l where l.id = v_group), 0),
        'ends_at', private.week_end(now())),
    'not_driving_left', private.not_driving_left(v_uid),
    'challenges', private.challenges_json(v_uid, v_week),
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_uid), '[]'::jsonb));
end $$;

revoke all on function public.get_my_summary() from public, anon, authenticated;
grant execute on function public.get_my_summary() to authenticated;
