-- 0039_final_audit: four server fixes from the pre-release audit. Nothing a driver sees changes.
--
--   * route-archive runs every 5 minutes from 03:00 to 05:55 UTC instead of 6 times a night. Each run
--     is still one batch of at most 1 000 due drives in its own transaction
--     (private.archive_old_routes_run(), unchanged), so the job can archive up to 36 000 drives a day
--     and a backlog drains within the night, keeping the 183 days. It stays a nightly window, so a
--     driver's route pool is still rewritten about once a day (not once per drive) and storage still
--     dates a line only to the day. A run with nothing due costs one probe of
--     trips_unarchived_ended_idx (and the small wrong-limit places delete).
--   * private.refresh_ratings_daily() computes every due driver's rating first, locking nothing, then
--     writes them all in one UPDATE, so a driver's progress row is locked only for that statement
--     (not for the whole run) and an upload, report or "Wasn't driving" mark no longer waits for the
--     job. The numbers are the ones private.refresh_rating writes (the same rating_at as of the run's
--     now(), the same week-ago rating); a row whose rating was refreshed by a drive, report or mark
--     while the job was computing keeps that fresher value (its rating_updated_at moved, so the
--     UPDATE skips it). The schedule and the return value (the drivers refreshed) are unchanged.
--   * private.produce_weekly_recaps skips the hours when Sunday 18:xx is nowhere on Earth: zones run
--     from UTC+14 to UTC-12, so that hour lies between Sunday 04:00 and Monday 07:00 UTC (the guard
--     wrongly started on Saturday). The same drivers get the same recap at the same hour.
--   * public.list_my_wrapped reuses an archive line only when it was computed after the month's last
--     drive change too (max(trips.updated_at), which trips_touch moves on every update): an accepted
--     report recounts its drive and flips its clean flag without changing the drives or miles, and
--     the line then showed the archetype from before the report.
--
-- Deploy: this migration alone.

-- ---------------------------------------------------------------------------
-- route retention: the archive job's schedule
-- ---------------------------------------------------------------------------
-- the same name again replaces the job (cron.schedule upserts by name)
select cron.schedule('route-archive', '*/5 3-5 * * *', 'select private.archive_old_routes_run()');

-- ---------------------------------------------------------------------------
-- the daily rating refresh: compute unlocked, then one short UPDATE
-- ---------------------------------------------------------------------------
-- cron: ages change daily, so every driver with a rating (or miles in the window) is refreshed. The
-- columns and values are private.refresh_rating's (keep the two in step).
create or replace function private.refresh_ratings_daily() returns int
language plpgsql volatile set search_path = public as $$
declare
  v_users uuid[];
  v_seen timestamptz[];
  v_r jsonb[];
  v_week_ago numeric[];
  v_n int;
begin
  -- every due driver's rating as of now() and 7 days before, read without a row lock (offset 0 keeps
  -- rating_at to one call per driver)
  select array_agg(s.user_id), array_agg(s.rating_updated_at), array_agg(s.r),
         array_agg(case when s.r ->> 'rating' is null then null else private.rating_as_of(s.user_id, now() - interval '7 days') end)
    into v_users, v_seen, v_r, v_week_ago
    from (select g.user_id, g.rating_updated_at, private.rating_at(g.user_id, now()) as r
          from public.progress g
          where (g.miles_90d > 0 or g.safety_rating is not null)
            and (g.rating_updated_at is null or g.rating_updated_at < now() - interval '20 hours')
          offset 0) s;
  if v_users is null then
    return 0;
  end if;
  -- one statement, so each row is locked only until the run commits right after it; a row refreshed
  -- meanwhile (its rating_updated_at moved) keeps the fresher value
  update public.progress g set
    miles_90d = least((u.r ->> 'miles')::numeric, 999999),
    safety_rating = (u.r ->> 'rating')::numeric,
    ranked = (u.r ->> 'ranked')::boolean,
    rating_week_ago = u.week_ago,
    rating_updated_at = now()
  from unnest(v_users, v_seen, v_r, v_week_ago) as u(user_id, seen, r, week_ago)
  where g.user_id = u.user_id and g.rating_updated_at is not distinct from u.seen;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- the weekly recap: the hours it can be due
-- ---------------------------------------------------------------------------
create or replace function private.produce_weekly_recaps(p_now timestamp with time zone default now())
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  r record;
  v_n int := 0;
  v_tz text;
  v_local timestamp;
  v_week text;
  v_utc timestamp := p_now at time zone 'UTC';
begin
  -- Sunday 18:xx somewhere on Earth (UTC+14 .. UTC-12) lies between Sunday 04:00 and Monday 07:00
  -- UTC (Monday before 08:00 kept as a margin); outside that window nothing can be due and the fact
  -- table is not scanned
  if not ((extract(isodow from v_utc) = 7 and extract(hour from v_utc) >= 4)
          or (extract(isodow from v_utc) = 1 and extract(hour from v_utc) < 8)) then
    return 0;
  end if;
  for r in
    select distinct t.user_id from public.trips t where t.started_at > p_now - interval '7 days'
  loop
    v_tz := private.user_tz(r.user_id);
    v_local := p_now at time zone v_tz;
    if extract(isodow from v_local) <> 7 or extract(hour from v_local) <> 18 then
      continue;
    end if;
    -- the week ending on this local Sunday ('IYYY-Www', the league week's format)
    v_week := to_char(v_local::date, 'IYYY-"W"IW');
    if private.week_drives(r.user_id, v_week) = 0 then
      continue;
    end if;
    insert into public.inbox (user_id, kind, payload, dedupe_key)
    select r.user_id, 'weekly_recap',
      jsonb_build_object(
        'week', v_week,
        -- a driver not ranked yet (under 10 mi in 90 days) is told nothing about a rating
        'rating', case when g.ranked then g.safety_rating end,
        'rating_delta', case when g.ranked and g.safety_rating is not null then g.safety_rating - private.rating_as_of(r.user_id, p_now - interval '7 days') end,
        'drives', private.week_drives(r.user_id, v_week),
        'goals_done', (select count(*)::int from public.weekly_challenges w
                       where w.user_id = r.user_id and w.league_week = v_week and w.completed_at is not null)),
      'weekly_recap:' || v_week
    from public.progress g where g.user_id = r.user_id
    on conflict (user_id, dedupe_key) do nothing;
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$
;

-- ---------------------------------------------------------------------------
-- the Wrapped archive: a line is current only while no drive of the month changed after it
-- ---------------------------------------------------------------------------
-- list_my_wrapped() -> [{ month, drives, miles, archetype: { style, pattern } }]: the caller's
-- eligible past months, newest first, at most 24; each line from private.wrapped_archive while it
-- still matches the month's drives and miles and was computed after the month's last drive change,
-- else computed and kept
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
    select to_char(t.local_day, 'YYYY-MM') as m, count(*)::int as drives, round(sum(t.miles), 1) as miles,
           max(t.updated_at) as changed from public.trips t
    where t.user_id = v_uid and t.scored and not t.not_driving and t.local_day < v_cur
    group by 1 having count(*) >= 3
    order by 1 desc
    limit 24
  loop
    select c.archetype into v_arch from private.wrapped_archive c
      where c.user_id = v_uid and c.month = r.m and c.drives = r.drives and c.miles = r.miles and c.computed_at >= r.changed;
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

-- a replaced function keeps its owner and grants
notify pgrst, 'reload schema';
