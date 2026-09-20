-- 0002_trips: trips, trip events, disputes, daily scores, baselines, map feedback, rate limits,
-- the service-role writers and the private traces bucket.
--
-- The 0001 conventions apply unchanged (RLS on every table; owner-only policies written
-- `col = (select auth.uid())` to authenticated; default-deny grants; definer functions owned by
-- postgres pinning search_path = public). What is new here:
--   * one scoring implementation. The edge functions score with _shared/scoring (TypeScript) and
--     pass the results in; this migration holds no port of scoreTrip / longTermScore / evaluateDay.
--     The SQL side validates shape and range, writes, counts the dispute allowance and owns the
--     status transitions (accepted dispute -> event `disputed`; passenger role -> trip `unscored`;
--     delete -> `deleted_at`).
--   * the writers are executable by service_role only, refuse any other JWT role as their first
--     statement (require_service_role), and act on the user id the edge function derived from the
--     caller's JWT (the `p_user` argument); every row they touch is checked against that id.
--   * clients never write these tables and there is no client-callable RPC in this migration; the
--     app reaches every mutation through the finalize-trip and trip-actions edge functions.
--   * the trace object key is derived from the user id and the client trip id, never from the
--     `tracePath` field the device sent; a table CHECK pins the derivation for every writer.
--   * writers are idempotent on a queued retry: apply_trip replays on (user, client_trip_id),
--     record_dispute replays on the event, soft_delete_trip replays on a deleted trip; every reply
--     carries `replayed` so nothing silently no-ops.
--   * lock order inside the writers is trips -> trip_events -> rate_limits, so a dispute and a
--     recompute on the same trip queue rather than deadlock.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- the device's id (a uuid today); the character class keeps the derived storage key single-segment
  client_trip_id text not null check (client_trip_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  -- calendar day of started_at in the trip's zone; derived by trips_local_day, keys score_daily
  local_day date not null,
  tz text not null check (char_length(tz) between 1 and 64),
  distance_m numeric not null check (distance_m between 0 and 2000000),
  duration_s numeric not null check (duration_s between 0 and 172800),
  role text not null check (role in ('driver', 'passenger', 'other', 'unknown')),
  role_confidence numeric check (role_confidence between 0 and 1),
  role_source text check (char_length(role_source) <= 32),
  mode text not null check (mode in ('mounted', 'pocket', 'auto')),
  camera_session boolean not null default false,
  score int check (score between 0 and 100),
  scoring_version int not null default 1 check (scoring_version >= 1),
  category_deductions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(category_deductions) = 'object' and pg_column_size(category_deductions) <= 2048),
  exposure numeric not null check (exposure > 0 and exposure <= 1000),
  data_quality text not null check (data_quality in ('A', 'B', 'C')),
  conditions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(conditions) = 'object' and pg_column_size(conditions) <= 1024),
  had_severe_event boolean not null default false,
  -- the device's rowsDigest, verbatim: TripMetrics inputs (validGnssPct, imuPresent,
  -- maxSustainedSpeedMps) for any later re-score, plus the trace sha256 for verification
  rows_digest jsonb not null default '{}'::jsonb
    check (jsonb_typeof(rows_digest) = 'object' and pg_column_size(rows_digest) <= 1024),
  limit_coverage_pct numeric check (limit_coverage_pct between 0 and 100),
  start_label text check (char_length(start_label) <= 80),
  end_label text check (char_length(end_label) <= 80),
  start_geohash5 text check (char_length(start_geohash5) = 5),
  end_geohash5 text check (char_length(end_geohash5) = 5),
  polyline text not null default '' check (octet_length(polyline) <= 16384),
  status text not null check (status in ('provisional', 'final', 'unscored', 'discarded')),
  unscored_reason text check (unscored_reason in ('passenger', 'too_short', 'grade_c', 'implausible_speed')),
  trace_path text check (char_length(trace_path) <= 256),
  -- finalized by crash recovery from the last checkpoint (M1 Task 9): rows may be missing
  incomplete boolean not null default false,
  vehicle_id uuid,
  notes text check (char_length(notes) <= 500),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_user_client_trip_key unique (user_id, client_trip_id),
  constraint trips_ended_after_started check (ended_at >= started_at),
  constraint trips_score_iff_scored check ((score is not null) = (status in ('provisional', 'final'))),
  -- the storage key is always the owner prefix plus the client id, whichever writer sets it
  constraint trips_trace_path_derived check (trace_path is null or trace_path = user_id::text || '/' || client_trip_id || '.bin.gz')
);
-- the owner policy filters on user_id and deleted_at; history reads newest first
create index trips_user_started_idx on public.trips (user_id, started_at desc) where deleted_at is null;

