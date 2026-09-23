-- 0011_referral: referral codes, redemption (R-D's order, the two budgets, one answer for a missing and a
-- malformed code), qualification in the invitee's settlement, the device check (R-C), expiry, the yearly
-- cap, retention and the under-13 transition. The builders are 0009's (copied; mkuser also stamps auth.users.created_at,
-- which GoTrue sets on sign-up and redemption's 14-day window reads).
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file runnable
-- alone. now() is the transaction's start throughout: redemption happens at now(), so qualifying drives
-- are placed on the local days after today and settlement is driven by p_now ten days on. Section 0 opens
-- real sessions over dblink (test-only, local-only guard, dropped at the end) and calls each RPC as the
-- first statement of a fresh session; its fixtures and the flag it turns on are committed and undone
-- again (a run that dies midway leaves them, and the next run deletes the users first; the flag goes back
-- to the migration's false).
-- The normaliser vectors in section 2 are parsed by scripts/__tests__/rewards-parity.test.ts too: keep
-- them one JSON array between the $vectors$ markers.
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0011_referral.test.sql runs only against the local Supabase stack';
  end if;
  create extension if not exists dblink with schema extensions;
  -- no settlement sweep runs while this file does (resumed at the end; a db reset re-creates it active)
  perform cron.alter_job((select jobid from cron.job where jobname = 'settle-rewards'), active := false);
end $$;

begin;
select plan(112);

-- ---------------------------------------------------------------------------
-- builders
-- ---------------------------------------------------------------------------
create function pg_temp.u(n int) returns uuid language sql immutable as $$
  select ('c9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.mkuser(n int, p_birth date default date '1990-01-01') returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email, created_at) values (pg_temp.u(n), 'r9-' || n || '@example.com', now());
  update public.private_profiles set birth_date = p_birth where user_id = pg_temp.u(n);
  return pg_temp.u(n);
end $$;
-- a trip on local day p_day (10:00 there), written straight into the table like 0002's tests do
create function pg_temp.trip(p_user uuid, p_day date, p_score int, p_minutes int default 20, p_tz text default 'America/Los_Angeles',
  p_role text default 'driver', p_severe boolean default false, p_events text[] default '{}', p_deleted boolean default false) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_start timestamptz := (p_day::timestamp + interval '10 hours') at time zone p_tz;
  v_cat text;
  v_i int := 0;
  v_status text := case when p_role = 'driver' then 'final' else 'unscored' end;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure,
    data_quality, status, score, unscored_reason, had_severe_event, deleted_at, category_deductions)
  values (p_user, 'r9-' || replace(gen_random_uuid()::text, '-', ''), v_start, v_start + make_interval(mins => p_minutes), p_tz,
    10000, p_minutes * 60, p_role, 'mounted', 1, 'A', v_status, case when v_status = 'final' then p_score end,
    case when v_status = 'unscored' then 'passenger' end, p_severe, case when p_deleted then now() end,
    coalesce((select jsonb_object_agg(c, 5) from unnest(p_events) c), '{}'::jsonb))
  returning id into v_id;
  foreach v_cat in array p_events loop
    v_i := v_i + 1;
    insert into public.trip_events (trip_id, user_id, client_event_id, category, started_at, duration_ms, severity, confidence,
      context_multiplier, source, status)
    values (v_id, p_user, 'ev-' || v_i, v_cat, v_start + interval '1 minute', 5000, 1, 0.9, 1, 'gnss', 'scored');
  end loop;
  return v_id;
end $$;
-- a score_daily row as the TypeScript day evaluation would store it; updated_at is set back 30 days so a
-- later rewrite (the touch trigger's now()) is seen as a change
create function pg_temp.day(p_user uuid, p_day date, p_safe boolean, p_good boolean default false, p_minutes int default 20,
  p_pf boolean default false, p_cam boolean default false, p_prov boolean default false) returns void
language sql as $$
  insert into public.score_daily (user_id, day, provisional, safe_day, good_day, phone_free_day, camera_day, exposure, driving_s,
    trips_scored, severe_events, updated_at)
  values (p_user, p_day, p_prov, p_safe, p_good, p_pf, p_cam, 1, p_minutes * 60, 1, 0, now() - interval '30 days')
$$;
-- a safe or unsafe driven day in one call
create function pg_temp.drove(p_user uuid, p_day date, p_safe boolean, p_tz text default 'America/Los_Angeles') returns void
language plpgsql as $$
begin
  perform pg_temp.trip(p_user, p_day, case when p_safe then 95 else 60 end, 20, p_tz);
  perform pg_temp.day(p_user, p_day, p_safe, false, 20, p_safe);
end $$;
-- the wall close of a Los Angeles day (02:00 PDT the next morning in June = 09:00 UTC)
create function pg_temp.la_close(p_day date) returns timestamptz language sql immutable as $$
  select ((p_day + 1)::timestamp + interval '2 hours') at time zone 'America/Los_Angeles'
$$;
create function pg_temp.settle(p_user uuid, p_now timestamptz) returns jsonb language sql as $$
  select public.settle_rewards(p_user, p_now)
$$;
create function pg_temp.dayrow(p_day date, p_safe boolean, p_pf boolean default false, p_minutes int default 20) returns jsonb
language sql immutable as $$
  select jsonb_build_object('day', p_day, 'longTermScore', 80, 'band', 'good', 'provisional', false, 'safeDay', p_safe,
    'goodDay', false, 'phoneFreeDay', p_pf, 'cameraDay', false, 'exposure', 1.25, 'drivingS', p_minutes * 60,
    'tripsScored', 1, 'severeEvents', 0)
$$;
-- apply_trip envelopes (FinalizeTripPayload at HEAD, as 0006's fixtures), Los Angeles
create function pg_temp.env(p_user uuid, p_client text, p_day date, p_score int, p_minutes int default 20,
  p_safe boolean default null, p_pf boolean default false, p_events int default 0) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours') at time zone 'America/Los_Angeles') * 1000)::bigint,
      'endedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours' + make_interval(mins => p_minutes)) at time zone 'America/Los_Angeles') * 1000)::bigint,
      'tz', 'America/Los_Angeles', 'distanceM', 12500, 'durationS', p_minutes * 60,
      'role', 'driver', 'roleConfidence', null, 'roleSource', 'manual', 'mode', 'mounted', 'cameraSession', false,
      'events', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', 'ev-' || i, 'category', 'speeding',
          'startedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours') at time zone 'America/Los_Angeles') * 1000)::bigint + i * 10000,
          'durationS', 8.5, 'durationMs', 8500, 'q', 0.9, 'corrected', false, 'status', 'scored',
          'measured', '{}'::jsonb, 'context', '{}'::jsonb, 'contextMultiplier', 1, 'severity', 1, 'deduction', 2,
          'lat', 47.606, 'lng', -122.332, 'alertShown', true, 'source', 'gnss') order by i), '[]'::jsonb)
        from generate_series(1, p_events) i),
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true, 'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb', 'polyline', '_p~iF~ps|U', 'tracePath', null,
      'hadSevereEvent', false, 'incomplete', false),
    'scored', jsonb_build_object('score', p_score, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', (select coalesce(jsonb_object_agg('ev-' || i, 2), '{}'::jsonb) from generate_series(1, p_events) i), 'scoringVersion', 1),
    'day', pg_temp.dayrow(p_day, coalesce(p_safe, p_score >= 85 and p_minutes >= 10), p_pf, p_minutes))
