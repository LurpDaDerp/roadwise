-- 0003_drives: the trips fact table, its events and disputes, the map-feedback log, the points
-- ledger, the derived aggregates (safety rating, stat sums, week points) and the two client reads.
--
-- trips is the fact table (plan decision 8): daily cap, 30-day rating, weekly league points,
-- challenge progress and clan goals are all derived from it by indexed query. Every row keeps the
-- `progress_before` snapshot (server-only) so the latest drive can be reverted exactly. The
-- writers (private.drive_context / apply_drive / revert / dispute) are in 0008_engine.

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_trip_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  local_day date not null,
  league_week text not null check (league_week ~ '^[0-9]{4}-W[0-5][0-9]$'),
  tz text not null check (char_length(tz) between 1 and 64),
  miles numeric(7,2) not null check (miles between 0 and 2000),
  safe_miles numeric(7,2) not null check (safe_miles between 0 and 2000),
  night_miles numeric(7,2) not null check (night_miles between 0 and 2000),
  duration_s int not null check (duration_s between 0 and 86400),
  dms_on boolean not null default false,
  dms_face_seen boolean not null default false,
  polyline text not null default '' check (char_length(polyline) <= 65536),
  scored boolean not null default false,
  reason text check (reason in ('too_short', 'spoofed', 'implausible')),
  not_driving boolean not null default false,
  not_driving_at timestamptz,
  merged_into uuid references public.trips(id) on delete cascade,
  is_loop boolean not null default false,
  loop_repeat boolean not null default false,
  safe_miles_earlier_today numeric(7,2) not null default 0 check (safe_miles_earlier_today >= 0),
  points_net int not null default 0,
  breakdown jsonb not null default '{}'::jsonb check (jsonb_typeof(breakdown) = 'object' and pg_column_size(breakdown) <= 65536),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536)),
  rating_penalty int not null default 0 check (rating_penalty >= 0),
  n_events int not null default 0 check (n_events >= 0),
  n_speeding int not null default 0 check (n_speeding >= 0),
  n_pickup int not null default 0 check (n_pickup >= 0),
  handling_s int not null default 0 check (handling_s >= 0),
  n_hard_brake int not null default 0 check (n_hard_brake >= 0),
  n_hard_accel int not null default 0 check (n_hard_accel >= 0),
  n_hard_corner int not null default 0 check (n_hard_corner >= 0),
  n_eyes_off int not null default 0 check (n_eyes_off >= 0),
  n_drowsy int not null default 0 check (n_drowsy >= 0),
  clean boolean not null default false,
  streak_before int not null default 0 check (streak_before >= 0),
  progress_before jsonb not null default '{}'::jsonb check (jsonb_typeof(progress_before) = 'object' and pg_column_size(progress_before) <= 4096),
  rev int not null default 1 check (rev >= 1),
  scoring_version int not null default 3,
  app_version text check (char_length(app_version) <= 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_user_client_unique unique (user_id, client_trip_id),
  constraint trips_time_order check (ended_at > started_at and ended_at - started_at <= interval '12 hours'),
  constraint trips_safe_le_miles check (safe_miles <= miles and night_miles <= miles)
);
create index trips_user_started_idx on public.trips (user_id, started_at desc);
create index trips_user_week_idx on public.trips (user_id, league_week);
create index trips_user_day_idx on public.trips (user_id, local_day);
create index trips_merged_into_idx on public.trips (merged_into) where merged_into is not null;
create trigger trips_touch before update on public.trips for each row execute function public.touch_updated_at();

-- one row per device-detected event; client_event_id is the id the breakdown refers to
create table public.trip_events (
  trip_id uuid not null references public.trips(id) on delete cascade,
  client_event_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'phone_handling', 'eyes_off', 'drowsy')),
  tier text not null check (tier in ('minor', 'moderate', 'severe')),
  started_at timestamptz not null,
  duration_s numeric(8,1) not null check (duration_s between 0 and 43200),
  units int check (units between 0 and 10000),
  stopped_in_traffic boolean,
  zone text check (zone in ('school', 'construction')),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  measured jsonb not null default '{}'::jsonb check (jsonb_typeof(measured) = 'object' and pg_column_size(measured) <= 1024),
  penalty int not null default 0 check (penalty >= 0),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (trip_id, client_event_id)
);
create index trip_events_user_idx on public.trip_events (user_id);
create trigger trip_events_touch before update on public.trip_events for each row execute function public.touch_updated_at();

create table public.event_disputes (
  trip_id uuid not null,
  client_event_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('hazard', 'wrong_limit', 'mounted')),
  status text not null check (status in ('accepted', 'rejected')),
  created_at timestamptz not null default now(),
  primary key (trip_id, client_event_id),
  constraint event_disputes_event_fkey foreign key (trip_id, client_event_id)
    references public.trip_events (trip_id, client_event_id) on delete cascade
);
-- the weekly quota count
create index event_disputes_user_created_idx on public.event_disputes (user_id, created_at desc);

-- wrong-limit reports, as anonymous map data: no user id, no trip id
create table public.map_feedback (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  limit_mph int check (limit_mph between 0 and 120),
  speed_mph int check (speed_mph between 0 and 250),
  created_at timestamptz not null default now()
);

