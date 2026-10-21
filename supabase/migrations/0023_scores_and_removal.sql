-- 0023_scores_and_removal: points, levels, streaks, freezes, the points ledger, leagues and the
-- global board are gone; phone use is not tracked; weekly challenges are plain weekly goals;
-- "Wasn't driving" works on any drive for 24 hours while its "Not driving?" never ran out; drives
-- record how they started; the server joins a drive to the one before it when it starts within
-- 5 min and 150 m of that one's end; and the Safety Rating judges each category per opportunity
-- over the last 90 days, recent weeks counting more.
--
--   * Each category scores its events per chance to slip: hard brakes per slowdown, hard starts
--     per speed-up, sharp turns per turn (minor 1, severe 2), and speeding by its charged seconds
--     weighted by how far over ((over / 5)^1.5) per second driven under a known limit. A rate is
--     smoothed with a prior at the typical rate (60 slowdowns, speed-ups and turns; 3600 s of
--     limit time) and read on 100 / (1 + (rate / typical) x 15/85): typical driving reads 85.
--     Attention (DashPal) keeps its curve. Each drive weighs 2^(-age/21 d) (a literal table), the
--     window is 90 days and Speed counts double. `private.rating_at` is the SQL copy of scoring
--     `ratingAt` and agrees with it to the digit.
--   * Drives keep their opportunity counters (slowdowns, speedups, turns, limit_s, moving_s);
--     a drive uploaded without them, and every drive stored before this migration, gets the
--     estimate from its miles and duration (`private.estimate_exposure`, scoring `estimateExposure`).
--   * The friends board ranks by Safety Rating only (`get_friends_board()`, no argument).
--
-- Section order is binding: R1 columns, R2 data, S1 the rating, R3 the engine, R4 data the new
-- functions fix, R5 drops, R6 dropped columns and tightened CHECKs, R7 grants, S2 the backfill and
-- the recompute (last).
--
-- Deploy order: push-sender (its recap copy reads old and new payloads), then this migration (with
-- 0024 and 0025), then finalize-trip, trip-actions and live-activity-start. Either order of the
-- last two steps fails safe: the older functions read contexts this migration changed, or call
-- functions it dropped, and answer 500, which phones retry; the newer functions refuse a database
-- without `version: 23` the same way.

-- ---------------------------------------------------------------------------
-- R1 how a drive started, and whether its "Not driving?" ran out
-- ---------------------------------------------------------------------------
alter table public.trips
  add column origin text not null default 'manual' check (origin in ('auto', 'manual')),
  add column not_driving_expired boolean not null default false;

-- ---------------------------------------------------------------------------
-- R2 phone use is not tracked: its events go (a report on one goes with it, by cascade)
-- ---------------------------------------------------------------------------
-- the drives that held one keep counts and a clean flag from the events they keep
update public.trips t set
    n_events = c.n,
    clean = t.scored and c.n = 0
  from (select x.id, (select count(*) from public.trip_events e
                      where e.trip_id = x.id and e.status = 'active'
                        and e.type not in ('eyes_off', 'drowsy', 'phone_pickup', 'phone_handling'))::int as n
        from public.trips x where x.n_pickup > 0 or x.handling_s > 0) c
  where c.id = t.id;
delete from public.event_disputes where reason = 'mounted';
delete from public.trip_events where type in ('phone_pickup', 'phone_handling');

-- the two templates that were about phone use and points, and their assignments; the three left are
-- plain weekly goals, worded as the app shows them
delete from public.weekly_challenges where template_id in ('no_pickups', 'positive');
delete from public.challenge_templates where id in ('no_pickups', 'positive');
update public.challenge_templates set description = '4 drives with no hard stops, starts or turns' where id = 'smooth';
update public.challenge_templates set description = '3 drives with no events' where id = 'clean';

-- the two achievements that were about phone use and streaks
delete from public.user_achievements where achievement_id in ('phone_free_25', 'streak_10');

-- leagues are gone: their queued results are never sent
delete from public.inbox where kind = 'league_result';

-- ---------------------------------------------------------------------------
-- S1 the per-opportunity Safety Rating
-- ---------------------------------------------------------------------------
alter table public.trips
  add column slowdowns int check (slowdowns between 0 and 20000),
  add column speedups int check (speedups between 0 and 20000),
  add column turns int check (turns between 0 and 20000),
  add column limit_s int check (limit_s between 0 and 43200),
  add column moving_s int check (moving_s between 0 and 43200),
  add constraint trips_limit_le_moving check (limit_s is null or moving_s is null or limit_s <= moving_s);
alter table public.progress add column miles_90d numeric(8,2) not null default 0 check (miles_90d >= 0);
-- the rating as of 7 days before the stored one, kept with it for the summary's weekly trend
alter table public.progress add column rating_week_ago numeric(4,1) check (rating_week_ago between 0 and 100);

