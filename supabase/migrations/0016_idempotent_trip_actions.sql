-- 0016_idempotent_trip_actions: a repeated "Wasn't driving" or dispute answers what the first one
-- did instead of a refusal. The phone queues each action and retries it when the answer never
-- arrived (a timeout, the app killed), so the server had often already applied it; the retry then
-- read 409 already_marked / already_disputed and the phone undid a change the server had kept.
--
--   * revert_latest_not_driving on a drive already marked answers the same document as the first
--     call: the trip ids, the uses left this month and the progress as it now stands. Nothing is
--     written again, and the latest-drive, 24 h and monthly-use rules are not re-checked (they held
--     when it was applied).
--   * a dispute of an event already disputed for the same reason answers the stored decision:
--     dispute_context hands back that status with nothing to re-score, and apply_dispute returns
--     the dispute's outcome (status, reject reason, the drive's net and breakdown as now stored,
--     the delta it credited, from its drive_adjust ledger row, the quota left and progress)
--     without writing. A dispute of that event for another reason is still refused
--     ("already disputed").
--   * private.dispute_outcome builds that answer, in apply_dispute's shape.

-- the answer to a dispute already stored for (trip, event): apply_dispute's document, nothing written
create or replace function private.dispute_outcome(p_user uuid, p_trip uuid, p_event uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('tripId', t.id, 'eventId', d.client_event_id, 'status', d.status,
    -- a mounted report is only ever rejected as not mounted; the others only on the weekly quota
    'rejectReason', case when d.status = 'accepted' then null when d.reason = 'mounted' then 'not_mounted' else 'quota' end,
    'quotaLeft', greatest(0, 3 - private.dispute_quota_used(p_user, d.reason)),
    'net', t.points_net,
    'delta', case when d.status = 'accepted' then coalesce((select l.amount from public.points_ledger l
                   where l.user_id = p_user and l.key = 'drive_adjust:' || t.id || ':' || d.client_event_id), 0) else 0 end,
    'breakdown', case when t.scored then t.breakdown else null end,
    'progress', private.progress_json(p_user, false))
  from public.event_disputes d join public.trips t on t.id = d.trip_id
  where d.trip_id = p_trip and d.client_event_id = p_event and d.user_id = p_user
$$;
revoke all on function private.dispute_outcome(uuid, uuid, uuid) from public, anon, authenticated;

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
  -- a repeat (the first answer was lost): the same document, nothing written again
  if t.not_driving then
    return jsonb_build_object('tripId', t.id, 'clientTripId', t.client_trip_id,
      'notDrivingLeft', private.not_driving_left(p_user),
      'progress', (select jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level, 'streak', g.streak,
        'atRisk', g.at_risk, 'freezes', g.freezes, 'safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = p_user));
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
