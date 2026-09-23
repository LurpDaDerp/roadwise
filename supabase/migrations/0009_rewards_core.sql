-- hosted safety (T5 review): a lock this migration cannot get within 5 s fails the push instead of queueing
-- an ALTER in front of apply_trip's writes (pause the settle-rewards job during the push)
set lock_timeout = '5s';

-- 0009_rewards_core: the rewards engine's core. Final settled reward days behind a sync watermark,
-- an idempotent points ledger, an append-only streak with shields, the ISO weekly goal, the
-- contradiction log, and the settlement procedure pg_cron calls. Everything that turns a day into
-- value runs here, as postgres, and is executable by no API role.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers below are its sections):
--   * trips_user_local_day_idx: the day facts read every drive of a day, deleted ones included (0002's
--     index is partial on deleted_at is null).
--   * score_daily.trips_all (ruling T3 follow-up): final trips on the day including soft-deleted ones;
--     upsert_score_day (0002's helper) is replaced to store it (tripsAll, else tripsScored).
--   * devices.synced_through / devices.signed_out_at (R-A): client-writable through 0001's table-level
--     grant; both can only DELAY the owner's own credit. clamp_device_watermark() (non-definer, a pure
--     builtin) stores least(synced_through, now()), so a phone can never claim a future sync.
--   * public.progress (#1, #4, #10, #11): one row per user; points, xp, class (level 1-6), counters,
--     streak, shields, next_focus, and settled_through (the settlement frontier). streak_started is
--     bookkeeping for the milestone dedupe key (a run's first safe day). Owner read; no client DML.
--   * public.points_ledger (#10; append-only, documented exception to #11): one row per credit, keyed
--     by (user_id, idempotency_key); never a negative amount; balance_after is the running total.
--   * public.reward_days (#1, #10, #11): one FINAL row per settled day. freeze_reward_day() refuses any
--     change but checked_through/updated_at (and the fold's single write of streak_after, see §R4), so a
--     settled day never changes, up or down. checked_through is bookkeeping, not client-readable.
--   * public.reward_due (#10, #11): the settlement queue, one row per user. RLS on, no policy, no grant.
--   * public.weekly_goals (#1, #10, #11): one goal per user and ISO week. Owner read.
--   * public.reward_contradictions (append-only except the relabel counter, documented): changed_after_settlement,
--     relabel_with_events and zone_hop, server-only (RLS on, no policy, no grant); M6 reads it through a
--     future definer RPC. Purged after 400 days by purge_reward_audit() (bounded, daily 04:40). The
--     exception (security M-1): a relabel row is one per (drive, target role, local day), and a repeat
--     updates its lastAt and count in place, so toggling a role cannot grow the table without bound.
--   * progress.rewards_start (review m3): existing users start earning on their local date of today
--     (start_rewards_for_existing_users, run once here); no history before it is ever credited.
--   * the facts and rules: reward_fact (a composite type), reward_day_facts, reward_wall_close,
--     reward_day_ready, reward_outcome, reward_tier, reward_predicates, valid_reward_predicates,
--     reward_zone_hop, reward_week_closed, weakest_goal_category, reward_rules (the JSON the app's
--     rewardRulesJson() returns; a jest parity test compares them).
--   * the settle steps (non-definer, run as postgres, no API execute): settle_days, append_streak,
--     settle_goals, ensure_week_goal, refresh_progress, emit_reward_events, schedule_next_settle,
--     reward_credit; the orchestrator settle_rewards; the loop settle_due_rewards_at (no transaction
--     control, for tests and the e2e); the procedure settle_due_rewards (COMMITs per user).
--   * triggers: enqueue_reward_settlement on score_daily (one pure upsert), audit_trip_relabel on
--     trips.role, freeze_reward_day, clamp_device_watermark, minimise_underage_rewards (the u13
--     transition), refuse_underage_writes on the six new user tables.
--   * inbox.type: the four reward types join the CHECK.
--   * client RPCs (#5, #6; definer, owner postgres, proconfig exactly search_path=public,
--     lock_timeout=2s, auth.uid() first, u13 refused): open_my_week(), set_weekly_focus(text).
--   * cron: settle-rewards every 5 minutes (call public.settle_due_rewards(200)), purge-reward-audit
--     daily at 04:40.
--   * THE ONE DOCUMENTED EXCEPTION to #5 (ruling r1-M1): the procedure settle_due_rewards COMMITs, and a
--     procedure that commits cannot carry `SET search_path`; its body is fully schema-qualified and it
--     sets search_path with set_config(..., true) at the start of every transaction. Not a definer.
--
-- §R2 The settled day. A day is M2's local_day. Its wall close is the latest of (D+1) 02:00 wall-clock
-- over the zones of the day's trips (deleted included), or the user's zone for a day with no trips. It
-- is ready once that close has passed and every watermark device (not signed out, seen or synced in the
-- last 14 days) reports synced_through >= the close, or 72 h after the close whatever the watermarks
-- say (a device holds a day only once it has reported a watermark at all: a null synced_through is a
-- build that does not report, review m1). Days ahead of the frontier settle strictly in day order; a score_daily day at or behind the
-- frontier with no reward row is never settled for value: it gets one contradiction and a frozen
-- neutral/no_drive row. Outcome, tier, bonuses and predicates follow §R2 over one statement of facts
-- (score_daily plus final driver trips of the day, deleted ones included, and their scored events).
-- A settled day is final: when its score_daily row later moves (updated_at past checked_through) one
-- changed_after_settlement contradiction is written and nothing else changes. The zone-hop guard: a day
-- whose close is within 20 h of an already-settled day that earned settles without earning (an unsafe
-- day stays unsafe) and writes a zone_hop contradiction. Every relabel of a drive with scored events
-- writes relabel_with_events.
-- §R3 Deleted drives count against their day (their trips and events are in the facts; score_daily
-- keeps the lower evaluation, Task 3).
-- §R4 The streak is append-only: each newly settled day, in order, is folded once into progress
-- (safe +1, every 14th lifetime safe day a shield while fewer than 2 are held; unsafe spends a shield or
-- restarts the streak; neutral nothing) and its streak_after is written once. Milestones 7, 14, 30, 50,
-- 100, 150, 200, 250, 300 and 365 emit streak_milestone once per run.
-- §R5 The weekly goal: ISO Monday-Sunday, 4 driving days in one category (the chosen focus, else the
-- costliest category over the previous 28 days, ties phone, speeding, braking, cornering, accel; phone
-- when nothing was lost). Achieved at 4 passes; at week close achieved if every driving day passed
-- (prorated), no_drives with none, else ended. Every state but active is final; 150 points once.
-- §R8 Settlement mechanics: the score_daily trigger upserts reward_due to the day's earliest close
-- anywhere (UTC+14) and reads nothing. The procedure claims one due user, moves due_at to a 10-minute
-- lease and COMMITs, settles that user under lock_timeout 2 s and COMMITs, per user; the next-settle
-- write is compare-and-set against the lease (it may set or delete only an untouched lease, and
-- otherwise only lowers due_at); a failure backs off 1 h (24 h after 5), also compare-and-set. NOTE: a
-- statement_timeout set inside a CALL is not enforced (PostgreSQL arms it once per client statement,
-- and the whole CALL is one), so the procedure bounds itself instead with a 4-minute run budget; it
-- still sets statement_timeout per transaction as the plan asks, which does no harm.
-- §R9 Notifications: settlement's events go to M4's inbox (on conflict do nothing); a new row is pending
-- only when no rewards row is still waiting to push (pending, deferred, sending) and none was made
-- pending today in the user's day, the highest priority first (referral > goal > class > badge >
-- milestone); the rest are inbox-only. Payloads match the catalog's strict schemas exactly.
--
-- Nothing from 0001-0008 is edited except: a column on score_daily and `create or replace` of its write
-- helper upsert_score_day (which keeps its owner and grants); an index on trips; two columns and a trigger on devices; the
-- inbox type CHECK (dropped by its real name and re-added); triggers on score_daily, trips and profiles.
-- apply_trip and apply_recompute are untouched.

-- ---------------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------------
-- The JSON packages/scoring's rewardRulesJson() returns (scripts/__tests__/rewards-parity.test.ts).
create or replace function public.reward_rules() returns jsonb
language sql immutable set search_path = public as $$
  select $json${
  "POINTS": {"safeDay": 50, "goodDay": 20, "phoneFreeDay": 25, "cameraDay": 10, "weeklyGoal": 150, "referral": 500},
  "MIN_DRIVING_S": 600,
  "SAFE_AVG": 85,
  "SHIELD_EVERY_SAFE_DAYS": 14,
  "SHIELD_MAX": 2,
  "STREAK_MILESTONES": [7, 14, 30, 50, 100, 150, 200, 250, 300, 365],
  "WEEKLY_GOAL_TARGET_DAYS": 4,
  "SETTLE_WALL_CLOCK_H": 2,
  "SETTLE_CAP_H": 72,
  "WATERMARK_ACTIVE_D": 14,
  "ZONE_HOP_MIN_H": 20,
  "MAX_ACTIVE_CHALLENGES": 2,
  "REFERRAL": {"QUALIFYING_DRIVES": 3, "REDEEM_WITHIN_D": 14, "QUALIFY_WITHIN_D": 90, "YEARLY_CAP": 20, "CODE_LENGTH": 8,
    "CODE_ALPHABET": "ABCDEFGHJKMNPQRSTUVWXYZ23456789", "REDEEM_ATTEMPTS_PER_DAY": 10, "GLOBAL_REDEEM_PER_HOUR": 500},
  "LEVELS": [{"level": 1, "name": "Learner", "xp": 0}, {"level": 2, "name": "Steady", "xp": 1500},
    {"level": 3, "name": "Smooth", "xp": 4000}, {"level": 4, "name": "Focused", "xp": 8000},
    {"level": 5, "name": "Road-wise", "xp": 15000}, {"level": 6, "name": "Mentor", "xp": 25000}],
  "GOAL_CATEGORIES": ["phone", "speeding", "braking", "cornering", "accel"]
}$json$::jsonb
$$;

-- ---------------------------------------------------------------------------
-- tables and columns
-- ---------------------------------------------------------------------------
create index trips_user_local_day_idx on public.trips (user_id, local_day);

alter table public.devices
  add column synced_through timestamptz null,
  add column signed_out_at timestamptz null;
comment on column public.devices.synced_through is
  'The phone''s sync watermark (M5 R-A): every drive this phone ended before this instant is on the server. Clamped to now() by the server. It may only DELAY the owner''s own reward settlement (a day waits for it, at most 72 h); it can never advance or grant anything.';
comment on column public.devices.signed_out_at is
  'Set when the account signed out on this phone (M5 R-A): a signed-out phone no longer holds the owner''s reward settlement. It can only stop this phone delaying credit; it grants nothing.';

-- ruling T3 follow-up: the count of final trips on the day INCLUDING soft-deleted ones (dayRows' `all`
-- evaluation), so the app can tell a day whose only drives were deleted from a day with no drive. A row
-- written before the edge functions send it stores trips_scored (M2's behaviour); rows already stored
-- are backfilled the same way, before the settlement trigger below exists (no production data predates
-- M5).
alter table public.score_daily add column trips_all int not null default 0 check (trips_all between 0 and 1000);
update public.score_daily set trips_all = trips_scored where trips_all is distinct from trips_scored;

-- 0002's helper with trips_all added (its callers, apply_trip and apply_recompute, are untouched): the
-- aggregate's tripsAll, else tripsScored for an older function build
create or replace function public.upsert_score_day(p_user uuid, p_days jsonb) returns void
language plpgsql set search_path = public as $$
declare
  d jsonb;
begin
  if p_days is null or jsonb_typeof(p_days) = 'null' then
    return;
  end if;
  for d in select * from jsonb_array_elements(case when jsonb_typeof(p_days) = 'array' then p_days else jsonb_build_array(p_days) end) loop
    insert into public.score_daily (user_id, day, long_term_score, band, provisional, safe_day, good_day,
      phone_free_day, camera_day, exposure, driving_s, trips_scored, severe_events, trips_all)
    -- the integer columns are rounded, not cast: `::int` from JSON text refuses a decimal point,
    -- and the caller's arithmetic (a sum of fractional durations, a weighted score) is numeric.
    -- The callers round at the same boundary, so this only stops a fraction becoming a 22P02.
    values (p_user, (d->>'day')::date, round((d->>'longTermScore')::numeric)::int, d->>'band', (d->>'provisional')::boolean,
      (d->>'safeDay')::boolean, (d->>'goodDay')::boolean, (d->>'phoneFreeDay')::boolean, (d->>'cameraDay')::boolean,
      (d->>'exposure')::numeric, round((d->>'drivingS')::numeric)::int, round((d->>'tripsScored')::numeric)::int,
      round((d->>'severeEvents')::numeric)::int,
      round(coalesce(d->>'tripsAll', d->>'tripsScored')::numeric)::int)
    on conflict (user_id, day) do update set
      long_term_score = excluded.long_term_score, band = excluded.band, provisional = excluded.provisional,
      safe_day = excluded.safe_day, good_day = excluded.good_day, phone_free_day = excluded.phone_free_day,
      camera_day = excluded.camera_day, exposure = excluded.exposure, driving_s = excluded.driving_s,
      trips_scored = excluded.trips_scored, severe_events = excluded.severe_events, trips_all = excluded.trips_all;
  end loop;
end $$;

-- a phone can delay its owner's credit but never claim a sync from the future
create or replace function public.clamp_device_watermark() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.synced_through is not null and new.synced_through > now() then
    new.synced_through := now();
  end if;
  return new;
end $$;
create trigger devices_clamp_watermark before insert or update on public.devices
  for each row execute function public.clamp_device_watermark();

create table public.progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points int not null default 0 check (points >= 0),
  xp int not null default 0 check (xp >= 0),
  level int not null default 1 check (level between 1 and 6),
  streak_days int not null default 0 check (streak_days >= 0),
  best_streak int not null default 0 check (best_streak >= 0),
  safe_days int not null default 0 check (safe_days >= 0),
  phone_free_days int not null default 0 check (phone_free_days >= 0),
  smooth_days int not null default 0 check (smooth_days >= 0),
  goals_achieved int not null default 0 check (goals_achieved >= 0),
  challenges_completed int not null default 0 check (challenges_completed >= 0),
  referrals_rewarded int not null default 0 check (referrals_rewarded >= 0),
  shields int not null default 0 check (shields between 0 and 2),
  next_focus text null check (next_focus in ('phone', 'speeding', 'braking', 'accel', 'cornering')),
  -- the settlement frontier: the latest day settled in order
  settled_through date null,
  -- the first safe day of the current run (the milestone dedupe key); null while the streak is 0
  streak_started date null,
  -- (review m3) the first day that can earn: set at migration time to an existing user's local date, so
  -- history from before rewards existed is never credited; null (a new user) = unbounded
  rewards_start date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- append-only (documented exception to #11): no updated_at, rows are never changed
create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('safe_day', 'good_day', 'phone_free_day', 'camera_day', 'weekly_goal', 'challenge', 'referral')),
  amount int not null check (amount between 1 and 10000),
  ref_key text not null check (char_length(ref_key) between 1 and 64),
  balance_after int not null check (balance_after >= 0),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  created_at timestamptz not null default now(),
  constraint points_ledger_user_key unique (user_id, idempotency_key)
);
create index points_ledger_user_created_idx on public.points_ledger (user_id, created_at desc);

-- the seven predicates, each pass | fail | neutral
create or replace function public.valid_reward_predicates(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p) k)
        = array['accel', 'braking', 'cornering', 'phone', 'safe', 'smooth', 'speeding']
    and not exists (select 1 from jsonb_each(p) e where e.value not in ('"pass"'::jsonb, '"fail"'::jsonb, '"neutral"'::jsonb)), false)
$$;

create table public.reward_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  outcome text not null check (outcome in ('safe', 'neutral', 'unsafe')),
  outcome_reason text not null check (outcome_reason in ('safe', 'no_drive', 'learning', 'short', 'unsafe', 'zone_hop')),
  tier text not null check (tier in ('safe', 'good', 'none')),
  phone_free boolean not null,
  camera boolean not null,
  predicates jsonb not null check (pg_column_size(predicates) <= 512 and public.valid_reward_predicates(predicates)),
  points int not null check (points between 0 and 1000),
  -- written once by the streak fold in the settling transaction (null only inside it)
  streak_after int null check (streak_after >= 0),
  wall_close timestamptz not null,
  settled_at timestamptz not null,
  source_updated_at timestamptz not null,
  -- bookkeeping: the latest score_daily.updated_at already compared (not client-readable)
  checked_through timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- a settled day is final: only the bookkeeping moves, and the fold writes streak_after once
create or replace function public.freeze_reward_day() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.user_id, new.day, new.outcome, new.outcome_reason, new.tier, new.phone_free, new.camera, new.predicates,
      new.points, new.wall_close, new.settled_at, new.source_updated_at, new.created_at)
     is distinct from
     (old.user_id, old.day, old.outcome, old.outcome_reason, old.tier, old.phone_free, old.camera, old.predicates,
      old.points, old.wall_close, old.settled_at, old.source_updated_at, old.created_at)
     or (old.streak_after is not null and new.streak_after is distinct from old.streak_after) then
    raise exception 'settled days are final' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger reward_days_freeze before update on public.reward_days
  for each row execute function public.freeze_reward_day();

create table public.reward_due (
  user_id uuid primary key references auth.users(id) on delete cascade,
  due_at timestamptz not null,
  failures int not null default 0 check (failures between 0 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the sweep's only probe
create index reward_due_due_at_idx on public.reward_due (due_at);

create table public.weekly_goals (
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  category text not null check (category in ('phone', 'speeding', 'braking', 'accel', 'cornering')),
  source text not null check (source in ('chosen', 'weakest')),
  target_days int not null default 4 check (target_days between 1 and 7),
  pass_days int not null default 0 check (pass_days between 0 and 7),
  fail_days int not null default 0 check (fail_days between 0 and 7),
  state text not null default 'active' check (state in ('active', 'achieved', 'ended', 'no_drives')),
  prorated boolean not null default false,
  closed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

-- append-only except the relabel counter (security M-1, see audit_trip_relabel): server only
create table public.reward_contradictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date null,
  kind text not null check (kind in ('changed_after_settlement', 'relabel_with_events', 'zone_hop')),
  detail jsonb not null check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 1024),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 128),
  created_at timestamptz not null default now(),
  constraint reward_contradictions_user_dedupe_key unique (user_id, dedupe_key)
);
create index reward_contradictions_user_created_idx on public.reward_contradictions (user_id, created_at desc);
-- the retention purge's scan
create index reward_contradictions_created_idx on public.reward_contradictions (created_at);

-- (review m3) no retroactive credit: every user who exists when this migration runs starts earning on
-- their local date of today. Days before it never get a reward row, a contradiction or a push, and the
-- settlement frontier starts there. A user created later has no progress row yet: null, unbounded.
-- A blocked (u13) account gets none (it holds no rewards data). Callable again (idempotent: it only
-- fills users without a progress row); no API role executes it.
create or replace function public.start_rewards_for_existing_users() returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  insert into public.progress (user_id, rewards_start)
  select p.id, public.user_local_date(p.id) from public.profiles p
  where p.age_band is distinct from 'u13' and not exists (select 1 from public.progress pr where pr.user_id = p.id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create trigger progress_touch before update on public.progress for each row execute function public.touch_updated_at();
create trigger reward_days_touch before update on public.reward_days for each row execute function public.touch_updated_at();
create trigger reward_due_touch before update on public.reward_due for each row execute function public.touch_updated_at();
create trigger weekly_goals_touch before update on public.weekly_goals for each row execute function public.touch_updated_at();

-- a u13 account holds no rewards data, whoever writes (0006's rule)
create trigger progress_refuse_underage before insert on public.progress for each row execute function public.refuse_underage_writes();
create trigger points_ledger_refuse_underage before insert on public.points_ledger for each row execute function public.refuse_underage_writes();
create trigger reward_days_refuse_underage before insert on public.reward_days for each row execute function public.refuse_underage_writes();
create trigger reward_due_refuse_underage before insert on public.reward_due for each row execute function public.refuse_underage_writes();
create trigger weekly_goals_refuse_underage before insert on public.weekly_goals for each row execute function public.refuse_underage_writes();
create trigger reward_contradictions_refuse_underage before insert on public.reward_contradictions for each row execute function public.refuse_underage_writes();

select public.start_rewards_for_existing_users();

-- the four reward notifications (Task 4's live types)
alter table public.inbox drop constraint inbox_type_check;
alter table public.inbox add constraint inbox_type_check
  check (type in ('trip_summary', 'permission_lapsed', 'streak_milestone', 'goal_completed', 'level_up', 'referral_qualified'));

-- ---------------------------------------------------------------------------
-- facts
-- ---------------------------------------------------------------------------
create type public.reward_fact as (
  day date, safe_day boolean, good_day boolean, phone_free_day boolean, camera_day boolean, driving_s int,
  provisional boolean, scored_all int, avg_all numeric, severe_all int, phone int, speeding int, braking int,
  accel int, cornering int, wall_close timestamptz, source_updated_at timestamptz
);

-- the latest wall-clock 02:00 after the day over the zones; a zone Postgres rejects is skipped, and
-- with none usable the day closes at 02:00 UTC
create or replace function public.reward_wall_close(p_day date, p_zones text[]) returns timestamptz
language plpgsql immutable set search_path = public as $$
declare
  v_local timestamp := (p_day + 1)::timestamp + make_interval(hours => (public.reward_rules() ->> 'SETTLE_WALL_CLOCK_H')::int);
  v_zone text;
  v_at timestamptz;
  v_best timestamptz;
begin
  foreach v_zone in array coalesce(p_zones, '{}'::text[]) loop
    begin
      v_at := v_local at time zone v_zone;
      if v_best is null or v_at > v_best then
        v_best := v_at;
      end if;
    exception when others then
      null;
    end;
  end loop;
  return coalesce(v_best, v_local at time zone 'UTC');
end $$;

-- §R2 facts in one statement: one row per score_daily day; final driver trips of the day, deleted
-- ones included, and their scored events; the day's zones, or p_tz for a day with no trips
create or replace function public.reward_day_facts(p_user uuid, p_from date, p_to date, p_tz text) returns setof public.reward_fact
language sql stable set search_path = public as $$
  select sd.day, sd.safe_day, sd.good_day, sd.phone_free_day, sd.camera_day, sd.driving_s, sd.provisional,
    coalesce(t.scored_all, 0), t.avg_all, coalesce(t.severe_all, 0),
    coalesce(e.phone, 0), coalesce(e.speeding, 0), coalesce(e.braking, 0), coalesce(e.accel, 0), coalesce(e.cornering, 0),
    public.reward_wall_close(sd.day, coalesce(z.zones, array[coalesce(p_tz, 'UTC')])),
    sd.updated_at
  from public.score_daily sd
  left join lateral (
    select count(*)::int as scored_all, avg(tr.score) as avg_all, (count(*) filter (where tr.had_severe_event))::int as severe_all
    from public.trips tr
    where tr.user_id = p_user and tr.local_day = sd.day and tr.status = 'final' and tr.role = 'driver'
  ) t on true
  left join lateral (
    select (count(*) filter (where ev.category = 'phone'))::int as phone,
           (count(*) filter (where ev.category = 'speeding'))::int as speeding,
           (count(*) filter (where ev.category = 'braking'))::int as braking,
           (count(*) filter (where ev.category = 'accel'))::int as accel,
           (count(*) filter (where ev.category = 'cornering'))::int as cornering
    from public.trips tr join public.trip_events ev on ev.trip_id = tr.id
    where tr.user_id = p_user and tr.local_day = sd.day and tr.status = 'final' and tr.role = 'driver' and ev.status = 'scored'
  ) e on true
  left join lateral (
    select array_agg(distinct tr.tz) as zones from public.trips tr where tr.user_id = p_user and tr.local_day = sd.day
  ) z on true
  where sd.user_id = p_user and sd.day between p_from and p_to
  order by sd.day
$$;

-- §R2 readiness: the close has passed and every watermark device has synced past it, or the 72 h cap
create or replace function public.reward_day_ready(p_user uuid, p_wall_close timestamptz, p_now timestamptz) returns boolean
language sql stable set search_path = public as $$
  select p_now >= p_wall_close
    and (p_now >= p_wall_close + make_interval(hours => (public.reward_rules() ->> 'SETTLE_CAP_H')::int)
         or not exists (
           select 1 from public.devices d
           where d.user_id = p_user and d.signed_out_at is null and d.synced_through is not null
             and greatest(d.last_seen_at, coalesce(d.synced_through, '-infinity'::timestamptz))
                 >= p_now - make_interval(days => (public.reward_rules() ->> 'WATERMARK_ACTIVE_D')::int)
             and coalesce(d.synced_through, '-infinity'::timestamptz) < p_wall_close))
$$;

create or replace function public.reward_outcome(f public.reward_fact, out outcome text, out reason text)
language sql immutable set search_path = public as $$
  select case when f.scored_all = 0 then 'neutral'
              when f.safe_day then 'safe'
              when f.provisional then 'neutral'
              when f.driving_s < (public.reward_rules() ->> 'MIN_DRIVING_S')::int and f.severe_all = 0
                   and f.avg_all >= (public.reward_rules() ->> 'SAFE_AVG')::numeric then 'neutral'
              else 'unsafe' end,
         case when f.scored_all = 0 then 'no_drive'
              when f.safe_day then 'safe'
              when f.provisional then 'learning'
              when f.driving_s < (public.reward_rules() ->> 'MIN_DRIVING_S')::int and f.severe_all = 0
                   and f.avg_all >= (public.reward_rules() ->> 'SAFE_AVG')::numeric then 'short'
              else 'unsafe' end
$$;

create or replace function public.reward_tier(f public.reward_fact) returns text
language sql immutable set search_path = public as $$
  select case when f.safe_day then 'safe' when f.good_day then 'good' else 'none' end
$$;

create or replace function public.reward_predicates(f public.reward_fact) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_min int := (public.reward_rules() ->> 'MIN_DRIVING_S')::int;
  v_cat text;
  v_n int;
  v_p jsonb := '{}'::jsonb;
  v_outcome text := (public.reward_outcome(f)).outcome;
begin
  foreach v_cat in array array['phone', 'speeding', 'braking', 'accel', 'cornering'] loop
    v_n := case v_cat when 'phone' then f.phone when 'speeding' then f.speeding when 'braking' then f.braking
                      when 'accel' then f.accel else f.cornering end;
    v_p := v_p || jsonb_build_object(v_cat, case when f.scored_all = 0 then 'neutral' when v_n > 0 then 'fail'
                                                 when f.driving_s < v_min then 'neutral' else 'pass' end);
  end loop;
  v_p := v_p || jsonb_build_object('smooth',
    case when 'fail' in (v_p ->> 'braking', v_p ->> 'accel', v_p ->> 'cornering') then 'fail'
         when v_p ->> 'braking' = 'pass' and v_p ->> 'accel' = 'pass' and v_p ->> 'cornering' = 'pass' then 'pass'
         else 'neutral' end);
  v_p := v_p || jsonb_build_object('safe', case v_outcome when 'safe' then 'pass' when 'unsafe' then 'fail' else 'neutral' end);
  return v_p;
end $$;

-- the fact summary a contradiction records (outcomes and counts, never a place or a time of day)
create or replace function public.reward_fact_summary(f public.reward_fact) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('outcome', (public.reward_outcome(f)).outcome, 'tier', public.reward_tier(f),
    'scoredAll', f.scored_all, 'severeAll', f.severe_all, 'provisional', f.provisional)
$$;

-- §R2 zone-hop guard over the STORED closes (rev2: m3): another settled day within 20 h that earned
create or replace function public.reward_zone_hop(p_user uuid, p_wall_close timestamptz) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from public.reward_days r
    where r.user_id = p_user
      and r.wall_close > p_wall_close - make_interval(hours => (public.reward_rules() ->> 'ZONE_HOP_MIN_H')::int)
      and r.wall_close < p_wall_close + make_interval(hours => (public.reward_rules() ->> 'ZONE_HOP_MIN_H')::int)
      and (r.tier <> 'none' or r.phone_free or r.camera or jsonb_path_exists(r.predicates, '$.* ? (@ == "pass")')))
$$;

-- §R5 a week has closed: its Sunday is ready (the user's zone when Sunday has no drive) and every day of
-- the week with a score_daily row has settled
create or replace function public.reward_week_closed(p_user uuid, p_week_start date, p_tz text, p_now timestamptz) returns boolean
language sql stable set search_path = public as $$
  select public.reward_day_ready(p_user,
      public.reward_wall_close(p_week_start + 6,
        coalesce((select array_agg(distinct tr.tz) from public.trips tr where tr.user_id = p_user and tr.local_day = p_week_start + 6),
                 array[coalesce(p_tz, 'UTC')])),
      p_now)
    and not exists (
      select 1 from public.score_daily sd
      where sd.user_id = p_user and sd.day between p_week_start and p_week_start + 6
        and sd.day >= coalesce((select pr.rewards_start from public.progress pr where pr.user_id = p_user), '-infinity'::date)
        and not exists (select 1 from public.reward_days r where r.user_id = p_user and r.day = sd.day))
$$;

-- §R5 the costliest category over the previous 28 days (final driver drives, deleted included)
create or replace function public.weakest_goal_category(p_user uuid, p_week_start date) returns text
language sql stable set search_path = public as $$
  with cost as (
    select c.cat, c.ord, coalesce(sum((tr.category_deductions ->> c.cat)::numeric), 0) as total
    from (values ('phone', 1), ('speeding', 2), ('braking', 3), ('cornering', 4), ('accel', 5)) c(cat, ord)
    left join public.trips tr on tr.user_id = p_user and tr.status = 'final' and tr.role = 'driver'
      and tr.local_day between p_week_start - 28 and p_week_start - 1
    group by c.cat, c.ord
  )
  select coalesce((select cat from cost where total > 0 order by total desc, ord limit 1), 'phone')
$$;

-- ---------------------------------------------------------------------------
-- the settle steps (non-definer; run as postgres; no API role executes them)
-- ---------------------------------------------------------------------------
-- one idempotent credit; balance_after is the running total (the caller holds the user's progress lock)
create or replace function public.reward_credit(p_user uuid, p_type text, p_amount int, p_ref text, p_key text) returns boolean
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key)
  select p_user, p_type, p_amount, p_ref,
         coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0) + p_amount, p_key
  on conflict (user_id, idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- §R2: late days behind the frontier, then ready days in order at the frontier, then the change log.
-- Returns the days newly settled for value, in order.
create or replace function public.settle_days(p_user uuid, p_tz text, p_now timestamptz) returns date[]
language plpgsql set search_path = public as $$
declare
  v_rules jsonb := public.reward_rules();
  v_min int := (v_rules ->> 'MIN_DRIVING_S')::int;
  v_frontier date;
  v_streak int;
  v_day date;
  f public.reward_fact;
  v_outcome text;
  v_reason text;
  v_tier text;
  v_pf boolean;
  v_cam boolean;
  v_pred jsonb;
  v_points int;
  v_earns boolean;
  v_neutral constant jsonb := '{"phone":"neutral","speeding":"neutral","braking":"neutral","accel":"neutral","cornering":"neutral","smooth":"neutral","safe":"neutral"}';
  v_days date[] := '{}';
  v_start date;
  r record;
begin
  select pr.settled_through, pr.streak_days, pr.rewards_start into v_frontier, v_streak, v_start from public.progress pr where pr.user_id = p_user;

  -- (rev2: I-A) a day at or behind the frontier with no reward row is never settled for value
  if v_frontier is not null then
    for v_day in
      select sd.day from public.score_daily sd
      where sd.user_id = p_user and sd.day <= v_frontier and sd.day >= coalesce(v_start, '-infinity'::date)
        and not exists (select 1 from public.reward_days rd where rd.user_id = p_user and rd.day = sd.day)
      order by sd.day
    loop
      select * into f from public.reward_day_facts(p_user, v_day, v_day, p_tz);
      insert into public.reward_contradictions (user_id, day, kind, detail, dedupe_key)
      values (p_user, v_day, 'changed_after_settlement',
        jsonb_build_object('late_day', true, 'now', public.reward_fact_summary(f)),
        'late:' || v_day || ':' || floor(extract(epoch from f.source_updated_at))::bigint)
      on conflict (user_id, dedupe_key) do nothing;
      insert into public.reward_days (user_id, day, outcome, outcome_reason, tier, phone_free, camera, predicates, points,
        streak_after, wall_close, settled_at, source_updated_at, checked_through)
      values (p_user, v_day, 'neutral', 'no_drive', 'none', false, false, v_neutral, 0,
        coalesce(v_streak, 0), f.wall_close, p_now, f.source_updated_at, f.source_updated_at);
    end loop;
  end if;

  -- days ahead of the frontier, strictly in order: the first day not ready stops the run
  for f in select x.* from public.reward_day_facts(p_user, greatest(coalesce(v_frontier + 1, '-infinity'::date), coalesce(v_start, '-infinity'::date)),
      'infinity'::date, p_tz) x order by x.day loop
    exit when not public.reward_day_ready(p_user, f.wall_close, p_now);
    select o.outcome, o.reason into v_outcome, v_reason from public.reward_outcome(f) o;
    v_tier := public.reward_tier(f);
    v_pf := f.phone_free_day and f.driving_s >= v_min;
    v_cam := f.camera_day and f.driving_s >= v_min;
    v_pred := public.reward_predicates(f);
    v_earns := v_tier <> 'none' or v_pf or v_cam or v_outcome = 'safe' or jsonb_path_exists(v_pred, '$.* ? (@ == "pass")');
    -- (R-B) the zone-hop guard can only cost: an unsafe day stays unsafe
    if v_earns and public.reward_zone_hop(p_user, f.wall_close) then
      insert into public.reward_contradictions (user_id, day, kind, detail, dedupe_key)
      values (p_user, f.day, 'zone_hop',
        jsonb_build_object('wouldHave', jsonb_build_object('outcome', v_outcome, 'tier', v_tier, 'phoneFree', v_pf, 'camera', v_cam)),
        'zone_hop:' || f.day)
      on conflict (user_id, dedupe_key) do nothing;
      v_tier := 'none';
      v_pf := false;
      v_cam := false;
      v_pred := (select jsonb_object_agg(e.key, case when e.value = '"pass"'::jsonb then '"neutral"'::jsonb else e.value end) from jsonb_each(v_pred) e);
      if v_outcome <> 'unsafe' then
        v_outcome := 'neutral';
        v_reason := 'zone_hop';
      end if;
    end if;

    v_points := 0;
    if v_tier = 'safe' then
      perform public.reward_credit(p_user, 'safe_day', (v_rules -> 'POINTS' ->> 'safeDay')::int, f.day::text, 'day:' || f.day || ':tier');
      v_points := v_points + (v_rules -> 'POINTS' ->> 'safeDay')::int;
    elsif v_tier = 'good' then
      perform public.reward_credit(p_user, 'good_day', (v_rules -> 'POINTS' ->> 'goodDay')::int, f.day::text, 'day:' || f.day || ':tier');
      v_points := v_points + (v_rules -> 'POINTS' ->> 'goodDay')::int;
    end if;
    if v_pf then
      perform public.reward_credit(p_user, 'phone_free_day', (v_rules -> 'POINTS' ->> 'phoneFreeDay')::int, f.day::text, 'day:' || f.day || ':phone_free');
      v_points := v_points + (v_rules -> 'POINTS' ->> 'phoneFreeDay')::int;
    end if;
    if v_cam then
      perform public.reward_credit(p_user, 'camera_day', (v_rules -> 'POINTS' ->> 'cameraDay')::int, f.day::text, 'day:' || f.day || ':camera');
      v_points := v_points + (v_rules -> 'POINTS' ->> 'cameraDay')::int;
    end if;

    insert into public.reward_days (user_id, day, outcome, outcome_reason, tier, phone_free, camera, predicates, points,
      streak_after, wall_close, settled_at, source_updated_at, checked_through)
    values (p_user, f.day, v_outcome, v_reason, v_tier, v_pf, v_cam, v_pred, v_points,
      null, f.wall_close, p_now, f.source_updated_at, f.source_updated_at);
    update public.progress set settled_through = f.day where user_id = p_user;
    v_days := v_days || f.day;
  end loop;

  -- a settled day is final: a later change of its score_daily row is recorded, never applied
  for r in
    select rd.day, rd.outcome, rd.tier, sd.updated_at
    from public.reward_days rd join public.score_daily sd on sd.user_id = rd.user_id and sd.day = rd.day
    where rd.user_id = p_user and sd.updated_at > rd.checked_through
  loop
    select * into f from public.reward_day_facts(p_user, r.day, r.day, p_tz);
    insert into public.reward_contradictions (user_id, day, kind, detail, dedupe_key)
    values (p_user, r.day, 'changed_after_settlement',
      jsonb_build_object('settled', jsonb_build_object('outcome', r.outcome, 'tier', r.tier), 'now', public.reward_fact_summary(f)),
      'late:' || r.day || ':' || floor(extract(epoch from r.updated_at))::bigint)
    on conflict (user_id, dedupe_key) do nothing;
    update public.reward_days set checked_through = r.updated_at where user_id = p_user and day = r.day;
  end loop;

  return v_days;
end $$;

-- §R4 the append-only fold, one day at a time in order; returns streak_milestone events
create or replace function public.append_streak(p_user uuid, p_days date[]) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_rules jsonb := public.reward_rules();
  v_every int := (v_rules ->> 'SHIELD_EVERY_SAFE_DAYS')::int;
  v_max int := (v_rules ->> 'SHIELD_MAX')::int;
  v_p public.progress%rowtype;
  v_day date;
  v_outcome text;
  v_safe_total int;
  v_events jsonb := '[]'::jsonb;
begin
  if p_days is null or cardinality(p_days) = 0 then
    return v_events;
  end if;
  select * into v_p from public.progress where user_id = p_user for update;
  foreach v_day in array p_days loop
    select rd.outcome into v_outcome from public.reward_days rd where rd.user_id = p_user and rd.day = v_day;
    if v_outcome = 'safe' then
      if v_p.streak_days = 0 then
        v_p.streak_started := v_day;
      end if;
      v_p.streak_days := v_p.streak_days + 1;
      select count(*) into v_safe_total from public.reward_days rd where rd.user_id = p_user and rd.outcome = 'safe' and rd.day <= v_day;
      if v_safe_total % v_every = 0 and v_p.shields < v_max then
        v_p.shields := v_p.shields + 1;
      end if;
      if v_rules -> 'STREAK_MILESTONES' @> to_jsonb(v_p.streak_days) then
        v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'streak_milestone',
          'payload', jsonb_build_object('days', v_p.streak_days, 'reachedOn', v_day::text),
          'dedupe_key', 'streak_milestone:' || v_p.streak_started || ':' || v_p.streak_days, 'priority', 1));
      end if;
    elsif v_outcome = 'unsafe' then
      if v_p.shields > 0 then
        v_p.shields := v_p.shields - 1;
      else
        v_p.streak_days := 0;
        v_p.streak_started := null;
      end if;
    end if;
    v_p.best_streak := greatest(v_p.best_streak, v_p.streak_days);
    update public.reward_days set streak_after = v_p.streak_days where user_id = p_user and day = v_day;
  end loop;
  update public.progress
    set streak_days = v_p.streak_days, best_streak = v_p.best_streak, shields = v_p.shields, streak_started = v_p.streak_started
    where user_id = p_user;
  return v_events;
end $$;

-- the settled pass and fail days of a goal's week, by its category's predicate
create or replace function public.reward_goal_counts(p_user uuid, p_week_start date, p_category text, out pass_days int, out fail_days int)
language sql stable set search_path = public as $$
  select (count(*) filter (where rd.predicates ->> p_category = 'pass'))::int,
         (count(*) filter (where rd.predicates ->> p_category = 'fail'))::int
  from public.reward_days rd
  where rd.user_id = p_user and rd.day between p_week_start and p_week_start + 6
$$;

-- §R5 materialise the week's goal. Also closes the user's earlier active goals whose week has closed,
-- to the states that carry no value (no_drives, ended); an earlier goal that closes achieved (prorated)
-- is left to settlement, which credits it (a client RPC never writes a ledger row), and whose schedule
-- already includes that week's close.
create or replace function public.ensure_week_goal(p_user uuid, p_week_start date, p_tz text, p_now timestamptz) returns public.weekly_goals
language plpgsql set search_path = public as $$
declare
  v_goal public.weekly_goals%rowtype;
  v_old public.weekly_goals%rowtype;
  v_counts record;
  v_focus text;
begin
  for v_old in
    select * from public.weekly_goals g where g.user_id = p_user and g.state = 'active' and g.week_start < p_week_start
  loop
    if public.reward_week_closed(p_user, v_old.week_start, p_tz, p_now) then
      select * into v_counts from public.reward_goal_counts(p_user, v_old.week_start, v_old.category);
      if v_counts.pass_days + v_counts.fail_days = 0 then
        update public.weekly_goals set state = 'no_drives', pass_days = 0, fail_days = 0, closed_at = p_now
          where user_id = p_user and week_start = v_old.week_start;
      elsif v_counts.pass_days < least(v_old.target_days, v_counts.pass_days + v_counts.fail_days) then
        update public.weekly_goals set state = 'ended', pass_days = v_counts.pass_days, fail_days = v_counts.fail_days, closed_at = p_now
          where user_id = p_user and week_start = v_old.week_start;
      end if;
    end if;
  end loop;

  insert into public.progress (user_id) values (p_user) on conflict (user_id) do nothing;
  select pr.next_focus into v_focus from public.progress pr where pr.user_id = p_user for update;
  -- (review n1) the chosen focus is for the week the driver is in: a past week's goal (a delayed
  -- settlement) takes the weakest category and leaves the focus for the current week
  if p_week_start <> date_trunc('week', (p_now at time zone coalesce(p_tz, 'UTC'))::date)::date then
    v_focus := null;
  end if;
  insert into public.weekly_goals (user_id, week_start, category, source, target_days)
  values (p_user, p_week_start, coalesce(v_focus, public.weakest_goal_category(p_user, p_week_start)),
    case when v_focus is not null then 'chosen' else 'weakest' end,
    (public.reward_rules() ->> 'WEEKLY_GOAL_TARGET_DAYS')::int)
  on conflict (user_id, week_start) do nothing
  returning * into v_goal;
  if v_goal.user_id is not null and v_focus is not null then
    update public.progress set next_focus = null where user_id = p_user;
  end if;
  if v_goal.user_id is null then
    select * into v_goal from public.weekly_goals g where g.user_id = p_user and g.week_start = p_week_start;
  end if;
  return v_goal;
end $$;

-- §R5 settlement's side: goals for the weeks just touched exist; every active goal is recounted and
-- closed when due; an achieved goal is credited once. Returns goal_completed events.
create or replace function public.settle_goals(p_user uuid, p_tz text, p_now timestamptz, p_days date[]) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_rules jsonb := public.reward_rules();
  v_week date;
  v_goal public.weekly_goals%rowtype;
  v_counts record;
  v_state text;
  v_events jsonb := '[]'::jsonb;
begin
  for v_week in select distinct date_trunc('week', d)::date from unnest(coalesce(p_days, '{}'::date[])) d order by 1 loop
    perform public.ensure_week_goal(p_user, v_week, p_tz, p_now);
  end loop;
  for v_goal in
    select g.* from public.weekly_goals g
    where g.user_id = p_user and g.state = 'active'
      and g.week_start + 6 >= coalesce((select pr.rewards_start from public.progress pr where pr.user_id = p_user), '-infinity'::date)
    order by g.week_start
  loop
    select * into v_counts from public.reward_goal_counts(p_user, v_goal.week_start, v_goal.category);
    v_state := case
      when v_counts.pass_days >= v_goal.target_days then 'achieved'
      when public.reward_week_closed(p_user, v_goal.week_start, p_tz, p_now) then
        case when v_counts.pass_days + v_counts.fail_days = 0 then 'no_drives'
             when v_counts.pass_days >= least(v_goal.target_days, v_counts.pass_days + v_counts.fail_days) then 'achieved'
             else 'ended' end
      else 'active' end;
    update public.weekly_goals
      set pass_days = v_counts.pass_days, fail_days = v_counts.fail_days, state = v_state,
          prorated = (v_state = 'achieved' and v_counts.pass_days < v_goal.target_days),
          closed_at = case when v_state <> 'active' then p_now end
      where user_id = p_user and week_start = v_goal.week_start;
    if v_state = 'achieved'
       and public.reward_credit(p_user, 'weekly_goal', (v_rules -> 'POINTS' ->> 'weeklyGoal')::int, v_goal.week_start::text, 'goal:' || v_goal.week_start) then
      v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'goal_completed',
        'payload', jsonb_build_object('kind', 'weekly_goal', 'category', v_goal.category, 'weekStart', v_goal.week_start::text,
          'points', (v_rules -> 'POINTS' ->> 'weeklyGoal')::int, 'prorated', v_counts.pass_days < v_goal.target_days),
        'dedupe_key', 'goal_completed:weekly:' || v_goal.week_start, 'priority', 4));
    end if;
  end loop;
  return v_events;
end $$;

-- counters recomputed over settled rows; a class rise mirrors profiles.level and emits level_up
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
    goals_achieved = (select count(*) from public.weekly_goals g where g.user_id = p_user and g.state = 'achieved')
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

-- §R9 events into M4's inbox: at most one pending rewards row per user per local day, the highest
-- priority; the rest inbox-only. The day is the current transaction's local day in p_tz.
create or replace function public.emit_reward_events(p_user uuid, p_events jsonb, p_tz text, p_now timestamptz) returns int
language plpgsql set search_path = public as $$
declare
  v_today date := (now() at time zone coalesce(p_tz, 'UTC'))::date;
  v_pushed boolean;
  v_event jsonb;
  v_count int := 0;
  v_n int;
begin
  if p_events is null or jsonb_array_length(p_events) = 0 then
    return 0;
  end if;
  -- (Task 4 review m1) a new row may be pending only when no rewards row is still waiting to push
  -- (pending, deferred or sending, from any day: a push deferred past midnight still counts) and none
  -- was made pending today; so "at most one a day" holds for what actually reaches the phone
  v_pushed := exists (
    select 1 from public.inbox i
    where i.user_id = p_user and i.type in ('streak_milestone', 'goal_completed', 'level_up', 'referral_qualified')
      and (i.push_state in ('pending', 'deferred', 'sending')
           or ((i.created_at at time zone coalesce(p_tz, 'UTC'))::date = v_today and i.push_reason is distinct from 'inbox_only')));
  for v_event in select e.value from jsonb_array_elements(p_events) e order by (e.value ->> 'priority')::int desc, e.value ->> 'dedupe_key' loop
    insert into public.inbox (user_id, type, payload, dedupe_key, push_state, push_reason)
    values (p_user, v_event ->> 'type', v_event -> 'payload', v_event ->> 'dedupe_key',
      case when v_pushed then 'skipped' else 'pending' end, case when v_pushed then 'inbox_only' end)
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_count := v_count + 1;
      v_pushed := true;
    end if;
  end loop;
  return v_count;
end $$;

-- a time the owner must come back at: the time itself when it is ahead, else an hour on (never past the cap)
create or replace function public.reward_retry_at(p_close timestamptz, p_now timestamptz) returns timestamptz
language sql immutable set search_path = public as $$
  select case when p_close > p_now then p_close
              else greatest(p_now, least(p_now + interval '1 hour',
                     p_close + make_interval(hours => (public.reward_rules() ->> 'SETTLE_CAP_H')::int))) end
$$;

-- §R8 the next time this user is owed a settlement, written compare-and-set against the lease (rev2: I-B)
create or replace function public.schedule_next_settle(p_user uuid, p_tz text, p_now timestamptz, p_lease timestamptz) returns timestamptz
language plpgsql set search_path = public as $$
declare
  v_frontier date;
  v_close timestamptz;
  v_next timestamptz;
  v_goal record;
  v_count int;
  v_start date;
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

-- the orchestrator: one user, one transaction (0010 and 0011 add one step each)
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
  v_events := v_events || public.refresh_progress(p_user);
  perform public.emit_reward_events(p_user, v_events, v_tz, p_now);
  perform public.schedule_next_settle(p_user, v_tz, p_now, p_lease);

  return jsonb_build_object('settledDays', cardinality(v_days),
    'ledgerRows', (select count(*) from public.points_ledger where user_id = p_user) - v_ledger,
    'contradictions', (select count(*) from public.reward_contradictions where user_id = p_user) - v_contra,
    'events', jsonb_array_length(v_events));
end $$;

-- a failed settlement backs off, compare-and-set against the lease (seat 5 r2): an enqueue during the
-- failed run keeps its earlier time
create or replace function public.reward_settle_failed(p_user uuid, p_now timestamptz, p_lease timestamptz) returns void
language sql set search_path = public as $$
  update public.reward_due
    set failures = failures + 1,
        due_at = least(p_now + case when failures + 1 >= 5 then interval '24 hours' else interval '1 hour' end,
                       case when due_at = p_lease then 'infinity'::timestamptz else due_at end)
    where user_id = p_user
$$;

-- the sweep's loop without transaction control, driven by p_now (pgTAP, the e2e); returns users settled
create or replace function public.settle_due_rewards_at(p_limit int, p_now timestamptz) returns int
language plpgsql set search_path = public as $$
declare
  v_user uuid;
  v_lease timestamptz;
  v_done uuid[] := '{}';
  v_n int := 0;
begin
  if p_limit is null or p_limit < 1 then
    return 0;
  end if;
  loop
    exit when v_n >= p_limit;
    select d.user_id into v_user from public.reward_due d
      where d.due_at <= p_now and not (d.user_id = any(v_done))
      order by d.due_at limit 1 for update skip locked;
    exit when v_user is null;
    v_lease := p_now + interval '10 minutes';
    update public.reward_due set due_at = v_lease where user_id = v_user;
    begin
      perform public.settle_rewards(v_user, p_now, v_lease);
    exception when others then
      perform public.reward_settle_failed(v_user, p_now, v_lease);
    end;
    v_done := v_done || v_user;
    v_user := null;
    v_n := v_n + 1;
  end loop;
  if v_n >= p_limit then
    raise log 'settle-rewards more';
  end if;
  return v_n;
end $$;

-- THE ONE DOCUMENTED EXCEPTION to convention #5 (ruling r1-M1): a procedure that COMMITs cannot carry
-- SET search_path, so every name is schema-qualified and the path is set per transaction. Every
-- transaction starts with lock_timeout 2 s (T5 review): the claim and lease, then (after COMMIT, so the
-- queue row is never locked while settling and apply_trip's enqueue never waits) the settlement in a
-- sub-block, then COMMIT outside it. A lock the run cannot get within 2 s (55P03) ends the run
-- cleanly: in the claim nothing was leased; in a settlement the lease backs off as for any failure,
-- or, if even that cannot lock, simply expires. The run also stops after 4 minutes or p_limit users
-- (statement_timeout is not enforced inside a CALL; see the header).
create or replace procedure public.settle_due_rewards(p_limit int default 200)
language plpgsql as $$
declare
  v_user uuid;
  v_lease timestamptz;
  v_now timestamptz;
  v_n int := 0;
  v_done uuid[] := '{}';
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_stop boolean := false;
begin
  loop
    perform pg_catalog.set_config('search_path', 'public, pg_temp', true);
    perform pg_catalog.set_config('lock_timeout', '2s', true);
    exit when v_n >= p_limit or pg_catalog.clock_timestamp() - v_start > interval '4 minutes';
    v_user := null;
    begin
      select d.user_id into v_user from public.reward_due d
        where d.due_at <= pg_catalog.now() and not (d.user_id = any(v_done))
        order by d.due_at limit 1 for update skip locked;
      if v_user is not null then
        v_lease := pg_catalog.now() + interval '10 minutes';
        update public.reward_due set due_at = v_lease where user_id = v_user;
      end if;
    exception when lock_not_available then
      v_user := null;
      v_stop := true;
    end;
    commit;
    exit when v_user is null;
    perform pg_catalog.set_config('search_path', 'public, pg_temp', true);
    perform pg_catalog.set_config('lock_timeout', '2s', true);
    perform pg_catalog.set_config('statement_timeout', '20s', true);
    v_now := pg_catalog.now();
    begin
      perform public.settle_rewards(v_user, v_now, v_lease);
    exception when others then
      if sqlstate = '55P03' then
        v_stop := true;
      end if;
      begin
        perform public.reward_settle_failed(v_user, v_now, v_lease);
      exception when lock_not_available then
        v_stop := true;
      end;
    end;
    commit;
    v_done := v_done || v_user;
    v_n := v_n + 1;
    exit when v_stop;
  end loop;
  if v_stop then
    raise log 'settle-rewards stopped on a lock';
  elsif v_n >= p_limit or pg_catalog.clock_timestamp() - v_start > interval '4 minutes' then
    raise log 'settle-rewards more';
  end if;
end $$;

-- retention (ruling r1-M2): contradictions older than 400 days, 5,000 a batch, at most 10 batches a run
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
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- triggers on the writers' tables
-- ---------------------------------------------------------------------------
-- §R8: one pure upsert, reads nothing; runs inside apply_trip's and apply_recompute's own transaction
create or replace function public.enqueue_reward_settlement() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into public.reward_due (user_id, due_at)
  values (new.user_id, ((new.day + 1)::timestamp + interval '2 hours') at time zone 'Etc/GMT-14')
  on conflict (user_id) do update set due_at = least(public.reward_due.due_at, excluded.due_at);
  return null;
end $$;
create trigger score_daily_enqueue_reward after insert or update on public.score_daily
  for each row execute function public.enqueue_reward_settlement();

-- §R2 relabel audit: one upsert, before or after settlement
create or replace function public.audit_trip_relabel() returns trigger
language plpgsql set search_path = public as $$
begin
  -- (security M-1) one row per (drive, target role, local day in the drive's zone): toggling a role
  -- updates that row's lastAt and count instead of adding rows, so the table stays bounded
  insert into public.reward_contradictions (user_id, day, kind, detail, dedupe_key)
  select new.user_id, new.local_day, 'relabel_with_events',
    jsonb_build_object('tripId', new.id, 'from', old.role, 'to', new.role,
      'daySettled', exists (select 1 from public.reward_days rd where rd.user_id = new.user_id and rd.day = new.local_day),
      'firstAt', now(), 'lastAt', now(), 'count', 1),
    'relabel:' || new.id || ':' || new.role || ':' || (now() at time zone new.tz)::date
  where exists (select 1 from public.trip_events ev where ev.trip_id = new.id and ev.status = 'scored')
  on conflict (user_id, dedupe_key) do update
    set detail = public.reward_contradictions.detail || jsonb_build_object(
      'lastAt', now(),
      'count', coalesce((public.reward_contradictions.detail ->> 'count')::int, 1) + 1,
      'daySettled', coalesce((public.reward_contradictions.detail ->> 'daySettled')::boolean, false)
                    or coalesce((excluded.detail ->> 'daySettled')::boolean, false));
  return null;
end $$;
create trigger trips_audit_relabel after update of role on public.trips
  for each row when (old.role is distinct from new.role)
  execute function public.audit_trip_relabel();

-- the under-13 minimisation of the rewards tables (R-H resets the class). DEFINER: the service role's
-- support correction has no privilege on these tables; 0006's definer trigger (which sorts, and so
-- fires, first) has already refused any other caller, and this repeats its check.
create or replace function public.minimise_underage_rewards() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce(auth.uid() = new.id, false)
          or coalesce(auth.role() = 'service_role', false)
          or (auth.uid() is null and session_user = 'postgres')) then
    raise exception 'minimise_underage_rewards requires the account owner or the service role' using errcode = 'insufficient_privilege';
  end if;
  delete from public.points_ledger where user_id = new.id;
  delete from public.reward_days where user_id = new.id;
  delete from public.weekly_goals where user_id = new.id;
  delete from public.reward_due where user_id = new.id;
  delete from public.reward_contradictions where user_id = new.id;
  delete from public.progress where user_id = new.id;
  update public.profiles set level = 1 where id = new.id and level <> 1;
  return null;
end $$;
create trigger profiles_minimise_underage_rewards after update of age_band on public.profiles
  for each row when (new.age_band = 'u13' and old.age_band is distinct from 'u13')
  execute function public.minimise_underage_rewards();

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- this week's goal, materialised on first look: { week_start, category, source, target_days,
-- pass_days, fail_days, state, prorated }
create or replace function public.open_my_week() returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_goal public.weekly_goals%rowtype;
begin
  if v_uid is null then
    raise exception 'open_my_week requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  v_goal := public.ensure_week_goal(v_uid, date_trunc('week', public.user_local_date(v_uid))::date,
    coalesce(public.user_tz(v_uid), 'UTC'), now());
  return jsonb_build_object('week_start', v_goal.week_start, 'category', v_goal.category, 'source', v_goal.source,
    'target_days', v_goal.target_days, 'pass_days', v_goal.pass_days, 'fail_days', v_goal.fail_days,
    'state', v_goal.state, 'prorated', v_goal.prorated);
