-- 0020_attention_rating: the Safety Rating is made of the radar's categories, Attention included.
--
--   * The phone's categories (speed, braking, acceleration, turning, phone use) take 10 × their
--     base penalty per mile off 100 between them, as before (trips.rating_penalty).
--   * Attention, from DashPal: its events (eyes off the road 40, drowsy 50: RATING_PENALTY in
--     packages/scoring drive.ts) take 10 × their penalty per mile DashPal watched, over at least
--     10 watched miles (ATTENTION_MIN_MILES), so a driver without a DashPal is never judged on it
--     and one look away on a short watched stretch can't sink the rating. A drive's watched miles
--     are its miles × the share of its moving seconds the dashcam covered (`watchedMiles`).
--   * Time of day is not part of the rating (it never was a penalty; now it isn't on the radar).
--   * list_my_drives hands each drive's DashPal seconds back, so a phone restoring its drives can
--     show Attention too.
--   * Every driver's rating is recomputed.

create or replace function private.attention_penalty_of(p_type text) returns int
language sql immutable set search_path = public as $$
  select case p_type when 'eyes_off' then 40 when 'drowsy' then 50 else 0 end
$$;

create or replace function private.watched_miles(p_miles numeric, p_moving_s int, p_covered_s int) returns numeric
language sql immutable set search_path = public as $$
  select case when coalesce(p_miles, 0) <= 0 or coalesce(p_moving_s, 0) <= 0 or coalesce(p_covered_s, 0) <= 0 then 0
    else p_miles * least(p_covered_s, p_moving_s)::numeric / p_moving_s end
$$;

-- plan §2 safetyRating with Attention: null with no miles
create or replace function private.safety_rating(p_penalty numeric, p_miles numeric, p_attention numeric, p_watched numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when coalesce(p_miles, 0) <= 0 then null
    else round(greatest(0, least(100, 100 - (greatest(p_penalty, 0) / p_miles * 100) / 10
      - case when coalesce(p_watched, 0) > 0 then 10 * greatest(coalesce(p_attention, 0), 0) / greatest(p_watched, 10) else 0 end)), 1) end
$$;

-- the rating over the kept scored drives started in (p_from, p_to]
create or replace function private.rating_window(p_user uuid, p_from timestamptz, p_to timestamptz) returns numeric
language sql stable set search_path = public as $$
  with d as (
    select t.id, t.miles, t.rating_penalty, t.dashcam_moving_s, t.dashcam_covered_s
    from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
      and t.started_at > p_from and t.started_at <= p_to
  )
  select private.safety_rating(
    coalesce((select sum(rating_penalty) from d), 0),
    coalesce((select sum(miles) from d), 0),
    coalesce((select sum(private.attention_penalty_of(e.type)) from public.trip_events e join d on d.id = e.trip_id
              where e.status = 'active' and e.type in ('eyes_off', 'drowsy')), 0),
    coalesce((select sum(private.watched_miles(miles, dashcam_moving_s, dashcam_covered_s)) from d), 0))
$$;

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
    safety_rating = private.rating_window(p_user, now() - interval '30 days', now()),
    ranked = v_miles >= 10,
    rating_updated_at = now()
  where user_id = p_user;
end $$;

-- the rating as of p_at (the 30 days before it), for the trend arrow
create or replace function private.rating_as_of(p_user uuid, p_at timestamptz) returns numeric
language sql stable set search_path = public as $$
  select private.rating_window(p_user, p_at - interval '30 days', p_at)
$$;

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
  select coalesce(jsonb_agg(jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id,
      'startedAt', floor(extract(epoch from t.started_at) * 1000)::bigint,
      'endedAt', floor(extract(epoch from t.ended_at) * 1000)::bigint,
      'tz', t.tz, 'localDay', t.local_day, 'leagueWeek', t.league_week,
      'miles', t.miles, 'safeMiles', t.safe_miles, 'nightMiles', t.night_miles, 'durationS', t.duration_s,
      'polyline', t.polyline, 'dashcamOn', t.dashcam_on, 'nDashcam', t.n_dashcam,
      'dashcamMovingS', t.dashcam_moving_s, 'dashcamCoveredS', t.dashcam_covered_s,
      'scored', t.scored, 'reason', t.reason, 'notDriving', t.not_driving, 'clean', t.clean,
      'pointsNet', t.points_net, 'breakdown', t.breakdown, 'result', t.result,
      'events', private.trip_events_json(t.id)) order by t.started_at desc), '[]'::jsonb)
    into v_out
  from (
    select * from public.trips t
    where t.user_id = v_uid and t.merged_into is null and (p_before is null or t.started_at < p_before)
    order by t.started_at desc
    limit p_limit
  ) t;
  return v_out;
end $$;

-- every driver's rating, made the new way
do $$
declare r record;
begin
  for r in select user_id from public.progress loop
    perform private.refresh_rating(r.user_id);
  end loop;
end $$;