-- the category an event counts toward (scoring axisOf); anything else counts nowhere
create or replace function private.axis_of(p_type text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_type = 'speeding' then 'speed'
    when p_type = 'hard_brake' then 'braking'
    when p_type = 'hard_accel' then 'acceleration'
    when p_type = 'hard_corner' then 'turning'
    when p_type in ('eyes_off', 'drowsy') then 'attention'
    else null end
$$;

-- scoring RECENCY_WEIGHT: the weight of a drive p_age_days old (whole days); 0 outside 0..89
create or replace function private.recency_weight(p_age_days int) returns double precision
language sql immutable set search_path = public as $$
  select case when p_age_days is null or p_age_days < 0 or p_age_days > 89 then 0::float8
    else (array[1,0.9675,0.9361,0.9057,0.8763,0.8479,0.8203,0.7937,0.7679,0.743,0.7189,0.6955,0.673,0.6511,0.63,0.6095,0.5897,0.5706,0.552,0.5341,
      0.5168,0.5,0.4838,0.4681,0.4529,0.4382,0.4239,0.4102,0.3969,0.384,0.3715,0.3594,0.3478,0.3365,0.3256,0.315,0.3048,0.2949,0.2853,0.276,
      0.2671,0.2584,0.25,0.2419,0.234,0.2264,0.2191,0.212,0.2051,0.1984,0.192,0.1857,0.1797,0.1739,0.1682,0.1628,0.1575,0.1524,0.1474,0.1426,
      0.138,0.1335,0.1292,0.125,0.1209,0.117,0.1132,0.1095,0.106,0.1025,0.0992,0.096,0.0929,0.0899,0.0869,0.0841,0.0814,0.0787,0.0762,0.0737,
      0.0713,0.069,0.0668,0.0646,0.0625,0.0605,0.0585,0.0566,0.0548,0.053]::float8[])[p_age_days + 1] end
$$;

-- scoring rateScore: 100 / (1 + (rate / baseline) * 15 / 85); never 0; a rate at or under 0 reads 100
create or replace function private.rate_score(p_rate double precision, p_baseline double precision) returns double precision
language sql immutable set search_path = public as $$
  select 100::float8 / (1::float8 + (greatest(coalesce(p_rate, 0), 0) / p_baseline) * (15::float8 / 85::float8))
$$;

-- scoring speedingWeight: charged seconds n = max(1, duration - 5) times x * sqrt(x), x = min(40, mean
-- over) / 5, the mean over from measured.overMphS (or the tier's legacy mean: minor 2, moderate 6.5,
-- severe 12). Written n * x * sqrt(x), as the TypeScript is, so the two agree bit for bit.
create or replace function private.speeding_weight(p_duration_s numeric, p_measured jsonb, p_tier text) returns double precision
language sql immutable set search_path = public as $$
  with n as (select greatest(1::float8, greatest(0::float8, coalesce(p_duration_s, 0)::float8) - 5::float8) as n),
  m as (select case when jsonb_typeof(p_measured -> 'overMphS') = 'number' then (p_measured ->> 'overMphS')::float8 / n.n
                    else (case p_tier when 'severe' then 12 when 'moderate' then 6.5 else 2 end)::float8 end as mean from n),
  x as (select least(40::float8, greatest(0::float8, m.mean)) / 5::float8 as x from m)
  select n.n * x.x * sqrt(x.x) from n, x
$$;

-- what an active event adds to its category's weight: a hard event minor 1 / severe 2, speeding
-- speeding_weight, anything else 0
create or replace function private.event_weight_of(p_type text, p_tier text, p_duration_s numeric, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case
    when p_type in ('hard_brake', 'hard_accel', 'hard_corner') then (case when p_tier = 'severe' then 2 else 1 end)::float8
    when p_type = 'speeding' then private.speeding_weight(p_duration_s, p_measured, p_tier)
    else 0::float8 end
$$;

-- scoring ATTENTION_PENALTY: a DashPal event's penalty on Attention's curve
create or replace function private.attention_penalty_of(p_type text) returns int
language sql immutable set search_path = public as $$
  select case p_type when 'eyes_off' then 40 when 'drowsy' then 50 else 0 end
$$;

-- scoring estimateExposure: counters for a drive recorded before they existed, from its miles and
-- length. The average speed picks per-mile counts and shares of the duration from the knot table
-- (piecewise linear, clamped at the ends), each rounded half up, then clamped as clampExposure does.
create or replace function private.estimate_exposure(p_miles numeric, p_duration_s int)
returns table (slowdowns int, speedups int, turns int, limit_s int, moving_s int)
language plpgsql immutable set search_path = public as $$
declare
  v_mi float8 := greatest(0::float8, coalesce(p_miles, 0)::float8);
  v_s float8 := greatest(0::float8, coalesce(p_duration_s, 0)::float8);
  v_avg float8;
  k float8[] := array[[10, 3.0, 3.0, 2.0, 0.45, 0.55], [20, 2.0, 2.0, 1.2, 0.60, 0.75],
                      [35, 0.9, 0.9, 0.5, 0.70, 0.90], [50, 0.3, 0.3, 0.15, 0.80, 0.97]]::float8[];
  v float8[] := array[0, 0, 0, 0, 0]::float8[];
  t float8;
begin
  v_avg := case when v_s > 0 then v_mi / (v_s / 3600::float8) else 0::float8 end;
  for c in 1..5 loop
    if v_avg <= k[1][1] then
      v[c] := k[1][c + 1];
    elsif v_avg >= k[4][1] then
      v[c] := k[4][c + 1];
    else
      for i in 2..4 loop
        if v_avg <= k[i][1] then
          t := (v_avg - k[i - 1][1]) / (k[i][1] - k[i - 1][1]);
          v[c] := k[i - 1][c + 1] + t * (k[i][c + 1] - k[i - 1][c + 1]);
          exit;
        end if;
      end loop;
    end if;
  end loop;
  -- half up, as Math.round (floor(x + 0.5)); every operand is non-negative
  slowdowns := least(20000, floor(v_mi * v[1] + 0.5)::int);
  speedups := least(20000, floor(v_mi * v[2] + 0.5)::int);
  turns := least(20000, floor(v_mi * v[3] + 0.5)::int);
  moving_s := least(43200, floor(v_s * v[5] + 0.5)::int);
  limit_s := least(moving_s, least(43200, floor(v_s * v[4] + 0.5)::int));
  return next;
end $$;

-- scoring ratingAt: the rating as of p_at over the kept scored drives started in (p_at - 90 d, p_at],
-- each weighted by its age in whole days. Every sum runs in the TypeScript's order (drives by
-- started_at then client_trip_id, events by started_at then client_event_id) in double precision,
-- so the phone and the server agree to the digit.
--   per rate axis: W = sum(w * weight), O = sum(w * max(opportunities, count)),
--                  score = rate_score((W + prior * rate) / (O + prior), rate)
--   Attention: P = sum(w * penalty), M = sum(w * watched miles); category_score(P, M, 10) when M > 0
--   rating = the weighted mean (Speed 2, the rest 1), clamped, half up to 1 decimal
-- Set-based: the window's drives; their active events summed per drive and category in one grouped
-- scan, and the speeding sums in a second scan of the speeding events alone, each ordered sum adding
-- in the event order; then the weighted sums over the drives, each ordered sum adding in the drive
-- order. An ordered float8 sum adds one term at a time in that order, exactly as the TypeScript's
-- loops do. A hard event weighs a whole 1 or 2 (event_weight_of), and a sum of whole numbers this
-- small is exact in any order, so those sums need no ordering. The cost grows with the rows, read
-- once each, not with a subquery per drive and category.
create or replace function private.rating_at(p_user uuid, p_at timestamptz) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_miles numeric;
  bw float8; bo float8; aw float8; ao float8; tw float8; tow float8; sw float8; so float8;
  ap float8; am float8;
  s_b float8; s_a float8; s_t float8; s_s float8; s_att float8;
  v_num float8; v_den float8;
begin
  if p_user is null or p_at is null then
    raise exception 'user and time are required' using errcode = 'invalid_parameter_value';
  end if;
  with d as materialized (
    select t.id, t.client_trip_id, t.started_at, t.miles, t.slowdowns, t.speedups, t.turns, t.limit_s,
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
      d.w * coalesce(ev.att, 0)::float8 as att
    from d left join ev on ev.trip_id = d.id left join sp on sp.trip_id = d.id
  )
  select coalesce(sum(greatest(x.miles, 0)), 0),
    coalesce(sum(x.b_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.b_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.a_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.a_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.t_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.t_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.s_w order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.s_o order by x.started_at, x.client_trip_id), 0::float8),
    coalesce(sum(x.att order by x.started_at, x.client_trip_id), 0::float8), coalesce(sum(x.w * x.watched order by x.started_at, x.client_trip_id), 0::float8)
    into v_miles, bw, bo, aw, ao, tw, tow, sw, so, ap, am
  from x;
  if v_miles <= 0 then
    return jsonb_build_object('rating', null, 'ranked', false, 'miles', 0, 'scores', jsonb_build_object(
      'acceleration', null, 'braking', null, 'turning', null, 'attention', null, 'speed', null));
  end if;
  -- scoring BASELINE: braking 0.010 / 60, acceleration 0.008 / 60, turning 0.008 / 60, speed 0.040 / 3600
  s_b := private.rate_score((bw + 60::float8 * 0.010::float8) / (bo + 60::float8), 0.010::float8);
  s_a := private.rate_score((aw + 60::float8 * 0.008::float8) / (ao + 60::float8), 0.008::float8);
  s_t := private.rate_score((tw + 60::float8 * 0.008::float8) / (tow + 60::float8), 0.008::float8);
  s_s := private.rate_score((sw + 3600::float8 * 0.040::float8) / (so + 3600::float8), 0.040::float8);
  s_att := case when am > 0 then private.category_score(ap, am, 10) end;
  -- the weighted mean in radar order (acceleration, braking, turning, attention, speed), as weightedScore sums it
  v_num := 1::float8 * s_a + 1::float8 * s_b + 1::float8 * s_t + coalesce(1::float8 * s_att, 0::float8) + 2::float8 * s_s;
  v_den := (1 + 1 + 1 + case when s_att is null then 0 else 1 end + 2)::float8;
  return jsonb_build_object(
    'rating', round(private.round_half_up(least(100::float8, greatest(0::float8, v_num / v_den)), 1)::numeric, 1),
    'ranked', v_miles >= 10, 'miles', v_miles,
    'scores', jsonb_build_object('acceleration', s_a, 'braking', s_b, 'turning', s_t, 'attention', s_att, 'speed', s_s));
end $$;

-- the rating as of p_at, for the trend arrow and the weekly recap
create or replace function private.rating_as_of(p_user uuid, p_at timestamptz) returns numeric
language sql stable set search_path = public as $$
  select (private.rating_at(p_user, p_at) ->> 'rating')::numeric
$$;

-- the driver's rating now, its ranked flag, the window's miles, and the rating as of 7 days before
-- (the summary's trend reads it, so no summary call computes a rating)
create or replace function private.refresh_rating(p_user uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_r jsonb;
begin
  v_r := private.rating_at(p_user, now());
  update public.progress set
    miles_90d = least((v_r ->> 'miles')::numeric, 999999),
    safety_rating = (v_r ->> 'rating')::numeric,
    ranked = (v_r ->> 'ranked')::boolean,
    rating_week_ago = case when v_r ->> 'rating' is null then null else private.rating_as_of(p_user, now() - interval '7 days') end,
    rating_updated_at = now()
  where user_id = p_user;
end $$;

-- cron: ages change daily, so every driver with a rating (or miles in the window) is refreshed
create or replace function private.refresh_ratings_daily() returns int
language plpgsql volatile set search_path = public as $$
declare
  v_user uuid;
  v_n int := 0;
begin
  for v_user in
    select g.user_id from public.progress g
    where (g.miles_90d > 0 or g.safety_rating is not null)
      and (g.rating_updated_at is null or g.rating_updated_at < now() - interval '20 hours')
  loop
    perform private.refresh_rating(v_user);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- the linear ratings are gone
drop function if exists private.rating_window(uuid, timestamptz, timestamptz);
drop function if exists private.rating_penalty_of(text, text, int, boolean);
drop function if exists private.safety_rating(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric);

-- the friends board: self + friends by Safety Rating, unranked last (0025 adds the sharing rules)
drop function if exists public.get_friends_board(text);
create or replace function public.get_friends_board() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'get_friends_board requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('rank', x.rank, 'user_id', x.user_id, 'username', x.username,
        'value', x.value, 'ranked', x.ranked, 'is_me', x.user_id = v_uid, 'miles_90d', x.miles_90d) order by x.rank)
    from (
      select (row_number() over (order by y.value desc nulls last, y.username))::int as rank, y.*
      from (
        select p.id as user_id, p.username, g.ranked, g.miles_90d, case when g.ranked then g.safety_rating else null end as value
        from (select v_uid as id
              union
              select case when f.user_a = v_uid then f.user_b else f.user_a end from public.friendships f where f.user_a = v_uid or f.user_b = v_uid) u
        join public.profiles p on p.id = u.id join public.progress g on g.user_id = u.id
        where u.id = v_uid or not private.blocked_either(v_uid, u.id)
      ) y
    ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- R3 the engine without points
-- ---------------------------------------------------------------------------

-- the events of one drive in the upload's shape (the merge and list_my_drives read it)
create or replace function private.trip_events_json(p_trip uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.client_event_id, 'type', e.type, 'tier', e.tier,
      'startedAt', floor(extract(epoch from e.started_at) * 1000)::bigint,
      'durationS', e.duration_s, 'zone', e.zone, 'status', e.status,
      'lat', e.lat, 'lng', e.lng, 'measured', e.measured)
    order by e.started_at, e.client_event_id), '[]'::jsonb)
  from public.trip_events e where e.trip_id = p_trip
