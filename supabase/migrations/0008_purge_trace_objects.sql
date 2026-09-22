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
-- clears the trips rows' trace_path for what it deleted, keeps two runs from overlapping, and
-- wakes it every 15 minutes. It is the ONE retention mechanism: 0002's unscheduled
-- expire_trace_objects is dropped here (final review m8).
--
-- Retention (ruling "B6 retention"): 14 days, for every user, matching the pd-1 disclosure ("kept
-- up to 14 days so disputes can be checked"); it supersedes 0002's 90-day note. Counted from the
-- DRIVE where a trips row names the object: least(object created_at, trips.ended_at), so a late
-- upload cannot keep a trace ~44 days (B6 security M-2); from the object's created_at otherwise
-- (an orphan). An object is never created before its drive ends, so this is never early.
-- least(x, y) < c is exactly x < c or y < c, so the rule is evaluated as the union of two cheap
-- halves (review B6 r1 n1), never as one trips lookup per object:
--   (a) traces objects with created_at < cutoff (a plain column filter on the bucket), and
--   (b) objects named by trips.trace_path where trips.ended_at < cutoff (the partial index
--       trips_trace_expiry_idx, then an exact (bucket_id, name) lookup in storage.objects).
-- One case falls to (a) alone: an object whose trips row names no path, which is only a late
-- upload landing under a drive already deleted (soft_delete_trip clears trace_path); it is kept at
-- most 14 days from that upload, like any orphan.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * trips.scored_without_trace boolean not null default false (ruling B6 r2): whether the drive
--     was SCORED without a trace, i.e. finalize-trip's `no_trace` condition (payload.tracePath null,
--     which apply_trip stores as trace_path null). It describes the recording at scoring time, not
--     later retention: clearing trace_path after the purge deletes the object (clear_trace_paths,
--     soft_delete_trip) never changes it, so a re-score never lowers a grade
--     for a trace that was present when the drive was scored. Backfilled = (trace_path is null)
--     FIRST, before anything in this migration can clear a path. Set by the non-definer trigger
--     trips_scored_without_trace for every writer: on insert from trace_path, on every update
--     pinned to the old value. apply_trip itself is unchanged (it inserts trace_path from the
--     payload, so the trigger reads exactly its value). Server-owned: clients have no write grant
--     on trips at all (0002), only table-level select.
--   * public.underage_object_keys_after(p_limit int, p_after_bucket text, p_after_name text)
--     returns jsonb (service-role guard first; invoker): [{ bucket, name }] of objects in ANY
--     bucket whose first path segment is a u13 user's id, ordered (bucket, name) in byte order,
--     strictly after the cursor when one is given (both cursor parts or neither), 1..1000 rows.
--     The join is split_part(name, '/', 1) = id (review B6 I1): hash-joinable, and the range
--     name ~>=~ '<id>/' and name ~<~ '<id>0' beside it lets storage's own name_prefix_search index
--     serve it per profile ('0' is the byte after '/'). postgres does not own storage.objects, so
--     no index of ours can be added there (m1); profiles_u13_idx keeps the u13 side small.
--   * public.underage_object_keys(p_limit int): 0006's function, REPLACED with the same signature,
--     now the cursor-less call of the above (the old LIKE '<id>/%' join grew as u13 x objects).
--   * public.expired_trace_object_keys(p_limit int, p_after_name text) returns jsonb (service-role
--     guard first; invoker): [{ bucket, name }] of `traces` objects past retention (above): the
--     union of halves (a) and (b), deduplicated, ordered by name in byte order after the cursor,
--     1..1000 rows. Half (a) is bounded to the traces bucket (storage has no created_at index and
--     none of ours can be added); half (b) reads only trips past retention that still name a path.
--   * trips_trace_expiry_idx: a partial index on trips (ended_at) where trace_path is not null,
--     for half (b); clear_trace_paths keeps it small.
--   * public.clear_trace_paths(p_keys text[]) returns int: service-role-only definer. For each key
--     the function has DELETED from the traces bucket, clears trips.trace_path, so nothing
--     references a missing object (ruling B6 retention). It leaves scored_without_trace alone: a
--     re-score reads that flag, so a drive scored with its trace keeps its grade. Keys must be '<uuid>/<client id>.bin.gz' (22023 otherwise), at most 1000; the
--     row is found through the (user_id, client_trip_id) key; returns the count only.
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
--       'idle'         nothing to remove (no object under a u13 prefix, no trace past retention);
--       'dispatched'   one net.http_post to the URL: body {"reason":"sweep"}, timeout 10 s,
--                      headers exactly Content-Type: application/json and
--                      X-Sweep-Signature: purge_traces_signature(floor(extract(epoch from now())), key).
--   * cron job `purge-trace-objects` every 15 minutes (review m2: a run that stops early with
--     `more` continues within the quarter hour; an idle run is one probe), as postgres.
--
-- The authentication contract is push-sender's sweep contract (0007, T2 r1) with its own purpose
-- string and its own key, so neither signature can ever be replayed against the other function.

