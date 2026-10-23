-- 0028_every_event_counts: scoring version 9. Every event that qualifies weighs on its category,
-- and more for a more severe one; dividing by the drive's own opportunities still means one event
-- marks a long drive down less than a short one.
--
--   * Speeding has no grace: every episode is an event from its first second over the line, and its
--     weight counts every one of its seconds (speeding_weight: n = max(1, duration), was duration - 5),
--     times (mean mph over the line / 5)^1.5 as before. The Speed count is those same seconds.
--   * A hard brake, start or turn weighs (peak g / its type's threshold)^2 between 1 and 4
--     (hard_event_weight; thresholds 0.30 brake, 0.32 start, 0.40 turn); an event without a
--     measured peak keeps its tier's 1 (minor) or 2 (severe).
--   * A phone pickup weighs (10 + its seconds in hand) x the speed factor of the highest speed it
--     was driven at (phone_pickup_weight; maxSpeedMph, else speedMph, else 1).
--   * A DashPal event weighs its base (eyes off 40, drowsy 50) x the speed factor of its speed x its
--     length over 5 s, between 1 and 3 (attention_weight).
--   * The speed factor is min(80, max(10, mph)) / 30: 30 mph weighs 1, 60 mph 2 (speed_factor).
--   * rating_at sums every weight in the TypeScript's order (drives by started_at then
--     client_trip_id, events by started_at then client_event_id): the hard-event weights are no
--     longer whole numbers, so their sums are ordered too. It stays the SQL copy of scoring ratingAt
--     and agrees with it to the digit.
--   * New drives store scoring_version 9 (the column default; finalize-trip sends it). Every stored
--     event is read under these rules from now on, and every driver's rating is refreshed at the end.
--
-- No table, policy or grant changes: the four new helpers are invoker SQL functions in private,
-- revoked from public, anon and authenticated like every rating helper (0023). Deploy order: this
-- migration with the app build that records events under these rules; either order is safe (the
-- server only stores the events the phone sends and rates what it holds).

alter table public.trips alter column scoring_version set default 9;

-- scoring speedFactor: min(80, max(10, mph)) / 30; 1 with no speed
create or replace function private.speed_factor(p_mph double precision) returns double precision
language sql immutable set search_path = public as $$
  select case when p_mph is null then 1::float8 else least(80::float8, greatest(10::float8, p_mph)) / 30::float8 end
$$;

-- scoring speedingWeight: n = max(1, duration) (every second over the line) times x * sqrt(x),
-- x = min(40, mean over) / 5, the mean over from measured.overMphS (or the tier's legacy mean: minor
-- 2, moderate 6.5, severe 12). Written n * x * sqrt(x), as the TypeScript is, so the two agree bit for bit.
create or replace function private.speeding_weight(p_duration_s numeric, p_measured jsonb, p_tier text) returns double precision
language sql immutable set search_path = public as $$
  with n as (select greatest(1::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8)) as n),
  m as (select case when jsonb_typeof(p_measured -> 'overMphS') = 'number' then (p_measured ->> 'overMphS')::float8 / n.n
                    else (case p_tier when 'severe' then 12 when 'moderate' then 6.5 else 2 end)::float8 end as mean from n),
  x as (select least(40::float8, greatest(0::float8, m.mean)) / 5::float8 as x from m)
  select n.n * x.x * sqrt(x.x) from n, x
$$;