$$;

-- drive_context: lock, idempotency, the merge target. `version` 23 tells finalize-trip which engine
-- it reads.
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
    return jsonb_build_object('version', 23, 'existing', v_existing, 'merge', null);
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
  return jsonb_build_object('version', 23, 'existing', null, 'merge', v_merge);
end $$;

-- how many of the week's kept scored drives meet a goal
create or replace function private.challenge_count(p_user uuid, p_week text, p_template text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.trips t
  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null
    and case p_template
          when 'no_speeding' then t.n_speeding = 0
          when 'smooth' then t.n_hard_brake + t.n_hard_accel + t.n_hard_corner = 0
          when 'clean' then t.clean
          else false end
$$;

-- StatSums over the kept scored drives since p_since (null = all time), plus the DashPal counts
create or replace function private.stat_sums(p_user uuid, p_since timestamptz) returns jsonb
language sql stable set search_path = public as $$
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
  where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
    and (p_since is null or t.started_at >= p_since)
$$;

-- the week's three goals, once: weakest of the last 30 days first (no drives: template order). A
-- week that has ended gets none.
create or replace function private.ensure_challenges(p_user uuid, p_week text) returns void
language plpgsql volatile set search_path = public as $$
declare
  s jsonb;
  v_miles numeric;
  v_drives int;
begin
  if private.week_key_end(p_week) <= now() then
    return;
  end if;
  if exists (select 1 from public.weekly_challenges w where w.user_id = p_user and w.league_week = p_week) then
    return;
  end if;
  s := private.stat_sums(p_user, now() - interval '30 days');
  v_miles := (s ->> 'miles')::numeric;
  v_drives := (s ->> 'drives')::int;
  insert into public.weekly_challenges (user_id, league_week, slot, template_id)
  select p_user, p_week, row_number() over (order by r.weakness desc, r.sort_order), r.id
  from (
    select c.id, c.sort_order,
      case when v_drives = 0 or v_miles <= 0 then 0
           when c.id = 'no_speeding' then (s ->> 'speeding')::numeric / v_miles * 100 / 4.0
           when c.id = 'smooth' then ((s ->> 'hardBrake')::numeric + (s ->> 'hardAccel')::numeric + (s ->> 'hardCorner')::numeric) / v_miles * 100 / 12.0
           when c.id = 'clean' then greatest(0, 80 - (s ->> 'cleanDrives')::numeric / v_drives * 100) / 30.0
           else 0 end as weakness
    from public.challenge_templates c
  ) r
  order by r.weakness desc, r.sort_order
  limit 3
  on conflict do nothing;
end $$;

-- the week's goals as its drives stand: done once reached, not done once no longer reached (a
-- "Wasn't driving", a merge that broke a clean drive). Nothing is rewarded. A week that has ended
-- is left as it was. Returns the goals this call completed: [{ id, title }].
create or replace function private.sync_challenges(p_user uuid, p_week text, p_trip uuid) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_done jsonb := '[]'::jsonb;
  v_n int;
