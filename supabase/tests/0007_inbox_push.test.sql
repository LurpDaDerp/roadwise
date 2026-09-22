-- 0007_inbox_push: notification_prefs, inbox, push_registrations, push_deliveries, the device drive
-- state, the producers (the drive-summary history row, already skipped/local; the permission
-- lapse), the client RPCs, the service-role writers push-sender uses, dispatch_push and its two cron
-- jobs, merge_own_profile_flags, and the under-13 minimisation of all of it.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. now() is the transaction's start throughout, so every "later" is simulated by
-- backdating a row. Local stack only: dispatch_push writes vault secrets and queues a pg_net
-- request inside the rolled-back transaction (pg_net's worker only ever sees committed rows).
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0007_inbox_push.test.sql runs only against the local Supabase stack';
  end if;
  -- test-only, like 0006's: fresh sessions for the client writes (section 0); dropped at the end
  create extension if not exists dblink with schema extensions;
end $$;

begin;
select plan(308);

-- ---------------------------------------------------------------------------
-- 0. client writes in FRESH sessions (fix round 4). PL/pgSQL checks EXECUTE on a function a trigger
--    calls when it first initialises the expression in a transaction, so a write that runs after
--    postgres has already fired the trigger in the same transaction can pass while every real
--    client request (a fresh transaction) fails. Each write below is the first statement of its own
--    new connection, as the signed-in user. The fixture user is committed in a separate session and
--    deleted again; a run that dies midway leaves it, and the next run deletes it first.
-- ---------------------------------------------------------------------------
create function pg_temp.conn() returns text language sql as $$
  select 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
$$;
-- a remote statement's command tag, or the remote error's SQLSTATE and message
create function pg_temp.remote(p_conn text, p_sql text) returns text language plpgsql as $$
begin
  return extensions.dblink_exec(p_conn, p_sql);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- one fresh connection: sign in as the fixture user, run p_sql first, roll back, disconnect
create function pg_temp.fresh_client_write(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  perform extensions.dblink_connect('rw7_client', pg_temp.conn());
  perform extensions.dblink_exec('rw7_client', $q$begin; set local role authenticated;
    set local request.jwt.claims = '{"role":"authenticated","sub":"b7000000-0000-4000-8000-0000000000f1"}'$q$);
  v := pg_temp.remote('rw7_client', p_sql);
  perform extensions.dblink_exec('rw7_client', 'rollback');
  perform extensions.dblink_disconnect('rw7_client');
  return v;
end $$;
select extensions.dblink_connect('rw7_pg', pg_temp.conn());
-- self-healing (n2): a user left committed by an aborted earlier run is deleted before it is created
select extensions.dblink_exec('rw7_pg', $q$delete from auth.users where id = 'b7000000-0000-4000-8000-0000000000f1'$q$);
select extensions.dblink_exec('rw7_pg', $q$insert into auth.users (id, email) values ('b7000000-0000-4000-8000-0000000000f1', 'f7@example.com')$q$);
select is(pg_temp.fresh_client_write($q$insert into public.notification_prefs (user_id, categories, tz, local_sent_day, local_sent_count)
    values ('b7000000-0000-4000-8000-0000000000f1', '{"rewards": false}', 'America/New_York', current_date, 1)$q$), 'INSERT 0 1',
  'a client INSERT of notification_prefs succeeds as the first statement of a fresh session (T20 defect)');
select is(pg_temp.fresh_client_write($q$insert into public.notification_prefs (user_id) values ('b7000000-0000-4000-8000-0000000000f1')$q$), 'INSERT 0 1',
  'so does one with no zone (the check is taken when the expression is set up, not only when tz is set)');
select extensions.dblink_exec('rw7_pg', $q$insert into public.notification_prefs (user_id) values ('b7000000-0000-4000-8000-0000000000f1')$q$);
select is(pg_temp.fresh_client_write($q$update public.notification_prefs set local_sent_day = current_date, local_sent_count = 2
    where user_id = 'b7000000-0000-4000-8000-0000000000f1'$q$), 'UPDATE 1',
  'a client UPDATE of only the day count succeeds in a fresh session (the phone''s report, T10)');
select is(pg_temp.fresh_client_write($q$update public.notification_prefs set tz = 'Europe/Paris', quiet_enabled = false, categories = '{"recording": false}'
    where user_id = 'b7000000-0000-4000-8000-0000000000f1'$q$), 'UPDATE 1',
  'a client UPDATE of zone, quiet hours and categories succeeds in a fresh session (H6, T7)');
select is(pg_temp.fresh_client_write($q$update public.notification_prefs set tz = 'Mars/Olympus' where user_id = 'b7000000-0000-4000-8000-0000000000f1'$q$),
  '22023 unknown time zone', 'and the validation still refuses an unknown zone there');
select extensions.dblink_exec('rw7_pg', $q$delete from auth.users where id = 'b7000000-0000-4000-8000-0000000000f1'$q$);
select extensions.dblink_disconnect('rw7_pg');

-- ---------------------------------------------------------------------------
-- fixtures (as the migration owner, with no JWT)
--   A adult (drives in America/New_York), B adult, T teen (16), U gives a child's birth date later,
--   W adult corrected to a child's date by support (the service-role path), N no drives, no prefs.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, email, raw_user_meta_data) values
  ('b7000000-0000-4000-8000-000000000001', 'a7@example.com', '{"display_name":"Ada"}'),
  ('b7000000-0000-4000-8000-000000000002', 'b7@example.com', '{"display_name":"Bo"}'),
  ('b7000000-0000-4000-8000-000000000003', 't7@example.com', '{"display_name":"Tia"}'),
  ('b7000000-0000-4000-8000-000000000004', 'u7@example.com', '{"display_name":"Uma"}'),
  ('b7000000-0000-4000-8000-000000000005', 'w7@example.com', '{"display_name":"Wes"}'),
  ('b7000000-0000-4000-8000-000000000006', 'n7@example.com', '{"display_name":"Nia"}');
update public.private_profiles set birth_date = date '1990-01-01' where user_id in
  ('b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000005',
   'b7000000-0000-4000-8000-000000000006');
update public.private_profiles set birth_date = ((now() at time zone 'UTC')::date - interval '16 years')::date
  where user_id = 'b7000000-0000-4000-8000-000000000003';
insert into public.devices (id, user_id, platform) values
  ('a-phone', 'b7000000-0000-4000-8000-000000000001', 'ios'),
  ('a-tablet', 'b7000000-0000-4000-8000-000000000001', 'ios'),
  ('b-phone', 'b7000000-0000-4000-8000-000000000002', 'android'),
  ('u-phone', 'b7000000-0000-4000-8000-000000000004', 'android'),
  ('w-phone', 'b7000000-0000-4000-8000-000000000005', 'android');

-- apply_trip envelopes, shaped like 0002's and 0006's fixtures (FinalizeTripPayload at HEAD)
create function pg_temp.envelope(p_user uuid, p_client text, p_ended_ago interval, p_distance numeric, p_duration numeric,
  p_role text, p_status text, p_reason text, p_quality text, p_tz text default 'America/New_York') returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from now() - p_ended_ago - make_interval(secs => p_duration)) * 1000)::bigint,
      'endedAt', floor(extract(epoch from now() - p_ended_ago) * 1000)::bigint,
      'tz', p_tz, 'distanceM', p_distance, 'durationS', p_duration,
      'role', p_role, 'roleConfidence', null, 'roleSource', case when p_role = 'unknown' then 'auto' else 'manual' end,
      'mode', 'mounted', 'cameraSession', false, 'events', '[]'::jsonb,
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true, 'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb', 'polyline', '_p~iF~ps|U', 'tracePath', null,
      'hadSevereEvent', false, 'incomplete', false),
    'scored', jsonb_build_object('score', case when p_status in ('provisional', 'final') then 80 end, 'status', p_status,
      'reason', p_reason, 'exposure', 1.25, 'dataQuality', p_quality,
      'categoryDeductions', '{"phone":0,"speeding":20,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', '{}'::jsonb, 'scoringVersion', 1),
    'day', jsonb_build_object('day', ((now() - p_ended_ago - make_interval(secs => p_duration)) at time zone p_tz)::date,
      'longTermScore', 80, 'band', 'good', 'provisional', false, 'safeDay', false, 'goodDay', true, 'phoneFreeDay', true,
      'cameraDay', false, 'exposure', 1.25, 'drivingS', 900, 'tripsScored', 1, 'severeEvents', 0),
    'baselines', jsonb_build_object('medians', '{"speeding": 1.2}'::jsonb))
