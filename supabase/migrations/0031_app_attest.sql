-- 0031_app_attest: the keys an iPhone attested with Apple's App Attest, and the one-time challenges
-- they were attested against.
--
--   * private.app_attest_challenges: SHA256 of each challenge the app-attest function hands out,
--     per user, for 5 minutes and one use. At most 20 a user an hour.
--   * private.app_attest_keys: a key the app-attest function verified (Apple's certificate chain,
--     this app, a nonce over one of these challenges): its EC point, the highest assertion counter
--     it has signed with, and Apple's environment (production, or the sandbox where the function
--     allows it). A key belongs to one user; a user keeps at most 10 (the least recently used
--     go). At most 10 attestations a user a day.
--   * finalize-trip reads a user's key (locked) inside the upload's transaction, checks the
--     upload's assertion against it, and moves the counter up in the same transaction
--     (app_attest_advance: strictly above the stored one, so a replayed assertion never passes).
--     app_attest_context also says whether the account may post as Android: it has an Android
--     device registered and has never had an iPhone (no iOS device registered and no App Attest
--     key). Only then is an upload with no App Attest headers at all scored as an Android upload;
--     an account with an iPhone, attested or registered, attests every upload.
--   * register_device (as 0024) refuses to turn an install registered as an iPhone into an Android
--     device, so an iPhone account cannot re-label its own phone to post as Android.
--
-- Both tables live in `private` (the Data API never exposes it), with RLS on and no grant to any
-- API role; only these functions, run by the edge functions as postgres, read or write them. Both
-- go with the account (on delete cascade).
--
-- Deploy order: this migration, then app-attest and finalize-trip. The finalize-trip before this
-- one never calls these functions.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table private.app_attest_challenges (
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_hash bytea not null check (octet_length(challenge_hash) = 32),
  expires_at timestamptz not null,
  primary key (user_id, challenge_hash)
);

