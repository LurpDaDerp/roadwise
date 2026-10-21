-- 0026_phone_use: phone use is tracked again, by motion alone. A drive uploads its phone pickups
-- (each with its seconds in hand) and its seconds at driving speed with the motion sensors read
-- (phone_s), and Phone use is a sixth category of the Safety Rating.
--
--   * A pickup weighs 10 plus its seconds in hand (event_weight_of). Phone use judges that weight
--     per second at driving speed, smoothed with a prior of 3600 s at the typical rate (0.04, the
--     same as Speed), and reads it on the same curve as the others (typical driving reads 85). It
--     counts double, as Speed does.
--   * Not tracked, no score: Phone use is null while the window holds no phone seconds and no
--     pickup, and a null category is left out of the weighted mean, so every drive stored before
--     this migration (phone_s 0, no pickups) rates exactly as it did and no rating is recomputed.
--     `private.rating_at` stays the SQL copy of scoring `ratingAt` and agrees with it to the digit.
--   * apply_drive takes the v5 upload (exposure.phoneS and phone_pickup events); a v4 upload has no
--     phoneS and stores phone_s 0. phone_s is held to the drive as limit_s is: within moving time
--     and within ceil(miles x 360 x 1.25) + 60 s. A pickup is moderate or severe, in hand a whole
--     number of seconds from 1 to the drive's length, and starts inside the drive. A pickup breaks a
--     clean drive like any event the phone detects (n_events), and Home's harsh-event stat still
--     counts hard brakes, starts and turns only (stat_sums is unchanged).
--   * "My phone was mounted" is a report reason again, for a phone pickup only, auto-accepted under
--     the weekly quota hazard and wrong-limit reports share (3 a week).
--   * Category scores name Phone use (get_profile), and the drive list carries phoneS.
--   * drive_context answers phoneUse: true. finalize-trip runs only on a database that answers it,
--     so a pickup is never refused here with a 400 the phone does not retry; the finalize-trip
--     before it reads only version 23 and keeps working on this schema.
--
-- Deploy order: this migration, then finalize-trip and trip-actions. Either order fails safe: the
-- older functions work on this schema (v4 and v3 uploads, no pickups), and the newer finalize-trip
-- answers a database without this migration with a 500, which phones retry; a phone that sends v5
-- to an older finalize-trip is refused on the path v, which it reads as a server behind it and
-- retries later.

-- ---------------------------------------------------------------------------
-- the schema: a drive's seconds at driving speed, the pickup, the mounted report
-- ---------------------------------------------------------------------------
alter table public.trips
  add column phone_s int not null default 0 check (phone_s between 0 and 43200),
  add constraint trips_phone_le_moving check (phone_s <= moving_s);