$$;
create temp table fx (name text primary key, p jsonb not null);
insert into fx values
  ('final', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-final', interval '30 minutes', 12500.5, 900, 'driver', 'final', null, 'A')),
  ('unknown', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-unknown', interval '40 minutes', 9000, 800, 'unknown', 'unscored', 'role_unknown', 'A')),
  ('unknown-c', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-unknown-c', interval '50 minutes', 9000, 800, 'unknown', 'unscored', 'role_unknown', 'C')),
  ('discarded', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-discarded', interval '60 minutes', 90000, 900, 'driver', 'discarded', 'implausible_speed', 'A')),
  ('short', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-short', interval '70 minutes', 500, 90, 'driver', 'unscored', 'too_short', 'A')),
  ('short-unknown', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-short-unknown', interval '80 minutes', 700, 600, 'unknown', 'unscored', 'role_unknown', 'A')),
  ('just-ended', pg_temp.envelope('b7000000-0000-4000-8000-000000000001', 'a-just-ended', interval '0 minutes', 12500, 900, 'driver', 'final', null, 'A'));
grant select on fx to service_role;

-- results the API roles hand back to the assertions
create temp table res (k text primary key, v jsonb);
grant select, insert, update on res to authenticated, service_role;

-- a pending lapse row for a user, due now (the claim fixtures)
create function pg_temp.pending(p_user uuid, p_key text, p_device text default 'a-phone', p_after interval default interval '1 minute') returns uuid
language sql as $$
  insert into public.inbox (user_id, type, payload, dedupe_key, deliver_after, push_after, push_state)
  values (p_user, 'permission_lapsed', jsonb_build_object('permission', 'location_always', 'platform', 'ios', 'deviceId', p_device),
    p_key, now() - p_after, now() - p_after, 'pending')
  returning id
$$;

-- every table (outside vault and the catalogs) whose rows contain p_needle; a table postgres cannot
-- read is reported as unreadable:<name>
create function pg_temp.tables_containing(p_needle text) returns text[]
language plpgsql as $$
declare
  r record;
  n int;
  v_out text[] := '{}';
begin
  for r in select c.oid::regclass::text as t from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'm') and ns.nspname not in ('vault', 'pg_catalog', 'information_schema', 'pg_toast')
      and ns.nspname not like 'pg_temp%' loop
    begin
      execute format('select count(*) from %s x where x::text like %L', r.t, '%' || p_needle || '%') into n;
      if n > 0 then
        v_out := v_out || r.t;
      end if;
    exception when insufficient_privilege then
      v_out := v_out || ('unreadable:' || r.t);
    end;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 1. structure
-- ---------------------------------------------------------------------------
select has_extension('pg_net', 'pg_net is installed');
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_net'), 'extensions', 'pg_net is created with schema extensions (#14)');

select columns_are('public', 'notification_prefs', array['user_id', 'categories', 'quiet_enabled', 'quiet_start', 'quiet_end', 'tz',
  'local_sent_day', 'local_sent_count', 'created_at', 'updated_at']::name[], 'notification_prefs has exactly its columns');
select columns_are('public', 'inbox', array['id', 'user_id', 'type', 'payload', 'ref_id', 'dedupe_key', 'deliver_after', 'push_after', 'read_at', 'dismissed_at',
  'push_state', 'push_reason', 'push_attempts', 'push_claimed_at', 'pushed_at', 'created_at', 'updated_at']::name[], 'inbox has exactly its columns');
select columns_are('public', 'push_registrations', array['token', 'user_id', 'device_id', 'platform', 'last_registered_at', 'created_at', 'updated_at']::name[],
  'push_registrations has exactly its columns');
select columns_are('public', 'push_deliveries', array['id', 'inbox_id', 'user_id', 'token', 'ticket_id', 'error', 'receipt_status', 'receipt_error',
  'receipt_checked_at', 'created_at', 'updated_at']::name[], 'push_deliveries has exactly its columns');
select is((select row(data_type, is_nullable, column_default)::text from information_schema.columns
    where table_schema = 'public' and table_name = 'devices' and column_name = 'drive_state'), row('text', 'NO', '''idle''::text')::text,
  'devices.drive_state is text not null default idle');
select has_column('public', 'devices', 'drive_state_at', 'devices carries drive_state_at');
select throws_ok($$ update public.devices set drive_state = 'parked' where id = 'a-phone' $$, '23514', null, 'drive_state is idle or recording');
select is(col_description('public.devices'::regclass, (select attnum from pg_attribute where attrelid = 'public.devices'::regclass and attname = 'push_token')),
  'Legacy (0001). Read by no server path: push tokens live in public.push_registrations (0007).', 'devices.push_token says no server path reads it');

select policies_are('public', 'notification_prefs', array['notification_prefs_select_own', 'notification_prefs_insert_own', 'notification_prefs_update_own']::name[],
  'notification_prefs: select, insert and update own');
select policies_are('public', 'inbox', array['inbox_select_own']::name[], 'inbox: select own only');
select policies_are('public', 'push_registrations', array['push_registrations_select_own']::name[], 'push_registrations: select own only');
select policies_are('public', 'push_deliveries', '{}'::name[], 'push_deliveries has no policies (server only)');
select is((select array_agg(polname::text order by polname) from pg_policy
    where polrelid in ('public.notification_prefs'::regclass, 'public.inbox'::regclass, 'public.push_registrations'::regclass)
      and polroles = array['authenticated'::regrole::oid]), array['inbox_select_own', 'notification_prefs_insert_own', 'notification_prefs_select_own',
      'notification_prefs_update_own', 'push_registrations_select_own'], 'every policy is to authenticated');
select is((select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'inbox_select_own'),
  '((user_id = ( SELECT auth.uid() AS uid)) AND (deliver_after <= now()))', 'inbox rows are visible to their owner once due');

select table_privs_are('public', 'notification_prefs', 'anon', '{}'::name[], 'anon has nothing on notification_prefs');
select table_privs_are('public', 'inbox', 'anon', '{}'::name[], 'anon has nothing on inbox');
select table_privs_are('public', 'push_registrations', 'anon', '{}'::name[], 'anon has nothing on push_registrations');
select table_privs_are('public', 'push_deliveries', 'anon', '{}'::name[], 'anon has nothing on push_deliveries');
select table_privs_are('public', 'notification_prefs', 'authenticated', array['SELECT']::name[], 'authenticated selects notification_prefs (writes are per column)');
select table_privs_are('public', 'inbox', 'authenticated', '{}'::name[], 'authenticated has no table-wide privilege on inbox (select is per column)');
select table_privs_are('public', 'push_registrations', 'authenticated', array['SELECT']::name[], 'authenticated only selects push_registrations');
select table_privs_are('public', 'push_deliveries', 'authenticated', '{}'::name[], 'authenticated has nothing on push_deliveries');
select column_privs_are('public', 'inbox', 'pushed_at', 'authenticated', array['SELECT']::name[], 'inbox.pushed_at is readable (the server half of the cap)');
select column_privs_are('public', 'inbox', 'payload', 'authenticated', array['SELECT']::name[], 'inbox.payload is read-only');
select column_privs_are('public', 'inbox', 'read_at', 'authenticated', array['SELECT']::name[], 'inbox.read_at is read-only (mark_inbox_read writes it)');
select column_privs_are('public', 'inbox', 'push_state', 'authenticated', '{}'::name[], 'inbox.push_state is hidden');
select column_privs_are('public', 'inbox', 'push_reason', 'authenticated', '{}'::name[], 'inbox.push_reason is hidden');
select column_privs_are('public', 'inbox', 'push_attempts', 'authenticated', '{}'::name[], 'inbox.push_attempts is hidden');
select column_privs_are('public', 'inbox', 'push_claimed_at', 'authenticated', '{}'::name[], 'inbox.push_claimed_at is hidden');
select column_privs_are('public', 'inbox', 'push_after', 'authenticated', '{}'::name[], 'inbox.push_after is hidden');
select is((select pg_get_indexdef('public.inbox_due_idx'::regclass)),
  'CREATE INDEX inbox_due_idx ON public.inbox USING btree (push_after) WHERE (push_state = ANY (ARRAY[''pending''::text, ''deferred''::text]))',
  'the due index is on push_after (ruling T2 I1)');
select column_privs_are('public', 'inbox', 'dedupe_key', 'authenticated', '{}'::name[], 'inbox.dedupe_key is hidden');
select column_privs_are('public', 'notification_prefs', 'user_id', 'authenticated', array['SELECT', 'INSERT']::name[], 'notification_prefs.user_id is insert-only');
select column_privs_are('public', 'notification_prefs', 'categories', 'authenticated', array['SELECT', 'INSERT', 'UPDATE']::name[], 'categories are client-editable');
select column_privs_are('public', 'notification_prefs', 'local_sent_count', 'authenticated', array['SELECT', 'INSERT', 'UPDATE']::name[], 'the phone writes its day count');
select column_privs_are('public', 'notification_prefs', 'created_at', 'authenticated', array['SELECT']::name[], 'notification_prefs.created_at is server-owned');
select column_privs_are('public', 'notification_prefs', 'updated_at', 'authenticated', array['SELECT']::name[], 'notification_prefs.updated_at is server-owned');

select col_is_pk('public', 'notification_prefs', 'user_id', 'notification_prefs is keyed by user_id');
select col_is_pk('public', 'inbox', 'id', 'inbox is keyed by id');
select col_default_is('public', 'inbox', 'id', 'gen_random_uuid()', 'inbox ids are random uuids');
select col_is_pk('public', 'push_registrations', 'token', 'push_registrations is keyed by token');
select col_is_pk('public', 'push_deliveries', 'id', 'push_deliveries is keyed by id');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'inbox_user_dedupe_key'), 'UNIQUE (user_id, dedupe_key)', 'inbox is unique on (user_id, dedupe_key)');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'push_registrations_device_fkey'),
  'FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE', 'a registration cascades from its device');
select has_index('public', 'inbox', 'inbox_user_created_idx', 'inbox (user_id, created_at desc)');
select has_index('public', 'inbox', 'inbox_due_idx', 'inbox due scan');
select has_index('public', 'inbox', 'inbox_sending_idx', 'inbox lease scan');
select has_index('public', 'inbox', 'inbox_user_sent_idx', 'inbox sent-per-user scan');
select has_index('public', 'push_registrations', 'push_registrations_user_idx', 'push_registrations (user_id)');
select has_index('public', 'push_registrations', 'push_registrations_user_device_idx', 'push_registrations (user_id, device_id), the composite FK');
select has_index('public', 'push_deliveries', 'push_deliveries_inbox_idx', 'push_deliveries (inbox_id)');
select has_index('public', 'push_deliveries', 'push_deliveries_user_idx', 'push_deliveries (user_id)');
select has_index('public', 'push_deliveries', 'push_deliveries_token_idx', 'push_deliveries (token) where not null');
select has_index('public', 'push_deliveries', 'push_deliveries_receipt_due_idx', 'push_deliveries receipts due');
select is((select array_agg(indexrelid::regclass::text order by indexrelid::regclass::text) from pg_index where indrelid = 'public.inbox'::regclass and indpred is not null),
  array['inbox_due_idx', 'inbox_sending_idx', 'inbox_user_sent_idx'], 'the three inbox scans are partial indexes');

select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.touch_updated_at()'::regprocedure
    and tgrelid in ('public.notification_prefs'::regclass, 'public.inbox'::regclass, 'public.push_registrations'::regclass, 'public.push_deliveries'::regclass)), 4,
  'all four tables keep updated_at');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.refuse_underage_writes()'::regprocedure
    and tgrelid in ('public.notification_prefs'::regclass, 'public.inbox'::regclass, 'public.push_registrations'::regclass)), 3,
  'prefs, inbox and registrations refuse an under-13 account''s inserts');
select has_trigger('public', 'trips', 'trips_enqueue_summary', 'trips enqueue the summary history row');
select has_trigger('public', 'devices', 'devices_enqueue_permission_lapse', 'devices enqueue a permission lapse');
select has_trigger('public', 'devices', 'devices_drive_state_stamp', 'devices stamp drive_state_at');
select has_trigger('public', 'devices', 'devices_drive_state_at_pin', 'devices discard a client drive_state_at');
select has_trigger('public', 'profiles', 'profiles_minimise_underage_notifications', 'a new u13 band minimises the notification tables');

select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values ('b7000000-0000-4000-8000-000000000001', 'bogus', '{}', 'k') $$,
  '23514', null, 'an unknown inbox type is refused');
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values ('b7000000-0000-4000-8000-000000000001', 'trip_summary', '[]', 'k') $$,
  '23514', null, 'an inbox payload must be an object');
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values ('b7000000-0000-4000-8000-000000000001', 'trip_summary',
    jsonb_build_object('x', repeat('y', 3000)), 'k') $$, '23514', null, 'an inbox payload is size-capped');
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values ('b7000000-0000-4000-8000-000000000001', 'trip_summary', '{}', repeat('k', 129)) $$,
  '23514', null, 'a dedupe key is at most 128 characters');
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key, push_state) values ('b7000000-0000-4000-8000-000000000001', 'trip_summary', '{}', 'k', 'lost') $$,
  '23514', null, 'push_state is one of six');
select throws_ok($$ insert into public.push_registrations (token, user_id, device_id, platform) values ('not-a-token', 'b7000000-0000-4000-8000-000000000001', 'a-phone', 'ios') $$,
  '23514', null, 'a registration token must look like an Expo token');
select throws_ok($$ insert into public.notification_prefs (user_id, local_sent_count) values ('b7000000-0000-4000-8000-000000000002', 51) $$,
  '23514', null, 'local_sent_count is at most 50');
select throws_ok($$ insert into public.push_deliveries (inbox_id, user_id, receipt_status) values (gen_random_uuid(), 'b7000000-0000-4000-8000-000000000001', 'maybe') $$,
  '23514', null, 'receipt_status is ok or error');

-- definer hygiene and execute grants
select is((select count(*)::int from pg_proc p where p.oid in (
    'public.enqueue_permission_lapse()'::regprocedure, 'public.mark_inbox_read(uuid[])'::regprocedure, 'public.dismiss_inbox(uuid[])'::regprocedure,
    'public.register_push_token(text, text)'::regprocedure, 'public.unregister_push_token(text)'::regprocedure,
    'public.merge_own_profile_flags(jsonb)'::regprocedure, 'public.claim_push_batch(integer, integer)'::regprocedure,
    'public.record_push_outcomes(jsonb)'::regprocedure, 'public.push_receipts_due(integer)'::regprocedure,
    'public.record_push_receipts(jsonb)'::regprocedure)
  and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public']), 10,
  'the lapse trigger, five RPCs and four writers are security definer, owned by postgres, pinning exactly search_path=public');
select is((select count(*)::int from pg_proc p where p.oid in (
    'public.is_known_tz(text)'::regprocedure, 'public.is_short_drive(numeric, numeric)'::regprocedure,
    'public.notification_prefs_validate()'::regprocedure, 'public.user_tz(uuid)'::regprocedure,
    'public.user_local_date(uuid, timestamptz)'::regprocedure, 'public.notification_defaults()'::regprocedure,
    'public.stamp_drive_state()'::regprocedure, 'public.enqueue_trip_summary()'::regprocedure,
    'public.pin_drive_state_at()'::regprocedure, 'public.push_sweep_signature(bigint, text)'::regprocedure,
    'public.minimise_underage_notifications()'::regprocedure, 'public.inbox_subject_gone(uuid, text, uuid, jsonb)'::regprocedure,
    'public.dispatch_push()'::regprocedure)
  and not p.prosecdef and p.proconfig = array['search_path=public']), 13,
  'every other function (dispatch_push included) is security invoker pinning exactly search_path=public');
select is(array(select has_function_privilege('authenticated', f, 'execute') from unnest(array['public.mark_inbox_read(uuid[])', 'public.dismiss_inbox(uuid[])',
    'public.register_push_token(text, text)', 'public.unregister_push_token(text)', 'public.merge_own_profile_flags(jsonb)']) f),
  array[true, true, true, true, true], 'authenticated executes the five client RPCs');
select is(array(select has_function_privilege('service_role', f, 'execute') from unnest(array['public.claim_push_batch(integer, integer)',
    'public.record_push_outcomes(jsonb)', 'public.push_receipts_due(integer)', 'public.record_push_receipts(jsonb)']) f),
  array[true, true, true, true], 'service_role executes the four writers');
select is((select bool_or(has_function_privilege('anon', f, 'execute')) from unnest(array['public.mark_inbox_read(uuid[])', 'public.dismiss_inbox(uuid[])',
    'public.register_push_token(text, text)', 'public.unregister_push_token(text)', 'public.merge_own_profile_flags(jsonb)',
    'public.claim_push_batch(integer, integer)', 'public.record_push_outcomes(jsonb)', 'public.push_receipts_due(integer)', 'public.record_push_receipts(jsonb)',
    'public.dispatch_push()', 'public.enqueue_permission_lapse()', 'public.enqueue_trip_summary()', 'public.minimise_underage_notifications()',
    'public.user_tz(uuid)', 'public.notification_defaults()', 'public.inbox_subject_gone(uuid, text, uuid, jsonb)', 'public.is_known_tz(text)',
    'public.is_short_drive(numeric, numeric)', 'public.notification_prefs_validate()', 'public.stamp_drive_state()',
    'public.pin_drive_state_at()', 'public.push_sweep_signature(bigint, text)']) f),
  false, 'anon executes nothing this migration creates');
select is((select bool_or(has_function_privilege('authenticated', f, 'execute')) from unnest(array['public.claim_push_batch(integer, integer)',
    'public.record_push_outcomes(jsonb)', 'public.push_receipts_due(integer)', 'public.record_push_receipts(jsonb)', 'public.dispatch_push()',
    'public.enqueue_permission_lapse()', 'public.enqueue_trip_summary()', 'public.minimise_underage_notifications()', 'public.user_tz(uuid)',
    'public.notification_defaults()', 'public.inbox_subject_gone(uuid, text, uuid, jsonb)',
    'public.is_short_drive(numeric, numeric)', 'public.notification_prefs_validate()', 'public.stamp_drive_state()',
    'public.pin_drive_state_at()', 'public.push_sweep_signature(bigint, text)']) f),
  false, 'authenticated executes no writer, trigger, helper or dispatch_push');
select is(has_function_privilege('authenticated', 'public.is_known_tz(text)', 'execute'), true,
  'authenticated executes is_known_tz, which its own notification_prefs writes reach through the invoker trigger (fix round 4)');
select is((select bool_or(has_function_privilege('service_role', f, 'execute')) from unnest(array['public.dispatch_push()', 'public.push_sweep_signature(bigint, text)', 'public.mark_inbox_read(uuid[])',
    'public.dismiss_inbox(uuid[])', 'public.register_push_token(text, text)', 'public.unregister_push_token(text)', 'public.merge_own_profile_flags(jsonb)']) f),
  false, 'service_role runs neither dispatch_push nor the client RPCs');

-- the extension schemas
select is(array[has_schema_privilege('anon', 'cron', 'usage'), has_schema_privilege('authenticated', 'cron', 'usage'),
                has_schema_privilege('service_role', 'cron', 'usage')], array[false, false, false],
  'no API role can use the cron schema, so no cron function is reachable (#3)');
select is((select count(*)::int from pg_namespace n, aclexplode(n.nspacl) a
    where n.nspname = 'net' and a.grantee in ('anon'::regrole, 'authenticated'::regrole) and a.grantor <> 'supabase_admin'::regrole), 0,
  'this migration grants the API roles nothing on net (their usage comes only from the platform''s pg_net event trigger)');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~ '\mnet\.'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or p.prosecdef)), 0,
  'no function in public that calls net is a definer or executable by anon or authenticated');

-- cron jobs
select is((select row(schedule, command, username)::text from cron.job where jobname = 'push-sender-sweep'),
  row('* * * * *', 'select public.dispatch_push()', 'postgres')::text, 'push-sender-sweep runs dispatch_push every minute as postgres');
select is((select row(schedule, command, username)::text from cron.job where jobname = 'cron-log-purge'),
  row('30 3 * * *', 'delete from cron.job_run_details where end_time < now() - interval ''3 days''', 'postgres')::text,
  'cron-log-purge keeps three days of cron history');

-- config
select is((select row(value, is_public)::text from public.app_config where key = 'notification_defaults'),
  row('{"quiet_enabled":true,"quiet_start":"22:00","quiet_end":"07:00","tz":"America/Los_Angeles"}'::jsonb, true)::text,
  'notification_defaults is the public 22:00-07:00 Los Angeles default');
select is((select count(*)::int from supabase_migrations.schema_migrations
    where version = '0007' and array_to_string(statements, ' ') like '%notification_defaults%on conflict (key) do nothing%'), 1,
  'the config row is inserted with on conflict do nothing');
update public.app_config set value = '{"quiet_enabled":"yes","quiet_start":"25:00","tz":"Mars/Olympus"}' where key = 'notification_defaults';
select is(public.notification_defaults(), '{"quiet_enabled":true,"quiet_start":"22:00","quiet_end":"07:00","tz":"America/Los_Angeles"}'::jsonb,
  'a malformed operator value falls back key by key to the migration''s defaults');
update public.app_config set value = '{"quiet_enabled":false,"quiet_start":"21:30","quiet_end":"06:15","tz":"America/Chicago"}' where key = 'notification_defaults';
select is(public.notification_defaults(), '{"quiet_enabled":false,"quiet_start":"21:30","quiet_end":"06:15","tz":"America/Chicago"}'::jsonb,
  'a well-formed operator value governs');
update public.app_config set value = '{"quiet_enabled":true,"quiet_start":"22:00","quiet_end":"07:00","tz":"America/Los_Angeles"}' where key = 'notification_defaults';

-- helpers
select is(array[public.is_short_drive(804.671, 600), public.is_short_drive(804.672, 119.9), public.is_short_drive(804.672, 120), public.is_short_drive(null, 600)],
  array[true, true, false, true], 'is_short_drive is the scorer''s 0.5 mile / 120 s minimum');
select is(array[public.is_known_tz('America/New_York'), public.is_known_tz('Etc/GMT+5'), public.is_known_tz('UTC'), public.is_known_tz('+05:00'),
                public.is_known_tz('Mars/Olympus'), public.is_known_tz('posix/America/New_York'), public.is_known_tz('EST5EDT'), public.is_known_tz(null)],
  array[true, true, true, false, false, false, false, false], 'is_known_tz takes IANA names the server knows, nothing else');

select is(public.push_sweep_signature(1790000000, 'rw-test-vector-key-0123456789abcdef'),
  '1790000000.c1ba00cabb1bd464447aaa98eb43cd7fffaaee9cf3809292c15c696632ca752f',
  'the sweep signature matches an independently computed HMAC-SHA256 test vector (the contract push-sender verifies)');

-- fix round 4: every function a client write can reach is executable by that client. Catalog-only,
-- so the order of earlier statements cannot mask it: for each table anon or authenticated may
-- INSERT, UPDATE or DELETE (public and storage), the invoker trigger functions' bodies (followed
-- through invoker callees; definer callees still need EXECUTE), the trigger WHEN clauses, the policies
-- that apply to the role, the CHECKs and the defaults.
-- every function a client (role r) write can reach, and whether r may execute it
create function pg_temp.client_reach(r text) returns table (via text, fn regprocedure, can_execute boolean)
language plpgsql as $$
begin
  return query
  with recursive writable as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'storage')
      and (has_any_column_privilege(r, c.oid, 'INSERT') or has_any_column_privilege(r, c.oid, 'UPDATE')
           or has_table_privilege(r, c.oid, 'DELETE'))
  ),
  -- trigger functions that run as the writer (invoker), on client-writable tables
  inv_trig as (
    select t.tgrelid::regclass::text || '.' || t.tgname as via, t.tgfoid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and not p.prosecdef
  ),
  -- direct expression dependencies: trigger WHEN, policies, CHECKs, defaults (pg_depend)
  expr as (
    select 'trigger WHEN ' || t.tgrelid::regclass::text || '.' || t.tgname as via, d.refobjid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid
    join pg_depend d on d.classid = 'pg_trigger'::regclass and d.objid = t.oid and d.refclassid = 'pg_proc'::regclass
    where not t.tgisinternal and d.refobjid <> t.tgfoid
    union all
    select 'policy ' || pol.polrelid::regclass::text || '.' || pol.polname, d.refobjid
    from pg_policy pol join writable w on w.oid = pol.polrelid
      and (pol.polroles @> array[r::regrole::oid] or pol.polroles = array[0::oid])
    join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'check ' || con.conrelid::regclass::text || '.' || con.conname, d.refobjid
    from pg_constraint con join writable w on w.oid = con.conrelid
    join pg_depend d on d.classid = 'pg_constraint'::regclass and d.objid = con.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'default ' || ad.adrelid::regclass::text, d.refobjid
    from pg_attrdef ad join writable w on w.oid = ad.adrelid
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_proc'::regclass
  ),
  -- calls from invoker function bodies: ANY schema-qualified `<schema>.<name>(` (fix round 5, n1),
  -- resolved through pg_namespace + pg_proc to EVERY overload of that name, followed through invoker
  -- callees (a definer callee is still checked for EXECUTE, but runs as its owner beyond that).
  -- Unqualified calls are not seen: the conventions require every name to be schema-qualified.
  body_calls(via, caller, callee) as (
    select it.via, it.fid, p2.oid
    from inv_trig it join pg_proc p on p.oid = it.fid
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
    union
    select bc.via, bc.callee, p2.oid
    from body_calls bc join pg_proc p on p.oid = bc.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  ),
  expr_calls(via, callee) as (
    select e.via, e.fid from expr e
    union
    select ec.via, p2.oid
    from expr_calls ec join pg_proc p on p.oid = ec.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  )
  select distinct x.via, x.callee::regprocedure, has_function_privilege(r, x.callee, 'execute')
  from (select b.via, b.callee from body_calls b union select e.via, e.callee from expr_calls e) x
  order by 1, 2;
end $$;
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach('authenticated') where not can_execute),
  '{}'::text[], 'every function an authenticated write reaches (trigger bodies, WHEN, policies, CHECKs, defaults) is executable by authenticated');
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach('anon') where not can_execute),
  '{}'::text[], 'and every function an anon write reaches is executable by anon');
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach('service_role') where not can_execute),
  '{}'::text[], 'and every function a service_role write reaches is executable by service_role');
