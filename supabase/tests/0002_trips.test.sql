-- pgTAP is a test-only dependency: install it outside the test transaction so it
-- persists in the local database without ever appearing in a migration.
create extension if not exists pgtap with schema extensions;

begin;
select plan(609);

-- ---------------------------------------------------------------------------
-- fixtures (run as the migration owner): six auth users, payload builders in
-- pg_temp shaped like FinalizeTripPayload at HEAD (src/data/sync/payload.ts),
-- and the apply_trip envelopes the service-role section applies. Trip times are
-- anchored to fixed hours of Los Angeles days so day-boundary assertions cannot
-- drift with the wall clock. B's trace object exists so A's storage attempts
-- have something to miss.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ta@example.com', '{"display_name":"Ava"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'tb@example.com', '{"display_name":"Ben"}'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'tc@example.com', '{"display_name":"Cy"}'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'td@example.com', '{"display_name":"Dee"}'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'te@example.com', '{"display_name":"Eli"}'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'tf@example.com', '{"display_name":"Fay"}'),
  ('99999999-9999-4999-8999-999999999999', 'tg@example.com', '{"display_name":"Gus"}'),
  -- R owns only the trace-retention fixtures; no other assertion in this file mentions R, so the
  -- expire_trace_objects section can write trips and objects without moving any other count
  ('11111111-1111-4111-8111-111111111111', 'tr@example.com', '{"display_name":"Ro"}');

-- calendar day N days ago in Los Angeles, and a fixed hour of that day
create function pg_temp.la_day(p_days_ago int) returns date
language sql as $$ select (now() at time zone 'America/Los_Angeles')::date - p_days_ago $$;
create function pg_temp.at_la(p_days_ago int, p_hour int) returns timestamptz
language sql as $$ select (pg_temp.la_day(p_days_ago)::timestamp + make_interval(hours => p_hour)) at time zone 'America/Los_Angeles' $$;

create function pg_temp.events(p_prefix text, p_n int, p_started_ms bigint, p_status text) returns jsonb
language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p_prefix || i, 'category', 'speeding', 'startedAt', p_started_ms + i * 10000,
    'durationS', 8.5, 'durationMs', 8500, 'q', 0.9, 'corrected', false, 'status', p_status,
    'measured', jsonb_build_object('speedMps', 21.0, 'limitMps', 15.6, 'overMps', 5.4),
    'context', jsonb_build_object('night', false, 'precipitation', false),
    'contextMultiplier', 1, 'severity', 1, 'deduction', 2,
    'lat', 47.606, 'lng', -122.332, 'alertShown', true, 'source', 'gnss') order by i), '[]'::jsonb)
  from generate_series(1, p_n) i
$$;

create function pg_temp.deductions(p_prefix text, p_n int) returns jsonb
language sql as $$
  select coalesce(jsonb_object_agg(p_prefix || i, 2), '{}'::jsonb) from generate_series(1, p_n) i
$$;

create function pg_temp.payload(p_client text, p_started timestamptz, p_ended timestamptz, p_n int, p_trace boolean) returns jsonb
language sql as $$
  select jsonb_build_object(
    'clientTripId', p_client,
    'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
    'endedAt', floor(extract(epoch from p_ended) * 1000)::bigint,
    'tz', 'America/Los_Angeles',
    'distanceM', 12500.5, 'durationS', 900,
    'role', 'driver', 'roleConfidence', null, 'roleSource', 'manual',
    'mode', 'mounted', 'cameraSession', false,
    'provisional', jsonb_build_object('score', 74, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":25,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', pg_temp.deductions('ev-', p_n), 'scoringVersion', 1),
    'events', pg_temp.events('ev-', p_n, floor(extract(epoch from p_started) * 1000)::bigint, 'scored'),
    'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true,
      'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
    'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb',
    'polyline', '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    'tracePath', case when p_trace then p_client || '.bin.gz' end,
    'hadSevereEvent', false,
    'incomplete', false)
$$;

create function pg_temp.day_row(p_day date, p_lts int) returns jsonb
language sql as $$
  select jsonb_build_object('day', p_day, 'longTermScore', p_lts, 'band', 'good', 'provisional', false,
    'safeDay', false, 'goodDay', false, 'phoneFreeDay', false, 'cameraDay', false,
    'exposure', 0, 'drivingS', 0, 'tripsScored', 0, 'severeEvents', 0)
$$;

create function pg_temp.envelope(p_user uuid, p_payload jsonb, p_score int, p_status text, p_reason text default null) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', p_payload,
    'scored', jsonb_build_object('score', p_score, 'status', p_status, 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":26,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', p_payload->'provisional'->'eventDeductions', 'scoringVersion', 1)
      || case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_reason) end,
    'conditions', '{"night": false, "precipitation": false}'::jsonb,
    'day', jsonb_build_object(
      'day', (to_timestamp((p_payload->>'startedAt')::bigint / 1000.0) at time zone 'America/Los_Angeles')::date,
      'longTermScore', 78, 'band', 'getting_there', 'provisional', false,
      'safeDay', false, 'goodDay', true, 'phoneFreeDay', true, 'cameraDay', false,
      'exposure', 1.25, 'drivingS', 900, 'tripsScored', 1, 'severeEvents', 0),
    'baselines', jsonb_build_object('medians', '{"speeding": 1.2, "phone": 0}'::jsonb))
$$;

create function pg_temp.trip(p_user uuid, p_client text) returns uuid
language sql as $$ select id from public.trips where user_id = p_user and client_trip_id = p_client $$;

create function pg_temp.ev(p_user uuid, p_client text, p_ev text) returns uuid
language sql as $$
  select e.id from public.trip_events e join public.trips t on t.id = e.trip_id
  where t.user_id = p_user and t.client_trip_id = p_client and e.client_event_id = p_ev
$$;

create temp table fx (name text primary key, p jsonb not null);
insert into fx values
  ('a1', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 20, true), 74, 'final')),
  ('a1-replay', jsonb_set(pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 20, true), 12, 'final'),
    '{day,longTermScore}', '55')),
  ('a-old', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-old', pg_temp.at_la(20, 10), pg_temp.at_la(20, 10) + interval '15 minutes', 1, true), 90, 'final')),
  ('a-hostile', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jsonb_set(pg_temp.payload('a-trip-hostile', pg_temp.at_la(2, 12), pg_temp.at_la(2, 12) + interval '15 minutes', 4, true),
      '{tracePath}', '"../bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/evil.bin.gz"'), 80, 'final')),
  ('a-unscored', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-unscored', pg_temp.at_la(2, 14), pg_temp.at_la(2, 14) + interval '2 minutes', 3, false), null, 'unscored', 'too_short')),
  -- a user id smuggled inside the device payload must be ignored: the trip lands under the envelope's userId
  ('a-uid', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-uid', pg_temp.at_la(2, 15), pg_temp.at_la(2, 15) + interval '5 minutes', 0, false)
      || '{"userId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "user_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}'::jsonb, 60, 'final')),
  ('a-big', pg_temp.envelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pg_temp.payload('a-trip-big', pg_temp.at_la(1, 10), pg_temp.at_la(1, 10) + interval '15 minutes', 501, false), 50, 'final')),
  ('b1', pg_temp.envelope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    pg_temp.payload('a-trip-1', pg_temp.at_la(1, 10), pg_temp.at_la(1, 10) + interval '15 minutes', 2, true), 88, 'final')),
  -- a uuid-shaped client id (what the device generates) and a day array that also carries today's row
  ('b2', (select jsonb_set(e, '{day}', jsonb_build_array(e->'day', pg_temp.day_row(pg_temp.la_day(0), 80)))
    from (select pg_temp.envelope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pg_temp.payload('7e1a3f60-2b3c-4d5e-8f90-1234567890ab', pg_temp.at_la(2, 9), pg_temp.at_la(2, 9) + interval '10 minutes', 2, false), 85, 'final') e) s)),
  ('c1', pg_temp.envelope('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    pg_temp.payload('c-trip-1', pg_temp.at_la(3, 10), pg_temp.at_la(3, 10) + interval '15 minutes', 10, false), 70, 'final')),
  ('d1', pg_temp.envelope('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    pg_temp.payload('d-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 30, false), 75, 'final')),
  ('e1', pg_temp.envelope('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    pg_temp.payload('e-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 50, false), 70, 'final')),
  -- F's first event is a phone event: a stated limit on it is not the free speeding path
  ('f1', pg_temp.envelope('ffffffff-ffff-4fff-8fff-ffffffffffff',
    jsonb_set(pg_temp.payload('f-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 10, false),
      '{events,0,category}', '"phone"'), 70, 'final')),
  -- G is a new driver: three scored events and one `possible` event on one trip
  ('g1', pg_temp.envelope('99999999-9999-4999-8999-999999999999',
    jsonb_set(pg_temp.payload('g-trip-1', pg_temp.at_la(2, 10), pg_temp.at_la(2, 10) + interval '15 minutes', 4, false),
      '{events,3,status}', '"possible"'), 70, 'final'));
grant select on fx to service_role;
grant execute on function pg_temp.trip(uuid, text), pg_temp.ev(uuid, text, text), pg_temp.la_day(int), pg_temp.at_la(int, int), pg_temp.day_row(date, int)
  to service_role, authenticated;

-- B's trace object, written the way the Storage API writes it (owner-prefixed key)
insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/a-trip-1.bin.gz', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
-- storage's protect_objects_delete statement trigger refuses every direct delete unless this
-- flag is set; the delete tests below need it so the policy, not the trigger, decides the rows
select set_config('storage.allow_delete_query', 'true', true);

-- ---------------------------------------------------------------------------
-- schema-level posture: RLS on every table, exact policy sets, explicit grants
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.trips'::regclass), true, 'RLS enabled on trips');
select is((select relrowsecurity from pg_class where oid = 'public.trip_events'::regclass), true, 'RLS enabled on trip_events');
select is((select relrowsecurity from pg_class where oid = 'public.event_disputes'::regclass), true, 'RLS enabled on event_disputes');
select is((select relrowsecurity from pg_class where oid = 'public.score_daily'::regclass), true, 'RLS enabled on score_daily');
select is((select relrowsecurity from pg_class where oid = 'public.baselines'::regclass), true, 'RLS enabled on baselines');
select is((select relrowsecurity from pg_class where oid = 'public.map_feedback'::regclass), true, 'RLS enabled on map_feedback');
select is((select relrowsecurity from pg_class where oid = 'public.rate_limits'::regclass), true, 'RLS enabled on rate_limits');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'no table in public is missing RLS');

select policies_are('public', 'trips', array['trips_select_own']::name[], 'trips has exactly one policy');
select policies_are('public', 'trip_events', array['trip_events_select_own']::name[], 'trip_events has exactly one policy');
select policies_are('public', 'event_disputes', array['event_disputes_select_own']::name[], 'event_disputes has exactly one policy');
select policies_are('public', 'score_daily', array['score_daily_select_own']::name[], 'score_daily has exactly one policy');
select policies_are('public', 'baselines', array['baselines_select_own']::name[], 'baselines has exactly one policy');
select policies_are('public', 'map_feedback', '{}'::name[], 'map_feedback has no policies (server only)');
select policies_are('public', 'rate_limits', '{}'::name[], 'rate_limits has no policies (server only)');

