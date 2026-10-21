-- 0022_round7_scoring: the SQL rating matches the scoring package to the digit (category_score,
-- safety_rating and round_half_up pinned against packages/scoring rating.test.ts), the rating is
-- read from the drives' active events per category (handling units, stopped pickups, removed
-- events), the linear ratings are gone, a challenge pays 200, and dispute_context hands the
-- re-score the drive's durationS and scoringVersion.
create extension if not exists pgtap with schema extensions;

begin;
select plan(27);

-- ---------------------------------------------------------------------------
-- parity with packages/scoring (the TypeScript pins the same values)
-- ---------------------------------------------------------------------------
select is(private.category_score(40, 10, 10), 80::float8, 'one pickup (40) every 10 mi scores 80');
select is(private.category_score(10, 20, 10), 96.96969696969697::float8, 'one hard brake (10) every 20 mi scores 96.97');
select is(private.category_score(100, 10, 10), 61.53846153846154::float8, 'one severe speeding (100) every 10 mi scores 61.54');
select is(array[private.category_score(40, 20, 10), private.category_score(100, 20, 10)], array[88.88888888888889::float8, 76.19047619047619::float8], '40 and 100 over 20 mi');
select is(array[private.category_score(40, 3, 10), private.category_score(null, 10, 10), private.category_score(-5, 10, 10), private.category_score(40, null, 10)],
  array[80::float8, 100, 100, 80], 'the miles are floored; a null or negative penalty reads as 0, null miles as the floor');
select is(private.category_score(100000, 10, 10) > 0, true, 'a category is never 0');

select is(array[private.round_half_up(89.549999999999997, 1), private.round_half_up(12.499999999999998, 0), private.round_half_up(59.400000000000006, 1), private.round_half_up(2.5, 0)],
  array[89.6::float8, 13, 59.4, 3], 'round_half_up: half up (2.5 is 3, never half to even), immune to binary drift (12.499999999999998 is 12.5, so 13)');

-- safety_rating(acceleration, braking, turning, attention, phone, speed, miles, watched)
select is(private.safety_rating(0, 10, 0, 0, 40, 100, 20, 0), 89.6, 'a severe speeding, a pickup and a hard brake over 20 mi, no DashPal: 89.6');
select is(private.safety_rating(0, 10, 0, 40, 40, 100, 20, 20), 89.5, 'the same with DashPal watching all 20 mi and one eyes-off: 89.5');
select is(array[private.safety_rating(0, 0, 0, 0, 40, 0, 10, 0), private.safety_rating(0, 0, 0, 0, 400, 0, 100, 0), private.safety_rating(0, 0, 0, 0, 0, 100, 9, 0), private.safety_rating(0, 0, 0, 0, 0, 15, 15, 0)],
  array[94.3, 94.3, 89.0, 98.3], 'one pickup per 10 mi (phone use 80, double) 94.3 whatever the window; a severe speeding over 9 mi (floored at 10) 89.0; a minor speeding over 15 mi 98.3');
select is(private.safety_rating(1000, 1000, 1000, 0, 1000, 1000, 10, 0), 13.8, 'a terrible month still reads above 0: every category 13.8');
select is(array[private.safety_rating(0, 0, 0, 0, 0, 0, 0, 0), private.safety_rating(0, 0, 0, 0, 40, 0, 0, 0), private.safety_rating(0, 0, 0, 0, 0, 0, 9.9, 0), private.safety_rating(0, 0, 0, 0, 0, 0, 10, 0)],
  array[null, null, 100.0, 100.0], 'null with no miles; 100 with no events');
select is(array[private.safety_rating(0, 0, 0, 40, 0, 0, 20, 0), private.safety_rating(0, 0, 0, 40, 0, 0, 20, 2), private.safety_rating(0, 0, 0, 40, 0, 0, 40, 40)],
  array[100.0, 97.5, 99.3], 'Attention only with watched miles: an eyes-off over 2 watched mi counts as over 10 (80, one of eight weights); over 40 watched mi 94');