select is((select count(*)::int from pg_temp.client_reach('authenticated') where via = 'notification_prefs.notification_prefs_validate' and fn = 'public.is_known_tz(text)'::regprocedure), 1,
  'the audit does see the trigger''s call into is_known_tz (it is not vacuous)');
-- n1 plant (rolled back, then dropped): a client-writable table whose invoker trigger calls pgcrypto
-- (extensions.digest, two overloads; extensions.gen_random_bytes) and a probe in extensions that
-- authenticated may not execute
create table public.zz_audit7 (id int);
alter table public.zz_audit7 enable row level security;
grant insert on public.zz_audit7 to authenticated;
create function extensions.zz_audit7_probe() returns int language sql as 'select 1';
revoke all on function extensions.zz_audit7_probe() from public, anon, authenticated;
create function public.zz_audit7_fn() returns trigger language plpgsql set search_path = public as $$
begin
  perform extensions.digest('x', 'sha256'), extensions.gen_random_bytes(4), extensions.zz_audit7_probe();
  return new;
end $$;
create trigger zz_audit7_trg before insert on public.zz_audit7 for each row execute function public.zz_audit7_fn();
select is((select array_agg(row(fn::text, can_execute)::text order by fn::text) from pg_temp.client_reach('authenticated') where via = 'zz_audit7.zz_audit7_trg'),
  array[row('extensions.digest(bytea,text)'::regprocedure, true)::text, row('extensions.digest(text,text)'::regprocedure, true)::text,
        row('extensions.gen_random_bytes(integer)'::regprocedure, true)::text, row('extensions.zz_audit7_probe()'::regprocedure, false)::text],
  'the audit resolves calls into other schemas, every overload of each name, and flags one the writer cannot execute (n1)');
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach('authenticated') where not can_execute),
  array['zz_audit7.zz_audit7_trg -> ' || 'extensions.zz_audit7_probe()'::regprocedure::text], 'so the client-write audit would fail on it');