begin
  if p_user is null or p_week is null or p_week !~ '^[0-9]{4}-W[0-5][0-9]$' or private.week_key_end(p_week) <= now() then
    return v_done;
  end if;
  for r in
    select w.slot, w.template_id, w.completed_at, c.title, c.target
    from public.weekly_challenges w join public.challenge_templates c on c.id = w.template_id
    where w.user_id = p_user and w.league_week = p_week
    order by w.slot
  loop
    v_n := private.challenge_count(p_user, p_week, r.template_id);
    if r.completed_at is null and v_n >= r.target then
      update public.weekly_challenges set completed_at = now(), completed_by_trip = p_trip
        where user_id = p_user and league_week = p_week and slot = r.slot;
      v_done := v_done || jsonb_build_object('id', r.template_id, 'title', r.title);
    elsif r.completed_at is not null and v_n < r.target then
      update public.weekly_challenges set completed_at = null, completed_by_trip = null
        where user_id = p_user and league_week = p_week and slot = r.slot;
    end if;
  end loop;
  return v_done;
end $$;

-- achievements, checked after a drive or an accepted report: returns the newly unlocked ids
create or replace function private.check_achievements(p_user uuid, p_week text) returns jsonb
language plpgsql volatile set search_path = public as $$
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
         when 'first_drive' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null)
         when 'clean_100' then coalesce((select sum(t.miles) from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving and t.merged_into is null), 0) >= 100
         when 'perfect_week' then coalesce((select count(*) >= 3 and bool_and(t.clean) from public.trips t
                                   where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null), false)
         else false end)
    then
      insert into public.user_achievements (user_id, achievement_id) values (p_user, v_id) on conflict do nothing;
      v_new := v_new || to_jsonb(v_id);
    end if;
  end loop;
  return v_new;
