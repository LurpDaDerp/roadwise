-- hosted safety (T5 review): fail fast on a lock rather than queue in front of apply_trip
set lock_timeout = '5s';

-- 0011_referral: referral codes, redemption and qualification (§R10), off by default behind
-- feature_flags.referral (R-F).
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * public.referral_codes (#1, #9, #10, #11): one permanent 8-character code per user. RLS on, no
--     policies, no grants: read only through get_my_referral_code and my_referrals.
--   * public.referrals (#1, #10, #11): one row per invitee (unique invitee_id). RLS on, no policies, no
--     grants. Neither party ever reads the other's id, name, dates or drives: the RPCs return counts
--     and the caller's own status only.
--   * public.push_token_seen (R-C; append-only, documented): sha256 of every Expo token ever registered
--     to a user, never the raw token. Filled by record_push_token_seen (a non-definer trigger on
--     push_registrations, which only 0007's definer RPC writes, so it runs as postgres) and backfilled
--     here. Purged after 400 days by purge_reward_audit (replaced here, bounded; r1-M2).
--   * badge_defs row referrals_1 (its producer is here).
--   * normalise_referral_code(text): exactly packages/scoring's normaliseReferralCode (JS \s and the
--     hyphen removed, then upper-cased); the test vectors are shared with the jest parity test.
--   * client RPCs (#5, #6; definer, owner postgres, proconfig exactly search_path=public,
--     lock_timeout=2s, auth.uid() first, u13 refused, the flag checked server-side):
--     get_my_referral_code(), redeem_referral_code(text), my_referrals().
--   * settle_referrals(uuid, timestamptz) (non-definer, no API execute) and the replaced
--     refresh_progress (counts referrals_rewarded), settle_rewards (the referral step after challenges)
--     and minimise_underage_rewards (the three new tables; R-H's class reset kept).
--   * feature_flags.referral: added OFF only where the key is absent (R-F, security rule 4); turning it
--     on is an operator step.
--
-- §R10 Redemption, in exactly this order (R-D; no code is looked up before the caller is eligible):
-- the caller's account is at most 14 days old ('code window closed'); the caller has not redeemed
-- before ('already used a code'); the caller's budget, 10 attempts per 24 h ('too many attempts');
-- the code's pattern after normalisation ('invalid code'); only then the global budget, 500
-- well-formed redemptions per rolling hour ('too many attempts', the same message; r1-M3: malformed
-- input never drains it); then the lookup ('invalid code', the same message as a malformed code) and
-- 'this is your own code'. Exhausted budgets log a count only ("referral redeem budget exhausted:
-- user|global"), never a user id or a code.
-- WHY refusals after the budget take are RETURNED, not raised: a raised error rolls the whole RPC
-- back, and the budget take with it, so wrong guesses would cost nothing. After the take, a refusal
-- therefore returns exactly the body PostgREST gives a raised error ({ code, details, hint, message })
-- and sets response.status (400 for 22023, 403 for 42501), so the transaction commits the take and
-- the client sees one shape and one status per message either way. The refusals before the take
-- (not signed in, u13, the flag, the window, already used, the user budget itself) raise.
-- Qualification, in the invitee's settlement (so it waits for the day to settle): at least 3 final,
-- not-deleted driver drives that started after redemption and within 90 days of it, on settled days
-- on or after progress.rewards_start (a day's reward row settled normally, not I-A's frozen late-day
-- row); then the device check (R-C: the two users' devices.id sets or
-- their push_token_seen hash sets intersect → rejected / shared_device, silent to both). Qualified →
-- the invitee +500 (`referral:invitee:<id>`) and the referrer enqueued at once; the referrer is
-- credited in their own settlement (`referral:referrer:<id>`) unless 20 were rewarded in the last
-- 365 days (then recorded unrewarded, referrer_cap). Not qualified by referral_final_at (90 d + 125 h, the
-- last in-window day's latest close plus the settlement cap) → expired; schedule_next_settle (replaced
-- here) wakes a pending invitee just after that bound.
--
-- Settlement order now: u13 check; zone; progress lock; settle_days; append_streak; settle_goals;
-- settle_challenges; settle_referrals; refresh_progress; settle_badges; refresh_progress;
-- emit_reward_events; schedule_next_settle.
--
-- Nothing from 0001-0010 is edited except: a trigger on push_registrations, the badge row, the flag
-- key, and `create or replace` of the four functions above and of schedule_next_settle.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table public.referral_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  invitee_id uuid not null unique references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'qualified', 'rejected', 'expired')),
  reject_reason text null check (reject_reason in ('shared_device')),
  redeemed_at timestamptz not null,
  qualified_at timestamptz null,
  invitee_rewarded boolean not null default false,
  -- null until the referrer's settlement decides
  referrer_rewarded boolean null,
  referrer_cap boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referrals_two_people check (referrer_id <> invitee_id)
);
create index referrals_referrer_status_idx on public.referrals (referrer_id, status);

-- append-only (documented): hashes only
create table public.push_token_seen (
  user_id uuid not null references auth.users(id) on delete cascade,
  token_sha256 bytea not null check (octet_length(token_sha256) = 32),
  first_seen_at timestamptz not null default now(),
  primary key (user_id, token_sha256)
);
create index push_token_seen_token_idx on public.push_token_seen (token_sha256);
-- the retention purge's scan
create index push_token_seen_first_seen_idx on public.push_token_seen (first_seen_at);

create trigger referral_codes_touch before update on public.referral_codes for each row execute function public.touch_updated_at();
create trigger referrals_touch before update on public.referrals for each row execute function public.touch_updated_at();
create trigger referral_codes_refuse_underage before insert on public.referral_codes for each row execute function public.refuse_underage_writes();
create trigger push_token_seen_refuse_underage before insert on public.push_token_seen for each row execute function public.refuse_underage_writes();

-- (R-C) every registration's token hash, kept after the registration moves or goes
create or replace function public.record_push_token_seen() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into public.push_token_seen (user_id, token_sha256)
  values (new.user_id, extensions.digest(new.token, 'sha256'))
  on conflict (user_id, token_sha256) do nothing;
  return null;
end $$;
create trigger push_registrations_token_seen after insert or update of user_id on public.push_registrations
  for each row execute function public.record_push_token_seen();
insert into public.push_token_seen (user_id, token_sha256)
  select r.user_id, extensions.digest(r.token, 'sha256') from public.push_registrations r
  where not exists (select 1 from public.profiles p where p.id = r.user_id and p.age_band = 'u13')
  on conflict (user_id, token_sha256) do nothing;

insert into public.badge_defs (id, family, tier, metric, threshold, sort) values ('referrals_1', 'referrals', 'bronze', 'referrals', 1, 16)
  on conflict (id) do nothing;

-- R-F: the key is added OFF only where absent; an operator's value is never overwritten
insert into public.app_config (key, value, is_public) values ('feature_flags', '{"referral": false}', true)
  on conflict (key) do nothing;
update public.app_config set value = value || '{"referral": false}'::jsonb
  where key = 'feature_flags' and not value ? 'referral';

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
-- packages/scoring normaliseReferralCode: input.replace(/[\s-]/g, '').toUpperCase(). The class is JS's
-- \s exactly (ECMAScript WhiteSpace and LineTerminator), plus the ASCII hyphen-minus.
create or replace function public.normalise_referral_code(p_input text) returns text
language sql immutable set search_path = public as $$
  select upper(regexp_replace(p_input,
    '[' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
        || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)
        || '-]', '', 'g'))