$$;
create function pg_temp.as_service(p_sql text) returns void language plpgsql as $$
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute p_sql;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
-- settled state that must never change: reward rows (not their bookkeeping), the ledger, the counters, the goals
create function pg_temp.snap(p_user uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'days', (select jsonb_agg(to_jsonb(r) - 'checked_through' - 'updated_at' order by r.day) from public.reward_days r where r.user_id = p_user),
    'ledger', (select jsonb_agg(to_jsonb(l) - 'id' - 'created_at' order by l.idempotency_key) from public.points_ledger l where l.user_id = p_user),
    'progress', (select to_jsonb(p) - 'updated_at' from public.progress p where p.user_id = p_user),
    'goals', (select jsonb_agg(to_jsonb(g) - 'updated_at' order by g.week_start) from public.weekly_goals g where g.user_id = p_user))
$$;
create function pg_temp.contra(p_user uuid, p_kind text default 'changed_after_settlement') returns int language sql as $$
  select count(*)::int from public.reward_contradictions where user_id = p_user and kind = p_kind
$$;
-- re-stamp a user's just-changed score_daily rows to a distinct later time (now() is constant in a test)
create function pg_temp.bump(p_user uuid, p_i int) returns int language plpgsql as $$
declare
  v_n int;
begin
  execute 'set local session_replication_role = replica';
  update public.score_daily set updated_at = now() + make_interval(mins => p_i) where user_id = p_user and updated_at = now();
  get diagnostics v_n = row_count;
  execute 'set local session_replication_role = origin';
  return v_n;
end $$;

-- the late settlement instant: every June and early July close, plus its 72 h cap, has passed
create function pg_temp.late() returns timestamptz language sql immutable as $$ select timestamptz '2026-08-01 00:00+00' $$;
create function pg_temp.conn() returns text language sql as $$
  select 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
$$;
create function pg_temp.remote(p_conn text, p_sql text) returns text language plpgsql as $$
begin
  return extensions.dblink_exec(p_conn, p_sql);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- one fresh connection signed in as F: p_sql's first row, or the error; rolled back, disconnected
create function pg_temp.fresh_client(p_sql text, p_exec boolean default false) returns text language plpgsql as $$
declare
  v text;
begin
  perform extensions.dblink_connect('rw9_client', pg_temp.conn());
  perform extensions.dblink_exec('rw9_client', $q$begin; set local role authenticated;
    set local request.jwt.claims = '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000901"}'$q$);
  begin
    if p_exec then
      v := extensions.dblink_exec('rw9_client', p_sql);
    else
      select r into v from extensions.dblink('rw9_client', p_sql) as t(r text);
    end if;
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  perform extensions.dblink_exec('rw9_client', 'rollback');
  perform extensions.dblink_disconnect('rw9_client');
  return v;
end $$;

-- redemption happens now (real time), so qualifying drives are on the days after today, and settlement
-- runs ten days on
create function pg_temp.today() returns date language sql stable as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create function pg_temp.later() returns timestamptz language sql stable as $$ select now() + interval '10 days' $$;
create function pg_temp.flag(p_on boolean) returns void language sql as $$
  update public.app_config set value = value || jsonb_build_object('referral', p_on) where key = 'feature_flags'
$$;
create function pg_temp.code_of(p_user uuid) returns text language sql as $$ select code from public.referral_codes where user_id = p_user $$;
-- a referral redeemed by p_invitee with p_referrer's code (created for the referrer if needed), as the invitee
create function pg_temp.redeem_as(p_invitee uuid, p_code text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_invitee)::text, true);
  v := public.redeem_referral_code(p_code);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function pg_temp.code_for(p_user uuid) returns text language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
  v := public.get_my_referral_code();
  perform set_config('request.jwt.claims', '', true);
  return v ->> 'code';
end $$;
create function pg_temp.mine(p_user uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
  v := public.my_referrals();
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
-- n drives on the days after today (or from p_from), each a settled-able safe day
create function pg_temp.drives(p_user uuid, p_n int, p_from date default null) returns void language plpgsql as $$
begin
  for i in 0 .. p_n - 1 loop
    perform pg_temp.drove(p_user, coalesce(p_from, pg_temp.today() + 1) + i, true);
  end loop;
end $$;
create function pg_temp.refusal(p_code text, p_message text) returns jsonb language sql immutable as $$
  select jsonb_build_object('code', p_code, 'details', null, 'hint', null, 'message', p_message)
$$;

-- ---------------------------------------------------------------------------
-- 0. fresh sessions (dblink): the three RPCs as the first statement (the flag is committed on and back off)
-- ---------------------------------------------------------------------------
select extensions.dblink_connect('rw9_pg', pg_temp.conn());
select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id in ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000903')$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into auth.users (id, email, created_at) values ('c9000000-0000-4000-8000-000000000901', 'r11-f@example.com', now()),
  ('c9000000-0000-4000-8000-000000000903', 'r11-g@example.com', now())$q$);