alter table public.trips alter column scoring_version set default 8;
alter table public.trip_events drop constraint trip_events_type_check;
alter table public.trip_events add constraint trip_events_type_check
  check (type in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy'));
alter table public.trip_events add constraint trip_events_pickup_tier_check
  check (type <> 'phone_pickup' or tier in ('moderate', 'severe'));
alter table public.event_disputes drop constraint event_disputes_reason_check;
alter table public.event_disputes add constraint event_disputes_reason_check
  check (reason in ('hazard', 'wrong_limit', 'camera_wrong', 'mounted'));

-- ---------------------------------------------------------------------------
-- the rating: Phone use
-- ---------------------------------------------------------------------------

-- the category an event counts toward (scoring axisOf); anything else counts nowhere
create or replace function private.axis_of(p_type text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_type = 'speeding' then 'speed'
    when p_type = 'hard_brake' then 'braking'
    when p_type = 'hard_accel' then 'acceleration'
    when p_type = 'hard_corner' then 'turning'
    when p_type = 'phone_pickup' then 'phone'
    when p_type in ('eyes_off', 'drowsy') then 'attention'
    else null end
$$;

-- what an active event adds to its category's weight (scoring eventWeight): a hard event minor 1 /
-- severe 2, speeding speeding_weight, a phone pickup 10 (PHONE_PICKUP_WEIGHT_S) plus its seconds in
-- hand clamped to 0..43 200 (phoneInHandS), anything else 0
create or replace function private.event_weight_of(p_type text, p_tier text, p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case
    when p_type in ('hard_brake', 'hard_accel', 'hard_corner') then (case when p_tier = 'severe' then 2 else 1 end)::float8
    when p_type = 'speeding' then private.speeding_weight(p_duration_s, p_measured, p_tier)
    when p_type = 'phone_pickup' then 10::float8 + least(43200::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8))
    else 0::float8 end
$$;

-- scoring ratingAt: the rating as of p_at over the kept scored drives started in (p_at - 90 d, p_at],
-- each weighted by its age in whole days. Every sum runs in the TypeScript's order (drives by
-- started_at then client_trip_id, events by started_at then client_event_id) in double precision,
-- so the phone and the server agree to the digit.
--   per rate axis: W = sum(w * weight), O = sum(w * max(opportunities, count)),
--                  score = rate_score((W + prior * rate) / (O + prior), rate)
--   Phone use: weight 10 + seconds in hand per pickup, count the seconds in hand, opportunities
--              phone_s; null when its O is 0 (no phone seconds and no pickup in the window)
--   Attention: P = sum(w * penalty), M = sum(w * watched miles); category_score(P, M, 10) when M > 0
--   rating = the weighted mean (Speed 2, Phone use 2, the rest 1), clamped, half up to 1 decimal
-- Set-based, as 0023 made it: the window's drives; their active events summed per drive and category
-- in one grouped scan, the speeding sums and the phone sums in a scan each of their own events, each
-- ordered sum adding in the event order; then the weighted sums over the drives, each ordered sum
-- adding in the drive order. An ordered float8 sum adds one term at a time in that order, exactly as
-- the TypeScript's loops do. A hard event weighs a whole 1 or 2 (event_weight_of), and a sum of whole
-- numbers this small is exact in any order, so those sums need no ordering.
create or replace function private.rating_at(p_user uuid, p_at timestamptz) returns jsonb
language plpgsql stable set search_path = public as $$
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
    where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
      and t.started_at > p_at - interval '2160 hours' and t.started_at <= p_at
  ),
  ev as (
    -- event_weight_of of a hard event: minor 1, severe 2 (written out: a call per event costs more
    -- than the whole sum)
    select e.trip_id,
      sum((case when e.tier = 'severe' then 2 else 1 end)::float8) filter (where e.type = 'hard_brake') as b_w,
      count(*) filter (where e.type = 'hard_brake') as b_n,
      sum((case when e.tier = 'severe' then 2 else 1 end)::float8) filter (where e.type = 'hard_accel') as a_w,
      count(*) filter (where e.type = 'hard_accel') as a_n,
      sum((case when e.tier = 'severe' then 2 else 1 end)::float8) filter (where e.type = 'hard_corner') as t_w,
      count(*) filter (where e.type = 'hard_corner') as t_n,
      sum(private.attention_penalty_of(e.type)) filter (where e.type in ('eyes_off', 'drowsy')) as att
    from d join public.trip_events e on e.trip_id = d.id
    -- (a drive's events are its driver's: the user filter only lets the planner read them by user)
    where e.status = 'active' and e.user_id = p_user
    group by e.trip_id
  ),
  sp as (
    -- event_weight_of of a speeding event is its speeding_weight; scoring speedingChargedS per event: max(1, duration - 5)
    select e.trip_id,
      sum(private.speeding_weight(e.duration_s, e.measured, e.tier) order by e.started_at, e.client_event_id) as s_w,
      sum(greatest(1::float8, greatest(0::float8, e.duration_s::float8) - 5::float8) order by e.started_at, e.client_event_id) as s_n
    from d join public.trip_events e on e.trip_id = d.id
    where e.status = 'active' and e.user_id = p_user and e.type = 'speeding'
    group by e.trip_id
  ),
  ph as (
    -- event_weight_of of a phone pickup: 10 + its seconds in hand (scoring phoneInHandS: clamped to
    -- 0..43 200); the count is the seconds in hand. Ordered like the speeding sums: a pickup's seconds
    -- are whole on every upload, but the TypeScript adds in this order whatever they are.
    select e.trip_id,
      sum(10::float8 + least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) as p_w,
      sum(least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) as p_n
    from d join public.trip_events e on e.trip_id = d.id
    where e.status = 'active' and e.user_id = p_user and e.type = 'phone_pickup'
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
      d.w * coalesce(sp.s_w, 0::float8) as s_w,
      d.w * greatest(coalesce(d.limit_s, 0)::float8, coalesce(sp.s_n, 0::float8)) as s_o,
      d.w * coalesce(ph.p_w, 0::float8) as p_w,
      d.w * greatest(coalesce(d.phone_s, 0)::float8, coalesce(ph.p_n, 0::float8)) as p_o,
      d.w * coalesce(ev.att, 0)::float8 as att
    from d left join ev on ev.trip_id = d.id left join sp on sp.trip_id = d.id left join ph on ph.trip_id = d.id
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
end $$;

-- ---------------------------------------------------------------------------
-- the engine: phone seconds and pickups stored, the context says so
-- ---------------------------------------------------------------------------

-- drive_context: lock, idempotency, the merge target. `version` 23 tells finalize-trip which engine
-- it reads; `phoneUse` that this database stores phone pickups and phone_s (0026).
create or replace function private.drive_context(p_user uuid, p_client_trip_id uuid, p_started_at timestamptz, p_local_day date,
  p_start_lat double precision, p_start_lng double precision, p_ended_at timestamptz default null) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  g public.progress%rowtype;
  t public.trips%rowtype;
  v_existing jsonb;
  v_merge jsonb := null;
begin
  if p_user is null or p_client_trip_id is null or p_started_at is null or p_local_day is null then
    raise exception 'user, clientTripId, startedAt and localDay are required' using errcode = 'invalid_parameter_value';
  end if;
  -- a drive dated to end more than 10 minutes from now is moved back to end now (apply_drive's
  -- rule), so the merge is decided on the times that will be stored
  if p_ended_at is not null and p_ended_at > now() + interval '10 minutes' then
    p_started_at := p_started_at - (p_ended_at - now());
    p_ended_at := now();
  end if;
  if (p_start_lat is null) <> (p_start_lng is null)
     or (p_start_lat is not null and (p_start_lat not between -90 and 90 or p_start_lng not between -180 and 180)) then
    raise exception 'start must be a lat/lng pair on the globe' using errcode = 'invalid_parameter_value';
  end if;
  select * into g from public.progress where user_id = p_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = p_user and x.client_trip_id = p_client_trip_id;
  if found then
    return jsonb_build_object('version', 23, 'phoneUse', true, 'existing', v_existing, 'merge', null);
  end if;
  -- the merge target: the latest kept drive, ended at most MERGE_GAP_S (300 s) before this start,
  -- whose end (held only in progress.last_end_*) is within MERGE_RADIUS_M (150 m) of this start
  select * into t from public.trips x
    where x.user_id = p_user and x.merged_into is null
    order by x.started_at desc limit 1;
  if found and not t.not_driving and t.reason is distinct from 'spoofed' and t.reason is distinct from 'implausible'
     and t.ended_at <= p_started_at and p_started_at - t.ended_at <= interval '300 seconds'
     and g.last_end_at = t.ended_at and g.last_end_lat is not null and g.last_end_lng is not null and p_start_lat is not null
     and private.distance_m(g.last_end_lat, g.last_end_lng, p_start_lat, p_start_lng) <= 150
     -- the union stays within the 12-hour drive bound; otherwise this is a separate drive
     and (p_ended_at is null or p_ended_at - t.started_at <= interval '12 hours') then
    v_merge := jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id, 'reason', t.reason,
      'miles', t.miles, 'durationS', t.duration_s,
      'events', private.trip_events_json(t.id),
      'dashcam', jsonb_build_object('deviceId', t.dashcam_device_id, 'movingS', t.dashcam_moving_s,
        'coveredS', t.dashcam_covered_s, 'synced', t.dashcam_synced));
  end if;
  return jsonb_build_object('version', 23, 'phoneUse', true, 'existing', null, 'merge', v_merge);
