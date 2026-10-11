-- 0003_drives + 0008_engine, DashPal: the stored seconds and the derived flag, eyes_off / drowsy
-- counted apart from n_events (never breaking `clean`), the envelope's DashPal invariants, a merge
-- keeping the union's seconds and the upload's own on the merged-away row, disputes on a drive
-- with DashPal events (no 40001), camera_wrong's type match and its own weekly quota, the
-- "wasn't driving" flag counting DashPal events, and the client reads.
create extension if not exists pgtap with schema extensions;

begin;
select plan(31);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000003', 'c@example.com');
update public.profiles set username = 'cam', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000003';

-- every drive is anchored at 02:00 New York today so local days and the merge gap are deterministic
create temporary table t as select (date_trunc('day', now() at time zone 'America/New_York') + interval '2 hours') at time zone 'America/New_York' as t0;
create function pg_temp.t0() returns timestamptz language sql stable as $$ select t0 from t $$;
grant select on t to authenticated;
grant execute on function pg_temp.t0() to authenticated;
create function pg_temp.c() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-000000000003'::uuid $$;
create function pg_temp.trip(p_client uuid) returns uuid language sql stable as $$ select id from public.trips where client_trip_id = p_client $$;

-- a scored drive through apply_drive. Events are [{id, type, tier?, penalty?, at? (minutes in)}];
-- a DashPal event is severe with source dashcam. p_dashcam is the envelope's (stored) block,
-- p_own the upload's own; the breakdown's activeEventCount leaves DashPal events out, as scoring does.
create function pg_temp.dpdrive(p_client uuid, p_started timestamptz, p_minutes int, p_miles numeric, p_net int, p_events jsonb,
  p_dashcam jsonb default null, p_own jsonb default null, p_merge uuid default null, p_bd jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ev jsonb;
  v_bd jsonb;
  v_streak int;
  v_n int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type',
      'tier', coalesce(e ->> 'tier', case when e ->> 'type' in ('eyes_off', 'drowsy') then 'severe' else 'minor' end),
      'startedAt', floor(extract(epoch from p_started + make_interval(mins => coalesce((e ->> 'at')::int, 1))) * 1000)::bigint, 'durationS', 2,
      'lat', 47.6, 'lng', -122.3,
      'measured', case when e ->> 'type' in ('eyes_off', 'drowsy') then '{"source": "dashcam", "speedMph": 40}'::jsonb else '{}'::jsonb end)), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'penalty', coalesce((e ->> 'penalty')::int, 10))), '[]'::jsonb) into v_bd from jsonb_array_elements(p_events) e;
  select count(*)::int into v_n from jsonb_array_elements(p_events) e where e ->> 'type' not in ('eyes_off', 'drowsy');
  if p_merge is null then
    select streak into v_streak from public.progress where user_id = pg_temp.c();
  else
    select (progress_before ->> 'streak')::int into v_streak from public.trips where id = p_merge;
  end if;
  return private.apply_drive(jsonb_build_object(
    'user', pg_temp.c(), 'mergeInto', p_merge, 'dashcam', p_dashcam,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_started) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_started + make_interval(mins => p_minutes)) * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_started at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', p_miles, 'safeMiles', p_miles, 'nightMiles', 0,
      'durationS', p_minutes * 60, 'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', 'poly', 'appVersion', '2.0.0',
      'dashcam', p_own),
    'scored', true, 'reason', null, 'net', p_net,
    'breakdown', jsonb_build_object('scored', true, 'net', p_net, 'ratingPenalty', 0, 'events', v_bd, 'activeEventCount', v_n,
      'dashcamMult', case when coalesce((p_dashcam ->> 'on')::boolean, false) then 1.25 else 1 end) || p_bd,
    'events', v_ev,
    'streak', jsonb_build_object('before', jsonb_build_object('streak', v_streak), 'after', jsonb_build_object('streak', v_streak + 1, 'atRisk', false, 'freezes', 2, 'cleanRun', 0),
      'outcome', 'grew', 'freezeEarned', false),
    'isLoop', false, 'loopRepeat', false, 'safeMilesEarlierToday', 0, 'scoringVersion', 4));
end $$;