-- scoring hardEventWeight: (peakG / the type's threshold)^2 between 1 and 4, written r * r; without a
-- measured peak, the tier's 1 (minor) or 2 (severe)
create or replace function private.hard_event_weight(p_type text, p_tier text, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_measured -> 'peakG') = 'number' then
      (select least(4::float8, greatest(1::float8, r.r * r.r))
         from (select (p_measured ->> 'peakG')::float8
                 / (case p_type when 'hard_brake' then 0.3::float8 when 'hard_accel' then 0.32::float8 else 0.4::float8 end) as r) r)
    else (case when p_tier = 'severe' then 2 else 1 end)::float8 end
$$;

-- scoring phonePickupWeight: (10 + its seconds in hand, clamped to 0..43 200) x speed_factor of
-- measured.maxSpeedMph, else measured.speedMph, else 1
create or replace function private.phone_pickup_weight(p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select (10::float8 + least(43200::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8)))
    * private.speed_factor(coalesce(
        case when jsonb_typeof(p_measured -> 'maxSpeedMph') = 'number' then (p_measured ->> 'maxSpeedMph')::float8 end,
        case when jsonb_typeof(p_measured -> 'speedMph') = 'number' then (p_measured ->> 'speedMph')::float8 end))
$$;

-- scoring attentionWeight: attention_penalty_of (eyes off 40, drowsy 50) x speed_factor of
-- measured.speedMph x min(3, max(1, duration / 5)), multiplied left to right; 0 for any other type
create or replace function private.attention_weight(p_type text, p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select private.attention_penalty_of(p_type)::float8
    * private.speed_factor(case when jsonb_typeof(p_measured -> 'speedMph') = 'number' then (p_measured ->> 'speedMph')::float8 end)
    * least(3::float8, greatest(1::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8) / 5::float8))
$$;

-- what an active event adds to its rate category's weight (scoring eventWeight): hard_event_weight,
-- speeding_weight, phone_pickup_weight, anything else 0 (a DashPal event weighs on Attention:
-- attention_weight)
create or replace function private.event_weight_of(p_type text, p_tier text, p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case
    when p_type in ('hard_brake', 'hard_accel', 'hard_corner') then private.hard_event_weight(p_type, p_tier, p_measured)
    when p_type = 'speeding' then private.speeding_weight(p_duration_s, p_measured, p_tier)
    when p_type = 'phone_pickup' then private.phone_pickup_weight(p_duration_s, p_measured)
    else 0::float8 end
$$;

-- scoring ratingAt: the rating as of p_at over the kept scored drives started in (p_at - 90 d, p_at],
-- each weighted by its age in whole days. Every sum runs in the TypeScript's order (drives by
-- started_at then client_trip_id, events by started_at then client_event_id) in double precision,
-- so the phone and the server agree to the digit.
--   per rate axis: W = sum(w * weight), O = sum(w * max(opportunities, count)),
--                  score = rate_score((W + prior * rate) / (O + prior), rate)
--   hard events: weight hard_event_weight, count 1 each; opportunities slowdowns / speedups / turns
--   Speed: weight speeding_weight, count the seconds over the line (max(1, duration)), opportunities limit_s
--   Phone use: weight phone_pickup_weight, count the seconds in hand, opportunities phone_s; null when
--              its O is 0 (no phone seconds and no pickup in the window)
--   Attention: P = sum(w * attention_weight), M = sum(w * watched miles); category_score(P, M, 10) when M > 0
--   rating = the weighted mean (Speed 2, Phone use 2, the rest 1), clamped, half up to 1 decimal
-- Set-based, as 0023 made it: the window's drives; their active events summed per drive and category
-- in one grouped scan, each ordered sum adding in the event order; then the weighted sums over the
-- drives, each ordered sum adding in the drive order. An ordered float8 sum adds one term at a time
-- in that order, exactly as the TypeScript's loops do.
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
end $$;

-- the new helpers: nobody but the definer RPCs that rate (as postgres) calls them
revoke all on function private.speed_factor(double precision) from public, anon, authenticated;
revoke all on function private.hard_event_weight(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.phone_pickup_weight(numeric, jsonb) from public, anon, authenticated;
revoke all on function private.attention_weight(text, numeric, jsonb) from public, anon, authenticated;

-- every driver's rating under the new rules (the last statement)
do $$
declare r record;
begin
  for r in select user_id from public.progress loop
    perform private.refresh_rating(r.user_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