$$;

create or replace function public.referrals_available() returns boolean
language sql stable set search_path = public as $$
  select coalesce((select (value -> 'referral') = 'true'::jsonb from public.app_config where key = 'feature_flags'), false)
$$;

-- (fix round 2, I1/m2) the instant after which a pending referral's count is final. Its last countable drive
-- starts at redeemed_at + QUALIFY_WITHIN_D. That drive's local day ends at most 25 h later (24 h, or 25 on
-- a DST fall-back day); reward_wall_close is the LATEST 02:00 over all of the day's trip zones, up to 26 h
-- past the drive's own zone's (UTC+14 against UTC-12), plus the 2 h itself; and reward_day_ready settles
-- the day at the latest SETTLE_CAP_H after that close. So 90 d + (25 + 26 + 2 + 72) h = 90 d + 125 h:
-- by then every in-window day has settled (in the same settlement, before settle_referrals runs), and
-- the referral qualifies or expires, never earlier. my_referrals and settle_referrals both read it.
create or replace function public.referral_final_at(p_redeemed_at timestamptz) returns timestamptz
language sql immutable set search_path = public as $$
  select p_redeemed_at + make_interval(days => (public.reward_rules() -> 'REFERRAL' ->> 'QUALIFY_WITHIN_D')::int,
    hours => 25 + 26 + 2 + (public.reward_rules() ->> 'SETTLE_CAP_H')::int)
