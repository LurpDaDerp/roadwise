-- 0048_scoring_v13: scoring version 13, the SQL copy of packages/scoring to the digit.
--
--   * Category weights: Phone use, Speed and Attention 3, Braking 2, Acceleration and Turning 1.
--   * The Safety Rating and the drive score combine their scored categories with a weighted
--     harmonic mean, sum(w) / sum(w / s), in radar order (private.weighted_score, the TypeScript's
--     weightedScore term for term), so a weak category pulls the total down harder than a strong
--     one lifts it. A null category is left out of both sums, as before.
--   * Speed: a speeding event weighs n x x x, x = min(5, max(0, mean over) / (L / 7)), L its posted
--     limit (measured.limitMph; 5 mph as the reference without one of at least 1 mph). The mean over
--     and the legacy tier means are as before.
--   * Attention is a rate category like the others: its opportunities are the seconds DashPal
--     watched (covered seconds held to moving seconds, on the terms that gave watched miles), the
--     typical rate 0.024 per watched second, the prior 3600 s in the Safety Rating, the drive floor
--     3600 s; a drowsy episode's base weight is 80 (eyes off 40). private.category_score goes.
--   * The drive score (Wrapped's average score) floors each category's opportunities at the size of
--     the rating's prior: 60 slowdowns, 60 speed-ups, 60 turns, and 3600 s for Speed, Phone use and
--     Attention. A clean drive still scores 100; one event on a short drive weighs no more than it
--     would in the rating.
--
-- Nothing a driver recorded is rewritten: trips, events, their measurements, exposure counters and
-- DashPal seconds are read as they stand. Only derived values are rebuilt, under the new math:
--   * every driver's stored rating (progress.safety_rating, ranked, miles_90d and rating_week_ago),
--     so Home's "up / down this week" and the weekly recap compare like with like from the first day;
--   * the Wrapped cohort (private.monthly_stats) for every month it holds, so every month's
--     percentiles compare a driver's live row with a cohort on the same math;
--   * the Wrapped archive's lines (private.wrapped_archive), so the archive list shows each past
--     month's archetype under the new math. Wrapped is computed live, so every month (closed ones
--     included) reads the new math. Shared Wrapped snapshots (public.wrapped_shares) stay as they
--     were shared.
--
-- Same signatures, owners, security and search_paths for every replaced function; the grants are
-- restated as they stand. No RPC or Edge Function response changes shape.
--
-- Deploy: this migration, then finalize-trip (it stamps new drives with scoring version 13), then
-- the app build.

-- ---------------------------------------------------------------------------
-- event weights
-- ---------------------------------------------------------------------------
-- scoring speedingWeight: n = max(1, duration) (every second over the line) times x * x,
-- x = min(5, max(0, mean over) / ref), ref = measured.limitMph / 7 when it is a number of at least
-- 1 (no real road posts less, and a near-zero limit would overflow the division), else 5; the mean over from measured.overMphS (or the tier's legacy mean: minor 2, moderate 6.5, severe
-- 12). Written n * x * x, as the TypeScript is, so the two agree bit for bit.
create or replace function private.speeding_weight(p_duration_s numeric, p_measured jsonb, p_tier text) returns double precision
language sql immutable set search_path = public as $$
  with n as (select greatest(1::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8)) as n),
  m as (select case when jsonb_typeof(p_measured -> 'overMphS') = 'number' then (p_measured ->> 'overMphS')::float8 / n.n
                    else (case p_tier when 'severe' then 12 when 'moderate' then 6.5 else 2 end)::float8 end as mean from n),
  r as (select case when jsonb_typeof(p_measured -> 'limitMph') = 'number' and (p_measured ->> 'limitMph')::float8 >= 1::float8
                    then (p_measured ->> 'limitMph')::float8 / 7::float8 else 5::float8 end as ref),
  x as (select least(5::float8, greatest(0::float8, m.mean) / r.ref) as x from m, r)
  select n.n * x.x * x.x from n, x
$$;