-- ---------------------------------------------------------------------------
-- a DashPal drive: the seconds, the flag, the counts
-- ---------------------------------------------------------------------------
select pg_temp.dpdrive('d1000000-0000-4000-8000-000000000001', pg_temp.t0(), 30, 12, 117,
  '[{"id":"e1000000-0000-4000-8000-000000000001","type":"hard_brake"},{"id":"e1000000-0000-4000-8000-000000000002","type":"drowsy","penalty":50,"at":5}]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 1500, "coveredS": 1350, "synced": true, "on": true}',
  '{"deviceId": "a4c1380f2b7e", "movingS": 1500, "coveredS": 1350, "synced": true}');
select is((select row(dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000001'),
  row('a4c1380f2b7e', 1500, 1350, true, true)::text, 'the trip keeps the DashPal seconds, the sync flag, the dashcam id and the DashPal-drive flag');
select is((select row(n_events, n_hard_brake, n_dashcam, clean)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000001'),
  row(1, 1, 1, false)::text, 'a drowsy is counted in n_dashcam, never in n_events (the brake breaks clean, not the drowsy)');
select is((select row(type, tier, penalty, status, measured ->> 'source')::text from public.trip_events where client_event_id = 'e1000000-0000-4000-8000-000000000002'),
  row('drowsy', 'severe', 50, 'active', 'dashcam')::text, 'the DashPal event is stored with its penalty and source');

select pg_temp.dpdrive('d1000000-0000-4000-8000-000000000002', pg_temp.t0() + interval '60 minutes', 10, 5, 25,
  '[{"id":"e2000000-0000-4000-8000-000000000001","type":"drowsy","penalty":50}]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 500, "coveredS": 450, "synced": true, "on": true}');
select is((select row(n_events, n_dashcam, clean)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000002'),
  row(0, 1, true)::text, 'a drive whose only event is a drowsy is clean');
select is((select clean_miles_30d from public.progress where user_id = pg_temp.c()), 5.00::numeric, 'its miles count as clean miles');
select is(private.challenge_count(pg_temp.c(), private.league_week(pg_temp.t0()), 'clean'), 1, 'and it counts toward the clean-drive challenge');

-- ---------------------------------------------------------------------------
-- envelope invariants
-- ---------------------------------------------------------------------------
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20, '[]',
  '{"deviceId": "A4C1380F2B7E", "movingS": 500, "coveredS": 450, "synced": true, "on": true}') $$,
  '22023', 'dashcam seconds are out of range', 'an uppercase dashcam id is refused');
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20, '[]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 500, "coveredS": 501, "synced": true, "on": true}') $$,
  '22023', 'dashcam seconds are out of range', 'covered seconds beyond the moving seconds are refused');
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20, '[]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 500, "coveredS": 399, "synced": true, "on": true}') $$,
  '22023', 'dashcam seconds are out of range', 'a DashPal flag its seconds do not earn (79.8 %) is refused');
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20, '[]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 500, "coveredS": 450, "synced": false, "on": false}', null, null, '{"dashcamMult": 1.25}') $$,
  '22023', 'dashcam seconds are out of range', 'a breakdown x1.25 on a drive that is not a DashPal drive is refused');
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20, '[]',
  null, '{"deviceId": "a4c1380f2b7e", "movingS": 43201, "coveredS": 0, "synced": true}') $$,
  '22023', 'dashcam seconds are out of range', 'an upload claiming more than 12 h moving is refused');
select throws_ok($$ select pg_temp.dpdrive('d1000000-0000-4000-8000-0000000000f1', pg_temp.t0() + interval '600 minutes', 10, 2, 20,
  '[{"id":"e9000000-0000-4000-8000-000000000001","type":"eyes_off","tier":"minor"}]') $$,
  '22023', 'event needs id, type, tier, startedAt and durationS', 'a DashPal event is severe only');

-- ---------------------------------------------------------------------------
-- merge: the union's seconds on the target, the upload's own on the merged-away row
-- ---------------------------------------------------------------------------
create temporary table c3 as select private.drive_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000003', pg_temp.t0() + interval '72 minutes',
  (pg_temp.t0() at time zone 'America/New_York')::date, 47.6105, -122.3105) as c;
select is((select c -> 'merge' -> 'dashcam' from c3), '{"deviceId": "a4c1380f2b7e", "movingS": 500, "coveredS": 450, "synced": true}'::jsonb,
  'the merge target carries its stored DashPal seconds');
