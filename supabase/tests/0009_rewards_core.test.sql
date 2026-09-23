-- 0009_rewards_core: final settled reward days behind a sync watermark, the idempotent ledger, the
-- append-only streak, the weekly goal, the contradiction log, the settlement procedure and its queue.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. now() is the transaction's start throughout; settlement is driven by p_now, so the
-- fixture days are fixed dates in June 2026 (in the past). Section 0 opens real sessions over dblink
-- (test-only, local-only guard, dropped at the end): client writes as the first statement of a fresh
-- session, two sweeps racing on one user, apply_trip while a settlement is open, and the lease race.
-- Its fixture users are committed and deleted again; a run that dies midway leaves them, and the next
-- run deletes them first.
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0009_rewards_core.test.sql runs only against the local Supabase stack';
  end if;
  create extension if not exists dblink with schema extensions;
  -- no settlement sweep runs while this file does (resumed at the end; a db reset re-creates it active)
  perform cron.alter_job((select jobid from cron.job where jobname = 'settle-rewards'), active := false);
end $$;

begin;
select plan(248);

-- ---------------------------------------------------------------------------
-- builders
-- ---------------------------------------------------------------------------
create function pg_temp.u(n int) returns uuid language sql immutable as $$
  select ('c9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.mkuser(n int, p_birth date default date '1990-01-01') returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email) values (pg_temp.u(n), 'r9-' || n || '@example.com');
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

-- ---------------------------------------------------------------------------
-- 0. real sessions (dblink): fresh-session client writes, racing sweeps, apply_trip never waits, the
--    lease race. F (901) and G (902) are committed and deleted again.
-- ---------------------------------------------------------------------------
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
-- a service-role apply_trip in its own committed transaction, refusing to wait more than 200 ms
create function pg_temp.remote_apply(p_conn text, p_env jsonb) returns text language sql as $$
  select pg_temp.remote(p_conn, format($q$begin; set local role service_role;
    set local request.jwt.claims = '{"role":"service_role"}'; set local lock_timeout = '200ms';
    do $d$ begin perform public.apply_trip(%L::jsonb); end $d$; commit$q$, p_env::text))
$$;

select extensions.dblink_connect('rw9_pg', pg_temp.conn());
select extensions.dblink_connect('rw9_s1', pg_temp.conn());
select extensions.dblink_connect('rw9_s2', pg_temp.conn());
select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id in
  ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into auth.users (id, email) values
  ('c9000000-0000-4000-8000-000000000901', 'r9-f@example.com'), ('c9000000-0000-4000-8000-000000000902', 'r9-g@example.com')$q$);
select extensions.dblink_exec('rw9_pg', $q$update public.private_profiles set birth_date = date '1990-01-01' where user_id in
  ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into public.devices (id, user_id, platform) values ('f-phone', 'c9000000-0000-4000-8000-000000000901', 'ios')$q$);

-- client write paths, each the first statement of its own fresh session
select is((pg_temp.fresh_client('select public.open_my_week()::text'))::jsonb ->> 'state', 'active',
  'open_my_week succeeds as the first statement of a fresh session as authenticated');
select is((pg_temp.fresh_client($q$select public.set_weekly_focus('phone')::text$q$))::jsonb ->> 'applied', 'this_week',
  'set_weekly_focus succeeds as the first statement of a fresh session');
select is(pg_temp.fresh_client($q$update public.devices set synced_through = now() + interval '1 day' where id = 'f-phone'$q$, true), 'UPDATE 1',
  'a devices PATCH of synced_through succeeds as the first statement of a fresh session (the clamp runs as authenticated)');

-- G: two drives committed through apply_trip
select is(pg_temp.remote_apply('rw9_pg', pg_temp.env(pg_temp.u(902), 'g1', date '2026-06-10', 95)), 'COMMIT', 'G''s first drive is committed');
-- two sweeps racing on one user: the second waits for the first, then adds nothing
select extensions.dblink_exec('rw9_s1', $q$begin; do $d$ begin perform public.settle_rewards('c9000000-0000-4000-8000-000000000902', now()); end $d$$q$);
select extensions.dblink_send_query('rw9_s2', $q$select public.settle_rewards('c9000000-0000-4000-8000-000000000902', now())::text$q$);
select pg_sleep(0.3);
select is(extensions.dblink_is_busy('rw9_s2'), 1, 'a second sweep of the same user waits for the first');
select extensions.dblink_exec('rw9_s1', 'commit');
select is((select (r::jsonb ->> 'ledgerRows')::int from extensions.dblink_get_result('rw9_s2') as t(r text)), 0,
  'and then credits nothing more');
select * from extensions.dblink_get_result('rw9_s2') as t(r text);
select is((select row(n = k, n > 0)::text from extensions.dblink('rw9_pg', $q$select count(*)::int, count(distinct idempotency_key)::int
    from public.points_ledger where user_id = 'c9000000-0000-4000-8000-000000000902'$q$) as t(n int, k int)), row(true, true)::text,
  'each ledger key exists once after the race');

-- apply_trip never waits on a settlement
select extensions.dblink_exec('rw9_s1', $q$begin; do $d$ begin
  perform 1 from public.progress where user_id = 'c9000000-0000-4000-8000-000000000902' for update;
  perform public.settle_days('c9000000-0000-4000-8000-000000000902', 'America/Los_Angeles', now()); end $d$$q$);
select is(pg_temp.remote_apply('rw9_s2', pg_temp.env(pg_temp.u(902), 'g2', date '2026-06-11', 95)), 'COMMIT',
  'apply_trip succeeds under lock_timeout 200ms while another session holds the user''s progress row inside an open settlement');
select extensions.dblink_exec('rw9_s1', 'rollback');
select extensions.dblink_exec('rw9_pg', $q$update public.reward_due set due_at = now() + interval '10 minutes' where user_id = 'c9000000-0000-4000-8000-000000000902'$q$);
select extensions.dblink_exec('rw9_s1', $q$begin; do $d$ begin
  perform 1 from public.progress where user_id = 'c9000000-0000-4000-8000-000000000902' for update; end $d$$q$);
select is(pg_temp.remote_apply('rw9_s2', pg_temp.env(pg_temp.u(902), 'g3', date '2026-06-12', 95)), 'COMMIT',
  'and while its reward_due claim is leased (the lease is committed separately, so nothing holds the row)');
select extensions.dblink_exec('rw9_s1', 'rollback');

-- the lease race (rev2: I-B): an enqueue while a leased settlement is running is never lost
create temp table g_lease as select now() + interval '10 minutes' as lease, (now() at time zone 'America/Los_Angeles')::date as today;
select extensions.dblink_exec('rw9_pg', format($q$update public.reward_due set due_at = %L where user_id = 'c9000000-0000-4000-8000-000000000902'$q$,
  (select lease from g_lease)));
select extensions.dblink_exec('rw9_s1', $q$begin; do $d$ begin
  perform 1 from public.progress where user_id = 'c9000000-0000-4000-8000-000000000902' for update; end $d$$q$);
select is(pg_temp.remote_apply('rw9_s2', pg_temp.env(pg_temp.u(902), 'g4', (select today from g_lease), 95)), 'COMMIT',
  'a drive for today commits while the leased settlement is open');
select is(pg_temp.remote('rw9_s1', format($q$do $d$ begin perform public.settle_rewards('c9000000-0000-4000-8000-000000000902', now(), %L); end $d$; commit$q$,
    (select lease from g_lease))), 'COMMIT', 'the leased settlement finishes');
select is((select d from extensions.dblink('rw9_pg', $q$select due_at::text from public.reward_due where user_id = 'c9000000-0000-4000-8000-000000000902'$q$) as t(d text))::timestamptz,
  pg_temp.la_close((select today from g_lease)),
  'the reward_due row still exists, at the new day''s close (the enqueue only ever lowers it; final review I1: the real close, not UTC+14''s)');
select is((select n from extensions.dblink('rw9_pg', format($q$select count(*)::int from public.reward_days where user_id = 'c9000000-0000-4000-8000-000000000902' and day = %L$q$,
    (select today from g_lease))) as t(n int)), 0, 'the new day is not settled before its close');
select extensions.dblink_exec('rw9_pg', format($q$do $d$ begin perform public.settle_rewards('c9000000-0000-4000-8000-000000000902', %L); end $d$$q$,
  pg_temp.la_close((select today from g_lease)) + interval '1 minute'));
select is((select n from extensions.dblink('rw9_pg', format($q$select count(*)::int from public.reward_days where user_id = 'c9000000-0000-4000-8000-000000000902' and day = %L$q$,
    (select today from g_lease))) as t(n int)), 1, 'and settles on the next run after it');

-- the procedure bounds every transaction with lock_timeout 2 s (T5 review): a held queue table or a held
-- progress row ends the run within a few seconds, never a wait
select extensions.dblink_exec('rw9_pg', $q$insert into public.reward_due (user_id, due_at) values ('c9000000-0000-4000-8000-000000000902', now() - interval '1 minute')
  on conflict (user_id) do update set due_at = excluded.due_at, failures = 0$q$);
select extensions.dblink_exec('rw9_s1', 'begin; lock table public.reward_due in access exclusive mode');
create temp table t_call as select clock_timestamp() as c;
select is(pg_temp.remote('rw9_s2', 'call public.settle_due_rewards(5)'), 'CALL', 'the CALL with the queue table locked elsewhere returns cleanly');
select ok(clock_timestamp() - (select c from t_call) < interval '6 seconds', 'within a few seconds (lock_timeout 2 s on the claim)');
select extensions.dblink_exec('rw9_s1', 'rollback');
select extensions.dblink_exec('rw9_s1', $q$begin; do $d$ begin
  perform 1 from public.progress where user_id = 'c9000000-0000-4000-8000-000000000902' for update; end $d$$q$);
update t_call set c = clock_timestamp();
select is(pg_temp.remote('rw9_s2', 'call public.settle_due_rewards(5)'), 'CALL', 'the CALL with the user''s progress row held elsewhere returns cleanly');
select ok(clock_timestamp() - (select c from t_call) < interval '6 seconds', 'within a few seconds (lock_timeout 2 s on the settlement)');
select extensions.dblink_exec('rw9_s1', 'rollback');
select is((select n from extensions.dblink('rw9_pg', $q$select failures from public.reward_due where user_id = 'c9000000-0000-4000-8000-000000000902'$q$) as t(n int)), 1,
  'and the lease backs off as for any failure');

select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id in
  ('c9000000-0000-4000-8000-000000000901', 'c9000000-0000-4000-8000-000000000902')$q$);
select is((select n from extensions.dblink('rw9_pg', $q$select count(*)::int from auth.users where id::text like 'c9000000-0000-4000-8000-00000000090_'$q$) as t(n int)), 0,
  'the committed fixtures are gone again');
select extensions.dblink_disconnect('rw9_s2');
select extensions.dblink_disconnect('rw9_s1');
select extensions.dblink_disconnect('rw9_pg');

-- ---------------------------------------------------------------------------
-- fixtures for the rest (one transaction): A adult, B adult, T teen, U later under 13
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(1);
select pg_temp.mkuser(2);
select pg_temp.mkuser(3, ((now() at time zone 'UTC')::date - interval '16 years')::date);
select pg_temp.mkuser(4);
insert into public.devices (id, user_id, platform, synced_through) select 'dev-' || n, pg_temp.u(n), 'ios', now() from generate_series(1, 4) n;

-- ---------------------------------------------------------------------------
-- 1. structure and conventions
-- ---------------------------------------------------------------------------
select columns_are('public', 'progress', array['user_id', 'points', 'xp', 'level', 'streak_days', 'best_streak', 'safe_days', 'phone_free_days',
  'smooth_days', 'goals_achieved', 'challenges_completed', 'referrals_rewarded', 'shields', 'next_focus', 'settled_through', 'streak_started', 'rewards_start',
  'created_at', 'updated_at']::name[], 'progress has exactly its columns');
select columns_are('public', 'points_ledger', array['id', 'user_id', 'type', 'amount', 'ref_key', 'balance_after', 'idempotency_key', 'created_at']::name[],
  'points_ledger has exactly its columns (append-only: no updated_at)');
select columns_are('public', 'reward_days', array['user_id', 'day', 'outcome', 'outcome_reason', 'tier', 'phone_free', 'camera', 'predicates', 'points',
  'streak_after', 'wall_close', 'settled_at', 'source_updated_at', 'checked_through', 'created_at', 'updated_at']::name[], 'reward_days has exactly its columns');