-- scoring ATTENTION_PENALTY: a DashPal episode's base weight, eyes off 40, drowsy 80; 0 for any other type
create or replace function private.attention_penalty_of(p_type text) returns int
language sql immutable set search_path = public as $$
  select case p_type when 'eyes_off' then 40 when 'drowsy' then 80 else 0 end
$$;

-- scoring attentionWeight: attention_penalty_of (eyes off 40, drowsy 80) x speed_factor of
-- measured.speedMph x min(3, max(1, duration / 5)), multiplied left to right; 0 for any other type
create or replace function private.attention_weight(p_type text, p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select private.attention_penalty_of(p_type)::float8
    * private.speed_factor(case when jsonb_typeof(p_measured -> 'speedMph') = 'number' then (p_measured ->> 'speedMph')::float8 end)
    * least(3::float8, greatest(1::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8) / 5::float8))
$$;

-- ---------------------------------------------------------------------------
-- combining the categories
-- ---------------------------------------------------------------------------
-- scoring weightedScore: the weighted harmonic mean sum(w) / sum(w / s) of the scored categories,
-- each sum added in radar order (acceleration 1, braking 2, turning 1, attention 3, phone use 3,
-- speed 3); a null, non-finite or non-positive score is left out of both sums; null when none is
-- scored. Unrounded. One term at a time, exactly as the TypeScript's loop adds them.
create or replace function private.weighted_score(p_acceleration double precision, p_braking double precision, p_turning double precision,
  p_attention double precision, p_phone double precision, p_speed double precision) returns double precision
language plpgsql immutable set search_path = public as $$
declare
  v_w float8 := 0;
  v_inv float8 := 0;
begin
  -- a score is used when above 0 and finite ('NaN' sorts above 'Infinity', so both fail the bound)
  if p_acceleration > 0::float8 and p_acceleration < 'Infinity'::float8 then
    v_w := v_w + 1::float8; v_inv := v_inv + 1::float8 / p_acceleration;
  end if;
  if p_braking > 0::float8 and p_braking < 'Infinity'::float8 then
    v_w := v_w + 2::float8; v_inv := v_inv + 2::float8 / p_braking;
  end if;
  if p_turning > 0::float8 and p_turning < 'Infinity'::float8 then
    v_w := v_w + 1::float8; v_inv := v_inv + 1::float8 / p_turning;
  end if;
  if p_attention > 0::float8 and p_attention < 'Infinity'::float8 then
    v_w := v_w + 3::float8; v_inv := v_inv + 3::float8 / p_attention;
  end if;
  if p_phone > 0::float8 and p_phone < 'Infinity'::float8 then
    v_w := v_w + 3::float8; v_inv := v_inv + 3::float8 / p_phone;
  end if;
  if p_speed > 0::float8 and p_speed < 'Infinity'::float8 then
    v_w := v_w + 3::float8; v_inv := v_inv + 3::float8 / p_speed;
  end if;
  if v_w > 0::float8 then
    return v_w / v_inv;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- the Safety Rating
-- ---------------------------------------------------------------------------
-- scoring ratingAt: the rating as of p_at over the kept scored drives started in (p_at - 90 d, p_at],
-- each weighted by its age in whole days. Every sum runs in the TypeScript's order (drives by
-- started_at then client_trip_id, events by started_at then client_event_id) in double precision,
-- so the phone and the server agree to the digit.
--   per category: W = sum(w * weight), O = sum(w * max(opportunities, count)),
--                 score = rate_score((W + prior * rate) / (O + prior), rate)
--   hard events: weight hard_event_weight, count 1 each; opportunities slowdowns / speedups / turns
--   Speed: weight speeding_weight, count the seconds over the line (max(1, duration)), opportunities limit_s
--   Phone use: weight phone_pickup_weight, count the seconds in hand, opportunities phone_s; null when
--              its O is 0 (no phone seconds and no pickup in the window)
--   Attention: weight attention_weight, opportunities the watched seconds; null when its O is 0
--   rating = weighted_score, clamped, half up to 1 decimal
create or replace function private.rating_at(p_user uuid, p_at timestamp with time zone)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_miles numeric;
  bw float8; bo float8; aw float8; ao float8; tw float8; tow float8; sw float8; so float8; pw float8; po float8;
  ap float8; ao_att float8;
  s_b float8; s_a float8; s_t float8; s_s float8; s_att float8; s_p float8;
  v_mean float8;
