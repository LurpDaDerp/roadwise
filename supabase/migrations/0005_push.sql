-- 0005_push: notification preferences, the inbox as a push outbox, deliveries, job leases, the
-- service-role writers push-sender uses, the pg_cron sweep (a pure-SQL idle probe, then one
-- pg_net call), and the weekly recap producer.
--
-- Three kinds: weekly_recap (Sunday evening, user-local), league_result (Monday, from the league
-- close in 0007), friend_request (from send_friend_request in 0006). The copy is rendered from the
-- payload facts by push-sender. Tokens live on devices.push_token (0001).

create table public.notification_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  weekly_recap boolean not null default true,
  leagues boolean not null default true,
  social boolean not null default true,
  quiet_enabled boolean not null default true,
  quiet_start time not null default '22:00',
  quiet_end time not null default '07:00',
  tz text check (char_length(tz) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger notification_prefs_touch before update on public.notification_prefs for each row execute function public.touch_updated_at();

create table public.inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('weekly_recap', 'league_result', 'friend_request')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 2048),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 128),
  push_state text not null default 'pending' check (push_state in ('pending', 'sending', 'sent', 'deferred', 'skipped', 'failed')),
  push_reason text check (char_length(push_reason) <= 32),
  push_after timestamptz not null default now(),
  push_attempts int not null default 0 check (push_attempts >= 0),
  push_claimed_at timestamptz,
  pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbox_user_dedupe_key unique (user_id, dedupe_key)
);
create index inbox_due_idx on public.inbox (push_after) where push_state in ('pending', 'deferred');
create index inbox_sending_idx on public.inbox (push_claimed_at) where push_state = 'sending';
create index inbox_user_created_idx on public.inbox (user_id, created_at desc);
create trigger inbox_touch before update on public.inbox for each row execute function public.touch_updated_at();