-- ---------------------------------------------------------------------------
-- scored_without_trace: the recording as it was scored, whatever retention does later
-- ---------------------------------------------------------------------------
alter table public.trips add column scored_without_trace boolean not null default false;
-- the backfill runs before anything below can clear a trace_path
update public.trips set scored_without_trace = (trace_path is null) where scored_without_trace is distinct from (trace_path is null);

create or replace function public.stamp_scored_without_trace() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.scored_without_trace := new.trace_path is null;
  else
    new.scored_without_trace := old.scored_without_trace;
  end if;
  return new;
end $$;
create trigger trips_scored_without_trace before insert or update on public.trips
  for each row execute function public.stamp_scored_without_trace();

-- ---------------------------------------------------------------------------
-- listing: a blocked child's objects, every bucket
-- ---------------------------------------------------------------------------
create index profiles_u13_idx on public.profiles (id) where age_band = 'u13';

create or replace function public.underage_object_keys_after(p_limit int, p_after_bucket text, p_after_name text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_keys jsonb;
begin
  perform public.require_service_role('underage_object_keys_after');
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  if (p_after_bucket is null) <> (p_after_name is null) then
    raise exception 'a cursor needs both its bucket and its name' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', k.bucket_id, 'name', k.name) order by k.bucket_id collate "C", k.name collate "C"), '[]'::jsonb)
    into v_keys
  from (
    select o.bucket_id, o.name
    from public.profiles p
    join storage.objects o
      on split_part(o.name, '/', 1) = p.id::text
     and o.name ~>=~ (p.id::text || '/') and o.name ~<~ (p.id::text || '0')
    where p.age_band = 'u13'
      and (p_after_bucket is null
           or (o.bucket_id collate "C", o.name collate "C") > (p_after_bucket collate "C", p_after_name collate "C"))
    order by o.bucket_id collate "C", o.name collate "C"
    limit p_limit
  ) k;
  return v_keys;
end $$;

create or replace function public.underage_object_keys(p_limit int) returns jsonb
language plpgsql stable set search_path = public as $$
begin
  perform public.require_service_role('underage_object_keys');
  return public.underage_object_keys_after(p_limit, null, null);
end $$;

-- ---------------------------------------------------------------------------
-- listing: traces past retention, counted from the drive where one exists
-- ---------------------------------------------------------------------------
-- half (b)'s index: trips past retention that still name a trace
create index trips_trace_expiry_idx on public.trips (ended_at) where trace_path is not null;

create or replace function public.expired_trace_object_keys(p_limit int, p_after_name text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_cutoff timestamptz := now() - interval '14 days';
  v_keys jsonb;
begin
  perform public.require_service_role('expired_trace_object_keys');
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', 'traces', 'name', k.name) order by k.name collate "C"), '[]'::jsonb)
    into v_keys
  from (
    select u.name
    from (
      -- (a) uploaded more than 14 days ago
      (select o.name from storage.objects o
       where o.bucket_id = 'traces' and o.created_at < v_cutoff
         and (p_after_name is null or o.name collate "C" > p_after_name collate "C")
       order by o.name collate "C"
       limit p_limit)
      union
      -- (b) named by a trips row whose drive ended more than 14 days ago
      (select o.name from public.trips t
       join storage.objects o on o.bucket_id = 'traces' and o.name = t.trace_path
       where t.trace_path is not null and t.ended_at < v_cutoff
         and (p_after_name is null or t.trace_path collate "C" > p_after_name collate "C")
       order by o.name collate "C"
       limit p_limit)
    ) u
    order by u.name collate "C"
    limit p_limit
  ) k;
  return v_keys;
end $$;

-- ---------------------------------------------------------------------------
-- after a delete: no trips row names a trace that is gone
-- ---------------------------------------------------------------------------
create or replace function public.clear_trace_paths(p_keys text[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  perform public.require_service_role('clear_trace_paths');
  if p_keys is null or cardinality(p_keys) > 1000 then
    raise exception 'clear_trace_paths takes at most 1000 keys' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from unnest(p_keys) k
             where k is null or k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.bin\.gz$') then
    raise exception 'clear_trace_paths keys must be trace keys' using errcode = 'invalid_parameter_value';
  end if;
  update public.trips t set trace_path = null
    from (select distinct split_part(k, '/', 1)::uuid as user_id, left(split_part(k, '/', 2), -7) as client_trip_id
          from unnest(p_keys) k) x
    where t.user_id = x.user_id and t.client_trip_id = x.client_trip_id and t.trace_path is not null;
  get diagnostics v_count = row_count;
  return v_count;
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
  -- the listings' own predicates, as existence probes: halves (a) and (b), then the children
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'traces' and o.created_at < now() - interval '14 days')
     and not exists (select 1 from public.trips t
                     join storage.objects o on o.bucket_id = 'traces' and o.name = t.trace_path
                     where t.trace_path is not null and t.ended_at < now() - interval '14 days')
     and not exists (select 1 from public.profiles p
                     join storage.objects o
                       on split_part(o.name, '/', 1) = p.id::text
                      and o.name ~>=~ (p.id::text || '/') and o.name ~<~ (p.id::text || '0')
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

select cron.schedule('purge-trace-objects', '*/15 * * * *', 'select public.dispatch_purge_traces()');

-- ---------------------------------------------------------------------------
-- final review m8: 0002's expire_trace_objects was never scheduled or called, and it cleared
-- trace_path before the bytes went. This migration's purge is the one retention mechanism, so the
-- older function is dropped rather than left for M8 to wire in beside it.
-- ---------------------------------------------------------------------------
drop function if exists public.expire_trace_objects(interval, int);

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
alter table public.job_leases enable row level security;
revoke all on public.job_leases from anon, authenticated, service_role;

revoke all on function public.stamp_scored_without_trace() from public, anon, authenticated;
revoke all on function public.underage_object_keys_after(int, text, text) from public, anon, authenticated;
revoke all on function public.underage_object_keys(int) from public, anon, authenticated;
revoke all on function public.expired_trace_object_keys(int, text) from public, anon, authenticated;
revoke all on function public.clear_trace_paths(text[]) from public, anon, authenticated;
revoke all on function public.take_job_lease(text, uuid, int) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.purge_traces_signature(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.dispatch_purge_traces() from public, anon, authenticated, service_role;
grant execute on function public.underage_object_keys_after(int, text, text) to service_role;
grant execute on function public.underage_object_keys(int) to service_role;
grant execute on function public.expired_trace_object_keys(int, text) to service_role;
grant execute on function public.clear_trace_paths(text[]) to service_role;
grant execute on function public.take_job_lease(text, uuid, int) to service_role;
grant execute on function public.release_job_lease(text, uuid) to service_role;