begin
  if p_user is null or p_at is null then
    raise exception 'user and time are required' using errcode = 'invalid_parameter_value';
  end if;
  with d as materialized (
    select t.id, t.client_trip_id, t.started_at, t.miles, t.slowdowns, t.speedups, t.turns, t.limit_s, t.phone_s,
      private.recency_weight(floor(extract(epoch from (p_at - t.started_at)) / 86400)::int) as w,
      -- scoring watchedSeconds: the covered seconds held to the moving seconds
      case when t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0
           then least(t.dashcam_covered_s, t.dashcam_moving_s)::float8
           else 0::float8 end as watched_s
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
    select d.client_trip_id, d.started_at, d.miles, d.w,
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
      d.w * coalesce(ev.att, 0::float8) as att_w,
      -- Attention's count is 0: only watched seconds open it
      d.w * d.watched_s as att_o
    from d left join ev on ev.trip_id = d.id
  )
  select coalesce(sum(greatest(x.miles, 0)), 0),
    coalesce(sum(x.b_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.b_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.a_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.a_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.t_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.t_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.s_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.s_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.p_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.p_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.att_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.att_o order by x.started_at, x.client_trip_id), 0::float8)
    into v_miles, bw, bo, aw, ao, tw, tow, sw, so, pw, po, ap, ao_att
  from x;
  if v_miles <= 0 then
    return jsonb_build_object('rating', null, 'ranked', false, 'miles', 0, 'scores', jsonb_build_object(
      'acceleration', null, 'braking', null, 'turning', null, 'attention', null, 'phone', null, 'speed', null));
  end if;
  -- scoring BASELINE: braking 0.010 / 60, acceleration 0.008 / 60, turning 0.008 / 60, speed 0.040 / 3600,
  -- phone 0.040 / 3600, attention 0.024 / 3600
  s_b := private.rate_score((bw + 60::float8 * 0.010::float8) / (bo + 60::float8), 0.010::float8);
  s_a := private.rate_score((aw + 60::float8 * 0.008::float8) / (ao + 60::float8), 0.008::float8);
  s_t := private.rate_score((tw + 60::float8 * 0.008::float8) / (tow + 60::float8), 0.008::float8);
  s_s := private.rate_score((sw + 3600::float8 * 0.040::float8) / (so + 3600::float8), 0.040::float8);
  -- not tracked, no score: no phone seconds and no pickup in the window (every drive before 0026)
  s_p := case when po > 0 then private.rate_score((pw + 3600::float8 * 0.040::float8) / (po + 3600::float8), 0.040::float8) end;
  -- no DashPal drive in the window, no score
  s_att := case when ao_att > 0 then private.rate_score((ap + 3600::float8 * 0.024::float8) / (ao_att + 3600::float8), 0.024::float8) end;
  v_mean := private.weighted_score(s_a, s_b, s_t, s_att, s_p, s_s);
  return jsonb_build_object(
    'rating', case when v_mean is null then null else round(private.round_half_up(least(100::float8, greatest(0::float8, v_mean)), 1)::numeric, 1) end,
    'ranked', v_miles >= 10, 'miles', v_miles,
    'scores', jsonb_build_object('acceleration', s_a, 'braking', s_b, 'turning', s_t, 'attention', s_att, 'phone', s_p, 'speed', s_s));
end $function$
;

