-- 0013_account: the export (only the caller's own rows, nothing about anyone else), the object
-- listing account-delete removes before the auth delete, and the delete itself: after an auth user
-- is deleted no table in public, auth or storage still contains their id, a family keeps going
-- under its longest-standing member or ends with its last one, and a minor linked to a deleted
-- guardian is left with no link at all.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. Local stack only.
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0013_account.test.sql runs only against the local Supabase stack';
  end if;
end $$;

begin;
select plan(65);

-- ---------------------------------------------------------------------------
-- fixtures (as the migration owner, with no JWT)
--   A an adult with a bit of everything, admin of family F1 and guardian of the minor B;
--   B a 16-year-old in F1, referred by A; C an adult in F1 who joined after B;
--   D an adult alone in family F2, which has a saved place.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('c1300000-0000-4000-8000-00000000000' || p)::uuid
$$;
insert into auth.users (id, email, raw_user_meta_data) values
  (pg_temp.u('a'), 'a13@example.com', '{"display_name":"Ada"}'),
  (pg_temp.u('b'), 'b13@example.com', '{"display_name":"Bea"}'),
  (pg_temp.u('c'), 'c13@example.com', '{"display_name":"Cy"}'),
  (pg_temp.u('d'), 'd13@example.com', '{"display_name":"Dee"}');
update public.private_profiles set birth_date = date '1985-01-01' where user_id in (pg_temp.u('a'), pg_temp.u('c'), pg_temp.u('d'));
update public.private_profiles set birth_date = current_date - interval '16 years' where user_id = pg_temp.u('b');
update public.private_profiles set guardian_link_status = 'linked', guardian_user_id = pg_temp.u('a') where user_id = pg_temp.u('b');

insert into public.consents (user_id, type, version) values (pg_temp.u('a'), 'tos', '2026-09-21');
insert into public.devices (id, user_id, platform, push_token) values ('a13-phone', pg_temp.u('a'), 'ios', 'ExponentPushToken[a13a13a13a13]');
insert into public.push_registrations (token, user_id, device_id, platform) values ('ExponentPushToken[a13a13a13a13]', pg_temp.u('a'), 'a13-phone', 'ios');
insert into public.inbox (user_id, type, payload, dedupe_key)
  values (pg_temp.u('a'), 'permission_lapsed', jsonb_build_object('permission', 'location_always', 'platform', 'ios', 'deviceId', 'a13-phone'), 'a13-lapse');

insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  (pg_temp.u('a'), 'a13-trip-1', now() - interval '2 days', now() - interval '2 days' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  (pg_temp.u('a'), 'a13-trip-2', now() - interval '1 day', now() - interval '1 day' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  (pg_temp.u('b'), 'b13-trip-1', now() - interval '1 day', now() - interval '1 day' + interval '10 minutes', 'UTC', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short');
update public.trips set trace_path = user_id::text || '/' || client_trip_id || '.bin.gz' where client_trip_id in ('a13-trip-1', 'b13-trip-1');
insert into public.trip_events (trip_id, user_id, client_event_id, category, started_at, duration_ms, severity, confidence, context_multiplier, source, status)
  select t.id, t.user_id, 'ev-1', 'phone', t.started_at, 4000, 0.5, 0.9, 1, 'os', 'scored' from public.trips t where t.client_trip_id = 'a13-trip-1';
insert into public.event_disputes (event_id, user_id, reason)
  select e.id, e.user_id, 'hazard' from public.trip_events e where e.user_id = pg_temp.u('a');
insert into public.score_daily (user_id, day) values (pg_temp.u('a'), current_date - 1);
insert into public.baselines (user_id) values (pg_temp.u('a'));
insert into public.rate_limits (user_id, key) values (pg_temp.u('a'), 'account_export');
insert into public.progress (user_id, points) values (pg_temp.u('a'), 5) on conflict (user_id) do update set points = 5;
insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key)
  values (pg_temp.u('a'), 'safe_day', 5, (current_date - 1)::text, 5, 'day:a13:tier');
insert into public.reward_due (user_id, due_at) values (pg_temp.u('a'), now() + interval '1 hour') on conflict (user_id) do nothing;
insert into public.weekly_goals (user_id, week_start, category, source, tz)
  values (pg_temp.u('a'), date_trunc('week', current_date)::date, 'phone', 'weakest', 'UTC');
insert into public.user_badges (user_id, badge_id, earned_at) values (pg_temp.u('a'), 'safe_days_7', now());
insert into public.referral_codes (user_id, code) values (pg_temp.u('a'), 'AAAA2345');
insert into public.referrals (referrer_id, invitee_id, redeemed_at) values (pg_temp.u('a'), pg_temp.u('b'), now());
insert into public.invites (code_hash, type, issuer_id, expires_at) values (extensions.digest('a13-invite', 'sha256'), 'guardian', pg_temp.u('a'), now() + interval '1 day');

insert into public.families (id, name, code, code_expires_at) values
  ('c1300000-0000-4000-8000-0000000000f1', 'The Lanes', 'FAMAAA', now() + interval '7 days'),
  ('c1300000-0000-4000-8000-0000000000f2', 'Solo', 'FAMDDD', now() + interval '7 days');
insert into public.family_members (family_id, user_id, role, sharing_location, created_at) values
  ('c1300000-0000-4000-8000-0000000000f1', pg_temp.u('a'), 'admin', true, now() - interval '3 days'),
  ('c1300000-0000-4000-8000-0000000000f1', pg_temp.u('b'), 'member', true, now() - interval '2 days'),
  ('c1300000-0000-4000-8000-0000000000f1', pg_temp.u('c'), 'member', false, now() - interval '1 day'),
  ('c1300000-0000-4000-8000-0000000000f2', pg_temp.u('d'), 'admin', false, now() - interval '1 day');
insert into public.member_locations (user_id, lat, lng, accuracy_m) values
  (pg_temp.u('a'), 47.6062, -122.3321, 12), (pg_temp.u('b'), 47.6101, -122.3421, 15);
insert into public.family_places (family_id, name, address, lat, lng) values
  ('c1300000-0000-4000-8000-0000000000f2', 'Home', '1 Main St', 47.1, -122.1);

-- GoTrue's audit log, in the shapes it writes (read off the local stack for review I1): no foreign
-- key, so nothing cascades into it
insert into auth.audit_log_entries (id, payload, created_at) values
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_id', pg_temp.u('a'), 'actor_username', 'a13@example.com', 'log_type', 'account'), now()),
  (gen_random_uuid(), json_build_object('action', 'user_recovery_requested', 'actor_username', 'A13@Example.com', 'log_type', 'user'), now()),
  (gen_random_uuid(), json_build_object('action', 'user_deleted', 'actor_id', '00000000-0000-0000-0000-000000000000', 'actor_username', 'service_role',
     'log_type', 'team', 'traits', json_build_object('user_email', 'a13@example.com', 'user_id', pg_temp.u('a'), 'user_phone', '')), now()),
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_id', pg_temp.u('c'), 'actor_username', 'c13@example.com', 'log_type', 'account'), now()),
  -- an address that merely contains A's is someone else's
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_username', 'xa13@example.com', 'log_type', 'account'), now()),
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_id', pg_temp.u('c'), 'actor_username', 'c13@example.com', 'log_type', 'old'), now() - interval '31 days');

insert into storage.buckets (id, name, public) values ('c13-other', 'c13-other', false);
insert into storage.objects (bucket_id, name, owner_id) values
  ('traces', pg_temp.u('a')::text || '/a13-trip-1.bin.gz', pg_temp.u('a')::text),
  ('traces', pg_temp.u('a')::text || '/a13-late.bin.gz', pg_temp.u('a')::text),
  ('c13-other', pg_temp.u('a')::text || '/note.bin', pg_temp.u('a')::text),
  ('traces', pg_temp.u('b')::text || '/b13-trip-1.bin.gz', pg_temp.u('b')::text),
  -- a name that starts with A's id but is not under A's folder
  ('traces', pg_temp.u('a')::text || '0/not-a.bin.gz', pg_temp.u('b')::text);

-- every table in public, auth or storage whose rows contain p_needle (0008's helper, narrowed)
create function pg_temp.tables_containing(p_needle text) returns text[]
language plpgsql as $$
declare
  r record;
  n int;
  v_out text[] := '{}';
begin
  for r in select format('%I.%I', ns.nspname, c.relname) as t from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where c.relkind in ('r', 'p') and ns.nspname in ('public', 'auth', 'storage') order by 1 loop
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

create function pg_temp.as_service(p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute p_sql into v;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
exception when others then
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  raise;
end $$;
grant execute on function pg_temp.as_service(text) to service_role;

-- ---------------------------------------------------------------------------
-- the functions: shape, ownership, grants
-- ---------------------------------------------------------------------------
select has_function('public', 'account_object_keys', array['uuid', 'integer', 'text', 'text'], 'account_object_keys exists');
select has_function('public', 'export_account', array['uuid'], 'export_account exists');
select is_definer('public', 'export_account', array['uuid'], 'export_account is security definer (it reads auth.users)');
select function_owner_is('public', 'export_account', array['uuid'], 'postgres', 'export_account is owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.export_account(uuid)'::regprocedure), array['search_path=public'], 'export_account pins exactly search_path=public');
select isnt_definer('public', 'account_object_keys', array['uuid', 'integer', 'text', 'text'], 'account_object_keys is invoker');
select is((select proconfig from pg_proc where oid = 'public.account_object_keys(uuid, int, text, text)'::regprocedure), array['search_path=public'], 'account_object_keys pins exactly search_path=public');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r,
     unnest(array['public.export_account(uuid)', 'public.account_object_keys(uuid, int, text, text)', 'public.purge_auth_audit(uuid, text)']) f
    where has_function_privilege(r, f, 'execute')), 0,
  'neither anon nor authenticated can execute any of the three');
select ok(has_function_privilege('service_role', 'public.export_account(uuid)', 'execute')
      and has_function_privilege('service_role', 'public.account_object_keys(uuid, int, text, text)', 'execute')
      and has_function_privilege('service_role', 'public.purge_auth_audit(uuid, text)', 'execute'),
  'service_role executes all three');

-- ---------------------------------------------------------------------------
-- the cascade, from the catalog: every reference to a person follows the delete
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(array_agg(c.conrelid::regclass::text || '.' || c.conname order by 1), '{}')
     from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
       and c.connamespace = 'public'::regnamespace and c.confdeltype not in ('c', 'n')),
  '{}'::text[], 'every public foreign key to auth.users is on delete cascade or set null');