select extensions.dblink_exec('rw9_pg', $q$update public.private_profiles set birth_date = date '1990-01-01' where user_id in
  ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000903')$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into public.referral_codes (user_id, code) values ('c9000000-0000-4000-8000-000000000903', 'GGGG2345')$q$);
select extensions.dblink_exec('rw9_pg', $q$update public.app_config set value = value || '{"referral": true}' where key = 'feature_flags'$q$);
select is(pg_temp.fresh_client($q$select public.get_my_referral_code()::text$q$)::jsonb ->> 'code' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', true,
  'get_my_referral_code succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$select public.redeem_referral_code('gggg-2345')::text$q$)::jsonb, '{"status": "pending"}'::jsonb,
  'redeem_referral_code succeeds as the first statement of a fresh session');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.fresh_client($q$select public.my_referrals()::text$q$)::jsonb) k),
  array['canRedeem', 'cap', 'code', 'joined', 'myCode', 'qualified', 'rewardedThisYear'], 'my_referrals succeeds as the first statement of a fresh session');
select extensions.dblink_exec('rw9_pg', $q$update public.app_config set value = value || '{"referral": false}' where key = 'feature_flags'$q$);
select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id in ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000903')$q$);
select is((select n from extensions.dblink('rw9_pg', $q$select count(*)::int from auth.users where id::text like 'c9000000-0000-4000-8000-00000000090_'$q$) as t(n int)), 0,
  'the committed fixtures are gone and the flag is back');
select extensions.dblink_disconnect('rw9_pg');

-- ---------------------------------------------------------------------------
-- 1. structure and conventions
-- ---------------------------------------------------------------------------
select columns_are('public', 'referral_codes', array['user_id', 'code', 'created_at', 'updated_at']::name[], 'referral_codes has exactly its columns');
select columns_are('public', 'referrals', array['id', 'referrer_id', 'invitee_id', 'status', 'reject_reason', 'redeemed_at', 'qualified_at', 'invitee_rewarded',
  'referrer_rewarded', 'referrer_cap', 'created_at', 'updated_at']::name[], 'referrals has exactly its columns');
select columns_are('public', 'push_token_seen', array['user_id', 'token_sha256', 'first_seen_at']::name[], 'push_token_seen has exactly its columns (append-only, hashes only)');
select policies_are('public', 'referral_codes', '{}'::name[], 'referral_codes: no policy');
select policies_are('public', 'referrals', '{}'::name[], 'referrals: no policy');
select policies_are('public', 'push_token_seen', '{}'::name[], 'push_token_seen: no policy');
select is((select count(*)::int from unnest(array['referral_codes', 'referrals', 'push_token_seen']) t, unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege(r, ('public.' || t)::regclass, p)), 0,
  'no API role, the service role included, holds any privilege on the three referral tables');
select has_index('public', 'referrals', 'referrals_referrer_status_idx', 'referrals (referrer_id, status)');
select has_index('public', 'push_token_seen', 'push_token_seen_token_idx', 'push_token_seen (token_sha256)');
select has_index('public', 'push_token_seen', 'push_token_seen_first_seen_idx', 'push_token_seen (first_seen_at), the purge''s scan');
select col_is_unique('public', 'referrals', 'invitee_id', 'one referral per invitee');
select col_is_unique('public', 'referral_codes', 'code', 'codes are unique');
select throws_ok($$ insert into public.referral_codes (user_id, code) values (pg_temp.u(2), 'ABCD234I') $$, '23514', null, 'a code outside the alphabet is refused');
select throws_ok($$ insert into public.referrals (referrer_id, invitee_id, redeemed_at) values (pg_temp.u(2), pg_temp.u(2), now()) $$, '23514', null, 'nobody refers themselves');
select has_trigger('public', 'push_registrations', 'push_registrations_token_seen', 'push_registrations records each token''s hash');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.refuse_underage_writes()'::regprocedure
    and tgrelid in ('public.referral_codes'::regclass, 'public.push_token_seen'::regclass)), 2, 'codes and token hashes refuse an under-13 account');
select is((select count(*)::int from pg_proc p where p.oid in ('public.get_my_referral_code()'::regprocedure, 'public.redeem_referral_code(text)'::regprocedure,
    'public.my_referrals()'::regprocedure) and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public', 'lock_timeout=2s']), 3,
  'the three RPCs are definer, owned by postgres, proconfig exactly search_path=public, lock_timeout=2s');
select is((select count(*)::int from pg_proc p where p.oid in ('public.settle_referrals(uuid, timestamptz)'::regprocedure, 'public.record_push_token_seen()'::regprocedure,
    'public.normalise_referral_code(text)'::regprocedure, 'public.referrals_available()'::regprocedure, 'public.referral_refusal(text, text)'::regprocedure,
    'public.refresh_progress(uuid)'::regprocedure, 'public.settle_rewards(uuid, timestamptz, timestamptz)'::regprocedure, 'public.purge_reward_audit()'::regprocedure,
    'public.referral_final_at(timestamptz)'::regprocedure, 'public.schedule_next_settle(uuid, text, timestamptz, timestamptz)'::regprocedure)
    and not p.prosecdef and p.proconfig = array['search_path=public']), 10, 'every other function is invoker, pinning search_path');
select is(array(select has_function_privilege('authenticated', f, 'execute') from unnest(array['public.get_my_referral_code()', 'public.redeem_referral_code(text)',
    'public.my_referrals()']::regprocedure[]) f), array[true, true, true], 'authenticated executes the three RPCs');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'service_role']) r,
    unnest(array['public.get_my_referral_code()', 'public.redeem_referral_code(text)', 'public.my_referrals()']::regprocedure[]) f), false,
  'anon and the service role execute none of them');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.settle_referrals(uuid, timestamptz)', 'public.record_push_token_seen()', 'public.normalise_referral_code(text)',
      'public.referrals_available()', 'public.referral_refusal(text, text)', 'public.referral_final_at(timestamptz)',
      'public.schedule_next_settle(uuid, text, timestamptz, timestamptz)']::regprocedure[]) f), false, 'no API role executes a referral helper or settle step');
