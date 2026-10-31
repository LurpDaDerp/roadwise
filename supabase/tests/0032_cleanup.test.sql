-- 0032_cleanup: clans, drive combining and the league leftovers are gone from the schema; what used
-- them still works: register_device (no install claims, profiles.league_eligible answered as
-- stored and never written), a report (a user only), apply_drive (an envelope's mergeInto is
-- ignored, the answer keeps mergedInto null), drive_context (merge always null), the export (format 6,
-- no clan key), the push claim, and an account delete with no clan trigger.
create extension if not exists pgtap with schema extensions;

begin;
select plan(28);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- what is gone
-- ---------------------------------------------------------------------------
select hasnt_table('public', 'clans', 'clans are gone');
select hasnt_table('public', 'clan_members', 'clan members are gone');
select hasnt_table('public', 'device_league_claims', 'install claims are gone');
select hasnt_table('public', 'job_leases', 'job leases are gone');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (p.proname like '%clan%' or p.proname in ('new_invite_code', 'remove_member', 'set_member_role', 'transfer_leadership',
           'acquire_job_lease', 'release_job_lease', 'get_my_stat_sums', 'watched_miles'))), 0,
  'no clan function, job-lease function, get_my_stat_sums or watched_miles is left');
select is((select count(*)::int from pg_trigger t where not t.tgisinternal and t.tgname like 'clan%'), 0, 'no clan trigger runs on an account delete');
select hasnt_column('public', 'trips', 'merged_into', 'a drive is never merged into another');
select is((select array_agg(column_name::text order by column_name::text) from information_schema.columns
    where table_schema = 'public' and table_name = 'progress' and column_name like 'last_end%'), null, 'progress keeps no end point');
select has_column('public', 'profiles', 'league_eligible', 'profiles.league_eligible stays for older builds that select it');
select is((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.reports'::regclass and c.conname = 'reports_target_kind_check'),
  'CHECK ((target_kind = ''user''::text))', 'a report names a user only');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and (p.prosrc like '%merged_into%' or p.prosrc like '%last_end_%' or p.prosrc like '%device_league_claims%'
      or p.prosrc like '%league_result%' or p.prosrc like '%clan_members%')), 0,
  'no function reads a dropped table or column');

-- ---------------------------------------------------------------------------
-- register_device still registers; league_eligible is answered as stored and never written
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(public.register_device('device-aaaaaaaa', 'ios', 'ExponentPushToken[abcdefgh12345]'), '{"league_eligible": true}'::jsonb,
  'ava registers: the answer carries her stored league_eligible');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(public.register_device('device-aaaaaaaa', 'android', 'ExponentPushToken[abcdefgh12345]'), '{"league_eligible": false}'::jsonb,
  'ben registers the same install: his stored false');
reset role;
select is((select array_agg(league_eligible order by username) from public.profiles where id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')),
  array[true, false], 'neither profile is rewritten');
select is((select array_agg(row(user_id, platform, push_token)::text order by user_id) from public.devices),
  array[row('00000000-0000-0000-0000-000000000001'::uuid, 'ios', null::text)::text, row('00000000-0000-0000-0000-000000000002'::uuid, 'android', 'ExponentPushToken[abcdefgh12345]')::text],
  'both rows are kept and the push token moved to ben');

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'other', '') $$, 'a user report goes through');
select throws_ok($$ select public.report_target('clan', '00000000-0000-0000-0000-000000000002', 'other', '') $$, '22023', 'kind must be user with a target id',
  'a clan report is refused');
reset role;