select is(
  (select coalesce(array_agg(a.attrelid::regclass::text order by 1), '{}')
     from pg_attribute a join pg_class cl on cl.oid = a.attrelid
     where cl.relnamespace = 'public'::regnamespace and cl.relkind in ('r', 'p') and a.attname = 'user_id' and not a.attisdropped
       and not exists (
         select 1 from pg_constraint c
         where c.conrelid = a.attrelid and c.contype = 'f' and c.confdeltype = 'c' and a.attnum = any(c.conkey))),
  '{}'::text[], 'every public table with a user_id column cascades it from a delete');
select has_trigger('public', 'private_profiles', 'private_profiles_guardian_gone', 'a guardian''s deletion ends the minor''s link');
select has_function('public', 'purge_auth_audit', array['uuid', 'text'], 'purge_auth_audit exists');
select is_definer('public', 'purge_auth_audit', array['uuid', 'text'], 'purge_auth_audit is security definer (it deletes in auth)');
select function_owner_is('public', 'purge_auth_audit', array['uuid', 'text'], 'postgres', 'purge_auth_audit is owned by postgres');
select is((select proconfig from pg_proc where oid = 'public.purge_auth_audit(uuid, text)'::regprocedure), array['search_path=public'], 'purge_auth_audit pins exactly search_path=public');
select is((select schedule || ' ' || command from cron.job where jobname = 'purge-auth-audit'),
  '50 4 * * * delete from auth.audit_log_entries where created_at < now() - interval ''30 days''', 'the auth audit log is kept 30 days, purged daily');