select is((select row(id, family, tier, metric, threshold, sort)::text from public.badge_defs where id = 'referrals_1'),
  row('referrals_1', 'referrals', 'bronze', 'referrals', 1, 16)::text, 'referrals_1 is seeded with its producer');
select is((select value -> 'referral' from public.app_config where key = 'feature_flags'), 'false'::jsonb, 'feature_flags.referral is off (R-F)');
update public.app_config set value = value || '{"referral": true}' where key = 'feature_flags';
update public.app_config set value = value || '{"referral": false}'::jsonb where key = 'feature_flags' and not value ? 'referral';
select is((select value -> 'referral' from public.app_config where key = 'feature_flags'), 'true'::jsonb, 'the migration''s merge never overwrites an operator''s true');
select pg_temp.flag(false);
select is((select count(*)::int from supabase_migrations.schema_migrations where version = '0011'
    and array_to_string(statements, ' ') like '%''feature_flags'', ''{"referral": false}'', true)%on conflict (key) do nothing%'), 1,
  'the flag key is inserted with on conflict do nothing');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe11 (id int);
create function public.zz_probe11_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe11', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe11_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe11_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe11_fn();
drop table public.zz_probe11;
select is((select coalesce(array_agg(t.relname::text order by t.relname), '{}') from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relkind = 'r' and t.relname not in ('profiles', 'private_profiles')
      and (exists (select 1 from pg_constraint c where c.conrelid = t.oid and c.contype = 'f' and c.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'user_id' and not a.attisdropped))
      and not exists (select 1 from pg_proc p where p.oid in ('public.minimise_underage_account()'::regprocedure,
                        'public.minimise_underage_notifications()'::regprocedure, 'public.minimise_underage_rewards()'::regprocedure)
                      and p.prosrc ~ ('delete from public\.' || t.relname || ' where'))), '{}'::text[],
  'every user-referencing public table (the three referral tables included) is deleted by the under-13 minimisation');
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
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach(r) where not can_execute),
  '{}'::text[], 'client-reach audit: ' || r) from unnest(array['anon', 'authenticated', 'service_role']) r;

-- ---------------------------------------------------------------------------
-- 2. the normaliser (one vector list, shared with scripts/__tests__/rewards-parity.test.ts)
-- ---------------------------------------------------------------------------
create temp table vectors as select * from jsonb_to_recordset($vectors$[
  {"input": " abcd-2345 ", "expected": "ABCD2345"},
  {"input": "aBcD-2345", "expected": "ABCD2345"},
  {"input": "\tabcd\n2345\r", "expected": "ABCD2345"},
  {"input": "ab\u000bcd\f2345", "expected": "ABCD2345"},
  {"input": "abcd\u00a02345", "expected": "ABCD2345"},
  {"input": "abcd\u16802345", "expected": "ABCD2345"},
  {"input": "abcd\u20002345", "expected": "ABCD2345"},
  {"input": "abcd\u20072345", "expected": "ABCD2345"},
  {"input": "abcd\u200a2345", "expected": "ABCD2345"},
  {"input": "abcd\u20282345\u2029", "expected": "ABCD2345"},
  {"input": "abcd\u202f2345", "expected": "ABCD2345"},
  {"input": "abcd\u205f2345", "expected": "ABCD2345"},
  {"input": "abcd\u30002345", "expected": "ABCD2345"},
  {"input": "\ufeffabcd2345", "expected": "ABCD2345"},
  {"input": "abcd\u200b2345", "expected": "ABCD\u200b2345"},
  {"input": "abcd\u20132345", "expected": "ABCD\u20132345"},
  {"input": "--ab-cd--23-45--", "expected": "ABCD2345"},
  {"input": "   ", "expected": ""},
  {"input": "", "expected": ""}
]$vectors$::jsonb) as v(input text, expected text);
select is((select count(*)::int from vectors where public.normalise_referral_code(input) is distinct from expected), 0,
  'the SQL normaliser gives exactly normaliseReferralCode''s output on every shared vector (JS \s, the hyphen, upper case; U+200B and U+2013 are kept)');
select is((select count(*)::int from vectors), 19, 'all 19 vectors ran');