$$;

-- a refusal that must not roll back the budget take: the body PostgREST gives a raised error, and its status
create or replace function public.referral_refusal(p_sqlstate text, p_message text) returns jsonb
language plpgsql set search_path = public as $$
begin
  perform set_config('response.status', case p_sqlstate when '42501' then '403' else '400' end, true);
  return jsonb_build_object('code', p_sqlstate, 'details', null, 'hint', null, 'message', p_message);
end $$;

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- { code }, created on first call
create or replace function public.get_my_referral_code() returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_alphabet constant text := public.reward_rules() -> 'REFERRAL' ->> 'CODE_ALPHABET';
  v_len constant int := (public.reward_rules() -> 'REFERRAL' ->> 'CODE_LENGTH')::int;
  v_code text;
  v_bytes bytea;
  v_b int;
  v_retries int := 0;
begin
  if v_uid is null then
    raise exception 'get_my_referral_code requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if not public.referrals_available() then
    raise exception 'referrals are not available yet' using errcode = 'insufficient_privilege';
  end if;
  select c.code into v_code from public.referral_codes c where c.user_id = v_uid;
  while v_code is null loop
    -- rejection sampling: bytes 0..247 map evenly onto the 31 letters, 248..255 are discarded
    v_code := '';
    while char_length(v_code) < v_len loop
      v_bytes := extensions.gen_random_bytes(16);
      for i in 0 .. 15 loop
        v_b := get_byte(v_bytes, i);
        if v_b < 248 then
          v_code := v_code || substr(v_alphabet, (v_b % 31) + 1, 1);
          exit when char_length(v_code) = v_len;
        end if;
      end loop;
    end loop;
    begin
      insert into public.referral_codes (user_id, code) values (v_uid, v_code)
        on conflict (user_id) do nothing;
      select c.code into v_code from public.referral_codes c where c.user_id = v_uid;
    exception when unique_violation then
      v_code := null;
      v_retries := v_retries + 1;
      if v_retries > 5 then
        raise;
      end if;
    end;
  end loop;
  return jsonb_build_object('code', v_code);
end $$;

-- R-D: eligibility, then the caller's budget, then the pattern, then the global budget, then the lookup
create or replace function public.redeem_referral_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_ref jsonb := public.reward_rules() -> 'REFERRAL';
  v_created timestamptz;
  v_count int;
  v_start timestamptz;
  v_code text;
  v_referrer uuid;
begin
  if v_uid is null then
    raise exception 'redeem_referral_code requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if not public.referrals_available() then
    raise exception 'referrals are not available yet' using errcode = 'insufficient_privilege';
  end if;
  select u.created_at into v_created from auth.users u where u.id = v_uid;
  if v_created is null or v_created < now() - make_interval(days => (v_ref ->> 'REDEEM_WITHIN_D')::int) then
    raise exception 'code window closed' using errcode = 'invalid_parameter_value';
  end if;
  -- the caller's rate_limits row is the mutex around the checks below and the attempt budget
  insert into public.rate_limits (user_id, key) values (v_uid, 'referral_redeem') on conflict (user_id, key) do nothing;
  select rl.count, rl.window_start into v_count, v_start from public.rate_limits rl
    where rl.user_id = v_uid and rl.key = 'referral_redeem' for update;
  if exists (select 1 from public.referrals r where r.invitee_id = v_uid) then
    raise exception 'already used a code' using errcode = 'invalid_parameter_value';
  end if;
  if v_start <= now() - interval '24 hours' then
    v_count := 0;
    v_start := now();
  end if;
  if v_count >= (v_ref ->> 'REDEEM_ATTEMPTS_PER_DAY')::int then
    raise log 'referral redeem budget exhausted: user';
    raise exception 'too many attempts' using errcode = 'insufficient_privilege';
  end if;
  update public.rate_limits set count = v_count + 1, window_start = v_start where user_id = v_uid and key = 'referral_redeem';

  -- from here every refusal is returned (the take above must commit)
  v_code := public.normalise_referral_code(p_code);
  if v_code is null or v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$' then
    return public.referral_refusal('22023', 'invalid code');
  end if;
  insert into public.global_rate_limits (key, window_start, count) values ('referral_redeem_global', now(), 0)
    on conflict (key) do nothing;
  select g.count, g.window_start into v_count, v_start from public.global_rate_limits g where g.key = 'referral_redeem_global' for update;
  if v_start + interval '1 hour' <= now() then
    v_count := 0;
    v_start := now();
  end if;
  if v_count >= (v_ref ->> 'GLOBAL_REDEEM_PER_HOUR')::int then
    raise log 'referral redeem budget exhausted: global';
    return public.referral_refusal('42501', 'too many attempts');
  end if;
  update public.global_rate_limits set count = v_count + 1, window_start = v_start where key = 'referral_redeem_global';

  select c.user_id into v_referrer from public.referral_codes c where c.code = v_code;
  if v_referrer is null then
    return public.referral_refusal('22023', 'invalid code');
  end if;
  if v_referrer = v_uid then
    return public.referral_refusal('22023', 'this is your own code');
  end if;
  insert into public.referrals (referrer_id, invitee_id, status, redeemed_at) values (v_referrer, v_uid, 'pending', now());
  return jsonb_build_object('status', 'pending');