drop trigger zz_audit7_trg on public.zz_audit7;
drop function public.zz_audit7_fn();
drop function extensions.zz_audit7_probe();
drop table public.zz_audit7;
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach('authenticated') where not can_execute),
  '{}'::text[], 'with the plant dropped, the real schema is clean again');

-- catch-alls
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe7 (id int);
create function public.zz_probe7_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe7', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe7_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe7_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe7_fn();
drop table public.zz_probe7;
-- every public table that references a user is covered by the minimisation (0006's function or
-- this migration's), except profiles (cleared in place) and private_profiles (kept: birth date, band)
select is((select coalesce(array_agg(t.relname::text order by t.relname), '{}') from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relkind = 'r' and t.relname not in ('profiles', 'private_profiles')
      and (exists (select 1 from pg_constraint c where c.conrelid = t.oid and c.contype = 'f' and c.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'user_id' and not a.attisdropped))
      and not exists (select 1 from pg_proc p where p.oid in ('public.minimise_underage_account()'::regprocedure, 'public.minimise_underage_notifications()'::regprocedure)
                      and p.prosrc ~ ('delete from public\.' || t.relname || ' where'))), '{}'::text[],
  'every user-referencing public table is deleted by the under-13 minimisation');

-- ---------------------------------------------------------------------------
-- 2. the drive-summary producer (apply_trip, as the service role)
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$ select public.apply_trip((select p from fx where name = 'final')) $$, 'A''s scored drive syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'final')) $$, 'and replays');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'unknown')) $$, 'a role-unknown drive syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'unknown-c')) $$, 'a role-unknown grade-C drive syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'discarded')) $$, 'a discarded drive syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'short')) $$, 'a too-short drive syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'short-unknown')) $$, 'a short drive whose role is unknown syncs');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'just-ended')) $$, 'a drive that ended just now syncs');
reset role;
select set_config('request.jwt.claims', '', true);

select is((select count(*)::int from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000001' and type = 'trip_summary'), 4,
  'four summary rows: the scored drive (once, despite the replay), both role-unknown drives and the one just ended');
select is((select row(i.push_state, i.push_reason, i.ref_id = t.id, i.dedupe_key = 'trip_summary:' || t.id, i.deliver_after = now() and i.push_after = now())::text
    from public.inbox i join public.trips t on t.id = i.ref_id where t.client_trip_id = 'a-final'),
  row('skipped', 'local', true, true, true)::text, 'the summary row is born skipped/local, keyed to its trip, due at once (ended 30 min ago)');
select is((select i.payload - 'startedAt' - 'endedAt' from public.inbox i join public.trips t on t.id = i.ref_id where t.client_trip_id = 'a-final'),
  '{"clientTripId":"a-final","distanceM":12500.5,"status":"final","roleUnknown":false,"scorableIfDriver":true}'::jsonb,
  'its payload holds facts only: no score, no place, no copy');
select is((select row((i.payload ->> 'startedAt')::timestamptz = t.started_at, (i.payload ->> 'endedAt')::timestamptz = t.ended_at,
      i.payload ->> 'startedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')::text
    from public.inbox i join public.trips t on t.id = i.ref_id where t.client_trip_id = 'a-final'), row(true, true, true)::text,
  'startedAt and endedAt are ISO UTC strings of the stored times');
select is((select array_agg(row(i.payload ->> 'status', i.payload -> 'roleUnknown', i.payload -> 'scorableIfDriver')::text order by t.client_trip_id)
    from public.inbox i join public.trips t on t.id = i.ref_id where t.client_trip_id in ('a-unknown', 'a-unknown-c')),
  array[row('unscored', 'true'::jsonb, 'true'::jsonb)::text, row('unscored', 'true'::jsonb, 'false'::jsonb)::text],
  'a role-unknown drive says so; scorableIfDriver is false for grade C (ruling T4 r1)');
select is((select count(*)::int from public.inbox i join public.trips t on t.id = i.ref_id
    where t.client_trip_id in ('a-discarded', 'a-short', 'a-short-unknown')), 0,
  'no row for a discarded drive, a too-short drive, or a short drive of unknown role (ruling I9)');
select is((select row(i.deliver_after - t.ended_at, i.push_after = i.deliver_after)::text from public.inbox i join public.trips t on t.id = i.ref_id where t.client_trip_id = 'a-just-ended'),
  row(interval '2 minutes', true)::text, 'a drive that ended just now is due two minutes after its end');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select is((select count(*)::int from public.inbox where type = 'trip_summary'), 3, 'A sees the three due summaries, not the one not yet due');
select is((select count(*)::int from public.inbox where payload ->> 'clientTripId' = 'a-just-ended'), 0, 'the not-yet-due row is invisible');
select throws_ok($$ select push_state from public.inbox $$, '42501', null, 'A cannot read push_state');
select lives_ok($$ select id, pushed_at from public.inbox $$, 'A reads pushed_at');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000002"}', true);
select is((select count(*)::int from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000001'), 0, 'B never sees A''s inbox');
reset role;
select set_config('request.jwt.claims', '', true);
update public.inbox set deliver_after = now() - interval '1 second' where payload ->> 'clientTripId' = 'a-just-ended';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select is((select count(*)::int from public.inbox where payload ->> 'clientTripId' = 'a-just-ended'), 1, 'once due, A sees it');
select set_config('request.jwt.claims', '{"role":"anon"}', true);
reset role;
set local role anon;
select throws_ok($$ select id from public.inbox $$, '42501', null, 'anon cannot read the inbox');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 3. mark_inbox_read / dismiss_inbox
-- ---------------------------------------------------------------------------
insert into res (k, v) select 'b-row', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000002', 'b-fixture', 'b-phone'));
update public.inbox set push_state = 'skipped', push_reason = 'inbox_only' where id = (select (v #>> '{}')::uuid from res where k = 'b-row');
insert into res (k, v) select 'a-future', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'a-future', 'a-phone', interval '-1 hour'));
update public.inbox set push_state = 'skipped', push_reason = 'inbox_only' where id = (select (v #>> '{}')::uuid from res where k = 'a-future');

select throws_ok($$ select public.mark_inbox_read(array[gen_random_uuid()]) $$, '42501', 'mark_inbox_read requires an authenticated user', 'no JWT, no read');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.mark_inbox_read(null) $$, '22023', 'ids must be 1 to 100 inbox ids', 'null ids are refused');
select throws_ok($$ select public.mark_inbox_read('{}') $$, '22023', 'ids must be 1 to 100 inbox ids', 'no ids are refused');
select throws_ok($$ select public.mark_inbox_read(array(select gen_random_uuid() from generate_series(1, 101))) $$, '22023', 'ids must be 1 to 100 inbox ids', '101 ids are refused');
select throws_ok($$ select public.mark_inbox_read(array[gen_random_uuid(), null]) $$, '22023', 'ids must be 1 to 100 inbox ids', 'a null id is refused');
select throws_ok($$ select public.dismiss_inbox('{}') $$, '22023', 'ids must be 1 to 100 inbox ids', 'dismiss has the same bounds');
select is(public.mark_inbox_read(array(select id from public.inbox where type = 'trip_summary' order by id limit 2)
    || (select (v #>> '{}')::uuid from res where k = 'b-row') || gen_random_uuid()), 2,
  'A marks two own rows read; B''s id and an unknown id are ignored (the count says so)');
select is(public.mark_inbox_read(array(select id from public.inbox where type = 'trip_summary' order by id limit 2)), 2, 'a replay still matches both (idempotent)');
select is(public.mark_inbox_read(array[(select (v #>> '{}')::uuid from res where k = 'a-future')]), 0, 'a row not yet due is not A''s to read yet');
select is(public.mark_inbox_read(array[(select (v #>> '{}')::uuid from res where k = 'b-row')]), 0, 'A on B''s row changes nothing');
select is(public.dismiss_inbox(array(select id from public.inbox where type = 'trip_summary' order by id limit 1)), 1, 'A dismisses one row');
select is(public.dismiss_inbox(array[(select (v #>> '{}')::uuid from res where k = 'b-row')]), 0, 'A cannot dismiss B''s row');
select throws_ok($$ update public.inbox set read_at = now() where user_id = 'b7000000-0000-4000-8000-000000000002' $$, '42501', null,
  'there is no direct client update of the inbox');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(read_at, dismissed_at)::text from public.inbox where id = (select (v #>> '{}')::uuid from res where k = 'b-row')),
  row(null::timestamptz, null::timestamptz)::text, 'B''s row is untouched');
select is((select count(*)::int from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000001' and read_at = now()), 2, 'exactly A''s two rows are read');
select is((select count(*)::int from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000001' and dismissed_at = now()), 1, 'exactly one is dismissed');

-- ---------------------------------------------------------------------------
-- 4. push registrations
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.register_push_token('a-phone', 'ExpoPushToken[short]') $$, '22023', 'invalid push token', 'a malformed token is refused');
select throws_ok($$ select public.register_push_token('a-phone', null) $$, '22023', 'invalid push token', 'a null token is refused');
select throws_ok($$ select public.register_push_token('no-such-phone', 'ExponentPushToken[aaaaaaaaaaaa1]') $$, '22023', 'unknown device', 'an unknown device is refused');
select throws_ok($$ select public.register_push_token('b-phone', 'ExponentPushToken[aaaaaaaaaaaa1]') $$, '22023', 'unknown device', 'B''s device is not A''s');
select lives_ok($$ select public.register_push_token('a-phone', 'ExponentPushToken[aaaaaaaaaaaa1]') $$, 'A registers a token');
select lives_ok($$ select public.register_push_token('a-tablet', 'ExpoPushToken[tablettoken01]') $$, 'and one for a second device');
select is((select array_agg(row(token, device_id, platform)::text order by token collate "C") from public.push_registrations),
  array[row('ExpoPushToken[tablettoken01]', 'a-tablet', 'ios')::text, row('ExponentPushToken[aaaaaaaaaaaa1]', 'a-phone', 'ios')::text],
  'A reads both registrations, the platform taken from the devices row');
select lives_ok($$ select public.register_push_token('a-phone', 'ExponentPushToken[aaaaaaaaaaaa2]') $$, 'the phone''s token rotates');
select is((select array_agg(token order by token) from public.push_registrations where device_id = 'a-phone'), array['ExponentPushToken[aaaaaaaaaaaa2]'],
  'the rotated-out token is gone; the other device keeps its own');
select throws_ok($$ insert into public.push_registrations (token, user_id, device_id, platform)
    values ('ExponentPushToken[forgedtoken1]', 'b7000000-0000-4000-8000-000000000001', 'a-phone', 'ios') $$, '42501', null, 'there is no direct client write of registrations');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000002"}', true);
select is((select count(*)::int from public.push_registrations), 0, 'B sees none of A''s registrations');
select lives_ok($$ select public.register_push_token('b-phone', 'ExponentPushToken[aaaaaaaaaaaa2]') $$, 'B registers the token A''s phone last held (the phone changed hands)');
select is(public.unregister_push_token('ExpoPushToken[tablettoken01]'), false, 'B cannot unregister A''s token: false');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(user_id, device_id, platform)::text from public.push_registrations where token = 'ExponentPushToken[aaaaaaaaaaaa2]'),
  row('b7000000-0000-4000-8000-000000000002'::uuid, 'b-phone', 'android')::text, 'the token now belongs to B and B''s device alone');
select is((select count(*)::int from public.push_registrations where token = 'ExpoPushToken[tablettoken01]'), 1, 'A''s other token survived B''s attempt');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select is(public.unregister_push_token('ExponentPushToken[aaaaaaaaaaaa2]'), false, 'A''s old token is B''s now: false');
select is(public.unregister_push_token('ExpoPushToken[tablettoken01]'), true, 'A unregisters its own token: true');
select is(public.unregister_push_token('ExpoPushToken[tablettoken01]'), false, 'and again: false, not an error');
select throws_ok($$ select public.unregister_push_token('nope') $$, '22023', 'invalid push token', 'unregister checks the pattern');
select lives_ok($$ select public.register_push_token('a-phone', 'ExponentPushToken[aaaaaaaaaaaa3]') $$, 'A registers again');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.register_push_token('a-phone', 'ExponentPushToken[aaaaaaaaaaaa9]') $$, '42501', 'register_push_token requires an authenticated user', 'no JWT, no registration');
delete from public.devices where user_id = 'b7000000-0000-4000-8000-000000000002' and id = 'b-phone';
select is((select count(*)::int from public.push_registrations where user_id = 'b7000000-0000-4000-8000-000000000002'), 0, 'deleting a device deletes its registrations');
insert into public.devices (id, user_id, platform) values ('b-phone', 'b7000000-0000-4000-8000-000000000002', 'android');

-- ---------------------------------------------------------------------------
-- 5. drive state (security M-1: drive_state_at is the server's, on every insert and update)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select lives_ok($$ update public.devices set drive_state = 'recording', drive_state_at = '2000-01-01' where id = 'a-phone' $$, 'A reports recording');
select lives_ok($$ update public.devices set drive_state_at = now() + interval '10 years' where id = 'a-tablet' $$, 'A writes a future drive_state_at alone');
select lives_ok($$ update public.devices set drive_state_at = now() + interval '10 years' where id = 'a-phone' $$, 'and on the recording phone');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(drive_state, drive_state_at)::text from public.devices where id = 'a-phone'), row('recording', now())::text,
  'the server stamps drive_state_at when drive_state is written; the phone''s value is ignored');
select is((select array_agg(row(id, drive_state, drive_state_at = now())::text order by id) from public.devices where user_id = 'b7000000-0000-4000-8000-000000000001'),
  array[row('a-phone', 'recording', true)::text, row('a-tablet', 'idle', true)::text],
  'a client write of drive_state_at alone never sticks, future-dated or not (security M-1)');

-- ---------------------------------------------------------------------------
-- 6. permission lapses: one row per (user, device, kind, the user's local day) (security M-2). A's
--    zone is pinned by a prefs row: Pago Pago (UTC-11), then Kiritimati (UTC+14), 25 h apart, so
--    their local dates always differ.
-- ---------------------------------------------------------------------------
insert into public.notification_prefs (user_id, tz) values ('b7000000-0000-4000-8000-000000000001', 'Pacific/Pago_Pago');
-- each report below is its own second where it matters (the touch trigger would stamp now() on all)
alter table public.devices disable trigger devices_touch;
create temp table lday as select (now() at time zone 'Pacific/Pago_Pago')::date::text as pago, (now() at time zone 'Pacific/Kiritimati')::date::text as kir;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"foreground","motion":"granted","reportedFrom":"background","ack":false}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(push_state, push_reason, payload, dedupe_key)::text) from public.inbox where dedupe_key like 'permission_lapsed:%'),
  array[row('pending', null::text, '{"permission":"location_always","platform":"ios","deviceId":"a-phone"}'::jsonb,
    'permission_lapsed:a-phone:location_always:' || (select pago from lday))::text],
  'Always -> While Using, reported from the background: one pending location_always row, facts only, keyed to the local day');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"foreground","motion":"granted","reportedFrom":"background","ack":false,"checkedAt":"x"}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.inbox where dedupe_key like 'permission_lapsed:%'), 1, 'a repeated report of the same state adds nothing');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.inbox where dedupe_key like 'permission_lapsed:%'), 1, 'an improvement adds nothing');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"foreground","motion":"granted","reportedFrom":"background","ack":false}', updated_at = now() + interval '5 seconds' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}', updated_at = now() + interval '6 seconds' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"foreground","motion":"granted","reportedFrom":"background","ack":false}', updated_at = now() + interval '7 seconds' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.inbox where dedupe_key like 'permission_lapsed:%'), 1,
  'restoring and lapsing again the same local day adds nothing: a flipping script gets one row a day per kind (security M-2)');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"denied","motion":"granted","reportedFrom":"foreground","ack":true}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.inbox where dedupe_key like 'permission_lapsed:%'), 1, 'ack: true records nothing');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"denied","motion":"denied","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
-- a-tablet: motion missing, then denied
update public.devices set permissions = '{"v":1,"location":"always","reportedFrom":"foreground","ack":false}' where id = 'a-tablet';
update public.devices set permissions = '{"v":1,"location":"always","motion":"denied","reportedFrom":"background","ack":false}' where id = 'a-tablet';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(payload ->> 'deviceId', payload ->> 'permission', push_state, push_reason)::text order by payload ->> 'deviceId', payload ->> 'permission')
    from public.inbox where dedupe_key like 'permission_lapsed:%'),
  array[row('a-phone', 'location', 'skipped', 'inbox_only')::text, row('a-phone', 'location_always', 'pending', null::text)::text,
        row('a-phone', 'motion', 'skipped', 'inbox_only')::text],
  'Always -> denied is one location row and motion granted -> denied one motion row, both inbox-only from the foreground; a missing motion key is never a lapse');

-- ruling T2 n1: a background lapse later the same day upgrades the day's inbox_only row to pending
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"denied","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"denied","motion":"denied","reportedFrom":"background","ack":false}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(payload ->> 'permission', push_state, push_reason, push_after = now(), deliver_after = now())::text order by payload ->> 'permission')
    from public.inbox where dedupe_key like 'permission_lapsed:a-phone:%' and payload ->> 'permission' in ('location', 'motion')),
  array[row('location', 'pending', null::text, true, true)::text, row('motion', 'skipped', 'inbox_only', true, true)::text],
  'a background lapse the same day upgrades the morning inbox_only row to pending, still one row; the untouched kind stays inbox_only (ruling T2 n1)');
update public.inbox set push_state = 'sent', push_reason = 'ok', pushed_at = now() - interval '10 days'
  where dedupe_key like 'permission_lapsed:a-phone:location:%';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"denied","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"denied","motion":"denied","reportedFrom":"background","ack":false}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(count(*), min(push_state), min(push_reason), min(pushed_at) = now() - interval '10 days')::text
    from public.inbox where dedupe_key like 'permission_lapsed:a-phone:location:%'),
  row(1, 'sent', 'ok', true)::text, 'an already-sent row is never downgraded or re-queued by a later lapse the same day');

-- the next local day: a new row for the same device and kind
update public.notification_prefs set tz = 'Pacific/Kiritimati' where user_id = 'b7000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"v":1,"location":"always","motion":"granted","reportedFrom":"foreground","ack":false}' where id = 'a-phone';
update public.devices set permissions = '{"v":1,"location":"foreground","motion":"granted","reportedFrom":"background","ack":false}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(split_part(dedupe_key, ':', 4) order by split_part(dedupe_key, ':', 4)) from public.inbox where dedupe_key like 'permission_lapsed:a-phone:location_always:%'),
  array[(select pago from lday), (select kir from lday)], 'on another local day the same lapse is recorded again');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000002"}', true);
