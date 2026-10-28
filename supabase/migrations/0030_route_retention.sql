-- 0030_route_retention: a drive's route and the places of its events are kept 183 days (about 6
-- months) after it ended. A daily job then moves the route into the driver's route pool and deletes
-- the places. The drive keeps every number it has (miles, time, night miles, counts, the clean flag,
-- the counters, scored and why not), so every all-time total, stat, achievement and goal still
-- counts it; the Safety Rating and the category scores read 90 days and a friend's heat map 90 days,
-- which the job never reaches.
--
--   * public.route_pool (id, user_id, polyline) and nothing else: no time, no trip id, no order (the
--     id is random and every read orders by it). RLS on and no grant to any API role: it is read
--     only through list_my_route_pool (the caller's own lines, for a restore on a new phone) and
--     export_account. Deleting the account deletes its lines (on delete cascade).
--   * trips.archived_at: when the job archived the drive. An archived drive's polyline is '' and its
--     events' lat and lng are null; only a kept, scored drive's route is pooled (what the phone's All
--     trips map draws: not "Wasn't driving", not unscored, not merged away), any other is dropped.
--   * private.route_retention() is the 183 days, in one place. private.archive_old_routes(p_batch)
--     archives one batch of the oldest due drives; private.archive_old_routes_daily() runs batches
--     until none is left (at most 40 of 500) and deletes the map_feedback rows past the 183 days, on
--     pg_cron at 04:10 UTC ('route-archive'). Both are idempotent: an archived drive is never picked
--     again, and a row another transaction holds waits for the next batch (skip locked).
--   * map_feedback (a wrong-limit report's place, logged with no user or trip) is written in the
--     same transaction as the report's event_disputes row, so its created_at equals that row's and
--     would tie the place back to the driver's drive: it goes at 183 days like the event's own place.
--   * list_my_drives says whether a drive is archived ('archived'), so a restore stores it as one.
--   * export_account is format 5: route_pool holds the driver's pooled lines (in random order).
--   * get_heatmap is unchanged: a friend's heat map is the last 90 days of routes.
--
-- Deploy: this migration alone (account-export passes the database's document through unchanged).
-- An app build that restores the pool answers a server without this migration as having none.

-- ---------------------------------------------------------------------------
-- the retention period
-- ---------------------------------------------------------------------------
create or replace function private.route_retention() returns interval
language sql immutable set search_path = public as $$ select interval '183 days' $$;

-- ---------------------------------------------------------------------------
-- archived drives and the route pool
-- ---------------------------------------------------------------------------
alter table public.trips add column archived_at timestamptz;
-- the job's scan: the drives not archived yet, oldest end first
create index trips_unarchived_ended_idx on public.trips (ended_at) where archived_at is null;

create table public.route_pool (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  polyline text not null check (char_length(polyline) between 1 and 65536)
);
-- list_my_route_pool's pages and export_account: one driver's lines in id order
create index route_pool_user_id_idx on public.route_pool (user_id, id);

alter table public.route_pool enable row level security;
revoke all on public.route_pool from public, anon, authenticated;
-- the server side (the secret key's service_role) is granted explicitly, as for trips
grant select, insert, update, delete on public.route_pool to service_role;

-- ---------------------------------------------------------------------------
-- the archive job
-- ---------------------------------------------------------------------------
-- archive_old_routes(p_batch): the oldest p_batch drives that ended more than 183 days ago and are
-- not archived yet. A kept, scored drive's non-empty route goes into the pool; every drive of the
-- batch then has its route emptied, its events' places deleted and archived_at stamped. Returns how
-- many drives it archived (0 when none is due).
create or replace function private.archive_old_routes(p_batch int default 500) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  if p_batch is null or p_batch not between 1 and 5000 then
    raise exception 'batch must be between 1 and 5000' using errcode = 'invalid_parameter_value';
  end if;
  v_ids := array(
    select t.id from public.trips t
    where t.archived_at is null and t.ended_at < now() - private.route_retention()
    order by t.ended_at
    limit p_batch
    for update skip locked);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  insert into public.route_pool (user_id, polyline)
    select t.user_id, t.polyline from public.trips t
    where t.id = any(v_ids) and t.scored and not t.not_driving and t.merged_into is null and t.polyline <> '';
  update public.trip_events set lat = null, lng = null
    where trip_id = any(v_ids) and (lat is not null or lng is not null);
  update public.trips set polyline = '', archived_at = now() where id = any(v_ids);
  return cardinality(v_ids);
end $$;

-- archive_old_routes_daily(): batches of 500 until one comes back short (at most 40, 20 000 drives a
-- run; a backlog carries on the next day), then the wrong-limit places past the 183 days. Returns
-- how many drives it archived.
create or replace function private.archive_old_routes_daily() returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  v_n int;
  v_total int := 0;
begin
  for i in 1..40 loop
    v_n := private.archive_old_routes(500);
    v_total := v_total + v_n;
    exit when v_n < 500;
  end loop;
  delete from public.map_feedback where created_at < now() - private.route_retention();
  return v_total;
end $$;

-- the same name again replaces the job (cron.schedule upserts by name)
select cron.schedule('route-archive', '10 4 * * *', 'select private.archive_old_routes_daily()');

-- ---------------------------------------------------------------------------
-- client reads
-- ---------------------------------------------------------------------------
-- list_my_drives(p_before, p_limit): the caller's kept drives newest first, with events and the
-- stored answer, and whether each is archived (its polyline '' and its events' places null)
create or replace function public.list_my_drives(p_before timestamptz default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'list_my_drives requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'limit must be between 1 and 50' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg((jsonb_build_object(
      'tripId', t.id, 'clientTripId', t.client_trip_id,
      'startedAt', floor(extract(epoch from t.started_at) * 1000)::bigint,
      'endedAt', floor(extract(epoch from t.ended_at) * 1000)::bigint,
      'tz', t.tz, 'localDay', t.local_day,
      'miles', t.miles, 'nightMiles', t.night_miles, 'durationS', t.duration_s,
      'polyline', t.polyline, 'dashcamOn', t.dashcam_on, 'nDashcam', t.n_dashcam,
      'dashcamMovingS', t.dashcam_moving_s, 'dashcamCoveredS', t.dashcam_covered_s,
      'scored', t.scored, 'reason', t.reason, 'notDriving', t.not_driving, 'clean', t.clean,
      'origin', t.origin, 'notDrivingExpired', t.not_driving_expired,
      'exposure', jsonb_build_object('slowdowns', t.slowdowns, 'speedups', t.speedups, 'turns', t.turns,
                                     'limitS', t.limit_s, 'movingS', t.moving_s, 'phoneS', t.phone_s),
      'result', t.result,
      'archived', t.archived_at is not null,
      'events', private.trip_events_json(t.id))
    -- LEGACY (Phase B removes): keys a build from before 0026 requires
    || jsonb_build_object('pointsNet', null, 'safeMiles', 0)) order by t.started_at desc), '[]'::jsonb)
    into v_out
  from (
    select * from public.trips t
    where t.user_id = v_uid and t.merged_into is null and (p_before is null or t.started_at < p_before)
    order by t.started_at desc
    limit p_limit
  ) t;
  return v_out;
end $$;

-- list_my_route_pool(p_after, p_limit): the caller's pooled lines, [{ id, polyline }], a page at a
-- time in id order (random, so the order says nothing about when); p_after is the last id of the
-- page before. Only ever the caller's own.
create or replace function public.list_my_route_pool(p_after uuid default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_my_route_pool requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'limit must be between 1 and 200' using errcode = 'invalid_parameter_value';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'polyline', r.polyline) order by r.id)
    from (
      select r.id, r.polyline from public.route_pool r
      where r.user_id = v_uid and (p_after is null or r.id > p_after)
      order by r.id
      limit p_limit
    ) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- the export: format 5 adds the route pool
-- ---------------------------------------------------------------------------
create or replace function public.export_account(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    'format_version', 5,
    'exported_at', now(),
    'about', jsonb_build_object('excluded', jsonb_build_array(
      'device push tokens and push delivery receipts', 'rate-limit counters', 'the merge-check end point of your latest drive')),
    'account', v_account,
    'profile', (select to_jsonb(p) - 'flagged' from public.profiles p where p.id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'platform', d.platform, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) order by d.created_at)
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'progress', (select to_jsonb(g) - 'last_end_lat' - 'last_end_lng' - 'last_end_at' from public.progress g where g.user_id = p_user),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.client_event_id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    -- the routes of drives past the 183 days: lines only, in random order
    'route_pool', coalesce((select jsonb_agg(r.polyline order by r.id) from public.route_pool r where r.user_id = p_user), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at) from public.user_achievements a where a.user_id = p_user), '[]'::jsonb),
    'weekly_challenges', coalesce((select jsonb_agg(to_jsonb(w) order by w.league_week, w.slot) from public.weekly_challenges w where w.user_id = p_user), '[]'::jsonb),
    'clan', (select jsonb_build_object('name', c.name, 'role', m.role, 'joined_at', m.joined_at)
      from public.clan_members m join public.clans c on c.id = m.clan_id where m.user_id = p_user),
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
end $$;

-- ---------------------------------------------------------------------------
-- grants (a replaced function keeps its grants)
-- ---------------------------------------------------------------------------
revoke all on function private.route_retention() from public, anon, authenticated;
revoke all on function private.archive_old_routes(int) from public, anon, authenticated;
revoke all on function private.archive_old_routes_daily() from public, anon, authenticated;
revoke all on function public.list_my_route_pool(uuid, int) from public, anon, authenticated;
grant execute on function public.list_my_route_pool(uuid, int) to authenticated;
notify pgrst, 'reload schema';