select pg_temp.dpdrive('d1000000-0000-4000-8000-000000000003', pg_temp.t0() + interval '72 minutes', 10, 3, 40, '[]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 1100, "coveredS": 450, "synced": true, "on": false}',
  '{"deviceId": "a4c1380f2b7e", "movingS": 600, "coveredS": 0, "synced": true}',
  (select (c -> 'merge' ->> 'tripId')::uuid from c3));
select is((select row(dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on, n_dashcam, clean, rev)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000002'),
  row(1100, 450, true, false, 1, true, 2)::text, 'the target holds the union''s seconds and the flag derived from them (41 %: no bonus, never an OR)');
select is((select row(merged_into = pg_temp.trip('d1000000-0000-4000-8000-000000000002'), dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_on)::text
    from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000003'),
  row(true, 'a4c1380f2b7e', 600, 0, false)::text, 'the merged-away row keeps the upload''s own seconds');

-- ---------------------------------------------------------------------------
-- disputes on a drive with DashPal events
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'hazard') $$,
  '22023', 'that reason does not apply to this event', 'hazard does not apply to a drowsy');
select throws_ok($$ select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'camera_wrong') $$,
  '22023', 'that reason does not apply to this event', 'camera_wrong does not apply to a hard brake');
-- the hard brake goes (hazard); the drowsy stays: the re-scored breakdown counts 0 phone events and the engine agrees
select is((private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000001'),
    'eventId', 'e1000000-0000-4000-8000-000000000001', 'reason', 'hazard', 'status', 'accepted',
    'breakdown', '{"net": 127, "ratingPenalty": 0, "events": [{"id": "e1000000-0000-4000-8000-000000000002", "penalty": 50}], "activeEventCount": 0, "dashcamMult": 1.25}'::jsonb, 'net', 127))) ->> 'status',
  'accepted', 'a hazard dispute on a drive that also has a drowsy is accepted (never a stale-breakdown 40001)');
select is((select row(n_events, n_dashcam, clean, points_net)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000001'),
  row(0, 1, true, 127)::text, 'the drive is clean now, the drowsy still counted and charged');
create temporary table cw as select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'camera_wrong') as d;
select is((select array[d ->> 'status', d ->> 'quotaLeft', d -> 'rescore' -> 'input' ->> 'dashcam', d -> 'rescore' -> 'input' -> 'events' #>> '{1,status}'] from cw),
  array['accepted', '3', 'true', 'removed'], 'camera_wrong on the drowsy: accepted on its own quota, re-scored as a DashPal drive with the event removed');
select private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000001'),
  'eventId', 'e1000000-0000-4000-8000-000000000002', 'reason', 'camera_wrong', 'status', 'accepted',
  'breakdown', '{"net": 177, "ratingPenalty": 0, "events": [], "activeEventCount": 0, "dashcamMult": 1.25}'::jsonb, 'net', 177));
select is((select row(n_events, n_dashcam, clean, points_net)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000001'),
  row(0, 0, true, 177)::text, 'an accepted camera_wrong takes the event out of n_dashcam and credits the delta');

-- the quotas: hazard + wrong_limit share 3 a week; camera_wrong has 3 of its own
select pg_temp.dpdrive('d1000000-0000-4000-8000-000000000004', pg_temp.t0() + interval '120 minutes', 20, 8, 20,
  '[{"id":"e4000000-0000-4000-8000-000000000001","type":"hard_brake","at":2},{"id":"e4000000-0000-4000-8000-000000000002","type":"hard_brake","at":3},{"id":"e4000000-0000-4000-8000-000000000003","type":"hard_brake","at":4},
    {"id":"e4000000-0000-4000-8000-000000000004","type":"drowsy","penalty":50,"at":5},{"id":"e4000000-0000-4000-8000-000000000005","type":"eyes_off","penalty":40,"at":6},{"id":"e4000000-0000-4000-8000-000000000006","type":"drowsy","penalty":50,"at":17}]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 1000, "coveredS": 100, "synced": true, "on": false}');
select private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000004'),
  'eventId', 'e4000000-0000-4000-8000-000000000001', 'reason', 'hazard', 'status', 'accepted'));