end $$;

-- apply_drive(p): write the drive (or the union into its merge target), its events, counts and
-- opportunity counters, the week's goals, the achievements and the rating; returns the stored
-- answer. No points, no streak.
-- p = { user, mergeInto, dashcam, payload { clientTripId, startedAt, endedAt, tz, localDay, miles,
--       nightMiles, durationS, end, polyline, appVersion, dashcam, origin, notDrivingExpired, exposure },
--       scored, reason, events, scoringVersion }
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
  v_slow int; v_up int; v_turn int; v_limit int; v_moving int;
  v_own_slow int; v_own_up int; v_own_turn int; v_own_limit int; v_own_moving int;
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
       or (ex ->> 'movingS')::numeric not between 0 and 1000000) then
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
  v_own_moving := least(v_dur, 43200, coalesce(floor((ex ->> 'movingS')::numeric)::int, v_exp.moving_s));
  v_own_limit := least(v_own_moving, coalesce(floor((ex ->> 'limitS')::numeric)::int, v_exp.limit_s));
  v_count_cap := least(20000, ceil(v_miles * 40)::int);
  v_own_slow := least(v_count_cap, greatest(1, ceil(v_own_moving / 15.0)::int), coalesce(floor((ex ->> 'slowdowns')::numeric)::int, v_exp.slowdowns));
  v_own_up := least(v_count_cap, greatest(1, ceil(v_own_moving / 15.0)::int), coalesce(floor((ex ->> 'speedups')::numeric)::int, v_exp.speedups));
  v_own_turn := least(v_count_cap, greatest(1, ceil(v_own_moving / 10.0)::int), coalesce(floor((ex ->> 'turns')::numeric)::int, v_exp.turns));
  v_slow := v_own_slow; v_up := v_own_up; v_turn := v_own_turn; v_limit := v_own_limit; v_moving := v_own_moving;

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
        polyline, scored, reason, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s,
        scoring_version, app_version)
      values (v_user, v_client, v_started, v_ended, v_local_day, v_week, v_tz, v_miles, v_night, v_dur,
        dc ->> 'deviceId', coalesce((dc ->> 'movingS')::int, 0), coalesce((dc ->> 'coveredS')::int, 0),
        coalesce((dc ->> 'synced')::boolean, false), coalesce((dc ->> 'on')::boolean, false),
        v_poly, v_scored, v_reason, v_origin, v_expired, v_slow, v_up, v_turn, v_limit, v_moving,
        coalesce((p ->> 'scoringVersion')::int, 7), left(pl ->> 'appVersion', 32))
      returning id into v_trip;
  else
    update public.trips set ended_at = v_ended, miles = v_miles, night_miles = v_night, duration_s = v_dur,
        dashcam_device_id = dc ->> 'deviceId', dashcam_moving_s = coalesce((dc ->> 'movingS')::int, 0),
        dashcam_covered_s = coalesce((dc ->> 'coveredS')::int, 0), dashcam_synced = coalesce((dc ->> 'synced')::boolean, false),
        dashcam_on = coalesce((dc ->> 'on')::boolean, false),
        polyline = v_poly, scored = v_scored, reason = v_reason, not_driving_expired = v_expired,
        slowdowns = v_slow, speedups = v_up, turns = v_turn, limit_s = v_limit, moving_s = v_moving,
        scoring_version = coalesce((p ->> 'scoringVersion')::int, scoring_version)
      where id = v_trip;
  end if;

  -- events: a new row is always active; a row the drive already holds (a merge re-sends the
  -- target's) keeps its status: removal happens in dispute_event alone
  for e in select x from jsonb_array_elements(ev) x loop
    if (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or e ->> 'type' not in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'eyes_off', 'drowsy')
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
        polyline, scored, merged_into, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s,
        scoring_version, app_version)
      values (v_user, v_client, v_own_started, v_ended, v_own_local_day,
        private.league_week(v_own_started), pl ->> 'tz',
        (pl ->> 'miles')::numeric, (pl ->> 'nightMiles')::numeric, (pl ->> 'durationS')::int,
        pdc ->> 'deviceId', coalesce((pdc ->> 'movingS')::int, 0), coalesce((pdc ->> 'coveredS')::int, 0), coalesce((pdc ->> 'synced')::boolean, false),
        coalesce(pl ->> 'polyline', ''), false, v_trip,
        coalesce(pl ->> 'origin', 'manual'), coalesce((pl ->> 'notDrivingExpired')::boolean, false),
        v_own_slow, v_own_up, v_own_turn, v_own_limit, v_own_moving,
        coalesce((p ->> 'scoringVersion')::int, 7), left(pl ->> 'appVersion', 32));
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

