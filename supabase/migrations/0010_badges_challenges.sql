-- 0010_badges_challenges: badges and personal challenges, counted in settled driving days (§R6, §R7).
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * public.badge_defs (#1, #10, #11): the badges, keyed by id; readable by authenticated (the app holds
--     the names and criteria copy, keyed by id); no client write. Seeded with 15 of §R7's 16 rows:
--     referrals_1 arrives with its producer in 0011. A jest parity test holds the seeds to
--     packages/scoring's BADGES.
--   * public.user_badges (#1, #10; append-only, documented exception to #11): one row per earned badge,
--     earned once and never removed. Owner read.
--   * public.challenge_defs (#1, #10, #11): §R6's four; readable by authenticated; parity with CHALLENGES.
--   * public.user_challenges (#1, #10, #11): enrolments. Owner read; written only by join_challenge,
--     leave_challenge and settlement. At most one active enrolment per definition (a unique partial
--     index) and two active at once (join_challenge, under the caller's rate_limits row as the mutex).
--   * public.settle_challenges(uuid, timestamptz), public.settle_badges(uuid) (non-definer, run as
--     postgres inside settle_rewards, no API execute).
--   * refresh_progress, settle_rewards and minimise_underage_rewards (0009) are replaced with
--     `create or replace` (owners, grants and flags kept): refresh_progress also counts
--     challenges_completed; settle_rewards gains the two steps; the minimisation also deletes the two
--     new user tables (R-H's class reset kept).
--   * client RPCs (#5, #6; definer, owner postgres, proconfig exactly search_path=public,
--     lock_timeout=2s, auth.uid() first, u13 refused): join_challenge(text), leave_challenge(uuid).
--
-- §R6 Challenges. Measured in driving days: settled days whose predicate for the challenge is pass or
-- fail, on or after the enrolment's start_day (the day after joining, in the user's local date) and
-- on or after progress.rewards_start. In day order: completed as soon as pass reaches the target
-- (points once, `challenge:<enrolment id>`, and a goal_completed challenge event), ended once
-- pass + fail reaches the window without it. Both are final; settled days never change (R-A), so an
-- enrolment's counts are exactly those of its settled days. Not driving pauses a challenge by
-- construction.
-- §R7 Badges. From progress's counters (settled safe days, phone-pass days, smooth-pass days, achieved
-- goals, completed challenges; referrals in 0011); earned once, never deleted by any later input. When
-- one settlement earns several tiers of a family, every row is inserted and only the highest tier
-- produces a level_up badge event.
--
-- The settlement order is now: u13 check; zone; progress lock; settle_days; append_streak;
-- settle_goals; settle_challenges; refresh_progress (counters, points, class); settle_badges;
-- refresh_progress (points and class after both); emit_reward_events; schedule_next_settle.
--
-- Nothing from 0001-0009 is edited except the three `create or replace`s above.

-- ---------------------------------------------------------------------------
-- definitions
-- ---------------------------------------------------------------------------
create table public.badge_defs (
  id text primary key check (id ~ '^[a-z_]+_[0-9]+$' and char_length(id) <= 40),
  family text not null check (family in ('safe_days', 'phone_free_days', 'smooth_days', 'weekly_goals', 'challenges', 'referrals')),
  tier text not null check (tier in ('bronze', 'silver', 'gold')),
  metric text not null check (metric in ('safe_days', 'phone_free_days', 'smooth_days', 'weekly_goals', 'challenges', 'referrals')),
  threshold int not null check (threshold between 1 and 100000),
  sort int not null check (sort between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.badge_defs (id, family, tier, metric, threshold, sort) values
  ('safe_days_7', 'safe_days', 'bronze', 'safe_days', 7, 1),
  ('safe_days_30', 'safe_days', 'silver', 'safe_days', 30, 2),
  ('safe_days_100', 'safe_days', 'gold', 'safe_days', 100, 3),
  ('phone_free_days_10', 'phone_free_days', 'bronze', 'phone_free_days', 10, 4),
  ('phone_free_days_50', 'phone_free_days', 'silver', 'phone_free_days', 50, 5),
  ('phone_free_days_200', 'phone_free_days', 'gold', 'phone_free_days', 200, 6),
  ('smooth_days_7', 'smooth_days', 'bronze', 'smooth_days', 7, 7),
  ('smooth_days_30', 'smooth_days', 'silver', 'smooth_days', 30, 8),
  ('smooth_days_100', 'smooth_days', 'gold', 'smooth_days', 100, 9),
  ('weekly_goals_1', 'weekly_goals', 'bronze', 'weekly_goals', 1, 10),
  ('weekly_goals_5', 'weekly_goals', 'silver', 'weekly_goals', 5, 11),
  ('weekly_goals_20', 'weekly_goals', 'gold', 'weekly_goals', 20, 12),
  ('challenges_1', 'challenges', 'bronze', 'challenges', 1, 13),
  ('challenges_3', 'challenges', 'silver', 'challenges', 3, 14),
  ('challenges_10', 'challenges', 'gold', 'challenges', 10, 15)
on conflict (id) do nothing;

create table public.challenge_defs (
  id text primary key check (id ~ '^[a-z_]{1,40}$'),
  predicate text not null check (predicate in ('phone', 'speeding', 'braking', 'accel', 'cornering', 'smooth', 'safe')),
  target_days int not null,
  window_days int not null,
  points int not null check (points between 100 and 300),
  sort int not null check (sort between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenge_defs_days check (target_days between 1 and window_days and window_days <= 60)
);
insert into public.challenge_defs (id, predicate, target_days, window_days, points, sort) values
  ('phone_down', 'phone', 10, 14, 200, 1),
  ('within_limit', 'speeding', 10, 14, 200, 2),
  ('smooth_ride', 'smooth', 10, 14, 150, 3),
  ('safe_run', 'safe', 7, 10, 300, 4)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- per-user rows
-- ---------------------------------------------------------------------------
-- append-only (documented exception to #11): a badge is earned once and never removed
create table public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_id text not null references public.badge_defs(id),
  earned_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);
create index user_badges_badge_idx on public.user_badges (badge_id);

create table public.user_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  def_id text not null references public.challenge_defs(id),
  start_day date not null,
  state text not null default 'active' check (state in ('active', 'completed', 'ended', 'left')),
  pass_days int not null default 0 check (pass_days >= 0),
  fail_days int not null default 0 check (fail_days >= 0),
  completed_at timestamptz null,
  ended_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one active enrolment per definition; rejoining after it ends is allowed
create unique index user_challenges_one_active_idx on public.user_challenges (user_id, def_id) where state = 'active';
create index user_challenges_user_state_idx on public.user_challenges (user_id, state);
create index user_challenges_def_idx on public.user_challenges (def_id);

create trigger badge_defs_touch before update on public.badge_defs for each row execute function public.touch_updated_at();
create trigger challenge_defs_touch before update on public.challenge_defs for each row execute function public.touch_updated_at();
create trigger user_challenges_touch before update on public.user_challenges for each row execute function public.touch_updated_at();
create trigger user_badges_refuse_underage before insert on public.user_badges for each row execute function public.refuse_underage_writes();
create trigger user_challenges_refuse_underage before insert on public.user_challenges for each row execute function public.refuse_underage_writes();

-- ---------------------------------------------------------------------------
-- settle steps
-- ---------------------------------------------------------------------------
-- §R6 every active enrolment, recounted over its settled driving days in order (final days, so the
-- same days give the same counts); returns goal_completed challenge events
create or replace function public.settle_challenges(p_user uuid, p_now timestamptz) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_start date;
  v_uc record;
  v_pred text;
  v_pass int;
  v_fail int;
  v_state text;
  v_events jsonb := '[]'::jsonb;
begin
  select pr.rewards_start into v_start from public.progress pr where pr.user_id = p_user;
  for v_uc in
    select uc.id, uc.start_day, d.id as def_id, d.predicate, d.target_days, d.window_days, d.points
    from public.user_challenges uc join public.challenge_defs d on d.id = uc.def_id
    where uc.user_id = p_user and uc.state = 'active'
    order by uc.created_at, uc.id
  loop
    v_pass := 0;
    v_fail := 0;
    v_state := 'active';
    for v_pred in
      select rd.predicates ->> v_uc.predicate from public.reward_days rd
      where rd.user_id = p_user and rd.day >= v_uc.start_day and rd.day >= coalesce(v_start, '-infinity'::date)
        and rd.predicates ->> v_uc.predicate in ('pass', 'fail')
      order by rd.day
    loop
      if v_pred = 'pass' then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
      end if;
      if v_pass >= v_uc.target_days then
        v_state := 'completed';
        exit;
      elsif v_pass + v_fail >= v_uc.window_days then
        v_state := 'ended';
        exit;
      end if;
    end loop;
    update public.user_challenges set pass_days = v_pass, fail_days = v_fail, state = v_state,
      completed_at = case when v_state = 'completed' then p_now end,
      ended_at = case when v_state = 'ended' then p_now end
      where id = v_uc.id;
    if v_state = 'completed'
       and public.reward_credit(p_user, 'challenge', v_uc.points, v_uc.id::text, 'challenge:' || v_uc.id) then
      v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'goal_completed',
        'payload', jsonb_build_object('kind', 'challenge', 'challengeId', v_uc.def_id, 'points', v_uc.points),
        'dedupe_key', 'goal_completed:challenge:' || v_uc.id, 'priority', 4));
    end if;
  end loop;
  return v_events;
end $$;

-- §R7 badges from progress's counters; returns one level_up badge event per family, its highest new tier
create or replace function public.settle_badges(p_user uuid) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_events jsonb;
begin
  with p as (
    select * from public.progress where user_id = p_user
  ), due as (
    select b.id, b.family, b.tier, b.threshold from public.badge_defs b, p
    where b.threshold <= case b.metric
      when 'safe_days' then p.safe_days when 'phone_free_days' then p.phone_free_days
      when 'smooth_days' then p.smooth_days when 'weekly_goals' then p.goals_achieved
      when 'challenges' then p.challenges_completed when 'referrals' then p.referrals_rewarded end
  ), earned as (
    insert into public.user_badges (user_id, badge_id, earned_at)
    select p_user, due.id, now() from due
    on conflict (user_id, badge_id) do nothing
    returning badge_id
  ), top as (
    select distinct on (b.family) b.id, b.tier
    from earned e join public.badge_defs b on b.id = e.badge_id
    order by b.family, b.threshold desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('type', 'level_up',
      'payload', jsonb_build_object('kind', 'badge', 'badgeId', top.id, 'tier', top.tier),
      'dedupe_key', 'level_up:badge:' || top.id, 'priority', 2) order by top.id), '[]'::jsonb)
    into v_events
  from top;
  return v_events;
end $$;

-- 0009's refresh_progress, now also counting completed challenges
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
    challenges_completed = (select count(*) from public.user_challenges uc where uc.user_id = p_user and uc.state = 'completed')
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

-- 0009's orchestrator with the two steps (the full order is in the header)
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

-- 0009's minimisation, also covering the badges and enrolments (R-H's class reset kept)
create or replace function public.minimise_underage_rewards() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce(auth.uid() = new.id, false)
          or coalesce(auth.role() = 'service_role', false)
          or (auth.uid() is null and session_user = 'postgres')) then
    raise exception 'minimise_underage_rewards requires the account owner or the service role' using errcode = 'insufficient_privilege';
  end if;
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

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- join a challenge: counting starts the day after joining (the join day is already partly known)
create or replace function public.join_challenge(p_def_id text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
  v_start timestamptz;
  v_uc public.user_challenges%rowtype;
begin
  if v_uid is null then
    raise exception 'join_challenge requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if p_def_id is null or not exists (select 1 from public.challenge_defs d where d.id = p_def_id and d.active) then
    raise exception 'unknown challenge' using errcode = 'invalid_parameter_value';
  end if;
  -- the caller's rate_limits row is the mutex around the checks below and the counter (M4's pattern)
  insert into public.rate_limits (user_id, key) values (v_uid, 'challenge_day') on conflict (user_id, key) do nothing;
  select rl.count, rl.window_start into v_count, v_start from public.rate_limits rl
    where rl.user_id = v_uid and rl.key = 'challenge_day' for update;
  if exists (select 1 from public.user_challenges uc where uc.user_id = v_uid and uc.def_id = p_def_id and uc.state = 'active') then
    raise exception 'challenge already active' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.user_challenges uc where uc.user_id = v_uid and uc.state = 'active')
     >= (public.reward_rules() ->> 'MAX_ACTIVE_CHALLENGES')::int then
    raise exception 'two challenges at a time' using errcode = 'insufficient_privilege';
  end if;
  if v_start <= now() - interval '24 hours' then
    v_count := 0;
    v_start := now();
  end if;
  if v_count >= 20 then
    raise exception 'challenge limit reached' using errcode = 'insufficient_privilege';
  end if;
  update public.rate_limits set count = v_count + 1, window_start = v_start where user_id = v_uid and key = 'challenge_day';
  insert into public.user_challenges (user_id, def_id, start_day)
    values (v_uid, p_def_id, public.user_local_date(v_uid) + 1)
    returning * into v_uc;
  return jsonb_build_object('id', v_uc.id, 'def_id', v_uc.def_id, 'start_day', v_uc.start_day, 'state', v_uc.state,
    'pass_days', v_uc.pass_days, 'fail_days', v_uc.fail_days);
