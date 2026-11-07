-- 0038_wrapped: the monthly Wrapped, server side.
--
--   * A month is the calendar month of a drive's local_day ('YYYY-MM'). The month's drives are its
--     scored drives not marked "Wasn't driving" (drive combining is gone since 0032, so no
--     merged_into test). A driver is eligible for a month with 3 or more of them.
--   * private.wrapped_trips(month, user): one row per such drive with its active event counts and
--     its drive score, the SQL copy of scoring driveScore (per category weight / max(opportunities,
--     floor, count), no prior; Attention when DashPal watched; Phone use when the drive has phone
--     seconds or a pickup; the weighted mean rounded half up to a whole number). The server stores
--     no drive score, so it is computed here from the stored events and exposure.
--   * private.wrapped_stats(user, month): the month's stats (totals, safety, smoothness, phone and
--     speed, habits, progress) and its archetype (private.wrapped_archetype: one style id, then
--     one pattern id); null when the driver is not eligible.
--   * private.monthly_stats: every eligible driver's comparable numbers per month (miles, average
--     drive score, clean share, hard events / speeding / pickups per 100 mi), refreshed by pg_cron
--     at 04:30 UTC daily for the current month and, on days 1 to 10, the month before; the month
--     just ended also every hour of the push window (inside produce_monthly_wrapped), so the push
--     never lands on a cohort missing the month's last day. Percentiles
--     (private.wrapped_percentiles) compare the driver's own row, computed live, with every OTHER
--     driver's stored row: round(100 x others strictly worse / (N - 1)), N counting the driver;
--     null under 25 eligible drivers, and null under 10 (never shame).
--   * RPCs: list_my_wrapped, get_my_wrapped, create_wrapped_share, delete_wrapped_share,
--     get_shared_wrapped, each rate-limited per user. A shared Wrapped is a snapshot in
--     public.wrapped_shares, one per driver and month (sharing again keeps the id and refreshes the
--     snapshot; deleting it ends the link, and sharing again then makes a new one). It holds no
--     route, place, speed or clock time: no busiest time band, no early or rush share, no weekday /
--     weekend split, no goals.
--   * private.wrapped_archive keeps each listed month's drives, miles and archetype, so the archive
--     does not compute up to 24 months of stats (and 48 ratings) on every open.
--   * Push: inbox kind monthly_wrapped, queued hourly by private.produce_monthly_wrapped for each
--     driver eligible last month whose local time is the 1st, 10:00-10:59 (dedupe
--     'monthly_wrapped:YYYY-MM', payload { month }); claim_push_batch reads the weekly recap switch
--     for it.
--   * export_account is format 8: it adds the driver's wrapped_shares, monthly_stats and
--     wrapped_archive rows.
--
-- Deploy: this migration, then push-sender (it knows the new kind; an older one skips it as
-- unknown_type), then the app.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table private.monthly_stats (
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  drives int not null check (drives >= 3),
  miles numeric not null check (miles >= 0),
  avg_score numeric check (avg_score between 0 and 100),
  clean_share numeric not null check (clean_share between 0 and 1),
  hard_per100 numeric not null check (hard_per100 >= 0),
  speeding_per100 numeric not null check (speeding_per100 >= 0),
  pickups_per100 numeric not null check (pickups_per100 >= 0),
  refreshed_at timestamptz not null default now(),
  primary key (month, user_id)
);
-- the account's own rows (export, the delete cascade)
create index monthly_stats_user_idx on private.monthly_stats (user_id);

alter table private.monthly_stats enable row level security;
revoke all on private.monthly_stats from public, anon, authenticated;