select table_privs_are('public', 'trips', 'anon', '{}'::name[], 'anon has no privileges on trips');
select table_privs_are('public', 'trips', 'authenticated', array['SELECT']::name[], 'authenticated may only select trips');
select table_privs_are('public', 'trip_events', 'anon', '{}'::name[], 'anon has no privileges on trip_events');
select table_privs_are('public', 'trip_events', 'authenticated', array['SELECT']::name[], 'authenticated may only select trip_events');
select table_privs_are('public', 'event_disputes', 'anon', '{}'::name[], 'anon has no privileges on event_disputes');
select table_privs_are('public', 'event_disputes', 'authenticated', array['SELECT']::name[], 'authenticated may only select event_disputes');
select table_privs_are('public', 'score_daily', 'anon', '{}'::name[], 'anon has no privileges on score_daily');
select table_privs_are('public', 'score_daily', 'authenticated', array['SELECT']::name[], 'authenticated may only select score_daily');
select table_privs_are('public', 'baselines', 'anon', '{}'::name[], 'anon has no privileges on baselines');
select table_privs_are('public', 'baselines', 'authenticated', array['SELECT']::name[], 'authenticated may only select baselines');
select table_privs_are('public', 'map_feedback', 'anon', '{}'::name[], 'anon has no privileges on map_feedback');
select table_privs_are('public', 'map_feedback', 'authenticated', '{}'::name[], 'authenticated has no privileges on map_feedback');
select table_privs_are('public', 'rate_limits', 'anon', '{}'::name[], 'anon has no privileges on rate_limits');
select table_privs_are('public', 'rate_limits', 'authenticated', '{}'::name[], 'authenticated has no privileges on rate_limits');

-- server-owned columns are read-only for clients (trips has no client write path at all)
select column_privs_are('public', 'trips', 'id', 'authenticated', array['SELECT']::name[], 'trips.id is read-only for clients');
select column_privs_are('public', 'trips', 'user_id', 'authenticated', array['SELECT']::name[], 'trips.user_id is read-only for clients');
select column_privs_are('public', 'trips', 'score', 'authenticated', array['SELECT']::name[], 'trips.score is read-only for clients');
select column_privs_are('public', 'trips', 'status', 'authenticated', array['SELECT']::name[], 'trips.status is read-only for clients');
select column_privs_are('public', 'trips', 'data_quality', 'authenticated', array['SELECT']::name[], 'trips.data_quality is read-only for clients');
select column_privs_are('public', 'trips', 'scoring_version', 'authenticated', array['SELECT']::name[], 'trips.scoring_version is read-only for clients');
select column_privs_are('public', 'trips', 'category_deductions', 'authenticated', array['SELECT']::name[], 'trips.category_deductions is read-only for clients');
select column_privs_are('public', 'trips', 'incomplete', 'authenticated', array['SELECT']::name[], 'trips.incomplete is read-only for clients');
select column_privs_are('public', 'trips', 'deleted_at', 'authenticated', array['SELECT']::name[], 'trips.deleted_at is read-only for clients');
select column_privs_are('public', 'trips', 'trace_path', 'authenticated', array['SELECT']::name[], 'trips.trace_path is read-only for clients');
select column_privs_are('public', 'trips', 'rows_digest', 'authenticated', array['SELECT']::name[], 'trips.rows_digest is read-only for clients');
select column_privs_are('public', 'trips', 'role', 'authenticated', array['SELECT']::name[], 'trips.role changes only through the role writer');
select column_privs_are('public', 'trips', 'created_at', 'authenticated', array['SELECT']::name[], 'trips.created_at is read-only for clients');
select column_privs_are('public', 'trips', 'updated_at', 'authenticated', array['SELECT']::name[], 'trips.updated_at is read-only for clients');
select column_privs_are('public', 'trip_events', 'status', 'authenticated', array['SELECT']::name[], 'trip_events.status is read-only for clients');
select column_privs_are('public', 'trip_events', 'deduction', 'authenticated', array['SELECT']::name[], 'trip_events.deduction is read-only for clients');
select column_privs_are('public', 'event_disputes', 'auto_accepted', 'authenticated', array['SELECT']::name[], 'event_disputes.auto_accepted is read-only for clients');
select column_privs_are('public', 'event_disputes', 'consumed_allowance', 'authenticated', array['SELECT']::name[], 'event_disputes.consumed_allowance is read-only for clients');
select column_privs_are('public', 'score_daily', 'long_term_score', 'authenticated', array['SELECT']::name[], 'score_daily.long_term_score is read-only for clients');
select column_privs_are('public', 'baselines', 'medians', 'authenticated', array['SELECT']::name[], 'baselines.medians is read-only for clients');

-- indexes: the owner column every policy filters on, every FK a cascade follows
select has_index('public', 'trips', 'trips_user_client_trip_key', 'trips unique per (user, client_trip_id)');
select has_index('public', 'trips', 'trips_user_started_idx', 'trips indexed by owner and start time');
select has_index('public', 'trip_events', 'trip_events_user_started_idx', 'trip_events indexed by owner and start time');
select has_index('public', 'trip_events', 'trip_events_trip_client_event_key', 'trip_events unique per (trip, client_event_id); leads on trip_id for the cascade');
select has_trigger('public', 'trips', 'trips_local_day', 'trips.local_day is derived from started_at and tz');
select has_index('public', 'event_disputes', 'event_disputes_event_id_key', 'event_disputes unique per event (cascade index)');
select has_index('public', 'event_disputes', 'event_disputes_user_created_idx', 'event_disputes indexed by owner and time (the rolling counts)');
select has_index('public', 'score_daily', 'score_daily_pkey', 'score_daily keyed by (user, day)');
select has_index('public', 'baselines', 'baselines_pkey', 'baselines keyed by user');
select has_index('public', 'rate_limits', 'rate_limits_pkey', 'rate_limits keyed by (user, key)');

-- updated_at everywhere, maintained by touch_updated_at
select has_column('public', 'trips', 'updated_at', 'trips carries updated_at');
select has_trigger('public', 'trips', 'trips_touch', 'trips.updated_at is maintained');
select has_column('public', 'trip_events', 'updated_at', 'trip_events carries updated_at');
select has_trigger('public', 'trip_events', 'trip_events_touch', 'trip_events.updated_at is maintained');
select has_column('public', 'event_disputes', 'updated_at', 'event_disputes carries updated_at');
select has_trigger('public', 'event_disputes', 'event_disputes_touch', 'event_disputes.updated_at is maintained');
select has_column('public', 'score_daily', 'updated_at', 'score_daily carries updated_at');
select has_trigger('public', 'score_daily', 'score_daily_touch', 'score_daily.updated_at is maintained');
select has_column('public', 'baselines', 'updated_at', 'baselines carries updated_at');
select has_trigger('public', 'baselines', 'baselines_touch', 'baselines.updated_at is maintained');
select has_column('public', 'map_feedback', 'updated_at', 'map_feedback carries updated_at');
select has_trigger('public', 'map_feedback', 'map_feedback_touch', 'map_feedback.updated_at is maintained');
select has_column('public', 'rate_limits', 'updated_at', 'rate_limits carries updated_at');
select has_trigger('public', 'rate_limits', 'rate_limits_touch', 'rate_limits.updated_at is maintained');
select has_column('public', 'trips', 'incomplete', 'trips carries the crash-recovery flag');
select has_column('public', 'trips', 'rows_digest', 'trips carries the re-score inputs');

-- bounds: every text column length-checked, every enum-like column checked, every jsonb typed and capped
select col_has_check('public', 'trips', 'client_trip_id', 'trips.client_trip_id is pattern-bounded');
select col_has_check('public', 'trips', 'tz', 'trips.tz is length-bounded');
select col_has_check('public', 'trips', 'role', 'trips.role is an enum check');
select col_has_check('public', 'trips', 'role_source', 'trips.role_source is length-bounded');
select col_has_check('public', 'trips', 'mode', 'trips.mode is an enum check');
select col_has_check('public', 'trips', 'status', 'trips.status is an enum check');
select col_has_check('public', 'trips', 'data_quality', 'trips.data_quality is an enum check');
select col_has_check('public', 'trips', 'unscored_reason', 'trips.unscored_reason is an enum check');
select col_has_check('public', 'trips', 'score', 'trips.score is range-checked');
select col_has_check('public', 'trips', 'distance_m', 'trips.distance_m is range-checked');
select col_has_check('public', 'trips', 'category_deductions', 'trips.category_deductions is type- and size-checked');
select col_has_check('public', 'trips', 'conditions', 'trips.conditions is type- and size-checked');
select col_has_check('public', 'trips', 'rows_digest', 'trips.rows_digest is type- and size-checked');
select col_has_check('public', 'trips', 'polyline', 'trips.polyline is size-bounded');
select col_has_check('public', 'trips', 'start_label', 'trips.start_label is length-bounded');
select col_has_check('public', 'trips', 'end_label', 'trips.end_label is length-bounded');
select col_has_check('public', 'trips', 'start_geohash5', 'trips.start_geohash5 is length-checked');
select col_has_check('public', 'trips', 'trace_path', 'trips.trace_path is length-bounded and derivation-checked');
select col_has_check('public', 'trips', 'notes', 'trips.notes is length-bounded');
select col_has_check('public', 'trip_events', 'client_event_id', 'trip_events.client_event_id is length-bounded');
select col_has_check('public', 'trip_events', 'category', 'trip_events.category is an enum check');
select col_has_check('public', 'trip_events', 'status', 'trip_events.status is an enum check');
select col_has_check('public', 'trip_events', 'source', 'trip_events.source is an enum check');
select col_has_check('public', 'trip_events', 'measured', 'trip_events.measured is type- and size-checked');
select col_has_check('public', 'trip_events', 'context', 'trip_events.context is type- and size-checked');
select col_has_check('public', 'trip_events', 'confidence', 'trip_events.confidence is range-checked');
select col_has_check('public', 'trip_events', 'context_multiplier', 'trip_events.context_multiplier is range-checked');
select col_has_check('public', 'trip_events', 'severity', 'trip_events.severity is range-checked');
select col_has_check('public', 'trip_events', 'lat', 'trip_events.lat is range-checked');
select col_has_check('public', 'trip_events', 'lng', 'trip_events.lng is range-checked');
select col_has_check('public', 'event_disputes', 'reason', 'event_disputes.reason is an enum check');
select col_has_check('public', 'event_disputes', 'note', 'event_disputes.note is length-bounded');
select col_has_check('public', 'event_disputes', 'stated_limit_mph', 'event_disputes.stated_limit_mph is range-checked');
select col_has_check('public', 'event_disputes', 'denied_reason', 'event_disputes.denied_reason is an enum check');
select col_has_check('public', 'event_disputes', 'segment_key', 'event_disputes.segment_key is length-bounded');
select col_has_check('public', 'score_daily', 'band', 'score_daily.band is an enum check');
select col_has_check('public', 'score_daily', 'long_term_score', 'score_daily.long_term_score is range-checked');
select col_has_check('public', 'baselines', 'medians', 'baselines.medians is type- and size-checked');
select col_has_check('public', 'map_feedback', 'segment_key', 'map_feedback.segment_key is length-bounded');
select col_has_check('public', 'map_feedback', 'status', 'map_feedback.status is an enum check');
select col_has_check('public', 'rate_limits', 'key', 'rate_limits.key is length-bounded');
select col_type_is('public', 'trip_events', 'lat', 'numeric(8,3)', 'trip_events.lat is stored at 3 dp');
select col_type_is('public', 'trip_events', 'lng', 'numeric(8,3)', 'trip_events.lng is stored at 3 dp');