-- ---------------------------------------------------------------------------
-- 3. the flag, codes and redemption (R-D)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(n) from generate_series(1, 9) n;
select throws_ok($$ select pg_temp.code_for(pg_temp.u(1)) $$, '42501', 'referrals are not available yet', 'flag off: get_my_referral_code is refused');
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(2), 'ABCD2345') $$, '42501', 'referrals are not available yet', 'flag off: redeem is refused');
select throws_ok($$ select pg_temp.mine(pg_temp.u(2)) $$, '42501', 'referrals are not available yet', 'flag off: my_referrals is refused');
select throws_ok($$ select public.get_my_referral_code() $$, '42501', 'get_my_referral_code requires an authenticated user', 'no JWT, no code');
select pg_temp.flag(true);
select is(pg_temp.code_for(pg_temp.u(1)) ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', true, 'a code is created on first call, in the alphabet');
select is(pg_temp.code_for(pg_temp.u(1)), pg_temp.code_of(pg_temp.u(1)), 'and is the same on every later call');
select is(pg_temp.redeem_as(pg_temp.u(2), ' ' || lower(substr(pg_temp.code_of(pg_temp.u(1)), 1, 4)) || '-' || lower(substr(pg_temp.code_of(pg_temp.u(1)), 5)) || ' '),
  '{"status": "pending"}'::jsonb, 'a code typed '' abcd-2345 '' style is normalised and redeemed');
select is((select row(referrer_id, status, redeemed_at = now())::text from public.referrals where invitee_id = pg_temp.u(2)),
  row(pg_temp.u(1), 'pending', true)::text, 'pending, redeemed now');
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(2), pg_temp.code_of(pg_temp.u(1))) $$, '22023', 'already used a code', 'a second redemption is refused');
select is(pg_temp.redeem_as(pg_temp.u(1), pg_temp.code_of(pg_temp.u(1))), pg_temp.refusal('22023', 'this is your own code'), 'one''s own code is refused');
select is(pg_temp.redeem_as(pg_temp.u(3), 'ZZZZ2345'), pg_temp.refusal('22023', 'invalid code'), 'a well-formed code that does not exist: invalid code');
select is(pg_temp.redeem_as(pg_temp.u(3), 'not a code!'), pg_temp.refusal('22023', 'invalid code'), 'a malformed code: the same answer');
select is((select count from public.rate_limits where user_id = pg_temp.u(3) and key = 'referral_redeem'), 2, 'each wrong code spends one attempt (the refusal is returned, so the take commits)');
select pg_temp.redeem_as(pg_temp.u(3), 'ZZZZ234' || n) from generate_series(2, 9) n;
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(3), pg_temp.code_of(pg_temp.u(1))) $$, '42501', 'too many attempts', 'the 11th attempt in 24 h is refused, even with a real code');
-- (R-D) an ineligible caller learns nothing and spends nothing
update auth.users set created_at = now() - interval '15 days' where id = pg_temp.u(4);
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(4), pg_temp.code_of(pg_temp.u(1))) $$, '22023', 'code window closed', 'a 15-day-old account: a real code');
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(4), 'QQQQ2345') $$, '22023', 'code window closed', 'and a random code get the same answer');
select throws_ok($$ select pg_temp.redeem_as(pg_temp.u(2), 'QQQQ2345') $$, '22023', 'already used a code', 'an already-redeemed caller gets the same answer for a random code');
select is(array[(select coalesce(sum(count), 0)::int from public.rate_limits where user_id = pg_temp.u(4) and key = 'referral_redeem'),
    (select count from public.rate_limits where user_id = pg_temp.u(2) and key = 'referral_redeem')], array[0, 1],
  'and neither spends any budget (the redeemed caller''s one attempt is its successful redemption)');
-- the global budget: charged only after the pattern check (r1-M3)
insert into public.global_rate_limits (key, window_start, count) values ('referral_redeem_global', now(), 0)
  on conflict (key) do update set window_start = now(), count = 0;
do $$
begin
  for u in 100 .. 159 loop
    perform pg_temp.mkuser(u);
    for j in 1 .. 10 loop
      perform pg_temp.redeem_as(pg_temp.u(u), 'bad code ' || j);
    end loop;
  end loop;
end $$;
select is((select count from public.global_rate_limits where key = 'referral_redeem_global'), 0, '600 malformed codes spend nothing from the global budget');
update public.global_rate_limits set count = 500 where key = 'referral_redeem_global';
select is(pg_temp.redeem_as(pg_temp.u(5), 'YYYY2345'), pg_temp.refusal('42501', 'too many attempts'), 'the 501st well-formed redemption in the hour: too many attempts');
update public.global_rate_limits set count = 0 where key = 'referral_redeem_global';
select is(pg_temp.redeem_as(pg_temp.u(5), 'YYYY2345'), pg_temp.refusal('22023', 'invalid code'), 'with budget, the same wrong code is simply invalid');
select is((select count from public.global_rate_limits where key = 'referral_redeem_global'), 1, 'and a wrong well-formed code spends one from the global budget');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.mine(pg_temp.u(2))) k),
  array['canRedeem', 'cap', 'code', 'joined', 'myCode', 'qualified', 'rewardedThisYear'], 'my_referrals has exactly its keys: no id, name or date of anyone');
select is(pg_temp.mine(pg_temp.u(2)) - 'code', '{"joined": 0, "qualified": 0, "rewardedThisYear": 0, "cap": 20, "canRedeem": false, "myCode": "pending"}'::jsonb,
  'the invitee sees only that their code is pending');
select is(pg_temp.mine(pg_temp.u(1)) - 'code', '{"joined": 1, "qualified": 0, "rewardedThisYear": 0, "cap": 20, "canRedeem": true, "myCode": "none"}'::jsonb,
  'the referrer sees counts only');

-- ---------------------------------------------------------------------------
-- 4. qualification (§R10): R = 1, I = 2
-- ---------------------------------------------------------------------------
select pg_temp.drives(pg_temp.u(2), 2);
select pg_temp.settle(pg_temp.u(2), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(2)), 'pending', 'two settled drives: still pending');
select pg_temp.drives(pg_temp.u(2), 1, pg_temp.today() + 3);
select pg_temp.settle(pg_temp.u(2), pg_temp.later());
select is((select row(status, invitee_rewarded, qualified_at = pg_temp.later(), referrer_rewarded)::text from public.referrals where invitee_id = pg_temp.u(2)),
  row('qualified', true, true, null::boolean)::text, 'a third drive on a settled day qualifies in the invitee''s settlement');
select is((select row(type, amount, idempotency_key)::text from public.points_ledger where user_id = pg_temp.u(2) and type = 'referral'),
  row('referral', 500, 'referral:invitee:' || (select id from public.referrals where invitee_id = pg_temp.u(2)))::text, 'the invitee +500 once');
select is((select payload from public.inbox where user_id = pg_temp.u(2) and type = 'referral_qualified'), '{"role": "invitee", "points": 500}'::jsonb,
  'a referral_qualified event with exactly the catalog''s keys');