-- ---------------------------------------------------------------------------
-- guards and inputs
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c1300000-0000-4000-8000-00000000000a"}', true);
set local role authenticated;
select throws_ok($$ select public.export_account('c1300000-0000-4000-8000-00000000000a') $$, '42501', null, 'a signed-in client cannot export, even itself');
select throws_ok($$ select public.account_object_keys('c1300000-0000-4000-8000-00000000000a', 10, null, null) $$, '42501', null, 'nor list its objects');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.export_account('c1300000-0000-4000-8000-00000000000a') $$, '42501', 'export_account requires the service role', 'export_account checks the service role first');
select throws_ok($$ select public.account_object_keys('c1300000-0000-4000-8000-00000000000a', 10, null, null) $$, '42501', 'account_object_keys requires the service role', 'account_object_keys checks the service role first');
select throws_ok($$ select pg_temp.as_service('select public.export_account(null)') $$, '22023', 'user is required', 'export needs a user');
select throws_ok($$ select public.purge_auth_audit('c1300000-0000-4000-8000-00000000000a', null) $$, '42501', 'purge_auth_audit requires the service role', 'purge_auth_audit checks the service role first');
select throws_ok($$ select pg_temp.as_service('select to_jsonb(public.purge_auth_audit(null, null))') $$, '22023', 'user is required', 'the purge needs a user');
select throws_ok($$ select pg_temp.as_service('select to_jsonb(public.purge_auth_audit(''c1300000-0000-4000-8000-00000000000a'', ''a13@example.com''))') $$,
  '42501', 'account still exists', 'a live account''s audit trail is never purged');