-- the event tables
select is(array[private.rating_penalty_of('speeding', 'minor', null, null), private.rating_penalty_of('speeding', 'moderate', null, null), private.rating_penalty_of('speeding', 'severe', null, null),
    private.rating_penalty_of('hard_brake', 'minor', null, null), private.rating_penalty_of('hard_brake', 'moderate', null, null), private.rating_penalty_of('hard_brake', 'severe', null, null),
    private.rating_penalty_of('hard_accel', 'minor', null, null), private.rating_penalty_of('hard_accel', 'severe', null, null),
    private.rating_penalty_of('hard_corner', 'minor', null, null), private.rating_penalty_of('hard_corner', 'severe', null, null),
    private.rating_penalty_of('phone_pickup', 'severe', null, null), private.rating_penalty_of('phone_pickup', 'severe', null, false), private.rating_penalty_of('phone_pickup', 'severe', null, true),
    private.rating_penalty_of('phone_handling', 'moderate', null, null), private.rating_penalty_of('phone_handling', 'severe', 3, null), private.rating_penalty_of('phone_handling', 'severe', 0, null), private.rating_penalty_of('phone_handling', 'severe', 5000, null),
    private.rating_penalty_of('eyes_off', 'severe', null, null), private.rating_penalty_of('drowsy', 'severe', null, null), private.rating_penalty_of('nope', 'severe', null, null)],
  array[15, 40, 100, 10, 10, 25, 15, 30, 10, 25, 40, 40, 20, 10, 30, 10, 14400, 40, 50, 0],
  'RATING_PENALTY: speeding 15/40/100, brake 10/25, accel 15/30, corner 10/25, pickup 40 (20 stopped), handling 10 a unit (null = 1, 1..1440), eyes off 40, drowsy 50');
select is(array[private.axis_of('speeding'), private.axis_of('hard_brake'), private.axis_of('hard_accel'), private.axis_of('hard_corner'), private.axis_of('phone_pickup'), private.axis_of('phone_handling'), private.axis_of('eyes_off'), private.axis_of('drowsy'), private.axis_of('nope')],
  array['speed', 'braking', 'acceleration', 'turning', 'phone', 'phone', 'attention', 'attention', null], 'axis_of: the radar category of every event type');

-- the linear ratings are gone
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric'], 'the 2-argument linear rating is gone');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric', 'numeric', 'numeric'], 'the 4-argument linear rating is gone');
select hasnt_function('private', 'attention_penalty_of', array['text'], 'attention_penalty_of is gone (rating_penalty_of covers it)');

-- ---------------------------------------------------------------------------
-- the rating from stored drives
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
create temporary table t as select now() - interval '2 days' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
create function pg_temp.rating() returns numeric language sql stable as $$
  select safety_rating from public.progress where user_id = '00000000-0000-0000-0000-000000000001' $$;

-- a scored drive through apply_drive: events are [{id, type, tier, units, stoppedInTraffic, penalty}] shorthand
create function pg_temp.drive(p_client uuid, p_started timestamptz, p_minutes int, p_miles numeric, p_net int, p_events jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
  v_bd jsonb;
  v_streak int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', floor(extract(epoch from p_started + interval '1 minute') * 1000)::bigint, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'units', (e ->> 'units')::int, 'stoppedInTraffic', (e ->> 'stoppedInTraffic')::boolean,
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb), 'status', 'active')), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'penalty', coalesce((e ->> 'penalty')::int, 10))), '[]'::jsonb) into v_bd from jsonb_array_elements(p_events) e;
  select streak into v_streak from public.progress where user_id = '00000000-0000-0000-0000-000000000001';
  return private.apply_drive(jsonb_build_object(
    'user', '00000000-0000-0000-0000-000000000001', 'mergeInto', null,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + make_interval(mins => p_minutes)) * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'safeMiles', p_miles, 'nightMiles', 0,
      'durationS', p_minutes * 60,
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', 'poly', 'appVersion', '2.0.0'),
    'scored', true, 'reason', null, 'net', p_net,
    'breakdown', jsonb_build_object('scored', true, 'net', p_net, 'ratingPenalty', 0, 'events', v_bd),
    'events', v_ev,
    'streak', jsonb_build_object('before', jsonb_build_object('streak', v_streak), 'after', jsonb_build_object('streak', v_streak + 1, 'atRisk', false, 'freezes', 2, 'cleanRun', 0),
      'outcome', 'grew', 'freezeEarned', false),
    'isLoop', false, 'loopRepeat', false, 'safeMilesEarlierToday', 0, 'scoringVersion', 6) || p_extra);