create table public.wrapped_shares (
  id text primary key check (id ~ '^[A-Za-z0-9]{12}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and pg_column_size(snapshot) <= 8192),
  created_at timestamptz not null default now(),
  constraint wrapped_shares_user_month unique (user_id, month)
);

alter table public.wrapped_shares enable row level security;
revoke all on public.wrapped_shares from public, anon, authenticated;
-- the server side (the secret key's service_role) is granted explicitly, as for trips
grant select, insert, update, delete on public.wrapped_shares to service_role;

-- the archive's line per driver and past month (its drives, miles and archetype), kept when the
-- month's stats are computed so list_my_wrapped reads it instead of computing every month again. A
-- line is used only while the month's drives and miles still match it (a late drive or a
-- "Wasn't driving" mark computes it again); opening the month writes it again too.
create table private.wrapped_archive (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  drives int not null check (drives >= 3),
  miles numeric not null check (miles >= 0),
  archetype jsonb not null check (jsonb_typeof(archetype) = 'object'),
  computed_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table private.wrapped_archive enable row level security;
revoke all on private.wrapped_archive from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- the month
-- ---------------------------------------------------------------------------
-- the first day of a 'YYYY-MM' month; anything else is refused
create or replace function private.wrapped_month_start(p_month text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'month must be YYYY-MM' using errcode = 'invalid_parameter_value';
  end if;
  return to_date(p_month || '-01', 'YYYY-MM-DD');
end $$;

-- 3 or more scored drives, not marked "Wasn't driving", on local days in the month
create or replace function private.wrapped_eligible(p_user uuid, p_month text) returns boolean
language sql stable set search_path = public as $$
  select count(*) >= 3 from public.trips t
  where t.user_id = p_user and t.scored and not t.not_driving
    and t.local_day >= private.wrapped_month_start(p_month)
    and t.local_day < (private.wrapped_month_start(p_month) + interval '1 month')::date
$$;

-- ---------------------------------------------------------------------------
-- the month's drives, each with its event counts and its drive score
-- ---------------------------------------------------------------------------
-- p_user null: every driver's (the cohort refresh). The drive score is scoring driveScore: per rate
-- category rate_score(weight / max(opportunities, floor, count)) with the BASELINE floors (braking,
-- acceleration, turning 10; speed and phone use 600 s), Attention category_score over the watched
-- miles floored at 3 when DashPal watched, Phone use only with phone seconds or a pickup; the
-- weighted mean in radar order (Speed and Phone use double), clamped and rounded half up to a whole
-- number. Null with no miles.
create or replace function private.wrapped_trips(p_month text, p_user uuid default null)
returns table (user_id uuid, trip_id uuid, started_at timestamptz, tz text, miles numeric, duration_s int, clean boolean,
  n_hard int, n_speeding int, n_pickup int, score double precision)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
declare
  v_d0 date := private.wrapped_month_start(p_month);
  v_d1 date := (private.wrapped_month_start(p_month) + interval '1 month')::date;
  v_ids uuid[];
begin
  if p_user is null then
    -- the started_at range lets the planner read the BRIN index; a local day is within a day of
    -- its UTC start, so three days each side keep every drive of the month
    select coalesce(array_agg(t.id), '{}') into v_ids from public.trips t
    where t.scored and not t.not_driving and t.local_day >= v_d0 and t.local_day < v_d1
      and t.started_at >= (v_d0::timestamp at time zone 'UTC') - interval '3 days'
      and t.started_at < (v_d1::timestamp at time zone 'UTC') + interval '3 days';
  else
    select coalesce(array_agg(t.id), '{}') into v_ids from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.local_day >= v_d0 and t.local_day < v_d1;
  end if;
  return query
  with d as materialized (
    select t.id, t.user_id, t.started_at, t.tz, t.miles, t.duration_s, t.clean,
      coalesce(t.slowdowns, 0) as slowdowns, coalesce(t.speedups, 0) as speedups, coalesce(t.turns, 0) as turns,
      least(coalesce(t.limit_s, 0), coalesce(t.moving_s, 0)) as limit_s, least(coalesce(t.phone_s, 0), coalesce(t.moving_s, 0)) as phone_s,
      -- scoring watchedMiles
      case when t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0
           then t.miles::float8 * least(t.dashcam_covered_s, t.dashcam_moving_s)::float8 / t.dashcam_moving_s::float8
           else 0::float8 end as watched
    from public.trips t where t.id = any(v_ids)
  ),
  ev as (
    select e.trip_id,
      count(*) filter (where e.type in ('hard_brake', 'hard_accel', 'hard_corner')) as n_hard,
      count(*) filter (where e.type = 'speeding') as n_speeding,
      count(*) filter (where e.type = 'phone_pickup') as n_pickup,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_brake'), 0::float8) as b_w,
      count(*) filter (where e.type = 'hard_brake') as b_n,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_accel'), 0::float8) as a_w,
      count(*) filter (where e.type = 'hard_accel') as a_n,
      coalesce(sum(private.hard_event_weight(e.type, e.tier, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'hard_corner'), 0::float8) as t_w,
      count(*) filter (where e.type = 'hard_corner') as t_n,
      coalesce(sum(private.speeding_weight(e.duration_s, e.measured, e.tier) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding'), 0::float8) as s_w,
      -- scoring speedingChargedS: max(1, duration)
      coalesce(sum(greatest(1::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'speeding'), 0::float8) as s_n,
      coalesce(sum(private.phone_pickup_weight(e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup'), 0::float8) as p_w,
      -- scoring phoneInHandS: the seconds in hand clamped to 0..43 200
      coalesce(sum(least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id) filter (where e.type = 'phone_pickup'), 0::float8) as p_n,
      coalesce(sum(private.attention_weight(e.type, e.duration_s, e.measured) order by e.started_at, e.client_event_id) filter (where e.type in ('eyes_off', 'drowsy')), 0::float8) as att
    from d join public.trip_events e on e.trip_id = d.id
    where e.status = 'active'
    group by e.trip_id
  ),
  s as (
    select d.*, coalesce(ev.n_hard, 0)::int as n_hard, coalesce(ev.n_speeding, 0)::int as n_speeding, coalesce(ev.n_pickup, 0)::int as n_pickup,
      private.rate_score(coalesce(ev.a_w, 0::float8) / greatest(d.speedups::float8, 10::float8, coalesce(ev.a_n, 0)::float8), 0.008::float8) as s_a,
      private.rate_score(coalesce(ev.b_w, 0::float8) / greatest(d.slowdowns::float8, 10::float8, coalesce(ev.b_n, 0)::float8), 0.010::float8) as s_b,
      private.rate_score(coalesce(ev.t_w, 0::float8) / greatest(d.turns::float8, 10::float8, coalesce(ev.t_n, 0)::float8), 0.008::float8) as s_t,
      case when d.watched > 0 then private.category_score(coalesce(ev.att, 0::float8), d.watched, 3::float8) end as s_att,
      case when d.phone_s > 0 or coalesce(ev.p_n, 0::float8) > 0
           then private.rate_score(coalesce(ev.p_w, 0::float8) / greatest(d.phone_s::float8, 600::float8, coalesce(ev.p_n, 0::float8)), 0.040::float8) end as s_p,
      private.rate_score(coalesce(ev.s_w, 0::float8) / greatest(d.limit_s::float8, 600::float8, coalesce(ev.s_n, 0::float8)), 0.040::float8) as s_s
    from d left join ev on ev.trip_id = d.id
  )
  select s.user_id, s.id, s.started_at, s.tz, s.miles, s.duration_s, s.clean, s.n_hard, s.n_speeding, s.n_pickup,
    case when s.miles > 0 then private.round_half_up(least(100::float8, greatest(0::float8,
      (1::float8 * s.s_a + 1::float8 * s.s_b + 1::float8 * s.s_t + coalesce(1::float8 * s.s_att, 0::float8) + coalesce(2::float8 * s.s_p, 0::float8) + 2::float8 * s.s_s)
      / (1 + 1 + 1 + case when s.s_att is null then 0 else 1 end + case when s.s_p is null then 0 else 2 end + 2)::float8)), 0) end
  from s;
end $$;

-- ---------------------------------------------------------------------------
-- the comparable numbers: one row per eligible driver (p_user null: every one)
-- ---------------------------------------------------------------------------
-- miles to 1 decimal, the average drive score to 1, the clean share to 4 and the per-100-mile rates
-- to 2: the stored cohort and a driver's live row are rounded alike, so equal numbers tie
create or replace function private.wrapped_month_rows(p_month text, p_user uuid default null)
returns table (user_id uuid, drives int, miles numeric, avg_score numeric, clean_share numeric,
  hard_per100 numeric, speeding_per100 numeric, pickups_per100 numeric)
language sql stable set search_path = public as $$
  select f.user_id, count(*)::int, round(sum(f.miles), 1), round(avg(f.score)::numeric, 1),
    round(count(*) filter (where f.clean)::numeric / count(*), 4),
    round(case when sum(f.miles) > 0 then 100 * sum(f.n_hard) / sum(f.miles) else 0 end, 2),
    round(case when sum(f.miles) > 0 then 100 * sum(f.n_speeding) / sum(f.miles) else 0 end, 2),
    round(case when sum(f.miles) > 0 then 100 * sum(f.n_pickup) / sum(f.miles) else 0 end, 2)
  from private.wrapped_trips(p_month, p_user) f
  group by f.user_id
  having count(*) >= 3
$$;

-- the month's cohort, written again whole; the number of eligible drivers
create or replace function private.refresh_monthly_stats(p_month text) returns int
language plpgsql volatile set search_path = public as $$
declare
  v_n int;
begin
  perform private.wrapped_month_start(p_month);
  delete from private.monthly_stats s where s.month = p_month;
  insert into private.monthly_stats (month, user_id, drives, miles, avg_score, clean_share, hard_per100, speeding_per100, pickups_per100)
    select p_month, r.user_id, r.drives, r.miles, r.avg_score, r.clean_share, r.hard_per100, r.speeding_per100, r.pickups_per100
    from private.wrapped_month_rows(p_month, null) r;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- the daily job: the current UTC month to date, and on days 1 to 10 the month before (its last
-- drives still arriving)
create or replace function private.refresh_monthly_stats_daily(p_now timestamptz default now()) returns int
language plpgsql volatile set search_path = public as $$
declare
  v_utc timestamp := p_now at time zone 'UTC';
  v_n int;
begin
  v_n := private.refresh_monthly_stats(to_char(v_utc, 'YYYY-MM'));
  if extract(day from v_utc) <= 10 then
    v_n := v_n + private.refresh_monthly_stats(to_char(v_utc - interval '1 month', 'YYYY-MM'));
  end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- percentiles
-- ---------------------------------------------------------------------------
-- 'better than x% of drivers': x = round(100 x worse / (n - 1)); null when x is under 10
create or replace function private.wrapped_pct(p_worse int, p_n int) returns int
language sql immutable set search_path = public as $$
  select case when p_n is null or p_n < 2 or p_worse is null then null
              when round(100.0 * p_worse / (p_n - 1)) < 10 then null
              else round(100.0 * p_worse / (p_n - 1))::int end
$$;

-- the driver's own row, computed live, against every OTHER driver's stored row for the month;
-- higher is better for miles, the average drive score and the clean share, lower for the rates;
-- a tie is not worse. Every value null under 25 eligible drivers (the driver counted) or when the
-- driver is not eligible.
create or replace function private.wrapped_percentiles(p_user uuid, p_month text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  me record;
  v_n int;
  w_miles int; w_score int; w_clean int; w_hard int; w_speeding int; w_pickups int;
begin
  select * into me from private.wrapped_month_rows(p_month, p_user) r limit 1;
  if found then
    select count(*)::int + 1,
      count(*) filter (where s.miles < me.miles)::int,
      count(*) filter (where s.avg_score < me.avg_score)::int,
      count(*) filter (where s.clean_share < me.clean_share)::int,
      count(*) filter (where s.hard_per100 > me.hard_per100)::int,
      count(*) filter (where s.speeding_per100 > me.speeding_per100)::int,
      count(*) filter (where s.pickups_per100 > me.pickups_per100)::int
      into v_n, w_miles, w_score, w_clean, w_hard, w_speeding, w_pickups
    from private.monthly_stats s where s.month = p_month and s.user_id <> p_user;
  end if;
  if not found or v_n is null or v_n < 25 then
    return jsonb_build_object('miles', null, 'avgScore', null, 'cleanShare', null, 'hardPer100', null, 'speedingPer100', null, 'pickupsPer100', null);
  end if;
  return jsonb_build_object(
    'miles', private.wrapped_pct(w_miles, v_n),
    'avgScore', case when me.avg_score is null then null else private.wrapped_pct(w_score, v_n) end,
    'cleanShare', private.wrapped_pct(w_clean, v_n),
    'hardPer100', private.wrapped_pct(w_hard, v_n),
    'speedingPer100', private.wrapped_pct(w_speeding, v_n),
    'pickupsPer100', private.wrapped_pct(w_pickups, v_n));
end $$;

-- ---------------------------------------------------------------------------
-- the archetype: one style id, then one pattern id
-- ---------------------------------------------------------------------------
-- p_categories: the month-end whole-number category scores (null while unranked). Ties go to the
-- first of speed, phone, braking, acceleration, turning (then attention).
--   style, first match: a Safety Rating under 60 or any category under 60 (Attention included) →
--   from the lowest category: speed lead_footed, phone phone_happy, braking / acceleration /
--   turning jumpy, attention (DashPal only) bumpy; a clean share under 30% → bumpy; the rating up 5 or more on the month's start → rising; a clean share of
--   80% or more → spotless; the best category 80 or more (Attention never best): speed steady,
--   braking / acceleration / turning smooth, phone focused; else easygoing.
--   pattern, first match: an average drive of 20 mi or more, or a longest of 100 mi or more →
--   road_tripper; rush share 50% or more → commuter; early share 40% or more → early_bird; weekend
--   share 50% or more → weekend_cruiser; an average drive under 5 mi over 12 drives or more →
--   city_hopper; else cruiser.
create or replace function private.wrapped_archetype(p_rating_end numeric, p_rating_start numeric, p_categories jsonb,
  p_clean_share double precision, p_drives int, p_avg_miles double precision, p_longest_miles double precision,
  p_rush_share double precision, p_early_share double precision, p_weekend_share double precision) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_low_key text; v_low numeric;
  v_high_key text; v_high numeric;
  v_style text;
  v_pattern text;
begin
  -- the lowest of every category, Attention included (it ties last)
  select x.k, (p_categories ->> x.k)::numeric into v_low_key, v_low
    from unnest(array['speed', 'phone', 'braking', 'acceleration', 'turning', 'attention']) with ordinality as x(k, n)
    where jsonb_typeof(p_categories -> x.k) = 'number'
    order by (p_categories ->> x.k)::numeric, x.n limit 1;
  select x.k, (p_categories ->> x.k)::numeric into v_high_key, v_high
    from unnest(array['speed', 'phone', 'braking', 'acceleration', 'turning']) with ordinality as x(k, n)
    where jsonb_typeof(p_categories -> x.k) = 'number'
    order by (p_categories ->> x.k)::numeric desc, x.n limit 1;
  if (p_rating_end is not null and p_rating_end < 60) or (v_low is not null and v_low < 60) then
    -- Attention lowest (or no category at all): no category word fits, so Bumpy
    v_style := case v_low_key when 'speed' then 'lead_footed' when 'phone' then 'phone_happy'
                              when 'braking' then 'jumpy' when 'acceleration' then 'jumpy' when 'turning' then 'jumpy'
                              else 'bumpy' end;
  elsif coalesce(p_clean_share, 0) < 0.30 then
    v_style := 'bumpy';
  elsif p_rating_end is not null and p_rating_start is not null and p_rating_end - p_rating_start >= 5 then
    v_style := 'rising';
  elsif p_clean_share >= 0.80 then
    v_style := 'spotless';
  elsif v_high is not null and v_high >= 80 then
    v_style := case v_high_key when 'speed' then 'steady' when 'phone' then 'focused' else 'smooth' end;
  else
    v_style := 'easygoing';
  end if;
  v_pattern := case
    when coalesce(p_avg_miles, 0) >= 20 or coalesce(p_longest_miles, 0) >= 100 then 'road_tripper'
    when coalesce(p_rush_share, 0) >= 0.5 then 'commuter'
    when coalesce(p_early_share, 0) >= 0.4 then 'early_bird'
    when coalesce(p_weekend_share, 0) >= 0.5 then 'weekend_cruiser'
    when coalesce(p_avg_miles, 0) < 5 and coalesce(p_drives, 0) >= 12 then 'city_hopper'
    else 'cruiser' end;
  return jsonb_build_object('style', v_style, 'pattern', v_pattern);
end $$;

-- ---------------------------------------------------------------------------
-- the month's stats
-- ---------------------------------------------------------------------------
-- Null when the driver is not eligible. Month boundaries and badge dates are read in the driver's
-- zone (private.user_tz); a drive's weekday and hour in its own zone. Ratings are as of local
-- midnight at the month's start and end (never later than now), each null while unranked; the
-- category scores are the month-end 90-day scores, whole numbers, null while unranked (Attention
-- null without DashPal miles, Phone use null when not tracked).
create or replace function private.wrapped_stats(p_user uuid, p_month text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_d0 date := private.wrapped_month_start(p_month);
  v_d1 date := (private.wrapped_month_start(p_month) + interval '1 month')::date;
  v_tz text;
  a record;
  v_end jsonb;
  v_start jsonb;
  v_rating_end numeric;
  v_rating_start numeric;
  v_cats jsonb;
  v_best text;
  v_badges jsonb;
  v_goals int;
  v_clean_share float8;
  v_avg_miles float8;
begin
  if p_user is null or not private.wrapped_eligible(p_user, p_month) then
    return null;
  end if;
  v_tz := private.user_tz(p_user);
  with f as materialized (
    select x.*, (x.started_at at time zone x.tz) as lt from private.wrapped_trips(p_month, p_user) x
  )
  select count(*)::int as drives, coalesce(sum(f.miles), 0) as miles, coalesce(sum(f.duration_s), 0)::int as duration_s,
    coalesce(max(f.miles), 0) as longest, avg(f.score) as avg_score,
    count(*) filter (where f.clean)::int as clean_n, max(f.miles) filter (where f.clean) as longest_clean,
    coalesce(sum(f.n_hard), 0)::int as n_hard, coalesce(sum(f.n_speeding), 0)::int as n_speeding, coalesce(sum(f.n_pickup), 0)::int as n_pickup,
    -- the most drives; a tie goes to the earlier weekday (ISO, 1 = Monday) or band
    mode() within group (order by extract(isodow from f.lt)::int) as weekday,
    mode() within group (order by (floor(extract(hour from f.lt) / 3) * 3)::int) as band,
    count(*) filter (where extract(isodow from f.lt) >= 6)::int as weekend_n,
    count(*) filter (where extract(hour from f.lt) between 5 and 8)::int as early_n,
    count(*) filter (where extract(isodow from f.lt) <= 5
                       and (extract(hour from f.lt) between 6 and 9 or extract(hour from f.lt) between 15 and 18))::int as rush_n
    into a
  from f;
  if a.drives < 3 then
    return null;
  end if;

  v_end := private.rating_at(p_user, least(now(), v_d1::timestamp at time zone v_tz));
  v_start := private.rating_at(p_user, least(now(), v_d0::timestamp at time zone v_tz));
  v_rating_end := case when (v_end ->> 'ranked')::boolean then (v_end ->> 'rating')::numeric end;
  v_rating_start := case when (v_start ->> 'ranked')::boolean then (v_start ->> 'rating')::numeric end;
  select jsonb_object_agg(x.k, case when (v_end ->> 'ranked')::boolean and jsonb_typeof(v_end -> 'scores' -> x.k) = 'number'
                                    then private.round_half_up((v_end -> 'scores' ->> x.k)::float8, 0)::int end)
    into v_cats
  from unnest(array['speed', 'braking', 'acceleration', 'turning', 'phone', 'attention']) x(k);
  select x.k into v_best
    from unnest(array['speed', 'phone', 'braking', 'acceleration', 'turning']) with ordinality as x(k, n)
    where jsonb_typeof(v_cats -> x.k) = 'number'
    order by (v_cats ->> x.k)::int desc, x.n limit 1;

  select coalesce(jsonb_agg(u.achievement_id order by u.unlocked_at, u.achievement_id), '[]'::jsonb) into v_badges
  from public.user_achievements u
  where u.user_id = p_user and (u.unlocked_at at time zone v_tz)::date >= v_d0 and (u.unlocked_at at time zone v_tz)::date < v_d1;
  -- weekly goals done in the weeks (league weeks, 'IYYY-Www') whose Sunday falls in the month
  select count(*)::int into v_goals
  from public.weekly_challenges w
  where w.user_id = p_user and w.completed_at is not null
    and w.league_week in (select to_char(g::date, 'IYYY-"W"IW') from generate_series(v_d0::timestamp, (v_d1 - 1)::timestamp, interval '1 day') g
                          where extract(isodow from g) = 7);

  v_clean_share := a.clean_n::float8 / a.drives;
  v_avg_miles := a.miles::float8 / a.drives;
  return jsonb_build_object(
    'month', p_month,
    -- totals
    'drives', a.drives,
    'miles', round(a.miles, 1),
    'durationS', a.duration_s,
    'avgDriveMiles', round(a.miles / a.drives, 1),
    'longestDriveMiles', round(a.longest, 1),
    -- safety
    'avgScore', case when a.avg_score is null then null else private.round_half_up(a.avg_score, 0)::int end,
    'ratingStart', v_rating_start,
    'ratingEnd', v_rating_end,
    'ratingChange', case when v_rating_end is not null and v_rating_start is not null then round(v_rating_end - v_rating_start, 1) end,
    'cleanDrives', a.clean_n,
    'cleanShare', round(v_clean_share::numeric, 3),
    'longestCleanDriveMiles', round(a.longest_clean, 1),
    -- smoothness, phone and speed
    'hardPer100', case when a.miles > 0 then round(100 * a.n_hard / a.miles, 1) else 0 end,
    'speedingPer100', case when a.miles > 0 then round(100 * a.n_speeding / a.miles, 1) else 0 end,
    'pickupsPer100', case when a.miles > 0 then round(100 * a.n_pickup / a.miles, 1) else 0 end,
    'categories', v_cats,
    'bestCategory', v_best,
    -- habits
    'busiestWeekday', a.weekday,
    'busiestBandStartHour', a.band,
    'weekdayDrives', a.drives - a.weekend_n,
    'weekendDrives', a.weekend_n,
    'earlyShare', round(a.early_n::numeric / a.drives, 3),
    'rushShare', round(a.rush_n::numeric / a.drives, 3),
    -- progress
    'badges', v_badges,
    'goalsCompleted', v_goals,
    'archetype', private.wrapped_archetype(v_rating_end, v_rating_start, v_cats, v_clean_share, a.drives, v_avg_miles, a.longest::float8,
      a.rush_n::float8 / a.drives, a.early_n::float8 / a.drives, a.weekend_n::float8 / a.drives));
end $$;

-- a past month: before the driver's current local month
create or replace function private.wrapped_past(p_user uuid, p_month text) returns boolean
language sql stable set search_path = public as $$
  select private.wrapped_month_start(p_month) < date_trunc('month', now() at time zone private.user_tz(p_user))::date
$$;

-- keeps the archive's line for a month from its computed stats
create or replace function private.wrapped_archive_put(p_user uuid, p_month text, p_stats jsonb) returns void
language sql volatile set search_path = public as $$
  insert into private.wrapped_archive (user_id, month, drives, miles, archetype, computed_at)
  values (p_user, p_month, (p_stats ->> 'drives')::int, (p_stats ->> 'miles')::numeric, p_stats -> 'archetype', now())
  on conflict (user_id, month) do update
    set drives = excluded.drives, miles = excluded.miles, archetype = excluded.archetype, computed_at = excluded.computed_at
$$;

-- 12 base62 characters from the CSPRNG (bytes 248 and up are dropped, so every character is as likely)
create or replace function private.new_share_id() returns text
language plpgsql volatile set search_path = public as $$
declare
  c constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  v_out text := '';
  v_bytes bytea;
  v_b int;
  i int;
begin
  while char_length(v_out) < 12 loop
    v_bytes := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v_b := get_byte(v_bytes, i);
      if v_b < 248 and char_length(v_out) < 12 then
        v_out := v_out || substr(c, 1 + v_b % 62, 1);
      end if;
    end loop;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- client RPCs
-- ---------------------------------------------------------------------------
-- Every RPC takes from a per-user budget (private.require_rate_limit, as get_profile): the reads 60
-- a minute (the archive 30), sharing and unsharing 20 an hour together.
--
-- list_my_wrapped() -> [{ month, drives, miles, archetype: { style, pattern } }]: the caller's
-- eligible past months, newest first, at most 24; each line from private.wrapped_archive while it
-- still matches the month's drives and miles, else computed and kept
create or replace function public.list_my_wrapped() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_cur date;
  v_out jsonb := '[]'::jsonb;
  v_s jsonb;
  v_arch jsonb;
  r record;
begin
  if v_uid is null then
    raise exception 'list_my_wrapped requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'list_my_wrapped', interval '1 minute', 30);
  v_cur := date_trunc('month', now() at time zone private.user_tz(v_uid))::date;
  for r in
    select to_char(t.local_day, 'YYYY-MM') as m, count(*)::int as drives, round(sum(t.miles), 1) as miles from public.trips t
    where t.user_id = v_uid and t.scored and not t.not_driving and t.local_day < v_cur
    group by 1 having count(*) >= 3
    order by 1 desc
    limit 24
  loop
    select c.archetype into v_arch from private.wrapped_archive c
      where c.user_id = v_uid and c.month = r.m and c.drives = r.drives and c.miles = r.miles;
    if not found then
      v_s := private.wrapped_stats(v_uid, r.m);
      if v_s is null then
        continue;
      end if;
      perform private.wrapped_archive_put(v_uid, r.m, v_s);
      v_arch := v_s -> 'archetype';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('month', r.m, 'drives', r.drives, 'miles', r.miles, 'archetype', v_arch));
  end loop;
  return v_out;
end $$;

-- get_my_wrapped(p_month) -> the month's stats, archetype and percentiles; null unless an eligible
-- past month (it keeps the archive's line too)
create or replace function public.get_my_wrapped(p_month text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_s jsonb;
begin
  if v_uid is null then
    raise exception 'get_my_wrapped requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'get_my_wrapped', interval '1 minute', 60);
  perform private.wrapped_month_start(p_month);
  if not private.wrapped_past(v_uid, p_month) then
    return null;
  end if;
  v_s := private.wrapped_stats(v_uid, p_month);
  if v_s is null then
    return null;
  end if;
  perform private.wrapped_archive_put(v_uid, p_month, v_s);
  return v_s || jsonb_build_object('percentiles', private.wrapped_percentiles(v_uid, p_month));
end $$;

-- create_wrapped_share(p_month) -> the share id: a snapshot of the public part of an eligible past
-- month, one per driver and month (sharing again keeps the id and refreshes the snapshot). No
-- route, place, speed or clock time; habits are the busiest weekday only; progress is the badges.
create or replace function public.create_wrapped_share(p_month text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_s jsonb;
  v_snap jsonb;
  v_id text;
  v_try int := 0;
begin
  if v_uid is null then
    raise exception 'create_wrapped_share requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'wrapped_share', interval '1 hour', 20);
  perform private.wrapped_month_start(p_month);
  if private.wrapped_past(v_uid, p_month) then
    v_s := private.wrapped_stats(v_uid, p_month);
  end if;
  if v_s is null then
    raise exception 'wrapped not found' using errcode = 'no_data_found';
  end if;
  perform private.wrapped_archive_put(v_uid, p_month, v_s);
  v_snap := jsonb_build_object(
    'month', p_month,
    'username', (select p.username from public.profiles p where p.id = v_uid),
    'drives', v_s -> 'drives', 'miles', v_s -> 'miles', 'durationS', v_s -> 'durationS',
    'avgDriveMiles', v_s -> 'avgDriveMiles', 'longestDriveMiles', v_s -> 'longestDriveMiles',
    'avgScore', v_s -> 'avgScore', 'ratingStart', v_s -> 'ratingStart', 'ratingEnd', v_s -> 'ratingEnd', 'ratingChange', v_s -> 'ratingChange',
    'cleanDrives', v_s -> 'cleanDrives', 'cleanShare', v_s -> 'cleanShare', 'longestCleanDriveMiles', v_s -> 'longestCleanDriveMiles',
    'hardPer100', v_s -> 'hardPer100', 'speedingPer100', v_s -> 'speedingPer100', 'pickupsPer100', v_s -> 'pickupsPer100',
    'categories', v_s -> 'categories', 'bestCategory', v_s -> 'bestCategory',
    'busiestWeekday', v_s -> 'busiestWeekday',
    'badges', v_s -> 'badges', 'badgesCount', jsonb_array_length(v_s -> 'badges'),
    'archetype', v_s -> 'archetype',
    'percentiles', private.wrapped_percentiles(v_uid, p_month));
  loop
    update public.wrapped_shares w set snapshot = v_snap where w.user_id = v_uid and w.month = p_month returning w.id into v_id;
    if v_id is not null then
      return v_id;
    end if;
    begin
      insert into public.wrapped_shares (id, user_id, month, snapshot) values (private.new_share_id(), v_uid, p_month, v_snap) returning id into v_id;
      return v_id;
    exception when unique_violation then
      -- a share made at the same moment (the update finds it next time) or, all but never, an id
      -- already taken (a new one is drawn)
      v_try := v_try + 1;
      if v_try >= 5 then
        raise;
      end if;
    end;
  end loop;
end $$;

-- delete_wrapped_share(p_month) -> whether a share was deleted: the month's link stops working (it
-- reads as not available); sharing the month again makes a new link
create or replace function public.delete_wrapped_share(p_month text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'delete_wrapped_share requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'wrapped_share', interval '1 hour', 20);
  perform private.wrapped_month_start(p_month);
  delete from public.wrapped_shares w where w.user_id = v_uid and w.month = p_month;
  return found;
end $$;

-- get_shared_wrapped(p_id) -> the snapshot with { id, mine, username } (the current username),
-- for any signed-in driver; null when not found or when either side has blocked the other
create or replace function public.get_shared_wrapped(p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  w record;
begin
  if v_uid is null then
    raise exception 'get_shared_wrapped requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_rate_limit(v_uid, 'get_shared_wrapped', interval '1 minute', 60);
  if p_id is null or p_id !~ '^[A-Za-z0-9]{12}$' then
    return null;
  end if;
  select s.id, s.user_id, s.snapshot into w from public.wrapped_shares s where s.id = p_id;
  if not found or (w.user_id <> v_uid and private.blocked_either(v_uid, w.user_id)) then
    return null;
  end if;
  return w.snapshot || jsonb_build_object('id', w.id, 'mine', w.user_id = v_uid,
    'username', (select p.username from public.profiles p where p.id = w.user_id));
end $$;

-- ---------------------------------------------------------------------------
-- push: monthly_wrapped
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and rel.relname = 'inbox' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%weekly_recap%'
  loop
    execute format('alter table public.inbox drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.inbox add constraint inbox_kind_check
  check (kind in ('weekly_recap', 'friend_request', 'monthly_wrapped'));

-- each driver eligible last month, at 10:xx local on the 1st: { month }; inside the window it also
-- refreshes the month's cohort first
create or replace function private.produce_monthly_wrapped(p_now timestamptz default now()) returns int
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_n int := 0;
  v_local timestamp;
  v_month text;
  v_utc timestamp := p_now at time zone 'UTC';
begin
  -- 10:xx on the 1st somewhere on Earth (UTC-12 to UTC+14) lies between 20:00 UTC on the last day
  -- of the month before and 23:00 UTC on the 1st; outside that window nothing can be due
  if not (extract(day from v_utc + interval '4 hours') = 1 or (extract(day from v_utc) = 1 and extract(hour from v_utc) < 23)) then
    return 0;
  end if;
  -- the month just ended (the UTC month 14 hours on, less one): its cohort is written again every
  -- hour of the window, so each driver's percentiles hold the month's last drives when the push
  -- lands (the daily job last wrote it at 04:30 UTC on its last day)
  perform private.refresh_monthly_stats(to_char(date_trunc('month', v_utc + interval '14 hours') - interval '1 month', 'YYYY-MM'));
  for r in
    select distinct t.user_id from public.trips t
    where t.started_at > p_now - interval '35 days' and t.scored and not t.not_driving
  loop
    v_local := p_now at time zone private.user_tz(r.user_id);
    if extract(day from v_local) <> 1 or extract(hour from v_local) <> 10 then
      continue;
    end if;
    v_month := to_char(v_local::date - 1, 'YYYY-MM');
    if not private.wrapped_eligible(r.user_id, v_month) then
      continue;
    end if;
    insert into public.inbox (user_id, kind, payload, dedupe_key)
      values (r.user_id, 'monthly_wrapped', jsonb_build_object('month', v_month), 'monthly_wrapped:' || v_month)
      on conflict (user_id, dedupe_key) do nothing;
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- claim_push_batch as 0032, with monthly_wrapped following the weekly recap switch
create or replace function public.claim_push_batch(p_limit integer, p_lease_seconds integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
        'enabled', case when c.kind in ('weekly_recap', 'monthly_wrapped') then coalesce(p.weekly_recap, true)
                        else coalesce(p.social, true) end,
        'tokens', coalesce((select jsonb_agg(d.push_token order by d.last_seen_at desc) from (
                    select d.push_token, d.last_seen_at from public.devices d
                    where d.user_id = c.user_id and d.push_token is not null order by d.last_seen_at desc limit 10) d), '[]'::jsonb)))
      order by c.push_after, c.id), '[]'::jsonb)
    into v_out
  from claimed c left join public.notification_prefs p on p.user_id = c.user_id;
  return v_out;
end $function$;

-- ---------------------------------------------------------------------------
-- the export: 0034's export_account (format 7) with the shared Wrapped and the monthly numbers;
-- format 8
-- ---------------------------------------------------------------------------
create or replace function public.export_account(p_user uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_account jsonb;
begin
  perform public.require_service_role('export_account');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  select jsonb_build_object('user_id', u.id, 'email', u.email, 'created_at', u.created_at) into v_account from auth.users u where u.id = p_user;
  if v_account is null then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;
  return jsonb_build_object(
    'format', 'roadwise-export',
    'format_version', 8,
    'exported_at', now(),
    'about', jsonb_build_object('excluded', jsonb_build_array(
      'device push tokens and push delivery receipts', 'rate-limit counters')),
    'account', v_account,
    'profile', (select to_jsonb(p) - 'flagged' from public.profiles p where p.id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'platform', d.platform, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) order by d.created_at)
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'progress', (select to_jsonb(g) from public.progress g where g.user_id = p_user),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.client_event_id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    -- passenger rides: the drive's id, its local day and which claim it was (0034)
    'passenger_rides', coalesce((select jsonb_agg(jsonb_build_object('client_trip_id', r.client_trip_id, 'local_day', r.local_day, 'kind', r.kind) order by r.local_day, r.client_trip_id)
      from private.passenger_rides r where r.user_id = p_user), '[]'::jsonb),
    -- the routes of drives past the 183 days: lines only, in random order
    'route_pool', coalesce((select jsonb_agg(r.polyline order by r.id) from public.route_pool r where r.user_id = p_user), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at) from public.user_achievements a where a.user_id = p_user), '[]'::jsonb),
    'weekly_challenges', coalesce((select jsonb_agg(to_jsonb(w) order by w.league_week, w.slot) from public.weekly_challenges w where w.user_id = p_user), '[]'::jsonb),
    -- the shared Wrapped: each link's id, month and snapshot (0038)
    'wrapped_shares', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'month', s.month, 'snapshot', s.snapshot, 'created_at', s.created_at) order by s.month)
      from public.wrapped_shares s where s.user_id = p_user), '[]'::jsonb),
    -- the numbers each month's percentiles compare (0038)
    'monthly_stats', coalesce((select jsonb_agg(to_jsonb(m) - 'user_id' order by m.month) from private.monthly_stats m where m.user_id = p_user), '[]'::jsonb),
    -- the archive's kept lines: each past month's drives, miles and archetype (0038)
    'wrapped_archive', coalesce((select jsonb_agg(to_jsonb(a) - 'user_id' order by a.month) from private.wrapped_archive a where a.user_id = p_user), '[]'::jsonb),
    'friends', jsonb_build_object(
      'count', private.friend_count(p_user),
      'outgoing_requests', (select count(*) from public.friend_requests r where r.from_id = p_user),
      'incoming_requests', (select count(*) from public.friend_requests r where r.to_id = p_user),
      'blocked_count', (select count(*) from public.blocks b where b.blocker_id = p_user)),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('target_kind', r.target_kind, 'reason', r.reason, 'note', r.note, 'created_at', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(n) from public.notification_prefs n where n.user_id = p_user),
    'inbox', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'payload', i.payload - 'from_user_id', 'created_at', i.created_at) order by i.created_at)
      from public.inbox i where i.user_id = p_user), '[]'::jsonb));
end $function$;

-- ---------------------------------------------------------------------------
-- jobs: the cohort daily at 04:30 UTC, the push hourly at :10 (the same name again replaces a job)
-- ---------------------------------------------------------------------------
select cron.schedule('monthly-stats', '30 4 * * *', 'select private.refresh_monthly_stats_daily()');
select cron.schedule('monthly-wrapped', '10 * * * *', 'select private.produce_monthly_wrapped()');

-- the cohorts of the months already driven (up to two years back), so the archive's percentiles
-- are there from the start
select private.refresh_monthly_stats(m.month)
from (select distinct to_char(t.local_day, 'YYYY-MM') as month from public.trips t
      where t.local_day >= (current_date - interval '24 months')::date) m
order by m.month;

-- ---------------------------------------------------------------------------
-- grants (new functions only; a replaced function keeps its grants)
-- ---------------------------------------------------------------------------
revoke all on function private.wrapped_month_start(text) from public, anon, authenticated;
revoke all on function private.wrapped_eligible(uuid, text) from public, anon, authenticated;
revoke all on function private.wrapped_trips(text, uuid) from public, anon, authenticated;
revoke all on function private.wrapped_month_rows(text, uuid) from public, anon, authenticated;
revoke all on function private.refresh_monthly_stats(text) from public, anon, authenticated;
revoke all on function private.refresh_monthly_stats_daily(timestamptz) from public, anon, authenticated;
revoke all on function private.wrapped_pct(int, int) from public, anon, authenticated;
revoke all on function private.wrapped_percentiles(uuid, text) from public, anon, authenticated;
revoke all on function private.wrapped_archetype(numeric, numeric, jsonb, double precision, int, double precision, double precision,
  double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function private.wrapped_stats(uuid, text) from public, anon, authenticated;
revoke all on function private.wrapped_past(uuid, text) from public, anon, authenticated;
revoke all on function private.new_share_id() from public, anon, authenticated;
revoke all on function private.wrapped_archive_put(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.produce_monthly_wrapped(timestamptz) from public, anon, authenticated;
revoke all on function public.list_my_wrapped() from public, anon, authenticated;
revoke all on function public.get_my_wrapped(text) from public, anon, authenticated;
revoke all on function public.create_wrapped_share(text) from public, anon, authenticated;
revoke all on function public.get_shared_wrapped(text) from public, anon, authenticated;
revoke all on function public.delete_wrapped_share(text) from public, anon, authenticated;
grant execute on function public.list_my_wrapped() to authenticated;
grant execute on function public.get_my_wrapped(text) to authenticated;
grant execute on function public.create_wrapped_share(text) to authenticated;
grant execute on function public.get_shared_wrapped(text) to authenticated;
grant execute on function public.delete_wrapped_share(text) to authenticated;
notify pgrst, 'reload schema';