end $$;

-- counts and the caller's own status only: nothing about the other party
create or replace function public.my_referrals() returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_ref jsonb := public.reward_rules() -> 'REFERRAL';
  v_mine public.referrals%rowtype;
  v_created timestamptz;
begin
  if v_uid is null then
    raise exception 'my_referrals requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if not public.referrals_available() then
    raise exception 'referrals are not available yet' using errcode = 'insufficient_privilege';
  end if;
  select * into v_mine from public.referrals r where r.invitee_id = v_uid;
  select u.created_at into v_created from auth.users u where u.id = v_uid;
  return jsonb_build_object(
    'code', (select c.code from public.referral_codes c where c.user_id = v_uid),
    'joined', (select count(*) from public.referrals r where r.referrer_id = v_uid),
    'qualified', (select count(*) from public.referrals r where r.referrer_id = v_uid and r.status = 'qualified'),
    'rewardedThisYear', (select count(*) from public.referrals r where r.referrer_id = v_uid and r.referrer_rewarded
                          and r.qualified_at > now() - interval '365 days'),
    'cap', (v_ref ->> 'YEARLY_CAP')::int,
    'canRedeem', coalesce(v_mine.id is null and v_created >= now() - make_interval(days => (v_ref ->> 'REDEEM_WITHIN_D')::int), false),
    'myCode', case
      when v_mine.id is null then 'none'
      when v_mine.status = 'qualified' then 'counted'
      -- (fix rounds 1-2, m2) pending until its count is final (referral_final_at), so it never flips to counted
      when v_mine.status = 'pending' and now() <= public.referral_final_at(v_mine.redeemed_at) then 'pending'
      else 'not_counted' end);
end $$;

-- ---------------------------------------------------------------------------
-- settlement
-- ---------------------------------------------------------------------------
-- §R10 both sides for p_user; returns referral_qualified events
create or replace function public.settle_referrals(p_user uuid, p_now timestamptz) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_ref jsonb := public.reward_rules() -> 'REFERRAL';
  v_points int := (public.reward_rules() -> 'POINTS' ->> 'referral')::int;
  v_start date;
  v_r public.referrals%rowtype;
  v_drives int;
  v_rewarded int;
  v_events jsonb := '[]'::jsonb;