end $$;

-- leave an active challenge: no points, final
create or replace function public.leave_challenge(p_id uuid) returns void
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'leave_challenge requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  update public.user_challenges set state = 'left', ended_at = now()
    where id = p_id and user_id = v_uid and state = 'active';
  if not found then
    raise exception 'challenge not found' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS, policies, grants: definitions readable by authenticated; enrolments and badges owner-read;
-- no DML for any API role, the service role included
-- ---------------------------------------------------------------------------
alter table public.badge_defs enable row level security;
alter table public.challenge_defs enable row level security;
alter table public.user_badges enable row level security;
alter table public.user_challenges enable row level security;

create policy badge_defs_select on public.badge_defs for select to authenticated using (true);
create policy challenge_defs_select on public.challenge_defs for select to authenticated using (true);
create policy user_badges_select_own on public.user_badges for select to authenticated using (user_id = (select auth.uid()));
create policy user_challenges_select_own on public.user_challenges for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.badge_defs from anon, authenticated, service_role;
revoke all on public.challenge_defs from anon, authenticated, service_role;
revoke all on public.user_badges from anon, authenticated, service_role;
revoke all on public.user_challenges from anon, authenticated, service_role;
grant select on public.badge_defs to authenticated;
grant select on public.challenge_defs to authenticated;
grant select on public.user_badges to authenticated;
grant select on public.user_challenges to authenticated;

revoke all on function public.settle_challenges(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.settle_badges(uuid) from public, anon, authenticated, service_role;
revoke all on function public.join_challenge(text) from public, anon, authenticated, service_role;
revoke all on function public.leave_challenge(uuid) from public, anon, authenticated, service_role;
grant execute on function public.join_challenge(text) to authenticated;
grant execute on function public.leave_challenge(uuid) to authenticated;