end $$;

-- the driver's chosen focus: this week while nothing has counted yet, else next week
create or replace function public.set_weekly_focus(p_category text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '2s' as $$
declare
  v_uid uuid := auth.uid();
  v_goal public.weekly_goals%rowtype;
  v_count int;
  v_start timestamptz;
  v_applied text;
begin
  if v_uid is null then
    raise exception 'set_weekly_focus requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.age_band = 'u13') then
    raise exception 'account not eligible' using errcode = 'insufficient_privilege';
  end if;
  if p_category is null or p_category not in ('phone', 'speeding', 'braking', 'accel', 'cornering') then
    raise exception 'unknown focus' using errcode = 'invalid_parameter_value';
  end if;
  -- 20 a day (M4's invite_day pattern: the rate_limits row is the counter and the mutex)
  insert into public.rate_limits (user_id, key) values (v_uid, 'focus_day') on conflict (user_id, key) do nothing;
  select rl.count, rl.window_start into v_count, v_start from public.rate_limits rl where rl.user_id = v_uid and rl.key = 'focus_day' for update;
  if v_start <= now() - interval '24 hours' then
    v_count := 0;
    v_start := now();
  end if;
  if v_count >= 20 then
    raise exception 'focus limit reached' using errcode = 'insufficient_privilege';
  end if;
  update public.rate_limits set count = v_count + 1, window_start = v_start where user_id = v_uid and key = 'focus_day';

  v_goal := public.ensure_week_goal(v_uid, date_trunc('week', public.user_local_date(v_uid))::date,
    coalesce(public.user_tz(v_uid), 'UTC'), now());
  if v_goal.state = 'active' and v_goal.pass_days + v_goal.fail_days = 0 then
    update public.weekly_goals set category = p_category, source = 'chosen'
      where user_id = v_uid and week_start = v_goal.week_start
      returning * into v_goal;
    v_applied := 'this_week';
  else
    update public.progress set next_focus = p_category where user_id = v_uid;
    v_applied := 'next_week';
  end if;
  return jsonb_build_object('applied', v_applied, 'goal', jsonb_build_object('week_start', v_goal.week_start,
    'category', v_goal.category, 'source', v_goal.source, 'target_days', v_goal.target_days, 'pass_days', v_goal.pass_days,
    'fail_days', v_goal.fail_days, 'state', v_goal.state, 'prorated', v_goal.prorated));
end $$;

-- ---------------------------------------------------------------------------
-- cron
-- ---------------------------------------------------------------------------
select cron.schedule('settle-rewards', '*/5 * * * *', 'call public.settle_due_rewards(200)');
select cron.schedule('purge-reward-audit', '40 4 * * *', 'select public.purge_reward_audit()');

-- ---------------------------------------------------------------------------
-- RLS, policies, grants: no DML for any API role on any new table, the service role included
-- ---------------------------------------------------------------------------
alter table public.progress enable row level security;
alter table public.points_ledger enable row level security;
alter table public.reward_days enable row level security;
alter table public.reward_due enable row level security;
alter table public.weekly_goals enable row level security;
alter table public.reward_contradictions enable row level security;

create policy progress_select_own on public.progress for select to authenticated using (user_id = (select auth.uid()));
create policy points_ledger_select_own on public.points_ledger for select to authenticated using (user_id = (select auth.uid()));
create policy reward_days_select_own on public.reward_days for select to authenticated using (user_id = (select auth.uid()));
create policy weekly_goals_select_own on public.weekly_goals for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.progress from anon, authenticated, service_role;
revoke all on public.points_ledger from anon, authenticated, service_role;
revoke all on public.reward_days from anon, authenticated, service_role;
revoke all on public.reward_due from anon, authenticated, service_role;
revoke all on public.weekly_goals from anon, authenticated, service_role;
revoke all on public.reward_contradictions from anon, authenticated, service_role;
grant select on public.progress to authenticated;
grant select on public.points_ledger to authenticated;
grant select (user_id, day, outcome, outcome_reason, tier, phone_free, camera, predicates, points, streak_after, wall_close,
  settled_at, source_updated_at, created_at, updated_at) on public.reward_days to authenticated;
grant select on public.weekly_goals to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.reward_rules()', 'public.clamp_device_watermark()', 'public.valid_reward_predicates(jsonb)',
    'public.freeze_reward_day()', 'public.reward_wall_close(date, text[])', 'public.reward_day_facts(uuid, date, date, text)', 'public.start_rewards_for_existing_users()',
    'public.reward_day_ready(uuid, timestamptz, timestamptz)', 'public.reward_outcome(public.reward_fact)',
    'public.reward_tier(public.reward_fact)', 'public.reward_predicates(public.reward_fact)',
    'public.reward_fact_summary(public.reward_fact)', 'public.reward_zone_hop(uuid, timestamptz)',
    'public.reward_week_closed(uuid, date, text, timestamptz)', 'public.weakest_goal_category(uuid, date)',
    'public.reward_credit(uuid, text, int, text, text)', 'public.settle_days(uuid, text, timestamptz)',
    'public.append_streak(uuid, date[])', 'public.reward_goal_counts(uuid, date, text)',
    'public.ensure_week_goal(uuid, date, text, timestamptz)', 'public.settle_goals(uuid, text, timestamptz, date[])',
    'public.refresh_progress(uuid)', 'public.emit_reward_events(uuid, jsonb, text, timestamptz)',
    'public.reward_retry_at(timestamptz, timestamptz)', 'public.schedule_next_settle(uuid, text, timestamptz, timestamptz)',
    'public.settle_rewards(uuid, timestamptz, timestamptz)', 'public.reward_settle_failed(uuid, timestamptz, timestamptz)',
    'public.settle_due_rewards_at(int, timestamptz)', 'public.purge_reward_audit()', 'public.enqueue_reward_settlement()',
    'public.audit_trip_relabel()', 'public.minimise_underage_rewards()',
    'public.open_my_week()', 'public.set_weekly_focus(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
revoke all on procedure public.settle_due_rewards(int) from public, anon, authenticated, service_role;
grant execute on function public.open_my_week() to authenticated;
grant execute on function public.set_weekly_focus(text) to authenticated;
