-- 0033_auth_mail_cap: the per-address cap on the codes the send-email hook mails.
--
--   * private.auth_mail_sends: one row per address the hook has mailed, keyed by SHA256 of the
--     lower-cased address (the address itself is never stored), with two fixed windows: at most 5
--     mails in an hour and 10 in a day. A row whose day ended more than a day ago is dropped the
--     next time any address is mailed.
--   * private.take_auth_mail(hash): takes one mail for that address; false (nothing taken) when
--     either window is full. send-email (supabase/functions/send-email) calls it before every
--     sign-up code it sends, as postgres over a direct connection, and answers Auth with a 429 when
--     it is false, so Auth fails the request and the code is never stored.
--
-- It is keyed by the address, not the account: Auth calls the hook inside the transaction that is
-- creating the account, so the account's row is not visible yet (and public.rate_limits needs it).
-- The table lives in `private` (the Data API never exposes it), with RLS on and no grant to any API
-- role.
--
-- Deploy order: this migration, then send-email, then `config push` (which turns the hook on).

create table private.auth_mail_sends (
  address_hash bytea primary key check (octet_length(address_hash) = 32),
  hour_start timestamptz not null default now(),
  hour_count int not null default 0 check (hour_count >= 0),
  day_start timestamptz not null default now(),
  day_count int not null default 0 check (day_count >= 0)
);
create index auth_mail_sends_day_start_idx on private.auth_mail_sends (day_start);
alter table private.auth_mail_sends enable row level security;
revoke all on private.auth_mail_sends from public, anon, authenticated;

-- one mail for the address whose SHA256 is p_address_hash: true when taken, false when it has had
-- 5 this hour or 10 today (the count is not moved then)
create or replace function private.take_auth_mail(p_address_hash bytea) returns boolean
language plpgsql volatile set search_path = public as $$
declare
  v_hour_start timestamptz;
  v_hour_count int;
  v_day_start timestamptz;
  v_day_count int;
begin
  if p_address_hash is null or octet_length(p_address_hash) <> 32 then
    raise exception 'a 32-byte address hash is required' using errcode = 'invalid_parameter_value';
  end if;
  delete from private.auth_mail_sends where day_start < now() - interval '2 days';
  insert into private.auth_mail_sends (address_hash) values (p_address_hash)
    on conflict (address_hash) do nothing;
  select hour_start, hour_count, day_start, day_count
    into v_hour_start, v_hour_count, v_day_start, v_day_count
    from private.auth_mail_sends where address_hash = p_address_hash for update;
  if v_hour_start + interval '1 hour' <= now() then
    v_hour_start := now();
    v_hour_count := 0;
  end if;
  if v_day_start + interval '1 day' <= now() then
    v_day_start := now();
    v_day_count := 0;
  end if;
  if v_hour_count >= 5 or v_day_count >= 10 then
    update private.auth_mail_sends
      set hour_start = v_hour_start, hour_count = v_hour_count, day_start = v_day_start, day_count = v_day_count
      where address_hash = p_address_hash;
    return false;
  end if;
  update private.auth_mail_sends
    set hour_start = v_hour_start, hour_count = v_hour_count + 1, day_start = v_day_start, day_count = v_day_count + 1
    where address_hash = p_address_hash;
  return true;
end $$;

-- run only by send-email (postgres over a direct connection)
revoke all on function private.take_auth_mail(bytea) from public, anon, authenticated;
