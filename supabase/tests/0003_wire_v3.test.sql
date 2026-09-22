-- 0003_wire_v3: the `role_unknown` unscored reason and the scoring-version pin on apply_recompute.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating the statement keeps
-- this file runnable on its own.
create extension if not exists pgtap with schema extensions;

begin;
select plan(39);

-- ---------------------------------------------------------------------------
-- fixtures (run as the migration owner): two auth users and an apply_trip envelope builder shaped
-- like FinalizeTripPayload at HEAD (src/data/sync/payload.ts, contract v3). Trip times are fixed
-- hours of a recent Los Angeles day so nothing drifts with the wall clock.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'w3a@example.com', '{"display_name":"Ada"}'),
  ('b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', 'w3b@example.com', '{"display_name":"Bo"}');

create function pg_temp.at_la(p_days_ago int, p_hour int) returns timestamptz
language sql as $$
  select (((now() at time zone 'America/Los_Angeles')::date - p_days_ago)::timestamp + make_interval(hours => p_hour)) at time zone 'America/Los_Angeles'
$$;

create function pg_temp.envelope(p_user uuid, p_client text, p_role text, p_score int, p_status text, p_reason text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from pg_temp.at_la(1, 10)) * 1000)::bigint,
      'endedAt', floor(extract(epoch from pg_temp.at_la(1, 10) + interval '15 minutes') * 1000)::bigint,
      'tz', 'America/Los_Angeles',
      'distanceM', 12500.5, 'durationS', 900,
      'role', p_role, 'roleConfidence', 0.5, 'roleSource', 'auto',
      'mode', 'pocket', 'cameraSession', false,
      'provisional', jsonb_build_object('score', p_score, 'status', p_status, 'exposure', 1.25, 'dataQuality', 'A',
        'categoryDeductions', '{"phone":0,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
        'eventDeductions', '{}'::jsonb, 'scoringVersion', 1) || jsonb_strip_nulls(jsonb_build_object('reason', p_reason)),
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'ev-1', 'category', 'phone', 'startedAt', floor(extract(epoch from pg_temp.at_la(1, 10) + interval '5 minutes') * 1000)::bigint,
        'durationS', 12, 'durationMs', 12000, 'q', 0.9, 'corrected', false, 'status', 'scored',
        'measured', '{"speedMps": 15.6}'::jsonb, 'context', '{"night": false, "precipitation": false}'::jsonb,
        'contextMultiplier', 1, 'severity', 1, 'deduction', null,
        'lat', 47.606, 'lng', -122.332, 'alertShown', false, 'source', 'os')),
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true,
        'maxSustainedSpeedMps', 20, 'sha256', repeat('a', 64)),
      'limitCoveragePct', 80,
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb',
      'polyline', '',
      'tracePath', null,
      'hadSevereEvent', false,
      'incomplete', false),
    'scored', jsonb_build_object('score', p_score, 'status', p_status, 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', '{}'::jsonb, 'scoringVersion', 1) || jsonb_strip_nulls(jsonb_build_object('reason', p_reason)),
    'conditions', '{"night": false, "precipitation": false}'::jsonb,
    'day', jsonb_build_object(
      'day', (pg_temp.at_la(1, 10) at time zone 'America/Los_Angeles')::date,
      'longTermScore', 80, 'band', 'good', 'provisional', true,
      'safeDay', false, 'goodDay', false, 'phoneFreeDay', true, 'cameraDay', false,
      'exposure', 0, 'drivingS', 0, 'tripsScored', 0, 'severeEvents', 0),
    'baselines', null)
$$;

create function pg_temp.trip(p_user uuid, p_client text) returns uuid
language sql as $$ select id from public.trips where user_id = p_user and client_trip_id = p_client $$;

create function pg_temp.ev(p_user uuid, p_client text) returns uuid
language sql as $$
  select e.id from public.trip_events e join public.trips t on t.id = e.trip_id
  where t.user_id = p_user and t.client_trip_id = p_client and e.client_event_id = 'ev-1'
$$;

-- a recompute envelope for the fixture trip: final 90, the event scored at 10 points
create function pg_temp.rescored(p_version jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('score', 90, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
    'categoryDeductions', '{"phone":10,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
    'eventDeductions', '{"ev-1": 10}'::jsonb)
    || case when p_version is null then '{}'::jsonb else jsonb_build_object('scoringVersion', p_version) end
$$;

create function pg_temp.events_of(p_user uuid, p_client text) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('id', pg_temp.ev(p_user, p_client), 'status', 'scored', 'deduction', 10)) $$;

grant execute on function pg_temp.at_la(int, int), pg_temp.envelope(uuid, text, text, int, text, text), pg_temp.trip(uuid, text),
  pg_temp.ev(uuid, text), pg_temp.rescored(jsonb), pg_temp.events_of(uuid, text)
  to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- schema posture: the migration adds no table, and the redefined writer keeps its guarantees
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'no table in public is missing RLS');
select col_has_check('public', 'trips', 'unscored_reason', 'trips.unscored_reason is an enum check');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'trips_unscored_reason_check' and conrelid = 'public.trips'::regclass),
  'CHECK ((unscored_reason = ANY (ARRAY[''passenger''::text, ''role_unknown''::text, ''too_short''::text, ''grade_c''::text, ''implausible_speed''::text])))',
  'the unscored_reason CHECK is exactly the five reasons the scorer produces');