begin
  select pr.rewards_start into v_start from public.progress pr where pr.user_id = p_user;

  -- the invitee's side
  select * into v_r from public.referrals r where r.invitee_id = p_user and r.status = 'pending' for update;
  if v_r.id is not null then
    select count(*) into v_drives from public.trips t
      where t.user_id = p_user and t.status = 'final' and t.role = 'driver' and t.deleted_at is null
        and t.started_at > v_r.redeemed_at
        and t.started_at <= v_r.redeemed_at + make_interval(days => (v_ref ->> 'QUALIFY_WITHIN_D')::int)
        and t.local_day >= coalesce(v_start, '-infinity'::date)
        -- (fix round 1, m1) a day settled normally: I-A's frozen late-day row (neutral / no_drive) never earns,
        -- and a real no_drive day has no final driver drive to count anyway
        and exists (select 1 from public.reward_days rd where rd.user_id = p_user and rd.day = t.local_day
                    and rd.outcome_reason <> 'no_drive');
    if v_drives >= (v_ref ->> 'QUALIFYING_DRIVES')::int then
      if exists (select 1 from public.devices a join public.devices b on b.id = a.id
                 where a.user_id = p_user and b.user_id = v_r.referrer_id)
         or exists (select 1 from public.push_token_seen a join public.push_token_seen b on b.token_sha256 = a.token_sha256
                    where a.user_id = p_user and b.user_id = v_r.referrer_id) then
        update public.referrals set status = 'rejected', reject_reason = 'shared_device' where id = v_r.id;
      else
        update public.referrals set status = 'qualified', qualified_at = p_now, invitee_rewarded = true where id = v_r.id;
        if public.reward_credit(p_user, 'referral', v_points, v_r.id::text, 'referral:invitee:' || v_r.id) then
          v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'referral_qualified',
            'payload', jsonb_build_object('role', 'invitee', 'points', v_points),
            'dedupe_key', 'referral_qualified:invitee:' || v_r.id, 'priority', 5));
        end if;
        -- the referrer is credited in their own settlement, as soon as the sweep reaches them
        insert into public.reward_due (user_id, due_at) values (v_r.referrer_id, p_now)
          on conflict (user_id) do update set due_at = least(public.reward_due.due_at, excluded.due_at);
      end if;
    -- (fix round 2, I1) only once every in-window day has settled: a last-day drive held by the watermark
    -- still counts when it settles
    elsif p_now > public.referral_final_at(v_r.redeemed_at) then
      update public.referrals set status = 'expired' where id = v_r.id;
    end if;
  end if;

  -- the referrer's side, oldest first, within the yearly cap
  for v_r in
    select * from public.referrals r where r.referrer_id = p_user and r.status = 'qualified' and r.referrer_rewarded is null
    order by r.qualified_at, r.id for update
  loop
    select count(*) into v_rewarded from public.referrals r
      where r.referrer_id = p_user and r.referrer_rewarded and r.qualified_at > p_now - interval '365 days';
    if v_rewarded >= (v_ref ->> 'YEARLY_CAP')::int then
      update public.referrals set referrer_rewarded = false, referrer_cap = true where id = v_r.id;
    else
      update public.referrals set referrer_rewarded = true where id = v_r.id;
      if public.reward_credit(p_user, 'referral', v_points, v_r.id::text, 'referral:referrer:' || v_r.id) then
        v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'referral_qualified',
          'payload', jsonb_build_object('role', 'referrer', 'points', v_points),
          'dedupe_key', 'referral_qualified:referrer:' || v_r.id, 'priority', 5));
      end if;
    end if;
  end loop;
  return v_events;
end $$;

-- 0010's refresh_progress, now also counting rewarded referrals (the referrer's side)
create or replace function public.refresh_progress(p_user uuid) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_rules jsonb := public.reward_rules();
  v_points int;
  v_old int;
  v_level int;
  v_name text;
begin
  select coalesce(sum(l.amount), 0) into v_points from public.points_ledger l where l.user_id = p_user;
  select coalesce(max((lv ->> 'level')::int), 1) into v_level
    from jsonb_array_elements(v_rules -> 'LEVELS') lv where (lv ->> 'xp')::int <= v_points;
  select pr.level into v_old from public.progress pr where pr.user_id = p_user;
  update public.progress pr set
    points = v_points, xp = v_points, level = greatest(v_level, coalesce(v_old, 1)),
    safe_days = (select count(*) from public.reward_days rd where rd.user_id = p_user and rd.outcome = 'safe'),
    phone_free_days = (select count(*) from public.reward_days rd where rd.user_id = p_user and rd.predicates ->> 'phone' = 'pass'),
    smooth_days = (select count(*) from public.reward_days rd where rd.user_id = p_user and rd.predicates ->> 'smooth' = 'pass'),
    goals_achieved = (select count(*) from public.weekly_goals g where g.user_id = p_user and g.state = 'achieved'),
    challenges_completed = (select count(*) from public.user_challenges uc where uc.user_id = p_user and uc.state = 'completed'),
    referrals_rewarded = (select count(*) from public.referrals r where r.referrer_id = p_user and r.referrer_rewarded)
    where pr.user_id = p_user;
  if v_level > coalesce(v_old, 1) then
    update public.profiles set level = v_level where id = p_user and level is distinct from v_level;
    select lv ->> 'name' into v_name from jsonb_array_elements(v_rules -> 'LEVELS') lv where (lv ->> 'level')::int = v_level;
    return jsonb_build_array(jsonb_build_object('type', 'level_up',
      'payload', jsonb_build_object('kind', 'level', 'level', v_level, 'name', v_name),
      'dedupe_key', 'level_up:level:' || v_level, 'priority', 3));
  end if;
  return '[]'::jsonb;
