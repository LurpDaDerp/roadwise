-- 0026_phone_use: phone use by motion. The schema stores a drive's phone seconds and its pickups;
-- Phone use agrees with packages/scoring to the digit (the pins of rating.test.ts "ratingAt: Phone
-- use"); it has no score until a drive was watched for it, so every earlier drive rates as before;
-- apply_drive takes the v5 counters (a v4 upload has no phone seconds) and holds phone_s to the drive
-- as limit_s is held; a pickup is checked; "My phone was mounted" reports a pickup under the hazard
-- and wrong-limit quota; the context, the drive list and the profile say so.
create extension if not exists pgtap with schema extensions;

begin;
select plan(62);
-- the scores travel in jsonb: read them back exactly (the test runner's session prints 15 digits)
set local extra_float_digits = 1;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com'),
  ('00000000-0000-0000-0000-000000000005', 'e@example.com'),
  ('00000000-0000-0000-0000-000000000006', 'f@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'cat', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'dan', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000004';
update public.profiles set username = 'eve', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000005';
update public.profiles set username = 'fay', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000006';

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
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', '', 'appVersion', '3.1.0', 'origin', 'auto', 'notDrivingExpired', false) || p_payload;
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', null, 'dashcam', null, 'payload', v_pl,
    'scored', true, 'reason', null, 'events', v_ev, 'scoringVersion', 8) || p_env);
end $$;
-- the upload's counters: v5 with phoneS, v4 (p_phone null) without it
create function pg_temp.exp(a int, b int, c int, d int, e int, p_phone int default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('exposure', jsonb_build_object('slowdowns', a, 'speedups', b, 'turns', c, 'limitS', d, 'movingS', e)
    || case when p_phone is null then '{}'::jsonb else jsonb_build_object('phoneS', p_phone) end) $$;
create function pg_temp.t(p_client uuid) returns public.trips language sql stable as $$ select * from public.trips where client_trip_id = p_client $$;
create function pg_temp.scores(p_user uuid) returns float8[] language sql stable as $$
  select array[(r ->> 'rating')::float8, (s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8,
      (s ->> 'attention')::float8, (s ->> 'phone')::float8, (s ->> 'speed')::float8]
  from (select r, r -> 'scores' as s from (select private.rating_at(p_user, now()) as r) y) x $$;

-- ---------------------------------------------------------------------------
-- the schema
-- ---------------------------------------------------------------------------
select col_not_null('public', 'trips', 'phone_s', 'every drive holds its phone seconds');
select col_default_is('public', 'trips', 'phone_s', '0', 'a drive stored before phone tracking has none');
select col_default_is('public', 'trips', 'scoring_version', '9', 'scoring version 9 (since 0028)');
select is(array[private.axis_of('speeding'), private.axis_of('hard_brake'), private.axis_of('hard_accel'), private.axis_of('hard_corner'), private.axis_of('phone_pickup'),
    private.axis_of('eyes_off'), private.axis_of('drowsy'), private.axis_of('phone_handling'), private.axis_of('nope')],
  array['speed', 'braking', 'acceleration', 'turning', 'phone', 'attention', 'attention', null, null], 'axis_of: a phone pickup counts toward Phone use (scoring axisOf)');
select is(array[private.event_weight_of('phone_pickup', 'moderate', 8, '{}'), private.event_weight_of('phone_pickup', 'severe', 24, '{}'),
    private.event_weight_of('phone_pickup', 'severe', 2.5, '{}'), private.event_weight_of('phone_pickup', 'moderate', -5, '{}'),
    private.event_weight_of('phone_pickup', 'severe', 50000, '{}'), private.event_weight_of('phone_pickup', 'severe', null, '{}'),
    private.event_weight_of('phone_handling', 'severe', 30, '{}'), private.event_weight_of('hard_brake', 'severe', 2, '{}')],
  array[18, 34, 12.5, 10, 43210, 10, 0, 2]::float8[], 'event_weight_of: a pickup 10 + its seconds in hand (0..43 200); phone handling nothing (scoring eventWeight)');
select is(private.drive_context('00000000-0000-0000-0000-000000000006', 'f0000000-0000-4000-8000-0000000000ff', now() - interval '1 hour', current_date, 47.6, -122.3, now())
    - 'existing' - 'merge', '{"version": 23, "phoneUse": true}'::jsonb, 'drive_context says this database stores phone use');

-- ---------------------------------------------------------------------------
-- pin P (ava): three drives watched for phone use, three pickups, one removed by a mounted report
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a1', now() - interval '1 hour', 3600, 6,
  '[{"id":"a1000000-0000-4000-8000-000000000001","type":"phone_pickup","tier":"moderate","durationS":8,"measured":{"speedMph":24.5,"maxSpeedMph":31.2},"at":120},
    {"id":"a1000000-0000-4000-8000-000000000002","type":"hard_brake","at":180},
    {"id":"a1000000-0000-4000-8000-000000000003","type":"phone_pickup","tier":"severe","durationS":24,"measured":{"speedMph":40.1,"maxSpeedMph":44.8},"at":300}]',
  pg_temp.exp(15, 15, 9, 840, 1136, 900));
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a2', now() - interval '5 days', 3600, 25,
  '[{"id":"a2000000-0000-4000-8000-000000000001","type":"phone_pickup","tier":"severe","durationS":40,"at":200},
    {"id":"a2000000-0000-4000-8000-000000000002","type":"phone_pickup","tier":"severe","durationS":60,"at":900},
    {"id":"a2000000-0000-4000-8000-000000000003","type":"speeding","durationS":30,"measured":{"overMphS":125},"at":1200}]',
  pg_temp.exp(45, 45, 25, 2400, 3300, 2700));
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a3', now() - interval '30 days', 3600, 12, '[]',
  pg_temp.exp(20, 20, 12, 1500, 1900, 1600));