select throws_ok($$ select pg_temp.as_service('select public.export_account(''c1300000-0000-4000-8000-0000000000ee'')') $$, 'P0002', 'no such account', 'an unknown user is refused, not exported empty');
select throws_ok($$ select pg_temp.as_service('select public.account_object_keys(null, 10, null, null)') $$, '22023', 'user is required', 'listing needs a user');
select throws_ok($$ select pg_temp.as_service('select public.account_object_keys(''c1300000-0000-4000-8000-00000000000a'', 0, null, null)') $$, '22023', 'limit must be between 1 and 1000', 'a zero limit is refused');
select throws_ok($$ select pg_temp.as_service('select public.account_object_keys(''c1300000-0000-4000-8000-00000000000a'', 10, ''traces'', null)') $$, '22023', 'a cursor needs both its bucket and its name', 'half a cursor is refused');

-- ---------------------------------------------------------------------------
-- export: the account's own rows, and nothing about anyone else
-- ---------------------------------------------------------------------------
create temp table ex as select
  pg_temp.as_service(format('select public.export_account(%L)', pg_temp.u('a'))) as a,
  pg_temp.as_service(format('select public.export_account(%L)', pg_temp.u('b'))) as b;
select is((select a ->> 'format' from ex), 'roadwise-export', 'the document says what it is');
select is((select a -> 'account' ->> 'user_id' from ex), pg_temp.u('a')::text, 'it is the account asked for');
select is((select a -> 'account' ->> 'email' from ex), 'a13@example.com', 'with its own email');
select is((select jsonb_array_length(a -> 'trips') from ex), 2, 'both of A''s drives, and not B''s');
select is((select jsonb_array_length(a -> 'trip_events') || '/' || jsonb_array_length(a -> 'event_disputes') from ex), '1/1', 'A''s events and disputes');
select is((select jsonb_array_length(a -> 'consents') || '/' || jsonb_array_length(a -> 'devices') || '/' || jsonb_array_length(a -> 'inbox') from ex), '1/1/1', 'consents, devices and inbox');
select is((select a -> 'devices' -> 0 ? 'push_token' from ex), false, 'a device''s push token (a credential) is left out');
select is((select a -> 'points_ledger' -> 0 ->> 'amount' || '/' || jsonb_array_length(a -> 'badges') || '/' || jsonb_array_length(a -> 'weekly_goals') from ex), '5/1/1', 'the ledger, badges and goals');
select is((select a -> 'family' from ex), jsonb_build_object('family_name', 'The Lanes', 'role', 'admin', 'sharing_location', true, 'joined_at', (select created_at from public.family_members where user_id = pg_temp.u('a')))
  , 'the family: A''s own membership and the name, nothing else');