end $$;

-- 0010's orchestrator with the referral step after challenges (the full order is in the header)
create or replace function public.settle_rewards(p_user uuid, p_now timestamptz, p_lease timestamptz default null) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_tz text;
  v_ledger int;
  v_contra int;
  v_days date[];
  v_events jsonb;
begin
  if exists (select 1 from public.profiles p where p.id = p_user and p.age_band = 'u13') then
    delete from public.reward_due where user_id = p_user;
    return jsonb_build_object('skipped', 'u13');
  end if;
  v_tz := coalesce(public.user_tz(p_user), 'UTC');
  insert into public.progress (user_id) values (p_user) on conflict (user_id) do nothing;
  perform 1 from public.progress where user_id = p_user for update;
  select count(*) into v_ledger from public.points_ledger where user_id = p_user;
  select count(*) into v_contra from public.reward_contradictions where user_id = p_user;

  v_days := public.settle_days(p_user, v_tz, p_now);
  v_events := public.append_streak(p_user, v_days);
  v_events := v_events || public.settle_goals(p_user, v_tz, p_now, v_days);
  v_events := v_events || public.settle_challenges(p_user, p_now);
  v_events := v_events || public.settle_referrals(p_user, p_now);
  v_events := v_events || public.refresh_progress(p_user);
  v_events := v_events || public.settle_badges(p_user);
  v_events := v_events || public.refresh_progress(p_user);
  perform public.emit_reward_events(p_user, v_events, v_tz, p_now);
  perform public.schedule_next_settle(p_user, v_tz, p_now, p_lease);

  return jsonb_build_object('settledDays', cardinality(v_days),
    'ledgerRows', (select count(*) from public.points_ledger where user_id = p_user) - v_ledger,
    'contradictions', (select count(*) from public.reward_contradictions where user_id = p_user) - v_contra,
    'events', jsonb_array_length(v_events));
end $$;

-- 0010's minimisation, also covering the referral tables (R-H's class reset kept). It deletes every
-- referral row the user is in, the OTHER party's side included: the row names the child, so it cannot stay.
-- The counterpart keeps any ledger credit and badge already given; a referrer's referrals_rewarded counter
-- drops by one at their next refresh (fix round 2, n2).
create or replace function public.minimise_underage_rewards() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce(auth.uid() = new.id, false)
          or coalesce(auth.role() = 'service_role', false)
          or (auth.uid() is null and session_user = 'postgres')) then
    raise exception 'minimise_underage_rewards requires the account owner or the service role' using errcode = 'insufficient_privilege';
  end if;
  delete from public.referrals where referrer_id = new.id or invitee_id = new.id;
  delete from public.referral_codes where user_id = new.id;
  delete from public.push_token_seen where user_id = new.id;
  delete from public.user_badges where user_id = new.id;
  delete from public.user_challenges where user_id = new.id;
  delete from public.points_ledger where user_id = new.id;
  delete from public.reward_days where user_id = new.id;
  delete from public.weekly_goals where user_id = new.id;
  delete from public.reward_due where user_id = new.id;
  delete from public.reward_contradictions where user_id = new.id;
  delete from public.progress where user_id = new.id;
  update public.profiles set level = 1 where id = new.id and level <> 1;
  return null;
end $$;

-- 0009's §R8 scheduler, now also waking a pending invitee just after referral_final_at (fix round 2, I1), so
-- an invitee who stops driving still has the referral expired
create or replace function public.schedule_next_settle(p_user uuid, p_tz text, p_now timestamptz, p_lease timestamptz) returns timestamptz
language plpgsql set search_path = public as $$
declare
  v_frontier date;
  v_close timestamptz;
  v_next timestamptz;
  v_goal record;
  v_count int;
  v_start date;
  v_final timestamptz;