select is_empty($$ update public.devices set permissions = '{"location":"denied"}'
    where user_id = 'b7000000-0000-4000-8000-000000000001' returning id $$, 'B cannot touch A''s device, so cannot create a lapse for A');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ update public.devices set permissions = '{"location":"denied"}' where id = 'a-phone' $$,
  '42501', 'enqueue_permission_lapse requires the device owner or the service role', 'a session with neither the owner''s JWT nor the service role is refused');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$ update public.devices set permissions = '{"location":"foreground","motion":"denied"}' where id = 'a-tablet' $$,
  'the service role reports a lapse');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(push_state, push_reason)::text from public.inbox where dedupe_key = 'permission_lapsed:a-tablet:location_always:' || (select kir from lday)),
  row('skipped', 'inbox_only')::text, 'it is recorded on the service-role path too (no reportedFrom: inbox only)');
insert into public.devices (id, user_id, platform, permissions) values (repeat('x', 128), 'b7000000-0000-4000-8000-000000000001', 'android', '{"location":"always"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select lives_ok($$ update public.devices set permissions = '{"location":"foreground"}' where id = repeat('x', 128) $$,
  'a lapse on a 128-character device id is recorded');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(payload ->> 'deviceId' = repeat('x', 128), dedupe_key = 'permission_lapsed:md5-' || md5(repeat('x', 128)) || ':location_always:' || (select kir from lday))::text
    from public.inbox where dedupe_key like 'permission_lapsed:md5-%'),
  row(true, true)::text, 'its dedupe key hashes the device id (within 128 characters); the payload keeps the id');
-- final review I4: an excused Always (manual by choice, or auto_detect withdrawn) is no lapse
insert into public.devices (id, user_id, platform, permissions) values
  ('a-watch-excused', 'b7000000-0000-4000-8000-000000000001', 'ios', '{"location":"always","alwaysExcused":true}'),
  ('a-watch-wanted', 'b7000000-0000-4000-8000-000000000001', 'ios', '{"location":"always","alwaysExcused":false}'),
  ('a-watch-older', 'b7000000-0000-4000-8000-000000000001', 'ios', '{"location":"always"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"location":"foreground","alwaysExcused":true,"reportedFrom":"background"}' where id = 'a-watch-excused';
update public.devices set permissions = '{"location":"foreground","alwaysExcused":false,"reportedFrom":"background"}' where id = 'a-watch-wanted';
update public.devices set permissions = '{"location":"foreground","reportedFrom":"background"}' where id = 'a-watch-older';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select coalesce(array_agg(row(payload ->> 'deviceId', payload ->> 'permission', push_state)::text order by payload ->> 'deviceId'), '{}')
    from public.inbox where payload ->> 'deviceId' like 'a-watch-%'),
  array[row('a-watch-older', 'location_always', 'pending')::text, row('a-watch-wanted', 'location_always', 'pending')::text],
  'Always -> While Using raises no location_always lapse while alwaysExcused is true; it does when false, and when the key is missing (an older client) (final review I4)');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"location":"denied","alwaysExcused":true,"reportedFrom":"background"}' where id = 'a-watch-excused';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(payload ->> 'permission') from public.inbox where payload ->> 'deviceId' = 'a-watch-excused'), array['location'],
  'the excuse covers only location_always: losing location altogether is still a lapse');
-- a lapse raised before the driver became excused resolves as subject_gone (final review I4)
select is(array(select public.inbox_subject_gone(i.user_id, i.type, i.ref_id, i.payload) from public.inbox i
    where i.payload ->> 'deviceId' in ('a-watch-wanted', 'a-watch-older') order by i.payload ->> 'deviceId'), array[false, false],
  'both unexcused location_always lapses are current (not subject_gone)');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"location":"foreground","alwaysExcused":true,"reportedFrom":"foreground"}' where id = 'a-watch-wanted';
reset role;
select set_config('request.jwt.claims', '', true);
select is(array(select public.inbox_subject_gone(i.user_id, i.type, i.ref_id, i.payload) from public.inbox i
    where i.payload ->> 'deviceId' in ('a-watch-wanted', 'a-watch-older') order by i.payload ->> 'deviceId'), array[false, true],
  'once its device reports alwaysExcused: true, the earlier location_always lapse is subject_gone; the other device''s stays current');