select is((select a -> 'location' ->> 'lat' from ex), '47.6062', 'A''s own shared location');
select is((select a -> 'referrals' from ex), jsonb_build_array(jsonb_build_object('as', 'referrer', 'status', 'pending', 'redeemed_at', (select redeemed_at from public.referrals where referrer_id = pg_temp.u('a')), 'qualified_at', null, 'rewarded', null)),
  'a referral: only A''s side of it');
select is((select b -> 'private_profile' ->> 'guardian_linked' from ex), 'true', 'the minor''s export says a guardian is linked');
select is((select b -> 'referrals' -> 0 ->> 'as' from ex), 'invitee', 'and that they were referred');
select is(
  (select array_remove(array[
      case when position(pg_temp.u('b')::text in a::text) > 0 then 'B id in A' end,
      case when position(pg_temp.u('c')::text in a::text) > 0 then 'C id in A' end,
      case when position('b13@example.com' in a::text) > 0 then 'B email in A' end,
      case when position('47.6101' in a::text) > 0 then 'B location in A' end,
      case when position('FAMAAA' in a::text) > 0 then 'family code in A' end,
      case when position(pg_temp.u('a')::text in b::text) > 0 then 'A id in B' end,
      case when position('a13@example.com' in b::text) > 0 then 'A email in B' end,
      case when position('47.6062' in b::text) > 0 then 'A location in B' end,
      case when position('Ada' in b::text) > 0 then 'A name in B' end], null) from ex),
  '{}'::text[], 'no export names, locates or identifies anyone but its own account (family, referral and guardian link included)');

-- ---------------------------------------------------------------------------
-- the objects account-delete removes first
-- ---------------------------------------------------------------------------
select is(pg_temp.as_service(format('select public.account_object_keys(%L, 1000, null, null)', pg_temp.u('a'))),
  jsonb_build_array(
    jsonb_build_object('bucket', 'c13-other', 'name', pg_temp.u('a')::text || '/note.bin'),
    jsonb_build_object('bucket', 'traces', 'name', pg_temp.u('a')::text || '/a13-late.bin.gz'),
    jsonb_build_object('bucket', 'traces', 'name', pg_temp.u('a')::text || '/a13-trip-1.bin.gz')),
  'every object under A''s folder in every bucket, in (bucket, name) byte order; never B''s, never a look-alike prefix');
select is(pg_temp.as_service(format('select public.account_object_keys(%L, 1, %L, %L)', pg_temp.u('a'), 'traces', pg_temp.u('a')::text || '/a13-late.bin.gz')),
  jsonb_build_array(jsonb_build_object('bucket', 'traces', 'name', pg_temp.u('a')::text || '/a13-trip-1.bin.gz')),
  'the cursor pages strictly after itself');
-- the look-alike has done its job; it would otherwise match A's id in the scans below
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = pg_temp.u('a')::text || '0/not-a.bin.gz';