create table public.trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- the device's event id: keys the scorer's eventDeductions map and the client's dispute request
  client_event_id text not null check (char_length(client_event_id) between 1 and 64),
  category text not null check (category in ('phone', 'speeding', 'braking', 'accel', 'cornering', 'focus')),
  started_at timestamptz not null,
  duration_ms int not null check (duration_ms between 0 and 172800000),
  -- numeric(8,3) rounds whatever arrives to 3 dp (roughly 100 m): no precise positions are stored
  lat numeric(8,3) check (lat between -90 and 90),
  lng numeric(8,3) check (lng between -180 and 180),
  measured jsonb not null default '{}'::jsonb
    check (jsonb_typeof(measured) = 'object' and pg_column_size(measured) <= 1024),
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 256),
  severity numeric not null check (severity between 0 and 100),
  confidence numeric not null check (confidence between 0 and 1),
  context_multiplier numeric not null check (context_multiplier between 1 and 1.5),
  deduction numeric check (deduction between 0 and 100),
  alert_shown boolean not null default false,
  corrected boolean not null default false,
  source text not null check (source in ('gnss', 'imu', 'both', 'os', 'camera')),
  status text not null check (status in ('scored', 'possible', 'disputed', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- leads on trip_id, so it is also the index the trips cascade walks
  constraint trip_events_trip_client_event_key unique (trip_id, client_event_id)
);
create index trip_events_user_started_idx on public.trip_events (user_id, started_at desc);

create table public.event_disputes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.trip_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('not_driver', 'passenger_phone', 'wrong_limit', 'hazard', 'phone_moved', 'other')),
  note text check (char_length(note) <= 500),
  stated_limit_mph int check (stated_limit_mph between 5 and 100),
  auto_accepted boolean not null default false,
  -- the decision as taken: whether this dispute spent one of the 3-per-7-days, and why it was
  -- denied. The rolling counts read these, and a replay answers from them.
  consumed_allowance boolean not null default false,
  denied_reason text check (denied_reason in ('allowance_7d', 'allowance_30d')),
  -- the map_feedback cell this wrong-limit report went to (one report per user and cell)
  segment_key text check (char_length(segment_key) <= 128),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one dispute per event, ever (the audit row stays whether or not it was applied)
  constraint event_disputes_event_id_key unique (event_id)
);
create index event_disputes_user_created_idx on public.event_disputes (user_id, created_at desc);