select private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000004'),
  'eventId', 'e4000000-0000-4000-8000-000000000002', 'reason', 'hazard', 'status', 'accepted'));
select is((select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000003', 'hazard')) ->> 'rejectReason',
  'quota', 'three hazards accepted this week: the fourth is rejected');
select is((select array[d ->> 'status', d ->> 'quotaLeft'] from (select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000004', 'camera_wrong') as d) x),
  array['accepted', '2'], 'camera_wrong is still accepted: its own quota (one used)');
select is((private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000004'),
    'eventId', 'e4000000-0000-4000-8000-000000000004', 'reason', 'camera_wrong', 'status', 'accepted'))) ->> 'quotaLeft',
  '1', 'apply_dispute answers what is left of camera_wrong''s own quota');
select private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000004'),
  'eventId', 'e4000000-0000-4000-8000-000000000005', 'reason', 'camera_wrong', 'status', 'accepted'));
select is((select private.dispute_context(pg_temp.c(), 'd1000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000006', 'camera_wrong')) - 'rescore' - 'tripId' - 'clientTripId' - 'oldNet' - 'scored',
  '{"status": "rejected", "reason": "camera_wrong", "eventId": "e4000000-0000-4000-8000-000000000006", "quotaLeft": 0, "rejectReason": "quota"}'::jsonb,
  'the fourth camera_wrong of the week is rejected: quota');
select is((private.apply_dispute(jsonb_build_object('user', pg_temp.c(), 'tripId', pg_temp.trip('d1000000-0000-4000-8000-000000000004'),
    'eventId', 'e4000000-0000-4000-8000-000000000006', 'reason', 'camera_wrong', 'status', 'accepted'))) - 'progress' - 'tripId' - 'breakdown' - 'net',
  '{"delta": 0, "status": "rejected", "eventId": "e4000000-0000-4000-8000-000000000006", "quotaLeft": 0, "rejectReason": "quota"}'::jsonb,
  'and an accepted decision past it is re-counted under the lock and stored rejected');
select is((select row(n_events, n_hard_brake, n_dashcam)::text from public.trips where client_trip_id = 'd1000000-0000-4000-8000-000000000004'),
  row(3, 3, 3)::text, 'disputes without a re-score leave the stored counts as they were');

-- ---------------------------------------------------------------------------
-- "wasn't driving": a drive with only DashPal events counts as a drive with events
-- ---------------------------------------------------------------------------
update public.trips set not_driving = true, not_driving_at = now() - interval '40 days'
  where client_trip_id in ('d1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000004');
select pg_temp.dpdrive('d1000000-0000-4000-8000-000000000005', pg_temp.t0() + interval '200 minutes', 10, 4, 10,
  '[{"id":"e5000000-0000-4000-8000-000000000001","type":"eyes_off","penalty":40}]',
  '{"deviceId": "a4c1380f2b7e", "movingS": 590, "coveredS": 590, "synced": true, "on": true}');
select lives_ok($$ select private.revert_latest_not_driving(pg_temp.c(), 'd1000000-0000-4000-8000-000000000005') $$, 'the latest drive is marked as not driving');
select is((select flagged from public.profiles where id = pg_temp.c()), true,
  'three of the last uses were on drives with events, two of them DashPal events only: flagged');

-- ---------------------------------------------------------------------------
-- client reads
-- ---------------------------------------------------------------------------
select is(private.stat_sums(pg_temp.c(), null) - array['miles', 'drives', 'pickups', 'durationS', 'hardAccel', 'hardBrake', 'speeding', 'handlingS', 'hardCorner', 'nightMiles', 'cleanDrives'],
  '{"dashcamDrives": 1, "dashcamEvents": 0}'::jsonb, 'stat sums keep DashPal drives and events apart from the phone''s counts');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is((select jsonb_build_object('dashcamOn', d -> 'dashcamOn', 'nDashcam', d -> 'nDashcam') from jsonb_array_elements(public.list_my_drives(null, 10)) d
    where d ->> 'clientTripId' = 'd1000000-0000-4000-8000-000000000005'),
  '{"dashcamOn": true, "nDashcam": 1}'::jsonb, 'list_my_drives carries the DashPal flag and count');
reset role;

select * from finish();
rollback;