-- ---------------------------------------------------------------------------
-- the delete: the function removes the objects, then GoTrue deletes the auth user
-- ---------------------------------------------------------------------------
select ok(pg_temp.tables_containing(pg_temp.u('a')::text) @> array['public.trips', 'public.family_members', 'public.member_locations', 'public.points_ledger', 'public.referrals', 'storage.objects', 'auth.users'],
  'negative control: before the delete the scan finds A in the tables it must later find empty');
delete from storage.objects o
  using jsonb_array_elements(pg_temp.as_service(format('select public.account_object_keys(%L, 1000, null, null)', pg_temp.u('a')))) k
  where o.bucket_id = k ->> 'bucket' and o.name = k ->> 'name';
select lives_ok(format('delete from auth.users where id = %L', pg_temp.u('a')), 'the auth user is deleted');
select is(pg_temp.tables_containing(pg_temp.u('a')::text), array['auth.audit_log_entries'], 'review I1: after the auth delete, GoTrue''s audit log still names A');
select is(pg_temp.as_service(format('select to_jsonb(public.purge_auth_audit(%L, %L))', pg_temp.u('a'), 'a13@example.com')), '3'::jsonb,
  'the purge removes A''s rows: by id anywhere in the payload, and by the whole email, in any case');
select is(pg_temp.tables_containing(pg_temp.u('a')::text), '{}'::text[], 'after the delete and the purge no table in public, auth or storage contains A''s id');
select is((select array_agg(payload ->> 'actor_username' order by payload ->> 'actor_username') from auth.audit_log_entries where payload ->> 'actor_username' like '%13@example.com'),
  array['c13@example.com', 'c13@example.com', 'xa13@example.com'], 'nobody else''s rows go, not even an address that contains A''s');
select lives_ok($$ delete from auth.audit_log_entries where created_at < now() - interval '30 days' $$, 'the daily job''s statement runs');
select is((select count(*)::int from auth.audit_log_entries where payload ->> 'log_type' = 'old'), 0, 'and removes only what is older than 30 days');
select is((select role from public.family_members where user_id = pg_temp.u('b')), 'admin', 'the family goes on: its longest-standing member is its admin now');
select is((select count(*)::int from public.family_members where family_id = 'c1300000-0000-4000-8000-0000000000f1'), 2, 'with its two other members');
select is((select guardian_link_status || '/' || coalesce(guardian_user_id::text, 'none') from public.private_profiles where user_id = pg_temp.u('b')), 'none/none',
  'the minor whose guardian deleted their account has no link left, not a "linked" with nobody');
select is((select count(*)::int from public.trips where user_id = pg_temp.u('b')) || '/' || (select count(*)::int from public.member_locations where user_id = pg_temp.u('b'))
    || '/' || (select count(*)::int from storage.objects where owner_id = pg_temp.u('b')::text), '1/1/1',
  'nothing of B''s went with it');

select lives_ok(format('delete from auth.users where id = %L', pg_temp.u('d')), 'the last member of a family deletes their account');
select is((select count(*)::int from public.families where id = 'c1300000-0000-4000-8000-0000000000f2')
    + (select count(*)::int from public.family_places where family_id = 'c1300000-0000-4000-8000-0000000000f2'), 0,
  'and the family ends with its saved places');

-- the minor deleting their own account: only their rows go
select lives_ok(format('delete from auth.users where id = %L', pg_temp.u('b')), 'the minor deletes their account');
select is((select role from public.family_members where user_id = pg_temp.u('c')), 'admin', 'the family goes on under its last member');
select is(pg_temp.tables_containing(pg_temp.u('b')::text), array['storage.objects'], 'only the object account-delete would have removed through the Storage API is left');

-- ---------------------------------------------------------------------------
-- catch-alls (conventions 1, 5, 13)
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe13 (id int);
create function public.zz_probe13_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe13', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe13_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe13_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe13_fn();
drop table public.zz_probe13;

select * from finish();
rollback;
