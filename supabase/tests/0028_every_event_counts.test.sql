-- 0028_every_event_counts: scoring version 9. Every event that qualifies weighs on its category, and
-- more for a more severe one: speeding counts every second over the line (no grace), a hard event
-- weighs (peak / threshold)^2 between 1 and 4, a phone pickup and a DashPal event weigh more the
-- faster the car was going, a DashPal event more the longer it lasted. The helpers agree with
-- packages/scoring to the digit (rating.test.ts "the severity of the other events" and pin Q); the
-- new functions run as their caller, pin search_path and are closed to the API roles.
create extension if not exists pgtap with schema extensions;

begin;
select plan(22);
-- the scores travel in jsonb: read them back exactly (the test runner's session prints 15 digits)
set local extra_float_digits = 1;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- a drive through apply_drive: started p_start, p_dur seconds long, p_miles; events are
-- [{id, type, tier?, durationS?, measured?, at? (s in)}]; p_payload is merged into the payload, p_env into the envelope
create function pg_temp.drive(p_user uuid, p_client uuid, p_start timestamptz, p_dur int, p_miles numeric, p_events jsonb,
  p_payload jsonb default '{}'::jsonb, p_env jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ms bigint := floor(extract(epoch from p_start) * 1000)::bigint;
  v_ev jsonb;
  v_pl jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', v_ms + (coalesce((e ->> 'at')::numeric, 60) * 1000)::bigint, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb))), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  v_pl := jsonb_build_object('clientTripId', p_client, 'startedAt', v_ms, 'endedAt', v_ms + p_dur * 1000::bigint, 'tz', 'America/Los_Angeles',
      'localDay', to_char(p_start at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'miles', p_miles, 'nightMiles', 0, 'durationS', p_dur,
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', '', 'appVersion', '3.2.0', 'origin', 'auto', 'notDrivingExpired', false) || p_payload;
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', null, 'dashcam', null, 'payload', v_pl,
    'scored', true, 'reason', null, 'events', v_ev, 'scoringVersion', 9) || p_env);
end $$;
create function pg_temp.scores(p_user uuid) returns float8[] language sql stable as $$
  select array[(r ->> 'rating')::float8, (s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8,
      (s ->> 'attention')::float8, (s ->> 'phone')::float8, (s ->> 'speed')::float8]
  from (select r, r -> 'scores' as s from (select private.rating_at(p_user, now()) as r) y) x $$;

-- ---------------------------------------------------------------------------
-- posture catch-alls
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public or private lacks RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0,
  'every security definer function is owned by postgres and pins search_path=public');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no API role can execute anything in private (the new weights included)');
select is((select array_agg(p.proname::text || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') order by p.proname)
    from pg_proc p where p.pronamespace = 'private'::regnamespace
      and p.proname in ('speed_factor', 'hard_event_weight', 'phone_pickup_weight', 'attention_weight')),
  array['attention_weight:false:search_path=public', 'hard_event_weight:false:search_path=public', 'phone_pickup_weight:false:search_path=public',
    'speed_factor:false:search_path=public'],
  'the four new helpers exist, run as their caller and pin search_path');
select col_default_is('public', 'trips', 'scoring_version', '9', 'scoring version 9');

-- ---------------------------------------------------------------------------
-- the weights, to the digit (packages/scoring rating.test.ts pins the same values)
-- ---------------------------------------------------------------------------
select is(array[private.speed_factor(30), private.speed_factor(60), private.speed_factor(10), private.speed_factor(4), private.speed_factor(120), private.speed_factor(null)],
  array[1, 2, 0.3333333333333333, 0.3333333333333333, 2.6666666666666665, 1]::float8[], 'speed_factor: the speed over 30 mph, read between 10 and 80; 1 with none');
select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36}'), private.hard_event_weight('hard_accel', 'severe', '{"peakG": 0.5}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.47}'), private.hard_event_weight('hard_brake', 'severe', '{"peakG": 0.62}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.2}'), private.hard_event_weight('hard_brake', 'severe', '{}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": "x"}')],
  array[1.44, 2.44140625, 1.3806249999999995, 4, 1, 2, 1]::float8[], 'hard_event_weight: (peak / threshold)^2 between 1 and 4; the tier without a peak');
select is(array[private.speeding_weight(1, '{"overMphS": 1}', 'minor'), private.speeding_weight(3, '{"overMphS": 4.5}', 'minor'), private.speeding_weight(5, '{"overMphS": 65}', 'severe')],
  array[0.08944271909999159, 0.49295030175464943, 5 * (13 / 5.0)::float8 * sqrt((13 / 5.0)::float8)]::float8[],
  'speeding_weight: no grace, one second just over the line weighs a little and five seconds count all five');