-- "Wasn't driving": any kept drive, until 24 h after it ended, only if its "Not driving?" never ran
-- out, 2 a UTC month (not_driving_left, 0008). Nothing is reverted but the drive's part in the rating
-- and the week's goals. A repeat answers the same document and writes nothing.
create or replace function private.mark_not_driving(p_user uuid, p_client_trip_id uuid) returns jsonb
language plpgsql volatile set search_path = public as $$
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
  if not found or t.merged_into is not null then
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
end $$;

-- a report's answer, as stored: what dispute_event returns, first time or repeat
create or replace function private.dispute_answer(p_user uuid, p_trip uuid, p_event uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('tripId', t.id, 'eventId', d.client_event_id, 'status', d.status,
    'rejectReason', case when d.status = 'accepted' then null else 'quota' end,
    'quotaLeft', greatest(0, 3 - private.dispute_quota_used(p_user, d.reason)),
    'clean', t.clean,
    'rating', (select jsonb_build_object('safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = p_user))
  from public.event_disputes d join public.trips t on t.id = d.trip_id
  where d.trip_id = p_trip and d.client_event_id = p_event and d.user_id = p_user
$$;

-- one report, decided and applied in one call: hazard (a hard brake), wrong_limit (speeding),
-- camera_wrong (a DashPal event); 3 auto-accepts a week for hazard + wrong_limit and 3 for
-- camera_wrong (dispute_quota_used, 0008). An accepted report removes the event and updates the
-- drive's counts and clean flag, the week's goals, the achievements and the rating. A repeat with the
-- same reason answers what was stored and writes nothing.
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
  if p_reason is null or p_reason not in ('hazard', 'wrong_limit', 'camera_wrong') then
    raise exception 'reason must be hazard, wrong_limit or camera_wrong' using errcode = 'invalid_parameter_value';
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
     or (p_reason = 'camera_wrong' and e.type not in ('eyes_off', 'drowsy')) then
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
-- client reads
-- ---------------------------------------------------------------------------

-- the public card of one driver (the caller has already been checked; 0025 adds the viewer)
create or replace function private.public_card(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('user_id', p.id, 'username', p.username, 'safety_rating', g.safety_rating, 'ranked', g.ranked)
    -- LEGACY (Phase B removes): what a build from before this migration reads
    || jsonb_build_object('level', 1, 'streak', 0, 'league_tier', 'bronze')
  from public.profiles p join public.progress g on g.user_id = p.id
  where p.id = p_user
$$;

-- search_users(p_query >= 3 chars) -> up to 20 cards, prefix match, onboarded users only, never self
-- or anyone blocked either way; 30/min
create or replace function public.search_users(p_query text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_q text := lower(btrim(coalesce(p_query, '')));
begin
  if v_uid is null then
    raise exception 'search_users requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if char_length(v_q) < 3 or char_length(v_q) > 20 or v_q !~ '^[a-z0-9_]+$' then
    raise exception 'query must be 3 to 20 letters, digits or underscores' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'search_users', interval '1 minute', 30);
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'username', p.username,
        'safety_rating', case when g.ranked then g.safety_rating end, 'ranked', g.ranked,
        -- LEGACY (Phase B removes): level
        'level', 1) order by p.username)
    from (
      select p.id, p.username from public.profiles p
      where p.username::text like replace(v_q, '_', '\_') || '%' and p.id <> v_uid and p.onboarded_at is not null
        and not private.blocked_either(v_uid, p.id)
      order by p.username
      limit 20
    ) p join public.progress g on g.user_id = p.id), '[]'::jsonb);
end $$;

-- the Home header and the Profile card in one call (also assigns this week's goals when due)
create or replace function public.get_my_summary() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  g public.progress%rowtype;
begin
  if v_uid is null then
    raise exception 'get_my_summary requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select * into g from public.progress where user_id = v_uid;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.weekly_challenges w where w.user_id = v_uid and w.league_week = v_week) then
    perform private.ensure_challenges(v_uid, v_week);
  end if;
  return jsonb_build_object(
    'profile', (select jsonb_build_object('user_id', p.id, 'username', p.username, 'units', p.units,
        'state', p.state, 'heatmap_visibility', p.heatmap_visibility, 'league_eligible', p.league_eligible,
        'onboarded_at', p.onboarded_at) from public.profiles p where p.id = v_uid),
    'progress', jsonb_build_object('safety_rating', g.safety_rating, 'ranked', g.ranked, 'miles_90d', g.miles_90d,
        -- the trend: the stored rating less the rating 7 days before it, both written by refresh_rating
        'rating_trend', g.safety_rating - g.rating_week_ago)
      -- LEGACY (Phase B removes): what a build from before this migration reads, at its starting values
      || jsonb_build_object('points', 0, 'lifetime', 0, 'level', 1, 'level_floor', 0, 'level_next', 250,
        'streak', 0, 'at_risk', false, 'next_mult', 1, 'freezes', 0, 'clean_run', 0, 'freeze_progress', 0,
        'phone_free_run', 0, 'clean_miles_30d', 0, 'league_tier', 'bronze', 'miles_30d', g.miles_90d),
    'not_driving_left', private.not_driving_left(v_uid),
    'challenges', private.challenges_json(v_uid, v_week),
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_uid), '[]'::jsonb));
end $$;

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
                                     'limitS', t.limit_s, 'movingS', t.moving_s),
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