create table public.score_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  long_term_score int check (long_term_score between 0 and 100),
  band text check (band in ('excellent', 'good', 'getting_there', 'needs_focus')),
  provisional boolean not null default true,
  safe_day boolean not null default false,
  good_day boolean not null default false,
  phone_free_day boolean not null default false,
  camera_day boolean not null default false,
  exposure numeric not null default 0 check (exposure between 0 and 10000),
  driving_s int not null default 0 check (driving_s between 0 and 172800),
  trips_scored int not null default 0 check (trips_scored between 0 and 1000),
  severe_events int not null default 0 check (severe_events between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table public.baselines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  medians jsonb not null default '{}'::jsonb
    check (jsonb_typeof(medians) = 'object' and pg_column_size(medians) <= 2048),
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- aggregated, de-identified wrong-limit reports keyed by a 7-character geohash cell; server only.
-- One report per (cell, user): the writer dedupes through event_disputes.segment_key.
create table public.map_feedback (
  segment_key text primary key check (char_length(segment_key) between 1 and 128),
  reports int not null default 0 check (reports >= 0),
  stated_limits_mph int[] not null default '{}'::int[] check (cardinality(stated_limits_mph) <= 200),
  status text not null default 'open' check (status in ('open', 'reviewed', 'applied', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- per-user rows the writers lock to serialise a check with its consumption. The dispute allowance
-- is counted from event_disputes; the `dispute_7d` row here is only the mutex.
create table public.rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 64),
  window_start timestamptz not null default now(),
  count int not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- triggers: updated_at maintenance, local_day derivation
-- ---------------------------------------------------------------------------
create trigger trips_touch before update on public.trips for each row execute function public.touch_updated_at();
create trigger trip_events_touch before update on public.trip_events for each row execute function public.touch_updated_at();
create trigger event_disputes_touch before update on public.event_disputes for each row execute function public.touch_updated_at();
create trigger score_daily_touch before update on public.score_daily for each row execute function public.touch_updated_at();
create trigger baselines_touch before update on public.baselines for each row execute function public.touch_updated_at();
create trigger map_feedback_touch before update on public.map_feedback for each row execute function public.touch_updated_at();
create trigger rate_limits_touch before update on public.rate_limits for each row execute function public.touch_updated_at();

-- local_day follows started_at and tz whichever path writes them (an unknown zone raises 22023).
-- apply_trip evaluates the same expression only to check the caller's day rows; the column itself
-- is always this trigger's.
create or replace function public.sync_trip_local_day() returns trigger
language plpgsql set search_path = public as $$
begin
  new.local_day := (new.started_at at time zone new.tz)::date;
  return new;
end $$;
create trigger trips_local_day before insert or update of started_at, tz on public.trips
  for each row execute function public.sync_trip_local_day();

-- ---------------------------------------------------------------------------
-- validation helpers (not definer; they run inside the definer writers as postgres)
-- ---------------------------------------------------------------------------
-- first statement of every writer: only the edge functions' service-role client may call them
create or replace function public.require_service_role(p_fn text) returns void
language plpgsql stable set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception '% requires the service role', p_fn using errcode = 'insufficient_privilege';
  end if;
end $$;

-- every listed key must be present (a JSON null counts as present; absence is a contract drift)
create or replace function public.require_keys(p_fn text, p_obj jsonb, p_prefix text, p_keys text[]) returns void
language plpgsql set search_path = public as $$
declare
  k text;
begin
  if p_obj is null or jsonb_typeof(p_obj) <> 'object' then
    if p_prefix = '' then
      raise exception '% payload must be a JSON object', p_fn using errcode = 'invalid_parameter_value';
    end if;
    raise exception '% payload key % must be a JSON object', p_fn, rtrim(p_prefix, '.') using errcode = 'invalid_parameter_value';
  end if;
  foreach k in array p_keys loop
    if not (p_obj ? k) then
      raise exception '% payload is missing %', p_fn, p_prefix || k using errcode = 'invalid_parameter_value';
    end if;
  end loop;
end $$;

create or replace function public.require_type(p_fn text, p_value jsonb, p_name text, p_type text) returns void
language plpgsql set search_path = public as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> p_type then
    raise exception '% payload key % must be a JSON %', p_fn, p_name, p_type using errcode = 'invalid_parameter_value';
  end if;
end $$;

-- a ScoredTrip block: the keys the writers need, a known status, an integer score 0..100 that is
-- present exactly when the status is provisional or final
create or replace function public.require_scored_trip(p_fn text, p_scored jsonb, out status text, out score int)
language plpgsql set search_path = public as $$
declare
  v_score_num numeric;
begin
  perform public.require_keys(p_fn, p_scored, 'scored.', array['score', 'status', 'categoryDeductions']);
  perform public.require_type(p_fn, p_scored->'categoryDeductions', 'scored.categoryDeductions', 'object');
  status := p_scored->>'status';
  if status is null or status not in ('provisional', 'final', 'unscored', 'discarded') then
    raise exception '% status is not a trip status', p_fn using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_scored->'score') <> 'null' then
    v_score_num := (p_scored->>'score')::numeric;
    if v_score_num < 0 or v_score_num > 100 then
      raise exception '% score must be between 0 and 100', p_fn using errcode = 'invalid_parameter_value';
    end if;
    score := v_score_num::int;
  end if;
  if (score is not null) <> (status in ('provisional', 'final')) then
    raise exception '% score must be present exactly when the trip is scored', p_fn using errcode = 'invalid_parameter_value';
  end if;
end $$;

-- a day row, or an array of them, as the edge function computed it with evaluateDay/longTermScore
create or replace function public.require_score_days(p_fn text, p_days jsonb) returns void
language plpgsql set search_path = public as $$
declare
  v_keys constant text[] := array['day', 'longTermScore', 'band', 'provisional', 'safeDay', 'goodDay',
    'phoneFreeDay', 'cameraDay', 'exposure', 'drivingS', 'tripsScored', 'severeEvents'];
  d jsonb;
  i int := 0;
begin
  if p_days is null or jsonb_typeof(p_days) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_days) = 'object' then
    perform public.require_keys(p_fn, p_days, 'day.', v_keys);
  elsif jsonb_typeof(p_days) = 'array' then
    for d in select * from jsonb_array_elements(p_days) loop
      perform public.require_keys(p_fn, d, 'day[' || i || '].', v_keys);
      i := i + 1;
    end loop;
  else
    raise exception '% payload key day must be a JSON object or array', p_fn using errcode = 'invalid_parameter_value';
  end if;
end $$;

create or replace function public.require_baselines(p_fn text, p_baselines jsonb) returns void
language plpgsql set search_path = public as $$
begin
  if p_baselines is null or jsonb_typeof(p_baselines) = 'null' then
    return;
  end if;
  perform public.require_keys(p_fn, p_baselines, 'baselines.', array['medians']);
  perform public.require_type(p_fn, p_baselines->'medians', 'baselines.medians', 'object');
end $$;

-- ---------------------------------------------------------------------------
-- write helpers (validated by the callers above; not definer)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_score_day(p_user uuid, p_days jsonb) returns void
language plpgsql set search_path = public as $$
declare
  d jsonb;
begin
  if p_days is null or jsonb_typeof(p_days) = 'null' then
    return;
  end if;
  for d in select * from jsonb_array_elements(case when jsonb_typeof(p_days) = 'array' then p_days else jsonb_build_array(p_days) end) loop
    insert into public.score_daily (user_id, day, long_term_score, band, provisional, safe_day, good_day,
      phone_free_day, camera_day, exposure, driving_s, trips_scored, severe_events)
    values (p_user, (d->>'day')::date, (d->>'longTermScore')::int, d->>'band', (d->>'provisional')::boolean,
      (d->>'safeDay')::boolean, (d->>'goodDay')::boolean, (d->>'phoneFreeDay')::boolean, (d->>'cameraDay')::boolean,
      (d->>'exposure')::numeric, (d->>'drivingS')::int, (d->>'tripsScored')::int, (d->>'severeEvents')::int)
    on conflict (user_id, day) do update set
      long_term_score = excluded.long_term_score, band = excluded.band, provisional = excluded.provisional,
      safe_day = excluded.safe_day, good_day = excluded.good_day, phone_free_day = excluded.phone_free_day,
      camera_day = excluded.camera_day, exposure = excluded.exposure, driving_s = excluded.driving_s,
      trips_scored = excluded.trips_scored, severe_events = excluded.severe_events;
  end loop;
end $$;

create or replace function public.upsert_baselines(p_user uuid, p_baselines jsonb) returns void
language plpgsql set search_path = public as $$
begin
  if p_baselines is null or jsonb_typeof(p_baselines) = 'null' then
    return;
  end if;
  insert into public.baselines (user_id, medians, computed_at)
  values (p_user, p_baselines->'medians', coalesce((p_baselines->>'computedAt')::timestamptz, now()))
  on conflict (user_id) do update set medians = excluded.medians, computed_at = excluded.computed_at;
end $$;

-- ---------------------------------------------------------------------------
-- apply_trip: the finalize-trip writer. One transaction, keyed by (user, client_trip_id): the
-- first upload wins and every later call with the same key returns what is stored.
--
-- p = {
--   userId:      uuid (from the JWT; a user id anywhere inside `payload` is ignored),
--   payload:     FinalizeTripPayload as the device sent it (src/data/sync/payload.ts),
--   scored:      ScoredTrip as the server re-scored it (status may also be 'provisional'),
--   day:         one day row, or an array of them, one of which is the trip's own day,
--   baselines?:  { medians, computedAt? } | null,
--   conditions?: { night, precipitation } (trip-level, computed server-side) | null,
--   limitCoveragePct?: number | null
-- }
-- Returns { trip_id, score, status, day, replayed }.
-- Envelope shape and enum/range errors are 22023 with fixed messages; a malformed event row
-- (unknown category, out-of-range value, duplicate id) fails closed on the table's CHECKs and
-- keys (23514 / 22P02 / 23502 / 23505) because zod has already rejected it upstream.
-- ---------------------------------------------------------------------------
create or replace function public.apply_trip(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_payload jsonb;
  v_scored jsonb;
  v_user uuid;
  v_client text;
  v_status text;
  v_score int;
  v_scored_now boolean;
  v_started timestamptz;
  v_local_day date;
  v_trace text;
  v_trip_id uuid;
  v_existing record;
begin
  perform public.require_service_role('apply_trip');

  -- shape first: nothing is looked up or written for a payload that drifted from the contract
  perform public.require_keys('apply_trip', p, '', array['userId', 'payload', 'scored', 'day']);
  v_payload := p->'payload';
  v_scored := p->'scored';
  perform public.require_keys('apply_trip', v_payload, 'payload.', array['clientTripId', 'startedAt', 'endedAt', 'tz',
    'distanceM', 'durationS', 'role', 'roleConfidence', 'roleSource', 'mode', 'cameraSession', 'events', 'rowsDigest',
    'startGeohash5', 'endGeohash5', 'polyline', 'tracePath', 'hadSevereEvent', 'incomplete']);
  perform public.require_keys('apply_trip', v_scored, 'scored.', array['score', 'status', 'exposure', 'dataQuality',
    'categoryDeductions', 'eventDeductions', 'scoringVersion']);
  perform public.require_type('apply_trip', v_payload->'events', 'payload.events', 'array');
  perform public.require_type('apply_trip', v_payload->'rowsDigest', 'payload.rowsDigest', 'object');
  perform public.require_type('apply_trip', v_scored->'eventDeductions', 'scored.eventDeductions', 'object');
  select status, score into v_status, v_score from public.require_scored_trip('apply_trip', v_scored);
  v_scored_now := v_status in ('provisional', 'final');
  perform public.require_score_days('apply_trip', p->'day');
  perform public.require_baselines('apply_trip', p->'baselines');
  if p ? 'conditions' and jsonb_typeof(p->'conditions') <> 'null' then
    perform public.require_type('apply_trip', p->'conditions', 'conditions', 'object');
  end if;
  if jsonb_array_length(v_payload->'events') > 500 then
    raise exception 'apply_trip payload has more than 500 events' using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_user := (p->>'userId')::uuid;
  exception when invalid_text_representation then
    raise exception 'apply_trip userId is not a uuid' using errcode = 'invalid_parameter_value';
  end;
  if v_user is null then
    raise exception 'apply_trip userId is not a uuid' using errcode = 'invalid_parameter_value';
  end if;
  v_client := v_payload->>'clientTripId';
  if v_client is null or char_length(v_client) not between 1 and 64 then
    raise exception 'apply_trip clientTripId must be 1 to 64 characters' using errcode = 'invalid_parameter_value';
  end if;
  v_started := timestamptz 'epoch' + (v_payload->>'startedAt')::bigint * interval '1 millisecond';
  -- the same expression trips_local_day stores; here only to check the caller's day rows
  v_local_day := (v_started at time zone (v_payload->>'tz'))::date;
  if not exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(p->'day') = 'array' then p->'day' else jsonb_build_array(p->'day') end) d
    where (d->>'day')::date = v_local_day) then
    raise exception 'apply_trip day does not match the trip' using errcode = 'invalid_parameter_value';
  end if;
  -- the object key is derived here; the field only says whether a trace exists
  v_trace := case when jsonb_typeof(v_payload->'tracePath') = 'null' then null
    else v_user::text || '/' || v_client || '.bin.gz' end;

  insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s,
    role, role_confidence, role_source, mode, camera_session, score, scoring_version, category_deductions, exposure,
    data_quality, conditions, had_severe_event, rows_digest, limit_coverage_pct, start_geohash5, end_geohash5, polyline,
    status, unscored_reason, trace_path, incomplete)
  values (v_user, v_client, v_started,
    timestamptz 'epoch' + (v_payload->>'endedAt')::bigint * interval '1 millisecond',
    v_payload->>'tz', (v_payload->>'distanceM')::numeric, (v_payload->>'durationS')::numeric,
    v_payload->>'role', (v_payload->>'roleConfidence')::numeric, v_payload->>'roleSource', v_payload->>'mode',
    (v_payload->>'cameraSession')::boolean, v_score, (v_scored->>'scoringVersion')::int, v_scored->'categoryDeductions',
    (v_scored->>'exposure')::numeric, v_scored->>'dataQuality',
    case when jsonb_typeof(p->'conditions') = 'object' then p->'conditions' else '{}'::jsonb end,
    (v_payload->>'hadSevereEvent')::boolean, v_payload->'rowsDigest', (p->>'limitCoveragePct')::numeric,
    v_payload->>'startGeohash5', v_payload->>'endGeohash5', coalesce(v_payload->>'polyline', ''), v_status,
    v_scored->>'reason', v_trace, (v_payload->>'incomplete')::boolean)
  on conflict (user_id, client_trip_id) do nothing
  returning id into v_trip_id;

  -- replay (including a concurrent first upload that lost the race): the stored result, untouched,
  -- even when the trip has since been deleted
  if v_trip_id is null then
    select t.id, t.score, t.status, t.local_day into v_existing
    from public.trips t where t.user_id = v_user and t.client_trip_id = v_client;
    return jsonb_build_object('trip_id', v_existing.id, 'score', v_existing.score, 'status', v_existing.status,
      'day', v_existing.local_day, 'replayed', true);
  end if;

  insert into public.trip_events (trip_id, user_id, client_event_id, category, started_at, duration_ms, lat, lng,
    measured, context, severity, confidence, context_multiplier, deduction, alert_shown, corrected, source, status)
  select v_trip_id, v_user, e->>'id', e->>'category',
    timestamptz 'epoch' + (e->>'startedAt')::bigint * interval '1 millisecond',
    (e->>'durationMs')::int, (e->>'lat')::numeric, (e->>'lng')::numeric,
    case when jsonb_typeof(e->'measured') = 'object' then e->'measured' else '{}'::jsonb end,
    case when jsonb_typeof(e->'context') = 'object' then e->'context' else '{}'::jsonb end,
    (e->>'severity')::numeric, (e->>'q')::numeric, (e->>'contextMultiplier')::numeric,
    case when v_scored_now then coalesce((v_scored->'eventDeductions'->>(e->>'id'))::numeric, 0) end,
    coalesce((e->>'alertShown')::boolean, false), coalesce((e->>'corrected')::boolean, false),
    e->>'source', e->>'status'
  from jsonb_array_elements(v_payload->'events') e;

  perform public.upsert_score_day(v_user, p->'day');
  perform public.upsert_baselines(v_user, p->'baselines');

  return jsonb_build_object('trip_id', v_trip_id, 'score', v_score, 'status', v_status, 'day', v_local_day, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- apply_recompute: after a dispute, a role change or a delete the edge function re-scores in
-- TypeScript and writes exactly these values for one of p_user's trips. p_scored null skips the
-- trip and its events and refreshes only the owner's day rows and baselines (the post-delete case,
-- so a soft-deleted own trip is accepted there and refused for a re-score); p_events rows are
-- { id (trip_events.id), status, deduction }. rows_digest is never touched.
-- ---------------------------------------------------------------------------
create or replace function public.apply_recompute(p_user uuid, p_trip_id uuid, p_scored jsonb, p_events jsonb, p_day jsonb, p_baselines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trip public.trips%rowtype;
  v_rescore boolean;
  v_status text;
  v_score int;
  v_scored_now boolean;
  e jsonb;
  v_ev_id uuid;
  v_ev_status text;
begin
  perform public.require_service_role('apply_recompute');
  if p_user is null then
    raise exception 'apply_recompute requires a user' using errcode = 'invalid_parameter_value';
  end if;
  if p_trip_id is null then
    raise exception 'apply_recompute requires a trip' using errcode = 'invalid_parameter_value';
  end if;

  v_rescore := p_scored is not null and jsonb_typeof(p_scored) <> 'null';
  if not v_rescore then
    if p_events is not null and jsonb_typeof(p_events) <> 'null' then
      raise exception 'apply_recompute events require scored' using errcode = 'invalid_parameter_value';
    end if;
  else
    select status, score into v_status, v_score from public.require_scored_trip('apply_recompute', p_scored);
    v_scored_now := v_status in ('provisional', 'final');
    if p_events is not null and jsonb_typeof(p_events) not in ('null', 'array') then
      raise exception 'apply_recompute events must be a JSON array' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  perform public.require_score_days('apply_recompute', p_day);
  perform public.require_baselines('apply_recompute', p_baselines);

  -- ownership: a trip that is not the user's reads exactly like one that does not exist
  select * into v_trip from public.trips where id = p_trip_id and user_id = p_user for update;
  if not found then
    raise exception 'trip not owned by user' using errcode = 'insufficient_privilege';
  end if;
  if v_rescore and v_trip.deleted_at is not null then
    raise exception 'trip already deleted' using errcode = 'insufficient_privilege';
  end if;

  if v_rescore then
    for e in select * from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) loop
      perform public.require_keys('apply_recompute', e, 'events[].', array['id', 'status', 'deduction']);
      v_ev_status := e->>'status';
      if v_ev_status is null or v_ev_status not in ('scored', 'possible', 'disputed', 'removed') then
        raise exception 'apply_recompute event status is not an event status' using errcode = 'invalid_parameter_value';
      end if;
      begin
        v_ev_id := (e->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'apply_recompute event id is not a uuid' using errcode = 'invalid_parameter_value';
      end;
      update public.trip_events
        set status = v_ev_status,
            deduction = case when v_scored_now then coalesce((e->>'deduction')::numeric, 0) end
        where id = v_ev_id and trip_id = p_trip_id;
      if not found then
        raise exception 'apply_recompute event does not belong to the trip' using errcode = 'invalid_parameter_value';
      end if;
    end loop;

    update public.trips
      set score = v_score,
          status = v_status,
          category_deductions = p_scored->'categoryDeductions',
          exposure = coalesce((p_scored->>'exposure')::numeric, exposure),
          data_quality = coalesce(p_scored->>'dataQuality', data_quality),
          scoring_version = coalesce((p_scored->>'scoringVersion')::int, scoring_version),
          unscored_reason = p_scored->>'reason'
      where id = p_trip_id;
    if not v_scored_now then
      update public.trip_events set deduction = null where trip_id = p_trip_id and deduction is not null;
    end if;
  else
    v_score := v_trip.score;
    v_status := v_trip.status;
  end if;

  perform public.upsert_score_day(p_user, p_day);
  perform public.upsert_baselines(p_user, p_baselines);

  return jsonb_build_object('trip_id', p_trip_id, 'score', v_score, 'status', v_status);
end $$;

-- ---------------------------------------------------------------------------
-- disputes (§9.9). Two guard-rails, both rolling, both counted from event_disputes.created_at:
--   * 3 consuming disputes per 7 days (a dispute counts while it is younger than 7 days);
--   * at most 20 % of the user's scored events over 30 days may be auto-accepted, free ones
--     included, with a floor of one so a new driver can dispute at all.
-- Only events with status `scored` can be disputed (22023 otherwise).
-- "Wrong limit" with a stated posted limit on a speeding event is accepted without spending one
-- of the 3 (it still counts toward the 20 %); on any other category it is an ordinary dispute.
-- Every dispute is recorded whether or not it is applied, with the decision on the row. The
-- rate_limits row `dispute_7d` is only the per-user mutex around check-and-consume.
-- ---------------------------------------------------------------------------
create or replace function public.count_dispute_allowance(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_limit_7d constant int := 3;      -- CONSTANTS.DISPUTES_PER_7D
  v_max_pct_30d constant int := 20;  -- CONSTANTS.DISPUTES_MAX_PCT_30D
  v_used int;
  v_disputed int;
  v_scored int;
  v_max int;
  v_denied text;
begin
  perform public.require_service_role('count_dispute_allowance');
  if p_user is null then
    raise exception 'count_dispute_allowance requires a user' using errcode = 'invalid_parameter_value';
  end if;

  select count(*)::int into v_used from public.event_disputes d
    where d.user_id = p_user and d.consumed_allowance and d.created_at > now() - interval '7 days';
  select count(*)::int into v_disputed from public.event_disputes d
    where d.user_id = p_user and d.auto_accepted and d.created_at > now() - interval '30 days';
  select count(*)::int into v_scored from public.trip_events e join public.trips t on t.id = e.trip_id
    where e.user_id = p_user and t.deleted_at is null and t.status in ('provisional', 'final')
      and e.status in ('scored', 'disputed', 'removed') and e.started_at > now() - interval '30 days';
  -- floor of one: a driver with fewer than five scored events can still dispute one
  v_max := greatest(1, floor(v_scored * v_max_pct_30d / 100.0));
  v_denied := case when v_used >= v_limit_7d then 'allowance_7d' when v_disputed >= v_max then 'allowance_30d' end;

  return jsonb_build_object(
    'used_7d', v_used, 'limit_7d', v_limit_7d, 'remaining_7d', greatest(v_limit_7d - v_used, 0),
    'disputed_30d', v_disputed, 'scored_30d', v_scored, 'max_30d', v_max, 'remaining_30d', greatest(v_max - v_disputed, 0),
    'remaining_allowance', least(greatest(v_limit_7d - v_used, 0), greatest(v_max - v_disputed, 0)),
    'can_auto_accept', v_denied is null, 'denied_reason', v_denied);
end $$;

create or replace function public.record_dispute(p_user uuid, p_event_id uuid, p_reason text, p_note text, p_stated_limit_mph int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trip_id uuid;
  v_trip public.trips%rowtype;
  v_ev public.trip_events%rowtype;
  v_prior public.event_disputes%rowtype;
  v_free boolean;
  v_allow jsonb;
  v_accept boolean;
  v_denied text;
  v_id uuid;
  v_new_status text;
  v_key text;
  v_first_report boolean := false;
begin
  perform public.require_service_role('record_dispute');
  if p_user is null then
    raise exception 'record_dispute requires a user' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('not_driver', 'passenger_phone', 'wrong_limit', 'hazard', 'phone_moved', 'other') then
    raise exception 'record_dispute reason is not a dispute reason' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(p_note) > 500 then
    raise exception 'record_dispute note exceeds 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_stated_limit_mph is not null and p_stated_limit_mph not between 5 and 100 then
    raise exception 'record_dispute stated limit must be between 5 and 100' using errcode = 'invalid_parameter_value';
  end if;

  -- ownership: an event that is not the user's reads exactly like one that does not exist.
  -- Lock order trips -> trip_events -> rate_limits (shared with the other writers).
  select trip_id into v_trip_id from public.trip_events where id = p_event_id and user_id = p_user;
  if not found then
    raise exception 'event not owned by user' using errcode = 'insufficient_privilege';
  end if;
  select * into v_trip from public.trips where id = v_trip_id and user_id = p_user and deleted_at is null for update;
  if not found then
    raise exception 'event not owned by user' using errcode = 'insufficient_privilege';
  end if;
  select * into v_ev from public.trip_events where id = p_event_id and user_id = p_user for update;
  if not found then
    raise exception 'event not owned by user' using errcode = 'insufficient_privilege';
  end if;

  -- a queued retry of a dispute already on record answers with that decision
  select * into v_prior from public.event_disputes where event_id = p_event_id;
  if found then
    v_allow := public.count_dispute_allowance(p_user);
    return jsonb_build_object('dispute_id', v_prior.id, 'trip_id', v_trip_id, 'auto_accepted', v_prior.auto_accepted,
      'consumed', v_prior.consumed_allowance, 'denied_reason', v_prior.denied_reason,
      'remaining_7d', v_allow->'remaining_7d', 'remaining_30d', v_allow->'remaining_30d',
      'remaining_allowance', v_allow->'remaining_allowance', 'event_status', v_ev.status, 'replayed', true);
  end if;

  if v_trip.status not in ('provisional', 'final') then
    raise exception 'trip is not scored' using errcode = 'insufficient_privilege';
  end if;
  -- only a scored event costs anything, so only a scored event can be disputed (a `possible` one
  -- never counted; `disputed`/`removed` ones without a dispute row were removed by the device)
  if v_ev.status <> 'scored' then
    raise exception 'event is not scored' using errcode = 'invalid_parameter_value';
  end if;
  if v_trip.ended_at < now() - interval '14 days' then
    raise exception 'dispute window closed' using errcode = 'invalid_parameter_value';
  end if;

  v_free := p_reason = 'wrong_limit' and p_stated_limit_mph is not null and v_ev.category = 'speeding';

  -- the user's mutex row: a concurrent dispute cannot check the allowance before this one is recorded
  insert into public.rate_limits (user_id, key) values (p_user, 'dispute_7d') on conflict (user_id, key) do nothing;
  perform 1 from public.rate_limits where user_id = p_user and key = 'dispute_7d' for update;
  v_allow := public.count_dispute_allowance(p_user);
  v_denied := case
    when not v_free and (v_allow->>'used_7d')::int >= (v_allow->>'limit_7d')::int then 'allowance_7d'
    when (v_allow->>'disputed_30d')::int >= (v_allow->>'max_30d')::int then 'allowance_30d'
  end;
  v_accept := v_denied is null;

  -- wrong-limit reports on speeding events aggregate per ~150 m geohash cell whether or not the
  -- dispute was applied; a user counts once per cell
  if p_reason = 'wrong_limit' and v_ev.category = 'speeding' and v_ev.lat is not null and v_ev.lng is not null then
    v_key := 'gh7:' || extensions.st_geohash(extensions.st_setsrid(extensions.st_makepoint(v_ev.lng::float8, v_ev.lat::float8), 4326), 7);
    v_first_report := not exists (select 1 from public.event_disputes d where d.user_id = p_user and d.segment_key = v_key);
  end if;

  insert into public.event_disputes (event_id, user_id, reason, note, stated_limit_mph, auto_accepted, consumed_allowance, denied_reason, segment_key)
  values (p_event_id, p_user, p_reason, p_note, p_stated_limit_mph, v_accept, v_accept and not v_free, v_denied, v_key)
  returning id into v_id;

  if v_accept then
    -- the recompute that follows (apply_recompute) turns this into `removed`
    update public.trip_events set status = 'disputed' where id = p_event_id;
    v_new_status := 'disputed';
  else
    v_new_status := v_ev.status;
  end if;

  if v_first_report then
    insert into public.map_feedback (segment_key, reports, stated_limits_mph)
    values (v_key, 1, case when p_stated_limit_mph is null then '{}'::int[] else array[p_stated_limit_mph] end)
    on conflict (segment_key) do update set
      reports = public.map_feedback.reports + 1,
      stated_limits_mph = case
        when p_stated_limit_mph is null or cardinality(public.map_feedback.stated_limits_mph) >= 200 then public.map_feedback.stated_limits_mph
        else array_append(public.map_feedback.stated_limits_mph, p_stated_limit_mph) end;
  end if;

  v_allow := public.count_dispute_allowance(p_user);
  return jsonb_build_object('dispute_id', v_id, 'trip_id', v_trip_id, 'auto_accepted', v_accept,
    'consumed', v_accept and not v_free, 'denied_reason', v_denied,
    'remaining_7d', v_allow->'remaining_7d', 'remaining_30d', v_allow->'remaining_30d',
    'remaining_allowance', v_allow->'remaining_allowance', 'event_status', v_new_status, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- role change: a user-stated passenger/other role is authoritative (§9.7) and unscores the trip;
-- driver leaves scoring to the recompute that follows.
-- ---------------------------------------------------------------------------
create or replace function public.set_trip_role_row(p_user uuid, p_trip_id uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trip public.trips%rowtype;
begin
  perform public.require_service_role('set_trip_role_row');
  if p_user is null then
    raise exception 'set_trip_role_row requires a user' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('driver', 'passenger', 'other') then
    raise exception 'set_trip_role_row role is not a trip role' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and user_id = p_user and deleted_at is null for update;
  if not found then
    raise exception 'trip not owned by user' using errcode = 'insufficient_privilege';
  end if;

  if p_role = 'driver' then
    update public.trips set role = 'driver', role_source = 'manual', role_confidence = null where id = p_trip_id;
  else
    update public.trips
      set role = p_role, role_source = 'manual', role_confidence = null,
          status = 'unscored', score = null, unscored_reason = 'passenger', category_deductions = '{}'::jsonb
      where id = p_trip_id;
    update public.trip_events set deduction = null where trip_id = p_trip_id and deduction is not null;
  end if;

  select * into v_trip from public.trips where id = p_trip_id;
  return jsonb_build_object('trip_id', v_trip.id, 'role', v_trip.role, 'status', v_trip.status, 'score', v_trip.score);
end $$;

-- ---------------------------------------------------------------------------
-- delete: soft (deleted_at); events and disputes stay for audit and the owner policies hide them.
-- The trace object is removed through the Storage API by the edge function before this call
-- (storage refuses direct row deletes and a row delete would orphan the blob); the key that was
-- stored is returned for that call and the column is cleared here. A repeat on an already-deleted
-- own trip replays (the queued delete-trip item may be retried after a lost response).
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_trip(p_user uuid, p_trip_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trip public.trips%rowtype;
begin
  perform public.require_service_role('soft_delete_trip');
  if p_user is null then
    raise exception 'soft_delete_trip requires a user' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and user_id = p_user for update;
  if not found then
    raise exception 'trip not owned by user' using errcode = 'insufficient_privilege';
  end if;
  if v_trip.deleted_at is not null then
    return jsonb_build_object('trip_id', p_trip_id, 'trace_path', null, 'replayed', true);
  end if;
  update public.trips set deleted_at = now(), trace_path = null where id = p_trip_id;
  return jsonb_build_object('trip_id', p_trip_id, 'trace_path', v_trip.trace_path, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- storage: the private traces bucket, owner-prefixed keys <uid>/<clientTripId>.bin.gz
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('traces', 'traces', false, 5242880, array['application/gzip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy traces_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'traces' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy traces_select_own on storage.objects for select to authenticated
  using (bucket_id = 'traces' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy traces_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'traces' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- function grants: the writers are service-role only; helpers and triggers are callable by no client
-- ---------------------------------------------------------------------------
revoke all on function public.sync_trip_local_day() from public, anon, authenticated;
revoke all on function public.require_service_role(text) from public, anon, authenticated;
revoke all on function public.require_keys(text, jsonb, text, text[]) from public, anon, authenticated;
revoke all on function public.require_type(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.require_scored_trip(text, jsonb) from public, anon, authenticated;
revoke all on function public.require_score_days(text, jsonb) from public, anon, authenticated;
revoke all on function public.require_baselines(text, jsonb) from public, anon, authenticated;
revoke all on function public.upsert_score_day(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.upsert_baselines(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.apply_trip(jsonb) from public, anon, authenticated;
revoke all on function public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.count_dispute_allowance(uuid) from public, anon, authenticated;
revoke all on function public.record_dispute(uuid, uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.set_trip_role_row(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.soft_delete_trip(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_trip(jsonb) to service_role;
grant execute on function public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.count_dispute_allowance(uuid) to service_role;
grant execute on function public.record_dispute(uuid, uuid, text, text, int) to service_role;
grant execute on function public.set_trip_role_row(uuid, uuid, text) to service_role;
grant execute on function public.soft_delete_trip(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: default deny; owner-only reads; deleted trips (their events and disputes) hidden from the owner
-- ---------------------------------------------------------------------------
alter table public.trips enable row level security;
alter table public.trip_events enable row level security;
alter table public.event_disputes enable row level security;
alter table public.score_daily enable row level security;
alter table public.baselines enable row level security;
alter table public.map_feedback enable row level security;
alter table public.rate_limits enable row level security;

create policy trips_select_own on public.trips for select to authenticated
  using (user_id = (select auth.uid()) and deleted_at is null);
create policy trip_events_select_own on public.trip_events for select to authenticated
  using (user_id = (select auth.uid())
    and exists (select 1 from public.trips t where t.id = trip_events.trip_id and t.user_id = (select auth.uid()) and t.deleted_at is null));
create policy event_disputes_select_own on public.event_disputes for select to authenticated
  using (user_id = (select auth.uid())
    and exists (select 1 from public.trip_events e join public.trips t on t.id = e.trip_id
      where e.id = event_disputes.event_id and t.user_id = (select auth.uid()) and t.deleted_at is null));
create policy score_daily_select_own on public.score_daily for select to authenticated
  using (user_id = (select auth.uid()));
create policy baselines_select_own on public.baselines for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- table grants: read-only for the owner; no client write path anywhere in this migration.
-- The revoke is scoped to the tables created here: a schema-wide `revoke all on all tables` would
-- strip 0001's grants, which its own test file asserts exactly.
-- ---------------------------------------------------------------------------
revoke all on public.trips, public.trip_events, public.event_disputes, public.score_daily, public.baselines,
  public.map_feedback, public.rate_limits from anon, authenticated;
grant select on public.trips to authenticated;
grant select on public.trip_events to authenticated;
grant select on public.event_disputes to authenticated;
grant select on public.score_daily to authenticated;
grant select on public.baselines to authenticated;