select columns_are('public', 'reward_due', array['user_id', 'due_at', 'failures', 'created_at', 'updated_at']::name[], 'reward_due has exactly its columns');
select columns_are('public', 'weekly_goals', array['user_id', 'week_start', 'category', 'source', 'target_days', 'pass_days', 'fail_days', 'state',
  'prorated', 'closed_at', 'tz', 'created_at', 'updated_at']::name[], 'weekly_goals has exactly its columns (tz pinned at creation, final review m2)');
select columns_are('public', 'reward_contradictions', array['id', 'user_id', 'day', 'kind', 'detail', 'dedupe_key', 'created_at']::name[],
  'reward_contradictions has exactly its columns (append-only)');
select has_column('public', 'devices', 'synced_through', 'devices carries synced_through');
select has_column('public', 'devices', 'signed_out_at', 'devices carries signed_out_at');
select has_column('public', 'score_daily', 'trips_all', 'score_daily carries trips_all');
select policies_are('public', 'progress', array['progress_select_own']::name[], 'progress: select own');
select policies_are('public', 'points_ledger', array['points_ledger_select_own']::name[], 'points_ledger: select own');
select policies_are('public', 'reward_days', array['reward_days_select_own']::name[], 'reward_days: select own');
select policies_are('public', 'reward_due', '{}'::name[], 'reward_due: no policy (server only)');
select policies_are('public', 'weekly_goals', array['weekly_goals_select_own']::name[], 'weekly_goals: select own');
select policies_are('public', 'reward_contradictions', '{}'::name[], 'reward_contradictions: no policy (server only)');
select is((select count(*)::int from pg_policy where polrelid in ('public.progress'::regclass, 'public.points_ledger'::regclass,
    'public.reward_days'::regclass, 'public.weekly_goals'::regclass) and polroles = array['authenticated'::regrole::oid] and polcmd = 'r'), 4,
  'the four policies are select-only, to authenticated');
select is(array(select row(t, r, (select coalesce(array_agg(p order by p), '{}') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege(r, ('public.' || t)::regclass, p)))::text
    from unnest(array['points_ledger','progress','reward_contradictions','reward_days','reward_due','weekly_goals']) t, unnest(array['anon','authenticated','service_role']) r order by t, r),
  array[row('points_ledger','anon','{}'::text[])::text, row('points_ledger','authenticated','{SELECT}'::text[])::text, row('points_ledger','service_role','{}'::text[])::text,
        row('progress','anon','{}'::text[])::text, row('progress','authenticated','{SELECT}'::text[])::text, row('progress','service_role','{}'::text[])::text,
        row('reward_contradictions','anon','{}'::text[])::text, row('reward_contradictions','authenticated','{}'::text[])::text, row('reward_contradictions','service_role','{}'::text[])::text,
        row('reward_days','anon','{}'::text[])::text, row('reward_days','authenticated','{}'::text[])::text, row('reward_days','service_role','{}'::text[])::text,
        row('reward_due','anon','{}'::text[])::text, row('reward_due','authenticated','{}'::text[])::text, row('reward_due','service_role','{}'::text[])::text,
        row('weekly_goals','anon','{}'::text[])::text, row('weekly_goals','authenticated','{SELECT}'::text[])::text, row('weekly_goals','service_role','{}'::text[])::text],
  'exact table privileges: select for authenticated where owners read, and no DML for any API role, the service role included');
select column_privs_are('public', 'reward_days', 'checked_through', 'authenticated', '{}'::name[], 'reward_days.checked_through is not client-readable');
select column_privs_are('public', 'reward_days', 'points', 'authenticated', array['SELECT']::name[], 'reward_days.points is readable');
select has_index('public', 'trips', 'trips_user_local_day_idx', 'trips (user_id, local_day), the facts include deleted drives');
select has_index('public', 'reward_due', 'reward_due_due_at_idx', 'reward_due (due_at), the sweep''s probe');
select has_index('public', 'points_ledger', 'points_ledger_user_created_idx', 'points_ledger (user_id, created_at desc)');
select has_index('public', 'reward_contradictions', 'reward_contradictions_user_created_idx', 'reward_contradictions (user_id, created_at desc)');
select has_index('public', 'reward_contradictions', 'reward_contradictions_created_idx', 'reward_contradictions (created_at), the purge''s scan');
select is(array(select pg_get_constraintdef(oid) from pg_constraint where conname in ('points_ledger_user_key', 'reward_contradictions_user_dedupe_key') order by conname),
  array['UNIQUE (user_id, idempotency_key)', 'UNIQUE (user_id, dedupe_key)'], 'the ledger and the contradictions are idempotent per user');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.touch_updated_at()'::regprocedure
    and tgrelid in ('public.progress'::regclass, 'public.reward_days'::regclass, 'public.reward_due'::regclass, 'public.weekly_goals'::regclass)), 4,
  'the four mutable tables keep updated_at');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.refuse_underage_writes()'::regprocedure
    and tgrelid in ('public.progress'::regclass, 'public.points_ledger'::regclass, 'public.reward_days'::regclass, 'public.reward_due'::regclass,
      'public.weekly_goals'::regclass, 'public.reward_contradictions'::regclass)), 6, 'all six new user tables refuse an under-13 account''s inserts');
select is(array(select tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal and tgname in ('reward_days_freeze', 'devices_clamp_watermark',
    'score_daily_enqueue_reward', 'trips_audit_relabel', 'profiles_minimise_underage_rewards') order by 1),
  array['devices.devices_clamp_watermark', 'profiles.profiles_minimise_underage_rewards', 'reward_days.reward_days_freeze',
        'score_daily.score_daily_enqueue_reward', 'trips.trips_audit_relabel'], 'the five triggers are in place');

-- definer hygiene, the one procedure exception, execute grants
select is((select count(*)::int from pg_proc p where p.oid in ('public.open_my_week()'::regprocedure, 'public.set_weekly_focus(text)'::regprocedure)
    and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public', 'lock_timeout=2s']), 2,
  'the two RPCs are definer, owned by postgres, proconfig exactly search_path=public, lock_timeout=2s');
select is((select row(p.prosecdef, p.proowner = 'postgres'::regrole, p.proconfig)::text from pg_proc p where p.oid = 'public.minimise_underage_rewards()'::regprocedure),
  row(true, true, array['search_path=public'])::text, 'the minimisation trigger is definer, owned by postgres, pinning search_path');
create temp table fn9 (f regprocedure);
insert into fn9 select unnest(array['public.reward_rules()', 'public.clamp_device_watermark()', 'public.valid_reward_predicates(jsonb)', 'public.freeze_reward_day()',
  'public.reward_wall_close(date, text[])', 'public.reward_day_facts(uuid, date, date, text)', 'public.reward_day_ready(uuid, timestamptz, timestamptz)',
  'public.reward_outcome(public.reward_fact)', 'public.reward_tier(public.reward_fact)', 'public.reward_predicates(public.reward_fact)',
  'public.reward_fact_summary(public.reward_fact)', 'public.reward_zone_hop(uuid, timestamptz)', 'public.reward_week_closed(uuid, date, text, timestamptz)',
  'public.weakest_goal_category(uuid, date)', 'public.reward_credit(uuid, text, int, text, text)', 'public.settle_days(uuid, text, timestamptz)',
  'public.append_streak(uuid, date[])', 'public.reward_goal_counts(uuid, date, text)', 'public.ensure_week_goal(uuid, date, text, timestamptz)',
  'public.settle_goals(uuid, text, timestamptz, date[])', 'public.refresh_progress(uuid)', 'public.emit_reward_events(uuid, jsonb, text, timestamptz)',
  'public.reward_retry_at(timestamptz, timestamptz)', 'public.schedule_next_settle(uuid, text, timestamptz, timestamptz)',
  'public.settle_rewards(uuid, timestamptz, timestamptz)', 'public.reward_settle_failed(uuid, timestamptz, timestamptz)',
  'public.settle_due_rewards_at(int, timestamptz)', 'public.purge_reward_audit()',
  'public.audit_trip_relabel()', 'public.upsert_score_day(uuid, jsonb)']::regprocedure[]);
select is((select count(*)::int from fn9 join pg_proc p on p.oid = fn9.f where not p.prosecdef and p.proconfig = array['search_path=public']), 30,
  'every other function 0009 creates or replaces is invoker, pinning exactly search_path=public');
select is((select count(*)::int from pg_proc p where p.oid in ('public.enqueue_reward_settlement()'::regprocedure, 'public.wake_reward_settlement()'::regprocedure)
    and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public']), 2,
  'the enqueue and wake triggers are definer, owned by postgres, pinning search_path (final review I1)');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.enqueue_reward_settlement()', 'public.wake_reward_settlement()']::regprocedure[]) f), false, 'and no API role executes them');
select is((select row(p.prokind, p.prosecdef, p.proconfig)::text from pg_proc p where p.oid = 'public.settle_due_rewards(int)'::regprocedure),
  row('p'::"char", false, null::text[])::text,
  'settle_due_rewards(int) is the one documented exception: a procedure, not definer, no proconfig (it COMMITs; the path is set per transaction)');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proconfig is null and p.prokind in ('f', 'p')
    and p.oid in (select f from fn9 union select 'public.settle_due_rewards(int)'::regprocedure union select 'public.open_my_week()'::regprocedure
                  union select 'public.set_weekly_focus(text)'::regprocedure union select 'public.minimise_underage_rewards()'::regprocedure)), 1,
  'of everything 0009 creates, only settle_due_rewards(int) runs without a pinned search_path');
select is((select count(*)::int from regexp_matches(pg_get_functiondef('public.settle_due_rewards(int)'::regprocedure),
    '(?<!for\s)\m(from|join|update)\s+(?!(public|pg_catalog)\.)[a-z_]', 'g')), 0, 'the procedure''s body names every table schema-qualified');
select is(array[has_function_privilege('authenticated', 'public.open_my_week()', 'execute'), has_function_privilege('authenticated', 'public.set_weekly_focus(text)', 'execute')],
  array[true, true], 'authenticated executes the two RPCs');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'service_role']) r,
    unnest(array['public.open_my_week()', 'public.set_weekly_focus(text)']::regprocedure[]) f), false, 'anon and the service role execute neither RPC');
select is((select bool_or(has_function_privilege(r, fn9.f, 'execute')) from fn9, unnest(array['anon', 'authenticated', 'service_role']) r
    where fn9.f <> 'public.upsert_score_day(uuid, jsonb)'::regprocedure), false,
  'no API role executes a settle step, helper, trigger function, settle_rewards or settle_due_rewards_at');
select is((select bool_or(has_function_privilege(r, 'public.settle_due_rewards(int)', 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r), false,
  'no API role executes the procedure');

-- catch-alls
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe9 (id int);
create function public.zz_probe9_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe9', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe9_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe9_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe9_fn();
drop table public.zz_probe9;
select is((select coalesce(array_agg(t.relname::text order by t.relname), '{}') from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relkind = 'r' and t.relname not in ('profiles', 'private_profiles')
      and (exists (select 1 from pg_constraint c where c.conrelid = t.oid and c.contype = 'f' and c.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'user_id' and not a.attisdropped))
      and not exists (select 1 from pg_proc p where p.oid in ('public.minimise_underage_account()'::regprocedure,
                        'public.minimise_underage_notifications()'::regprocedure, 'public.minimise_underage_rewards()'::regprocedure)
                      and p.prosrc ~ ('delete from public\.' || t.relname || ' where'))), '{}'::text[],
  'every user-referencing public table is deleted by the under-13 minimisation (0006, 0007 or 0009)');

-- M4's client-reach audit (T2 r4/r5): every function a client write can reach is executable by it
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
select is((select count(*)::int from pg_temp.client_reach('authenticated') where via = 'notification_prefs.notification_prefs_validate'), 1,
  'the audit is not vacuous');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.open_my_week() $$, '42501', null, 'anon cannot open a week');
select throws_ok($$ select public.set_weekly_focus('phone') $$, '42501', null, 'nor set a focus');
select throws_ok($$ select user_id from public.progress $$, '42501', null, 'nor read progress');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.open_my_week() $$, '42501', 'open_my_week requires an authenticated user', 'no JWT, no week');

-- D12: nothing in 0009 reads permissions, role_source or mode (with a planted case: the scan bites)
select is((select count(*)::int from fn9 where pg_get_functiondef(fn9.f) ~ '(permissions|role_source|\.mode\M)'), 0,
  'no 0009 function reads devices.permissions, trips.role_source or trips.mode (D12)');
create function public.zz_d12() returns text language sql as 'select t.mode from public.trips t limit 1';
select is((select count(*)::int from unnest(array['public.zz_d12()'::regprocedure]) f where pg_get_functiondef(f) ~ '(permissions|role_source|\.mode\M)'), 1,
  'the D12 scan catches a planted read of trips.mode');