select is(array[private.phone_pickup_weight(6, '{"speedMph": 22, "maxSpeedMph": 52.5}'), private.phone_pickup_weight(6, '{"speedMph": 45}'), private.phone_pickup_weight(6, '{}')],
  array[28, 24, 16]::float8[], 'phone_pickup_weight: (10 + seconds in hand) x the speed factor of its top speed, else its start speed, else 1');
select is(array[private.attention_weight('eyes_off', 12.5, '{"source": "dashcam", "speedMph": 47.3}'), private.attention_weight('drowsy', 3, '{"source": "dashcam", "speedMph": 61}'),
    private.attention_weight('eyes_off', 2, '{"source": "dashcam"}'), private.attention_weight('drowsy', 60, '{"speedMph": 90}'), private.attention_weight('hard_brake', 2, '{}')],
  array[157.66666666666666, 101.66666666666666, 40, 399.99999999999994, 0]::float8[], 'attention_weight: the base x the speed factor x the length over 5 s (1 to 3)');
select is(array[private.event_weight_of('hard_brake', 'minor', 2, '{"peakG": 0.36}'), private.event_weight_of('phone_pickup', 'moderate', 6, '{"speedMph": 22, "maxSpeedMph": 52.5}'),
    private.event_weight_of('speeding', 'minor', 3, '{"overMphS": 4.5}'), private.event_weight_of('eyes_off', 'severe', 12.5, '{"speedMph": 47.3}')],
  array[1.44, 28, 0.49295030175464943, 0]::float8[], 'event_weight_of dispatches to the new weights; a DashPal event weighs on Attention only');

-- ---------------------------------------------------------------------------
-- pin Q (ava): one drive with every kind of event at its own severity, watched by DashPal
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000aa', now() - interval '1 hour', 3600, 15,
  '[{"id":"a1000000-0000-4000-8000-000000000001","type":"hard_brake","measured":{"peakG":0.36},"at":60},
    {"id":"a1000000-0000-4000-8000-000000000002","type":"hard_brake","tier":"severe","measured":{"peakG":0.62},"at":120},
    {"id":"a1000000-0000-4000-8000-000000000003","type":"hard_accel","measured":{"peakG":0.4},"at":180},
    {"id":"a1000000-0000-4000-8000-000000000004","type":"hard_corner","tier":"severe","measured":{"peakG":0.5},"at":240},
    {"id":"a1000000-0000-4000-8000-000000000005","type":"speeding","durationS":3,"measured":{"overMphS":4.5},"at":300},
    {"id":"a1000000-0000-4000-8000-000000000006","type":"speeding","tier":"moderate","durationS":12,"measured":{"overMphS":72},"at":400},
    {"id":"a1000000-0000-4000-8000-000000000007","type":"phone_pickup","tier":"moderate","durationS":6,"measured":{"speedMph":22,"maxSpeedMph":52.5},"at":500},
    {"id":"a1000000-0000-4000-8000-000000000008","type":"eyes_off","tier":"severe","durationS":12.5,"measured":{"source":"dashcam","speedMph":47.3},"at":600},
    {"id":"a1000000-0000-4000-8000-000000000009","type":"drowsy","tier":"severe","durationS":3,"measured":{"source":"dashcam","speedMph":61},"at":700}]',
  jsonb_build_object('exposure', jsonb_build_object('slowdowns', 20, 'speedups', 18, 'turns', 11, 'limitS', 1500, 'movingS', 1800, 'phoneS', 1700)),
  '{"dashcam": {"deviceId": "a4c1380f2b7e", "movingS": 1800, "coveredS": 1800, "synced": true, "on": true}}'::jsonb);
select is((select row(n_events, n_speeding, clean, scoring_version)::text from public.trips where client_trip_id = 'a0000000-0000-4000-8000-0000000000aa'),
  row(7, 2, false, 9)::text, 'the 3-second speeding is an event like the rest: it is counted and breaks a clean drive');
select is(pg_temp.scores('00000000-0000-0000-0000-000000000001'),
  array[70.8, 63.38621493232948, 42.875157629255995, 61.17781227230969, 48.06408544726301, 87.4757281553398, 87.82410285072866]::float8[],
  'pin Q: 70.8 and every category to the digit (scoring ratingAt)');
