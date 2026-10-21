-- 0022_round7_scoring: the Safety Rating is the weighted average of the radar's category scores,
-- a weekly challenge is worth 200 points, and a re-score (an accepted dispute) sees the drive's
-- duration and the scoring version it was first scored under.
--
--   * Each category (acceleration, braking, turning, attention, phone use, speed: the axis of
--     every event type, `axis_of`) sums the rating penalties of the active events of the kept
--     scored drives in the window (`rating_penalty_of`, the SQL copy of RATING_PENALTY in
--     packages/scoring drive.ts) and scores 100 / (1 + (penalty per mile) / 16) over the window's
--     miles floored at 10 (`category_score`, the SQL copy of categoryScore in rating.ts). A
--     category is never 0. Attention is over the miles DashPal watched, and has no score with
--     none, so a driver without a DashPal is never judged on it.
--   * The rating is the weighted mean of the scored categories: speed 2, phone use 2, the rest 1
--     (`safety_rating`, the SQL copy of safetyRatingOf), rounded to 1 decimal with the same
--     arithmetic as the TypeScript (double precision, half up at the end only), so the phone and
--     the server agree to the digit. Null with no miles; ranked from 10 miles (unchanged).
--   * The rating is read from the events, not trips.rating_penalty (which stays as a stat): a
--     disputed event (status removed) and a merge (events re-stored on the target) are covered.
--   * The old linear ratings (the 2- and 4-argument safety_rating, attention_penalty_of) are gone.
--   * complete_challenges rewards 200 points (was 100): the earn rate doubled.
--   * dispute_context hands the re-score the drive's durationS (the minimum-drive rule reads it) and
--     scoringVersion (a drive keeps the earning rules it was first scored under).
--   * Every driver's rating is recomputed.