drop function public.zz_d12();

-- the four reward notifications, the cron jobs
select lives_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key, push_state, push_reason) select pg_temp.u(2), t, '{}', 'type-' || t, 'skipped', 'inbox_only'
    from unnest(array['streak_milestone', 'goal_completed', 'level_up', 'referral_qualified']) t $$, 'inbox accepts the four reward types');
select throws_ok($$ insert into public.inbox (user_id, type, payload, dedupe_key) values (pg_temp.u(2), 'bogus', '{}', 'bogus') $$, '23514', null,
  'an unknown type is still refused');
delete from public.inbox where user_id = pg_temp.u(2);
select is((select row(schedule, command, username)::text from cron.job where jobname = 'settle-rewards'),
  row('*/5 * * * *', 'call public.settle_due_rewards(5000)', 'postgres')::text, 'settle-rewards calls the procedure every 5 minutes as postgres, up to 5000 users (the 4-minute budget bounds it)');
select is((select row(schedule, command)::text from cron.job where jobname = 'purge-reward-audit'),
  row('40 4 * * *', 'select public.purge_reward_audit()')::text, 'purge-reward-audit runs daily at 04:40');
select is(public.reward_rules() -> 'POINTS', '{"safeDay": 50, "goodDay": 20, "phoneFreeDay": 25, "cameraDay": 10, "weeklyGoal": 150, "referral": 500}'::jsonb,
  'reward_rules carries the D1 economy (the jest parity test compares all of it)');

-- ---------------------------------------------------------------------------
-- 2. trips_all (ruling T3 follow-up) and the watermark clamp
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(80);
select pg_temp.mkuser(81);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)',
  (jsonb_set(pg_temp.env(pg_temp.u(80), 'ta1', date '2026-06-01', 95), '{day,tripsAll}', '3'))::text));
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(81), 'ta2', date '2026-06-01', 95)::text));
select is(array[(select trips_all from public.score_daily where user_id = pg_temp.u(80)), (select trips_scored from public.score_daily where user_id = pg_temp.u(80))],
  array[3, 1], 'trips_all is stored from the aggregate''s tripsAll');
select is((select trips_all from public.score_daily where user_id = pg_temp.u(81)), 1, 'and, when an older build sends none, is tripsScored');
select throws_ok($$ update public.score_daily set trips_all = -1 where user_id = pg_temp.u(81) $$, '23514', null, 'trips_all is bounded');
select is((select row(prosecdef, proconfig)::text from pg_proc where oid = 'public.upsert_score_day(uuid, jsonb)'::regprocedure),
  row(false, array['search_path=public'])::text, 'upsert_score_day keeps its invoker flag and pinned path');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000001"}', true);
update public.devices set synced_through = now() + interval '1 day' where id = 'dev-1';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select synced_through from public.devices where id = 'dev-1'), now(), 'a client''s future synced_through is stored as now() (it can only delay)');

-- ---------------------------------------------------------------------------
-- 3. the day outcome table and predicates (O = 10, one day each, Los Angeles, June 2026)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(10);
select pg_temp.trip(pg_temp.u(10), date '2026-06-01', 95);           select pg_temp.day(pg_temp.u(10), date '2026-06-01', true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-02', 75);           select pg_temp.day(pg_temp.u(10), date '2026-06-02', false, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-03', 60);           select pg_temp.day(pg_temp.u(10), date '2026-06-03', false);
select pg_temp.day(pg_temp.u(10), date '2026-06-04', false, false, 0);
select pg_temp.trip(pg_temp.u(10), date '2026-06-05', 50);           select pg_temp.day(pg_temp.u(10), date '2026-06-05', false, false, 20, false, false, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-06', 92, 5);        select pg_temp.day(pg_temp.u(10), date '2026-06-06', false, false, 5);
select pg_temp.trip(pg_temp.u(10), date '2026-06-07', 92, 5, 'America/Los_Angeles', 'driver', true); select pg_temp.day(pg_temp.u(10), date '2026-06-07', false, false, 5);
select pg_temp.trip(pg_temp.u(10), date '2026-06-08', 50, 20, 'America/Los_Angeles', 'driver', false, '{}', true); select pg_temp.day(pg_temp.u(10), date '2026-06-08', false, false, 0);
select pg_temp.trip(pg_temp.u(10), date '2026-06-09', 95, 9);        select pg_temp.day(pg_temp.u(10), date '2026-06-09', false, false, 9, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-10', 95, 10);       select pg_temp.day(pg_temp.u(10), date '2026-06-10', true, false, 10, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-11', 95, 9);        select pg_temp.day(pg_temp.u(10), date '2026-06-11', false, false, 9, false, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-12', 95, 10);       select pg_temp.day(pg_temp.u(10), date '2026-06-12', true, false, 10, false, true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-13', 95);           select pg_temp.trip(pg_temp.u(10), date '2026-06-13', 0, 20, 'America/Los_Angeles', 'passenger', false, array['phone']);
select pg_temp.day(pg_temp.u(10), date '2026-06-13', true);
select pg_temp.trip(pg_temp.u(10), date '2026-06-14', 90, 20, 'America/Los_Angeles', 'driver', false, array['phone']); select pg_temp.day(pg_temp.u(10), date '2026-06-14', false);
select pg_temp.trip(pg_temp.u(10), date '2026-06-15', 90, 20, 'America/Los_Angeles', 'driver', false, array['braking']); select pg_temp.day(pg_temp.u(10), date '2026-06-15', false);
select is(array(select row(scored_all, avg_all::int, severe_all, phone, braking)::text from public.reward_day_facts(pg_temp.u(10), date '2026-06-13', date '2026-06-15', null) order by day),
  array[row(1, 95, 0, 0, 0)::text, row(1, 90, 0, 1, 0)::text, row(1, 90, 0, 0, 1)::text],
  'the facts count final driver drives and their scored events; a passenger''s trip and its phone event count for nothing');
select pg_temp.settle(pg_temp.u(10), pg_temp.late());
select is(array(select row(day, outcome, outcome_reason, tier, phone_free, camera, points)::text from public.reward_days where user_id = pg_temp.u(10) and day <= '2026-06-12' order by day),
  array[row(date '2026-06-01', 'safe', 'safe', 'safe', false, false, 50)::text,
        row(date '2026-06-02', 'unsafe', 'unsafe', 'good', false, false, 20)::text,
        row(date '2026-06-03', 'unsafe', 'unsafe', 'none', false, false, 0)::text,
        row(date '2026-06-04', 'neutral', 'no_drive', 'none', false, false, 0)::text, -- a genuine day without a drive stays no_drive
        row(date '2026-06-05', 'neutral', 'learning', 'none', false, false, 0)::text,
        row(date '2026-06-06', 'neutral', 'short', 'none', false, false, 0)::text,
        row(date '2026-06-07', 'unsafe', 'unsafe', 'none', false, false, 0)::text,
        row(date '2026-06-08', 'unsafe', 'unsafe', 'none', false, false, 0)::text,
        row(date '2026-06-09', 'neutral', 'short', 'none', false, false, 0)::text,
        row(date '2026-06-10', 'safe', 'safe', 'safe', true, false, 75)::text,
        row(date '2026-06-11', 'neutral', 'short', 'none', false, false, 0)::text,
        row(date '2026-06-12', 'safe', 'safe', 'safe', false, true, 60)::text],
  'safe; good (still a streak break); average 60; no scored drive; provisional; short; short with a severe event; a deleted 50 on an empty day; the 10-minute bonuses');
select is((select predicates from public.reward_days where user_id = pg_temp.u(10) and day = '2026-06-13'),
  '{"phone":"pass","speeding":"pass","braking":"pass","accel":"pass","cornering":"pass","smooth":"pass","safe":"pass"}'::jsonb,
  'a passenger''s scored phone event leaves the driver''s phone predicate passing');
select is((select predicates ->> 'phone' from public.reward_days where user_id = pg_temp.u(10) and day = '2026-06-14'), 'fail', 'a phone event fails phone');
select is((select array[predicates ->> 'braking', predicates ->> 'smooth', predicates ->> 'phone'] from public.reward_days where user_id = pg_temp.u(10) and day = '2026-06-15'),
  array['fail', 'fail', 'pass'], 'a braking event fails braking and smooth');
select is((select predicates from public.reward_days where user_id = pg_temp.u(10) and day = '2026-06-09'),
  '{"phone":"neutral","speeding":"neutral","braking":"neutral","accel":"neutral","cornering":"neutral","smooth":"neutral","safe":"neutral"}'::jsonb,
  'nine clean minutes are neutral everywhere');
select is((select predicates from public.reward_days where user_id = pg_temp.u(10) and day = '2026-06-04'),
  '{"phone":"neutral","speeding":"neutral","braking":"neutral","accel":"neutral","cornering":"neutral","smooth":"neutral","safe":"neutral"}'::jsonb,
  'a day with no scored drive is neutral everywhere');
select throws_ok($$ insert into public.reward_days (user_id, day, outcome, outcome_reason, tier, phone_free, camera, predicates, points, wall_close, settled_at, source_updated_at, checked_through)
    values (pg_temp.u(10), '2026-07-01', 'safe', 'safe', 'safe', false, false, '{"phone":"pass"}', 50, now(), now(), now(), now()) $$, '23514', null,
  'reward_days refuses a predicates object without all seven keys');

-- ---------------------------------------------------------------------------
-- 4. the ledger (L = 11): exactly two rows, idempotent under replays and races
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(11);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(11), 'l1', date '2026-06-01', 95, 20, true, true)::text));
select pg_temp.settle(pg_temp.u(11), pg_temp.late());
select is(array(select row(type, amount, balance_after, idempotency_key)::text from public.points_ledger where user_id = pg_temp.u(11) and ref_key = '2026-06-01'
    and type <> 'weekly_goal' order by balance_after),
  array[row('safe_day', 50, 50, 'day:2026-06-01:tier')::text, row('phone_free_day', 25, 75, 'day:2026-06-01:phone_free')::text],
  'a safe phone-free day settles to exactly two rows, 50 then 25, with balances 50 then 75');
select is((pg_temp.settle(pg_temp.u(11), pg_temp.late()) ->> 'ledgerRows')::int, 0, 'settling again adds nothing');
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(11), 'l1', date '2026-06-01', 95, 20, true, true)::text));
select is((pg_temp.settle(pg_temp.u(11), pg_temp.late()) ->> 'ledgerRows')::int, 0, 'replaying apply_trip for that day adds nothing');
select is((select count(*)::int from public.points_ledger where amount <= 0), 0, 'no ledger row anywhere is zero or negative');
select throws_ok($$ insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key)
    values (pg_temp.u(11), 'safe_day', -5, 'x', 0, 'neg') $$, '23514', null, 'a negative amount is refused');

-- ---------------------------------------------------------------------------
-- 5. finality (R-A): after settlement nothing changes the reward result (A = 1)
-- ---------------------------------------------------------------------------
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(1), 'a1', date '2026-06-01', 60, 20, false)::text));
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is((select row(outcome, tier, points)::text from public.reward_days where user_id = pg_temp.u(1) and day = '2026-06-01'), row('unsafe', 'none', 0)::text,
  'A''s bad day settles unsafe');
create temp table snapA as select pg_temp.snap(pg_temp.u(1)) as s, pg_temp.contra(pg_temp.u(1)) as c;
create function pg_temp.a_trip(p_client text) returns uuid language sql as $$
  select id from public.trips where user_id = pg_temp.u(1) and client_trip_id = p_client