create table private.app_attest_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9+/]{43}=$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_key bytea not null check (octet_length(public_key) = 65 and substring(public_key from 1 for 1) = '\x04'::bytea),
  counter bigint not null default 0 check (counter between 0 and 4294967295),
  environment text not null check (environment in ('production', 'development')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
-- the per-user cap (least recently used first) and the account's cascade
create index app_attest_keys_user_idx on private.app_attest_keys (user_id, last_used_at desc);

alter table private.app_attest_challenges enable row level security;
alter table private.app_attest_keys enable row level security;
revoke all on private.app_attest_challenges, private.app_attest_keys from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
-- a challenge's hash, kept 5 minutes; false when the user has had 20 this hour
create or replace function private.app_attest_issue_challenge(p_user uuid, p_hash bytea) returns boolean
language plpgsql volatile set search_path = public as $$
begin
  if p_user is null or p_hash is null or octet_length(p_hash) <> 32 then
    raise exception 'user and a 32-byte challenge hash are required' using errcode = 'invalid_parameter_value';
  end if;
  if not private.take_rate_limit(p_user, 'app_attest_challenge', interval '1 hour', 20) then
    return false;
  end if;
  delete from private.app_attest_challenges where user_id = p_user and expires_at <= now();
  insert into private.app_attest_challenges (user_id, challenge_hash, expires_at) values (p_user, p_hash, now() + interval '5 minutes')
    on conflict (user_id, challenge_hash) do nothing;
  return true;
end $$;

-- one attestation's challenge, used up: 'taken' when it was the user's and still lived, 'unknown'
-- when not, 'limited' when the user has made 10 attestations today (the challenge then stays)
create or replace function private.app_attest_take_challenge(p_user uuid, p_hash bytea) returns text
language plpgsql volatile set search_path = public as $$
declare
  v_expires timestamptz;
begin
  if p_user is null or p_hash is null or octet_length(p_hash) <> 32 then
    raise exception 'user and a 32-byte challenge hash are required' using errcode = 'invalid_parameter_value';
  end if;
  if not private.take_rate_limit(p_user, 'app_attest_attest', interval '1 day', 10) then
    return 'limited';
  end if;
  delete from private.app_attest_challenges where user_id = p_user and challenge_hash = p_hash returning expires_at into v_expires;
  return case when v_expires is not null and v_expires > now() then 'taken' else 'unknown' end;
end $$;

-- ---------------------------------------------------------------------------
-- keys
-- ---------------------------------------------------------------------------
-- a verified key: 'saved', 'known' (this user's already, kept as it is) or 'taken' (another user's)
create or replace function private.app_attest_save_key(p_user uuid, p_key_id text, p_public_key bytea, p_environment text) returns text
language plpgsql volatile set search_path = public as $$
declare
  v_owner uuid;
begin
  if p_user is null or p_key_id is null or p_key_id !~ '^[A-Za-z0-9+/]{43}=$' or p_public_key is null or octet_length(p_public_key) <> 65
     or p_environment is null or p_environment not in ('production', 'development') then
    raise exception 'user, key id, a 65-byte key and an environment are required' using errcode = 'invalid_parameter_value';
  end if;
  insert into private.app_attest_keys (key_id, user_id, public_key, environment) values (p_key_id, p_user, p_public_key, p_environment)
    on conflict (key_id) do nothing;
  if not found then
    select user_id into v_owner from private.app_attest_keys where key_id = p_key_id;
    return case when v_owner = p_user then 'known' else 'taken' end;
  end if;
  -- at most 10 keys a user: the least recently used go
  delete from private.app_attest_keys k where k.user_id = p_user and k.key_id in (
    select x.key_id from private.app_attest_keys x where x.user_id = p_user order by x.last_used_at desc, x.created_at desc, x.key_id offset 10);
  return 'saved';
end $$;

-- what an upload's App Attest check reads: the user's key by id (locked until the upload's
-- transaction ends; null when the user has no such key, or none was named) and whether the account
-- may post as Android (`androidOnly`: an Android device registered, no iOS device registered and no
-- App Attest key)
create or replace function private.app_attest_context(p_user uuid, p_key_id text) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  k private.app_attest_keys%rowtype;
  v_key jsonb := null;
begin
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_key_id is not null then
    select * into k from private.app_attest_keys x where x.key_id = p_key_id and x.user_id = p_user for update;
    if found then
      v_key := jsonb_build_object('publicKey', encode(k.public_key, 'hex'), 'counter', k.counter, 'environment', k.environment);
    end if;
  end if;
  return jsonb_build_object('key', v_key,
    'androidOnly', exists (select 1 from public.devices d where d.user_id = p_user and d.platform = 'android')
      and not exists (select 1 from public.devices d where d.user_id = p_user and d.platform = 'ios')
      and not exists (select 1 from private.app_attest_keys x where x.user_id = p_user));
end $$;

-- an assertion's counter, stored: true only when it is above the key's (and the key is the user's)
create or replace function private.app_attest_advance(p_user uuid, p_key_id text, p_counter bigint) returns boolean
language plpgsql volatile set search_path = public as $$
begin
  if p_user is null or p_key_id is null or p_counter is null or p_counter not between 1 and 4294967295 then
    raise exception 'user, key id and a counter are required' using errcode = 'invalid_parameter_value';
  end if;
  update private.app_attest_keys set counter = p_counter, last_used_at = now()
    where key_id = p_key_id and user_id = p_user and counter < p_counter;
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- register_device: an iPhone's row stays an iPhone's
-- ---------------------------------------------------------------------------
-- register_device(p_device_id, p_platform, p_push_token, p_live_activity_token) -> { league_eligible }
-- As 0024, and an install this account registered as 'ios' is refused as 'android' (the row and its
-- tokens are left as they were). A phone's platform never changes, so no real install meets it.
create or replace function public.register_device(p_device_id text, p_platform text, p_push_token text default null,
  p_live_activity_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_eligible boolean;
  v_known boolean;
  v_token_claimed boolean := false;
  v_released uuid;
begin
  if v_uid is null then
    raise exception 'register_device requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'platform must be ios or android' using errcode = 'invalid_parameter_value';
  end if;
  if p_push_token is not null and p_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid push token' using errcode = 'invalid_parameter_value';
  end if;
  if p_live_activity_token is not null and (p_platform <> 'ios' or p_live_activity_token !~ '^[0-9a-f]{32,200}$') then
    raise exception 'invalid live activity token' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'register_device', interval '1 hour', 60);
  v_known := exists (select 1 from public.devices d where d.user_id = v_uid and d.device_id = p_device_id);
  -- an install registered as an iPhone stays one: it cannot be re-labelled to post as Android
  if p_platform = 'android' and exists (select 1 from public.devices d where d.user_id = v_uid and d.device_id = p_device_id and d.platform = 'ios') then
    raise exception 'an iOS device cannot become an Android device' using errcode = 'invalid_parameter_value';
  end if;
  if not v_known then
    perform private.require_rate_limit(v_uid, 'register_device_new', interval '1 day', 10);
  end if;
  -- the token's previous holder owns a claim on that install: this account gets none for it
  if p_push_token is not null then
    v_token_claimed := exists (
      select 1 from public.devices d join public.device_league_claims c on c.user_id = d.user_id and c.device_id = d.device_id
      where d.push_token = p_push_token and d.user_id <> v_uid);
  end if;
  insert into public.devices (user_id, device_id, platform, push_token, live_activity_token, last_seen_at)
    values (v_uid, p_device_id, p_platform, p_push_token, p_live_activity_token, now())
  on conflict (user_id, device_id) do update
    set platform = excluded.platform,
        push_token = coalesce(excluded.push_token, public.devices.push_token),
        live_activity_token = coalesce(excluded.live_activity_token, public.devices.live_activity_token),
        last_seen_at = now();
  -- a token moves with the device: no other account keeps it
  if p_push_token is not null then
    update public.devices set push_token = null where push_token = p_push_token and user_id <> v_uid;
  end if;
  -- the push-to-start token belongs to one install: no other row keeps it
  if p_live_activity_token is not null then
    update public.devices set live_activity_token = null, live_activity_drive = null, live_activity_leg = null, live_activity_sent_at = null
      where live_activity_token = p_live_activity_token and not (user_id = v_uid and device_id = p_device_id);
  end if;
  -- at most 10 device rows per account: the least recently seen go
  delete from public.devices d where d.user_id = v_uid and d.device_id in (
    select x.device_id from public.devices x where x.user_id = v_uid order by x.last_seen_at desc, x.device_id offset 10);
  -- a claim whose holder has not been seen on the device for 90 days is released
  delete from public.device_league_claims c
    where c.device_id = p_device_id and c.user_id <> v_uid
      and not exists (select 1 from public.devices d where d.user_id = c.user_id and d.device_id = c.device_id and d.last_seen_at > now() - interval '90 days')
    returning c.user_id into v_released;
  if v_released is not null then
    update public.profiles set league_eligible = exists (select 1 from public.device_league_claims c where c.user_id = v_released) where id = v_released;
  end if;
  if not v_token_claimed and (select count(*) from public.device_league_claims c where c.user_id = v_uid) < 3 then
    insert into public.device_league_claims (device_id, user_id) values (p_device_id, v_uid)
      on conflict (device_id) do nothing;
  end if;
  v_eligible := exists (select 1 from public.device_league_claims c where c.user_id = v_uid);
  update public.profiles set league_eligible = v_eligible where id = v_uid and league_eligible is distinct from v_eligible;
  return jsonb_build_object('league_eligible', v_eligible);
end $$;

-- ---------------------------------------------------------------------------
-- grants: run only by the edge functions (postgres over a direct connection)
-- ---------------------------------------------------------------------------
revoke all on function private.app_attest_issue_challenge(uuid, bytea) from public, anon, authenticated;
revoke all on function private.app_attest_take_challenge(uuid, bytea) from public, anon, authenticated;
revoke all on function private.app_attest_save_key(uuid, text, bytea, text) from public, anon, authenticated;
revoke all on function private.app_attest_context(uuid, text) from public, anon, authenticated;
revoke all on function private.app_attest_advance(uuid, text, bigint) from public, anon, authenticated;
-- register_device stays the signed-in client's to call, as in 0024
revoke all on function public.register_device(text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_device(text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