-- function privileges: the writers are service-role only; helpers are callable by nobody client-side
select is(has_function_privilege('anon', 'public.apply_trip(jsonb)', 'execute'), false, 'anon cannot execute apply_trip');
select is(has_function_privilege('authenticated', 'public.apply_trip(jsonb)', 'execute'), false, 'authenticated cannot execute apply_trip');
select is(has_function_privilege('service_role', 'public.apply_trip(jsonb)', 'execute'), true, 'service_role can execute apply_trip');
select is(has_function_privilege('anon', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), false, 'anon cannot execute apply_recompute');
select is(has_function_privilege('authenticated', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), false, 'authenticated cannot execute apply_recompute');
select is(has_function_privilege('service_role', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), true, 'service_role can execute apply_recompute');
select is(has_function_privilege('anon', 'public.count_dispute_allowance(uuid)', 'execute'), false, 'anon cannot execute count_dispute_allowance');
select is(has_function_privilege('authenticated', 'public.count_dispute_allowance(uuid)', 'execute'), false, 'authenticated cannot execute count_dispute_allowance');
select is(has_function_privilege('service_role', 'public.count_dispute_allowance(uuid)', 'execute'), true, 'service_role can execute count_dispute_allowance');
select is(has_function_privilege('anon', 'public.record_dispute(uuid, uuid, text, text, int)', 'execute'), false, 'anon cannot execute record_dispute');
select is(has_function_privilege('authenticated', 'public.record_dispute(uuid, uuid, text, text, int)', 'execute'), false, 'authenticated cannot execute record_dispute');
select is(has_function_privilege('service_role', 'public.record_dispute(uuid, uuid, text, text, int)', 'execute'), true, 'service_role can execute record_dispute');
select is(has_function_privilege('anon', 'public.set_trip_role_row(uuid, uuid, text)', 'execute'), false, 'anon cannot execute set_trip_role_row');
select is(has_function_privilege('authenticated', 'public.set_trip_role_row(uuid, uuid, text)', 'execute'), false, 'authenticated cannot execute set_trip_role_row');
select is(has_function_privilege('service_role', 'public.set_trip_role_row(uuid, uuid, text)', 'execute'), true, 'service_role can execute set_trip_role_row');
select is(has_function_privilege('anon', 'public.soft_delete_trip(uuid, uuid)', 'execute'), false, 'anon cannot execute soft_delete_trip');
select is(has_function_privilege('authenticated', 'public.soft_delete_trip(uuid, uuid)', 'execute'), false, 'authenticated cannot execute soft_delete_trip');
select is(has_function_privilege('service_role', 'public.soft_delete_trip(uuid, uuid)', 'execute'), true, 'service_role can execute soft_delete_trip');
select is(has_function_privilege('anon', 'public.expire_trace_objects(interval, int)', 'execute'), false, 'anon cannot execute expire_trace_objects');
select is(has_function_privilege('authenticated', 'public.expire_trace_objects(interval, int)', 'execute'), false, 'authenticated cannot execute expire_trace_objects');
select is(has_function_privilege('service_role', 'public.expire_trace_objects(interval, int)', 'execute'), true, 'service_role can execute expire_trace_objects');
select is(has_function_privilege('authenticated', 'public.upsert_score_day(uuid, jsonb)', 'execute'), false, 'authenticated cannot call upsert_score_day');
select is(has_function_privilege('authenticated', 'public.upsert_baselines(uuid, jsonb)', 'execute'), false, 'authenticated cannot call upsert_baselines');
select is(has_function_privilege('anon', 'public.upsert_score_day(uuid, jsonb)', 'execute'), false, 'anon cannot call upsert_score_day');
select is(has_function_privilege('anon', 'public.upsert_baselines(uuid, jsonb)', 'execute'), false, 'anon cannot call upsert_baselines');
select is(has_function_privilege('authenticated', 'public.require_service_role(text)', 'execute'), false, 'authenticated cannot call require_service_role');
select is(has_function_privilege('anon', 'public.require_service_role(text)', 'execute'), false, 'anon cannot call require_service_role');
select is(has_function_privilege('authenticated', 'public.require_scored_trip(text, jsonb)', 'execute'), false, 'authenticated cannot call require_scored_trip');
select is(has_function_privilege('anon', 'public.require_scored_trip(text, jsonb)', 'execute'), false, 'anon cannot call require_scored_trip');

-- definer mechanism every writer depends on
select is_definer('public', 'apply_trip', array['jsonb']::name[], 'apply_trip is security definer');
select function_owner_is('public', 'apply_trip', array['jsonb']::name[], 'postgres', 'apply_trip owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.apply_trip(jsonb)'::regprocedure), array['search_path=public'], 'apply_trip pins search_path');
select is_definer('public', 'apply_recompute', array['uuid', 'uuid', 'jsonb', 'jsonb', 'jsonb', 'jsonb']::name[], 'apply_recompute is security definer');
select function_owner_is('public', 'apply_recompute', array['uuid', 'uuid', 'jsonb', 'jsonb', 'jsonb', 'jsonb']::name[], 'postgres', 'apply_recompute owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)'::regprocedure), array['search_path=public'], 'apply_recompute pins search_path');
select is_definer('public', 'count_dispute_allowance', array['uuid']::name[], 'count_dispute_allowance is security definer');
select function_owner_is('public', 'count_dispute_allowance', array['uuid']::name[], 'postgres', 'count_dispute_allowance owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.count_dispute_allowance(uuid)'::regprocedure), array['search_path=public'], 'count_dispute_allowance pins search_path');
select is_definer('public', 'record_dispute', array['uuid', 'uuid', 'text', 'text', 'integer']::name[], 'record_dispute is security definer');
select function_owner_is('public', 'record_dispute', array['uuid', 'uuid', 'text', 'text', 'integer']::name[], 'postgres', 'record_dispute owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.record_dispute(uuid, uuid, text, text, int)'::regprocedure), array['search_path=public'], 'record_dispute pins search_path');
select is_definer('public', 'set_trip_role_row', array['uuid', 'uuid', 'text']::name[], 'set_trip_role_row is security definer');
select function_owner_is('public', 'set_trip_role_row', array['uuid', 'uuid', 'text']::name[], 'postgres', 'set_trip_role_row owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.set_trip_role_row(uuid, uuid, text)'::regprocedure), array['search_path=public'], 'set_trip_role_row pins search_path');
select is_definer('public', 'soft_delete_trip', array['uuid', 'uuid']::name[], 'soft_delete_trip is security definer');
select function_owner_is('public', 'soft_delete_trip', array['uuid', 'uuid']::name[], 'postgres', 'soft_delete_trip owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.soft_delete_trip(uuid, uuid)'::regprocedure), array['search_path=public'], 'soft_delete_trip pins search_path');
select is_definer('public', 'expire_trace_objects', array['interval', 'integer']::name[], 'expire_trace_objects is security definer');
select function_owner_is('public', 'expire_trace_objects', array['interval', 'integer']::name[], 'postgres', 'expire_trace_objects owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.expire_trace_objects(interval, int)'::regprocedure), array['search_path=public'], 'expire_trace_objects pins search_path');
select is(
  (select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
select is(has_schema_privilege('authenticated', 'public', 'create'), false, 'authenticated cannot create objects in public');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'), 0, 'no table streams through realtime');

-- storage: the traces bucket is private, capped, gzip-only, and owner-prefixed
select is((select public from storage.buckets where id = 'traces'), false, 'traces bucket is private');
select is((select file_size_limit from storage.buckets where id = 'traces'), 5242880::bigint, 'traces bucket caps objects at 5 MB');
select is((select allowed_mime_types from storage.buckets where id = 'traces'), array['application/gzip'], 'traces bucket accepts gzip only');
select policies_are('storage', 'objects', array['traces_insert_own', 'traces_select_own', 'traces_delete_own']::name[], 'storage.objects has exactly the three traces policies');

-- default privileges: anything postgres creates in public from now on is default-deny
create table public.zz_probe (id int);
create sequence public.zz_probe_seq;
create function public.zz_probe_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege('anon', 'public.zz_probe', p)) from unnest(array['select', 'insert', 'update', 'delete']) as p), false, 'a new table grants anon nothing');
select is((select bool_or(has_table_privilege('authenticated', 'public.zz_probe', p)) from unnest(array['select', 'insert', 'update', 'delete']) as p), false, 'a new table grants authenticated nothing');
select is(has_table_privilege('service_role', 'public.zz_probe', 'select'), true, 'service_role keeps access to new tables');
select is((select bool_or(has_sequence_privilege('anon', 'public.zz_probe_seq', p)) from unnest(array['usage', 'select', 'update']) as p), false, 'a new sequence grants anon nothing');
select is((select bool_or(has_sequence_privilege('authenticated', 'public.zz_probe_seq', p)) from unnest(array['usage', 'select', 'update']) as p), false, 'a new sequence grants authenticated nothing');
select is(has_function_privilege('anon', 'public.zz_probe_fn()', 'execute'), false, 'a new function grants anon nothing');
select is(has_function_privilege('authenticated', 'public.zz_probe_fn()', 'execute'), false, 'a new function grants authenticated nothing');
select is(has_function_privilege('authenticated', 'extensions.st_point(double precision, double precision)', 'execute'), true, 'the global function default-deny leaves extension helpers callable');
drop function public.zz_probe_fn();
drop sequence public.zz_probe_seq;
drop table public.zz_probe;

-- ---------------------------------------------------------------------------
-- act as the service role (the edge functions' client): apply_trip
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- shape validation runs before anything is looked up or written
select throws_ok($$ select public.apply_trip((select p - 'scored' from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing scored', 'missing scored rejected');
select throws_ok($$ select public.apply_trip((select p - 'userId' from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing userId', 'missing userId rejected');
select throws_ok($$ select public.apply_trip((select p - 'day' from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing day', 'missing day rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload}', (p->'payload') - 'incomplete') from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing payload.incomplete', 'missing payload.incomplete rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload}', (p->'payload') - 'tracePath') from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing payload.tracePath', 'missing payload.tracePath rejected (null is fine, absent is not)');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload}', (p->'payload') - 'rowsDigest') from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing payload.rowsDigest', 'missing payload.rowsDigest rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,rowsDigest}', '[]') from fx where name = 'a1')) $$, '22023', 'apply_trip payload key payload.rowsDigest must be a JSON object', 'rowsDigest must be an object');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{day}', (p->'day') - 'severeEvents') from fx where name = 'a1')) $$, '22023', 'apply_trip payload is missing day.severeEvents', 'missing day.severeEvents rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,events}', '{}') from fx where name = 'a1')) $$, '22023', 'apply_trip payload key payload.events must be a JSON array', 'events must be an array');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,eventDeductions}', '[]') from fx where name = 'a1')) $$, '22023', 'apply_trip payload key scored.eventDeductions must be a JSON object', 'eventDeductions must be an object');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{conditions}', '[1]') from fx where name = 'a1')) $$, '22023', 'apply_trip payload key conditions must be a JSON object', 'conditions must be an object when present');
select throws_ok($$ select public.apply_trip((select p from fx where name = 'a-big')) $$, '22023', 'apply_trip payload has more than 500 events', 'more than 500 events rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,score}', '101') from fx where name = 'a1')) $$, '22023', 'apply_trip score must be between 0 and 100', 'score above 100 rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,score}', '-1') from fx where name = 'a1')) $$, '22023', 'apply_trip score must be between 0 and 100', 'negative score rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,status}', '"bogus"') from fx where name = 'a1')) $$, '22023', 'apply_trip status is not a trip status', 'unknown status rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,score}', 'null') from fx where name = 'a1')) $$, '22023', 'apply_trip score must be present exactly when the trip is scored', 'final without a score rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{scored,status}', '"unscored"') from fx where name = 'a1')) $$, '22023', 'apply_trip score must be present exactly when the trip is scored', 'unscored with a score rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{day,day}', '"2001-01-01"') from fx where name = 'a1')) $$, '22023', 'apply_trip day does not match the trip', 'a day row that is not the trip day is rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{userId}', '"not-a-uuid"') from fx where name = 'a1')) $$, '22023', 'apply_trip userId is not a uuid', 'a malformed user id is rejected in the 22023 family');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{userId}', 'null') from fx where name = 'a1')) $$, '22023', 'apply_trip userId is not a uuid', 'a null user id is rejected');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,tz}', '"Mars/Olympus"') from fx where name = 'a1')) $$, '22023', null, 'an unknown time zone is rejected');
-- event rows and ids fail closed on the table (zod has already refused them upstream); these pin the codes Task 2 maps
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,clientTripId}', '"../x"') from fx where name = 'a1')) $$, '23514', null, 'a client trip id outside the character class is rejected by the table');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,events,0,category}', '"bogus"') from fx where name = 'a1')) $$, '23514', null, 'an unknown event category is rejected by the table');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,events,1,id}', '"ev-1"') from fx where name = 'a1')) $$, '23505', null, 'duplicate event ids are rejected by the unique key');
select throws_ok($$ select public.apply_trip((select jsonb_set(p, '{payload,distanceM}', '3000000') from fx where name = 'a1')) $$, '23514', null, 'an implausible distance is rejected by the table ceiling');
select is((select count(*)::int from public.trips), 0, 'rejected payloads wrote nothing');

