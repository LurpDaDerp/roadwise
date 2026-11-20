-- 0045_auth_mail_cap: the caps on the code mails the send-email hook sends (the sign-up
-- confirmation code, the password-reset code and the Apple/Google reminder, counted together),
-- and a password a confirmation never lets through.
--
--   * private.auth_mail_sends: one row per key the hook has mailed for, keyed by SHA-256, with two
--     fixed windows (an hour and a day). Three kinds of key: an inbox (the address as send-email
--     normalises it: lower case, no "+tag", a Gmail name without dots on gmail.com, so spellings
--     of one inbox share a row), the IP address the request came from ("ip:" + the IPv4 address
--     Auth reports, or its IPv6 address's /64 network, send-email's ipKey), and the two together ("pair:" + inbox + "|" + IP key). Neither the address nor the
--     IP is ever stored, only the hash. A row whose day ended more than a day ago is dropped the
--     next time anything is mailed.
--   * private.take_auth_mail(address hash, pair hash, ip hash): takes one mail for every key at
--     once, or for none. With an IP (pair and ip hashes both given): an inbox from one IP gets 5 an
--     hour and 10 a day ('pair'), an inbox from all IPs together 20 an hour and 30 a day
--     ('address'), and an IP 20 an hour and 50 a day across inboxes ('ip'). So one requester can't
--     use up an inbox's mails and lock its owner out of sign-up and Forgot password, while the
--     inbox's own ceiling still stops it being flooded from many IPs. With no IP reported (both
--     null), the inbox alone gets 5 an hour and 10 a day. 'ok' when taken. send-email calls it
--     before every mail, as postgres over a direct connection, and answers Auth with a 429 when it
--     is not 'ok', so Auth fails the request and the code is never stored.
--   * auth.users trigger clear_password_on_first_confirm: when an address is confirmed for the
--     first time (email_confirmed_at goes from null to a time) and the same update sets no new
--     password, the password the account had is cleared. Auth keeps the password of the first
--     sign-up to an address until the address is confirmed, whoever chose it, so without this the
--     password of someone who registered another person's address would work for the moment
--     between that person's code and the app setting their own password. The app sets the
--     driver's password right after every code (src/features/auth/emailPassword.ts).
--
-- The caps are keyed by address and IP, not by account: Auth calls the hook inside the transaction
-- that is creating the account, so the account's row is not visible yet (and public.rate_limits
-- needs it). The table lives in `private` (the Data API never exposes it), with RLS on and no
-- grant to any API role.
--
-- Deploy order: this migration, then send-email, then `config push` (which turns the hook on).

create table private.auth_mail_sends (
  key_hash bytea primary key check (octet_length(key_hash) = 32),
  hour_start timestamptz not null default now(),
  hour_count int not null default 0 check (hour_count >= 0),
  day_start timestamptz not null default now(),
  day_count int not null default 0 check (day_count >= 0)
);
create index auth_mail_sends_day_start_idx on private.auth_mail_sends (day_start);
alter table private.auth_mail_sends enable row level security;
revoke all on private.auth_mail_sends from public, anon, authenticated;

-- one key's row, made if missing, locked, and with any window that has run out started again;
-- its counts as they stand after that
create or replace function private.auth_mail_window(p_key bytea, out o_hour_count int, out o_day_count int)
language plpgsql volatile set search_path = '' as $$
begin
  insert into private.auth_mail_sends (key_hash) values (p_key) on conflict (key_hash) do nothing;
  update private.auth_mail_sends s
     set hour_start = case when s.hour_start + interval '1 hour' <= now() then now() else s.hour_start end,
         hour_count = case when s.hour_start + interval '1 hour' <= now() then 0 else s.hour_count end,
         day_start = case when s.day_start + interval '1 day' <= now() then now() else s.day_start end,
         day_count = case when s.day_start + interval '1 day' <= now() then 0 else s.day_count end
   where s.key_hash = p_key
   returning s.hour_count, s.day_count into o_hour_count, o_day_count;
end $$;

-- one mail for the inbox, the inbox from this IP and the IP whose SHA-256s are given (pair and ip
-- both null when Auth reported no IP): 'ok' when taken for all of them, else which cap is full
-- ('pair', 'address', then 'ip'), with nothing taken
create or replace function private.take_auth_mail(p_address_hash bytea, p_pair_hash bytea, p_ip_hash bytea) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_address_hour int;
  v_address_day int;
  v_pair_hour int;
  v_pair_day int;
  v_ip_hour int;
  v_ip_day int;
begin
  if p_address_hash is null or octet_length(p_address_hash) <> 32 then
    raise exception 'a 32-byte address hash is required' using errcode = 'invalid_parameter_value';
  end if;
  if (p_pair_hash is null) <> (p_ip_hash is null) then
    raise exception 'the pair and ip hashes come together or not at all' using errcode = 'invalid_parameter_value';
  end if;
  if p_ip_hash is not null and (octet_length(p_ip_hash) <> 32 or octet_length(p_pair_hash) <> 32
      or p_ip_hash = p_address_hash or p_pair_hash = p_address_hash or p_pair_hash = p_ip_hash) then
    raise exception 'the pair and ip hashes must be 32 bytes and all three different' using errcode = 'invalid_parameter_value';
  end if;
  -- rows whose day ended more than a day ago; one another mail has locked is left for later
  delete from private.auth_mail_sends
   where key_hash in (select key_hash from private.auth_mail_sends
                       where day_start < now() - interval '2 days' for update skip locked);
  -- always the inbox first, then the pair, then the IP: two calls never wait on each other in a
  -- circle (the three kinds of key never share a hash)
  select o_hour_count, o_day_count into v_address_hour, v_address_day from private.auth_mail_window(p_address_hash);
  if p_ip_hash is null then
    if v_address_hour >= 5 or v_address_day >= 10 then
      return 'address';
    end if;
  else
    select o_hour_count, o_day_count into v_pair_hour, v_pair_day from private.auth_mail_window(p_pair_hash);
    if v_pair_hour >= 5 or v_pair_day >= 10 then
      return 'pair';
    end if;
    if v_address_hour >= 20 or v_address_day >= 30 then
      return 'address';
    end if;
    select o_hour_count, o_day_count into v_ip_hour, v_ip_day from private.auth_mail_window(p_ip_hash);
    if v_ip_hour >= 20 or v_ip_day >= 50 then
      return 'ip';
    end if;
  end if;
  update private.auth_mail_sends
     set hour_count = hour_count + 1, day_count = day_count + 1
   where key_hash = p_address_hash or key_hash = p_pair_hash or key_hash = p_ip_hash;
  return 'ok';
end $$;

-- run only by send-email (postgres over a direct connection)
revoke all on function private.auth_mail_window(bytea) from public, anon, authenticated;
revoke all on function private.take_auth_mail(bytea, bytea, bytea) from public, anon, authenticated;

-- An address confirmed for the first time keeps no password it had before, unless the same update
-- sets a new one (an admin confirming and setting a password together). Runs as Auth's own role
-- inside Auth's update; touches nothing but the row being updated.
create or replace function private.clear_password_on_first_confirm() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null
     and new.encrypted_password is not distinct from old.encrypted_password
     and coalesce(old.encrypted_password, '') <> '' then
    new.encrypted_password := '';
  end if;
  return new;
end $$;

create trigger clear_password_on_first_confirm
  before update of email_confirmed_at on auth.users
  for each row execute function private.clear_password_on_first_confirm();