-- the category an event counts toward (scoring `axisOf`)
create or replace function private.axis_of(p_type text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_type = 'speeding' then 'speed'
    when p_type = 'hard_brake' then 'braking'
    when p_type = 'hard_accel' then 'acceleration'
    when p_type = 'hard_corner' then 'turning'
    when p_type in ('phone_pickup', 'phone_handling') then 'phone'
    when p_type in ('eyes_off', 'drowsy') then 'attention'
    else null end
$$;

-- RATING_PENALTY: what an active event adds to its category's penalty sum (base penalties only,
-- never the points' multipliers). Handling counts its 15-s units (null = 1, 1..1440); a two-level
-- type reads anything below severe as minor.
create or replace function private.rating_penalty_of(p_type text, p_tier text, p_units int, p_stopped boolean) returns int
language sql immutable set search_path = public as $$
  select case
    when p_type = 'speeding' then case when p_tier = 'severe' then 100 when p_tier = 'moderate' then 40 else 15 end
    when p_type = 'hard_brake' then case when p_tier = 'severe' then 25 else 10 end
    when p_type = 'hard_accel' then case when p_tier = 'severe' then 30 else 15 end
    when p_type = 'hard_corner' then case when p_tier = 'severe' then 25 else 10 end
    when p_type = 'phone_pickup' then case when coalesce(p_stopped, false) then 20 else 40 end
    when p_type = 'phone_handling' then 10 * least(1440, greatest(1, coalesce(p_units, 1)))
    when p_type = 'eyes_off' then 40
    when p_type = 'drowsy' then 50
    else 0 end
$$;

-- scoring `roundTo`: half up at p_dp decimals (JavaScript's Math.round, floor(x + 0.5): never
-- round(float8), which is half to even), the value first snapped to 9 decimals so binary drift
-- (89.549999999999997) lands where the decimal maths says. Double precision throughout, as the
-- TypeScript is. For values at or above 0.
create or replace function private.round_half_up(p_value double precision, p_dp int) returns double precision
language sql immutable set search_path = public as $$
  select floor(floor(p_value * power(10::float8, p_dp) * 1e9::float8 + 0.5::float8) / 1e9::float8 + 0.5::float8) / power(10::float8, p_dp)
$$;

-- scoring `categoryScore`: 100 / (1 + (penalty / max(miles, floor)) / 16), never 0. A null or
-- negative penalty reads as 0; null miles as 0 (so the floor).
create or replace function private.category_score(p_penalty double precision, p_miles double precision, p_floor double precision) returns double precision
language sql immutable set search_path = public as $$
  select 100::float8 / (1::float8 + (greatest(coalesce(p_penalty, 0), 0) / greatest(coalesce(p_miles, 0), p_floor)) / 16::float8)
$$;

-- scoring `safetyRatingOf`: the weighted mean of the categories' scores over the window's miles
-- (floored at 10; Attention over the miles DashPal watched, only when any), speed and phone use
-- counting double, clamped to 0..100 and rounded to 1 decimal. Null with no miles. The sums run
-- in the radar's order (acceleration, braking, turning, attention, phone, speed), as the
-- TypeScript's do, so the two agree bit for bit before the rounding.
create or replace function private.safety_rating(p_acceleration numeric, p_braking numeric, p_turning numeric, p_attention numeric, p_phone numeric, p_speed numeric,
  p_miles numeric, p_watched numeric) returns numeric
language sql immutable set search_path = public as $$
  with s as (
    select
      private.category_score(p_acceleration::float8, p_miles::float8, 10) as acceleration,
      private.category_score(p_braking::float8, p_miles::float8, 10) as braking,
      private.category_score(p_turning::float8, p_miles::float8, 10) as turning,
      case when coalesce(p_watched, 0) > 0 then private.category_score(p_attention::float8, p_watched::float8, 10) end as attention,
      private.category_score(p_phone::float8, p_miles::float8, 10) as phone,
      private.category_score(p_speed::float8, p_miles::float8, 10) as speed
  )
  select case when coalesce(p_miles, 0) <= 0 then null
    else round(private.round_half_up(least(100::float8, greatest(0::float8,
      (1::float8 * s.acceleration + 1::float8 * s.braking + 1::float8 * s.turning + coalesce(1::float8 * s.attention, 0::float8) + 2::float8 * s.phone + 2::float8 * s.speed)
      / (1 + 1 + 1 + case when s.attention is null then 0 else 1 end + 2 + 2)::float8)), 1)::numeric, 1) end
  from s
$$;

-- the rating over the kept scored drives started in (p_from, p_to]: the per-category penalty sums
-- of their active events, their miles and the miles DashPal watched
create or replace function private.rating_window(p_user uuid, p_from timestamptz, p_to timestamptz) returns numeric
language sql stable set search_path = public as $$
  with d as (
    select t.id, t.miles, t.dashcam_moving_s, t.dashcam_covered_s
    from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
      and t.started_at > p_from and t.started_at <= p_to
  ), p as (
    select private.axis_of(e.type) as axis, sum(private.rating_penalty_of(e.type, e.tier, e.units, e.stopped_in_traffic)) as penalty
    from public.trip_events e join d on d.id = e.trip_id
    where e.status = 'active'
    group by 1
  )
  select private.safety_rating(
    coalesce((select penalty from p where axis = 'acceleration'), 0),
    coalesce((select penalty from p where axis = 'braking'), 0),
    coalesce((select penalty from p where axis = 'turning'), 0),
    coalesce((select penalty from p where axis = 'attention'), 0),
    coalesce((select penalty from p where axis = 'phone'), 0),
    coalesce((select penalty from p where axis = 'speed'), 0),
    coalesce((select sum(miles) from d), 0),
    coalesce((select sum(private.watched_miles(miles, dashcam_moving_s, dashcam_covered_s)) from d), 0))
$$;

-- the linear ratings are gone: nothing computes 100 less 10 x the penalty per mile any more
drop function if exists private.safety_rating(numeric, numeric);
drop function if exists private.safety_rating(numeric, numeric, numeric, numeric);
drop function if exists private.attention_penalty_of(text);

-- a weekly challenge is worth 200 points
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
        values (p_user, 'challenge:' || p_week || ':' || r.slot, 200, 'challenge', p_trip, p_week)
        on conflict (user_id, key) do nothing;
      select freeze_progress into v_fp from public.progress where user_id = p_user for update;
      update public.progress set
        points = points + 200,
        lifetime = lifetime + 200,
        level = private.level_for(greatest(0, points + 200)),
        freeze_progress = case when v_fp + 1 >= 3 then 0 else v_fp + 1 end,
        freezes = case when v_fp + 1 >= 3 then least(3, freezes + 1) else freezes end
      where user_id = p_user;
      v_done := v_done || jsonb_build_object('id', r.template_id, 'title', r.title);
    end if;
  end loop;
  return v_done;
end $$;

-- dispute_context: as 0016, and the re-score input now carries the drive's durationS (the
-- minimum-drive rule: under 0.5 mi AND under 2 min) and scoringVersion (the drive keeps the
-- earning rules it was first scored under: a pre-6 drive earns 10 a mile and a 25 clean bonus and
-- prices phone use without the speed multiplier, so the re-score moves the net by the disputed
-- event's penalty alone).
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
  -- a repeat of a stored dispute (same reason): its decision, nothing to re-score; apply_dispute
  -- then answers the stored outcome
  select d.status into v_status from public.event_disputes d
    where d.trip_id = t.id and d.client_event_id = p_event_id and d.user_id = p_user and d.reason = p_reason;
  if found then
    return jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id, 'eventId', p_event_id, 'reason', p_reason,
      'status', v_status,
      'rejectReason', case when v_status = 'accepted' then null when p_reason = 'mounted' then 'not_mounted' else 'quota' end,
      'scored', t.scored, 'oldNet', t.points_net,
      'quotaLeft', case when p_reason in ('hazard', 'wrong_limit', 'camera_wrong') then greatest(0, 3 - private.dispute_quota_used(p_user, p_reason)) else null end,
      'rescore', null);
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
        'durationS', t.duration_s, 'scoringVersion', t.scoring_version,
        'events', (select jsonb_agg(case when x ->> 'id' = p_event_id::text then x || '{"status":"removed"}'::jsonb else x end)
                   from jsonb_array_elements(private.trip_events_json(t.id)) x)),
      'ctx', jsonb_build_object('streak', t.streak_before, 'safeMilesEarlierToday', t.safe_miles_earlier_today)) else null end);
end $$;

-- every driver's rating, made the new way
do $$
declare r record;
begin
  for r in select user_id from public.progress loop
    perform private.refresh_rating(r.user_id);
  end loop;
end $$;