delete from public.devices where id like 'a-watch-%';
delete from public.devices where id = repeat('x', 128);
delete from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000001';
alter table public.devices enable trigger devices_touch;


-- ---------------------------------------------------------------------------
-- 7. notification_prefs
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000001', '{"bogus": true}') $$,
  '22023', 'unknown notification category', 'an unknown category is refused');
select throws_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000001', '{"rewards": "no"}') $$,
  '22023', 'category values must be true or false', 'a non-boolean value is refused');
select throws_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000001', '[]') $$,
  '23514', null, 'categories must be an object');
select throws_ok($$ insert into public.notification_prefs (user_id, tz) values ('b7000000-0000-4000-8000-000000000001', 'Mars/Olympus') $$,
  '22023', 'unknown time zone', 'an unknown zone is refused');
select throws_ok($$ insert into public.notification_prefs (user_id, tz) values ('b7000000-0000-4000-8000-000000000001', '+05:00') $$,
  '22023', 'unknown time zone', 'a fixed offset is refused');
select lives_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000001',
    '{"trip_summaries": true, "recording": true, "rewards": false, "family": true, "safety": true, "product": false, "weekly_recap": true, "crews": true}') $$,
  'A stores all eight categories; quiet hours and zone left to the defaults');
select throws_ok($$ update public.notification_prefs set categories = '{"crew": false}' $$, '22023', 'unknown notification category', 'an update is validated too');
select throws_ok($$ update public.notification_prefs set user_id = 'b7000000-0000-4000-8000-000000000002' $$, '42501', null, 'user_id cannot be changed');
select throws_ok($$ update public.notification_prefs set created_at = now() - interval '1 day' $$, '42501', null, 'created_at is server-owned');
select throws_ok($$ insert into public.notification_prefs (user_id) values ('b7000000-0000-4000-8000-000000000002') $$, '42501', null, 'A cannot create B''s row');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000002"}', true);
select is((select count(*)::int from public.notification_prefs), 0, 'B cannot read A''s preferences');
select throws_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000001', '{"rewards": true}')
    on conflict (user_id) do update set categories = excluded.categories $$, '42501', null, 'B upserting onto A''s user_id is refused');
select is_empty($$ update public.notification_prefs set categories = '{"rewards": true}' where user_id = 'b7000000-0000-4000-8000-000000000001' returning user_id $$,
  'B cannot update A''s row');
select throws_ok($$ delete from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000001' $$, '42501', null,
  'nor delete it (no client deletes at all)');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000003"}', true);
select lives_ok($$ insert into public.notification_prefs (user_id, quiet_enabled, quiet_start, quiet_end, tz) values ('b7000000-0000-4000-8000-000000000003', true, '21:00', '06:30', 'America/Chicago') $$,
  'a teen stores quiet hours and a zone');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select categories -> 'rewards' from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000001'), 'false'::jsonb, 'A''s row is unchanged by B');

-- user_tz / user_local_date (0006's contract, now preferring prefs.tz)
select is(public.user_tz('b7000000-0000-4000-8000-000000000001'), 'America/New_York', 'no prefs zone: the latest drive''s zone');
select is(public.user_tz('b7000000-0000-4000-8000-000000000006'), null, 'no prefs zone and no drive: none');
select is(public.user_local_date('b7000000-0000-4000-8000-000000000006'), (now() at time zone 'UTC')::date, 'and the local date is UTC''s');
update public.notification_prefs set tz = 'Pacific/Kiritimati' where user_id = 'b7000000-0000-4000-8000-000000000001';
select is(public.user_tz('b7000000-0000-4000-8000-000000000001'), 'Pacific/Kiritimati', 'a prefs zone wins over the drive''s');
select is(public.user_local_date('b7000000-0000-4000-8000-000000000001'), (now() at time zone 'Pacific/Kiritimati')::date, 'and sets the local date');
update public.notification_prefs set tz = null where user_id = 'b7000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- 8. the service-role writers
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.claim_push_batch(10, 300) $$, '42501', null, 'authenticated cannot claim');
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.claim_push_batch(10, 300) $$, '42501', 'claim_push_batch requires the service role', 'an authenticated JWT is refused inside the writer too');
select throws_ok($$ select public.record_push_outcomes('{"outcomes":[]}') $$, '42501', 'record_push_outcomes requires the service role', 'record_push_outcomes is service-role only');
select throws_ok($$ select public.push_receipts_due(10) $$, '42501', 'push_receipts_due requires the service role', 'push_receipts_due is service-role only');
select throws_ok($$ select public.record_push_receipts('{"receipts":[]}') $$, '42501', 'record_push_receipts requires the service role', 'record_push_receipts is service-role only');
select set_config('request.jwt.claims', '', true);

-- a clean slate: only this section's fixtures are pending
update public.inbox set push_state = 'skipped', push_reason = 'inbox_only' where push_state in ('pending', 'deferred');
alter table public.devices disable trigger devices_drive_state_at_pin;
update public.devices set drive_state_at = now() - interval '5 hours' where id = 'a-phone';
update public.devices set drive_state = 'recording' where id = 'a-tablet';
update public.devices set drive_state_at = now() - interval '7 hours' where id = 'a-tablet';
alter table public.devices enable trigger devices_drive_state_at_pin;
update public.devices set push_token = 'ExponentPushToken[legacydevice1]' where id = 'a-phone';
update public.notification_prefs set local_sent_day = (now() at time zone 'America/New_York')::date, local_sent_count = 2 where user_id = 'b7000000-0000-4000-8000-000000000001';
insert into public.inbox (user_id, type, payload, dedupe_key, push_state, push_reason, pushed_at) values
  ('b7000000-0000-4000-8000-000000000001', 'permission_lapsed', '{"permission":"motion","platform":"ios","deviceId":"a-phone"}', 'sent-1', 'sent', 'ok', now() - interval '1 day'),
  ('b7000000-0000-4000-8000-000000000001', 'permission_lapsed', '{"permission":"motion","platform":"ios","deviceId":"a-phone"}', 'sent-9', 'sent', 'ok', now() - interval '9 days'),
  ('b7000000-0000-4000-8000-000000000001', 'trip_summary', '{"clientTripId":"a-sent"}', 'sent-2', 'sent', 'ok', now() - interval '2 days');
insert into res (k, v) select 'i1', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'i1', 'a-phone', interval '2 minutes'));
insert into res (k, v) select 'i2', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000002', 'i2', 'b-phone', interval '1 minute'));
update public.inbox set push_state = 'deferred', push_reason = 'quiet_hours' where dedupe_key = 'i2';
insert into res (k, v) select 'i3', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'i3', 'a-phone', interval '-5 minutes'));
insert into res (k, v) select 'i4', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'i4', 'gone-phone', interval '30 seconds'));

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.claim_push_batch(0, 300) $$, '22023', 'limit must be between 1 and 500', 'a claim of 0 is refused');
select throws_ok($$ select public.claim_push_batch(501, 300) $$, '22023', 'limit must be between 1 and 500', 'a claim of 501 is refused');
select throws_ok($$ select public.claim_push_batch(10, 29) $$, '22023', 'lease must be between 30 and 3600 seconds', 'a 29 s lease is refused');
select throws_ok($$ select public.claim_push_batch(10, 3601) $$, '22023', 'lease must be between 30 and 3600 seconds', 'a 3601 s lease is refused');
insert into res (k, v) values ('claim1', public.claim_push_batch(100, 300));
insert into res (k, v) values ('claim2', public.claim_push_batch(100, 300));
reset role;
select set_config('request.jwt.claims', '', true);

select is((select array_agg(e ->> 'inbox_id' order by ord) from res, jsonb_array_elements(v) with ordinality x(e, ord) where k = 'claim1'),
  array[(select v #>> '{}' from res where k = 'i1'), (select v #>> '{}' from res where k = 'i2'), (select v #>> '{}' from res where k = 'i4')],
  'the claim takes the due pending and deferred rows, oldest first; not the future row, not the skipped/local summaries');
select is((select array_agg(row(push_state, push_attempts, push_claimed_at = now())::text order by dedupe_key) from public.inbox where dedupe_key in ('i1', 'i2', 'i3', 'i4')),
  array[row('sending', 1, true)::text, row('sending', 1, true)::text, row('pending', 0, null::boolean)::text, row('sending', 1, true)::text],
  'claimed rows are sending, stamped and counted');
select is((select v from res where k = 'claim2'), '[]'::jsonb, 'a second claim finds nothing');
select is((select e - 'ctx' - 'inbox_id' from res, jsonb_array_elements(v) e where k = 'claim1' and e ->> 'inbox_id' = (select v #>> '{}' from res where k = 'i1')),
  jsonb_build_object('user_id', 'b7000000-0000-4000-8000-000000000001', 'type', 'permission_lapsed',
    'payload', '{"permission":"location_always","platform":"ios","deviceId":"a-phone"}'::jsonb,
    'created_at', now(), 'read', false, 'dismissed', false, 'subject_gone', false),
  'an item carries its facts; a location_always lapse still current on its device is not subject_gone');
select is((select e -> 'subject_gone' from res, jsonb_array_elements(v) e where k = 'claim1' and e ->> 'inbox_id' = (select v #>> '{}' from res where k = 'i4')),
  'true'::jsonb, 'a lapse on a device that no longer exists is subject_gone');
select is((select e -> 'ctx' from res, jsonb_array_elements(v) e where k = 'claim1' and e ->> 'inbox_id' = (select v #>> '{}' from res where k = 'i1')),
  jsonb_build_object('tz', 'America/New_York', 'quiet', '{"enabled":true,"start":"22:00","end":"07:00"}'::jsonb,
    'categories', '{"trip_summaries": true, "recording": true, "rewards": false, "family": true, "safety": true, "product": false, "weekly_recap": true, "crews": true}'::jsonb,
    'driving_since', now() - interval '5 hours',
    'recent', jsonb_build_array(jsonb_build_object('type', 'permission_lapsed', 'pushed_at', now() - interval '1 day', 'lapse_key', 'a-phone:motion'),
      jsonb_build_object('type', 'trip_summary', 'pushed_at', now() - interval '2 days')),
    'local_sent_today', 2, 'tokens', '["ExponentPushToken[aaaaaaaaaaaa3]"]'::jsonb),
  'A''s ctx: the drive''s zone; null quiet fields = notification_defaults; driving within 6 h (the 7-h-old one ignored); 8 days of sends; today''s phone count; tokens, never devices.push_token');
select is((select e -> 'ctx' from res, jsonb_array_elements(v) e where k = 'claim1' and e ->> 'inbox_id' = (select v #>> '{}' from res where k = 'i2')),
  jsonb_build_object('tz', 'America/Los_Angeles', 'quiet', '{"enabled":true,"start":"22:00","end":"07:00"}'::jsonb, 'categories', '{}'::jsonb,
    'driving_since', null, 'recent', '[]'::jsonb, 'local_sent_today', 0, 'tokens', '[]'::jsonb),
  'B with no prefs and no drives: every default');
select is((select count(*)::int from res where k = 'claim1' and v::text like '%legacydevice1%'), 0, 'devices.push_token never appears in a claim');
select is((select array_agg(row(r ->> 'type', r ? 'lapse_key', r ->> 'lapse_key')::text order by r ->> 'pushed_at' desc) from res,
    jsonb_array_elements(v -> 0 -> 'ctx' -> 'recent') r where k = 'claim1'),
  array[row('permission_lapsed', true, 'a-phone:motion')::text, row('trip_summary', false, null::text)::text],
  'recent carries lapse_key (deviceId:permission) on a lapse only, and no such key on any other type (ruling T3 (2))');
select is((select count(distinct e -> 'ctx')::int from res, jsonb_array_elements(v) e where k = 'claim1' and e ->> 'user_id' = 'b7000000-0000-4000-8000-000000000001'), 1,
  'both of A''s items carry the same ctx');

-- prefs values replace the defaults; the phone count only counts on its own day; a prefs zone wins
update public.notification_prefs set quiet_enabled = false, quiet_start = '23:15', tz = 'Europe/Paris' where user_id = 'b7000000-0000-4000-8000-000000000001';
update public.notification_prefs set local_sent_day = (now() at time zone 'Europe/Paris')::date - 1 where user_id = 'b7000000-0000-4000-8000-000000000001';
alter table public.devices disable trigger devices_drive_state_at_pin;
update public.devices set drive_state_at = now() - interval '6 hours 1 minute' where id = 'a-phone';
alter table public.devices enable trigger devices_drive_state_at_pin;
insert into res (k, v) select 'i5', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'i5'));
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
update public.devices set permissions = '{"location":"always","motion":"denied"}' where id = 'a-phone';
reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into res (k, v) values ('claim3', public.claim_push_batch(100, 300));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select jsonb_build_object('tz', v -> 0 -> 'ctx' -> 'tz', 'quiet', v -> 0 -> 'ctx' -> 'quiet', 'driving_since', v -> 0 -> 'ctx' -> 'driving_since',
      'local_sent_today', v -> 0 -> 'ctx' -> 'local_sent_today') from res where k = 'claim3'),
  '{"tz":"Europe/Paris","quiet":{"enabled":false,"start":"23:15","end":"07:00"},"driving_since":null,"local_sent_today":0}'::jsonb,
  'prefs fields replace the defaults one by one; recording older than 6 h is not driving; yesterday''s phone count is 0');
select is((select v -> 0 -> 'subject_gone' from res where k = 'claim3'), 'true'::jsonb, 'a location_always lapse whose device is back on Always is subject_gone');

-- lease expiry, at most once
update public.inbox set push_claimed_at = now() - interval '10 minutes' where dedupe_key = 'i4';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into res (k, v) values ('claim4', public.claim_push_batch(100, 300));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(push_state, push_reason)::text from public.inbox where dedupe_key = 'i4'), row('failed', 'lease_expired')::text,
  'a sending row past its lease fails as lease_expired, never re-sent');
select is((select v from res where k = 'claim4'), '[]'::jsonb, 'and is not claimed again');

-- record_push_outcomes
insert into public.push_registrations (token, user_id, device_id, platform) values ('ExponentPushToken[deadtoken0001]', 'b7000000-0000-4000-8000-000000000001', 'a-phone', 'ios');
insert into res (k, v) select 'j1', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'j1'));
insert into res (k, v) select 'j2', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'j2'));
insert into res (k, v) select 'j3', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000002', 'j3', 'b-phone'));
insert into res (k, v) select 'j4', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'j4'));
alter table public.devices disable trigger devices_drive_state_at_pin;
update public.devices set drive_state_at = now() + interval '10 years' where id = 'a-tablet';
alter table public.devices enable trigger devices_drive_state_at_pin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into res (k, v) values ('claim5', public.claim_push_batch(100, 300));
select is((select jsonb_agg(distinct e -> 'ctx' -> 'driving_since') from res, jsonb_array_elements(v) e
    where k = 'claim5' and e ->> 'user_id' = 'b7000000-0000-4000-8000-000000000001'), jsonb_build_array(now()),
  'j1-j4 are claimed; a future drive_state_at is clamped to now() (security M-1)');
