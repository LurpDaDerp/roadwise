-- 0018_weekly_recap_week: the weekly recap reports the week that ends on the driver's own Sunday.
--
-- The recap goes out at 18:xx on the driver's local Sunday and named the league week of that
-- instant in New York. West of New York by six hours or more (Hawaii from March to November),
-- 18:00 Sunday is already Monday in New York, so the recap reported the new, empty week: 0
-- drives, 0 points, no best drive. The week is now the ISO week of the driver's local Sunday
-- (Monday to that Sunday), which is the league week those drives were stored under.
--
-- The run's instant is a parameter (default now(), which is what the hourly job uses), so the
-- rule can be tested at a fixed moment.
drop function if exists private.produce_weekly_recaps();

create or replace function private.produce_weekly_recaps(p_now timestamptz default now()) returns int
language plpgsql volatile set search_path = public as $$
declare
  r record;
  v_n int := 0;
  v_tz text;
  v_local timestamp;
  v_week text;
  v_utc timestamp := p_now at time zone 'UTC';
begin
  -- Sunday 18:xx somewhere on Earth lies between Saturday 04:00 and Monday 08:00 UTC; outside that
  -- window nothing can be due and the fact table is not scanned
  if not ((extract(isodow from v_utc) = 6 and extract(hour from v_utc) >= 4) or extract(isodow from v_utc) = 7
          or (extract(isodow from v_utc) = 1 and extract(hour from v_utc) < 8)) then
    return 0;
  end if;
  for r in
    select distinct t.user_id from public.trips t where t.started_at > p_now - interval '7 days' and t.merged_into is null
  loop
    v_tz := private.user_tz(r.user_id);
    v_local := p_now at time zone v_tz;
    if extract(isodow from v_local) <> 7 or extract(hour from v_local) <> 18 then
      continue;
    end if;
    -- the week ending on this local Sunday ('IYYY-Www', the league week's format)
    v_week := to_char(v_local::date, 'IYYY-"W"IW');
    insert into public.inbox (user_id, kind, payload, dedupe_key)
    select r.user_id, 'weekly_recap',
      jsonb_build_object(
        'week', v_week,
        -- an unranked driver (under 25 mi in 30 days) is told nothing about a rating
        'rating', case when g.ranked then g.safety_rating end,
        'rating_delta', case when g.ranked and g.safety_rating is not null then g.safety_rating - private.rating_as_of(r.user_id, p_now - interval '7 days') end,
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