$$;
create function pg_temp.scored(p_score int) returns jsonb language sql immutable as $$
  select jsonb_build_object('score', p_score, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A', 'scoringVersion', 1,
    'categoryDeductions', '{"phone":0,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb)
$$;
-- (i) an accepted dispute's recompute makes score_daily safe
select pg_temp.as_service(format('select public.apply_recompute(%L, %L, %L::jsonb, %L::jsonb, %L::jsonb, null)', pg_temp.u(1), pg_temp.a_trip('a1'),
  pg_temp.scored(95), '[]', pg_temp.dayrow(date '2026-06-01', true)));
select pg_temp.bump(pg_temp.u(1), 1);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(pg_temp.snap(pg_temp.u(1)), (select s from snapA), '(i) a dispute recompute after settlement changes nothing settled');
select is(pg_temp.contra(pg_temp.u(1)), (select c from snapA) + 1, 'and writes exactly one changed_after_settlement row');
select is((select detail from public.reward_contradictions where user_id = pg_temp.u(1) and kind = 'changed_after_settlement'),
  '{"settled":{"outcome":"unsafe","tier":"none","phoneFree":false,"camera":false},"now":{"outcome":"safe","tier":"safe","scoredAll":1,"severeAll":0,"provisional":false,"phoneFree":false,"camera":false}}'::jsonb,
  'the contradiction records the settled result and the facts now (outcomes and counts, no place)');
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(pg_temp.contra(pg_temp.u(1)), (select c from snapA) + 1, 'a replayed settlement writes no second row');
-- (ii) a passenger answer on its bad drive
select pg_temp.as_service(format('select public.set_trip_role_row(%L, %L, %L)', pg_temp.u(1), pg_temp.a_trip('a1'), 'passenger'));
select pg_temp.as_service(format('select public.apply_recompute(%L, %L, null, null, %L::jsonb, null)', pg_temp.u(1), pg_temp.a_trip('a1'),
  pg_temp.dayrow(date '2026-06-01', false)));
select pg_temp.bump(pg_temp.u(1), 2);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(array[pg_temp.snap(pg_temp.u(1)) = (select s from snapA), pg_temp.contra(pg_temp.u(1)) = (select c from snapA) + 2], array[true, true],
  '(ii) a passenger answer after settlement changes nothing settled, one more row');
-- (iii) a soft delete
select pg_temp.as_service(format('select public.soft_delete_trip(%L, %L)', pg_temp.u(1), pg_temp.a_trip('a1')));
select pg_temp.as_service(format('select public.apply_recompute(%L, %L, null, null, %L::jsonb, null)', pg_temp.u(1), pg_temp.a_trip('a1'),
  pg_temp.dayrow(date '2026-06-01', true)));
select pg_temp.bump(pg_temp.u(1), 3);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(array[pg_temp.snap(pg_temp.u(1)) = (select s from snapA), pg_temp.contra(pg_temp.u(1)) = (select c from snapA) + 3], array[true, true],
  '(iii) a soft delete after settlement changes nothing settled, one more row (the day would now settle to another result)');
-- (iv) a late upload of a safe drive
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(1), 'a2', date '2026-06-01', 98, 30, true)::text));
select pg_temp.bump(pg_temp.u(1), 4);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(array[pg_temp.snap(pg_temp.u(1)) = (select s from snapA), pg_temp.contra(pg_temp.u(1)) = (select c from snapA) + 3], array[true, true],
  '(iv) a late safe upload after settlement changes nothing settled, and (final review m1) records no second row for the safe result (i) already recorded');
-- (final review m1) a rewrite that leaves the day's result as settled records nothing
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(1), 'a5', date '2026-06-01', 40, 20, false)::text));
select pg_temp.bump(pg_temp.u(1), 6);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(array[(select (outcome, tier)::text from public.reward_days where user_id = pg_temp.u(1) and day = '2026-06-01'),
    (pg_temp.contra(pg_temp.u(1)) - (select c from snapA))::text], array[row('unsafe', 'none')::text, '3'],
  'a late unsafe drive puts the day back to the settled unsafe result: no row');
-- the mirror: settled safe, then a late unsafe drive
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(1), 'a3', date '2026-06-02', 95, 20, true)::text));
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
create temp table snapA2 as select pg_temp.snap(pg_temp.u(1)) as s, pg_temp.contra(pg_temp.u(1)) as c;
select is((select row(outcome, points)::text from public.reward_days where user_id = pg_temp.u(1) and day = '2026-06-02'), row('safe', 50)::text, 'a safe day settles safe');
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(1), 'a4', date '2026-06-02', 40, 20, false)::text));
select pg_temp.bump(pg_temp.u(1), 5);
select pg_temp.settle(pg_temp.u(1), pg_temp.late());
select is(array[pg_temp.snap(pg_temp.u(1)) = (select s from snapA2), pg_temp.contra(pg_temp.u(1)) = (select c from snapA2) + 1], array[true, true],
  'a late unsafe drive after a safe day settled changes nothing settled either, one row');
select is((select count(*)::int from public.reward_contradictions where user_id = pg_temp.u(1) and kind = 'changed_after_settlement'
    and (detail -> 'settled') = jsonb_build_object('outcome', detail -> 'now' ->> 'outcome', 'tier', detail -> 'now' ->> 'tier',
      'phoneFree', (detail -> 'now' -> 'phoneFree'), 'camera', (detail -> 'now' -> 'camera'))), 0,
  'no changed_after_settlement row records a result equal to the settled one');
-- (final review m7) a late change that moves only a bonus is recorded
select pg_temp.mkuser(29);
select pg_temp.drove(pg_temp.u(29), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(29), pg_temp.late());
set local session_replication_role = replica;
update public.score_daily set updated_at = now() - interval '30 days' where user_id = pg_temp.u(29);
set local session_replication_role = origin;
update public.score_daily set phone_free_day = false where user_id = pg_temp.u(29) and day = '2026-06-01';
select pg_temp.bump(pg_temp.u(29), 1);
select pg_temp.settle(pg_temp.u(29), pg_temp.late());
select is((select row(dedupe_key, detail -> 'settled' -> 'phoneFree', detail -> 'now' -> 'phoneFree')::text from public.reward_contradictions
    where user_id = pg_temp.u(29) and kind = 'changed_after_settlement'),
  row('changed:2026-06-01:safe:safe:false:false', 'true'::jsonb, 'false'::jsonb)::text,
  'a late change that moves only the phone-free bonus (outcome and tier as settled) is recorded, keyed by the bonus');
select throws_ok($$ update public.reward_days set tier = 'safe' where user_id = pg_temp.u(1) and day = '2026-06-01' $$, '42501', 'settled days are final',
  'a direct change of a settled day is refused, even as postgres');
select throws_ok($$ update public.reward_days set streak_after = 9 where user_id = pg_temp.u(1) and day = '2026-06-01' $$, '42501', 'settled days are final',
  'so is a change of a written streak_after');
select lives_ok($$ update public.reward_days set checked_through = now() + interval '1 day' where user_id = pg_temp.u(1) and day = '2026-06-01' $$,
  'only the bookkeeping moves');
-- before settlement the answer counts: a passenger answer on the day's only bad drive
select pg_temp.mkuser(12);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(12), 'x1', date '2026-06-03', 55, 20, false)::text));
select pg_temp.as_service(format('select public.set_trip_role_row(%L, %L, %L)', pg_temp.u(12),
  (select id from public.trips where user_id = pg_temp.u(12)), 'passenger'));
select pg_temp.settle(pg_temp.u(12), pg_temp.late());
select is((select row(outcome, outcome_reason)::text from public.reward_days where user_id = pg_temp.u(12) and day = '2026-06-03'), row('neutral', 'no_drive')::text,
  'before settlement, a passenger answer on the only bad drive makes the day settle per the new facts');

-- ---------------------------------------------------------------------------
-- 6. the relabel audit (R = 13)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(13);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(13), 'r1', date '2026-06-01', 80, 20, false, false, 1)::text));
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(13), 'r2', date '2026-06-02', 80, 20, false, false, 1)::text));
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(13), 'r3', date '2026-06-03', 80, 20, false)::text));
select pg_temp.as_service(format('select public.set_trip_role_row(%L, %L, %L)', pg_temp.u(13),
  (select id from public.trips where user_id = pg_temp.u(13) and client_trip_id = 'r1'), 'passenger'));
select pg_temp.settle(pg_temp.u(13), pg_temp.late());
select pg_temp.as_service(format('select public.set_trip_role_row(%L, %L, %L)', pg_temp.u(13),
  (select id from public.trips where user_id = pg_temp.u(13) and client_trip_id = 'r2'), 'passenger'));
select pg_temp.as_service(format('select public.set_trip_role_row(%L, %L, %L)', pg_temp.u(13),
  (select id from public.trips where user_id = pg_temp.u(13) and client_trip_id = 'r3'), 'passenger'));
select is(array(select row(c.day, c.detail - 'tripId' - 'firstAt' - 'lastAt')::text from public.reward_contradictions c where c.user_id = pg_temp.u(13) and c.kind = 'relabel_with_events' order by c.day),
  array[row(date '2026-06-01', '{"from":"driver","to":"passenger","daySettled":false,"count":1}'::jsonb)::text,
        row(date '2026-06-02', '{"from":"driver","to":"passenger","daySettled":true,"count":1}'::jsonb)::text],
  'a relabel of a drive with scored events is audited before and after settlement; a drive with no scored events is not');

-- ---------------------------------------------------------------------------
-- 7. a late day behind the frontier (rev2: I-A; I = 14)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(14);
select pg_temp.drove(pg_temp.u(14), d::date, true) from generate_series(date '2026-06-01', date '2026-06-10', interval '1 day') d where d::date <> date '2026-06-05';
select pg_temp.settle(pg_temp.u(14), pg_temp.late());
select is((select settled_through from public.progress where user_id = pg_temp.u(14)), date '2026-06-10', 'I is settled through day 10');
create temp table snapI as select pg_temp.snap(pg_temp.u(14)) as s;
select pg_temp.trip(pg_temp.u(14), date '2026-06-05', 40);
select pg_temp.day(pg_temp.u(14), date '2026-06-05', false);
select pg_temp.settle(pg_temp.u(14), pg_temp.late());
select is((select row(outcome, outcome_reason, tier, points, streak_after, predicates ->> 'safe')::text from public.reward_days where user_id = pg_temp.u(14) and day = '2026-06-05'),
  row('neutral', 'late', 'none', 0, 9, 'neutral')::text, 'the late day gets a frozen neutral no-value row, reason late');
select is((select row(count(*), bool_and((detail ->> 'late_day')::boolean))::text from public.reward_contradictions where user_id = pg_temp.u(14)), row(1, true)::text,
  'and one late_day contradiction');
select is(pg_temp.snap(pg_temp.u(14)) - 'days', (select s from snapI) - 'days', 'the streak, points and goals are unchanged');
select is((select jsonb_agg(to_jsonb(r) - 'checked_through' - 'updated_at' order by r.day) from public.reward_days r where r.user_id = pg_temp.u(14) and r.day <> '2026-06-05'),
  (select s -> 'days' from snapI), 'every other settled day is unchanged');
select pg_temp.drove(pg_temp.u(14), date '2026-06-11', true);
select pg_temp.settle(pg_temp.u(14), pg_temp.la_close(date '2026-06-11') + interval '1 minute');
select is((select row(outcome, streak_after)::text from public.reward_days where user_id = pg_temp.u(14) and day = '2026-06-11'), row('safe', 10)::text,
  'day 11 still settles on time, and the streak goes on from 9');
select is((pg_temp.settle(pg_temp.u(14), pg_temp.late()) - 'events'), '{"settledDays":0,"ledgerRows":0,"contradictions":0}'::jsonb, 'a second run writes nothing more');

-- ---------------------------------------------------------------------------
-- 8. the property test (R-A): 60 random late inputs never change settled history (P = 15)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(15);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(15), 'p' || i, date '2026-05-31' + i,
    (array[95, 90, 60, 95, 88, 50, 97])[i % 7 + 1], 20, (array[95, 90, 60, 95, 88, 50, 97])[i % 7 + 1] >= 85, (array[95, 90, 60, 95, 88, 50, 97])[i % 7 + 1] >= 90)::text))
  from generate_series(1, 30) i where i % 7 <> 3;