begin
  -- lock the queue row BEFORE reading the facts: an apply_trip that committed earlier is then in the
  -- facts, and one that commits later waits for this transaction and lowers (or re-inserts) the row
  -- after it, so a new day is never lost between the read and the write
  perform 1 from public.reward_due where user_id = p_user for update;
  select pr.settled_through, pr.rewards_start into v_frontier, v_start from public.progress pr where pr.user_id = p_user;
  select x.wall_close into v_close
    from public.reward_day_facts(p_user, greatest(coalesce(v_frontier + 1, '-infinity'::date), coalesce(v_start, '-infinity'::date)),
      'infinity'::date, p_tz) x order by x.day limit 1;
  if v_close is not null then
    v_next := public.reward_retry_at(v_close, p_now);
  end if;
  for v_goal in
    select g.week_start from public.weekly_goals g
    where g.user_id = p_user and g.state = 'active' and g.pass_days + g.fail_days > 0
  loop
    v_close := public.reward_wall_close(v_goal.week_start + 6,
      coalesce((select array_agg(distinct tr.tz) from public.trips tr where tr.user_id = p_user and tr.local_day = v_goal.week_start + 6),
               array[coalesce(p_tz, 'UTC')]));
    v_next := least(v_next, public.reward_retry_at(v_close, p_now));
  end loop;
  -- a pending referral is settled (then pending means p_now <= its bound) one minute after its bound
  select public.referral_final_at(r.redeemed_at) into v_final from public.referrals r where r.invitee_id = p_user and r.status = 'pending';
  if v_final is not null then
    v_next := least(v_next, v_final + interval '1 minute');
  end if;
  -- (review m2) a time at or before now is never written: the sweep would pick the user again at once
  if v_next is not null and v_next <= p_now then
    v_next := p_now + interval '1 minute';
  end if;

  if p_lease is null then
    if v_next is null then
      delete from public.reward_due where user_id = p_user;
    else
      insert into public.reward_due (user_id, due_at) values (p_user, v_next)
        on conflict (user_id) do update set due_at = excluded.due_at, failures = 0;
    end if;
  elsif v_next is null then
    -- only an untouched lease is deleted: a concurrent enqueue keeps its row
    delete from public.reward_due where user_id = p_user and due_at = p_lease;
  else
    update public.reward_due
      set due_at = case when due_at = p_lease then v_next else least(v_next, due_at) end,
          failures = case when due_at = p_lease then 0 else failures end
      where user_id = p_user;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      insert into public.reward_due (user_id, due_at) values (p_user, v_next)
        on conflict (user_id) do update set due_at = least(public.reward_due.due_at, excluded.due_at);
    end if;
  end if;
  return v_next;
end $$;

-- 0009's retention, also purging push_token_seen after 400 days (r1-M2), each bounded the same way
create or replace function public.purge_reward_audit() returns int
language plpgsql set search_path = public as $$
declare
  v_total int := 0;
  v_n int;
begin
  for i in 1 .. 10 loop
    delete from public.reward_contradictions
      where id in (select c.id from public.reward_contradictions c where c.created_at < now() - interval '400 days' limit 5000);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < 5000;
  end loop;
  for i in 1 .. 10 loop
    delete from public.push_token_seen
      where (user_id, token_sha256) in (select s.user_id, s.token_sha256 from public.push_token_seen s
                                         where s.first_seen_at < now() - interval '400 days' limit 5000);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < 5000;
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- RLS and grants: none of the three tables is readable or writable by any API role
-- ---------------------------------------------------------------------------
alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
alter table public.push_token_seen enable row level security;
revoke all on public.referral_codes from anon, authenticated, service_role;
revoke all on public.referrals from anon, authenticated, service_role;
revoke all on public.push_token_seen from anon, authenticated, service_role;

revoke all on function public.record_push_token_seen() from public, anon, authenticated, service_role;
revoke all on function public.normalise_referral_code(text) from public, anon, authenticated, service_role;
revoke all on function public.referrals_available() from public, anon, authenticated, service_role;
revoke all on function public.referral_refusal(text, text) from public, anon, authenticated, service_role;
revoke all on function public.referral_final_at(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.settle_referrals(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_my_referral_code() from public, anon, authenticated, service_role;
revoke all on function public.redeem_referral_code(text) from public, anon, authenticated, service_role;
revoke all on function public.my_referrals() from public, anon, authenticated, service_role;
grant execute on function public.get_my_referral_code() to authenticated;
grant execute on function public.redeem_referral_code(text) to authenticated;
grant execute on function public.my_referrals() to authenticated;