select is((select safety_rating from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), 70.8, 'the stored rating is the new one');
-- a short episode weighs on Speed: taking it away raises the score
update public.trip_events set status = 'removed' where client_event_id = 'a1000000-0000-4000-8000-000000000005';
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' ->> 'speed')::float8, '>', 87.82410285072866::float8,
  'the 3-second speeding weighed on Speed');
update public.trip_events set status = 'active' where client_event_id = 'a1000000-0000-4000-8000-000000000005';
-- a harder brake weighs more: the same drive with the severe brake at its threshold reads higher on Braking
update public.trip_events set measured = '{"peakG": 0.45}' where client_event_id = 'a1000000-0000-4000-8000-000000000002';
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' ->> 'braking')::float8, '>', 42.875157629255995::float8,
  'a softer peak weighs less on Braking');
update public.trip_events set measured = '{"peakG": 0.62}' where client_event_id = 'a1000000-0000-4000-8000-000000000002';
-- a pickup at a lower speed weighs less on Phone use
update public.trip_events set measured = '{"speedMph": 15, "maxSpeedMph": 20}' where client_event_id = 'a1000000-0000-4000-8000-000000000007';
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' ->> 'phone')::float8, '>', 87.4757281553398::float8,
  'a pickup at 20 mph weighs less than one at 52.5');
update public.trip_events set measured = '{"speedMph": 22, "maxSpeedMph": 52.5}' where client_event_id = 'a1000000-0000-4000-8000-000000000007';
-- a shorter DashPal episode weighs less on Attention
update public.trip_events set duration_s = 4 where client_event_id = 'a1000000-0000-4000-8000-000000000008';
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' ->> 'attention')::float8, '>', 48.06408544726301::float8,
  'a 4-second eyes-off weighs less than a 12.5-second one');
update public.trip_events set duration_s = 12.5 where client_event_id = 'a1000000-0000-4000-8000-000000000008';
select is(pg_temp.scores('00000000-0000-0000-0000-000000000001'),
  array[70.8, 63.38621493232948, 42.875157629255995, 61.17781227230969, 48.06408544726301, 87.4757281553398, 87.82410285072866]::float8[],
  'and back as it was');

-- ---------------------------------------------------------------------------
-- relative to the drive: one event marks a long drive down less than a short one
-- ---------------------------------------------------------------------------
-- ben: the same 12-second moderate speeding on a 20-minute and on a 2-hour drive (one drive at a time)
select pg_temp.drive('00000000-0000-0000-0000-000000000002', 'b0000000-0000-4000-8000-0000000000b1', now() - interval '3 hours', 1200, 10,
  '[{"id":"b1000000-0000-4000-8000-000000000001","type":"speeding","tier":"moderate","durationS":12,"measured":{"overMphS":72},"at":300}]',
  jsonb_build_object('exposure', jsonb_build_object('slowdowns', 10, 'speedups', 10, 'turns', 6, 'limitS', 1000, 'movingS', 1150, 'phoneS', 0)));
create temporary table short_drive as select (private.rating_at('00000000-0000-0000-0000-000000000002', now()) -> 'scores' ->> 'speed')::float8 as speed;
delete from public.trips where user_id = '00000000-0000-0000-0000-000000000002';
select pg_temp.drive('00000000-0000-0000-0000-000000000002', 'b0000000-0000-4000-8000-0000000000b2', now() - interval '3 hours', 7200, 60,
  '[{"id":"b2000000-0000-4000-8000-000000000001","type":"speeding","tier":"moderate","durationS":12,"measured":{"overMphS":72},"at":300}]',
  jsonb_build_object('exposure', jsonb_build_object('slowdowns', 60, 'speedups', 60, 'turns', 36, 'limitS', 6000, 'movingS', 6900, 'phoneS', 0)));
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000002', now()) -> 'scores' ->> 'speed')::float8, '>', (select speed from short_drive),
  'the same speeding marks a 2-hour drive down less than a 20-minute one');
select cmp_ok((select speed from short_drive), '<', 87.48261474269819::float8, 'and the short one is marked down: no speeding is free');

-- the API roles still cannot reach the helpers
select is(array[has_function_privilege('authenticated', 'private.attention_weight(text, numeric, jsonb)', 'execute'),
    has_function_privilege('anon', 'private.hard_event_weight(text, text, jsonb)', 'execute'),
    has_function_privilege('authenticated', 'private.phone_pickup_weight(numeric, jsonb)', 'execute'),
    has_function_privilege('anon', 'private.speed_factor(double precision)', 'execute')],
  array[false, false, false, false], 'the new weights are closed to anon and authenticated');

select * from finish();
rollback;