select pg_temp.settle(pg_temp.u(15), pg_temp.late());
-- P's rows were written in this transaction (updated_at = now()); set them back so a later input's
-- rewrite (the touch trigger's now()) is the only thing bump() re-stamps
set local session_replication_role = replica;
update public.score_daily set updated_at = now() - interval '30 days' where user_id = pg_temp.u(15);
set local session_replication_role = origin;
create temp table snapP as select pg_temp.snap(pg_temp.u(15)) as s, pg_temp.contra(pg_temp.u(15)) as c,
  (select array_agg(day order by day) from public.reward_days where user_id = pg_temp.u(15)) as days;
create temp table prop (i int, kind int, changed boolean, key text);
do $$
declare
  v_user uuid := pg_temp.u(15);
  v_day date;
  v_kind int;
  v_trip uuid;
  v_role text;
  v_gap date;
  v_changed boolean;
  v_key text;
  f public.reward_fact;
  v_o text;
  v_t text;
  v_pf boolean;
  v_cam boolean;
  v_rd record;
begin
  perform setseed(0.5);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for i in 1 .. 60 loop
    v_day := (select days from snapP)[1 + floor(random() * cardinality((select days from snapP)))::int];
    v_kind := 1 + floor(random() * 6)::int;
    select t.id, t.role into v_trip, v_role from public.trips t
      where t.user_id = v_user and t.local_day = v_day and t.deleted_at is null order by t.client_trip_id limit 1;
    if v_kind in (1, 2, 3) and v_trip is null then
      v_kind := 4;
    end if;
    if v_kind = 1 and v_role <> 'driver' then
      v_kind := 5;
    end if;
    if v_kind = 6 then
      select g::date into v_gap from generate_series(date '2026-06-01', date '2026-06-30', interval '1 day') g
        where not exists (select 1 from public.score_daily sd where sd.user_id = v_user and sd.day = g::date) order by g limit 1;
      if v_gap is null then
        v_kind := 5;
      end if;
    end if;
    case v_kind
      when 1 then
        perform public.apply_recompute(v_user, v_trip, pg_temp.scored((40 + floor(random() * 60))::int), '[]', pg_temp.dayrow(v_day, random() < 0.5), null);
      when 2 then
        perform public.set_trip_role_row(v_user, v_trip, case when v_role = 'driver' then 'passenger' else 'driver' end);
        perform public.apply_recompute(v_user, v_trip, null, null, pg_temp.dayrow(v_day, random() < 0.5), null);
      when 3 then
        perform public.soft_delete_trip(v_user, v_trip);
        perform public.apply_recompute(v_user, v_trip, null, null, pg_temp.dayrow(v_day, false), null);
      when 4 then
        perform public.apply_trip(pg_temp.env(v_user, 'late' || i, v_day, (40 + floor(random() * 60))::int, 20));
      when 5 then
        update public.score_daily set safe_day = not safe_day where user_id = v_user and day = v_day;
      else
        insert into public.score_daily (user_id, day, provisional, safe_day, good_day, phone_free_day, camera_day, exposure, driving_s, trips_scored, severe_events)
          values (v_user, v_gap, false, true, false, false, false, 1, 1200, 1, 0);
    end case;
    v_changed := pg_temp.bump(v_user, i) > 0;
    perform public.settle_rewards(v_user, pg_temp.late());
    -- the oracle (final review m1): a new gap day is frozen with one row; a changed settled day records a
    -- row only when it would now settle to another outcome or tier, once per (day, outcome, tier)
    v_key := null;
    if v_changed and v_kind = 6 then
      v_key := 'gap:' || v_gap;
    elsif v_changed then
      select * into f from public.reward_day_facts(v_user, v_day, v_day, 'America/Los_Angeles');
      select o.outcome into v_o from public.reward_outcome(f) o;
      v_t := public.reward_tier(f);
      v_pf := f.phone_free_day and f.driving_s >= 600;
      v_cam := f.camera_day and f.driving_s >= 600;
      select rd.outcome, rd.tier, rd.phone_free, rd.camera, rd.outcome_reason into v_rd from public.reward_days rd where rd.user_id = v_user and rd.day = v_day;
      if v_rd.outcome_reason = 'zone_hop' then
        v_t := 'none';
        v_pf := false;
        v_cam := false;
        if v_o <> 'unsafe' then v_o := 'neutral'; end if;
      end if;
      if (v_o, v_t, v_pf, v_cam) is distinct from (v_rd.outcome, v_rd.tier, v_rd.phone_free, v_rd.camera) then
        v_key := v_day || ':' || v_o || ':' || v_t || ':' || v_pf || ':' || v_cam;
      end if;
    end if;
    insert into prop values (i, v_kind, v_changed, v_key);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;
select is((select count(distinct kind)::int from prop), 6, 'the 60 inputs cover all six kinds');
select is((select jsonb_build_object('days', (select jsonb_agg(to_jsonb(r) - 'checked_through' - 'updated_at' order by r.day) from public.reward_days r
      where r.user_id = pg_temp.u(15) and r.day in (select unnest(days) from snapP)))
    || (pg_temp.snap(pg_temp.u(15)) - 'days')), (select s from snapP),
  'after 60 random late inputs every settled day, the ledger, progress and the goals are unchanged');
select is(pg_temp.contra(pg_temp.u(15)) - (select c from snapP), (select count(distinct key)::int from prop),
  'and the contradictions grew by exactly the distinct results (outcome, tier, bonuses) the changed days would now settle to (final review m1, m7)');
select ok((select count(distinct key) from prop) < (select count(*) from prop where changed),
  'which is fewer than the inputs that rewrote a score_daily row (rewrites that change nothing record nothing)');

-- ---------------------------------------------------------------------------
-- 9. wall close, zone hop, stale profile zone
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(16);
select pg_temp.drove(pg_temp.u(16), date '2026-06-01', true);
select is(array[public.reward_day_ready(pg_temp.u(16), pg_temp.la_close(date '2026-06-01'), timestamptz '2026-06-02 01:59:00 America/Los_Angeles'),
                public.reward_day_ready(pg_temp.u(16), pg_temp.la_close(date '2026-06-01'), timestamptz '2026-06-02 02:00:00 America/Los_Angeles')],
  array[false, true], 'a Los Angeles day is not ready at 01:59 PDT the next morning and is at 02:00');
select is(array[public.reward_wall_close(date '2026-03-07', array['America/Los_Angeles']), public.reward_wall_close(date '2026-10-31', array['America/Los_Angeles'])],
  array[timestamptz '2026-03-08 10:00+00', timestamptz '2026-11-01 10:00+00'],
  'the day before spring-forward closes at 03:00 PDT and the day before fall-back at 02:00 PST: both 10:00 UTC');
select is(public.reward_wall_close(date '2026-06-01', array['America/Los_Angeles', 'Pacific/Honolulu']), timestamptz '2026-06-02 12:00+00',
  'a day with a Los Angeles and a Honolulu drive closes at the Honolulu 02:00');
select is(public.reward_wall_close(date '2026-06-01', array['Not/AZone', 'America/Los_Angeles']), timestamptz '2026-06-02 09:00+00',
  'a zone Postgres rejects is skipped, never raised');
select pg_temp.mkuser(17);
insert into public.notification_prefs (user_id, tz) values (pg_temp.u(17), 'Europe/Paris');
select pg_temp.drove(pg_temp.u(17), date '2026-06-01', true);
select is((select wall_close from public.reward_day_facts(pg_temp.u(17), date '2026-06-01', date '2026-06-01', public.user_tz(pg_temp.u(17)))),
  pg_temp.la_close(date '2026-06-01'), 'a Paris profile zone does not close a Los Angeles-keyed day before the Los Angeles 02:00');
select is(public.reward_day_ready(pg_temp.u(16), public.reward_wall_close((now() at time zone 'America/Los_Angeles')::date, array['America/Los_Angeles']), now()),
  false, 'today is never ready');
-- zone hop (R-B): closes 18 h apart (Pago Pago on day 1, Chicago on day 2)
select pg_temp.mkuser(18);
select pg_temp.drove(pg_temp.u(18), date '2026-06-01', true, 'Pacific/Pago_Pago');
select pg_temp.drove(pg_temp.u(18), date '2026-06-02', true, 'America/Chicago');
select pg_temp.settle(pg_temp.u(18), pg_temp.late());
select is(array(select row(day, wall_close, outcome, outcome_reason, tier, phone_free, points, jsonb_path_exists(predicates, '$.* ? (@ == "pass")'))::text
    from public.reward_days where user_id = pg_temp.u(18) order by day),
  array[row(date '2026-06-01', timestamptz '2026-06-02 13:00+00', 'safe', 'safe', 'safe', true, 75, true)::text,
        row(date '2026-06-02', timestamptz '2026-06-03 07:00+00', 'neutral', 'zone_hop', 'none', false, 0, false)::text],
  'two safe days whose closes are 18 h apart: the later settles without earning');
select is((select count(*)::int from public.reward_contradictions where user_id = pg_temp.u(18) and kind = 'zone_hop'), 1, 'with one zone_hop contradiction');
select pg_temp.mkuser(19);
select pg_temp.drove(pg_temp.u(19), date '2026-06-01', true, 'Pacific/Pago_Pago');
select pg_temp.drove(pg_temp.u(19), date '2026-06-02', false, 'America/Chicago');
select pg_temp.settle(pg_temp.u(19), pg_temp.late());
select is((select row(outcome, tier)::text from public.reward_days where user_id = pg_temp.u(19) and day = '2026-06-02'), row('unsafe', 'none')::text,
  'the guard only costs: the later day unsafe stays unsafe');
select is((select array_agg(points order by day) from public.reward_days where user_id = pg_temp.u(10) and day in ('2026-06-01', '2026-06-02')), array[50, 20],
  'two ordinary consecutive days (about 24 h apart) both earn');
-- stale profile zone (rev2: m2): the profile zone is 6 h west of the drives' zone
select pg_temp.mkuser(20);
insert into public.notification_prefs (user_id, tz) values (pg_temp.u(20), 'Pacific/Honolulu');
select pg_temp.drove(pg_temp.u(20), date '2026-06-01', true, 'America/New_York');
select pg_temp.drove(pg_temp.u(20), date '2026-06-02', true, 'America/New_York');
select pg_temp.settle(pg_temp.u(20), pg_temp.late());
select is((select array_agg(tier order by day) from public.reward_days where user_id = pg_temp.u(20)), array['safe', 'safe'],
  'a stale profile zone 6 h west never enters a driven day''s close, so both days earn');

-- ---------------------------------------------------------------------------
-- 10. the sync watermark (R-A); every day is 2026-06-01 in Los Angeles, close C = 2026-06-02 09:00 UTC
-- ---------------------------------------------------------------------------
create function pg_temp.c() returns timestamptz language sql immutable as $$ select timestamptz '2026-06-02 09:00+00' $$;
select pg_temp.mkuser(n) from generate_series(21, 27) n;
select pg_temp.drove(pg_temp.u(n), date '2026-06-01', true) from generate_series(21, 26) n;
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values
  ('w21', pg_temp.u(21), 'ios', pg_temp.c() - interval '1 hour', pg_temp.c() - interval '1 hour'),
  ('w22', pg_temp.u(22), 'ios', pg_temp.c() - interval '1 hour', pg_temp.c() - interval '1 hour'),
  ('w23', pg_temp.u(23), 'ios', pg_temp.c() - interval '1 hour', pg_temp.c() - interval '1 hour'),
  ('w24', pg_temp.u(24), 'ios', null, pg_temp.c() - interval '15 days');
update public.devices set signed_out_at = pg_temp.c() - interval '2 hours' where id = 'w23';
select pg_temp.settle(pg_temp.u(21), pg_temp.c() + interval '1 hour');
select is(array[(select count(*)::int from public.reward_days where user_id = pg_temp.u(21)),
    (select extract(epoch from due_at - pg_temp.c())::int from public.reward_due where user_id = pg_temp.u(21))],
  array[0, 259200], 'a device synced before the close holds the day at close + 1 h, and reward_due moves to close + 72 h, not an hourly poll (final review I1)');
-- the wake (final review I1): queued in real time (a day after now), a moved watermark brings the owner to now
update public.reward_due set due_at = now() + interval '1 day' where user_id = pg_temp.u(21);
update public.devices set last_seen_at = pg_temp.c() where id = 'w21';
select is((select due_at from public.reward_due where user_id = pg_temp.u(21)), now() + interval '1 day', 'a device write that moves no watermark wakes nothing');
update public.devices set synced_through = pg_temp.c() + interval '30 minutes' where id = 'w21';
select is((select due_at from public.reward_due where user_id = pg_temp.u(21)), now(), 'a moved watermark wakes the owner''s queued settlement to now');
select pg_temp.settle(pg_temp.u(21), pg_temp.c() + interval '2 hours');
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(21)), 1, 'once the watermark passes the close the day settles on the next run');
select pg_temp.settle(pg_temp.u(22), pg_temp.c() + interval '72 hours' - interval '1 second');
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(22)), 0, 'a watermark that never advances holds the day until the cap');
select pg_temp.settle(pg_temp.u(22), pg_temp.c() + interval '72 hours');
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(22)), 1, 'and it settles at exactly close + 72 h');
select pg_temp.settle(pg_temp.u(23), pg_temp.c() + interval '1 minute');
select pg_temp.settle(pg_temp.u(24), pg_temp.c() + interval '1 minute');
select is(array[(select count(*)::int from public.reward_days where user_id = pg_temp.u(23)), (select count(*)::int from public.reward_days where user_id = pg_temp.u(24))],
  array[1, 1], 'a signed-out device, or one last seen 15 days ago, does not hold a day');