select is((select due_at from public.reward_due where user_id = pg_temp.u(1)), pg_temp.later(), 'and the referrer is enqueued at once');
select pg_temp.settle(pg_temp.u(1), pg_temp.later());
select is((select row(count(*), min(amount), min(idempotency_key))::text from public.points_ledger where user_id = pg_temp.u(1) and type = 'referral'),
  row(1, 500, 'referral:referrer:' || (select id from public.referrals where invitee_id = pg_temp.u(2)))::text, 'the referrer''s settlement credits them once');
select is((select payload from public.inbox where user_id = pg_temp.u(1) and type = 'referral_qualified'), '{"role": "referrer", "points": 500}'::jsonb, 'with its event');
select is((select count(*)::int from public.user_badges where user_id = pg_temp.u(1) and badge_id = 'referrals_1'), 1, 'and the referrals_1 badge');
select is(array[(pg_temp.settle(pg_temp.u(2), pg_temp.later()) ->> 'ledgerRows')::int, (pg_temp.settle(pg_temp.u(1), pg_temp.later()) ->> 'ledgerRows')::int], array[0, 0],
  'replaying both settlements adds nothing');
select is(array[pg_temp.mine(pg_temp.u(2)) ->> 'myCode', pg_temp.mine(pg_temp.u(1)) ->> 'qualified', pg_temp.mine(pg_temp.u(1)) ->> 'rewardedThisYear'],
  array['counted', '1', '1'], 'the invitee sees counted, the referrer one qualified and rewarded');
-- drives before redemption, a deleted drive and an unsettled day do not count
select pg_temp.code_for(pg_temp.u(6));
select pg_temp.drove(pg_temp.u(7), pg_temp.today() - 2, true);
select pg_temp.drove(pg_temp.u(7), pg_temp.today() - 1, true);
select pg_temp.redeem_as(pg_temp.u(7), pg_temp.code_of(pg_temp.u(6)));
select pg_temp.drives(pg_temp.u(7), 2);
select pg_temp.settle(pg_temp.u(7), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(7)), 'pending', 'drives before redemption do not count');
select pg_temp.redeem_as(pg_temp.u(8), pg_temp.code_of(pg_temp.u(6)));
select pg_temp.drives(pg_temp.u(8), 3);
update public.trips set deleted_at = now() where user_id = pg_temp.u(8) and local_day = pg_temp.today() + 1;
select pg_temp.settle(pg_temp.u(8), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(8)), 'pending', 'a deleted drive does not count');
select pg_temp.redeem_as(pg_temp.u(9), pg_temp.code_of(pg_temp.u(6)));
select pg_temp.drives(pg_temp.u(9), 3);
select pg_temp.settle(pg_temp.u(9), pg_temp.la_close(pg_temp.today() + 2) + interval '1 minute');
select is((select status from public.referrals where invitee_id = pg_temp.u(9)), 'pending', 'a drive on a day not yet settled does not count yet');
select pg_temp.settle(pg_temp.u(9), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(9)), 'qualified', 'and counts once its day settles');
-- nothing before rewards_start counts
select pg_temp.mkuser(10);
select pg_temp.redeem_as(pg_temp.u(10), pg_temp.code_of(pg_temp.u(6)));
insert into public.progress (user_id, rewards_start) values (pg_temp.u(10), pg_temp.today() + 3);
select pg_temp.drives(pg_temp.u(10), 3);
select pg_temp.settle(pg_temp.u(10), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(10)), 'pending', 'only drives on days on or after rewards_start count');
-- (fix round 1, m1) a drive uploaded late, behind the frontier, lands on I-A's frozen row and never counts
select pg_temp.mkuser(19);
select pg_temp.redeem_as(pg_temp.u(19), pg_temp.code_of(pg_temp.u(6)));
select pg_temp.drove(pg_temp.u(19), pg_temp.today() + 1, true);
select pg_temp.drove(pg_temp.u(19), pg_temp.today() + 3, true);
select pg_temp.settle(pg_temp.u(19), pg_temp.later());
select pg_temp.drove(pg_temp.u(19), pg_temp.today() + 2, true);
select pg_temp.settle(pg_temp.u(19), pg_temp.later());
select is((select row(outcome, outcome_reason, points)::text from public.reward_days where user_id = pg_temp.u(19) and day = pg_temp.today() + 2),
  row('neutral', 'late', 0)::text, 'a day uploaded behind the frontier settles as I-A''s frozen neutral row, reason late');
select is((select status from public.referrals where invitee_id = pg_temp.u(19)), 'pending', 'so its drive does not count: three drives, two on real settled days, still pending');
-- the same day read as a no_drive row (reward_days is immutable, hence replica) does not count either
set local session_replication_role = replica;
update public.reward_days set outcome_reason = 'no_drive' where user_id = pg_temp.u(19) and day = pg_temp.today() + 2;
set local session_replication_role = origin;
select pg_temp.settle(pg_temp.u(19), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(19)), 'pending', 'a no_drive day''s drive does not count either');
select pg_temp.drove(pg_temp.u(19), pg_temp.today() + 4, true);
select pg_temp.settle(pg_temp.u(19), pg_temp.later());
select is((select status from public.referrals where invitee_id = pg_temp.u(19)), 'qualified', 'the next normally settled drive qualifies');

-- ---------------------------------------------------------------------------
-- 5. the device check (R-C), expiry and the yearly cap
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(n) from generate_series(11, 16) n;
select pg_temp.code_for(pg_temp.u(11));
select pg_temp.redeem_as(pg_temp.u(12), pg_temp.code_of(pg_temp.u(11)));
insert into public.devices (id, user_id, platform) values ('shared-phone', pg_temp.u(11), 'ios'), ('shared-phone', pg_temp.u(12), 'ios');
select pg_temp.drives(pg_temp.u(12), 3);
select pg_temp.settle(pg_temp.u(12), pg_temp.later());
select is((select row(status, reject_reason)::text from public.referrals where invitee_id = pg_temp.u(12)), row('rejected', 'shared_device')::text,
  'a shared devices.id: rejected / shared_device');
