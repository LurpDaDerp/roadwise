-- 0034_passenger_rides: every passenger claim is a passenger ride, counted by month.
--
--   * private.passenger_rides: one row per claim, keyed by (user, client_trip_id), holding only the
--     drive's local day and which claim it was: `in_drive` (the driving screen's "Not driving?",
--     whose drive is never uploaded), `notification` (the recap notification's "I wasn't driving" on
--     an automatic drive) or `after` ("Wasn't driving" on the recap). No time and no route. It lives
--     in `private` (the Data API never exposes it), with RLS on and no grant to any API role; only
--     the functions below read or write it. It goes with the account (on delete cascade).
--   * A trip marked not driving by any path (mark_not_driving, or the notification's mark) records
--     its ride through a trigger, so mark_not_driving itself is not redefined here. The drives
--     already marked are recorded as `after` rides.
--   * record_passenger_ride(clientTripId, localDay): the in-drive claim. Idempotent on the trip id.
--   * mark_passenger_ride(clientTripId): the notification's mark. It marks the uploaded drive not
--     driving as mark_not_driving does (0032's body: the rating and the week's goals drop it, the
--     account is flagged when 3 of its last 4 marks were on drives with events), but uses no monthly
--     mark: not_driving_left now leaves out the drives marked from the notification. Only an
--     automatic drive whose "Not driving?" never ran out, and only within 35 minutes of the later of
--     its end and its first upload (the phone offers it for 30 minutes after the end, before the
--     recap is opened; the 5 extra minutes cover clock drift and an upload sent late with the mark
--     right behind it). A repeat, or a drive already marked, answers the same document and writes
--     nothing. Its answer has mark_not_driving's shape.
--   * get_passenger_rides(userId default self): { this_month } for the caller or a friend, the
--     month in the rider's own time zone (private.user_tz). Anyone else (or a block either way) is
--     "profile not found". Friends always see it: it is not behind a sharing setting.
--
-- New objects only, besides not_driving_left (same signature; CREATE OR REPLACE keeps its ACL).
-- Deploy: this migration alone; no edge function changes.

-- ---------------------------------------------------------------------------
-- the rides
-- ---------------------------------------------------------------------------
create table private.passenger_rides (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_trip_id uuid not null,
  local_day date not null,
  kind text not null check (kind in ('in_drive', 'notification', 'after')),
  primary key (user_id, client_trip_id)
);
-- the month's count: one rider's days in order
create index passenger_rides_user_day_idx on private.passenger_rides (user_id, local_day);

alter table private.passenger_rides enable row level security;
revoke all on private.passenger_rides from public, anon, authenticated;

-- the drives already marked "Wasn't driving"
insert into private.passenger_rides (user_id, client_trip_id, local_day, kind)
  select t.user_id, t.client_trip_id, t.local_day, 'after' from public.trips t where t.not_driving
  on conflict (user_id, client_trip_id) do nothing;

-- ---------------------------------------------------------------------------
-- a trip marked not driving is a passenger ride
-- ---------------------------------------------------------------------------
-- A definer, so the ride is recorded whoever marks the trip. The notification's mark writes its own
-- `notification` row first; this one then leaves it as it is.
create or replace function private.trip_marked_passenger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into private.passenger_rides (user_id, client_trip_id, local_day, kind)
    values (new.user_id, new.client_trip_id, new.local_day, 'after')
    on conflict (user_id, client_trip_id) do nothing;
  return null;
end $$;

create trigger trips_marked_passenger after update of not_driving on public.trips
  for each row when (new.not_driving and not old.not_driving)
  execute function private.trip_marked_passenger();

-- ---------------------------------------------------------------------------
-- "Wasn't driving" marks left: the notification's marks use none
-- ---------------------------------------------------------------------------
create or replace function private.not_driving_left(p_user uuid) returns int
language sql stable set search_path = public as $$
  select greatest(0, 2 - (select count(*)::int from public.trips t
    where t.user_id = p_user and t.not_driving and t.not_driving_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
      and not exists (select 1 from private.passenger_rides r
                      where r.user_id = t.user_id and r.client_trip_id = t.client_trip_id and r.kind = 'notification')))
$$;

-- ---------------------------------------------------------------------------
-- the in-drive claim
-- ---------------------------------------------------------------------------
-- The local day the phone sends is held to the last 60 days, and to one day ahead (a zone east of
-- UTC); anything else is not a day this drive could have had.
create or replace function private.record_passenger_ride(p_user uuid, p_client_trip_id uuid, p_local_day date) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_day date;
begin
  if p_user is null or p_client_trip_id is null then
    raise exception 'user and clientTripId are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_local_day is null or p_local_day < v_today - 60 or p_local_day > v_today + 1 then
    raise exception 'invalid local day' using errcode = 'invalid_parameter_value';
  end if;
  insert into private.passenger_rides (user_id, client_trip_id, local_day, kind)
    values (p_user, p_client_trip_id, p_local_day, 'in_drive')
    on conflict (user_id, client_trip_id) do nothing;
  select r.local_day into v_day from private.passenger_rides r where r.user_id = p_user and r.client_trip_id = p_client_trip_id;
  return jsonb_build_object('clientTripId', p_client_trip_id, 'localDay', to_char(v_day, 'YYYY-MM-DD'));
end $$;

-- ---------------------------------------------------------------------------
-- the notification's mark
-- ---------------------------------------------------------------------------
-- The trip-marking steps are 0032's mark_not_driving, unchanged; the checks before them are this
-- mark's own, and the monthly count is not one of them.
create or replace function private.mark_passenger_ride(p_user uuid, p_client_trip_id uuid) returns jsonb
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
  if not found then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  if not t.not_driving then
    if t.origin <> 'auto' then
      raise exception 'not an automatic drive' using errcode = 'insufficient_privilege';
    end if;
    if t.not_driving_expired then
      raise exception 'the not driving option expired' using errcode = 'insufficient_privilege';
    end if;
    if now() > greatest(t.ended_at, t.created_at) + interval '35 minutes' then
      raise exception 'the passenger mark came too late' using errcode = 'insufficient_privilege';
    end if;
    -- written before the trip is marked, so the trigger's `after` row never takes its place; a stray
    -- in-drive row under the same id becomes this mark
    insert into private.passenger_rides (user_id, client_trip_id, local_day, kind)
      values (p_user, t.client_trip_id, t.local_day, 'notification')
      on conflict (user_id, client_trip_id) do update set kind = 'notification', local_day = excluded.local_day;
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

-- ---------------------------------------------------------------------------
-- the month's count
-- ---------------------------------------------------------------------------
create or replace function private.passenger_rides_this_month(p_user uuid) returns int
language plpgsql stable set search_path = public as $$
declare
  v_start date := date_trunc('month', now() at time zone private.user_tz(p_user))::date;
begin
  return (select count(*)::int from private.passenger_rides r
    where r.user_id = p_user and r.local_day >= v_start and r.local_day < (v_start + interval '1 month')::date);
end $$;

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
create or replace function public.record_passenger_ride(p_client_trip_id uuid, p_local_day date) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'record_passenger_ride requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'passenger_rides', interval '1 hour', 60);
  return private.record_passenger_ride(v_uid, p_client_trip_id, p_local_day);
end $$;

create or replace function public.mark_passenger_ride(p_client_trip_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'mark_passenger_ride requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'passenger_rides', interval '1 hour', 60);
  return private.mark_passenger_ride(v_uid, p_client_trip_id);
end $$;

-- volatile: it takes from the caller's rate limit
create or replace function public.get_passenger_rides(p_user_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
begin
  if v_uid is null then
    raise exception 'get_passenger_rides requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'get_passenger_rides', interval '1 minute', 60);
  v_other := coalesce(p_user_id, v_uid);
  if v_other <> v_uid and (private.blocked_either(v_uid, v_other) or not private.are_friends(v_uid, v_other)) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  return jsonb_build_object('this_month', private.passenger_rides_this_month(v_other));
end $$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
revoke all on function private.trip_marked_passenger() from public, anon, authenticated;
revoke all on function private.record_passenger_ride(uuid, uuid, date) from public, anon, authenticated;
revoke all on function private.mark_passenger_ride(uuid, uuid) from public, anon, authenticated;
revoke all on function private.passenger_rides_this_month(uuid) from public, anon, authenticated;
revoke all on function public.record_passenger_ride(uuid, date) from public, anon, authenticated;
revoke all on function public.mark_passenger_ride(uuid) from public, anon, authenticated;
revoke all on function public.get_passenger_rides(uuid) from public, anon, authenticated;
grant execute on function public.record_passenger_ride(uuid, date) to authenticated;
grant execute on function public.mark_passenger_ride(uuid) to authenticated;
grant execute on function public.get_passenger_rides(uuid) to authenticated;
notify pgrst, 'reload schema';