-- clans stay server-only (0012); their member rows carry no points, level, week points or streak
create or replace function public.get_my_clan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_clan uuid;
  v_role text;
  v_week text := private.league_week(now());
begin
  if v_uid is null then
    raise exception 'get_my_clan requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select m.clan_id, m.role into v_clan, v_role from public.clan_members m where m.user_id = v_uid;
  if v_clan is null then
    return null;
  end if;
  return jsonb_build_object(
    'clan', (select jsonb_build_object('id', c.id, 'name', c.name, 'banner', c.banner,
               'invite_code', case when v_role in ('leader', 'coleader') then c.invite_code else null end,
               'member_count', (select count(*) from public.clan_members m where m.clan_id = c.id))
             from public.clans c where c.id = v_clan),
    'my_role', v_role,
    'goal', private.clan_goal(v_clan, v_week),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'user_id', p.id, 'username', p.username, 'role', m.role, 'joined_at', m.joined_at,
          'safety_rating', g.safety_rating, 'ranked', g.ranked, 'miles_90d', g.miles_90d,
          'clean_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where t.clean) / count(*)) end
                        from public.trips t where t.user_id = p.id and t.scored and not t.not_driving and t.merged_into is null
                          and t.started_at > now() - interval '30 days')) order by m.joined_at)
      from public.clan_members m join public.profiles p on p.id = m.user_id join public.progress g on g.user_id = m.user_id
      where m.clan_id = v_clan and not private.blocked_either(v_uid, m.user_id)), '[]'::jsonb));
end $$;

-- the weekly recap: the week ending on the driver's local Sunday (0018), its drives, the weekly goals
-- done and the rating. A week with no kept scored drive has nothing true to say and gets no recap.
create or replace function private.produce_weekly_recaps(p_now timestamptz default now()) returns int
language plpgsql volatile set search_path = public as $$
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
    select distinct t.user_id from public.trips t where t.started_at > p_now - interval '7 days' and t.merged_into is null
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
end $$;

-- export_account(p_user): the account's own rows (0009), with no points or leagues
create or replace function public.export_account(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    'format_version', 4,
    'exported_at', now(),
    'about', jsonb_build_object('excluded', jsonb_build_array(
      'device push tokens and push delivery receipts', 'rate-limit counters', 'the merge-check end point of your latest drive')),
    'account', v_account,
    'profile', (select to_jsonb(p) - 'flagged' from public.profiles p where p.id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'platform', d.platform, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) order by d.created_at)
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'progress', (select to_jsonb(g) - 'last_end_lat' - 'last_end_lng' - 'last_end_at' from public.progress g where g.user_id = p_user),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.client_event_id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at) from public.user_achievements a where a.user_id = p_user), '[]'::jsonb),
    'weekly_challenges', coalesce((select jsonb_agg(to_jsonb(w) order by w.league_week, w.slot) from public.weekly_challenges w where w.user_id = p_user), '[]'::jsonb),
    'clan', (select jsonb_build_object('name', c.name, 'role', m.role, 'joined_at', m.joined_at)
      from public.clan_members m join public.clans c on c.id = m.clan_id where m.user_id = p_user),
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
end $$;

-- ---------------------------------------------------------------------------
-- R4 data that the new functions put right
-- ---------------------------------------------------------------------------
-- this week's goals: the three that are left, assigned again and checked against the week's drives
-- (a goal already reached is marked done again, now)
do $$
declare
  r record;
  v_week text := private.league_week(now());
begin
  for r in select distinct w.user_id from public.weekly_challenges w where w.league_week = v_week loop
    delete from public.weekly_challenges where user_id = r.user_id and league_week = v_week;
    perform private.ensure_challenges(r.user_id, v_week);
    perform private.sync_challenges(r.user_id, v_week, null);
  end loop;
end $$;