-- ---------------------------------------------------------------------------
-- Wrapped: the drive score
-- ---------------------------------------------------------------------------
-- One row per kept scored drive of the month (every driver's, or p_user's) with its active event
-- counts and its drive score, the SQL copy of scoring driveScore: per category weight /
-- max(opportunities, floor, count) with no prior (braking, acceleration, turning 60; speed and phone
-- use 3600 s; Attention 3600 watched seconds, count 0), Attention only when DashPal watched, Phone use
-- only with phone seconds or a pickup; weighted_score, clamped and rounded half up to a whole
-- number. Null with no miles.
create or replace function private.wrapped_trips(p_month text, p_user uuid default null)
returns table (user_id uuid, trip_id uuid, started_at timestamptz, tz text, miles numeric, duration_s int, clean boolean,
  n_hard int, n_speeding int, n_pickup int, score double precision)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
declare
  v_d0 date := private.wrapped_month_start(p_month);
  v_d1 date := (private.wrapped_month_start(p_month) + interval '1 month')::date;
  v_ids uuid[];
begin
  if p_user is null then
    -- the started_at range lets the planner read the BRIN index; a local day is within a day of
    -- its UTC start, so three days each side keep every drive of the month
    select coalesce(array_agg(t.id), '{}') into v_ids from public.trips t
    where t.scored and not t.not_driving and t.local_day >= v_d0 and t.local_day < v_d1
      and t.started_at >= (v_d0::timestamp at time zone 'UTC') - interval '3 days'
      and t.started_at < (v_d1::timestamp at time zone 'UTC') + interval '3 days';
  else
    select coalesce(array_agg(t.id), '{}') into v_ids from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.local_day >= v_d0 and t.local_day < v_d1;
  end if;
  return query
  with d as materialized (
    select t.id, t.user_id, t.started_at, t.tz, t.miles, t.duration_s, t.clean,
      coalesce(t.slowdowns, 0) as slowdowns, coalesce(t.speedups, 0) as speedups, coalesce(t.turns, 0) as turns,
      least(coalesce(t.limit_s, 0), coalesce(t.moving_s, 0)) as limit_s, least(coalesce(t.phone_s, 0), coalesce(t.moving_s, 0)) as phone_s,
      -- scoring watchedSeconds
      case when t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0
           then least(t.dashcam_covered_s, t.dashcam_moving_s)::float8
           else 0::float8 end as watched_s
    from public.trips t where t.id = any(v_ids)
  ),
  ev as (
    select e.trip_id,
      count(*) filter (where e.type in ('hard_brake', 'hard_accel', 'hard_corner')) as n_hard,
      count(*) filter (where e.type = 'speeding') as n_speeding,
      count(*) filter (where e.type = 'phone_pickup') as n_pickup,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_brake'), 0::float8) as b_w,
      count(*) filter (where e.type = 'hard_brake') as b_n,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_accel'), 0::float8) as a_w,
      count(*) filter (where e.type = 'hard_accel') as a_n,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_corner'), 0::float8) as t_w,
      count(*) filter (where e.type = 'hard_corner') as t_n,
      coalesce(sum(private.speeding_weight(e.duration_s, e.measured, e.tier) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding'), 0::float8) as s_w,
      -- scoring speedingChargedS: max(1, duration)
      coalesce(sum(greatest(1::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding'), 0::float8) as s_n,
      coalesce(sum(private.phone_pickup_weight(e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup'), 0::float8) as p_w,
      -- scoring phoneInHandS: the seconds in hand clamped to 0..43 200
      coalesce(sum(least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup'), 0::float8) as p_n,
      coalesce(sum(private.attention_weight(e.type, e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type in ('eyes_off', 'drowsy')), 0::float8) as att
    from d join public.trip_events e on e.trip_id = d.id
    where e.status = 'active'
    group by e.trip_id
  ),
  s as (
    select d.*, coalesce(ev.n_hard, 0)::int as n_hard, coalesce(ev.n_speeding, 0)::int as n_speeding, coalesce(ev.n_pickup, 0)::int as n_pickup,
      private.rate_score(coalesce(ev.a_w, 0::float8) / greatest(d.speedups::float8, 60::float8, coalesce(ev.a_n, 0)::float8), 0.008::float8) as s_a,
      private.rate_score(coalesce(ev.b_w, 0::float8) / greatest(d.slowdowns::float8, 60::float8, coalesce(ev.b_n, 0)::float8), 0.010::float8) as s_b,
      private.rate_score(coalesce(ev.t_w, 0::float8) / greatest(d.turns::float8, 60::float8, coalesce(ev.t_n, 0)::float8), 0.008::float8) as s_t,
      case when d.watched_s > 0 then private.rate_score(coalesce(ev.att, 0::float8) / greatest(d.watched_s, 3600::float8, 0::float8), 0.024::float8) end as s_att,
      case when d.phone_s > 0 or coalesce(ev.p_n, 0::float8) > 0
           then private.rate_score(coalesce(ev.p_w, 0::float8) / greatest(d.phone_s::float8, 3600::float8, coalesce(ev.p_n, 0::float8)), 0.040::float8) end as s_p,
      private.rate_score(coalesce(ev.s_w, 0::float8) / greatest(d.limit_s::float8, 3600::float8, coalesce(ev.s_n, 0::float8)), 0.040::float8) as s_s
    from d left join ev on ev.trip_id = d.id
  )
  select s.user_id, s.id, s.started_at, s.tz, s.miles, s.duration_s, s.clean, s.n_hard, s.n_speeding, s.n_pickup,
    case when s.miles > 0 then private.round_half_up(least(100::float8, greatest(0::float8,
      private.weighted_score(s.s_a, s.s_b, s.s_t, s.s_att, s.s_p, s.s_s))), 0) end
  from s;
end $$;

-- the attention curve of scoring version 12 has no reader left
drop function if exists private.category_score(double precision, double precision, double precision);


-- ---------------------------------------------------------------------------
-- derived values rebuilt under the new math
-- ---------------------------------------------------------------------------
-- every driver with a rating or a scored drive in the window: the rating now, ranked, the window's
-- miles and the rating a week ago (private.refresh_rating, as every drive upload and the daily job
-- write them)
do $$
declare
  r record;
begin
  for r in
    select g.user_id from public.progress g
    where g.miles_90d > 0 or g.safety_rating is not null or g.rating_week_ago is not null
      or exists (select 1 from public.trips t where t.user_id = g.user_id and t.scored and not t.not_driving
                   and t.started_at > now() - interval '2160 hours')
    order by g.user_id
  loop
    perform private.refresh_rating(r.user_id);
  end loop;
end $$;

-- the Wrapped cohort: every month private.monthly_stats holds, written again whole
do $$
declare
  r record;
begin
  for r in select distinct s.month from private.monthly_stats s order by 1 loop
    perform private.refresh_monthly_stats(r.month);
  end loop;
end $$;
-- and the current UTC month (on days 1 to 10 the month before too), as the daily job writes it
select private.refresh_monthly_stats_daily(now());

-- the Wrapped archive: each line's archetype, drives and miles computed again (a month no longer
-- eligible keeps its line, which is never read again: list_my_wrapped never lists such a month, and
-- a line is read only while its drives and miles match and it is newer than the month's last trip
-- change, so any change that makes the month eligible again computes it afresh)
do $$
declare
  r record;
  v_s jsonb;
begin
  for r in select c.user_id, c.month from private.wrapped_archive c order by 1, 2 loop
    v_s := private.wrapped_stats(r.user_id, r.month);
    if v_s is not null then
      perform private.wrapped_archive_put(r.user_id, r.month, v_s);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- grants, as they stand (a replaced function keeps its owner and grants)
-- ---------------------------------------------------------------------------
revoke all on function private.speeding_weight(numeric, jsonb, text) from public, anon, authenticated;
revoke all on function private.attention_penalty_of(text) from public, anon, authenticated;
revoke all on function private.attention_weight(text, numeric, jsonb) from public, anon, authenticated;
revoke all on function private.weighted_score(double precision, double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function private.rating_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.wrapped_trips(text, uuid) from public, anon, authenticated;
