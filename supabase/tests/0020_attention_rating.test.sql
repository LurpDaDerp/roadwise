-- 0020_attention_rating (+ 0022): the Safety Rating is the weighted mean of the radar's categories,
-- read from the drives' active events; Attention from DashPal per watched mile (floored at 10),
-- only for a driver DashPal watched; the rating as of a past day agrees; list_my_drives hands the
-- DashPal seconds back.
create extension if not exists pgtap with schema extensions;

begin;
select plan(8);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
create temporary table t as select now() - interval '2 days' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
create function pg_temp.rating() returns numeric language sql stable as $$
  select safety_rating from public.progress where user_id = '00000000-0000-0000-0000-000000000001' $$;
create function pg_temp.trip() returns uuid language sql stable as $$
  select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111' $$;

-- a scored drive through apply_drive: events are [{id, type, tier, penalty}] shorthand
create function pg_temp.drive(p_user uuid, p_client uuid, p_started timestamptz, p_minutes int, p_miles numeric, p_net int, p_events jsonb,
  p_merge uuid default null, p_extra jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
  v_bd jsonb;
  v_streak int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', floor(extract(epoch from p_started + interval '1 minute') * 1000)::bigint, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb), 'status', coalesce(e ->> 'status', 'active'))), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'penalty', coalesce((e ->> 'penalty')::int, 10))), '[]'::jsonb) into v_bd from jsonb_array_elements(p_events) e
    where coalesce(e ->> 'status', 'active') = 'active';
  if p_merge is null then
    select streak into v_streak from public.progress where user_id = p_user;
  else
    select (progress_before ->> 'streak')::int into v_streak from public.trips where id = p_merge;
  end if;
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', p_merge,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + make_interval(mins => p_minutes)) * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'safeMiles', p_miles, 'nightMiles', 0,
      'durationS', p_minutes * 60,
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', coalesce(p_extra ->> 'polyline', 'poly'), 'appVersion', '2.0.0'),
    'scored', coalesce((p_extra ->> 'scored')::boolean, true), 'reason', p_extra ->> 'reason', 'net', p_net,
    'breakdown', jsonb_build_object('scored', true, 'net', p_net, 'ratingPenalty', coalesce((p_extra ->> 'ratingPenalty')::int, 0), 'events', v_bd),
    'events', v_ev,
    'streak', jsonb_build_object('before', jsonb_build_object('streak', v_streak), 'after', jsonb_build_object('streak', case when p_net > 0 then v_streak + 1 else v_streak end, 'atRisk', p_net < 0, 'freezes', 2, 'cleanRun', 0),
      'outcome', case when p_net > 0 then 'grew' when p_net < 0 then 'at_risk' else 'none' end, 'freezeEarned', false),
    'isLoop', false, 'loopRepeat', false, 'safeMilesEarlierToday', 0, 'scoringVersion', 3) || p_extra);
end $$;

-- 20 miles with a severe speeding (100), a phone pickup (40) and a minor hard brake (10): speed 76, phone use 89,
-- braking 97, the rest 100; speed and phone use counted double -> 89.6 (pinned with the scoring package)
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 20, 100,
  '[{"id":"a1a1a1a1-0000-4000-8000-000000000001","type":"speeding","tier":"severe","penalty":80},{"id":"a1a1a1a1-0000-4000-8000-000000000002","type":"phone_pickup","tier":"severe","penalty":32},{"id":"a1a1a1a1-0000-4000-8000-000000000003","type":"hard_brake","penalty":8}]',
  null, '{"ratingPenalty": 150}');
select is(pg_temp.rating(), 89.6, 'the phone''s categories alone: 89.6');

-- an eyes-off look on a drive DashPal never watched counts nothing
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
  values (pg_temp.trip(), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '00000000-0000-0000-0000-000000000001', 'eyes_off', 'severe', pg_temp.t0() + interval '5 minutes', 3);
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is(pg_temp.rating(), 89.6, 'no watched miles: Attention has no score and takes nothing');

-- watched all 20 miles: Attention scores 40 over 20 mi (89), one more category in the mean
update public.trips set dashcam_moving_s = 1000, dashcam_covered_s = 1000 where id = pg_temp.trip();
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is(pg_temp.rating(), 89.5, 'watched: Attention joins the mean');
select is(private.rating_as_of('00000000-0000-0000-0000-000000000001', now()), 89.5, 'the rating as of now agrees');

-- watched 2 of the 20 miles: Attention is over at least 10 miles, so 40 over 10 mi (80)
update public.trips set dashcam_covered_s = 100 where id = pg_temp.trip();
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is(pg_temp.rating(), 88.4, 'a short watched stretch counts as 10 miles');

-- a drowsy event (50) in place of the removed eyes-off: Attention 50 over 10 mi (76)
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
  values (pg_temp.trip(), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '00000000-0000-0000-0000-000000000001', 'drowsy', 'severe', pg_temp.t0() + interval '9 minutes', 3);
update public.trip_events set status = 'removed' where client_event_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is(pg_temp.rating(), 87.9, 'a removed event counts nothing, a drowsy one 50');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select d ->> 'dashcamMovingS' from jsonb_array_elements(public.list_my_drives(null, 10)) d), '1000', 'list_my_drives hands back the moving seconds');
select is((select d ->> 'dashcamCoveredS' from jsonb_array_elements(public.list_my_drives(null, 10)) d), '100', 'and the covered ones');

select * from finish();
rollback;