-- every stored answer in the shape finalize-trip answers now, so a replay of an older drive reads like
-- a new one: its ids, scored and reason, the events the drive keeps, the rating it reported, and the
-- goals and achievements that still exist
update public.trips t set result = jsonb_build_object(
    'tripId', t.result -> 'tripId', 'clientTripId', t.result -> 'clientTripId', 'mergedInto', coalesce(t.result -> 'mergedInto', 'null'::jsonb),
    'scored', coalesce(t.result -> 'scored', to_jsonb(t.scored)), 'reason', coalesce(t.result -> 'reason', 'null'::jsonb),
    'eventIds', coalesce((select jsonb_agg(e.client_event_id order by e.started_at, e.client_event_id)
                          from public.trip_events e where e.trip_id = (t.result ->> 'tripId')::uuid), '[]'::jsonb),
    'rating', jsonb_build_object('safetyRating', coalesce(t.result -> 'progress' -> 'safetyRating', 'null'::jsonb),
                                 'ranked', coalesce(t.result -> 'progress' -> 'ranked', 'false'::jsonb)),
    'challenges', coalesce((select jsonb_agg(c) from jsonb_array_elements(case when jsonb_typeof(t.result -> 'challenges') = 'array' then t.result -> 'challenges' else '[]'::jsonb end) c
                            where c ->> 'id' in ('no_speeding', 'smooth', 'clean')), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(a) from jsonb_array_elements(case when jsonb_typeof(t.result -> 'achievements') = 'array' then t.result -> 'achievements' else '[]'::jsonb end) a
                              where a #>> '{}' in ('first_drive', 'clean_100', 'perfect_week')), '[]'::jsonb))
  where t.result is not null and jsonb_typeof(t.result) = 'object' and t.result ? 'tripId';

-- ---------------------------------------------------------------------------
-- R5 what points, streaks, freezes, levels and leagues were made of
-- ---------------------------------------------------------------------------
drop function if exists private.week_points(uuid, text);
drop function if exists private.complete_challenges(uuid, text, uuid);
drop function if exists private.revert_challenges_of_trip(uuid, uuid);
drop function if exists private.revert_trip(uuid, uuid);
drop function if exists private.restore_progress(uuid, jsonb);
drop function if exists private.progress_snapshot(uuid);
drop function if exists private.progress_json(uuid, boolean);
drop function if exists private.apply_freeze_grant(uuid);
drop function if exists private.level_for(int);
drop function if exists private.level_floor(int);
drop function if exists private.revert_latest_not_driving(uuid, uuid);
drop function if exists private.dispute_context(uuid, uuid, uuid, text);
drop function if exists private.apply_dispute(jsonb);
drop function if exists private.dispute_outcome(uuid, uuid, uuid);
drop function if exists private.place_in_league(uuid, text);
drop function if exists private.league_standings(uuid);
drop function if exists private.close_leagues();
drop function if exists public.get_my_league();
drop function if exists public.get_global_board(text);
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'league-close';
drop table public.points_ledger;
drop table public.league_members;
drop table public.league_groups;

-- ---------------------------------------------------------------------------
-- R6 the columns and values they kept
-- ---------------------------------------------------------------------------
drop index if exists public.progress_global_board_idx;
alter table public.progress
  drop column points, drop column lifetime, drop column level, drop column streak, drop column at_risk,
  drop column freezes, drop column freezes_granted_at, drop column clean_run, drop column freeze_progress,
  drop column phone_free_run, drop column league_tier,
  -- the 30-day sums of the old linear rating and the global board's tie-break (the rating is 90 days now)
  drop column miles_30d, drop column clean_miles_30d, drop column rating_penalty_30d;
alter table public.trips drop constraint trips_safe_le_miles;
alter table public.trips
  drop column points_net, drop column breakdown, drop column n_pickup, drop column handling_s,
  drop column streak_before, drop column progress_before, drop column is_loop, drop column loop_repeat,
  drop column safe_miles_earlier_today, drop column safe_miles, drop column rev, drop column rating_penalty,
  add constraint trips_night_le_miles check (night_miles <= miles);
alter table public.trips alter column scoring_version set default 7;
-- S1 replaced every function that read these (0022's rating_window read units and stopped_in_traffic)
alter table public.trip_events drop column penalty, drop column units, drop column stopped_in_traffic;

-- the enum-like CHECKs lose the values that are gone. Inline CHECK names are Postgres's
-- <table>_<column>_check; the block finds them by definition, so the right one goes whatever its name.
do $$
declare c record;
begin
  for c in
    select con.conname, rel.relname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'c'
      and ((rel.relname = 'trip_events' and pg_get_constraintdef(con.oid) like '%phone_pickup%')
        or (rel.relname = 'event_disputes' and pg_get_constraintdef(con.oid) like '%mounted%')
        or (rel.relname = 'user_achievements' and pg_get_constraintdef(con.oid) like '%streak_10%')
        or (rel.relname = 'inbox' and pg_get_constraintdef(con.oid) like '%league_result%'))
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
  end loop;
end $$;
alter table public.trip_events add constraint trip_events_type_check
  check (type in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'eyes_off', 'drowsy'));
alter table public.event_disputes add constraint event_disputes_reason_check
  check (reason in ('hazard', 'wrong_limit', 'camera_wrong'));
alter table public.user_achievements add constraint user_achievements_achievement_id_check
  check (achievement_id in ('first_drive', 'clean_100', 'perfect_week'));
alter table public.inbox add constraint inbox_kind_check
  check (kind in ('weekly_recap', 'friend_request'));

-- ---------------------------------------------------------------------------
-- R7 grants (new functions only; a replaced function keeps its grants)
-- ---------------------------------------------------------------------------
revoke all on function private.recency_weight(int) from public, anon, authenticated;
revoke all on function private.rate_score(double precision, double precision) from public, anon, authenticated;
revoke all on function private.speeding_weight(numeric, jsonb, text) from public, anon, authenticated;
revoke all on function private.event_weight_of(text, text, numeric, jsonb) from public, anon, authenticated;
revoke all on function private.attention_penalty_of(text) from public, anon, authenticated;
revoke all on function private.estimate_exposure(numeric, int) from public, anon, authenticated;
revoke all on function private.rating_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.sync_challenges(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.mark_not_driving(uuid, uuid) from public, anon, authenticated;
revoke all on function private.dispute_event(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.dispute_answer(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_friends_board() from public, anon, authenticated;
grant execute on function public.get_friends_board() to authenticated;
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- S2 every drive's counters, then every driver's rating (the last statements)
-- ---------------------------------------------------------------------------
update public.trips t set (slowdowns, speedups, turns, limit_s, moving_s) =
  (select e.slowdowns, e.speedups, e.turns, e.limit_s, e.moving_s from private.estimate_exposure(t.miles, t.duration_s) e)
  where t.slowdowns is null or t.speedups is null or t.turns is null or t.limit_s is null or t.moving_s is null;
alter table public.trips
  alter column slowdowns set not null, alter column speedups set not null, alter column turns set not null,
  alter column limit_s set not null, alter column moving_s set not null;
do $$
declare r record;
begin
  for r in select user_id from public.progress loop
    perform private.refresh_rating(r.user_id);
  end loop;
end $$;