select is_definer('public', 'apply_recompute', array['uuid', 'uuid', 'jsonb', 'jsonb', 'jsonb', 'jsonb']::name[], 'apply_recompute is still security definer');
select function_owner_is('public', 'apply_recompute', array['uuid', 'uuid', 'jsonb', 'jsonb', 'jsonb', 'jsonb']::name[], 'postgres', 'apply_recompute is still owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)'::regprocedure), array['search_path=public'], 'apply_recompute still pins search_path');
select is(has_function_privilege('anon', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), false, 'anon cannot execute apply_recompute');
select is(has_function_privilege('authenticated', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), false, 'authenticated cannot execute apply_recompute');
select is(has_function_privilege('service_role', 'public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb)', 'execute'), true, 'service_role can execute apply_recompute');
select is(
  (select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');

-- ---------------------------------------------------------------------------
-- role_unknown: an auto-detected drive whose role is unclear is stored unscored with that reason
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok($$ select public.apply_trip(pg_temp.envelope('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown', 'unknown', null, 'unscored', 'role_unknown')) $$,
  'apply_trip stores an unknown-role drive unscored as role_unknown');
select is((select role from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown')), 'unknown', 'the role is stored as unknown');
select is((select status from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown')), 'unscored', 'the drive is unscored');
select is((select unscored_reason from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown')), 'role_unknown', 'the reason is role_unknown');
select is((select score from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown')), null, 'an unknown-role drive carries no score');
select throws_ok($$ select public.apply_trip(pg_temp.envelope('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-bogus', 'unknown', null, 'unscored', 'role_unclear')) $$,
  '23514', null, 'a reason the scorer does not produce fails closed on the table CHECK (a row code, 400)');
select is((select count(*)::int from public.trips where client_trip_id = 'a-bogus'), 0, 'the refused drive wrote nothing');
-- a recompute can store the reason too (a role answer that leaves the drive unscored)
select lives_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown'),
  '{"score": null, "status": "unscored", "reason": "role_unknown", "categoryDeductions": {}, "scoringVersion": 1}', null, null, null) $$,
  'apply_recompute accepts role_unknown as a reason');
select is((select unscored_reason from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-unknown')), 'role_unknown', 'the recompute kept role_unknown');

-- ---------------------------------------------------------------------------
-- the scoring-version pin: apply_recompute keeps the stored version and refuses another one
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.apply_trip(pg_temp.envelope('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v', 'driver', 95, 'final', null)) $$, 'A drive scored under version 1');
select is((select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('1'), pg_temp.events_of('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'), null, null) ->> 'score'),
  '90', 'a re-score under the stored version is applied');
select is((select scoring_version from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 1, 'the stored version is kept');

-- the trip moves to version 2 behind the writer's back (as a future apply_trip under v2 would store it)
reset role;
update public.trips set scoring_version = 2 where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v');
set local role service_role;

select throws_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    jsonb_set(pg_temp.rescored('1'), '{score}', '40'), jsonb_set(pg_temp.events_of('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'), '{0,deduction}', '3'),
    jsonb_build_object('day', (pg_temp.at_la(1, 10) at time zone 'America/Los_Angeles')::date, 'longTermScore', 12, 'band', 'needs_focus', 'provisional', true,
      'safeDay', false, 'goodDay', false, 'phoneFreeDay', true, 'cameraDay', false, 'exposure', 0, 'drivingS', 0, 'tripsScored', 0, 'severeEvents', 0),
    '{"medians": {"phone": 9}}') $$,
  '22023', 'scoring_version_mismatch', 'a re-score under another version is refused with the fixed code and message');
select is((select score from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 90, 'the refused re-score left the score alone');
select is((select scoring_version from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 2, 'and the stored version');
select is((select deduction from public.trip_events where id = pg_temp.ev('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 10::numeric, 'and the event rows');
select is((select long_term_score from public.score_daily where user_id = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'), 80, 'and the day row it carried');
select is((select count(*)::int from public.baselines where user_id = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'), 0, 'and wrote no baselines');
select throws_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('3'), null, null, null) $$,
  '22023', 'scoring_version_mismatch', 'a newer version than the stored one is refused too');
select throws_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('null'), null, null, null) $$,
  '22023', 'scoring_version_mismatch', 'a null version is not the stored one');
select throws_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('"2"'), null, null, null) $$,
  '22023', 'scoring_version_mismatch', 'a version sent as a string is not the stored number');
select is((select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    jsonb_set(pg_temp.rescored('2'), '{score}', '88'), null, null, null) ->> 'score'),
  '88', 'a re-score under the stored version 2 is applied');
select is((select scoring_version from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 2, 'and still stores version 2');
select lives_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored(null), null, null, null) $$,
  'a re-score that names no version is applied under the stored one');
select is((select scoring_version from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 2, 'and the stored version stands');
-- the post-delete day refresh re-scores nothing, so no version is asked of it
select lives_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    null, null, null, null) $$,
  'a day refresh on a trip of another version is not refused');
-- the pin is checked after ownership: another user's trip reads as not owned, whatever its version
select throws_ok($$ select public.apply_recompute('b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('1'), null, null, null) $$,
  '42501', 'trip not owned by user', 'B asking to re-score A trip under a wrong version learns only that it is not theirs');
select is((select score from public.trips where id = pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v')), 90, 'and A trip is untouched');

-- the role guard still runs first
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3"}', true);
select throws_ok($$ select public.apply_recompute('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', pg_temp.trip('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'a-v'),
    pg_temp.rescored('9'), null, null, null) $$,
  '42501', 'apply_recompute requires the service role', 'a non-service claim is refused before the version is looked at');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

reset role;
select * from finish();
rollback;