create temp table snapW as select pg_temp.snap(pg_temp.u(23)) as s;
-- the wake on a sign-out and on a removed phone; a user with nothing queued gets no row
select pg_temp.mkuser(28);
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values ('w28', pg_temp.u(28), 'ios', pg_temp.c(), pg_temp.c()),
  ('w28b', pg_temp.u(28), 'android', pg_temp.c(), pg_temp.c());
update public.devices set synced_through = pg_temp.c() + interval '1 minute' where id = 'w28';
select is((select count(*)::int from public.reward_due where user_id = pg_temp.u(28)), 0, 'a wake with nothing queued creates no queue row');
insert into public.reward_due (user_id, due_at) values (pg_temp.u(28), now() + interval '1 day');
update public.devices set signed_out_at = now() where id = 'w28';
select is((select due_at from public.reward_due where user_id = pg_temp.u(28)), now(), 'a sign-out wakes the owner');
update public.reward_due set due_at = now() + interval '1 day' where user_id = pg_temp.u(28);
delete from public.devices where id = 'w28b';
select is((select due_at from public.reward_due where user_id = pg_temp.u(28)), now(), 'so does a removed phone');
-- I-B holds: a wake during a leased settlement is kept by the lease's compare-and-set
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values ('w28c', pg_temp.u(28), 'ios', pg_temp.c(), pg_temp.c());
update public.reward_due set due_at = now() + interval '10 minutes' where user_id = pg_temp.u(28);
update public.devices set synced_through = pg_temp.c() + interval '2 minutes' where id = 'w28c';
select public.settle_rewards(pg_temp.u(28), now(), now() + interval '10 minutes');
select is((select due_at from public.reward_due where user_id = pg_temp.u(28)), now(),
  'a wake during a lease survives the leased settlement (nothing owed, yet the row is kept at now: rev2 I-B)');
update public.devices set signed_out_at = null where id = 'w23';
select pg_temp.settle(pg_temp.u(23), pg_temp.c() + interval '2 minutes');
select is(pg_temp.snap(pg_temp.u(23)), (select s from snapW), 're-enrolling that device after the day settled changes nothing (rev2: m1b)');
select pg_temp.settle(pg_temp.u(25), pg_temp.c());
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(25)), 1, 'a user with no device settles at the wall close');
select is(public.reward_day_ready(pg_temp.u(21), pg_temp.c(), pg_temp.c() - interval '1 second'), false,
  'no watermark can settle a day before its wall close');
-- strict order: a later day whose close has passed waits for a held earlier day
select pg_temp.drove(pg_temp.u(27), date '2026-06-01', true, 'Pacific/Pago_Pago');
select pg_temp.drove(pg_temp.u(27), date '2026-06-02', true, 'Pacific/Kiritimati');
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values
  ('w27', pg_temp.u(27), 'ios', timestamptz '2026-06-02 12:30+00', timestamptz '2026-06-02 12:30+00');
select pg_temp.settle(pg_temp.u(27), timestamptz '2026-06-02 12:45+00');
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(27)), 0,
  'days settle in order: a later day already past its close and its watermark waits for the earlier day');

-- ---------------------------------------------------------------------------
-- 11. the append-only streak (§R4): S safe, U unsafe, N a day with no drive, L learning
-- ---------------------------------------------------------------------------
create function pg_temp.vector(p_n int, p_pattern text) returns uuid language plpgsql as $$
declare
  v_user uuid := pg_temp.mkuser(p_n);
  v_day date;
begin
  for i in 1 .. char_length(p_pattern) loop
    v_day := date '2026-05-31' + i;
    case substr(p_pattern, i, 1)
      when 'S' then perform pg_temp.drove(v_user, v_day, true);
      when 'U' then perform pg_temp.drove(v_user, v_day, false);
      when 'N' then perform pg_temp.day(v_user, v_day, false, false, 0);
      else perform pg_temp.trip(v_user, v_day, 50); perform pg_temp.day(v_user, v_day, false, false, 20, false, false, true);
    end case;
  end loop;
  perform pg_temp.settle(v_user, pg_temp.late());
  return v_user;
end $$;
create function pg_temp.streak(p_user uuid) returns text language sql as $$
  select row(streak_days, best_streak, shields)::text from public.progress where user_id = p_user
$$;
select is(pg_temp.streak(pg_temp.vector(30, 'SSS')), row(3, 3, 0)::text, 'S S S: streak 3');
select is(pg_temp.streak(pg_temp.vector(31, 'SSU')), row(0, 2, 0)::text, 'S S U: streak 0, best 2');
select is(pg_temp.streak(pg_temp.vector(32, repeat('S', 14))), row(14, 14, 1)::text, '14 safe days: one shield');
select is(pg_temp.streak(pg_temp.vector(33, repeat('S', 28))), row(28, 28, 2)::text, '28: two shields');
select is(pg_temp.streak(pg_temp.vector(34, repeat('S', 42))), row(42, 42, 2)::text, '42: still two');
select is(pg_temp.streak(pg_temp.vector(35, repeat('S', 14) || 'U')), row(14, 14, 0)::text, '14 then an unsafe day: the shield is spent, the streak stands');
select is(pg_temp.streak(pg_temp.vector(36, 'SNS')), row(2, 2, 0)::text, 'a day with no drive between safe days changes nothing');
select is(pg_temp.streak(pg_temp.vector(37, 'SLS')), row(2, 2, 0)::text, 'a learning day does not break the streak');
select pg_temp.vector(38, 'SSUSN');
select is((select array_agg(streak_after order by day) from public.reward_days where user_id = pg_temp.u(38)), array[1, 2, 0, 1, 1],
  'each settled day stores its streak_after');
select is((select array_agg(payload order by (payload ->> 'days')::int) from public.inbox where user_id = pg_temp.u(32) and type = 'streak_milestone'),
  array['{"days": 7, "reachedOn": "2026-06-07"}'::jsonb, '{"days": 14, "reachedOn": "2026-06-14"}'::jsonb],
  'milestone rows at 7 and 14, each payload exactly { days, reachedOn } (the catalog''s schema)');
select pg_temp.settle(pg_temp.u(32), pg_temp.late());
select is((select count(*)::int from public.inbox where user_id = pg_temp.u(32) and type = 'streak_milestone'), 2, 'and never twice');

-- ---------------------------------------------------------------------------
-- 12. the weekly goal (§R5); the week of Monday 2026-06-01
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(n) from generate_series(40, 49) n;
select pg_temp.trip(pg_temp.u(40), date '2026-06-01', 80);
update public.trips set category_deductions = '{"phone":2,"speeding":10,"braking":1}' where user_id = pg_temp.u(40);
select pg_temp.trip(pg_temp.u(41), date '2026-06-01', 80);
update public.trips set category_deductions = '{"phone":5,"speeding":5}' where user_id = pg_temp.u(41);
select is(array[public.weakest_goal_category(pg_temp.u(40), date '2026-06-15'), public.weakest_goal_category(pg_temp.u(41), date '2026-06-15'),
                public.weakest_goal_category(pg_temp.u(42), date '2026-06-15')],
  array['speeding', 'phone', 'phone'], 'the costliest category; a phone/speeding tie goes to phone; nothing lost is phone');
-- 43: four phone-clean days by Thursday
select pg_temp.drove(pg_temp.u(43), d::date, true) from generate_series(date '2026-06-01', date '2026-06-04', interval '1 day') d;
select pg_temp.settle(pg_temp.u(43), pg_temp.la_close(date '2026-06-04') + interval '1 minute');
select is((select row(category, source, pass_days, fail_days, state, prorated)::text from public.weekly_goals where user_id = pg_temp.u(43)),
  row('phone', 'weakest', 4, 0, 'achieved', false)::text, 'four passing days achieve the goal before the week ends');
select is((select row(amount, idempotency_key)::text from public.points_ledger where user_id = pg_temp.u(43) and type = 'weekly_goal'),
  row(150, 'goal:2026-06-01')::text, '+150 once');
select is((select payload from public.inbox where user_id = pg_temp.u(43) and type = 'goal_completed'),
  '{"kind": "weekly_goal", "category": "phone", "weekStart": "2026-06-01", "points": 150, "prorated": false}'::jsonb,
  'and a goal_completed event with exactly the catalog''s keys');
select pg_temp.settle(pg_temp.u(43), pg_temp.late());
select is((select count(*)::int from public.points_ledger where user_id = pg_temp.u(43) and type = 'weekly_goal'), 1, 'never twice');
-- 44: two passes and no fails at the close; 45: two passes and a fail
select pg_temp.drove(pg_temp.u(44), d::date, true) from generate_series(date '2026-06-01', date '2026-06-02', interval '1 day') d;
select pg_temp.settle(pg_temp.u(44), pg_temp.late());
select is((select row(state, prorated, pass_days)::text from public.weekly_goals where user_id = pg_temp.u(44)), row('achieved', true, 2)::text,
  'two passing days and no failing day at the close: achieved, prorated');
select is((select coalesce(sum(amount), 0)::int from public.points_ledger where user_id = pg_temp.u(44) and type = 'weekly_goal'), 150, '+150');
select pg_temp.drove(pg_temp.u(45), d::date, true) from generate_series(date '2026-06-01', date '2026-06-02', interval '1 day') d;
select pg_temp.trip(pg_temp.u(45), date '2026-06-03', 90, 20, 'America/Los_Angeles', 'driver', false, array['phone']);
select pg_temp.day(pg_temp.u(45), date '2026-06-03', false);
select pg_temp.settle(pg_temp.u(45), pg_temp.late());
select is((select row(state, pass_days, fail_days)::text from public.weekly_goals where user_id = pg_temp.u(45)), row('ended', 2, 1)::text,
  'two passes and a fail at the close: ended');
select is((select count(*)::int from public.points_ledger where user_id = pg_temp.u(45) and type = 'weekly_goal'), 0, 'no goal points');
-- 46: a goal with no driving day
select public.ensure_week_goal(pg_temp.u(46), date '2026-06-01', 'America/Los_Angeles', timestamptz '2026-06-01 12:00+00');
select pg_temp.settle(pg_temp.u(46), pg_temp.late());
select is((select state from public.weekly_goals where user_id = pg_temp.u(46)), 'no_drives', 'no driving day: no_drives');
-- 47: the week is held open by a watermarked Sunday
select pg_temp.drove(pg_temp.u(47), date '2026-06-01', true);
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values
  ('w47', pg_temp.u(47), 'ios', pg_temp.la_close(date '2026-06-07') - interval '1 hour', pg_temp.la_close(date '2026-06-07') - interval '1 hour');
update public.devices set synced_through = pg_temp.la_close(date '2026-06-01') + interval '1 minute' where id = 'w47';
select pg_temp.settle(pg_temp.u(47), pg_temp.la_close(date '2026-06-07') + interval '1 hour');
select is((select row(state, pass_days)::text from public.weekly_goals where user_id = pg_temp.u(47)), row('active', 1)::text,
  'a week whose Sunday is held by a watermark stays active');
update public.devices set synced_through = pg_temp.la_close(date '2026-06-07') + interval '1 minute' where id = 'w47';
select pg_temp.settle(pg_temp.u(47), pg_temp.la_close(date '2026-06-07') + interval '2 hours');
select is((select row(state, prorated)::text from public.weekly_goals where user_id = pg_temp.u(47)), row('achieved', true)::text,
  'and closes once that Sunday is ready');
-- 48: open_my_week closes a stopped driver's earlier goal
select public.ensure_week_goal(pg_temp.u(48), date_trunc('week', (now() at time zone 'UTC')::date)::date - 14, 'UTC', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000048"}', true);
select lives_ok($$ select public.open_my_week() $$, 'open_my_week in a later week');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(state order by week_start) from public.weekly_goals where user_id = pg_temp.u(48)), array['no_drives', 'active'],
  'closes the earlier active goal of a driver who stopped driving (no value), and opens this week''s');
-- 49: the chosen focus
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000049"}', true);
select is(public.open_my_week() - 'week_start', '{"category":"phone","source":"weakest","target_days":4,"pass_days":0,"fail_days":0,"state":"active","prorated":false}'::jsonb,
  'open_my_week returns this week''s goal');