-- happy path
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a1')) $$, 'apply_trip applies A trip 1');
select is((select public.apply_trip((select p from fx where name = 'a1')) ->> 'status'), 'final', 'result carries the stored status');
select is(((select public.apply_trip((select p from fx where name = 'a1')) ->> 'score')::int), 74, 'result carries the stored score');
select is(((select public.apply_trip((select p from fx where name = 'a1')) ->> 'trip_id')::uuid), pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'result carries the trip id');
select is((select public.apply_trip((select p from fx where name = 'a1')) ->> 'day'), pg_temp.la_day(2)::text, 'result carries the trip day');
select is(((select public.apply_trip((select p from fx where name = 'a1')) ->> 'replayed')::boolean), true, 'a second call reports a replay');
select is((select count(*)::int from public.trips where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 1, 'replays create no second trip');

select is((select status from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'final', 'trip status stored from the server result');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 74, 'trip score stored');
select is((select scoring_version from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 1, 'scoring version stored');
select is((select data_quality from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'A', 'data quality stored');
select is((select (category_deductions ->> 'speeding')::numeric from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 26::numeric, 'category deductions come from the server result, not the device provisional');
select is((select exposure from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 1.25, 'exposure stored');
select is((select trace_path from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-1.bin.gz', 'trace path is derived from the user id and client trip id');
select is((select incomplete from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), false, 'incomplete flag stored');
select is((select rows_digest from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), (select p->'payload'->'rowsDigest' from fx where name = 'a1'), 'rows digest stored verbatim from the payload');
select is((select local_day from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), pg_temp.la_day(2), 'local day derived on insert');
select is((select role from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'driver', 'role stored');
select is((select role_source from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'manual', 'role source stored');
select is((select role_confidence from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), null, 'null role confidence stored as null');
select is((select mode from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'mounted', 'mode stored');
select is((select camera_session from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), false, 'camera session stored');
select is((select started_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), pg_temp.at_la(2, 10), 'started_at converted from epoch ms');
select is((select ended_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), pg_temp.at_la(2, 10) + interval '15 minutes', 'ended_at converted from epoch ms');
select is((select tz from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'America/Los_Angeles', 'tz stored');
select is((select distance_m from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 12500.5, 'distance stored');
select is((select duration_s from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 900::numeric, 'duration stored');
select is((select polyline from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), '_p~iF~ps|U_ulLnnqC_mqNvxq`@', 'polyline stored');
select is((select start_geohash5 from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'c23nb', 'start geohash stored');
select is((select conditions from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), '{"night": false, "precipitation": false}'::jsonb, 'conditions stored from the envelope');
select is((select had_severe_event from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), false, 'severe-event flag stored');
select is((select unscored_reason from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), null, 'a scored trip has no unscored reason');
select is((select deleted_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), null, 'a new trip is not deleted');

select is((select count(*)::int from public.trip_events where trip_id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 20, 'all 20 events stored');
select is((select user_id from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'events carry the owner');
select is((select category from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'speeding', 'event category stored');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'scored', 'event status stored');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 2::numeric, 'event deduction taken from the server eventDeductions map');
select is((select lat from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 47.606, 'event lat stored at 3 dp');
select is((select lng from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), -122.332, 'event lng stored at 3 dp');
select is((select duration_ms from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 8500, 'event duration stored');
select is((select confidence from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 0.9, 'event confidence stored');
select is((select context_multiplier from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 1::numeric, 'event context multiplier stored');
select is((select severity from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 1::numeric, 'event severity stored');
select is((select (measured ->> 'overMps')::numeric from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 5.4, 'event measured stored');
select is((select context from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), '{"night": false, "precipitation": false}'::jsonb, 'event context stored');
select is((select alert_shown from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), true, 'event alert flag stored');
select is((select source from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'gnss', 'event source stored');
select is((select started_at from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), pg_temp.at_la(2, 10) + interval '10 seconds', 'event started_at converted from epoch ms');

select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 78, 'day row long-term score written from the envelope');
select is((select band from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 'getting_there', 'day row band written');
select is((select provisional from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), false, 'day row provisional flag written');
select is((select good_day from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), true, 'day row good-day flag written');
select is((select safe_day from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), false, 'day row safe-day flag written');
select is((select phone_free_day from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), true, 'day row phone-free flag written');
select is((select driving_s from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 900, 'day row driving seconds written');
select is((select trips_scored from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 1, 'day row scored-trip count written');
select is((select exposure from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 1.25, 'day row exposure written');
select is((select (medians ->> 'speeding')::numeric from public.baselines where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 1.2, 'baselines medians written from the envelope');
select is((select computed_at from public.baselines where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), now(), 'baselines computed_at stamped server-side');

-- idempotency: the same (user, client_trip_id) with different values returns the stored result and rewrites nothing
select is(((select public.apply_trip((select p from fx where name = 'a1-replay')) ->> 'score')::int), 74, 'replay with a different score returns the stored score');
select is(((select public.apply_trip((select p from fx where name = 'a1-replay')) ->> 'replayed')::boolean), true, 'replay is reported as such');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 74, 'stored score untouched by the replay');
select is((select count(*)::int from public.trip_events where trip_id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 20, 'event count unchanged by the replay');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 78, 'day row untouched by the replay');

-- the same client_trip_id under another user is a different trip; the trace key follows the user id, never the field
select lives_ok($$ select public.apply_trip((select p from fx where name = 'b1')) $$, 'apply_trip applies B trip with the same client id');
select isnt(pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1'), pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'client trip ids are unique per user, not global');
select is((select trace_path from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/a-trip-1.bin.gz', 'B trace path is under B prefix');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a-hostile')) $$, 'apply_trip applies a trip whose tracePath field is hostile');
select is((select trace_path from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-hostile.bin.gz', 'hostile tracePath field is ignored; the key is derived');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a-uid')) $$, 'apply_trip applies a trip whose payload smuggles another user id');
select is((select user_id from public.trips where client_trip_id = 'a-trip-uid'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'a user id inside the device payload is ignored; the envelope userId owns the trip');
select is((select count(*)::int from public.trips where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 1, 'nothing landed under the smuggled user');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'b2')) $$, 'apply_trip accepts a uuid-shaped client id and a day array');
select is((select local_day from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '7e1a3f60-2b3c-4d5e-8f90-1234567890ab')), pg_temp.la_day(2), 'uuid client id stored; its day derived');
select is((select long_term_score from public.score_daily where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and day = pg_temp.la_day(0)), 80, 'the extra day row of the array is written too');
select is((select count(*)::int from public.score_daily where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 3, 'B has a row per day the arrays named');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a-old')) $$, 'apply_trip applies A old trip');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'c1')) $$, 'apply_trip applies C trip');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'd1')) $$, 'apply_trip applies D trip');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'e1')) $$, 'apply_trip applies E trip');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'f1')) $$, 'apply_trip applies F trip');
select is((select category from public.trip_events where id = pg_temp.ev('ffffffff-ffff-4fff-8fff-ffffffffffff', 'f-trip-1', 'ev-1')), 'phone', 'F first event is a phone event');

-- an unscored trip stores a null score, its reason, and null event deductions
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a-unscored')) $$, 'apply_trip applies an unscored trip');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored')), null, 'unscored trip has no score');
select is((select status from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored')), 'unscored', 'unscored status stored');
select is((select unscored_reason from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored')), 'too_short', 'unscored reason stored');
select is((select trace_path from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored')), null, 'null tracePath stores a null trace path');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored', 'ev-1')), null, 'events of an unscored trip carry no deduction');
select is((select count(*)::int from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 2, 'A has one day row per distinct day');

-- the role guard is belt-and-braces over the grant: the same SQL role without the service claim is refused
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}', true);
select throws_ok($$ select public.apply_trip((select p from fx where name = 'a1')) $$, '42501', 'apply_trip requires the service role', 'apply_trip refuses a non-service claim');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 1, "status": "final"}', null, null, null) $$, '42501', 'apply_recompute requires the service role', 'apply_recompute refuses a non-service claim');
select throws_ok($$ select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', 'count_dispute_allowance requires the service role', 'count_dispute_allowance refuses a non-service claim');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1'), 'hazard', null, null) $$, '42501', 'record_dispute requires the service role', 'record_dispute refuses a non-service claim');
select throws_ok($$ select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'passenger') $$, '42501', 'set_trip_role_row requires the service role', 'set_trip_role_row refuses a non-service claim');
select throws_ok($$ select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')) $$, '42501', 'soft_delete_trip requires the service role', 'soft_delete_trip refuses a non-service claim');
select throws_ok($$ select public.expire_trace_objects() $$, '42501', 'expire_trace_objects requires the service role', 'expire_trace_objects refuses a non-service claim');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- disputes: rolling allowance boundaries (3 per 7 days, 20 % of scored events
-- over 30 days), the free speeding stated-limit path, audit rows, replays,
-- map feedback deduped per user and cell
-- ---------------------------------------------------------------------------
-- A has 25 events on scored trips in the last 30 days (20 + 1 + 4 + 0): 20 % = 5, so the 7-day cap of 3 binds first
select is((select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
  '{"used_7d": 0, "limit_7d": 3, "remaining_7d": 3, "disputed_30d": 0, "scored_30d": 25, "max_30d": 5, "remaining_30d": 5, "remaining_allowance": 3, "can_auto_accept": true, "denied_reason": null}'::jsonb, 'A starts with the full allowance');
select throws_ok($$ select public.count_dispute_allowance(null) $$, '22023', 'count_dispute_allowance requires a user', 'allowance needs a user');

select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1'), 'hazard', 'swerved round a ladder', null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": true, "denied_reason": null, "remaining_7d": 2, "remaining_30d": 4, "remaining_allowance": 2, "event_status": "disputed", "replayed": false}'::jsonb, 'dispute 1 auto-accepted and consumes');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'disputed', 'accepted dispute marks the event disputed');
select is((select auto_accepted from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), true, 'dispute row records the acceptance');
select is((select consumed_allowance from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), true, 'dispute row records the consumption');
select is((select reason from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'hazard', 'dispute row records the reason');
select is((select note from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'swerved round a ladder', 'dispute row records the note');
select is((select decided_at from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), now(), 'dispute decided_at is server time');
select is((select user_id from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'dispute row carries the owner');
select is(((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-2'), 'phone_moved', null, null)) ->> 'auto_accepted')::boolean, true, 'dispute 2 auto-accepted');
select is(((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-3'), 'other', repeat('n', 500), null)) ->> 'auto_accepted')::boolean, true, 'dispute 3 auto-accepted with a 500-character note');
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4'), 'passenger_phone', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_7d", "remaining_7d": 0, "remaining_30d": 2, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'dispute 4 is recorded but not applied (7-day allowance)');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4')), 'scored', 'a dispute beyond the allowance leaves the event scored');
select is((select auto_accepted from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4')), false, 'the denied dispute is still recorded');
select is((select denied_reason from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4')), 'allowance_7d', 'the denied dispute records why');
select is((select count from public.rate_limits where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and key = 'dispute_7d'), 0, 'the rate_limits row is only a lock; nothing is counted there');
select is(((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1'), 'hazard', null, null)) ->> 'trip_id')::uuid, pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'the result carries the trip id');

-- wrong limit with a stated limit on a speeding event: accepted without spending one of the 3, still counted
-- toward the 20 %, and aggregated into map feedback once per user and cell
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-5'), 'wrong_limit', null, 35)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": false, "denied_reason": null, "remaining_7d": 0, "remaining_30d": 1, "remaining_allowance": 0, "event_status": "disputed", "replayed": false}'::jsonb, 'wrong limit with a stated limit is accepted without consuming the 7-day cap');
select is((select stated_limit_mph from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-5')), 35, 'stated limit recorded');
select is(((select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) ->> 'used_7d')::int, 3, 'a free dispute leaves the 7-day count at three');
select is((select count(*)::int from public.map_feedback), 1, 'wrong-limit dispute creates one map feedback row');
select is((select reports from public.map_feedback), 1, 'map feedback counts one report');
select is((select stated_limits_mph from public.map_feedback), array[35], 'map feedback keeps the stated limit');
select is((select status from public.map_feedback), 'open', 'map feedback starts open');
select is(((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-6'), 'wrong_limit', null, 30)) ->> 'auto_accepted')::boolean, true, 'second free wrong-limit dispute at the same place accepted');
select is((select reports from public.map_feedback), 1, 'a repeat report on the same cell by the same user does not increment reports');
select is((select stated_limits_mph from public.map_feedback), array[35], 'a repeat report does not extend the stated limits');
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-7'), 'wrong_limit', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_7d", "remaining_7d": 0, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'wrong limit without a stated limit consumes, so it is denied at the cap');
select is((select reports from public.map_feedback), 1, 'a denied repeat report is still not double-counted');
select is((select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
  '{"used_7d": 3, "limit_7d": 3, "remaining_7d": 0, "disputed_30d": 5, "scored_30d": 25, "max_30d": 5, "remaining_30d": 0, "remaining_allowance": 0, "can_auto_accept": false, "denied_reason": "allowance_7d"}'::jsonb, 'A allowance after three consuming and two free disputes');
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-8'), 'wrong_limit', null, 35)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_30d", "remaining_7d": 0, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'the free path is capped by the 30-day 20 % rule');

-- a queued retry of a recorded dispute replays the decision instead of failing
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": true, "denied_reason": null, "remaining_7d": 0, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "disputed", "replayed": true}'::jsonb, 'an accepted dispute replays as accepted');
select is((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4'), 'other', 'changed my mind', null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_7d", "remaining_7d": 0, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": true}'::jsonb, 'a denied dispute replays as denied, whatever the retry says');
select is((select reason from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-4')), 'passenger_phone', 'a replay rewrites nothing on the recorded row');
select is(((select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile', 'ev-1'), 'hazard', null, null)) ->> 'denied_reason'), 'allowance_7d', 'a dispute on a second trip is recorded (denied) for the delete test below');

-- guard rails
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1'), 'hazard', null, null) $$, '42501', 'event not owned by user', 'A cannot dispute B event');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000000', 'hazard', null, null) $$, '42501', 'event not owned by user', 'an unknown event reads as not owned (no oracle)');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'bogus', null, null) $$, '22023', 'record_dispute reason is not a dispute reason', 'unknown reason rejected');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'other', repeat('n', 501), null) $$, '22023', 'record_dispute note exceeds 500 characters', 'overlong note rejected');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'wrong_limit', null, 200) $$, '22023', 'record_dispute stated limit must be between 5 and 100', 'implausible stated limit rejected');
select throws_ok($$ select public.record_dispute(null, pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'hazard', null, null) $$, '22023', 'record_dispute requires a user', 'dispute needs a user');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old', 'ev-1'), 'hazard', null, null) $$, '22023', 'dispute window closed', 'events older than 14 days cannot be disputed');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-unscored', 'ev-1'), 'hazard', null, null) $$, '22023', 'trip is not scored', 'events on an unscored trip cannot be disputed');
select is((select count(*)::int from public.event_disputes where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 9, 'rejected calls and replays recorded nothing');

-- C has 10 scored events in 30 days: 20 % = 2, so the 30-day rule binds before the 7-day cap
select is((select public.count_dispute_allowance('cccccccc-cccc-4ccc-8ccc-cccccccccccc')),
  '{"used_7d": 0, "limit_7d": 3, "remaining_7d": 3, "disputed_30d": 0, "scored_30d": 10, "max_30d": 2, "remaining_30d": 2, "remaining_allowance": 2, "can_auto_accept": true, "denied_reason": null}'::jsonb, 'C allowance is capped by the 20 % rule');
select is(((select public.record_dispute('cccccccc-cccc-4ccc-8ccc-cccccccccccc', pg_temp.ev('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c-trip-1', 'ev-1'), 'hazard', null, null)) ->> 'auto_accepted')::boolean, true, 'C dispute 1 accepted');
select is(((select public.record_dispute('cccccccc-cccc-4ccc-8ccc-cccccccccccc', pg_temp.ev('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c-trip-1', 'ev-2'), 'hazard', null, null)) ->> 'auto_accepted')::boolean, true, 'C dispute 2 accepted');
select is((select public.record_dispute('cccccccc-cccc-4ccc-8ccc-cccccccccccc', pg_temp.ev('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c-trip-1', 'ev-3'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_30d", "remaining_7d": 1, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'C dispute 3 denied by the 20 % rule while the 7-day cap still has room');
select is(((select public.record_dispute('cccccccc-cccc-4ccc-8ccc-cccccccccccc', pg_temp.ev('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c-trip-1', 'ev-4'), 'wrong_limit', null, 40)) ->> 'denied_reason'), 'allowance_30d', 'C free wrong-limit dispute is also denied by the 20 % rule');
select is((select reports from public.map_feedback), 2, 'a wrong-limit report from another user on the same cell is aggregated even when denied');
select is((select stated_limits_mph from public.map_feedback), array[35, 40], 'the other user stated limit is appended');

-- F's phone event with a stated limit is not the free speeding path: it consumes normally
select is((select public.record_dispute('ffffffff-ffff-4fff-8fff-ffffffffffff', pg_temp.ev('ffffffff-ffff-4fff-8fff-ffffffffffff', 'f-trip-1', 'ev-1'), 'wrong_limit', null, 35)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": true, "denied_reason": null, "remaining_7d": 2, "remaining_30d": 1, "remaining_allowance": 1, "event_status": "disputed", "replayed": false}'::jsonb, 'a stated limit on a phone event consumes one of the 3');
select is((select reports from public.map_feedback), 2, 'a wrong-limit report on a phone event does not feed the speed-limit map');

-- E has 50 scored events (20 % = 10): free stated-limit disputes are accepted up to the 20 % share, not beyond
select is((select count(*)::int from (select public.record_dispute('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', pg_temp.ev('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'e-trip-1', 'ev-' || i), 'wrong_limit', null, 35) r from generate_series(1, 10) i) s where (s.r ->> 'auto_accepted')::boolean), 10, 'ten free stated-limit disputes accepted on 50 scored events');
select is((select public.count_dispute_allowance('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')),
  '{"used_7d": 0, "limit_7d": 3, "remaining_7d": 3, "disputed_30d": 10, "scored_30d": 50, "max_30d": 10, "remaining_30d": 0, "remaining_allowance": 0, "can_auto_accept": false, "denied_reason": "allowance_30d"}'::jsonb, 'E allowance: nothing spent from the 7-day cap, the 20 % share is used up');
select is((select public.record_dispute('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', pg_temp.ev('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'e-trip-1', 'ev-11'), 'wrong_limit', null, 35)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_30d", "remaining_7d": 3, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'the 11th speeding stated-limit dispute in 30 days on 50 scored events is denied by the 20 % rule');
select is((select reports from public.map_feedback), 3, 'E counts once on the cell across eleven reports');

-- D: the rolling 7-day window. Three consuming disputes are on record at day 0 (7 days 1 s ago,
-- aged out), day 6.5 and day 6.9 (still counting); today is day 7.0. D has 30 scored events
-- (20 % = 6) so only the 7-day rule binds.
insert into public.event_disputes (event_id, user_id, reason, auto_accepted, consumed_allowance, created_at, decided_at) values
  (pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-1'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'hazard', true, true, now() - interval '7 days 1 second', now() - interval '7 days 1 second'),
  (pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-2'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'hazard', true, true, now() - interval '6 days 12 hours', now() - interval '6 days 12 hours'),
  (pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-3'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'hazard', true, true, now() - interval '6 days 21 hours 36 minutes', now() - interval '6 days 21 hours 36 minutes');
update public.trip_events set status = 'removed' where id in (
  pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-1'),
  pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-2'),
  pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-3'));
select is((select public.count_dispute_allowance('dddddddd-dddd-4ddd-8ddd-dddddddddddd')),
  '{"used_7d": 2, "limit_7d": 3, "remaining_7d": 1, "disputed_30d": 3, "scored_30d": 30, "max_30d": 6, "remaining_30d": 3, "remaining_allowance": 1, "can_auto_accept": true, "denied_reason": null}'::jsonb, 'day 0 / 6.5 / 6.9 at day 7.0: the day-0 dispute has aged out, two still count');
select is((select public.record_dispute('dddddddd-dddd-4ddd-8ddd-dddddddddddd', pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-4'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": true, "denied_reason": null, "remaining_7d": 0, "remaining_30d": 2, "remaining_allowance": 0, "event_status": "disputed", "replayed": false}'::jsonb, 'the third dispute inside the rolling week is accepted');
select is((select public.record_dispute('dddddddd-dddd-4ddd-8ddd-dddddddddddd', pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-5'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_7d", "remaining_7d": 0, "remaining_30d": 2, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'the fourth inside the rolling week is recorded, not applied');
select is((select status from public.trip_events where id = pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-5')), 'scored', 'D denied dispute leaves the event scored');
select is((select auto_accepted from public.event_disputes where event_id = pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-5')), false, 'D denied dispute is on record');
insert into public.event_disputes (event_id, user_id, reason, auto_accepted, consumed_allowance, created_at, decided_at) values
  (pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-6'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'hazard', true, true, now() - interval '7 days', now() - interval '7 days');
update public.trip_events set status = 'removed' where id = pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-6');
select is(((select public.count_dispute_allowance('dddddddd-dddd-4ddd-8ddd-dddddddddddd')) ->> 'used_7d')::int, 3, 'a dispute exactly 7 days old no longer counts (strict boundary)');
select is((select public.record_dispute('dddddddd-dddd-4ddd-8ddd-dddddddddddd', pg_temp.ev('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd-trip-1', 'ev-7'), 'wrong_limit', null, 40)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": false, "denied_reason": null, "remaining_7d": 0, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "disputed", "replayed": false}'::jsonb, 'a free dispute is accepted at the 7-day cap');
select is(((select public.count_dispute_allowance('dddddddd-dddd-4ddd-8ddd-dddddddddddd')) ->> 'used_7d')::int, 3, 'the free dispute did not move the 7-day count');
select is(((select public.count_dispute_allowance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) ->> 'used_7d')::int, 0, 'D rows do not count for B');
select is((select reports from public.map_feedback), 4, 'D first report on the cell is aggregated');

-- G: a new driver with 3 scored events (20 % = 0.6 -> floor of one) and one `possible` event
select lives_ok($$ select public.apply_trip((select p from fx where name = 'g1')) $$, 'apply_trip applies G trip');
select is((select status from public.trip_events where id = pg_temp.ev('99999999-9999-4999-8999-999999999999', 'g-trip-1', 'ev-4')), 'possible', 'G fourth event is possible');
select is((select public.count_dispute_allowance('99999999-9999-4999-8999-999999999999')),
  '{"used_7d": 0, "limit_7d": 3, "remaining_7d": 3, "disputed_30d": 0, "scored_30d": 3, "max_30d": 1, "remaining_30d": 1, "remaining_allowance": 1, "can_auto_accept": true, "denied_reason": null}'::jsonb, 'three scored events give a 20 % share of one (floor)');
select throws_ok($$ select public.record_dispute('99999999-9999-4999-8999-999999999999', pg_temp.ev('99999999-9999-4999-8999-999999999999', 'g-trip-1', 'ev-4'), 'wrong_limit', null, 35) $$, '22023', 'event is not scored', 'a stated-limit dispute on a possible speeding event is refused');
select is((select public.count_dispute_allowance('99999999-9999-4999-8999-999999999999')),
  '{"used_7d": 0, "limit_7d": 3, "remaining_7d": 3, "disputed_30d": 0, "scored_30d": 3, "max_30d": 1, "remaining_30d": 1, "remaining_allowance": 1, "can_auto_accept": true, "denied_reason": null}'::jsonb, 'the refused dispute consumed nothing');
select is((select count(*)::int from public.event_disputes where user_id = '99999999-9999-4999-8999-999999999999'), 0, 'the refused dispute was not recorded');
select is((select reports from public.map_feedback), 4, 'the refused dispute wrote no map feedback');
select is((select public.record_dispute('99999999-9999-4999-8999-999999999999', pg_temp.ev('99999999-9999-4999-8999-999999999999', 'g-trip-1', 'ev-1'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": true, "consumed": true, "denied_reason": null, "remaining_7d": 2, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "disputed", "replayed": false}'::jsonb, 'a new driver first dispute is accepted through the floor');
select is((select public.record_dispute('99999999-9999-4999-8999-999999999999', pg_temp.ev('99999999-9999-4999-8999-999999999999', 'g-trip-1', 'ev-2'), 'hazard', null, null)) - 'dispute_id' - 'trip_id',
  '{"auto_accepted": false, "consumed": false, "denied_reason": "allowance_30d", "remaining_7d": 2, "remaining_30d": 0, "remaining_allowance": 0, "event_status": "scored", "replayed": false}'::jsonb, 'the second is denied by the 20 % rule');

-- ---------------------------------------------------------------------------
-- apply_recompute writes exactly the caller's values, for the caller's user only
-- ---------------------------------------------------------------------------
select is((select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'),
    '{"score": 72, "status": "final", "exposure": 1.25, "dataQuality": "B", "categoryDeductions": {"phone":0,"speeding":24,"braking":0,"accel":0,"cornering":0,"focus":0}, "scoringVersion": 1}',
    jsonb_build_array(
      jsonb_build_object('id', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1'), 'status', 'removed', 'deduction', 0),
      jsonb_build_object('id', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-2'), 'status', 'scored', 'deduction', 3.5)),
    jsonb_build_object('day', pg_temp.la_day(2), 'longTermScore', 70, 'band', 'getting_there', 'provisional', false,
      'safeDay', false, 'goodDay', true, 'phoneFreeDay', true, 'cameraDay', false, 'exposure', 1.25, 'drivingS', 900, 'tripsScored', 1, 'severeEvents', 0),
    '{"medians": {"speeding": 0.9}}')),
  jsonb_build_object('trip_id', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'score', 72, 'status', 'final'), 'apply_recompute returns the new trip result');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 72, 'recompute wrote the score');
select is((select data_quality from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 'B', 'recompute wrote the data quality');
select is((select (category_deductions ->> 'speeding')::numeric from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 24::numeric, 'recompute wrote the category deductions');
select is((select rows_digest from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), (select p->'payload'->'rowsDigest' from fx where name = 'a1'), 'recompute leaves the rows digest untouched');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 'removed', 'recompute wrote the removed status');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-1')), 0::numeric, 'recompute wrote the removed event deduction');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-2')), 3.5, 'recompute wrote the second event deduction');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-2')), 'scored', 'recompute keeps a scored status when told to');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-3')), 2::numeric, 'events not in the recompute list are untouched');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(2)), 70, 'recompute refreshed the day row');
select is((select (medians ->> 'speeding')::numeric from public.baselines where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 0.9, 'recompute refreshed the baselines');
-- the severe flag follows p_scored.hadSevereEvent when it is given and stays when it is not
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {"speeding": 24}, "hadSevereEvent": true}', null, null, null) $$, 'recompute accepts a severe flag');
select is((select had_severe_event from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), true, 'recompute stored the severe flag it was given');
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {"speeding": 24}}', null, null, null) $$, 'recompute with no events, day or baselines touches only the trip');
select is((select count(*)::int from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 2, 'a null day writes no day row');
select is((select had_severe_event from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), true, 'a recompute without hadSevereEvent leaves the severe flag alone');
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {"speeding": 24}, "hadSevereEvent": false}', null, null, null) $$, 'recompute accepts a cleared severe flag');
select is((select had_severe_event from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), false, 'a recompute with hadSevereEvent false clears the severe flag');
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {"speeding": 24}}', null,
  jsonb_build_array(pg_temp.day_row(pg_temp.la_day(2), 71), pg_temp.day_row(pg_temp.la_day(0), 71)), null) $$, 'recompute accepts an array of day rows');
select is((select count(*)::int from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 3, 'both day rows written');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 71, 'today row carries the refreshed long-term score');
-- the integer-bound day fields are rounded by the writer, so a caller that sends them as numerics
-- (a sum of fractional durations, a JSON number that kept its point) is written, not refused
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), null, null,
  jsonb_build_object('day', pg_temp.la_day(0), 'longTermScore', 68.6, 'band', 'good', 'provisional', false,
    'safeDay', false, 'goodDay', false, 'phoneFreeDay', false, 'cameraDay', false,
    'exposure', 2.100001, 'drivingS', 2520.4, 'tripsScored', 2.0, 'severeEvents', 1.4), null) $$,
  'a day row whose integer fields arrive as numerics is accepted');
select is((select driving_s from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 2520, 'drivingS is rounded into the integer column');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 69, 'longTermScore is rounded into the integer column');
select is((select trips_scored from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 2, 'tripsScored is rounded into the integer column');
select is((select severe_events from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 1, 'severeEvents is rounded into the integer column');

select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 101, "status": "final", "categoryDeductions": {}}', null, null, null) $$, '22023', 'apply_recompute score must be between 0 and 100', 'recompute rejects a score above 100');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 50, "status": "bogus", "categoryDeductions": {}}', null, null, null) $$, '22023', 'apply_recompute status is not a trip status', 'recompute rejects an unknown status');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": null, "status": "final", "categoryDeductions": {}}', null, null, null) $$, '22023', 'apply_recompute score must be present exactly when the trip is scored', 'recompute rejects final without a score');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {}}',
  jsonb_build_array(jsonb_build_object('id', pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1'), 'status', 'removed', 'deduction', 0)), null, null) $$, '22023', 'apply_recompute event does not belong to the trip', 'recompute rejects an event of another trip');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {}}',
  jsonb_build_array(jsonb_build_object('id', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-2'), 'status', 'bogus', 'deduction', 0)), null, null) $$, '22023', 'apply_recompute event status is not an event status', 'recompute rejects an unknown event status');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000000', '{"score": 72, "status": "final", "categoryDeductions": {}}', null, null, null) $$, '42501', 'trip not owned by user', 'an unknown trip reads as not owned (no oracle)');
select throws_ok($$ select public.apply_recompute('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 100, "status": "final", "categoryDeductions": {}}', null, pg_temp.day_row(pg_temp.la_day(2), 100), null) $$, '42501', 'trip not owned by user', 'B cannot recompute A trip');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')), 72, 'A score untouched by B attempt');
select is((select count(*)::int from public.score_daily where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and long_term_score = 100), 0, 'no day row landed from B attempt');
select throws_ok($$ select public.apply_recompute(null, pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), null, null, null, null) $$, '22023', 'apply_recompute requires a user', 'recompute needs a user');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, null, null, null, null) $$, '22023', 'apply_recompute requires a trip', 'recompute needs a trip');
select is((select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), null, null, pg_temp.day_row(pg_temp.la_day(0), 69), null)),
  jsonb_build_object('trip_id', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'score', 72, 'status', 'final'), 'a null scored refreshes only the day rows and echoes the stored trip result');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(0)), 69, 'day-only refresh wrote the row');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), null, '[]', null, null) $$, '22023', 'apply_recompute events require scored', 'events without scored are rejected');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{"score": 72, "status": "final", "categoryDeductions": {}}', '{}', null, null) $$, '22023', 'apply_recompute events must be a JSON array', 'recompute rejects a non-array events value');
select is((select status from public.trip_events where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1')), 'scored', 'B event untouched by the rejected recompute');

-- ---------------------------------------------------------------------------
-- role change and soft delete
-- ---------------------------------------------------------------------------
select is((select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'), 'passenger')),
  jsonb_build_object('trip_id', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'), 'role', 'passenger', 'status', 'unscored', 'score', null), 'passenger role change unscores the trip');
select is((select role from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'passenger', 'role written');
select is((select role_source from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'manual', 'a user-set role is sourced manual');
select is((select status from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'unscored', 'trip unscored');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), null, 'score cleared');
select is((select category_deductions from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), '{}'::jsonb, 'category deductions cleared');
select is((select unscored_reason from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'passenger', 'unscored reason is passenger');
select is((select deduction from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile', 'ev-1')), null, 'event deductions cleared on an unscored trip');
select is(((select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'), 'driver')) ->> 'status'), 'unscored', 'switching back to driver leaves scoring to the recompute');
select is((select role from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile')), 'driver', 'driver role written');
select throws_ok($$ select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'), 'bogus') $$, '22023', 'set_trip_role_row role is not a trip role', 'unknown role rejected');
select throws_ok($$ select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1'), 'passenger') $$, '42501', 'trip not owned by user', 'A cannot re-role B trip');
select throws_ok($$ select public.set_trip_role_row(null, pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'), 'passenger') $$, '22023', 'set_trip_role_row requires a user', 'role change needs a user');
select is((select role from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), 'driver', 'B trip role untouched');

-- a delete must take the route with it (audit I-1). No M2 writer fills the endpoint labels or the
-- note, so set them first: otherwise the assertions below would pass on a writer that scrubs
-- nothing.
update public.trips set start_label = 'Home', end_label = 'School', notes = 'dropped my sister at school'
  where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old');
select is((select polyline from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), '_p~iF~ps|U_ulLnnqC_mqNvxq`@', 'the live trip holds its route before the delete');
select is((select lat from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old', 'ev-1')), 47.606, 'its event holds a coordinate before the delete');

select is((select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'))),
  jsonb_build_object('trip_id', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'), 'trace_path', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-old.bin.gz', 'replayed', false), 'soft delete returns the trace key that was stored');
select is((select deleted_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), now(), 'deleted_at stamped');
select is((select trace_path from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'trace path cleared on delete');
select is((select count(*)::int from public.trip_events where trip_id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 1, 'events survive a soft delete (audit)');

-- gone: everything that says where the drive went
select is((select polyline from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), '', 'the deleted trip holds no polyline');
select is((select start_geohash5 from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'the deleted trip holds no start cell');
select is((select end_geohash5 from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'the deleted trip holds no end cell');
select is((select start_label from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'the deleted trip holds no start label');
select is((select end_label from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'the deleted trip holds no end label');
select is((select notes from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), null, 'the deleted trip holds no note');
select is((select rows_digest from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), '{}'::jsonb, 'the deleted trip holds no re-score inputs and no trace digest');
select is((select count(*)::int from public.trip_events where trip_id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old') and (lat is not null or lng is not null)), 0, 'no event of the deleted trip holds a coordinate');
select is((select measured from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old', 'ev-1')), '{}'::jsonb, 'the deleted trip event holds no measurements (a speeding row carries the road''s posted limit)');
select is((select context from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old', 'ev-1')), '{}'::jsonb, 'the deleted trip event holds no context');

-- kept: exactly what an aggregate reads back, and nothing that says where
select is((select status from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 'final', 'the deleted trip keeps its status');
select is((select category_deductions from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), '{"phone":0,"speeding":26,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb, 'the deleted trip keeps its category deductions');
select is((select distance_m from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 12500.5::numeric, 'the deleted trip keeps its distance');
select is((select duration_s from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 900::numeric, 'the deleted trip keeps its duration');
select is((select local_day from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), pg_temp.la_day(20), 'the deleted trip keeps its day');
select is((select role from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 'driver', 'the deleted trip keeps its role');
select is((select status from public.trip_events where id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old', 'ev-1')), 'scored', 'the event row and its status stay: the dispute allowance and the replay branch read them');
select is((select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'))),
  jsonb_build_object('trip_id', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'), 'trace_path', null, 'replayed', true), 'a repeat delete replays (queued retry after a lost response)');
select is((select deleted_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), now(), 'deleted_at unchanged by the replay');
select throws_ok($$ select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'), 'passenger') $$, '42501', 'trip not owned by user', 'a deleted trip cannot be re-roled');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'), '{"score": 50, "status": "final", "categoryDeductions": {}}', null, null, null) $$, '42501', 'trip already deleted', 'a deleted trip cannot be re-scored');
select is((select score from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), 90, 'deleted trip audit values untouched');
select lives_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old'), null, null, pg_temp.day_row(pg_temp.la_day(20), 77), null) $$, 'a deleted own trip still allows the post-delete day refresh');
select is((select long_term_score from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and day = pg_temp.la_day(20)), 77, 'post-delete day refresh wrote the row');
select throws_ok($$ select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')) $$, '42501', 'trip not owned by user', 'A cannot delete B trip');
select throws_ok($$ select public.soft_delete_trip(null, pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')) $$, '22023', 'soft_delete_trip requires a user', 'delete needs a user');
select is((select deleted_at from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), null, 'B trip not deleted');
select is(((select public.apply_trip((select p from fx where name = 'a-old')) ->> 'replayed')::boolean), true, 'a re-upload of a deleted trip replays instead of resurrecting it');
select is((select deleted_at from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), now(), 'deleted trip stays deleted after the replay');
select is((select polyline from public.trips where id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old')), '', 'a re-upload of a deleted trip does not restore its route');
select is(((select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile'))) ->> 'trace_path'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-hostile.bin.gz', 'the disputed trip is deleted too (its dispute must vanish from the owner view)');

-- the catch-all the audit asked for: after every delete in this file, no deleted trip anywhere
-- says where its driver went
select is((select count(*)::int from public.trips
  where deleted_at is not null
    and (polyline <> '' or start_geohash5 is not null or end_geohash5 is not null
      or start_label is not null or end_label is not null or notes is not null
      or trace_path is not null or rows_digest <> '{}'::jsonb)),
  0, 'no soft-deleted trip holds a route, an endpoint cell, a label, a note, a trace key or a trace digest');
select is((select count(*)::int from public.trip_events e join public.trips t on t.id = e.trip_id
  where t.deleted_at is not null
    and (e.lat is not null or e.lng is not null or e.measured <> '{}'::jsonb or e.context <> '{}'::jsonb)),
  0, 'no event of a soft-deleted trip holds a coordinate, a measurement or a context');

-- ---------------------------------------------------------------------------
-- retention: expire_trace_objects (audit I-6). Four trips for user R, written
-- straight into the table so no day row, baseline or count anywhere else moves:
--   r-deleted  40 days old, soft-deleted, trace_path already null, object still
--              in the bucket (the Wi-Fi upload that landed after the delete)
--   r-old      30 days old, live, trace_path set, object in the bucket
--   r-fresh    13 days old, live, trace_path set, object in the bucket -- still
--              inside the 14-day dispute window the trace exists for
--   r-none     30 days old, live, never had a trace
-- Every other trip in this file is 1 to 3 days old, or is A's a-trip-old, which
-- has neither a trace path nor an object, so no sweep below reaches one.
-- ---------------------------------------------------------------------------
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s,
  role, mode, exposure, data_quality, status, score, polyline, start_geohash5, trace_path, deleted_at)
values
  ('11111111-1111-4111-8111-111111111111', 'r-deleted', now() - interval '40 days' - interval '15 minutes',
   now() - interval '40 days', 'America/Los_Angeles', 1000, 900, 'driver', 'mounted', 1, 'A', 'final', 70,
   '', null, null, now() - interval '40 days'),
  ('11111111-1111-4111-8111-111111111111', 'r-old', now() - interval '30 days' - interval '15 minutes',
   now() - interval '30 days', 'America/Los_Angeles', 1000, 900, 'driver', 'mounted', 1, 'A', 'final', 90,
   '_p~iF~ps|U', 'c23nb', '11111111-1111-4111-8111-111111111111/r-old.bin.gz', null),
  ('11111111-1111-4111-8111-111111111111', 'r-fresh', now() - interval '13 days' - interval '15 minutes',
   now() - interval '13 days', 'America/Los_Angeles', 1000, 900, 'driver', 'mounted', 1, 'A', 'final', 80,
   '_p~iF~ps|U', 'c23nb', '11111111-1111-4111-8111-111111111111/r-fresh.bin.gz', null),
  ('11111111-1111-4111-8111-111111111111', 'r-none', now() - interval '30 days' - interval '15 minutes',
   now() - interval '30 days', 'America/Los_Angeles', 1000, 900, 'driver', 'mounted', 1, 'A', 'final', 60,
   '_p~iF~ps|U', 'c23nb', null, null);
insert into storage.objects (bucket_id, name, owner_id) values
  ('traces', '11111111-1111-4111-8111-111111111111/r-deleted.bin.gz', '11111111-1111-4111-8111-111111111111'),
  ('traces', '11111111-1111-4111-8111-111111111111/r-old.bin.gz', '11111111-1111-4111-8111-111111111111'),
  ('traces', '11111111-1111-4111-8111-111111111111/r-fresh.bin.gz', '11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from storage.objects where bucket_id = 'traces' and name like '11111111-%'), 3, 'three retention fixture objects are in the bucket to start with');
select is((select count(*)::int from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and trace_path is not null), 2, 'two retention fixture trips still name a trace');

select throws_ok($$ select public.expire_trace_objects(interval '-1 day') $$, '22023', 'expire_trace_objects requires a non-negative age', 'a negative age is refused');
select throws_ok($$ select public.expire_trace_objects(null::interval) $$, '22023', 'expire_trace_objects requires a non-negative age', 'a null age is refused');
select throws_ok($$ select public.expire_trace_objects(interval '14 days', 0) $$, '22023', 'expire_trace_objects limit must be between 1 and 5000', 'an empty batch is refused');
select throws_ok($$ select public.expire_trace_objects(interval '14 days', 5001) $$, '22023', 'expire_trace_objects limit must be between 1 and 5000', 'an oversize batch is refused');

-- the default sweep: the dispute window is 14 days, so the 40- and 30-day trips go and nothing else
select is((select public.expire_trace_objects(interval '14 days')) - 'cutoff'::text - 'older_than'::text,
  jsonb_build_object('trips', 2, 'cleared', 1, 'keys', jsonb_build_array(
    '11111111-1111-4111-8111-111111111111/r-deleted.bin.gz',
    '11111111-1111-4111-8111-111111111111/r-old.bin.gz')),
  'the sweep names the two trips past the dispute window, oldest first, and clears the one column that was set');
select is((select trace_path from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and client_trip_id = 'r-old'), null, 'the expired trip no longer names its trace');
select is((select trace_path from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and client_trip_id = 'r-fresh'), '11111111-1111-4111-8111-111111111111/r-fresh.bin.gz', 'a trip still inside the dispute window keeps its trace');
select is((select trace_path from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/a-trip-1.bin.gz', 'a recent trip keeps its trace, whoever owns it');
select is((select count(*)::int from storage.objects where bucket_id = 'traces' and name like '11111111-%'), 3, 'the sweep removes no object itself: only the Storage API can, and the caller makes that call');
select is((select score from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and client_trip_id = 'r-old'), 90, 'expiring a trace leaves the trip''s score alone');
select is((select deleted_at is null from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and client_trip_id = 'r-old'), true, 'expiring a trace does not delete the trip');
select is((select polyline from public.trips where user_id = '11111111-1111-4111-8111-111111111111' and client_trip_id = 'r-old'), '_p~iF~ps|U', 'expiring a trace leaves a live trip''s route alone: this is retention, not a delete');

-- a re-run before the caller has removed the objects still names them: the sweep converges on the
-- bucket, not on the column, so a caller that died between the two steps loses no key
select is((select public.expire_trace_objects(interval '14 days')) -> 'keys'::text,
  jsonb_build_array('11111111-1111-4111-8111-111111111111/r-deleted.bin.gz',
    '11111111-1111-4111-8111-111111111111/r-old.bin.gz'),
  'a re-run still names the objects the caller has not removed yet');
select is(((select public.expire_trace_objects(interval '14 days')) ->> 'cleared'::text)::int, 0, 'the re-run clears nothing: the columns are already null');

-- the age is a parameter, so a shorter window reaches trips the default leaves alone
select is((select public.expire_trace_objects(interval '10 days')) -> 'keys'::text,
  jsonb_build_array('11111111-1111-4111-8111-111111111111/r-deleted.bin.gz',
    '11111111-1111-4111-8111-111111111111/r-old.bin.gz',
    '11111111-1111-4111-8111-111111111111/r-fresh.bin.gz'),
  'a shorter age reaches a trip that is still inside the 14-day window');
select is((select public.expire_trace_objects(interval '10 days', 1)) -> 'keys'::text,
  jsonb_build_array('11111111-1111-4111-8111-111111111111/r-deleted.bin.gz'),
  'the batch limit caps one sweep, oldest first');
select is((select count(*)::int from public.trips where trace_path is not null and ended_at < now() - interval '10 days'), 0, 'after the sweep no trip past the window still names a trace');

-- this delete stands in for the Storage API call the caller makes with the returned keys
delete from storage.objects where bucket_id = 'traces' and name like '11111111-%';
select is((select public.expire_trace_objects(interval '10 days')) - 'cutoff'::text - 'older_than'::text,
  jsonb_build_object('trips', 0, 'cleared', 0, 'keys', '[]'::jsonb),
  'once the objects are gone the sweep is empty: it terminates instead of re-reporting them forever');

-- ---------------------------------------------------------------------------
-- act as user A (authenticated): reads are owner-only and hide deleted trips;
-- there is no client write path to any of these tables
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(auth.uid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'auth.uid() resolves to A');

select is((select count(*)::int from public.trips), 3, 'A sees own live trips only');
select is_empty($$ select id from public.trips where client_trip_id in ('a-trip-old', 'a-trip-hostile') $$, 'deleted trips are hidden from their owner');
select is_empty($$ select id from public.trips where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, 'A cannot see B trips');
select is((select count(*)::int from public.trip_events), 23, 'A sees the events of own live trips');
select is_empty($$ select id from public.trip_events where trip_id = pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-old') $$, 'events of a deleted trip are hidden');
select is_empty($$ select id from public.trip_events where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, 'A cannot see B events');
select is((select count(*)::int from public.event_disputes), 8, 'A sees own disputes on live trips');
select is_empty($$ select id from public.event_disputes where event_id = pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-hostile', 'ev-1') $$, 'the dispute of a deleted trip is hidden');
select is_empty($$ select id from public.event_disputes where user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' $$, 'A cannot see C disputes');
select is((select count(*)::int from public.score_daily), 3, 'A sees own day rows');
select is_empty($$ select day from public.score_daily where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, 'A cannot see B day rows');
select is((select count(*)::int from public.baselines), 1, 'A sees own baselines');
select is_empty($$ select user_id from public.baselines where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, 'A cannot see B baselines');
select throws_ok($$ select count(*) from public.map_feedback $$, '42501', null, 'A cannot read map_feedback');
select throws_ok($$ select count(*) from public.rate_limits $$, '42501', null, 'A cannot read rate_limits');

select throws_ok($$ insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', now(), now(), 'UTC', 0, 0, 'driver', 'mounted', 1, 'A', 'final') $$, '42501', null, 'A cannot insert a trip');
select throws_ok($$ insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', now(), now(), 'UTC', 0, 0, 'driver', 'mounted', 1, 'A', 'final') on conflict (user_id, client_trip_id) do update set score = 100 $$, '42501', null, 'A cannot upsert onto B trip key');
select throws_ok($$ update public.trips set score = 100 where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update own trips');
select throws_ok($$ update public.trips set rows_digest = '{}' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot rewrite the re-score inputs');
select throws_ok($$ update public.trips set notes = 'x' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update trip notes directly');
select throws_ok($$ update public.trips set role = 'passenger' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update trip role directly');
select throws_ok($$ update public.trips set deleted_at = null where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot undelete a trip');
select throws_ok($$ update public.trips set score = 0 where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, '42501', null, 'A cannot update B trips');
select throws_ok($$ delete from public.trips where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot delete own trips');
select throws_ok($$ delete from public.trips where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, '42501', null, 'A cannot delete B trips');
select throws_ok($$ insert into public.trip_events (trip_id, user_id, client_event_id, category, started_at, duration_ms, severity, confidence, context_multiplier, source, status) values (pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', 'phone', now(), 0, 0, 1, 1, 'os', 'scored') $$, '42501', null, 'A cannot insert an event');
select throws_ok($$ update public.trip_events set status = 'removed' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update own events');
select throws_ok($$ update public.trip_events set status = 'removed' where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' $$, '42501', null, 'A cannot update B events');
select throws_ok($$ delete from public.trip_events where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot delete own events');
select throws_ok($$ insert into public.event_disputes (event_id, user_id, reason) values (pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'hazard') $$, '42501', null, 'A cannot insert a dispute directly');
select throws_ok($$ update public.event_disputes set auto_accepted = true where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update own disputes');
select throws_ok($$ delete from public.event_disputes where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot delete own disputes');
select throws_ok($$ insert into public.score_daily (user_id, day) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_date) $$, '42501', null, 'A cannot insert a day row');
select throws_ok($$ update public.score_daily set long_term_score = 100 where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update own day rows');
select throws_ok($$ delete from public.score_daily where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot delete own day rows');
select throws_ok($$ insert into public.baselines (user_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') on conflict (user_id) do update set medians = '{}' $$, '42501', null, 'A cannot upsert baselines');
select throws_ok($$ update public.baselines set medians = '{}' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot update own baselines');
select throws_ok($$ delete from public.baselines where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '42501', null, 'A cannot delete own baselines');
select throws_ok($$ insert into public.map_feedback (segment_key) values ('x') $$, '42501', null, 'A cannot insert map feedback');
select throws_ok($$ insert into public.rate_limits (user_id, key) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dispute_7d') on conflict (user_id, key) do update set count = 0 $$, '42501', null, 'A cannot touch own rate limit row');

-- the writers are not client RPCs
select throws_ok($$ select public.apply_trip('{}') $$, '42501', null, 'A cannot call apply_trip');
select throws_ok($$ select public.apply_recompute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), '{}', null, null, null) $$, '42501', null, 'A cannot call apply_recompute');
select throws_ok($$ select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'A cannot call count_dispute_allowance');
select throws_ok($$ select public.record_dispute('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1', 'ev-9'), 'hazard', null, null) $$, '42501', null, 'A cannot call record_dispute');
select throws_ok($$ select public.set_trip_role_row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1'), 'passenger') $$, '42501', null, 'A cannot call set_trip_role_row');
select throws_ok($$ select public.soft_delete_trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pg_temp.trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a-trip-1')) $$, '42501', null, 'A cannot call soft_delete_trip');
select throws_ok($$ select public.upsert_score_day('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}') $$, '42501', null, 'A cannot call upsert_score_day');
select throws_ok($$ select public.upsert_baselines('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}') $$, '42501', null, 'A cannot call upsert_baselines');
select throws_ok($$ select public.require_service_role('x') $$, '42501', null, 'A cannot call require_service_role');
select throws_ok($$ select * from public.require_scored_trip('x', '{}') $$, '42501', null, 'A cannot call require_scored_trip');

-- storage: own prefix only, for insert, select and delete
select lives_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-1.bin.gz', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, 'A can write a trace under own prefix');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/a-trip-2.bin.gz', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'A cannot write a trace under B prefix');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'a-trip-1.bin.gz', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'A cannot write a trace outside any prefix');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'A cannot write an object named as the bare prefix');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('other', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.bin.gz', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'the policies are bucket-scoped');
select is((select count(*)::int from storage.objects where bucket_id = 'traces'), 1, 'A sees only own trace object');
select is_empty($$ select id from storage.objects where name like 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/%' $$, 'B trace object is invisible to A');
select is_empty($$ delete from storage.objects where name = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/a-trip-1.bin.gz' returning id $$, 'A cannot delete B trace object');
select is_empty($$ update storage.objects set name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.bin.gz' where bucket_id = 'traces' returning id $$, 'A cannot rename objects (no update policy, so no row is reachable)');
select lives_ok($$ delete from storage.objects where name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a-trip-1.bin.gz' $$, 'A can delete own trace object');
select is((select count(*)::int from storage.objects where bucket_id = 'traces'), 0, 'own trace object is gone; B object stays invisible');

-- ---------------------------------------------------------------------------
-- act as user B: A's actions never reached B, and A's data is invisible
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);
select is((select count(*)::int from public.trips), 2, 'B sees only own trips');
select is((select score from public.trips where client_trip_id = 'a-trip-1'), 88, 'B score untouched by A recomputes');
select is((select count(*)::int from public.trip_events where status <> 'scored'), 0, 'B events untouched by A disputes');
select is((select count(*)::int from public.event_disputes), 0, 'B has no disputes and sees none of A');
select is((select count(*)::int from public.score_daily), 3, 'B sees only own day rows');
select is((select count(*)::int from public.baselines), 1, 'B sees only own baselines');
select is((select count(*)::int from storage.objects where bucket_id = 'traces'), 1, 'B trace object survived A');

-- ---------------------------------------------------------------------------
-- authenticated role with a JWT that carries no sub: nothing is visible
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is((select count(*)::int from public.trips), 0, 'a JWT without sub sees no trips');
select is((select count(*)::int from public.trip_events), 0, 'a JWT without sub sees no events');
select is((select count(*)::int from public.score_daily), 0, 'a JWT without sub sees no day rows');
select is((select count(*)::int from storage.objects where bucket_id = 'traces'), 0, 'a JWT without sub sees no traces');

-- ---------------------------------------------------------------------------
-- act as anon: nothing
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select count(*) from public.trips $$, '42501', null, 'anon cannot read trips');
select throws_ok($$ select count(*) from public.trip_events $$, '42501', null, 'anon cannot read trip_events');
select throws_ok($$ select count(*) from public.event_disputes $$, '42501', null, 'anon cannot read event_disputes');
select throws_ok($$ select count(*) from public.score_daily $$, '42501', null, 'anon cannot read score_daily');
select throws_ok($$ select count(*) from public.baselines $$, '42501', null, 'anon cannot read baselines');
select throws_ok($$ select count(*) from public.map_feedback $$, '42501', null, 'anon cannot read map_feedback');
select throws_ok($$ select count(*) from public.rate_limits $$, '42501', null, 'anon cannot read rate_limits');
select throws_ok($$ select public.apply_trip('{}') $$, '42501', null, 'anon cannot call apply_trip');
select throws_ok($$ select public.count_dispute_allowance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$, '42501', null, 'anon cannot call count_dispute_allowance');
select is((select count(*)::int from storage.objects where bucket_id = 'traces'), 0, 'anon sees no traces');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('traces', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.bin.gz') $$, '42501', null, 'anon cannot write traces');

-- ---------------------------------------------------------------------------
-- server-side writes: updated_at moves on update through the touch triggers,
-- local_day re-derives on update, bounds hold against the server path too
-- ---------------------------------------------------------------------------
reset role;
insert into public.rate_limits (user_id, key, updated_at) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'probe', timestamptz '2020-01-01 00:00:00+00');
select is((select updated_at from public.rate_limits where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and key = 'probe'), timestamptz '2020-01-01 00:00:00+00', 'fixture rate limit starts with a stale updated_at');
update public.rate_limits set count = 1 where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and key = 'probe';
select is((select updated_at from public.rate_limits where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and key = 'probe'), now(), 'rate_limits.updated_at bumps on update');
insert into public.score_daily (user_id, day, updated_at) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', date '2020-01-01', timestamptz '2020-01-01 00:00:00+00');
update public.score_daily set trips_scored = 1 where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and day = date '2020-01-01';
select is((select updated_at from public.score_daily where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and day = date '2020-01-01'), now(), 'score_daily.updated_at bumps on update');
update public.trips set notes = 'server note', updated_at = timestamptz '2020-01-01 00:00:00+00' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1');
select is((select updated_at from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), now(), 'a supplied updated_at on trips is overwritten by the touch trigger');

-- local_day follows a server-side change of tz (10:00 Los Angeles is the next calendar day in Tokyo)
update public.trips set tz = 'Asia/Tokyo' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1');
select is((select local_day from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), (pg_temp.at_la(1, 10) at time zone 'Asia/Tokyo')::date, 'local_day re-derives when tz changes');
select is((select local_day from public.trips where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1')), pg_temp.la_day(0), 'the re-derived day moved forward by one');

-- bounds hold against the server path too (23514, never silent truncation)
select throws_ok($$ update public.trips set client_trip_id = '../x' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'client trip id outside the character class rejected');
select throws_ok($$ update public.trips set trace_path = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/other.bin.gz' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'a trace path that is not the derived key is rejected');
select throws_ok($$ update public.trips set notes = repeat('n', 501) where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'trip notes longer than 500 rejected');
select throws_ok($$ update public.trips set start_label = repeat('l', 81) where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'trip label longer than 80 rejected');
select throws_ok($$ update public.trips set polyline = repeat('p', 16385) where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'polyline over 16 KB rejected');
select throws_ok($$ update public.trips set category_deductions = '[1]' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'category_deductions must be a JSON object');
select throws_ok($$ update public.trips set category_deductions = (select jsonb_object_agg('k' || i, md5(i::text)) from generate_series(1, 100) i) where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'oversize category_deductions rejected');
select throws_ok($$ update public.trips set rows_digest = (select jsonb_object_agg('k' || i, md5(i::text)) from generate_series(1, 50) i) where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'oversize rows_digest rejected');
select throws_ok($$ update public.trips set score = 101 where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'score above 100 rejected by the table');
select throws_ok($$ update public.trips set status = 'bogus' where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'unknown trip status rejected by the table');
select throws_ok($$ update public.trips set distance_m = 3000000 where id = pg_temp.trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1') $$, '23514', null, 'distance above the ceiling rejected by the table');
select throws_ok($$ update public.trip_events set measured = (select jsonb_object_agg('k' || i, md5(i::text)) from generate_series(1, 50) i) where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1') $$, '23514', null, 'oversize event measured rejected');
select throws_ok($$ update public.trip_events set lat = 91 where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1') $$, '23514', null, 'latitude out of range rejected');
select throws_ok($$ update public.trip_events set severity = 101 where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1') $$, '23514', null, 'severity above the ceiling rejected');
select throws_ok($$ update public.trip_events set status = 'bogus' where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1') $$, '23514', null, 'unknown event status rejected by the table');
select throws_ok($$ update public.event_disputes set reason = 'bogus' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '23514', null, 'unknown dispute reason rejected by the table');
select throws_ok($$ update public.event_disputes set denied_reason = 'bogus' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '23514', null, 'unknown denied reason rejected by the table');
select throws_ok($$ update public.score_daily set band = 'bogus' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$, '23514', null, 'unknown band rejected by the table');
update public.trip_events set lat = 47.6062095, lng = -122.3320708 where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1');
select is((select lat::text from public.trip_events where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1')), '47.606', 'a full-precision latitude is rounded to 3 dp by the column type');
select is((select lng::text from public.trip_events where id = pg_temp.ev('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a-trip-1', 'ev-1')), '-122.332', 'a full-precision longitude is rounded to 3 dp by the column type');

select * from finish();
rollback;