select throws_ok($$ select public.record_push_outcomes(null) $$, '22023', 'outcomes must be an array of at most 500 items', 'a null envelope is refused');
select throws_ok($$ select public.record_push_outcomes('{"outcomes":{}}') $$, '22023', 'outcomes must be an array of at most 500 items', 'outcomes must be an array');
select throws_ok($$ select public.record_push_outcomes(jsonb_build_object('outcomes', (select jsonb_agg('{}'::jsonb) from generate_series(1, 501)))) $$,
  '22023', 'outcomes must be an array of at most 500 items', '501 outcomes are refused');
select throws_ok($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"nope","state":"sent","reason":"ok"}]}') $$,
  '22023', 'outcome must be an object with a uuid inbox_id', 'a bad inbox id is refused');
select throws_ok(format($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"%s","state":"lost","reason":"ok"}]}') $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'unknown outcome state', 'an unknown state is refused');
select throws_ok(format($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"%s","state":"skipped","reason":"bored"}]}') $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'unknown outcome reason', 'an unknown reason is refused');
select throws_ok(format($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"%s","state":"deferred","reason":"driving"}]}') $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'deferred outcome needs push_after within 7 days', 'a deferral needs a time');
select throws_ok(format($$ select public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(jsonb_build_object('inbox_id', '%s', 'state', 'deferred', 'reason', 'window', 'push_after', now() + interval '7 days 1 minute')))) $$,
    (select v #>> '{}' from res where k = 'j1')),
  '22023', 'deferred outcome needs push_after within 7 days', 'a deferral past 7 days is refused');
select throws_ok(format($$ select public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(jsonb_build_object('inbox_id', '%s', 'state', 'sent', 'reason', 'ok',
    'deliveries', (select jsonb_agg('{}'::jsonb) from generate_series(1, 11)))))) $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'deliveries must be an array of at most 10 items', 'eleven deliveries are refused');
select throws_ok(format($$ select public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(jsonb_build_object('inbox_id', '%s', 'state', 'sent', 'reason', 'ok',
    'deliveries', jsonb_build_array(jsonb_build_object('error', repeat('e', 65))))))) $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'delivery must be an object with bounded token, ticket_id and error', 'an overlong delivery error is refused');
select throws_ok(format($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"%s","state":"sent","reason":"ok"}]}') $$, (select v #>> '{}' from res where k = 'i3')),
  '22023', 'outcome for an unclaimed item', 'an outcome for a row that is not sending is refused');
select is(public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(
    jsonb_build_object('inbox_id', gen_random_uuid(), 'state', 'sent', 'reason', 'ok')))), 0,
  'an outcome for a row that no longer exists is skipped and not counted (final review m1)');
select is(public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'j1'), 'state', 'sent', 'reason', 'ok', 'deliveries', jsonb_build_array(
      jsonb_build_object('token', 'ExponentPushToken[aaaaaaaaaaaa3]', 'ticket_id', 'ticket-1'),
      jsonb_build_object('token', 'ExponentPushToken[deadtoken0001]', 'error', 'DeviceNotRegistered'))),
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'j2'), 'state', 'deferred', 'reason', 'driving', 'push_after', now() + interval '5 minutes'),
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'j3'), 'state', 'skipped', 'reason', 'local'),
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'j4'), 'state', 'failed', 'reason', 'expo_error')))), 4,
  'four outcomes are applied');
select throws_ok(format($$ select public.record_push_outcomes('{"outcomes":[{"inbox_id":"%s","state":"sent","reason":"ok"}]}') $$, (select v #>> '{}' from res where k = 'j1')),
  '22023', 'outcome for an unclaimed item', 'a replayed outcome is refused (the row is settled)');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(dedupe_key, push_state, push_reason, pushed_at = now(), push_after = now() + interval '5 minutes',
      deliver_after = now() - interval '1 minute')::text order by dedupe_key)
    from public.inbox where dedupe_key in ('j1', 'j2', 'j3', 'j4')),
  array[row('j1', 'sent', 'ok', true, false, true)::text, row('j2', 'deferred', 'driving', null::boolean, true, true)::text,
        row('j3', 'skipped', 'local', null::boolean, false, true)::text, row('j4', 'failed', 'expo_error', null::boolean, false, true)::text],
  'sent stamps pushed_at; deferred moves push_after only (deliver_after never moves); skipped local and failed are recorded');