select is(public.set_weekly_focus('speeding') #>> '{applied}', 'this_week', 'a focus before any counted day applies this week');
select is((public.open_my_week() ->> 'category') || '/' || (public.open_my_week() ->> 'source'), 'speeding/chosen', 'the goal takes it');
reset role;
select set_config('request.jwt.claims', '', true);
update public.weekly_goals set pass_days = 1 where user_id = pg_temp.u(49);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000049"}', true);
select is(public.set_weekly_focus('braking') #>> '{applied}', 'next_week', 'after a counted day it becomes next week''s focus');
select throws_ok($$ select public.set_weekly_focus('bogus') $$, '22023', 'unknown focus', 'an unknown focus is refused');
reset role;
select set_config('request.jwt.claims', '', true);
select public.ensure_week_goal(pg_temp.u(49), date_trunc('week', (now() at time zone 'UTC')::date)::date + 7, 'UTC',
  (date_trunc('week', (now() at time zone 'UTC')::date)::date + 7)::timestamp at time zone 'UTC' + interval '1 hour');
select is((select array_agg(category order by week_start) from public.weekly_goals w where w.user_id = pg_temp.u(49)),
  array['speeding', 'braking'], 'next week''s goal takes the chosen focus');
select is((select next_focus from public.progress where user_id = pg_temp.u(49)), null, 'and consumes it');
select is((select count(*)::int from public.weekly_goals where user_id = pg_temp.u(49) and week_start = date_trunc('week', (now() at time zone 'UTC')::date)::date), 1,
  'open_my_week twice keeps one row for the week');
update public.rate_limits set count = 20 where user_id = pg_temp.u(49) and key = 'focus_day';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000049"}', true);
select throws_ok($$ select public.set_weekly_focus('phone') $$, '42501', 'focus limit reached', 'the 21st focus change in 24 h is refused');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 13. class (§R1)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(50);
insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key) values (pg_temp.u(50), 'challenge', 1480, 'seed', 1480, 'seed');
select pg_temp.drove(pg_temp.u(50), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(50), pg_temp.la_close(date '2026-06-01') + interval '1 minute');
select is((select row(p.points, p.level, pr.level)::text from public.progress p join public.profiles pr on pr.id = p.user_id where p.user_id = pg_temp.u(50)),
  row(1555, 2, 2)::text, '1,480 plus a safe phone-free day: 1,555 points, class 2, mirrored to profiles.level');
select is((select payload from public.inbox where user_id = pg_temp.u(50) and type = 'level_up'), '{"kind": "level", "level": 2, "name": "Steady"}'::jsonb,
  'one level_up, exactly { kind, level, name } with the class''s own name');
select pg_temp.drove(pg_temp.u(50), date '2026-06-02', true);
select pg_temp.settle(pg_temp.u(50), pg_temp.la_close(date '2026-06-02') + interval '1 minute');
select is((select count(*)::int from public.inbox where user_id = pg_temp.u(50) and type = 'level_up'), 1, 'a later settlement adds no second level_up');

-- ---------------------------------------------------------------------------
-- 14. notifications (§R9; Task 4 review m1)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(51);
insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key) values (pg_temp.u(51), 'challenge', 1400, 'seed', 1400, 'seed');
select pg_temp.drove(pg_temp.u(51), d::date, true) from generate_series(date '2026-06-01', date '2026-06-07', interval '1 day') d;
select pg_temp.settle(pg_temp.u(51), pg_temp.late());
select is(array(select row(type, push_state, push_reason)::text from public.inbox where user_id = pg_temp.u(51) and type <> 'trip_summary'
    and payload ->> 'kind' is distinct from 'badge' order by type),
  array[row('goal_completed', 'pending', null::text)::text, row('level_up', 'skipped', 'inbox_only')::text, row('streak_milestone', 'skipped', 'inbox_only')::text],
  'a settlement producing a goal, a class and a milestone: exactly one pending (the goal), two inbox-only');
select is((select count(*)::int from public.inbox where user_id = pg_temp.u(51) and payload ->> 'kind' = 'badge' and push_reason is distinct from 'inbox_only'), 0,
  'the badges that settlement also earned (0010) are inbox-only too: still exactly one pending');
select pg_temp.drove(pg_temp.u(51), d::date, true) from generate_series(date '2026-06-08', date '2026-06-11', interval '1 day') d;
select pg_temp.settle(pg_temp.u(51), pg_temp.late());
select is((select row(push_state, push_reason)::text from public.inbox where user_id = pg_temp.u(51) and dedupe_key = 'goal_completed:weekly:2026-06-08'),
  row('skipped', 'inbox_only')::text, 'a second settlement the same day: its event is inbox-only');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000002"}', true);
select is((select count(*)::int from public.inbox where user_id = 'c9000000-0000-4000-8000-000000000051'), 0, 'B sees none of M''s rows');
select is((select count(*)::int from public.progress where user_id = 'c9000000-0000-4000-8000-000000000051') + (select count(*)::int from public.points_ledger where user_id = 'c9000000-0000-4000-8000-000000000051')
    + (select count(*)::int from public.weekly_goals where user_id = 'c9000000-0000-4000-8000-000000000051'), 0, 'nor M''s progress, ledger or goals');
select throws_ok($$ select checked_through from public.reward_days $$, '42501', null, 'checked_through is not client-readable');
select is((select count(*)::int from public.reward_days r where r.user_id = 'c9000000-0000-4000-8000-000000000051' and r.points >= 0), 0, 'nor M''s reward days');
reset role;
select set_config('request.jwt.claims', '', true);
create function pg_temp.ev(p_key text, p_priority int) returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('type', 'streak_milestone', 'payload', jsonb_build_object('days', 7, 'reachedOn', '2026-06-07'),
    'dedupe_key', p_key, 'priority', p_priority))
$$;
select pg_temp.mkuser(52);
insert into public.inbox (user_id, type, payload, dedupe_key, push_state, created_at)
  values (pg_temp.u(52), 'goal_completed', '{}', 'carried', 'deferred', now() - interval '1 day');
select public.emit_reward_events(pg_temp.u(52), pg_temp.ev('e1', 1), 'UTC', now());
select is((select push_reason from public.inbox where user_id = pg_temp.u(52) and dedupe_key = 'e1'), 'inbox_only',
  'a push deferred into the next day holds that day''s new event to inbox-only');
update public.inbox set push_state = 'sent', push_reason = 'ok' where user_id = pg_temp.u(52) and dedupe_key = 'carried';
select public.emit_reward_events(pg_temp.u(52), pg_temp.ev('e2', 1), 'UTC', now());
select is((select push_state from public.inbox where user_id = pg_temp.u(52) and dedupe_key = 'e2'), 'pending', 'once it is sent, the next day''s event is pending');
select pg_temp.mkuser(53);
select public.emit_reward_events(pg_temp.u(53), pg_temp.ev('e5', 1) || pg_temp.ev('e6', 4), 'UTC', now());
select is(array(select row(dedupe_key, push_state)::text from public.inbox where user_id = pg_temp.u(53) order by dedupe_key),
  array[row('e5', 'skipped')::text, row('e6', 'pending')::text], 'two events on one day: the higher priority pending, the other inbox-only');

-- ---------------------------------------------------------------------------
-- 15. scheduling (§R8)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(n) from generate_series(60, 64) n;
select pg_temp.day(pg_temp.u(60), date '2026-06-10', false);
select is((select due_at from public.reward_due where user_id = pg_temp.u(60)), now(),
  'a score_daily row for a day whose close has passed enqueues at now (final review I1: never ahead of older work)');
select is((select count(*)::int from public.progress where user_id = pg_temp.u(60)) + (select count(*)::int from public.reward_days where user_id = pg_temp.u(60)), 0,
  'and writes nothing else');
create temp table today9 as select (now() at time zone 'America/Los_Angeles')::date as d;
select pg_temp.mkuser(65);
insert into public.notification_prefs (user_id, tz) values (pg_temp.u(65), 'America/Los_Angeles');
select pg_temp.day(pg_temp.u(65), (select d from today9) + 10, false);
select is((select due_at from public.reward_due where user_id = pg_temp.u(65)), pg_temp.la_close((select d from today9) + 10),
  'a day ahead enqueues at its real close (the user''s zone for a day without trips), not 02:00 at UTC+14 (final review m6)');
select pg_temp.day(pg_temp.u(65), (select d from today9) + 5, false);
select pg_temp.day(pg_temp.u(65), (select d from today9) + 20, false);
select is((select due_at from public.reward_due where user_id = pg_temp.u(65)), pg_temp.la_close((select d from today9) + 5), 'an earlier day lowers it; a later one does not raise it');
select pg_temp.mkuser(66);
select pg_temp.drove(pg_temp.u(66), (select d from today9) + 3, true, 'Asia/Tokyo');
select is((select due_at from public.reward_due where user_id = pg_temp.u(66)), (((select d from today9) + 4)::timestamp + interval '2 hours') at time zone 'Asia/Tokyo',
  'a driven day enqueues at the close in its trips'' zone');
-- fairness: an old-day write queues at now, behind a user who has waited longer
select pg_temp.mkuser(67);
select pg_temp.mkuser(68);
select pg_temp.drove(pg_temp.u(68), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(68), pg_temp.late());
insert into public.reward_due (user_id, due_at) values (pg_temp.u(67), now() - interval '1 hour');
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(68), 'old1', date '2026-06-01', 60, 20, false)::text));
select is((select due_at from public.reward_due where user_id = pg_temp.u(68)), now(), 'a write to a settled old day queues at now');
create temp table q9 as select user_id, due_at from public.reward_due where user_id not in (pg_temp.u(67), pg_temp.u(68));
delete from public.reward_due where user_id not in (pg_temp.u(67), pg_temp.u(68));
select is(public.settle_due_rewards_at(1, now()), 1, 'a sweep of one user');
select is(array[(select count(*)::int from public.reward_due where user_id = pg_temp.u(67)), (select count(*)::int from public.reward_due where user_id = pg_temp.u(68))],
  array[0, 1], 'takes the user who waited longer; the old-day write waits its turn');
insert into public.reward_due (user_id, due_at) select user_id, due_at from q9 on conflict (user_id) do nothing;
-- the cheap no-op (final review I1): a run that settles nothing and credits nothing skips the counters
set local session_replication_role = replica;
update public.progress set safe_days = 99 where user_id = pg_temp.u(68);
set local session_replication_role = origin;
select is(pg_temp.settle(pg_temp.u(68), pg_temp.late()) - 'events', '{"settledDays":0,"ledgerRows":0,"contradictions":1}'::jsonb,
  'the old-day rewrite settles nothing and records its one row');
select is((select safe_days from public.progress where user_id = pg_temp.u(68)), 99, 'and the counters, badges and challenges were not recomputed');
select pg_temp.drove(pg_temp.u(68), date '2026-06-02', true);
select pg_temp.settle(pg_temp.u(68), pg_temp.late());
select is((select safe_days from public.progress where user_id = pg_temp.u(68)), 2, 'a run that settles a day recomputes them');
-- (final review m2) a goal week closes by the zone pinned at the goal's creation, not a later client zone
select pg_temp.mkuser(69);
insert into public.notification_prefs (user_id, tz) values (pg_temp.u(69), 'America/Los_Angeles');
select pg_temp.drove(pg_temp.u(69), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(69), pg_temp.la_close(date '2026-06-01') + interval '1 minute');
select is((select tz from public.weekly_goals where user_id = pg_temp.u(69) and week_start = '2026-06-01'), 'America/Los_Angeles', 'the goal pins the user''s zone');
update public.notification_prefs set tz = 'Pacific/Kiritimati' where user_id = pg_temp.u(69);
select is(array[public.reward_week_closed(pg_temp.u(69), '2026-06-01', public.user_tz(pg_temp.u(69)), timestamptz '2026-06-07 20:00+00'),
    public.reward_week_closed(pg_temp.u(69), '2026-06-01', public.user_tz(pg_temp.u(69)), pg_temp.la_close(date '2026-06-07'))], array[false, true],
  'moved to UTC+14 after, the week without a Sunday drive still closes at Sunday''s close in the pinned zone, not 13 h early');
select pg_temp.drove(pg_temp.u(61), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(61), pg_temp.late());
select is((select count(*)::int from public.reward_due where user_id = pg_temp.u(61)), 0, 'after a settlement with nothing pending the row is gone');
-- the compare-and-set against the lease (rev2: I-B)
insert into public.reward_due (user_id, due_at) values (pg_temp.u(61), pg_temp.late() + interval '10 minutes');
select public.settle_rewards(pg_temp.u(61), pg_temp.late(), pg_temp.late() + interval '10 minutes');
select is((select count(*)::int from public.reward_due where user_id = pg_temp.u(61)), 0, 'nothing owed and an untouched lease: the row is deleted');
insert into public.reward_due (user_id, due_at) values (pg_temp.u(61), timestamptz '2026-07-01 12:00+00');
select public.settle_rewards(pg_temp.u(61), pg_temp.late(), pg_temp.late() + interval '10 minutes');
select is((select due_at from public.reward_due where user_id = pg_temp.u(61)), timestamptz '2026-07-01 12:00+00',
  'a row an enqueue touched during the lease is never deleted, only ever lowered');
