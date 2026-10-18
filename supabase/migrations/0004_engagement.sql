-- 0004_engagement: the five achievements and the three weekly challenges.
--
-- Challenge progress is derived from the week's trips (plan §4); the only stored facts are the
-- week's three template assignments and the moment each was completed (and by which drive, so a
-- revert of that drive can undo it). Achievements are earned once.

create table public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null check (achievement_id in ('first_drive', 'clean_100', 'perfect_week', 'phone_free_25', 'streak_10')),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

create table public.challenge_templates (
  id text primary key check (id ~ '^[a-z_]{1,32}$'),
  title text not null check (char_length(title) between 1 and 64),
  description text not null check (char_length(description) between 1 and 160),
  target int not null check (target between 1 and 50),
  sort_order int not null unique
);
insert into public.challenge_templates (id, title, description, target, sort_order) values
  ('no_pickups', 'Hands off', '5 drives with 0 phone pickups', 5, 1),
  ('no_speeding', 'Easy does it', '4 drives with no speeding', 4, 2),
  ('smooth', 'Smooth operator', '4 drives with no hard braking, acceleration or cornering', 4, 3),
  ('clean', 'Clean sweep', '3 clean drives', 3, 4),
  ('positive', 'In the green', '3 drives with positive points', 3, 5);

create table public.weekly_challenges (
  user_id uuid not null references auth.users(id) on delete cascade,
  league_week text not null check (league_week ~ '^[0-9]{4}-W[0-5][0-9]$'),
  slot int not null check (slot between 1 and 3),
  template_id text not null references public.challenge_templates(id),
  completed_at timestamptz,
  completed_by_trip uuid references public.trips(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, league_week, slot),
  constraint weekly_challenges_user_week_template unique (user_id, league_week, template_id)
);
create index weekly_challenges_completed_by_idx on public.weekly_challenges (completed_by_trip) where completed_by_trip is not null;

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
-- how many of the week's kept scored drives satisfy a template
create or replace function private.challenge_count(p_user uuid, p_week text, p_template text) returns int
language sql stable set search_path = public as $$
  select count(*)::int from public.trips t
  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null
    and case p_template
          when 'no_pickups' then t.n_pickup = 0
          when 'no_speeding' then t.n_speeding = 0
          when 'smooth' then t.n_hard_brake + t.n_hard_accel + t.n_hard_corner = 0
          when 'clean' then t.clean
          when 'positive' then t.points_net > 0
          else false end
$$;

-- assign the week's three slots once: slot 1 targets the weakest stat of the last 30 days
-- (distance from the green threshold, normalised by the red bound), slots 2-3 the next two;
-- a user with no scored drive in 30 days gets no_pickups, no_speeding, clean
create or replace function private.ensure_challenges(p_user uuid, p_week text) returns void
language plpgsql volatile set search_path = public as $$
declare
  s jsonb;
  v_miles numeric;
  v_drives int;
begin
  -- a week that has ended gets no challenges (a late upload still scores, but counts for nothing weekly)
  if private.week_key_end(p_week) <= now() then
    return;
  end if;
  if exists (select 1 from public.weekly_challenges w where w.user_id = p_user and w.league_week = p_week) then
    return;
  end if;
  s := private.stat_sums(p_user, now() - interval '30 days');
  v_miles := (s ->> 'miles')::numeric;
  v_drives := (s ->> 'drives')::int;
  if v_drives = 0 or v_miles <= 0 then
    insert into public.weekly_challenges (user_id, league_week, slot, template_id) values
      (p_user, p_week, 1, 'no_pickups'), (p_user, p_week, 2, 'no_speeding'), (p_user, p_week, 3, 'clean')
    on conflict do nothing;
    return;
  end if;
  insert into public.weekly_challenges (user_id, league_week, slot, template_id)
  select p_user, p_week, row_number() over (order by r.weakness desc, r.sort_order), r.id
  from (
    select c.id, c.sort_order,
      case c.id
        when 'no_pickups' then (s ->> 'pickups')::numeric / v_miles * 100 / 1.0
        when 'no_speeding' then (s ->> 'speeding')::numeric / v_miles * 100 / 4.0
        when 'smooth' then ((s ->> 'hardBrake')::numeric + (s ->> 'hardAccel')::numeric + (s ->> 'hardCorner')::numeric) / v_miles * 100 / 12.0
        when 'clean' then greatest(0, 80 - (s ->> 'cleanDrives')::numeric / v_drives * 100) / 30.0
        when 'positive' then (select count(*) filter (where t.points_net <= 0)::numeric / greatest(count(*), 1) / 0.5
                              from public.trips t where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
                                and t.started_at > now() - interval '30 days')
        else 0 end as weakness
    from public.challenge_templates c
  ) r
  order by r.weakness desc, r.sort_order
  limit 3
  on conflict do nothing;
end $$;