create table public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references public.inbox(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text check (char_length(token) <= 256),
  ticket_id text check (char_length(ticket_id) <= 128),
  error text check (char_length(error) <= 64),
  receipt_status text check (receipt_status in ('ok', 'error')),
  receipt_error text check (char_length(receipt_error) <= 64),
  receipt_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_deliveries_inbox_idx on public.push_deliveries (inbox_id);
create index push_deliveries_user_idx on public.push_deliveries (user_id);
create index push_deliveries_receipt_due_idx on public.push_deliveries (created_at) where ticket_id is not null and receipt_status is null;
create trigger push_deliveries_touch before update on public.push_deliveries for each row execute function public.touch_updated_at();

-- one runner per job name at a time
create table public.job_leases (
  name text primary key check (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  holder text not null check (char_length(holder) between 1 and 128),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
-- prefs.tz, else the zone of the latest drive, else New York
create or replace function private.user_tz(p_user uuid) returns text
language plpgsql stable set search_path = public as $$
declare
  v_tz text;
begin
  select p.tz into v_tz from public.notification_prefs p where p.user_id = p_user;
  if v_tz is null then
    select t.tz into v_tz from public.trips t where t.user_id = p_user order by t.started_at desc limit 1;
  end if;
  if v_tz is null or not private.is_known_tz(v_tz) then
    return 'America/New_York';
  end if;
  return v_tz;
end $$;

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
create or replace function public.get_notification_prefs() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'get_notification_prefs requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  select jsonb_build_object('weekly_recap', p.weekly_recap, 'leagues', p.leagues, 'social', p.social,
      'quiet_enabled', p.quiet_enabled, 'quiet_start', left(p.quiet_start::text, 5), 'quiet_end', left(p.quiet_end::text, 5), 'tz', p.tz)
    into v_out from public.notification_prefs p where p.user_id = v_uid;
  return coalesce(v_out, jsonb_build_object('weekly_recap', true, 'leagues', true, 'social', true,
    'quiet_enabled', true, 'quiet_start', '22:00', 'quiet_end', '07:00', 'tz', null));
end $$;

-- set_notification_prefs(...): each null = unchanged; times as 'HH:MM'
create or replace function public.set_notification_prefs(p_weekly_recap boolean default null, p_leagues boolean default null, p_social boolean default null,
  p_quiet_enabled boolean default null, p_quiet_start text default null, p_quiet_end text default null, p_tz text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'set_notification_prefs requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if (p_quiet_start is not null and p_quiet_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     or (p_quiet_end is not null and p_quiet_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'quiet hours must be HH:MM' using errcode = 'invalid_parameter_value';
  end if;
  if p_tz is not null and not private.is_known_tz(p_tz) then
    raise exception 'unknown time zone' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.notification_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.notification_prefs set
    weekly_recap = coalesce(p_weekly_recap, weekly_recap),
    leagues = coalesce(p_leagues, leagues),
    social = coalesce(p_social, social),
    quiet_enabled = coalesce(p_quiet_enabled, quiet_enabled),
    quiet_start = coalesce(p_quiet_start::time, quiet_start),
    quiet_end = coalesce(p_quiet_end::time, quiet_end),
    tz = coalesce(p_tz, tz)
  where user_id = v_uid;
  return public.get_notification_prefs();
end $$;

-- ---------------------------------------------------------------------------
-- service-role writers (push-sender, through the Data API)
-- ---------------------------------------------------------------------------
-- acquire_job_lease(p_name, p_holder, p_seconds) -> true when the lease is held by p_holder now
create or replace function public.acquire_job_lease(p_name text, p_holder text, p_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
begin
  perform public.require_service_role('acquire_job_lease');
  if p_name is null or p_name !~ '^[a-z][a-z0-9_-]{0,63}$' or p_holder is null or char_length(p_holder) not between 1 and 128
     or p_seconds is null or p_seconds not between 1 and 3600 then
    raise exception 'lease needs a name, a holder and 1 to 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.job_leases (name, holder, expires_at) values (p_name, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (name) do update
    set holder = excluded.holder, expires_at = excluded.expires_at, updated_at = now()
    where public.job_leases.expires_at <= now() or public.job_leases.holder = excluded.holder;
  v_ok := found;
  return v_ok;
end $$;

create or replace function public.release_job_lease(p_name text, p_holder text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_service_role('release_job_lease');
  delete from public.job_leases where name = p_name and holder = p_holder;
end $$;

-- claim_push_batch(p_limit 1..500, p_lease_seconds 30..3600) -> [{ inbox_id, user_id, kind,
-- payload, created_at, ctx: { tz, quiet: { enabled, start, end }, enabled, tokens[] } }]
--   expired `sending` rows are failed first; due rows are claimed oldest first (skip locked);
--   ctx.enabled = the user's preference for this kind; tokens = the user's devices' push tokens
create or replace function public.claim_push_batch(p_limit int, p_lease_seconds int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  perform public.require_service_role('claim_push_batch');
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'limit must be between 1 and 500' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease must be between 30 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  update public.inbox set push_state = 'failed', push_reason = 'lease_expired'
    where push_state = 'sending' and push_claimed_at < now() - make_interval(secs => p_lease_seconds);
  with due as (
    select i.id from public.inbox i
    where i.push_state in ('pending', 'deferred') and i.push_after <= now()
    order by i.push_after, i.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.inbox i set push_state = 'sending', push_claimed_at = now(), push_attempts = i.push_attempts + 1
      from due where i.id = due.id
      returning i.id, i.user_id, i.kind, i.payload, i.created_at, i.push_after
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'inbox_id', c.id, 'user_id', c.user_id, 'kind', c.kind, 'payload', c.payload, 'created_at', c.created_at,
      'ctx', jsonb_build_object(
        'tz', private.user_tz(c.user_id),
        'quiet', jsonb_build_object('enabled', coalesce(p.quiet_enabled, true),
          'start', left(coalesce(p.quiet_start, '22:00'::time)::text, 5), 'end', left(coalesce(p.quiet_end, '07:00'::time)::text, 5)),
        'enabled', case c.kind when 'weekly_recap' then coalesce(p.weekly_recap, true)
                                when 'league_result' then coalesce(p.leagues, true)
                                else coalesce(p.social, true) end,
        'tokens', coalesce((select jsonb_agg(d.push_token order by d.last_seen_at desc) from (
                    select d.push_token, d.last_seen_at from public.devices d
                    where d.user_id = c.user_id and d.push_token is not null order by d.last_seen_at desc limit 10) d), '[]'::jsonb)))
      order by c.push_after, c.id), '[]'::jsonb)
    into v_out
  from claimed c left join public.notification_prefs p on p.user_id = c.user_id;
  return v_out;
end $$;

-- record_push_outcomes({ outcomes: [{ inbox_id, state, reason, push_after?, deliveries? }] }) -> int
create or replace function public.record_push_outcomes(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_o jsonb;
  v_d jsonb;
  v_id uuid;
  v_state text;
  v_reason text;
  v_after timestamptz;
  v_user uuid;
  v_current text;
  v_count int := 0;
begin
  perform public.require_service_role('record_push_outcomes');
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'outcomes') is distinct from 'array'
     or jsonb_array_length(p -> 'outcomes') > 500 then
    raise exception 'outcomes must be an array of at most 500 items' using errcode = 'invalid_parameter_value';
  end if;
  for v_o in select e.value from jsonb_array_elements(p -> 'outcomes') e loop
    v_id := null;
    if jsonb_typeof(v_o) = 'object' and (v_o ->> 'inbox_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_id := (v_o ->> 'inbox_id')::uuid;
    end if;
    if v_id is null then
      raise exception 'outcome must be an object with a uuid inbox_id' using errcode = 'invalid_parameter_value';
    end if;
    v_state := v_o ->> 'state';
    if v_state is null or v_state not in ('sent', 'deferred', 'skipped', 'failed') then
      raise exception 'unknown outcome state' using errcode = 'invalid_parameter_value';
    end if;
    v_reason := v_o ->> 'reason';
    if v_reason is null or v_reason !~ '^[a-z_]{1,32}$' then
      raise exception 'unknown outcome reason' using errcode = 'invalid_parameter_value';
    end if;
    v_after := null;
    if v_state = 'deferred' then
      begin
        v_after := (v_o ->> 'push_after')::timestamptz;
      exception when others then
        v_after := null;
      end;
      if v_after is null or v_after > now() + interval '7 days' then
        raise exception 'deferred outcome needs push_after within 7 days' using errcode = 'invalid_parameter_value';
      end if;
    end if;
    if v_o ? 'deliveries' and jsonb_typeof(v_o -> 'deliveries') <> 'null'
       and (jsonb_typeof(v_o -> 'deliveries') <> 'array' or jsonb_array_length(v_o -> 'deliveries') > 10) then
      raise exception 'deliveries must be an array of at most 10 items' using errcode = 'invalid_parameter_value';
    end if;
    select i.user_id, i.push_state into v_user, v_current from public.inbox i where i.id = v_id for update;
    if not found then
      continue;
    end if;
    if v_current <> 'sending' then
      raise exception 'outcome for an unclaimed item' using errcode = 'invalid_parameter_value';
    end if;
    update public.inbox set
      push_state = v_state, push_reason = v_reason,
      pushed_at = case when v_state = 'sent' then now() else pushed_at end,
      push_after = case when v_state = 'deferred' then v_after else push_after end
    where id = v_id;
    if jsonb_typeof(v_o -> 'deliveries') = 'array' then
      for v_d in select e.value from jsonb_array_elements(v_o -> 'deliveries') e loop
        if jsonb_typeof(v_d) <> 'object'
           or char_length(coalesce(v_d ->> 'token', '')) > 256
           or char_length(coalesce(v_d ->> 'ticket_id', '')) > 128
           or char_length(coalesce(v_d ->> 'error', '')) > 64 then
          raise exception 'delivery must be an object with bounded token, ticket_id and error' using errcode = 'invalid_parameter_value';
        end if;
        insert into public.push_deliveries (inbox_id, user_id, token, ticket_id, error)
          values (v_id, v_user, v_d ->> 'token', v_d ->> 'ticket_id', v_d ->> 'error');
        if v_d ->> 'error' = 'DeviceNotRegistered' and v_d ->> 'token' is not null then
          update public.devices set push_token = null where user_id = v_user and push_token = v_d ->> 'token';
        end if;
      end loop;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- push_receipts_due(p_limit) -> [{ delivery_id, ticket_id }]; tickets older than a day expire
create or replace function public.push_receipts_due(p_limit int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  perform public.require_service_role('push_receipts_due');
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  update public.push_deliveries set receipt_status = 'error', receipt_error = 'expired', receipt_checked_at = now()
    where ticket_id is not null and receipt_status is null and created_at < now() - interval '24 hours';
  select coalesce(jsonb_agg(jsonb_build_object('delivery_id', q.id, 'ticket_id', q.ticket_id) order by q.created_at, q.id), '[]'::jsonb)
    into v_out
  from (
    select d.id, d.ticket_id, d.created_at from public.push_deliveries d
    where d.ticket_id is not null and d.receipt_status is null
      and d.created_at <= now() - interval '15 minutes'
      and (d.receipt_checked_at is null or d.receipt_checked_at <= now() - interval '15 minutes')
    order by d.created_at, d.id
    limit p_limit
  ) q;
  return v_out;
end $$;

-- record_push_receipts({ receipts: [{ delivery_id, status ok|error|null, error }] }) -> int
create or replace function public.record_push_receipts(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_r jsonb;
  v_id uuid;
  v_status text;
  v_error text;
  v_token text;
  v_user uuid;
  v_count int := 0;
begin
  perform public.require_service_role('record_push_receipts');
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'receipts') is distinct from 'array'
     or jsonb_array_length(p -> 'receipts') > 1000 then
    raise exception 'receipts must be an array of at most 1000 items' using errcode = 'invalid_parameter_value';
  end if;
  for v_r in select e.value from jsonb_array_elements(p -> 'receipts') e loop
    if jsonb_typeof(v_r) <> 'object' or (v_r ->> 'delivery_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_r ->> 'status', 'ok') not in ('ok', 'error') or char_length(coalesce(v_r ->> 'error', '')) > 64 then
      raise exception 'receipt must be { delivery_id, status ok|error|null, error }' using errcode = 'invalid_parameter_value';
    end if;
    v_id := (v_r ->> 'delivery_id')::uuid;
    v_status := v_r ->> 'status';
    v_error := v_r ->> 'error';
    update public.push_deliveries set
      receipt_status = coalesce(v_status, receipt_status),
      receipt_error = case when v_status is null then receipt_error else v_error end,
      receipt_checked_at = now()
    where id = v_id
    returning token, user_id into v_token, v_user;
    if found then
      v_count := v_count + 1;
      if v_error = 'DeviceNotRegistered' and v_token is not null then
        update public.devices set push_token = null where user_id = v_user and push_token = v_token;
      end if;
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- the sweep: pg_cron -> dispatch_push -> pg_net -> push-sender (HMAC over a timestamp; the key
-- lives in vault as push_sender_hmac_key, the URL as push_sender_url)
-- ---------------------------------------------------------------------------
create or replace function private.push_sweep_signature(p_ts bigint, p_key text) returns text
language sql immutable set search_path = public as $$
  select p_ts::text || '.' || encode(extensions.hmac('push-sender-sweep:' || p_ts::text, p_key, 'sha256'), 'hex')
$$;

create or replace function private.dispatch_push() returns text
language plpgsql set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  -- the idle probe first: plain index lookups, no secrets read unless there is work
  if not exists (select 1 from public.inbox i where i.push_state in ('pending', 'deferred') and i.push_after <= now())
     and not exists (select 1 from public.inbox i where i.push_state = 'sending' and i.push_claimed_at < now() - interval '1 hour')
     and not exists (select 1 from public.push_deliveries d
                     where d.ticket_id is not null and d.receipt_status is null
                       and d.created_at <= now() - interval '15 minutes'
                       and (d.receipt_checked_at is null or d.receipt_checked_at <= now() - interval '15 minutes')) then
    return 'idle';
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'push_sender_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'push_sender_hmac_key';
  if coalesce(v_url, '') = '' or octet_length(coalesce(v_key, '')) < 32 then
    return 'unconfigured';
  end if;
  perform net.http_post(
    url := v_url,
    body := '{"reason":"sweep"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Sweep-Signature', private.push_sweep_signature(floor(extract(epoch from now()))::bigint, v_key)),
    timeout_milliseconds := 10000);
  return 'dispatched';
end $$;

-- ---------------------------------------------------------------------------
-- weekly recap: hourly; a user whose local time is Sunday 18:xx and who drove this week gets one
-- row per league week
-- ---------------------------------------------------------------------------
create or replace function private.produce_weekly_recaps() returns int
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_n int := 0;
  v_tz text;
  v_local timestamp;
  v_week text;
  v_utc timestamp := now() at time zone 'UTC';
begin
  -- Sunday 18:xx somewhere on Earth lies between Saturday 04:00 and Monday 08:00 UTC; outside that
  -- window nothing can be due and the fact table is not scanned
  if not ((extract(isodow from v_utc) = 6 and extract(hour from v_utc) >= 4) or extract(isodow from v_utc) = 7
          or (extract(isodow from v_utc) = 1 and extract(hour from v_utc) < 8)) then
    return 0;
  end if;
  for r in
    select distinct t.user_id from public.trips t where t.started_at > now() - interval '7 days' and t.merged_into is null
  loop
    v_tz := private.user_tz(r.user_id);
    v_local := now() at time zone v_tz;
    if extract(isodow from v_local) <> 7 or extract(hour from v_local) <> 18 then
      continue;
    end if;
    v_week := private.league_week(now());
    insert into public.inbox (user_id, kind, payload, dedupe_key)
    select r.user_id, 'weekly_recap',
      jsonb_build_object(
        'week', v_week,
        -- an unranked driver (under 25 mi in 30 days) is told nothing about a rating
        'rating', case when g.ranked then g.safety_rating end,
        'rating_delta', case when g.ranked and g.safety_rating is not null then g.safety_rating - private.rating_as_of(r.user_id, now() - interval '7 days') end,
        'streak', g.streak,
        'drives', private.week_drives(r.user_id, v_week),
        'week_points', private.week_points(r.user_id, v_week),
        'best_drive_net', (select max(t.points_net) from public.trips t
                           where t.user_id = r.user_id and t.league_week = v_week and t.scored and not t.not_driving and t.merged_into is null),
        -- this week's league standing (one rank lookup) and the last closed result
        'league', (select jsonb_build_object('rank', s.rank, 'tier', m.tier, 'size', l.member_count)
                   from public.league_members m join public.league_groups l on l.id = m.group_id
                   join private.league_standings(m.group_id) s on s.user_id = m.user_id
                   where m.week = v_week and m.user_id = r.user_id),
        'last_result', (select jsonb_build_object('week', m.week, 'result', m.result, 'final_rank', m.final_rank, 'tier', m.tier)
                        from public.league_members m where m.user_id = r.user_id and m.result is not null order by m.week desc limit 1)),
      'weekly_recap:' || v_week
    from public.progress g where g.user_id = r.user_id
    on conflict (user_id, dedupe_key) do nothing;
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

select cron.schedule('push-sender-sweep', '* * * * *', 'select private.dispatch_push()');
select cron.schedule('weekly-recap', '5 * * * *', 'select private.produce_weekly_recaps()');
select cron.schedule('inbox-purge', '40 3 * * *', $$delete from public.inbox where created_at < now() - interval '60 days'$$);

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.notification_prefs enable row level security;
alter table public.inbox enable row level security;
alter table public.push_deliveries enable row level security;
alter table public.job_leases enable row level security;

create policy notification_prefs_select_own on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.notification_prefs, public.inbox, public.push_deliveries, public.job_leases from anon, authenticated;
-- the server side (the secret key's service_role) is granted explicitly: Supabase no longer does it by default
grant select, insert, update, delete on public.notification_prefs, public.inbox, public.push_deliveries, public.job_leases to service_role;
grant select on public.notification_prefs to authenticated;

revoke all on function public.get_notification_prefs() from public, anon, authenticated;
revoke all on function public.set_notification_prefs(boolean, boolean, boolean, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.acquire_job_lease(text, text, int) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, text) from public, anon, authenticated;
revoke all on function public.claim_push_batch(int, int) from public, anon, authenticated;
revoke all on function public.record_push_outcomes(jsonb) from public, anon, authenticated;
revoke all on function public.push_receipts_due(int) from public, anon, authenticated;
revoke all on function public.record_push_receipts(jsonb) from public, anon, authenticated;
grant execute on function public.get_notification_prefs() to authenticated;
grant execute on function public.set_notification_prefs(boolean, boolean, boolean, boolean, text, text, text) to authenticated;
grant execute on function public.acquire_job_lease(text, text, int) to service_role;
grant execute on function public.release_job_lease(text, text) to service_role;
grant execute on function public.claim_push_batch(int, int) to service_role;
grant execute on function public.record_push_outcomes(jsonb) to service_role;
grant execute on function public.push_receipts_due(int) to service_role;
grant execute on function public.record_push_receipts(jsonb) to service_role;