select is((select array_agg(row(phone_s, n_events, clean)::text order by started_at) from public.trips where user_id = '00000000-0000-0000-0000-000000000001'),
  array[row(1600, 0, true)::text, row(2700, 3, false)::text, row(900, 3, false)::text], 'the drives keep their phone seconds; a pickup is an event and breaks a clean drive');
select is((select array_agg(row(type, tier, duration_s, measured)::text order by started_at) from public.trip_events where trip_id = (pg_temp.t('a0000000-0000-4000-8000-0000000000a1')).id),
  array[row('phone_pickup', 'moderate', 8.0, '{"speedMph": 24.5, "maxSpeedMph": 31.2}'::jsonb)::text, row('hard_brake', 'minor', 2.0, '{}'::jsonb)::text,
    row('phone_pickup', 'severe', 24.0, '{"speedMph": 40.1, "maxSpeedMph": 44.8}'::jsonb)::text],
  'a pickup is stored with its tier, its seconds in hand and its speeds');
create temporary table m1 as select private.dispute_event('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'mounted') as d;
select is((select d - 'rating' - 'tripId' from m1), '{"eventId": "a2000000-0000-4000-8000-000000000002", "status": "accepted", "rejectReason": null, "quotaLeft": 2, "clean": false}'::jsonb,
  '"My phone was mounted" on a pickup is accepted, from the weekly quota hazard and wrong-limit reports share');
select is((select row(status, (select n_events from pg_temp.t('a0000000-0000-4000-8000-0000000000a2')))::text from public.trip_events where client_event_id = 'a2000000-0000-4000-8000-000000000002'),
  row('removed', 2)::text, 'the pickup is removed and the drive''s events recounted');
select is(pg_temp.scores('00000000-0000-0000-0000-000000000001'),
  array[88.3, 91.9280828053141, 81.02731927681675, 89.93932012720053, null, 86.73833371909146, 90.7045529239451]::float8[],
  'pin P: 88.3, Phone use 86.73833371909146 (each pickup weighed by its top speed since 0028) and every category to the digit (scoring ratingAt)');
select is((select row(safety_rating, ranked, miles_90d)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(88.3, true, 43.00)::text,
  'the stored rating counts Phone use');
select is(private.dispute_event('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'mounted'), (select d from m1),
  'a repeat of the report answers what was stored');

-- P1 alone (ben), its pickups with no measured speed (a speed factor of 1): the phone axis by hand, 52 + 144 over 900 + 3600
select pg_temp.drive('00000000-0000-0000-0000-000000000002', 'b0000000-0000-4000-8000-0000000000b1', now() - interval '1 hour', 3600, 6,
  '[{"id":"b1000000-0000-4000-8000-000000000001","type":"phone_pickup","tier":"moderate","durationS":8,"at":120},
    {"id":"b1000000-0000-4000-8000-000000000002","type":"hard_brake","at":180},
    {"id":"b1000000-0000-4000-8000-000000000003","type":"phone_pickup","tier":"severe","durationS":24,"at":300}]',
  pg_temp.exp(15, 15, 9, 840, 1136, 900));
select is(pg_temp.scores('00000000-0000-0000-0000-000000000002'),
  array[84.2, 87.62886597938144, 72.64957264957265, 86.69623059866963, null, 83.88157894736842, 87.48261474269819]::float8[], 'pin P1: 84.2, Phone use 83.88157894736842');

-- ---------------------------------------------------------------------------
-- not tracked, no score (cat, dan)
-- ---------------------------------------------------------------------------
-- a v4 upload: no phoneS, no pickup
select pg_temp.drive('00000000-0000-0000-0000-000000000003', 'c0000000-0000-4000-8000-0000000000c1', now() - interval '1 hour', 3600, 6, '[]', pg_temp.exp(15, 15, 9, 840, 1136));
select is((pg_temp.t('c0000000-0000-4000-8000-0000000000c1')).phone_s, 0, 'a v4 upload (no phoneS) stores no phone seconds');
select is(pg_temp.scores('00000000-0000-0000-0000-000000000003'),
  array[87.4, 87.62886597938144, 87.62886597938144, 86.69623059866963, null, null, 87.48261474269819]::float8[],
  'not watched for phone use: Phone use null, the rating 87.4 as before phone tracking (0023 pin E)');
select is(private.rating_at('00000000-0000-0000-0000-000000000003', now()) -> 'scores' -> 'phone', 'null'::jsonb, 'the null is in the answer');
-- the same drive watched (v5, 900 s at driving speed), no pickup
delete from public.trips where user_id = '00000000-0000-0000-0000-000000000003';
select pg_temp.drive('00000000-0000-0000-0000-000000000003', 'c0000000-0000-4000-8000-0000000000c2', now() - interval '1 hour', 3600, 6, '[]', pg_temp.exp(15, 15, 9, 840, 1136, 900));
select is(pg_temp.scores('00000000-0000-0000-0000-000000000003'),
  array[87.5, 87.62886597938144, 87.62886597938144, 86.69623059866963, null, 87.62886597938144, 87.48261474269819]::float8[],
  'watched with no pickup: Phone use 87.6, the rating 87.5');
-- a pickup on a drive with no phone seconds: its seconds in hand are the opportunities
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d1', now() - interval '1 hour', 3600, 6,
  '[{"id":"d1000000-0000-4000-8000-000000000001","type":"phone_pickup","tier":"moderate","durationS":12,"at":400}]', pg_temp.exp(15, 15, 9, 840, 1136));
select is(pg_temp.scores('00000000-0000-0000-0000-000000000004'),
  array[86.2, 87.62886597938144, 87.62886597938144, 86.69623059866963, null, 83.14241611828743, 87.48261474269819]::float8[],
  'a pickup with no phone seconds still scores Phone use: 83.14241611828743, the rating 86.2');
-- a removed pickup on such a drive leaves nothing to judge
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d1', 'd1000000-0000-4000-8000-000000000001', 'mounted')) ->> 'clean', 'true',
  'a mounted report on the only event makes the drive clean');