-- the week's challenges with derived progress: [{ id, slot, title, description, target, progress, completed }]
create or replace function private.challenges_json(p_user uuid, p_week text) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.template_id, 'slot', w.slot, 'title', c.title, 'description', c.description, 'target', c.target,
      'progress', least(c.target, private.challenge_count(p_user, p_week, w.template_id)),
      'completed', w.completed_at is not null) order by w.slot), '[]'::jsonb)
  from public.weekly_challenges w join public.challenge_templates c on c.id = w.template_id
  where w.user_id = p_user and w.league_week = p_week
$$;

-- after a drive is applied: complete what the week's trips now satisfy. +100 points (lifetime too),
-- the ledger row `challenge:<week>:<slot>`, freeze progress +1 (3 -> a freeze, capped at 3).
-- Returns the newly completed [{ id, title }].
create or replace function private.complete_challenges(p_user uuid, p_week text, p_trip uuid) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_done jsonb := '[]'::jsonb;
  v_fp int;
begin
  if private.week_key_end(p_week) <= now() then
    return v_done;
  end if;
  for r in
    select w.slot, w.template_id, c.title, c.target
    from public.weekly_challenges w join public.challenge_templates c on c.id = w.template_id
    where w.user_id = p_user and w.league_week = p_week and w.completed_at is null
    order by w.slot
  loop
    if private.challenge_count(p_user, p_week, r.template_id) >= r.target then
      update public.weekly_challenges set completed_at = now(), completed_by_trip = p_trip
        where user_id = p_user and league_week = p_week and slot = r.slot;
      insert into public.points_ledger (user_id, key, amount, kind, trip_id, league_week)
        values (p_user, 'challenge:' || p_week || ':' || r.slot, 100, 'challenge', p_trip, p_week)
        on conflict (user_id, key) do nothing;
      select freeze_progress into v_fp from public.progress where user_id = p_user for update;
      update public.progress set
        points = points + 100,
        lifetime = lifetime + 100,
        level = private.level_for(lifetime + 100),
        freeze_progress = case when v_fp + 1 >= 3 then 0 else v_fp + 1 end,
        freezes = case when v_fp + 1 >= 3 then least(3, freezes + 1) else freezes end
      where user_id = p_user;
      v_done := v_done || jsonb_build_object('id', r.template_id, 'title', r.title);
    end if;
  end loop;
  return v_done;
end $$;

-- a reverted drive takes back the challenges it completed: the ledger row goes (so the week's
-- points and a later re-completion stay consistent); the progress columns are restored from the
-- drive's snapshot by the caller
create or replace function private.revert_challenges_of_trip(p_user uuid, p_trip uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  r record;
begin
  for r in
    select w.slot, w.league_week from public.weekly_challenges w
    where w.user_id = p_user and w.completed_by_trip = p_trip
  loop
    delete from public.points_ledger where user_id = p_user and key = 'challenge:' || r.league_week || ':' || r.slot;
    update public.weekly_challenges set completed_at = null, completed_by_trip = null
      where user_id = p_user and league_week = r.league_week and slot = r.slot;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- achievements: checked after each apply; returns the newly unlocked ids
-- ---------------------------------------------------------------------------
create or replace function private.check_achievements(p_user uuid, p_week text) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_new jsonb := '[]'::jsonb;
  v_streak int;
  v_pfr int;
  v_id text;
begin
  select streak, phone_free_run into v_streak, v_pfr from public.progress where user_id = p_user;
  for v_id in
    select a from unnest(array['first_drive', 'clean_100', 'perfect_week', 'phone_free_25', 'streak_10']) with ordinality as x(a, n)
    where not exists (select 1 from public.user_achievements u where u.user_id = p_user and u.achievement_id = a)
    order by n
  loop
    if (case v_id
         when 'first_drive' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null)
         when 'clean_100' then coalesce((select sum(t.miles) from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving and t.merged_into is null), 0) >= 100
         when 'perfect_week' then (select count(*) >= 3 and bool_and(t.clean) from public.trips t
                                   where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving and t.merged_into is null)
         when 'phone_free_25' then v_pfr >= 25
         when 'streak_10' then v_streak >= 10
         else false end)
    then
      insert into public.user_achievements (user_id, achievement_id) values (p_user, v_id) on conflict do nothing;
      v_new := v_new || to_jsonb(v_id);
    end if;
  end loop;
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- RLS and grants: the owner reads their achievements; everything else via RPC
-- ---------------------------------------------------------------------------
alter table public.user_achievements enable row level security;
alter table public.challenge_templates enable row level security;
alter table public.weekly_challenges enable row level security;

create policy user_achievements_select_own on public.user_achievements for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.user_achievements, public.challenge_templates, public.weekly_challenges from anon, authenticated;
-- the server side (the secret key's service_role) is granted explicitly: Supabase no longer does it by default
grant select, insert, update, delete on public.user_achievements, public.challenge_templates, public.weekly_challenges to service_role;
grant select on public.user_achievements to authenticated;