end $$;

select is(private.rating_window('00000000-0000-0000-0000-000000000001', now() - interval '30 days', now()), null, 'no drives: no rating');

-- 10 mi: a severe hard acceleration (30), a minor hard corner (10), 3 units of handling (30) and a pickup stopped in traffic (20),
-- a moderate speeding (40) and a minor hard brake (10, removed below): acceleration 84, turning 94, phone use 76, speed 80
select pg_temp.drive('11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 10, 100,
  '[{"id":"a1a1a1a1-0000-4000-8000-000000000001","type":"hard_accel","tier":"severe","penalty":24},
    {"id":"a1a1a1a1-0000-4000-8000-000000000002","type":"hard_corner","tier":"minor","penalty":8},
    {"id":"a1a1a1a1-0000-4000-8000-000000000003","type":"phone_handling","tier":"severe","units":3,"durationS":45,"penalty":24},
    {"id":"a1a1a1a1-0000-4000-8000-000000000004","type":"phone_pickup","tier":"severe","stoppedInTraffic":true,"penalty":16},
    {"id":"a1a1a1a1-0000-4000-8000-000000000005","type":"speeding","tier":"moderate","durationS":20,"penalty":32},
    {"id":"a1a1a1a1-0000-4000-8000-000000000006","type":"hard_brake","tier":"minor","penalty":8}]');
select is(pg_temp.rating(), private.safety_rating(30, 10, 10, 0, 50, 40, 10, 0), 'the rating is the per-category sums of the stored active events (units and stopped read)');
select is(pg_temp.rating(), 83.5, 'which is 83.5');
update public.trip_events set status = 'removed' where client_event_id = 'a1a1a1a1-0000-4000-8000-000000000006';
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is(pg_temp.rating(), 84.4, 'a removed event (an accepted dispute) counts nothing: braking back to 100');
-- a second drive, 10 more clean miles: every category over 20 mi
select pg_temp.drive('22222222-2222-4222-8222-222222222222', pg_temp.t0() + interval '2 hours', 30, 10, 200, '[]');
select is(pg_temp.rating(), private.safety_rating(30, 0, 10, 0, 50, 40, 20, 0), 'the window sums every kept scored drive');
select is((select row(miles_30d, rating_penalty_30d, ranked)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(20.00, 0.00, true)::text,
  'miles, the breakdown penalty stat and ranked are untouched');

-- ---------------------------------------------------------------------------
-- dispute_context hands the re-score the drive's length and scoring version
-- ---------------------------------------------------------------------------
select pg_temp.drive('33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '4 hours', 6, 0.3, 3,
  '[{"id":"b1b1b1b1-0000-4000-8000-000000000001","type":"hard_brake","tier":"minor","penalty":4}]', '{"scoringVersion": 5}');
select is((select (d -> 'rescore' -> 'input') - 'events' from private.dispute_context('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', 'b1b1b1b1-0000-4000-8000-000000000001', 'hazard') d),
  '{"miles": 0.30, "dashcam": false, "durationS": 360, "safeMiles": 0.30, "loopRepeat": false, "scoringVersion": 5}'::jsonb,
  'the re-score input carries durationS (6 min) and the version the drive was scored under (5)');
select is((select d -> 'rescore' -> 'input' -> 'events' #>> '{0,status}' from private.dispute_context('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', 'b1b1b1b1-0000-4000-8000-000000000001', 'hazard') d),
  'removed', 'with the disputed event marked removed, as before');

-- ---------------------------------------------------------------------------
-- a challenge pays 200
-- ---------------------------------------------------------------------------
select is((select prosrc like '%200%' and prosrc not like '%100,%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'complete_challenges'),
  true, 'complete_challenges credits 200 (its completion is exercised in 0004_engagement)');

select * from finish();
rollback;