select is(pg_temp.scores('00000000-0000-0000-0000-000000000004'),
  array[87.4, 87.62886597938144, 87.62886597938144, 86.69623059866963, null, null, 87.48261474269819]::float8[], 'and with it removed, Phone use is null again');

-- ---------------------------------------------------------------------------
-- phone_s held to the drive (eve)
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000001', now() - interval '2 hours', 1200, 6, '[]', pg_temp.exp(5, 5, 5, 0, 1200, 1200));
select is((select row(moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000001')), row(1200, 1200)::text, 'phone time equal to moving time is kept');
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000002', now() - interval '4 hours', 600, 6, '[]', pg_temp.exp(5, 5, 5, 0, 43200, 43200));
select is((select row(moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000002')), row(600, 600)::text, 'phone time is cut to moving time (here the drive''s 600 s)');
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000003', now() - interval '20 hours', 43200, 0.5, '[]', pg_temp.exp(5, 5, 5, 43200, 43200, 43200));
select is((select row(limit_s, moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000003')), row(285, 510, 285)::text,
  'half a mile claimed as 12 h at driving speed keeps 285 s, as limit time does (ceil(mi x 450) + 60)');
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000004', now() - interval '8 hours', 5000, 1.1, '[]', pg_temp.exp(5, 5, 5, 5000, 5000, 5000));
select is((select row(limit_s, moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000004')), row(556, 1051, 556)::text,
  'the cap is a double in the phone''s order (boundExposure): 1.1 mi cuts to 556 s, not 555');
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000005', now() - interval '9 hours', 360, 1, '[]', pg_temp.exp(1, 1, 1, 360, 360, 360));
select is((pg_temp.t('e0000000-0000-4000-8000-000000000005')).phone_s, 360, 'a real drive always fits: a mile at 10 mph keeps its 360 s at driving speed');
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000006', now() - interval '10 hours', 1600, 8, '[]');
select is((select row(moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000006')), row(1136, 0)::text, 'an upload without counters is estimated, with no phone seconds');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000007', now() - interval '11 hours', 600, 6, '[]',
    jsonb_build_object('exposure', jsonb_build_object('slowdowns', 1, 'speedups', 1, 'turns', 1, 'limitS', 0, 'movingS', 500, 'phoneS', '9'))) $$,
  '22023', 'exposure counters are out of range', 'a phoneS that is not a number is refused');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000007', now() - interval '11 hours', 600, 6, '[]', pg_temp.exp(1, 1, 1, 0, 500, -1)) $$,
  '22023', 'exposure counters are out of range', 'a negative phoneS is refused');
select throws_ok($$ update public.trips set phone_s = moving_s + 1 where client_trip_id = 'e0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'the table holds phone time within moving time');
select throws_ok($$ update public.trips set phone_s = -1 where client_trip_id = 'e0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'and never negative');

-- an envelope naming mergeInto (the finalize-trip before 0032 sends null) is its own drive all the same
select pg_temp.drive('00000000-0000-0000-0000-000000000005', 'e0000000-0000-4000-8000-000000000008', now() - interval '30 minutes', 600, 4, '[]', pg_temp.exp(5, 5, 5, 300, 500, 400),
  jsonb_build_object('mergeInto', (pg_temp.t('e0000000-0000-4000-8000-000000000001')).id));
select is(array[(select row(moving_s, phone_s)::text from pg_temp.t('e0000000-0000-4000-8000-000000000001')), (select row(moving_s, phone_s, scored)::text from pg_temp.t('e0000000-0000-4000-8000-000000000008'))],
  array[row(1200, 1200)::text, row(500, 400, true)::text], 'mergeInto is ignored: the drive named keeps its own time; the upload is its own scored drive with its 400 s');

-- ---------------------------------------------------------------------------
-- a pickup is checked (fay): moderate or severe, whole seconds 1..the drive, a start inside it
-- ---------------------------------------------------------------------------
create function pg_temp.pickup(p_tier text, p_dur numeric, p_at numeric) returns jsonb language sql as $$
  select pg_temp.drive('00000000-0000-0000-0000-000000000006', gen_random_uuid(), date_trunc('second', now()) - interval '3 hours', 600, 5,
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'type', 'phone_pickup', 'tier', p_tier, 'durationS', p_dur, 'at', p_at)), pg_temp.exp(5, 5, 5, 300, 500, 400)) $$;
select throws_ok($$ select pg_temp.pickup('minor', 5, 100) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a minor pickup is refused');
select throws_ok($$ select pg_temp.pickup('moderate', 0, 100) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a pickup in hand 0 s is refused');
select throws_ok($$ select pg_temp.pickup('moderate', 2.5, 100) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a pickup in hand a fraction of a second is refused');
select throws_ok($$ select pg_temp.pickup('severe', 601, 0) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a pickup in hand longer than the drive is refused');
select throws_ok($$ select pg_temp.pickup('moderate', 5, -1) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a pickup a second before the drive is refused (no slack)');
select throws_ok($$ select pg_temp.pickup('moderate', 5, 600.001) $$, '22023',
  'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it', 'a pickup after the drive''s end is refused');
select lives_ok($$ select pg_temp.pickup('severe', 600, 0) $$, 'a pickup in hand from the first second to the last is stored');
select lives_ok($$ select pg_temp.pickup('moderate', 1, 600) $$, 'a 1 s pickup starting on the last millisecond is stored');
select is((select count(*)::int from public.trips where user_id = '00000000-0000-0000-0000-000000000006'), 2, 'nothing of a refused drive is stored');
select throws_ok($$ insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    values ((select id from public.trips where user_id = '00000000-0000-0000-0000-000000000006' limit 1), gen_random_uuid(), '00000000-0000-0000-0000-000000000006', 'phone_pickup', 'minor', now(), 3) $$,
  '23514', null, 'the table refuses a minor pickup');
select throws_ok($$ insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    values ((select id from public.trips where user_id = '00000000-0000-0000-0000-000000000006' limit 1), gen_random_uuid(), '00000000-0000-0000-0000-000000000006', 'phone_handling', 'severe', now(), 3) $$,
  '23514', null, 'phone handling stays gone');
select throws_ok($$ select pg_temp.drive('00000000-0000-0000-0000-000000000006', 'f0000000-0000-4000-8000-000000000009', now() - interval '5 hours', 600, 5,
    '[{"id":"f9000000-0000-4000-8000-000000000001","type":"phone_handling","tier":"severe"}]') $$,
  '22023', 'event needs id, type, tier, startedAt and durationS', 'apply_drive refuses phone handling');

-- ---------------------------------------------------------------------------
-- reports: "My phone was mounted" (dan)
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', now() - interval '2 hours', 1800, 10,
  '[{"id":"d2000000-0000-4000-8000-000000000001","type":"hard_brake","at":100},{"id":"d2000000-0000-4000-8000-000000000002","type":"phone_pickup","tier":"severe","durationS":30,"at":200},
    {"id":"d2000000-0000-4000-8000-000000000003","type":"speeding","durationS":20,"at":400},{"id":"d2000000-0000-4000-8000-000000000004","type":"phone_pickup","tier":"moderate","durationS":5,"at":800},
    {"id":"d2000000-0000-4000-8000-000000000005","type":"eyes_off","tier":"severe","measured":{"source":"dashcam","speedMph":40},"at":900}]',
  pg_temp.exp(10, 10, 5, 900, 1500, 1200));
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000001', 'mounted') $$,
  '22023', 'that reason does not apply to this event', '"mounted" does not apply to a hard brake');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000002', 'hazard') $$,
  '22023', 'that reason does not apply to this event', 'nor "hazard" to a pickup');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000002', 'camera_wrong') $$,
  '22023', 'that reason does not apply to this event', 'nor "DashPal got it wrong"');
select throws_ok($$ select private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000002', 'passenger') $$,
  '22023', 'reason must be hazard, wrong_limit, camera_wrong or mounted', 'an unknown reason is refused');
-- dan used one mounted report above: two more of the shared three, then the quota
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000001', 'hazard')) ->> 'quotaLeft', '1',
  'a hazard report draws on the same three');
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000002', 'mounted')) - 'rating' - 'tripId' - 'eventId',
  '{"status": "accepted", "rejectReason": null, "quotaLeft": 0, "clean": false}'::jsonb, 'the third of the week is accepted');
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000004', 'mounted')) - 'rating' - 'tripId' - 'eventId',
  '{"status": "rejected", "rejectReason": "quota", "quotaLeft": 0, "clean": false}'::jsonb, 'the fourth is refused on the quota, and the pickup stands');
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-0000000000d2', 'd2000000-0000-4000-8000-000000000005', 'camera_wrong')) ->> 'status', 'accepted',
  '"DashPal got it wrong" keeps its own three');
select is((select array_agg(client_event_id::text || '=' || status order by started_at) from public.trip_events where trip_id = (pg_temp.t('d0000000-0000-4000-8000-0000000000d2')).id),
  array['d2000000-0000-4000-8000-000000000001=removed', 'd2000000-0000-4000-8000-000000000002=removed', 'd2000000-0000-4000-8000-000000000003=active',
    'd2000000-0000-4000-8000-000000000004=active', 'd2000000-0000-4000-8000-000000000005=removed'], 'what each report removed');
select is((select row(n_events, n_speeding, n_hard_brake, n_dashcam, clean)::text from pg_temp.t('d0000000-0000-4000-8000-0000000000d2')), row(2, 1, 0, 0, false)::text,
  'the drive''s counts: the speeding and the pickup left');
select throws_ok($$ insert into public.event_disputes (trip_id, client_event_id, user_id, reason, status)
    values ((pg_temp.t('d0000000-0000-4000-8000-0000000000d2')).id, 'd2000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000004', 'passenger', 'accepted') $$,
  '23514', null, 'the table keeps the four report reasons');

-- ---------------------------------------------------------------------------
-- the stats: Home's harsh events stay harsh events
-- ---------------------------------------------------------------------------
select is(private.stat_sums('00000000-0000-0000-0000-000000000002', null) - 'miles' - 'durationS' - 'nightMiles' - 'dashcamDrives' - 'dashcamEvents',
  '{"drives": 1, "cleanDrives": 0, "speeding": 0, "hardBrake": 1, "hardAccel": 0, "hardCorner": 0}'::jsonb,
  'two pickups and a hard brake: one harsh event, no clean drive');

-- ---------------------------------------------------------------------------
-- reads: the drive list carries phoneS, the profile names Phone use
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select d -> 'exposure' from jsonb_array_elements(public.list_my_drives(null, 20)) d where d ->> 'clientTripId' = 'a0000000-0000-4000-8000-0000000000a1'),
  '{"slowdowns": 15, "speedups": 15, "turns": 9, "limitS": 840, "movingS": 1136, "phoneS": 900}'::jsonb, 'the drive list carries a drive''s phone seconds');
select is((select array_agg(e ->> 'type' order by e ->> 'startedAt') from jsonb_array_elements(public.list_my_drives(null, 20)) d, jsonb_array_elements(d -> 'events') e
    where d ->> 'clientTripId' = 'a0000000-0000-4000-8000-0000000000a1'), array['phone_pickup', 'hard_brake', 'phone_pickup'], 'and its pickups');
select is(public.get_profile('ava') -> 'scores',
  '{"acceleration": 92, "braking": 81, "turning": 90, "attention": null, "phone": 87, "speed": 91}'::jsonb, 'the profile''s category scores name Phone use, whole numbers');
select is(public.get_profile('cat') -> 'scores', 'null'::jsonb, 'a stranger''s scores stay hidden');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is(public.get_profile('cat') -> 'scores' -> 'phone', '88'::jsonb, 'cat''s own Phone use (87.6 rounds to 88)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select is(jsonb_typeof(public.get_profile('dan') -> 'scores' -> 'phone'), 'number', 'once a drive was watched for phone use, Phone use has a score');
reset role;

select * from finish();
rollback;