-- idempotent keys; week points sum the challenge rows of a week
create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 128),
  amount int not null,
  kind text not null check (kind in ('drive', 'drive_adjust', 'challenge', 'revert')),
  trip_id uuid references public.trips(id) on delete cascade,
  league_week text check (league_week ~ '^[0-9]{4}-W[0-5][0-9]$'),
  created_at timestamptz not null default now(),
  constraint points_ledger_user_key_unique unique (user_id, key)
);
create index points_ledger_trip_idx on public.points_ledger (trip_id) where trip_id is not null;
create index points_ledger_user_week_idx on public.points_ledger (user_id, league_week) where kind = 'challenge';

-- ---------------------------------------------------------------------------
-- derived aggregates
-- ---------------------------------------------------------------------------
-- the scored, kept drives: not merged away, not "wasn't driving"
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
    ranked = v_miles >= 25,
    rating_updated_at = now()
  where user_id = p_user;
end $$;

-- the rating as of p_at (the 30 days before it), for the trend arrow
create or replace function private.rating_as_of(p_user uuid, p_at timestamptz) returns numeric
language sql stable set search_path = public as $$
  select private.safety_rating(coalesce(sum(t.rating_penalty), 0), coalesce(sum(t.miles), 0))
  from public.trips t
  where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
    and t.started_at > p_at - interval '30 days' and t.started_at <= p_at
$$;

-- StatSums (plan §2) over the kept scored drives since p_since (null = all time)
create or replace function private.stat_sums(p_user uuid, p_since timestamptz) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'miles', coalesce(sum(t.miles), 0),
    'durationS', coalesce(sum(t.duration_s), 0),
    'nightMiles', coalesce(sum(t.night_miles), 0),
    'drives', count(*),
    'cleanDrives', count(*) filter (where t.clean),
    'speeding', coalesce(sum(t.n_speeding), 0),
    'pickups', coalesce(sum(t.n_pickup), 0),
    'handlingS', coalesce(sum(t.handling_s), 0),
    'hardBrake', coalesce(sum(t.n_hard_brake), 0),
    'hardAccel', coalesce(sum(t.n_hard_accel), 0),
    'hardCorner', coalesce(sum(t.n_hard_corner), 0),
    'eyesOff', coalesce(sum(t.n_eyes_off), 0),
    'drowsy', coalesce(sum(t.n_drowsy), 0))
  from public.trips t
  where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
    and (p_since is null or t.started_at >= p_since)
$$;

-- week points = drive nets of the week + challenge rewards of the week
create or replace function private.week_points(p_user uuid, p_week text) returns int
language sql stable set search_path = public as $$
  select coalesce((select sum(t.points_net)::int from public.trips t
                   where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null), 0)
       + coalesce((select sum(l.amount)::int from public.points_ledger l
                   where l.user_id = p_user and l.league_week = p_week and l.kind = 'challenge'), 0)
$$;

create or replace function private.week_drives(p_user uuid, p_week text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.trips t
  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null
$$;

-- the events of one trip in the upload-payload shape (used by the engine's merge and dispute paths)
create or replace function private.trip_events_json(p_trip uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.client_event_id, 'type', e.type, 'tier', e.tier,
      'startedAt', floor(extract(epoch from e.started_at) * 1000)::bigint,
      'durationS', e.duration_s, 'units', e.units, 'stoppedInTraffic', e.stopped_in_traffic, 'zone', e.zone,
      'status', e.status, 'lat', e.lat, 'lng', e.lng, 'measured', e.measured, 'penalty', e.penalty)
    order by e.started_at, e.client_event_id), '[]'::jsonb)
  from public.trip_events e where e.trip_id = p_trip
$$;

-- ---------------------------------------------------------------------------
-- client reads
-- ---------------------------------------------------------------------------
-- list_my_drives(p_before, p_limit): the caller's kept drives newest first, with events and result
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
      'dmsOn', t.dms_on, 'dmsFaceSeen', t.dms_face_seen, 'polyline', t.polyline,
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

-- get_my_stat_sums(p_since) -> StatSums
create or replace function public.get_my_stat_sums(p_since timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'get_my_stat_sums requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return private.stat_sums(v_uid, p_since);
end $$;

-- ---------------------------------------------------------------------------
-- cron: the rating decays as drives age out of the 30-day window
-- ---------------------------------------------------------------------------
create or replace function private.refresh_ratings_daily() returns int
language plpgsql volatile set search_path = public as $$
declare
  v_user uuid;
  v_n int := 0;
begin
  for v_user in
    select distinct t.user_id from public.trips t where t.started_at > now() - interval '31 days'
  loop
    perform private.refresh_rating(v_user);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
select cron.schedule('rating-refresh', '20 4 * * *', 'select private.refresh_ratings_daily()');
select cron.schedule('cron-log-purge', '30 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$);

-- ---------------------------------------------------------------------------
-- RLS and grants: no direct client access; every read goes through the RPCs above
-- ---------------------------------------------------------------------------
alter table public.trips enable row level security;
alter table public.trip_events enable row level security;
alter table public.event_disputes enable row level security;
alter table public.map_feedback enable row level security;
alter table public.points_ledger enable row level security;

revoke all on public.trips, public.trip_events, public.event_disputes, public.map_feedback, public.points_ledger from anon, authenticated;

revoke all on function public.list_my_drives(timestamptz, int) from public, anon, authenticated;
revoke all on function public.get_my_stat_sums(timestamptz) from public, anon, authenticated;
grant execute on function public.list_my_drives(timestamptz, int) to authenticated;
grant execute on function public.get_my_stat_sums(timestamptz) to authenticated;