-- ruling T2 I1: a deferred push never hides the row
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select is((select count(*)::int from public.inbox where id = (select (v #>> '{}')::uuid from res where k = 'j2')), 1,
  'a deferred row stays visible to its owner (ruling T2 I1)');
select is(public.mark_inbox_read(array[(select (v #>> '{}')::uuid from res where k = 'j2')]), 1, 'and can be marked read');
select is(public.dismiss_inbox(array[(select (v #>> '{}')::uuid from res where k = 'j2')]), 1, 'and dismissed');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(token, ticket_id, error)::text order by ticket_id nulls last) from public.push_deliveries
    where inbox_id = (select (v #>> '{}')::uuid from res where k = 'j1')),
  array[row('ExponentPushToken[aaaaaaaaaaaa3]', 'ticket-1', null::text)::text, row(null::text, null::text, 'DeviceNotRegistered')::text],
  'one delivery per ticket; the dead token''s delivery keeps its error');
select is((select count(*)::int from public.push_registrations where token = 'ExponentPushToken[deadtoken0001]'), 0, 'DeviceNotRegistered deletes the registration');

-- final review m1: a claimed row deleted mid-sweep (a u13 minimisation, an account deletion) must not
-- sink the rest of its batch
insert into res (k, v) select 'g1', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'g1'));
insert into res (k, v) select 'g2', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000002', 'g2', 'b-phone'));
insert into res (k, v) select 'g3', to_jsonb(pg_temp.pending('b7000000-0000-4000-8000-000000000001', 'g3'));
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into res (k, v) values ('claim6', public.claim_push_batch(100, 300));
reset role;
select set_config('request.jwt.claims', '', true);
delete from public.inbox where dedupe_key = 'g2';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'g1'), 'state', 'sent', 'reason', 'ok',
      'deliveries', jsonb_build_array(jsonb_build_object('token', null, 'error', 'MessageTooBig'))),
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'g2'), 'state', 'sent', 'reason', 'ok',
      'deliveries', jsonb_build_array(jsonb_build_object('token', null, 'ticket_id', 'ticket-g2'))),
    jsonb_build_object('inbox_id', (select v #>> '{}' from res where k = 'g3'), 'state', 'deferred', 'reason', 'driving',
      'push_after', now() + interval '5 minutes')))), 2,
  'a batch with a row deleted mid-sweep applies the other outcomes and counts only them (submitted 3, applied 2)');
select throws_ok(format($$ select public.record_push_outcomes(jsonb_build_object('outcomes', jsonb_build_array(
    jsonb_build_object('inbox_id', '%s', 'state', 'sent', 'reason', 'ok'),
    jsonb_build_object('inbox_id', '%s', 'state', 'sent', 'reason', 'ok')))) $$,
    (select v #>> '{}' from res where k = 'g2'), (select v #>> '{}' from res where k = 'g1')),
  '22023', 'outcome for an unclaimed item', 'a row that exists but is not sending still refuses the call, vanished rows beside it or not');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(row(dedupe_key, push_state, push_reason)::text order by dedupe_key) from public.inbox where dedupe_key in ('g1', 'g2', 'g3')),
  array[row('g1', 'sent', 'ok')::text, row('g3', 'deferred', 'driving')::text], 'g1 is sent and g3 deferred; g2 stays gone');
select is((select array_agg(coalesce(error, ticket_id)) from public.push_deliveries
    where inbox_id in ((select (v #>> '{}')::uuid from res where k = 'g1'), (select (v #>> '{}')::uuid from res where k = 'g2'))),
  array['MessageTooBig'], 'only the surviving row''s delivery is recorded; the vanished row''s has nothing to attach to');

-- receipts
insert into public.push_deliveries (inbox_id, user_id, ticket_id, created_at) values
  ((select (v #>> '{}')::uuid from res where k = 'j1'), 'b7000000-0000-4000-8000-000000000001', 'ticket-old', now() - interval '25 hours'),
  ((select (v #>> '{}')::uuid from res where k = 'j1'), 'b7000000-0000-4000-8000-000000000001', 'ticket-unseen', now() - interval '20 minutes');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.push_receipts_due(0) $$, '22023', 'limit must be between 1 and 1000', 'a receipts limit of 0 is refused');
select throws_ok($$ select public.push_receipts_due(1001) $$, '22023', 'limit must be between 1 and 1000', 'a receipts limit of 1001 is refused');
insert into res (k, v) values ('due1', public.push_receipts_due(100));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(e ->> 'ticket_id' order by e ->> 'ticket_id') from res, jsonb_array_elements(v) e where k = 'due1'), array['ticket-unseen'],
  'only a ticket at least 15 minutes old and under 24 hours is due (ticket-1 is too new)');
select is((select row(receipt_status, receipt_error, receipt_checked_at = now())::text from public.push_deliveries where ticket_id = 'ticket-old'),
  row('error', 'expired', true)::text, 'a 25-hour-old ticket with no receipt is stamped error/expired (rev1: I13)');
update public.push_deliveries set created_at = now() - interval '16 minutes' where ticket_id = 'ticket-1';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.record_push_receipts('{"receipts":{}}') $$, '22023', 'receipts must be an array of at most 1000 items', 'receipts must be an array');
select throws_ok(format($$ select public.record_push_receipts('{"receipts":[{"delivery_id":"%s","status":"maybe"}]}') $$, gen_random_uuid()),
  '22023', 'receipt must be { delivery_id, status ok|error|null, error }', 'an unknown receipt status is refused');
select is(public.record_push_receipts(jsonb_build_object('receipts', jsonb_build_array(
    jsonb_build_object('delivery_id', (select id from public.push_deliveries where ticket_id = 'ticket-1'), 'status', 'error', 'error', 'DeviceNotRegistered'),
    jsonb_build_object('delivery_id', (select id from public.push_deliveries where ticket_id = 'ticket-unseen'), 'status', null, 'error', null),
    jsonb_build_object('delivery_id', gen_random_uuid(), 'status', 'ok', 'error', null)))), 2,
  'two named deliveries exist and are stamped; an unknown id is ignored');
insert into res (k, v) values ('due2', public.push_receipts_due(100));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select row(receipt_status, receipt_error, receipt_checked_at = now())::text from public.push_deliveries where ticket_id = 'ticket-1'),
  row('error', 'DeviceNotRegistered', true)::text, 'a receipt error is recorded');
select is((select count(*)::int from public.push_registrations where token = 'ExponentPushToken[aaaaaaaaaaaa3]'), 0, 'and DeviceNotRegistered removes the registration');
select is((select row(receipt_status, receipt_checked_at = now())::text from public.push_deliveries where ticket_id = 'ticket-unseen'),
  row(null::text, true)::text, 'a receipt Expo has not produced yet is only stamped checked');
select is((select v from res where k = 'due2'), '[]'::jsonb, 'nothing is due again within 15 minutes of a check');
update public.push_deliveries set receipt_checked_at = now() - interval '16 minutes' where ticket_id = 'ticket-unseen';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select jsonb_agg(e ->> 'ticket_id') from jsonb_array_elements(public.push_receipts_due(100)) e), '["ticket-unseen"]'::jsonb,
  'it is asked for again 15 minutes after its last check');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 9. dispatch_push
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.dispatch_push() $$, '42501', null, 'service_role cannot run dispatch_push');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.dispatch_push() $$, '42501', null, 'authenticated cannot run dispatch_push');
reset role;
select set_config('request.jwt.claims', '', true);
select is(public.dispatch_push(), 'unconfigured', 'no vault secrets: unconfigured');
select vault.create_secret('http://push-sender.test/functions/v1/push-sender', 'push_sender_url');
select is(public.dispatch_push(), 'unconfigured', 'a URL without a key: still unconfigured');
select vault.create_secret('too-short-key', 'push_sender_hmac_key');
select is(public.dispatch_push(), 'unconfigured', 'a key shorter than 32 bytes: still unconfigured');
select vault.update_secret((select id from vault.secrets where name = 'push_sender_hmac_key'), 'hmac-0007-9f1c2e7d4b8a6f3e5d2c1b0a99887766');
update public.inbox set push_state = 'skipped', push_reason = 'inbox_only' where push_state in ('pending', 'deferred', 'sending');
update public.push_deliveries set receipt_status = 'ok' where receipt_status is null;
select is(public.dispatch_push(), 'idle', 'nothing due and no receipt owed: idle');
create temp table q0 as select coalesce(max(id), 0) as id from net.http_request_queue;
update public.push_deliveries set receipt_status = null, receipt_checked_at = null where ticket_id = 'ticket-unseen';
select is(public.dispatch_push(), 'dispatched', 'a receipt owed alone dispatches');
update public.push_deliveries set receipt_status = 'ok' where receipt_status is null;
select pg_temp.pending('b7000000-0000-4000-8000-000000000002', 'k1', 'b-phone');
select is(public.dispatch_push(), 'dispatched', 'a due item dispatches');
select is((select array_agg(row(method, url, headers, convert_from(body, 'UTF8')::jsonb, timeout_milliseconds)::text) from net.http_request_queue where id > (select id from q0)),
  array_fill(row('POST', 'http://push-sender.test/functions/v1/push-sender',
    jsonb_build_object('Content-Type', 'application/json', 'X-Sweep-Signature',
      floor(extract(epoch from now()))::bigint::text || '.' || encode(extensions.hmac('push-sender-sweep:' || floor(extract(epoch from now()))::bigint::text,
        'hmac-0007-9f1c2e7d4b8a6f3e5d2c1b0a99887766', 'sha256'), 'hex')), '{"reason":"sweep"}'::jsonb, 10000)::text, array[2]),
  'each dispatch queues one POST to the vault URL with a timestamped HMAC signature (no key, no Authorization), a sweep body and a 10 s timeout');
select is(pg_temp.tables_containing('hmac-0007-9f1c2e7d4b8a6f3e5d2c1b0a99887766'), '{}'::text[],
  'the key appears in no table outside Vault (the request queue and the cron log included)');
update public.inbox set push_state = 'sending', push_claimed_at = now() - interval '61 minutes' where dedupe_key = 'k1';
select is(public.dispatch_push(), 'dispatched', 'a sending row past the longest lease dispatches (so the claim can fail it)');
update public.inbox set push_claimed_at = now() - interval '59 minutes' where dedupe_key = 'k1';
select is(public.dispatch_push(), 'idle', 'a sending row inside the lease does not');

-- ---------------------------------------------------------------------------
-- 10. merge_own_profile_flags (ruling T17 (4))
-- ---------------------------------------------------------------------------
update public.profiles set flags = '{"keep": true}' where id = 'b7000000-0000-4000-8000-000000000001';
update public.profiles set flags = '{"b": 1}' where id = 'b7000000-0000-4000-8000-000000000002';
select throws_ok($$ select public.merge_own_profile_flags('{"onboarded": true}') $$, '42501', 'merge_own_profile_flags requires an authenticated user', 'no JWT, no merge');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.merge_own_profile_flags(null) $$, '22023', 'patch must be a non-empty JSON object of profile flags', 'a null patch is refused');
select throws_ok($$ select public.merge_own_profile_flags('[]') $$, '22023', 'patch must be a non-empty JSON object of profile flags', 'an array is refused');
select throws_ok($$ select public.merge_own_profile_flags('{}') $$, '22023', 'patch must be a non-empty JSON object of profile flags', 'an empty patch is refused');
select throws_ok($$ select public.merge_own_profile_flags('{"isAdmin": true}') $$, '22023', 'unknown profile flag', 'an unknown flag is refused');
select throws_ok($$ select public.merge_own_profile_flags('{"onboarded": "yes"}') $$, '22023', 'invalid profile flag value', 'onboarded must be a boolean');
select throws_ok($$ select public.merge_own_profile_flags('{"onboardingVersion": 1.5}') $$, '22023', 'invalid profile flag value', 'onboardingVersion must be an integer');
select throws_ok($$ select public.merge_own_profile_flags('{"disclaimerAcknowledged": ""}') $$, '22023', 'invalid profile flag value', 'the disclaimer version is 1 to 32 characters');
select is(public.merge_own_profile_flags('{"disclaimerAcknowledged": "2026-09-21"}'), '{"keep": true, "disclaimerAcknowledged": "2026-09-21"}'::jsonb,
  'the disclaimer is merged without a read-modify-write; other flags stay');
select is(public.merge_own_profile_flags('{"onboarded": true, "onboardingVersion": 1}'),
  '{"keep": true, "disclaimerAcknowledged": "2026-09-21", "onboarded": true, "onboardingVersion": 1}'::jsonb, 'onboarding is merged the same way');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000002"}', true);
select is(public.merge_own_profile_flags('{"onboarded": false}'), '{"b": 1, "onboarded": false}'::jsonb, 'B merges into B''s own row');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select flags from public.profiles where id = 'b7000000-0000-4000-8000-000000000001'),
  '{"keep": true, "disclaimerAcknowledged": "2026-09-21", "onboarded": true, "onboardingVersion": 1}'::jsonb, 'A''s flags are untouched by B');

-- ---------------------------------------------------------------------------
-- 11. under 13: U's footprint, then U's own age answer; W corrected by support
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000004"}', true);
select lives_ok($$ insert into public.notification_prefs (user_id, categories) values ('b7000000-0000-4000-8000-000000000004', '{"rewards": false}') $$, 'U stores preferences');
select lives_ok($$ select public.register_push_token('u-phone', 'ExponentPushToken[umaphonetoken]') $$, 'U registers a token');
update public.devices set permissions = '{"location":"always"}' where id = 'u-phone';
update public.devices set permissions = '{"location":"foreground","reportedFrom":"background"}', updated_at = now() + interval '1 second' where id = 'u-phone';
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.push_deliveries (inbox_id, user_id, token, ticket_id)
  select id, user_id, 'ExponentPushToken[umaphonetoken]', 'ticket-u' from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000004';
select is((select array[(select count(*) from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.push_registrations where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.push_deliveries where user_id = 'b7000000-0000-4000-8000-000000000004')]::int[]),
  array[1, 1, 1, 1], 'U has an inbox row, preferences, a registration and a delivery');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000004"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'U gives a birth date ten years ago');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array[(select count(*) from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.push_registrations where user_id = 'b7000000-0000-4000-8000-000000000004'),
    (select count(*) from public.push_deliveries where user_id = 'b7000000-0000-4000-8000-000000000004')]::int[]),
  array[0, 0, 0, 0], 'the block deletes U''s inbox, preferences, registrations and deliveries in the same transaction');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b7000000-0000-4000-8000-000000000004"}', true);
select throws_ok($$ insert into public.notification_prefs (user_id) values ('b7000000-0000-4000-8000-000000000004') $$, '42501', 'account not eligible',
  'a blocked child cannot store preferences again');
select throws_ok($$ select public.register_push_token('u-phone', 'ExponentPushToken[umaphonetoken]') $$, '42501', 'account not eligible',
  'nor register a token');
select throws_ok($$ select public.merge_own_profile_flags('{"onboarded": true}') $$, '42501', 'account not eligible', 'nor merge profile flags');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values ('b7000000-0000-4000-8000-000000000004', 'trip_summary', '{}', 'x') $$,
  '42501', 'account not eligible', 'no writer can add an inbox row for a blocked child');

-- W: a support correction (service role) to a child's date runs the same minimisation as the service role
insert into public.notification_prefs (user_id) values ('b7000000-0000-4000-8000-000000000005');
insert into public.push_registrations (token, user_id, device_id, platform) values ('ExponentPushToken[wesphonetoken]', 'b7000000-0000-4000-8000-000000000005', 'w-phone', 'android');
select pg_temp.pending('b7000000-0000-4000-8000-000000000005', 'w1', 'w-phone');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$ update public.private_profiles set birth_date = (current_date - interval '9 years')::date where user_id = 'b7000000-0000-4000-8000-000000000005' $$,
  'support corrects W to a child''s date');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array[(select count(*) from public.inbox where user_id = 'b7000000-0000-4000-8000-000000000005'),
    (select count(*) from public.notification_prefs where user_id = 'b7000000-0000-4000-8000-000000000005'),
    (select count(*) from public.push_registrations where user_id = 'b7000000-0000-4000-8000-000000000005')]::int[]),
  array[0, 0, 0], 'the service-role path minimises W''s notification data too');

select * from finish();
rollback;
drop extension if exists dblink;