-- a failing user backs off; the batch's other user still settles
select pg_temp.drove(pg_temp.u(62), date '2026-06-01', true);
insert into public.reward_days (user_id, day, outcome, outcome_reason, tier, phone_free, camera, predicates, points, streak_after, wall_close, settled_at, source_updated_at, checked_through)
  values (pg_temp.u(62), '2026-06-01', 'neutral', 'no_drive', 'none', false, false,
    '{"phone":"neutral","speeding":"neutral","braking":"neutral","accel":"neutral","cornering":"neutral","smooth":"neutral","safe":"neutral"}', 0, 0, now(), now(), now(), now());
select pg_temp.drove(pg_temp.u(63), date '2026-06-01', true);
delete from public.reward_due where user_id not in (pg_temp.u(62), pg_temp.u(63));
update public.reward_due set due_at = timestamptz '2026-06-02 09:00+00' where user_id in (pg_temp.u(62), pg_temp.u(63));
select is(public.settle_due_rewards_at(10, timestamptz '2026-06-05 00:00+00'), 2, 'the sweep takes both due users');
select is((select row(failures, due_at)::text from public.reward_due where user_id = pg_temp.u(62)), row(1, timestamptz '2026-06-05 01:00+00')::text,
  'a user whose settlement raises gets failures = 1 and due_at + 1 h');
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(63)), 1, 'and the other user still settles');
select is((select count(*)::int from public.progress where user_id = pg_temp.u(62)), 0, 'the failed settlement left nothing behind');
-- the back-off is compare-and-set against the lease (seat 5 r2)
insert into public.reward_due (user_id, due_at) values (pg_temp.u(64), timestamptz '2026-06-05 00:10+00');
select public.reward_settle_failed(pg_temp.u(64), timestamptz '2026-06-05 00:00+00', timestamptz '2026-06-05 00:10+00');
select is((select row(failures, due_at)::text from public.reward_due where user_id = pg_temp.u(64)), row(1, timestamptz '2026-06-05 01:00+00')::text,
  'an untouched lease backs off one hour');
update public.reward_due set due_at = timestamptz '2026-06-04 12:00+00' where user_id = pg_temp.u(64);
select public.reward_settle_failed(pg_temp.u(64), timestamptz '2026-06-05 00:00+00', timestamptz '2026-06-05 00:10+00');
select is((select row(failures, due_at)::text from public.reward_due where user_id = pg_temp.u(64)), row(2, timestamptz '2026-06-04 12:00+00')::text,
  'an enqueue during the failed run keeps its earlier time');
update public.reward_due set due_at = timestamptz '2026-06-05 00:10+00', failures = 4 where user_id = pg_temp.u(64);
select public.reward_settle_failed(pg_temp.u(64), timestamptz '2026-06-05 00:00+00', timestamptz '2026-06-05 00:10+00');
select is((select row(failures, due_at)::text from public.reward_due where user_id = pg_temp.u(64)), row(5, timestamptz '2026-06-06 00:00+00')::text,
  'the fifth failure backs off 24 h');

-- ---------------------------------------------------------------------------
-- 16. retention (ruling r1-M2)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(70);
insert into public.reward_contradictions (user_id, kind, detail, dedupe_key, created_at) values
  (pg_temp.u(70), 'zone_hop', '{}', 'old', now() - interval '401 days'), (pg_temp.u(70), 'zone_hop', '{}', 'young', now() - interval '399 days');
select is(public.purge_reward_audit(), 1, 'a 401-day-old contradiction is purged');
select is((select array_agg(dedupe_key) from public.reward_contradictions where user_id = pg_temp.u(70)), array['young'], 'a 399-day-old one is kept');
insert into public.reward_contradictions (user_id, kind, detail, dedupe_key, created_at)
  select pg_temp.u(70), 'zone_hop', '{}', 'bulk-' || i, now() - interval '500 days' from generate_series(1, 50001) i;
select is(public.purge_reward_audit(), 50000, 'one run deletes at most 50,000 rows');
select is(public.purge_reward_audit(), 1, 'and the next run the rest');

-- ---------------------------------------------------------------------------
-- 17. under 13 (R-H): U = 4
-- ---------------------------------------------------------------------------
select pg_temp.drove(pg_temp.u(4), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(4), pg_temp.late());
insert into public.reward_due (user_id, due_at) values (pg_temp.u(4), now());
insert into public.reward_contradictions (user_id, kind, detail, dedupe_key) values (pg_temp.u(4), 'zone_hop', '{}', 'u');
update public.profiles set level = 2 where id = pg_temp.u(4);
select is(array[(select count(*) from public.progress where user_id = pg_temp.u(4)), (select count(*) from public.points_ledger where user_id = pg_temp.u(4)),
    (select count(*) from public.reward_days where user_id = pg_temp.u(4)), (select count(*) from public.reward_due where user_id = pg_temp.u(4)),
    (select count(*) from public.weekly_goals where user_id = pg_temp.u(4)), (select count(*) from public.reward_contradictions where user_id = pg_temp.u(4))]::int[],
  array[1, 3, 1, 1, 1, 1], 'U holds a row in each of the six tables');
update public.private_profiles set birth_date = null where user_id = pg_temp.u(4);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000004"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'U gives a child''s birth date');
reset role;
select set_config('request.jwt.claims', '', true);
select is(array[(select count(*) from public.progress where user_id = pg_temp.u(4)), (select count(*) from public.points_ledger where user_id = pg_temp.u(4)),
    (select count(*) from public.reward_days where user_id = pg_temp.u(4)), (select count(*) from public.reward_due where user_id = pg_temp.u(4)),
    (select count(*) from public.weekly_goals where user_id = pg_temp.u(4)), (select count(*) from public.reward_contradictions where user_id = pg_temp.u(4))]::int[],
  array[0, 0, 0, 0, 0, 0], 'the u13 transition deletes every row in the six tables');
select is((select level from public.profiles where id = pg_temp.u(4)), 1, 'and resets profiles.level to 1 (R-H)');
select throws_ok($$ insert into public.progress (user_id) values (pg_temp.u(4)) $$, '42501', 'account not eligible', 'no progress row can be written for U');
select is(public.settle_rewards(pg_temp.u(4), pg_temp.late()), '{"skipped": "u13"}'::jsonb, 'settlement skips a u13 account');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000004"}', true);
select throws_ok($$ select public.open_my_week() $$, '42501', 'account not eligible', 'U cannot open a week');
select throws_ok($$ select public.set_weekly_focus('phone') $$, '42501', 'account not eligible', 'nor set a focus');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 18. fix round 1
-- ---------------------------------------------------------------------------
-- (security M-1) toggling a drive's role adds at most one row per target role and day
select pg_temp.mkuser(95);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(95), 't1', date '2026-06-01', 80, 20, false, false, 1)::text));
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for i in 1 .. 10 loop
    perform public.set_trip_role_row(pg_temp.u(95), (select id from public.trips where user_id = pg_temp.u(95)),
      case when i % 2 = 1 then 'passenger' else 'driver' end);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;
select is(array(select row(c.detail ->> 'to', (c.detail ->> 'count')::int)::text from public.reward_contradictions c
    where c.user_id = pg_temp.u(95) and c.kind = 'relabel_with_events' order by c.detail ->> 'to'),
  array[row('driver', 5)::text, row('passenger', 5)::text], 'ten role toggles keep one counted row per target role and day (security M-1)');
select is((select count(*)::int from public.reward_contradictions c where c.user_id = pg_temp.u(95) and c.detail ?& array['firstAt', 'lastAt']), 2,
  'each keeps its first and last time');
-- (review m1) a device that has never reported a watermark does not hold a day
select pg_temp.mkuser(92);
select pg_temp.drove(pg_temp.u(92), date '2026-06-01', true);
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values ('w92', pg_temp.u(92), 'ios', null, pg_temp.la_close(date '2026-06-01'));
select pg_temp.settle(pg_temp.u(92), pg_temp.la_close(date '2026-06-01'));
select is((select count(*)::int from public.reward_days where user_id = pg_temp.u(92)), 1,
  'an active device with a null synced_through (a build that does not report) settles at the wall close');
-- (review m2) a computed schedule at or before now becomes now + 1 minute; the procedure never takes one user twice
select pg_temp.mkuser(93);
select pg_temp.drove(pg_temp.u(93), date '2026-06-01', true);
select is(public.schedule_next_settle(pg_temp.u(93), 'America/Los_Angeles', pg_temp.late(), null), pg_temp.late() + interval '1 minute',
  'a schedule that would be at or before now is written as now + 1 minute');
select is((select due_at from public.reward_due where user_id = pg_temp.u(93)), pg_temp.late() + interval '1 minute', 'and stored so');
select ok(pg_get_functiondef('public.settle_due_rewards(int)'::regprocedure) ~ 'not \(d\.user_id = any\(v_done\)\)',
  'the procedure skips a user it already settled in this run');
select is((select count(*)::int from pg_proc p where p.oid in ('public.settle_due_rewards(int)'::regprocedure, 'public.settle_due_rewards_at(int, timestamptz)'::regprocedure)
    and p.prosrc ~ 'exception when others then\s+-- \(final review m8\)[^\n]*\n\s+raise log ''settle-rewards user failed: % %'', sqlstate, sqlerrm;'), 2,
  'both sweeps log a failed settlement''s sqlstate and message, never the user (final review m8)');
-- (review n1) settling a past week's goal leaves the focus for the current week
select pg_temp.mkuser(94);
insert into public.progress (user_id, next_focus) values (pg_temp.u(94), 'braking');
select pg_temp.drove(pg_temp.u(94), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(94), pg_temp.late());
select is((select row(g.category, g.source, pr.next_focus)::text from public.weekly_goals g join public.progress pr on pr.user_id = g.user_id where g.user_id = pg_temp.u(94)),
  row('phone', 'weakest', 'braking')::text, 'a past week''s goal takes the weakest category and the focus stays for the current week');
-- (review m3) no retroactive credit: existing users start today; history before it earns nothing
select pg_temp.mkuser(90);
select pg_temp.mkuser(91);
select pg_temp.drove(pg_temp.u(90), d::date, true) from generate_series(date '2026-06-01', date '2026-06-30', interval '1 day') d;
select public.start_rewards_for_existing_users();
select is((select rewards_start from public.progress where user_id = pg_temp.u(90)), public.user_local_date(pg_temp.u(90)),
  'an existing user starts on their local date of today');
select is((select count(*)::int from public.progress where user_id = pg_temp.u(4)), 0, 'a u13 account gets no progress row');
update public.progress set rewards_start = date '2026-07-01' where user_id = pg_temp.u(90);
delete from public.progress where user_id = pg_temp.u(91);
select pg_temp.drove(pg_temp.u(90), d::date, true) from generate_series(date '2026-07-01', date '2026-07-02', interval '1 day') d;
select pg_temp.settle(pg_temp.u(90), pg_temp.late());
select is((select array_agg(day order by day) from public.reward_days where user_id = pg_temp.u(90)), array[date '2026-07-01', date '2026-07-02'],
  'thirty days of history before rewards_start get no reward row; the days from it settle normally');
select is(array[(select count(*)::int from public.points_ledger where user_id = pg_temp.u(90) and type <> 'weekly_goal' and ref_key < '2026-07-01'),
    (select count(*)::int from public.reward_contradictions where user_id = pg_temp.u(90)),
    (select count(*)::int from public.inbox where user_id = pg_temp.u(90) and type <> 'trip_summary' and payload ->> 'reachedOn' < '2026-07-01')],
  array[0, 0, 0], 'no credit, no contradiction and no push for any day before it');
select is((select array_agg(row(week_start, state, prorated)::text order by week_start) from public.weekly_goals where user_id = pg_temp.u(90)),
  array[row(date '2026-06-29', 'achieved', true)::text], 'no goal for weeks before it; the week it starts in closes on its own days');
select pg_temp.drove(pg_temp.u(91), date '2026-06-01', true);
select pg_temp.settle(pg_temp.u(91), pg_temp.late());
select is((select row(pr.rewards_start, (select count(*)::int from public.reward_days r where r.user_id = pr.user_id))::text from public.progress pr where pr.user_id = pg_temp.u(91)),
  row(null::date, 1)::text, 'a user created after the migration is unbounded');

select * from finish();
rollback;
drop extension if exists dblink;
select cron.alter_job((select jobid from cron.job where jobname = 'settle-rewards'), active := true);