end $$;

-- apply_drive(p): write the drive (or the union into its merge target), its events, counts and
-- opportunity counters (phone seconds included), the week's goals, the achievements and the rating;
-- returns the stored answer. No points, no streak.
-- p = { user, mergeInto, dashcam, payload { clientTripId, startedAt, endedAt, tz, localDay, miles,
--       nightMiles, durationS, end, polyline, appVersion, dashcam, origin, notDrivingExpired,
--       exposure { slowdowns, speedups, turns, limitS, movingS, phoneS? } }, scored, reason, events,
--       scoringVersion }
create or replace function private.apply_drive(p jsonb) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_user uuid;
  pl jsonb;
  ev jsonb;
  ex jsonb;
  v_existing jsonb;
  v_merge uuid;
  tgt public.trips%rowtype;
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
  v_own_slow int; v_own_up int; v_own_turn int; v_own_limit int; v_own_moving int; v_own_phone int;
  v_own_dur int;
  v_count_cap int;
  v_shift interval := interval '0';
  v_shift_ms numeric := 0;
  v_own_started timestamptz;
  v_own_local_day date;
  v_ev_ms numeric;
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
  if v_user is null or jsonb_typeof(pl) is distinct from 'object' or jsonb_typeof(ev) is distinct from 'array'
     or jsonb_typeof(p -> 'scored') is distinct from 'boolean' or jsonb_array_length(ev) > 1000 then
    raise exception 'apply_drive needs user, payload, events and scored' using errcode = 'invalid_parameter_value';
  end if;
  v_client := (pl ->> 'clientTripId')::uuid;
  v_scored := (p ->> 'scored')::boolean;
  v_reason := p ->> 'reason';
  v_merge := (p ->> 'mergeInto')::uuid;
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
  -- end now (its length kept, its local day and week read again; drive_context applies the same
  -- rule). Nothing is refused, so a phone with a wrong clock never loses a drive. A drive dated in
  -- the past is taken as dated: it weighs less (or nothing, past 90 days), which is no more than
  -- the driver could get by never uploading it.
  if v_ended > now() + interval '10 minutes' then
    v_shift := v_ended - now();
    v_shift_ms := extract(epoch from v_shift) * 1000;
    v_started := v_started - v_shift;
    v_ended := now();
    v_local_day := (v_started at time zone v_tz)::date;
  end if;
  v_own_started := v_started;
  v_own_local_day := v_local_day;
  v_own_dur := v_dur;
  -- DashPal: the stored seconds and their flag (absent = none)
  dc := case when jsonb_typeof(p -> 'dashcam') = 'object' then p -> 'dashcam' else null end;
  pdc := case when jsonb_typeof(pl -> 'dashcam') = 'object' then pl -> 'dashcam' else null end;
  if not private.dashcam_valid(p -> 'dashcam', 86400, true) or not private.dashcam_valid(pl -> 'dashcam', 43200, false) then
    raise exception 'dashcam seconds are out of range' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(pl -> 'end') = 'object' then
    v_end_lat := (pl -> 'end' ->> 'lat')::double precision;
    v_end_lng := (pl -> 'end' ->> 'lng')::double precision;
    if v_end_lat is null or v_end_lng is null or v_end_lat not between -90 and 90 or v_end_lng not between -180 and 180 then
      raise exception 'end must be a lat/lng pair on the globe' using errcode = 'invalid_parameter_value';
    end if;
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
  v_own_moving := least(v_dur, 43200, ceil(v_miles::float8 * 720::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'movingS')::numeric)::int, v_exp.moving_s));
  v_own_limit := least(v_own_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'limitS')::numeric)::int, v_exp.limit_s));
  v_own_phone := least(v_own_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'phoneS')::numeric)::int, 0));
  v_count_cap := least(20000, ceil(v_miles * 40)::int);
  v_own_slow := least(v_count_cap, greatest(1, ceil(v_own_moving / 15.0)::int), coalesce(floor((ex ->> 'slowdowns')::numeric)::int, v_exp.slowdowns));
  v_own_up := least(v_count_cap, greatest(1, ceil(v_own_moving / 15.0)::int), coalesce(floor((ex ->> 'speedups')::numeric)::int, v_exp.speedups));
  v_own_turn := least(v_count_cap, greatest(1, ceil(v_own_moving / 10.0)::int), coalesce(floor((ex ->> 'turns')::numeric)::int, v_exp.turns));
  v_slow := v_own_slow; v_up := v_own_up; v_turn := v_own_turn; v_limit := v_own_limit; v_moving := v_own_moving; v_phone := v_own_phone;

  perform 1 from public.progress where user_id = v_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = v_user and x.client_trip_id = v_client;
  if found then
    return v_existing;
  end if;

  -- merge: the union is written into the target's row; nothing is reverted
  if v_merge is not null then
    select * into tgt from public.trips x where x.id = v_merge and x.user_id = v_user for update;
    if not found or tgt.merged_into is not null or tgt.not_driving or tgt.reason in ('spoofed', 'implausible') then
      raise exception 'merge target not found' using errcode = 'no_data_found';
    end if;
    v_started := tgt.started_at;
    v_local_day := tgt.local_day;
    v_tz := tgt.tz;
    v_miles := tgt.miles + v_miles; v_night := tgt.night_miles + v_night;
    v_dur := tgt.duration_s + v_dur;
    -- the union's counters (the target's are never null after the backfill)
    v_slow := least(20000, tgt.slowdowns + v_slow); v_up := least(20000, tgt.speedups + v_up);
    v_turn := least(20000, tgt.turns + v_turn); v_moving := least(43200, tgt.moving_s + v_moving);
    v_limit := least(v_moving, tgt.limit_s + v_limit);
    v_phone := least(v_moving, tgt.phone_s + v_phone);
    -- the route is a list of visible runs, never joined: the target's first; over the column limit
    -- the longer of the two is kept
    v_poly := case when coalesce(tgt.polyline, '') = '' then v_poly
                   when v_poly = '' then tgt.polyline
                   when char_length(tgt.polyline) + 1 + char_length(v_poly) <= 65536 then tgt.polyline || ' ' || v_poly
                   when char_length(v_poly) > char_length(tgt.polyline) then v_poly
                   else tgt.polyline end;
    v_trip := tgt.id;
    -- one drive: it started the way its first leg did, and its "Not driving?" ran out if either leg's did
    v_origin := tgt.origin;
    v_expired := tgt.not_driving_expired or v_expired;
    if v_ended - v_started > interval '12 hours' then
      raise exception 'merged drive would exceed 12 hours' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_week := private.league_week(v_started);

  if v_merge is null then
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
  else
    update public.trips set ended_at = v_ended, miles = v_miles, night_miles = v_night, duration_s = v_dur,
        dashcam_device_id = dc ->> 'deviceId', dashcam_moving_s = coalesce((dc ->> 'movingS')::int, 0),
        dashcam_covered_s = coalesce((dc ->> 'coveredS')::int, 0), dashcam_synced = coalesce((dc ->> 'synced')::boolean, false),
        dashcam_on = coalesce((dc ->> 'on')::boolean, false),
        polyline = v_poly, scored = v_scored, reason = v_reason, not_driving_expired = v_expired,
        slowdowns = v_slow, speedups = v_up, turns = v_turn, limit_s = v_limit, moving_s = v_moving, phone_s = v_phone,
        scoring_version = coalesce((p ->> 'scoringVersion')::int, scoring_version)
      where id = v_trip;
  end if;

  -- events: a new row is always active; a row the drive already holds (a merge re-sends the
  -- target's) keeps its status: removal happens in dispute_event alone
  for e in select x from jsonb_array_elements(ev) x loop
    if (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or e ->> 'type' not in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy')
       or e ->> 'tier' not in ('minor', 'moderate', 'severe') or (e ->> 'startedAt')::numeric is null or (e ->> 'durationS')::numeric is null
       -- a DashPal event is severe only
       or (e ->> 'type' in ('eyes_off', 'drowsy') and e ->> 'tier' <> 'severe') then
      raise exception 'event needs id, type, tier, startedAt and durationS' using errcode = 'invalid_parameter_value';
    end if;
    -- an event the drive already holds (the merge target's, re-sent) stays exactly as stored
    if exists (select 1 from public.trip_events x where x.trip_id = v_trip and x.client_event_id = (e ->> 'id')::uuid) then
      continue;
    end if;
    -- the upload's own event, moved with its drive when the clock rule moved it
    v_ev_ms := (e ->> 'startedAt')::numeric - v_shift_ms;
    if v_ev_ms not between extract(epoch from v_started) * 1000 - 60000 and extract(epoch from v_ended) * 1000 + 60000 then
      raise exception 'event starts outside the drive' using errcode = 'invalid_parameter_value';
    end if;
    -- a phone pickup (scoring phonePickupTier: moderate up to 15 s in hand, severe beyond) is in hand
    -- a whole number of seconds, from 1 to the upload's own length, and starts inside the upload's own
    -- drive (no slack: the phone checked the same before it sent it)
    if e ->> 'type' = 'phone_pickup' and (
         e ->> 'tier' not in ('moderate', 'severe')
         or (e ->> 'durationS')::numeric <> floor((e ->> 'durationS')::numeric)
         or (e ->> 'durationS')::numeric not between 1 and v_own_dur
         or v_ev_ms not between extract(epoch from v_own_started) * 1000 and extract(epoch from v_ended) * 1000) then
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

  -- the merged-away upload keeps its own row (unscored, pointing at the target), with its own facts
  if v_merge is not null then
    insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
        dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced,
        polyline, scored, merged_into, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s, phone_s,
        scoring_version, app_version)
      values (v_user, v_client, v_own_started, v_ended, v_own_local_day,
        private.league_week(v_own_started), pl ->> 'tz',
        (pl ->> 'miles')::numeric, (pl ->> 'nightMiles')::numeric, (pl ->> 'durationS')::int,
        pdc ->> 'deviceId', coalesce((pdc ->> 'movingS')::int, 0), coalesce((pdc ->> 'coveredS')::int, 0), coalesce((pdc ->> 'synced')::boolean, false),
        coalesce(pl ->> 'polyline', ''), false, v_trip,
        coalesce(pl ->> 'origin', 'manual'), coalesce((pl ->> 'notDrivingExpired')::boolean, false),
        v_own_slow, v_own_up, v_own_turn, v_own_limit, v_own_moving, v_own_phone,
        coalesce((p ->> 'scoringVersion')::int, 8), left(pl ->> 'appVersion', 32));
  end if;

  -- the latest end, for the next drive's merge check (every applied drive, scored or not)
  update public.progress set last_end_lat = v_end_lat, last_end_lng = v_end_lng, last_end_at = v_ended where user_id = v_user;
  if v_scored then
    perform private.ensure_challenges(v_user, v_week);
    v_challenges := private.sync_challenges(v_user, v_week, v_trip);
    v_achievements := private.check_achievements(v_user, v_week);
  end if;
  perform private.refresh_rating(v_user);

  v_resp := jsonb_build_object(
    'tripId', v_trip, 'clientTripId', v_client,
    'mergedInto', case when v_merge is null then null else tgt.client_trip_id end,
    'scored', v_scored, 'reason', v_reason,
    'eventIds', coalesce((select jsonb_agg(x.client_event_id order by x.started_at, x.client_event_id)
                          from public.trip_events x where x.trip_id = v_trip), '[]'::jsonb),
    'rating', (select jsonb_build_object('safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = v_user),
    'challenges', v_challenges, 'achievements', v_achievements);
  update public.trips set result = v_resp where user_id = v_user and client_trip_id = v_client;
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------
-- reports: "My phone was mounted" for a phone pickup
-- ---------------------------------------------------------------------------

-- the auto-accepts a report's reason has used this week: "DashPal got it wrong" has its own 3; a
-- hazard, a wrong limit and a mounted phone share the other 3 (scoring DISPUTE_AUTO_PER_WEEK)
create or replace function private.dispute_quota_used(p_user uuid, p_reason text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.event_disputes d
  where d.user_id = p_user and d.status = 'accepted' and d.created_at >= private.week_start(now())
    and case when p_reason = 'camera_wrong' then d.reason = 'camera_wrong' else d.reason in ('hazard', 'wrong_limit', 'mounted') end
$$;

-- one report, decided and applied in one call: hazard (a hard brake), wrong_limit (speeding),
-- camera_wrong (a DashPal event), mounted (a phone pickup: "My phone was mounted"); 3 auto-accepts a
-- week for hazard + wrong_limit + mounted and 3 for camera_wrong (dispute_quota_used). An accepted
-- report removes the event and updates the drive's counts and clean flag, the week's goals, the
-- achievements and the rating. A repeat with the same reason answers what was stored and writes
-- nothing.
create or replace function private.dispute_event(p_user uuid, p_client_trip_id uuid, p_event_id uuid, p_reason text) returns jsonb
language plpgsql volatile set search_path = public as $$
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
  if not found or t.merged_into is not null or t.not_driving then
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
end $$;

-- ---------------------------------------------------------------------------
-- client reads: the drive list carries phoneS, the category scores name Phone use
-- ---------------------------------------------------------------------------

-- list_my_drives(p_before, p_limit): the caller's kept drives newest first, with events and the stored answer
create or replace function public.list_my_drives(p_before timestamptz default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
      'events', private.trip_events_json(t.id))
    -- LEGACY (Phase B removes): keys a build from before this migration requires
    || jsonb_build_object('pointsNet', null, 'safeMiles', 0)) order by t.started_at desc), '[]'::jsonb)
    into v_out
  from (
    select * from public.trips t
    where t.user_id = v_uid and t.merged_into is null and (p_before is null or t.started_at < p_before)
    order by t.started_at desc
    limit p_limit
  ) t;
  return v_out;
end $$;

-- get_profile(p_username): the public profile, or "not found" (also when blocked either way). What a
-- friend sees follows the driver's sharing settings; anyone else sees the name and nothing more.
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_rel text;
  v_friend boolean;
  v_self boolean;
  pr public.profiles%rowtype;
  s jsonb;
  v_scores jsonb := null;
begin
  if v_uid is null then
    raise exception 'get_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_username is null or char_length(p_username) > 20 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'get_profile', interval '1 minute', 60);
  select * into pr from public.profiles p
    where p.username operator(extensions.=) p_username::extensions.citext and p.onboarded_at is not null;
  v_other := pr.id;
  if v_other is null or private.blocked_either(v_uid, v_other) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  v_self := v_other = v_uid;
  v_friend := not v_self and private.are_friends(v_uid, v_other);
  v_rel := case
    when v_self then 'self'
    when v_friend then 'friend'
    when exists (select 1 from public.friend_requests r where r.from_id = v_other and r.to_id = v_uid) then 'incoming'
    when exists (select 1 from public.friend_requests r where r.from_id = v_uid and r.to_id = v_other) then 'outgoing'
    else 'none' end;
  -- the category scores, whole numbers (half up), each null where it has no score (Attention without
  -- DashPal, Phone use before any drive was watched for it): to a friend only with the Safety Rating
  -- shared too, since the rating is their weighted mean and would show through them. The rating is
  -- computed once, into a variable: an inline subquery would be copied into each of the twelve reads.
  if v_self or (v_friend and pr.share_rating and pr.share_categories) then
    s := private.rating_at(v_other, now()) -> 'scores';
    v_scores := jsonb_build_object(
      'acceleration', case when s ->> 'acceleration' is null then null else private.round_half_up((s ->> 'acceleration')::float8, 0)::int end,
      'braking', case when s ->> 'braking' is null then null else private.round_half_up((s ->> 'braking')::float8, 0)::int end,
      'turning', case when s ->> 'turning' is null then null else private.round_half_up((s ->> 'turning')::float8, 0)::int end,
      'attention', case when s ->> 'attention' is null then null else private.round_half_up((s ->> 'attention')::float8, 0)::int end,
      'phone', case when s ->> 'phone' is null then null else private.round_half_up((s ->> 'phone')::float8, 0)::int end,
      'speed', case when s ->> 'speed' is null then null else private.round_half_up((s ->> 'speed')::float8, 0)::int end);
  end if;
  return private.public_card(v_other, v_uid) || jsonb_build_object(
    'achievements', case when v_self or (v_friend and pr.share_achievements)
      then coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_other), '[]'::jsonb)
      else '[]'::jsonb end,
    'scores', v_scores,
    -- LEGACY (Phase B removes): clans are server-only; an older build reads the key
    'clan', null,
    'relationship', v_rel,
    'can_view_stats', v_self or (v_friend and pr.share_stats),
    'can_view_heatmap', v_self or (v_friend and pr.heatmap_visibility = 'friends'));
end $$;

-- every replaced function keeps its grants; no function is new
notify pgrst, 'reload schema';
