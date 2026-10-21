-- 0019_points_floor_and_net_levels: points never go below 0, the level follows them, and the
-- Safety Rating counts from 10 miles.
--
--   * A driver's points total is earned less lost and never below 0: a drive takes away at most
--     what the driver holds (apply_drive), and its ledger row records what it really moved, so
--     the ledger and the total still agree and undoing the drive gives back exactly that. The
--     drive's own net (its receipt) is stored as before, loss and all.
--   * The level follows that total (`level_for(points)`), so losing points can drop a level, and
--     regaining them raises it again. `lifetime` stays the sum of positive drives and rewards; it
--     no longer sets the level.
--   * An accepted report re-credits a drive by what it now puts in (its net, floored as it would
--     have been against the points held before it) less what its ledger rows already put in.
--   * Undoing a drive (a merge, "Wasn't driving") and the challenge reward floor at 0 the same way.
--   * The week's points (the Friends board's week metric and the weekly recap) never read below 0.
--   * Ranked (a Safety Rating shown) from 10 miles in the last 30 days (was 25).
--   * Existing rows: a total below 0 is raised to 0, and every level is recomputed from the points.

create or replace function private.refresh_rating(p_user uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_miles numeric;
  v_clean numeric;
  v_pen numeric;
begin
  select coalesce(sum(t.miles), 0), coalesce(sum(t.miles) filter (where t.clean), 0), coalesce(sum(t.rating_penalty), 0)
    into v_miles, v_clean, v_pen
    from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
      and t.started_at > now() - interval '30 days';
  update public.progress set
    miles_30d = least(v_miles, 999999),
    clean_miles_30d = least(v_clean, 999999),
    rating_penalty_30d = least(v_pen, 99999999),
    safety_rating = private.safety_rating(v_pen, v_miles),
    ranked = v_miles >= 10,
    rating_updated_at = now()
  where user_id = p_user;
end $$;

-- week points = drive nets of the week + challenge rewards of the week, never below 0
create or replace function private.week_points(p_user uuid, p_week text) returns int
language sql stable set search_path = public as $$
  select greatest(0,
         coalesce((select sum(t.points_net)::int from public.trips t
                   where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null), 0)
       + coalesce((select sum(l.amount)::int from public.points_ledger l
                   where l.user_id = p_user and l.league_week = p_week and l.kind = 'challenge'), 0))
$$;

create or replace function private.complete_challenges(p_user uuid, p_week text, p_trip uuid) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_done jsonb := '[]'::jsonb;
  v_fp int;
begin
  if private.week_key_end(p_week) <= now() then
    return v_done;
  end if;
  for r in
    select w.slot, w.template_id, c.title, c.target
    from public.weekly_challenges w join public.challenge_templates c on c.id = w.template_id
    where w.user_id = p_user and w.league_week = p_week and w.completed_at is null
    order by w.slot
  loop
    if private.challenge_count(p_user, p_week, r.template_id) >= r.target then
      update public.weekly_challenges set completed_at = now(), completed_by_trip = p_trip
        where user_id = p_user and league_week = p_week and slot = r.slot;
      insert into public.points_ledger (user_id, key, amount, kind, trip_id, league_week)
        values (p_user, 'challenge:' || p_week || ':' || r.slot, 100, 'challenge', p_trip, p_week)
        on conflict (user_id, key) do nothing;
      select freeze_progress into v_fp from public.progress where user_id = p_user for update;
      update public.progress set
        points = points + 100,
        lifetime = lifetime + 100,
        level = private.level_for(greatest(0, points + 100)),
        freeze_progress = case when v_fp + 1 >= 3 then 0 else v_fp + 1 end,
        freezes = case when v_fp + 1 >= 3 then least(3, freezes + 1) else freezes end
      where user_id = p_user;
      v_done := v_done || jsonb_build_object('id', r.template_id, 'title', r.title);
    end if;
  end loop;
  return v_done;
end $$;

create or replace function private.revert_trip(p_user uuid, p_trip uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_snap jsonb;
  v_rev int;
  v_net int;
  v_sum int;
  v_challenges int;
  v_points int;
  v_lifetime int;
begin
  select t.progress_before, t.rev, t.points_net into v_snap, v_rev, v_net from public.trips t where t.id = p_trip and t.user_id = p_user for update;
  if not found then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  -- what this drive put into points: its own ledger rows, and the challenge rewards it completed
  select coalesce(sum(l.amount) filter (where l.kind <> 'challenge'), 0), coalesce(sum(l.amount) filter (where l.kind = 'challenge'), 0)
    into v_sum, v_challenges
    from public.points_ledger l where l.user_id = p_user and l.trip_id = p_trip;
  select g.points, g.lifetime into v_points, v_lifetime from public.progress g where g.user_id = p_user for update;
  perform private.restore_progress(p_user, v_snap);
  update public.progress set
    points = greatest(0, v_points - v_sum - v_challenges),
    lifetime = greatest(0, v_lifetime - greatest(0, v_net) - v_challenges),
    level = private.level_for(greatest(0, v_points - v_sum - v_challenges))
  where user_id = p_user;
  perform private.revert_challenges_of_trip(p_user, p_trip);
  if v_sum <> 0 then
    insert into public.points_ledger (user_id, key, amount, kind, trip_id)
      values (p_user, 'revert:' || p_trip || ':' || v_rev, -v_sum, 'revert', p_trip)
      on conflict (user_id, key) do nothing;
  end if;
end $$;

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
  v_applied int;
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
    -- points never go below 0: a drive takes away at most what the driver holds, and the ledger
    -- records what it really moved; the level follows the points
    select greatest(v_net, -greatest(0, g.points)) into v_applied from public.progress g where g.user_id = v_user;
    update public.progress set
      points = greatest(0, points + v_applied),
      lifetime = lifetime + greatest(0, v_net),
      level = private.level_for(greatest(0, points + v_applied)),
      streak = greatest(0, (v_after ->> 'streak')::int),
      at_risk = coalesce((v_after ->> 'atRisk')::boolean, false),
      freezes = least(3, greatest(0, (v_after ->> 'freezes')::int)),
      clean_run = greatest(0, coalesce((v_after ->> 'cleanRun')::int, 0)),
      phone_free_run = case when v_pk = 0 then phone_free_run + 1 else 0 end,
      last_end_lat = v_end_lat, last_end_lng = v_end_lng, last_end_at = v_ended
    where user_id = v_user;
    insert into public.points_ledger (user_id, key, amount, kind, trip_id, league_week)
      values (v_user, 'drive:' || v_trip || ':' || v_rev, v_applied, 'drive', v_trip, v_week)
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
  v_had int;
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
  -- a repeat of a stored dispute (same reason): its outcome, nothing written again
  if exists (select 1 from public.event_disputes d
             where d.trip_id = v_trip and d.client_event_id = v_event and d.user_id = v_user and d.reason = v_reason) then
    return private.dispute_outcome(v_user, v_trip, v_event);
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
    -- what the drive now puts into points (never more than the driver held before it was applied
    -- taken away), less what its ledger rows already put in
    select coalesce(sum(l.amount), 0) into v_had from public.points_ledger l
      where l.user_id = v_user and l.trip_id = v_trip and l.kind <> 'challenge';
    v_delta := greatest(v_net, -greatest(0, coalesce((t.progress_before ->> 'points')::int, 0))) - v_had;
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
        points = greatest(0, points + v_delta),
        lifetime = greatest(0, lifetime + greatest(0, v_net) - greatest(0, v_old)),
        level = private.level_for(greatest(0, points + v_delta))
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

-- existing rows: no total below 0, every level from the points, every ranked flag from 10 miles
update public.progress set points = greatest(0, points), level = private.level_for(greatest(0, points))
  where points < 0 or level <> private.level_for(greatest(0, points));
update public.progress set ranked = miles_30d >= 10 where ranked <> (miles_30d >= 10);
