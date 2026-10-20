-- 0017_revert_keeps_later_credits: undoing the latest drive (a merge into it, "Wasn't driving")
-- takes back only that drive's own points: a report credited on an older drive after it stays,
-- and progress keeps agreeing with the ledger.
create extension if not exists pgtap with schema extensions;

begin;
select plan(8);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
create temporary table t as select (date_trunc('day', now() at time zone 'America/New_York') + interval '2 hours') at time zone 'America/New_York' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
create function pg_temp.ledger() returns int language sql stable as $$
  select coalesce(sum(amount), 0)::int from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001' $$;
create function pg_temp.progress() returns text language sql stable as $$
  select row(points, lifetime)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001' $$;

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

-- Z: an older drive with a hard brake (90); A: the latest drive (50)
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 9, 90,
  '[{"id":"22222222-2222-4222-8222-222222222222","type":"hard_brake","penalty":10}]', null, '{"ratingPenalty": 10}');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '60 minutes', 20, 5, 50, '[]');
select is(pg_temp.progress(), row(140, 140)::text, 'Z and A applied');

-- parked after A, the driver reports Z's brake as a hazard: accepted, +10
select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'tripId', (select id from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'),
  'eventId', '22222222-2222-4222-8222-222222222222', 'reason', 'hazard', 'status', 'accepted',
  'breakdown', '{"net": 100, "ratingPenalty": 0, "events": [], "activeEventCount": 0}'::jsonb, 'net', 100));
select is(pg_temp.progress(), row(150, 150)::text, 'the report on Z is credited');

-- B restarts within the merge window and merges into A (A + B scores 80)
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '44444444-4444-4444-8444-444444444444', pg_temp.t0() + interval '82 minutes', 10, 3, 80, '[]',
  (select id from public.trips where client_trip_id = '33333333-3333-4333-8333-333333333333'));
select is(pg_temp.progress(), row(180, 180)::text, 'the merge takes back A''s 50 and adds the union''s 80; Z''s report credit stays');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), pg_temp.ledger(), 'points agree with the ledger after the merge');
select is((select level from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), private.level_for(180), 'the level follows lifetime');

-- "Wasn't driving" on the merged drive takes back exactly the union's 80
select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333');
select is(pg_temp.progress(), row(100, 100)::text, '"Wasn''t driving" leaves Z with its report credit');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), pg_temp.ledger(), 'points agree with the ledger after it too');
select is((select row(streak, last_end_at)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'),
  row(1, (select ended_at from public.trips where client_trip_id = '11111111-1111-4111-8111-111111111111'))::text,
  'the streak and the last drive''s end are restored from the snapshot');

select * from finish();
rollback;
