-- 0019_points_floor_and_net_levels: points never go below 0 and the level follows them; the
-- ledger keeps agreeing with the points through a floored drive, a report on it and its undoing;
-- the week's points never read below 0; a Safety Rating from 10 miles.
create extension if not exists pgtap with schema extensions;

begin;
select plan(14);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com'), ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
create temporary table t as select (date_trunc('day', now() at time zone 'America/New_York') + interval '2 hours') at time zone 'America/New_York' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
create function pg_temp.ledger() returns int language sql stable as $$
  select coalesce(sum(amount), 0)::int from public.points_ledger where user_id = '00000000-0000-0000-0000-000000000001' $$;
create function pg_temp.progress() returns text language sql stable as $$
  select row(points, level)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001' $$;

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

-- Z: +100; A: -300 with two hard brakes, more than the 100 held
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', pg_temp.t0(), 30, 9, 100, '[]');
select is((select (r ->> 'net')::int from (select pg_temp.drive('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333', pg_temp.t0() + interval '60 minutes', 20, 5, -300,
  '[{"id":"22222222-2222-4222-8222-222222222222","type":"hard_brake","penalty":250},{"id":"55555555-5555-4555-8555-555555555555","type":"hard_brake","penalty":100}]',
  null, '{"ratingPenalty": 20}') as r) x), -300, 'the drive''s own net (its receipt) keeps the whole loss');
select is(pg_temp.progress(), row(0, 1)::text, 'the points stop at 0');
select is((select amount from public.points_ledger where key like 'drive:' || (select id from public.trips where client_trip_id = '33333333-3333-4333-8333-333333333333') || ':%'), -100,
  'the ledger records what the drive really took');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), pg_temp.ledger(), 'points agree with the ledger');

-- the first brake was a hazard: the drive now nets -50, so it takes 50 of the 100 it met
select is((select (r ->> 'delta')::int from (select private.apply_dispute(jsonb_build_object('user', '00000000-0000-0000-0000-000000000001',
  'tripId', (select id from public.trips where client_trip_id = '33333333-3333-4333-8333-333333333333'),
  'eventId', '22222222-2222-4222-8222-222222222222', 'reason', 'hazard', 'status', 'accepted',
  'breakdown', '{"net": -50, "ratingPenalty": 10, "events": [{"id": "55555555-5555-4555-8555-555555555555", "penalty": 100}], "activeEventCount": 1}'::jsonb, 'net', -50)) as r) x), 50,
  'an accepted report gives back what the floored drive now takes less');
select is(pg_temp.progress(), row(50, 1)::text, 'and the points show it');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), pg_temp.ledger(), 'points agree with the ledger after the report');

-- "Wasn't driving" on it gives back exactly what it took
select private.revert_latest_not_driving('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333');
select is(pg_temp.progress(), row(100, 1)::text, 'undoing the drive gives back the 50 it took, no more');
select is((select points from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), pg_temp.ledger(), 'points agree with the ledger after the undo');

-- Y: +700 reaches level 3 (750); X: -100 drops back to level 2
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '66666666-6666-4666-8666-666666666666', pg_temp.t0() + interval '120 minutes', 30, 9, 700, '[]');
select is(pg_temp.progress(), row(800, 3)::text, 'level 3 at 800 points');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', '77777777-7777-4777-8777-777777777777', pg_temp.t0() + interval '180 minutes', 20, 5, -100,
  '[{"id":"88888888-8888-4888-8888-888888888888","type":"hard_brake","penalty":100}]', null, '{"ratingPenalty": 10}');
select is(pg_temp.progress(), row(700, 2)::text, 'losing points drops a level');

-- ben: one 10-mile drive that loses points
select pg_temp.drive('00000000-0000-0000-0000-000000000002', '99999999-9999-4999-8999-999999999999', pg_temp.t0(), 20, 10, -50,
  '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","type":"hard_brake","penalty":50}]', null, '{"ratingPenalty": 10}');
select is((select row(points, level, ranked)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000002'), row(0, 1, true)::text,
  'no points below 0, and ranked from 10 miles');
select is(private.week_points('00000000-0000-0000-0000-000000000002', private.league_week(pg_temp.t0())), 0, 'the week''s points never read below 0');
select is(private.week_points('00000000-0000-0000-0000-000000000001', private.league_week(pg_temp.t0())), 700, 'a positive week reads as before');

select * from finish();
rollback;
