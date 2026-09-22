-- 0008_purge_trace_objects: the server side of removing trace objects nothing else will ever
-- remove (task B6, ruling T12 security I-1). A RELEASE GATE: the block screen promises "RoadWise
-- will finish removing your recorded drives from its servers".
--
-- Why a new job: 0006's under-13 minimisation deletes a blocked child's trips rows, and 0002's
-- expire_trace_objects finds trace objects only through trips rows, so the child's raw 1 Hz GNSS
-- traces become orphans that no job lists. The block screen's own Storage purge can be skipped
-- (sign-out, uninstall, offline), and M8's delete-account will orphan traces the same way. SQL
-- cannot delete object bytes (storage.protect_delete; 0002's header): the edge function
-- purge-trace-objects deletes through the Storage API, and this migration lists what it deletes,
-- keeps two runs from overlapping, and wakes it hourly.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * public.expired_trace_object_keys(p_limit int) returns jsonb (#12 of the security rules:
--     service-role guard first; invoker): [{ bucket, name }] of objects in the `traces` bucket
--     created more than 14 days ago (the dispute window: a trace exists only to verify a disputed
--     moment, and a dispute closes 14 days after the drive; an object is created at upload, never
--     before its drive ends, so this is never early). Found by storage.objects metadata ALONE,
--     independent of trips rows, so an orphan of any cause is found. Oldest first, 1..1000 rows
--     (22023 otherwise). Together with 0006's underage_object_keys (every bucket, a u13 user's
--     prefix) these are the two lists the function deletes.
--   * public.job_leases (#1, #10, #11): one row per background job, the lease that keeps two runs
--     from overlapping (an advisory lock does not survive PostgREST's pooled connections). RLS on,
--     no policies, no grants to any API role: only the two definer functions below touch it.
--   * public.take_job_lease(p_job text, p_holder uuid, p_seconds int) returns boolean and
--     public.release_job_lease(p_job text, p_holder uuid) returns boolean: service-role-only
--     definers (require_service_role first; #5 owner postgres, pinned search_path). Take succeeds
--     when no lease is held or the held one has expired (a crashed run's lease lapses on its own);
--     release clears only the caller's own lease. Bounds: job name ^[a-z][a-z0-9_-]{0,63}$,
--     seconds 30..3600 (22023).
--   * public.purge_traces_signature(p_ts bigint, p_key text) returns text: internal (postgres
--     only), '<ts>.' || lower-hex HMAC-SHA256(key = the UTF-8 bytes of p_key, message = the UTF-8
--     bytes of 'purge-trace-objects:' || <ts>).
--   * public.dispatch_purge_traces() returns text: invoker, run by pg_cron as postgres; no API role
--     may execute it. Reads the vault secrets purge_traces_url and purge_traces_hmac_key (a
--     DEDICATED random secret of at least 32 bytes, never the service-role key, the JWT secret or
--     push_sender_hmac_key; the function holds the same value as PURGE_TRACES_HMAC_KEY). The key
--     is never sent, logged or returned. Returns:
--       'unconfigured' the URL is missing or empty, or the key is missing or under 32 bytes;
--       'idle'         nothing to remove (no object under a u13 prefix, no trace past 14 days);
--       'dispatched'   one net.http_post to the URL: body {"reason":"sweep"}, timeout 10 s,
--                      headers exactly Content-Type: application/json and
--                      X-Sweep-Signature: purge_traces_signature(floor(extract(epoch from now())), key).
--   * cron job `purge-trace-objects` at minute 45 of every hour, as postgres.
--
-- The authentication contract is push-sender's sweep contract (0007, T2 r1) with its own purpose
-- string and its own key, so neither signature can ever be replayed against the other function.

-- ---------------------------------------------------------------------------
-- listing: traces past the dispute window, by object metadata only
-- ---------------------------------------------------------------------------
create or replace function public.expired_trace_object_keys(p_limit int) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_keys jsonb;
begin
  perform public.require_service_role('expired_trace_object_keys');
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', k.bucket_id, 'name', k.name) order by k.created_at, k.name), '[]'::jsonb)
    into v_keys
  from (
    select o.bucket_id, o.name, o.created_at
    from storage.objects o
    where o.bucket_id = 'traces' and o.created_at < now() - interval '14 days'
    order by o.created_at, o.name
    limit p_limit
  ) k;
  return v_keys;
end $$;

-- ---------------------------------------------------------------------------
-- leases: no two runs of a job at once
-- ---------------------------------------------------------------------------
create table public.job_leases (
  job text primary key check (job ~ '^[a-z][a-z0-9_-]{0,63}$'),
  holder uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger job_leases_touch before update on public.job_leases for each row execute function public.touch_updated_at();

create or replace function public.take_job_lease(p_job text, p_holder uuid, p_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_taken boolean;
begin
  perform public.require_service_role('take_job_lease');
  if p_job is null or p_job !~ '^[a-z][a-z0-9_-]{0,63}$' then
    raise exception 'job must be a job name' using errcode = 'invalid_parameter_value';
  end if;
  if p_holder is null then
    raise exception 'holder is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_seconds is null or p_seconds < 30 or p_seconds > 3600 then
    raise exception 'lease must be between 30 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.job_leases (job, holder, expires_at)
    values (p_job, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (job) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.job_leases.expires_at <= now()
  returning true into v_taken;
  return coalesce(v_taken, false);
end $$;

create or replace function public.release_job_lease(p_job text, p_holder uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  perform public.require_service_role('release_job_lease');
  if p_job is null or p_job !~ '^[a-z][a-z0-9_-]{0,63}$' then
    raise exception 'job must be a job name' using errcode = 'invalid_parameter_value';
  end if;
  if p_holder is null then
    raise exception 'holder is required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.job_leases where job = p_job and holder = p_holder;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ---------------------------------------------------------------------------
-- the wake: pg_cron -> dispatch_purge_traces -> pg_net -> purge-trace-objects
-- ---------------------------------------------------------------------------
create or replace function public.purge_traces_signature(p_ts bigint, p_key text) returns text
language sql immutable set search_path = public as $$
  select p_ts::text || '.' || encode(extensions.hmac('purge-trace-objects:' || p_ts::text, p_key, 'sha256'), 'hex')
$$;

create or replace function public.dispatch_purge_traces() returns text
language plpgsql set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'purge_traces_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'purge_traces_hmac_key';
  if coalesce(v_url, '') = '' or octet_length(coalesce(v_key, '')) < 32 then
    return 'unconfigured';
  end if;
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'traces' and o.created_at < now() - interval '14 days')
     and not exists (select 1 from public.profiles p
                     join storage.objects o on o.name like p.id::text || '/%'
                     where p.age_band = 'u13') then
    return 'idle';
  end if;
  perform net.http_post(
    url := v_url,
    body := '{"reason":"sweep"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Sweep-Signature', public.purge_traces_signature(floor(extract(epoch from now()))::bigint, v_key)),
    timeout_milliseconds := 10000);
  return 'dispatched';
end $$;

select cron.schedule('purge-trace-objects', '45 * * * *', 'select public.dispatch_purge_traces()');

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
alter table public.job_leases enable row level security;
revoke all on public.job_leases from anon, authenticated, service_role;

revoke all on function public.expired_trace_object_keys(int) from public, anon, authenticated;
revoke all on function public.take_job_lease(text, uuid, int) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.purge_traces_signature(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.dispatch_purge_traces() from public, anon, authenticated, service_role;
grant execute on function public.expired_trace_object_keys(int) to service_role;
grant execute on function public.take_job_lease(text, uuid, int) to service_role;
grant execute on function public.release_job_lease(text, uuid) to service_role;