select is(array[(select count(*)::int from public.points_ledger where user_id = pg_temp.u(12) and type = 'referral'),
    (select count(*)::int from public.inbox where user_id in (pg_temp.u(11), pg_temp.u(12)) and type = 'referral_qualified')], array[0, 0], 'no ledger row, no event');
select is(array[pg_temp.mine(pg_temp.u(12)) ->> 'myCode', pg_temp.mine(pg_temp.u(11)) ->> 'joined', pg_temp.mine(pg_temp.u(11)) ->> 'qualified'], array['not_counted', '1', '0'],
  'the invitee sees not_counted; the referrer joined +1, qualified +0');
-- a push token registered by the referrer and later reassigned to the invitee (0007's register_push_token)
select pg_temp.code_for(pg_temp.u(13));
select pg_temp.redeem_as(pg_temp.u(14), pg_temp.code_of(pg_temp.u(13)));
insert into public.devices (id, user_id, platform) values ('r-phone', pg_temp.u(13), 'ios'), ('i-phone', pg_temp.u(14), 'ios');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000013"}', true);
select public.register_push_token('r-phone', 'ExponentPushToken[sharedtoken001]');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000014"}', true);
select public.register_push_token('i-phone', 'ExponentPushToken[sharedtoken001]');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.drives(pg_temp.u(14), 3);
select pg_temp.settle(pg_temp.u(14), pg_temp.later());
select is((select row(status, reject_reason)::text from public.referrals where invitee_id = pg_temp.u(14)), row('rejected', 'shared_device')::text,
  'disjoint device ids but a push token held first by the referrer and then by the invitee: rejected / shared_device');
select is((select row(count(*), bool_and(octet_length(token_sha256) = 32), bool_and(token_sha256 = extensions.digest('ExponentPushToken[sharedtoken001]', 'sha256')))::text
    from public.push_token_seen where user_id in (pg_temp.u(13), pg_temp.u(14))), row(2, true, true)::text, 'push_token_seen holds the 32-byte hash for each holder');
select is((select count(*)::int from public.push_token_seen where position('sharedtoken' in encode(token_sha256, 'escape')) > 0), 0, 'never the token itself');
-- expiry
select pg_temp.redeem_as(pg_temp.u(15), pg_temp.code_of(pg_temp.u(13)));
select pg_temp.settle(pg_temp.u(15), now() + interval '91 days');
select is((select status from public.referrals where invitee_id = pg_temp.u(15)), 'pending', '91 days without qualifying: not yet final, still pending');
select pg_temp.settle(pg_temp.u(15), now() + interval '96 days');
select is((select status from public.referrals where invitee_id = pg_temp.u(15)), 'expired', '96 days (past 90 d + 125 h) without qualifying: expired');
select is(pg_temp.mine(pg_temp.u(15)) ->> 'myCode', 'not_counted', 'an expired row reads not_counted at once');
-- (fix rounds 1-2, m2/I1) one bound for the display and the state: 90 d + (25 + 26 + 2 + SETTLE_CAP_H) h
select is(public.referral_final_at(timestamptz '2026-01-01 00:00+00'), timestamptz '2026-01-01 00:00+00' + interval '90 days 125 hours',
  'referral_final_at is redemption + 90 days + 125 hours');
select pg_temp.mkuser(20);
select pg_temp.mkuser(21);
select pg_temp.code_for(pg_temp.u(20));
select pg_temp.redeem_as(pg_temp.u(21), pg_temp.code_of(pg_temp.u(20)));
update public.referrals set redeemed_at = now() - interval '90 days 125 hours' + interval '1 minute' where invitee_id = pg_temp.u(21);
select is(pg_temp.mine(pg_temp.u(21)) ->> 'myCode', 'pending', 'my_referrals one minute before the bound: still pending (a held in-window day can still settle)');
update public.referrals set redeemed_at = now() - interval '90 days 125 hours' - interval '1 minute' where invitee_id = pg_temp.u(21);
select is(pg_temp.mine(pg_temp.u(21)) ->> 'myCode', 'not_counted', 'one minute after: not_counted');
-- (I1) settlement expires on the same bound, and the scheduler wakes the invitee just after it
select pg_temp.mkuser(23);
select pg_temp.redeem_as(pg_temp.u(23), pg_temp.code_of(pg_temp.u(20)));
create temp table final23 as select public.referral_final_at(redeemed_at) as t from public.referrals where invitee_id = pg_temp.u(23);
select pg_temp.settle(pg_temp.u(23), (select t from final23) - interval '1 minute');
select is((select status from public.referrals where invitee_id = pg_temp.u(23)), 'pending', 'a settlement one minute before the bound leaves it pending');
select is((select due_at from public.reward_due where user_id = pg_temp.u(23)), (select t from final23) + interval '1 minute',
  'and schedules the invitee one minute after the bound');
select pg_temp.settle(pg_temp.u(23), (select t from final23) + interval '1 minute');
select is((select status from public.referrals where invitee_id = pg_temp.u(23)), 'expired', 'that settlement expires it');
select is((select count(*)::int from public.reward_due where user_id = pg_temp.u(23)), 0, 'and nothing more is scheduled');
-- (I1) a third drive on the window's last day, held by the watermark past 90 days, still qualifies once it syncs
select pg_temp.mkuser(22);
select pg_temp.redeem_as(pg_temp.u(22), pg_temp.code_of(pg_temp.u(20)));
update public.referrals set redeemed_at = ((pg_temp.today() + 3)::timestamp + interval '12 hours') at time zone 'America/Los_Angeles' - interval '90 days'
  where invitee_id = pg_temp.u(22);
select pg_temp.drives(pg_temp.u(22), 3);
-- the watermarks are future instants here, which devices_clamp_watermark would clamp to now(): set them past it
set local session_replication_role = replica;
insert into public.devices (id, user_id, platform, synced_through) values ('w-phone', pg_temp.u(22), 'ios', pg_temp.la_close(pg_temp.today() + 2) + interval '1 minute');
set local session_replication_role = origin;
select pg_temp.settle(pg_temp.u(22), pg_temp.la_close(pg_temp.today() + 3) + interval '1 day');
select is(array[(select status from public.referrals where invitee_id = pg_temp.u(22)),
    (select count(*)::text from public.reward_days where user_id = pg_temp.u(22) and day = pg_temp.today() + 3)], array['pending', '0'],
  'past 90 days the last window day is held by the watermark: not settled, and the referral stays pending');
set local session_replication_role = replica;
update public.devices set synced_through = pg_temp.la_close(pg_temp.today() + 3) + interval '1 minute' where user_id = pg_temp.u(22);
set local session_replication_role = origin;
select pg_temp.settle(pg_temp.u(22), pg_temp.la_close(pg_temp.today() + 3) + interval '1 day');
select is((select status from public.referrals where invitee_id = pg_temp.u(22)), 'qualified', 'after the sync the day settles and the referral qualifies');
-- (n3) canRedeem is never null
select pg_temp.mkuser(24);
update auth.users set created_at = null where id = pg_temp.u(24);
select is(pg_temp.mine(pg_temp.u(24)) -> 'canRedeem', 'false'::jsonb, 'canRedeem is false, not null, when the account''s creation time is unknown');
-- the yearly cap: 20 already rewarded in 365 days
select pg_temp.mkuser(n) from generate_series(200, 219) n;
insert into public.referrals (referrer_id, invitee_id, status, redeemed_at, qualified_at, invitee_rewarded, referrer_rewarded)
  select pg_temp.u(16), pg_temp.u(n), 'qualified', now() - interval '20 days', now() - interval '10 days', true, true from generate_series(200, 218) n;
insert into public.referrals (referrer_id, invitee_id, status, redeemed_at, qualified_at, invitee_rewarded, referrer_rewarded)
  values (pg_temp.u(16), pg_temp.u(219), 'qualified', now() - interval '400 days', now() - interval '300 days', true, true);
select pg_temp.code_for(pg_temp.u(16));
select pg_temp.mkuser(17);
select pg_temp.redeem_as(pg_temp.u(17), pg_temp.code_of(pg_temp.u(16)));
select pg_temp.drives(pg_temp.u(17), 3);
select pg_temp.settle(pg_temp.u(17), pg_temp.later());
select pg_temp.settle(pg_temp.u(16), pg_temp.later());
select is((select row(status, invitee_rewarded, referrer_rewarded, referrer_cap)::text from public.referrals where invitee_id = pg_temp.u(17)),
  row('qualified', true, false, true)::text, 'the 21st in 365 days: recorded unrewarded for the referrer (cap), the invitee still credited');
select is(array[(select count(*)::int from public.points_ledger where user_id = pg_temp.u(16) and type = 'referral'),
    (select count(*)::int from public.points_ledger where user_id = pg_temp.u(17) and type = 'referral')], array[0, 1], 'no referrer credit, one invitee credit');
select pg_temp.mkuser(18);
select pg_temp.redeem_as(pg_temp.u(18), pg_temp.code_of(pg_temp.u(16)));
select pg_temp.drives(pg_temp.u(18), 3);
update public.referrals set qualified_at = now() - interval '366 days' where referrer_id = pg_temp.u(16) and invitee_id = pg_temp.u(200);
select pg_temp.settle(pg_temp.u(18), pg_temp.later());
select pg_temp.settle(pg_temp.u(16), pg_temp.later());
select is((select referrer_rewarded from public.referrals where invitee_id = pg_temp.u(18)), true, 'once one falls out of the 365 days, the next is rewarded again');

-- ---------------------------------------------------------------------------
-- 6. retention, under 13
-- ---------------------------------------------------------------------------
insert into public.push_token_seen (user_id, token_sha256, first_seen_at) values
  (pg_temp.u(11), extensions.digest('old', 'sha256'), now() - interval '401 days'), (pg_temp.u(11), extensions.digest('young', 'sha256'), now() - interval '399 days');
select is(public.purge_reward_audit(), 1, 'a push_token_seen row older than 400 days is purged');
select is((select count(*)::int from public.push_token_seen where user_id = pg_temp.u(11) and token_sha256 = extensions.digest('young', 'sha256')), 1, 'a 399-day-old one is kept');
select is(array[(select count(*) from public.referral_codes where user_id = pg_temp.u(13)), (select count(*) from public.referrals where referrer_id = pg_temp.u(13)),
    (select count(*) from public.push_token_seen where user_id = pg_temp.u(13))]::int[], array[1, 2, 1], 'the referrer 13 holds a code, referrals and a token hash');
update public.private_profiles set birth_date = null where user_id = pg_temp.u(13);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000013"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'the referrer gives a child''s birth date');
select throws_ok($$ select public.my_referrals() $$, '42501', 'account not eligible', 'and can no longer call a referral RPC');
reset role;
select set_config('request.jwt.claims', '', true);
select is(array[(select count(*) from public.referral_codes where user_id = pg_temp.u(13)), (select count(*) from public.referrals where referrer_id = pg_temp.u(13) or invitee_id = pg_temp.u(13)),
    (select count(*) from public.push_token_seen where user_id = pg_temp.u(13))]::int[], array[0, 0, 0], 'the u13 transition deletes the code, the referral rows and the token hashes');
select is((select level from public.profiles where id = pg_temp.u(13)), 1, 'and keeps the class reset (R-H)');
select throws_ok($$ insert into public.referral_codes (user_id, code) values (pg_temp.u(13), 'HHHH2345') $$, '42501', 'account not eligible', 'no code can be written for them');

select * from finish();
rollback;
drop extension if exists dblink;
select cron.alter_job((select jobid from cron.job where jobname = 'settle-rewards'), active := true);