-- ---------------------------------------------------------------------------
-- the drive engine
-- ---------------------------------------------------------------------------
create temporary table t as select date_trunc('second', now()) - interval '3 hours' as t0;
create function pg_temp.env(p_client uuid, p_start timestamptz, p_merge uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('user', '00000000-0000-0000-0000-000000000001', 'mergeInto', p_merge, 'dashcam', null,
    'payload', jsonb_build_object('clientTripId', p_client, 'startedAt', floor(extract(epoch from p_start) * 1000)::bigint,
      'endedAt', floor(extract(epoch from p_start + interval '20 minutes') * 1000)::bigint, 'tz', 'America/New_York',
      'localDay', to_char(p_start at time zone 'America/New_York', 'YYYY-MM-DD'), 'miles', 8, 'nightMiles', 0, 'durationS', 1200,
      'end', null, 'polyline', 'poly', 'appVersion', '3.2.0', 'origin', 'auto', 'notDrivingExpired', false),
    'scored', true, 'reason', null, 'events', '[]'::jsonb, 'scoringVersion', 10)
$$;
create temporary table r1 as select private.apply_drive(pg_temp.env('a1000000-0000-4000-8000-000000000001', (select t0 from t), null)) as r;
select is((select array(select jsonb_object_keys(r) order by 1) from r1),
  array['achievements', 'challenges', 'clientTripId', 'eventIds', 'mergedInto', 'rating', 'reason', 'scored', 'tripId'],
  'the answer keeps its keys, mergedInto among them (every build of the app requires it)');
select is(private.drive_context('00000000-0000-0000-0000-000000000001', 'a1000000-0000-4000-8000-000000000002', (select t0 from t) + interval '21 minutes',
    ((select t0 from t) at time zone 'America/New_York')::date, null, null, (select t0 from t) + interval '41 minutes'),
  '{"version": 23, "phoneUse": true, "existing": null, "merge": null}'::jsonb, 'drive_context answers version 23 with phone use and merge always null (an older finalize-trip requires the key)');
-- an envelope naming a drive to join (a finalize-trip before 0026 could): the field is ignored
create temporary table r2 as select private.apply_drive(pg_temp.env('a1000000-0000-4000-8000-000000000002', (select t0 from t) + interval '21 minutes',
  (select (r ->> 'tripId')::uuid from r1))) as r;
select is((select array[r ->> 'mergedInto', r ->> 'scored', r ->> 'clientTripId'] from r2), array[null, 'true', 'a1000000-0000-4000-8000-000000000002'],
  'an envelope''s mergeInto is ignored: the upload is its own scored drive');
select is((select array_agg(row(client_trip_id, miles, duration_s)::text order by started_at) from public.trips where user_id = '00000000-0000-0000-0000-000000000001'),
  array[row('a1000000-0000-4000-8000-000000000001'::uuid, 8.00, 1200)::text, row('a1000000-0000-4000-8000-000000000002'::uuid, 8.00, 1200)::text],
  'two drives, the first untouched');
select is(private.apply_drive(pg_temp.env('a1000000-0000-4000-8000-000000000002', (select t0 from t) + interval '21 minutes', null)), (select r from r2),
  'a replay answers the stored document');
select is((select result from public.trips where client_trip_id = 'a1000000-0000-4000-8000-000000000002'), (select r from r2), 'which is the drive''s stored result');

-- ---------------------------------------------------------------------------
-- the export (format 6) and the push claim
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table ex as select public.export_account('00000000-0000-0000-0000-000000000001') as e;
select is((select array[e ->> 'format_version', (e ? 'clan')::text, ((e -> 'trips' -> 0) ? 'merged_into')::text, ((e -> 'progress') ? 'last_end_at')::text] from ex),
  array['6', 'false', 'false', 'false'], 'the export is format 6: no clan key, no merged_into on a drive, no end point in progress');
select is((select e -> 'reports_made' -> 0 ->> 'target_kind' from ex), 'user', 'its reports name users');
reset role;
insert into public.notification_prefs (user_id, social) values ('00000000-0000-0000-0000-000000000002', false);
insert into public.inbox (user_id, kind, payload, dedupe_key) values
  ('00000000-0000-0000-0000-000000000002', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000001"}', 'friend_request:0032');
set local role service_role;
select is((select x -> 'ctx' -> 'enabled' from jsonb_array_elements(public.claim_push_batch(10, 60)) x where x ->> 'user_id' = '00000000-0000-0000-0000-000000000002'),
  'false'::jsonb, 'a friend request follows the social setting');
reset role;

-- ---------------------------------------------------------------------------
-- an account delete: no clan trigger runs, the cascade takes everything
-- ---------------------------------------------------------------------------
select lives_ok($$ delete from auth.users where id = '00000000-0000-0000-0000-000000000001' $$, 'an account is deleted');
select is((select count(*)::int from public.trips where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'and its drives go with it');

select * from finish();
rollback;
