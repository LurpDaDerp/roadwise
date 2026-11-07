-- 0037_round15: per-drive facts for the recap, the analytics and the badges.
--
--   * public.trips.weather: the worst weather the phone saw during the drive, one of 'clear',
--     'rain', 'snow', 'ice' (the phone's features/weather/driveWeather.ts, from Open-Meteo's current
--     conditions at each check); null when the drive had no reading and on every drive stored
--     before. It is the phone's word, like the exposure counters; it scores nothing.
--   * private.apply_drive: 0032's body exactly, plus the weather read from the upload's optional
--     payload.weather (finalize-trip passes it in the envelope's payload) and stored. A missing or
--     unknown value is stored as null, never refused, so no drive is lost over it.
--   * list_my_drives is unchanged: a drive restored onto a phone comes back without its weather.
--   * export_account (0034) exports to_jsonb of each trip, so the new column is in the export as is.
--   * Three more badges, 13 in all: Clean 500, Clean 1,000 and Rain or Shine (a clean drive in
--     rain, snow or ice); the CHECK, private.check_achievements and a Clean 500 / 1,000 backfill
--     (the badges section at the end).
--
-- apply_drive and check_achievements keep their signatures: CREATE OR REPLACE keeps their ACLs. Deploy order: this migration,
-- then finalize-trip, then the app (an older server refuses the new key as unknown; the phone reads
-- that refusal as a server behind it and retries).

alter table public.trips add column if not exists weather text
  constraint trips_weather_check check (weather is null or weather in ('clear', 'rain', 'snow', 'ice'));

-- apply_drive as 0032, storing the drive's weather
create or replace function private.apply_drive(p jsonb)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_user uuid;
  pl jsonb;
  ev jsonb;
  ex jsonb;
  v_existing jsonb;
  v_trip uuid;
  v_client uuid;
  v_scored boolean;
  v_reason text;
  v_origin text;
  v_expired boolean;
  v_started timestamptz;
  v_ended timestamptz;
  v_week text;
  v_local_day date;
  v_tz text;
  v_miles numeric; v_night numeric; v_dur int; v_poly text;
  v_n int; v_sp int; v_hb int; v_ha int; v_hc int; v_nd int;
  v_exp record;
  v_slow int; v_up int; v_turn int; v_limit int; v_moving int; v_phone int;
  v_count_cap int;
  v_shift interval := interval '0';
  v_shift_ms numeric := 0;
  v_ev_ms numeric;
  v_challenges jsonb := '[]'::jsonb;
  v_achievements jsonb := '[]'::jsonb;
  v_resp jsonb;
  e jsonb;
  dc jsonb;
  v_weather text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 1048576 then
    raise exception 'apply_drive needs an object under 1 MB' using errcode = 'invalid_parameter_value';
  end if;
  v_user := (p ->> 'user')::uuid;
  pl := p -> 'payload';
  ev := coalesce(p -> 'events', '[]'::jsonb);
  if v_user is null or jsonb_typeof(pl) is distinct from 'object' or jsonb_typeof(ev) is distinct from 'array'
     or jsonb_typeof(p -> 'scored') is distinct from 'boolean' or jsonb_array_length(ev) > 1000 then
    raise exception 'apply_drive needs user, payload, events and scored' using errcode = 'invalid_parameter_value';
  end if;
  v_client := (pl ->> 'clientTripId')::uuid;
  v_scored := (p ->> 'scored')::boolean;
  v_reason := p ->> 'reason';
  v_tz := pl ->> 'tz';
  -- (finalize-trip matches this message as a time-zone refusal, TZ_REFUSAL: keep it exactly)
  if v_client is null or v_tz is null or not private.is_known_tz(v_tz)
     or (v_reason is not null and v_reason not in ('too_short', 'spoofed', 'implausible'))
     or (pl ->> 'localDay') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'payload needs clientTripId, a known tz, localDay and a valid reason' using errcode = 'invalid_parameter_value';
  end if;
  if (pl ? 'origin' and (jsonb_typeof(pl -> 'origin') is distinct from 'string' or pl ->> 'origin' not in ('auto', 'manual')))
     or (pl ? 'notDrivingExpired' and jsonb_typeof(pl -> 'notDrivingExpired') is distinct from 'boolean') then
    raise exception 'origin must be auto or manual and notDrivingExpired a boolean' using errcode = 'invalid_parameter_value';
  end if;
  v_origin := coalesce(pl ->> 'origin', 'manual');
  -- the drive's weather (0037): one of the four words, else none (absent from an older build, or a
  -- drive with no reading); a value it does not know is ignored, never refused
  v_weather := case when jsonb_typeof(pl -> 'weather') = 'string' and pl ->> 'weather' in ('clear', 'rain', 'snow', 'ice')
    then pl ->> 'weather' end;
  v_expired := coalesce((pl ->> 'notDrivingExpired')::boolean, false);
  v_started := to_timestamp((pl ->> 'startedAt')::bigint / 1000.0);
  v_ended := to_timestamp((pl ->> 'endedAt')::bigint / 1000.0);
  v_local_day := (pl ->> 'localDay')::date;
  v_miles := (pl ->> 'miles')::numeric; v_night := (pl ->> 'nightMiles')::numeric;
  v_dur := (pl ->> 'durationS')::int;
  v_poly := coalesce(pl ->> 'polyline', '');
  if v_miles is null or v_night is null or v_dur is null or v_started is null or v_ended is null
     or v_miles not between 0 and 1000 or v_night not between 0 and v_miles
     or v_dur not between 0 and 43200 or char_length(v_poly) > 16384 or v_ended <= v_started or v_ended - v_started > interval '12 hours' then
    raise exception 'payload metrics are out of range' using errcode = 'invalid_parameter_value';
  end if;
  -- the clock: a drive dated to end more than 10 minutes from now would sit outside the rating's
  -- window today and count in full later, so it is moved back, start, end and events together, to
  -- end now (its length kept, its local day and week read again). Nothing is refused, so a phone
  -- with a wrong clock never loses a drive. A drive dated in the past is taken as dated: it weighs
  -- less (or nothing, past 90 days), which is no more than the driver could get by never uploading it.
  if v_ended > now() + interval '10 minutes' then
    v_shift := v_ended - now();
    v_shift_ms := extract(epoch from v_shift) * 1000;
    v_started := v_started - v_shift;
    v_ended := now();
    v_local_day := (v_started at time zone v_tz)::date;
  end if;
  -- DashPal: the stored seconds and their flag (absent = none)
  dc := case when jsonb_typeof(p -> 'dashcam') = 'object' then p -> 'dashcam' else null end;
  if not private.dashcam_valid(p -> 'dashcam', 86400, true) or not private.dashcam_valid(pl -> 'dashcam', 43200, false) then
    raise exception 'dashcam seconds are out of range' using errcode = 'invalid_parameter_value';
  end if;
  -- the upload's own opportunity counters, estimated from its own miles and duration when it sent
  -- none, clamped as scoring clampExposure clamps them
  ex := case when jsonb_typeof(pl -> 'exposure') = 'object' then pl -> 'exposure' else null end;
  if ex is not null and (
       jsonb_typeof(ex -> 'slowdowns') is distinct from 'number' or jsonb_typeof(ex -> 'speedups') is distinct from 'number'
       or jsonb_typeof(ex -> 'turns') is distinct from 'number' or jsonb_typeof(ex -> 'limitS') is distinct from 'number'
       or jsonb_typeof(ex -> 'movingS') is distinct from 'number'
       or (ex ->> 'slowdowns')::numeric not between 0 and 1000000 or (ex ->> 'speedups')::numeric not between 0 and 1000000
       or (ex ->> 'turns')::numeric not between 0 and 1000000 or (ex ->> 'limitS')::numeric not between 0 and 1000000
       or (ex ->> 'movingS')::numeric not between 0 and 1000000
       -- phoneS: a v5 upload's seconds at driving speed; a v4 upload has none (0)
       or (ex ? 'phoneS' and (jsonb_typeof(ex -> 'phoneS') is distinct from 'number' or (ex ->> 'phoneS')::numeric not between 0 and 1000000))) then
    raise exception 'exposure counters are out of range' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_exp from private.estimate_exposure(v_miles, v_dur);
  -- the counters are the phone's word, so each is held to what the drive itself allows (clamped,
  -- never refused, so a real drive is never lost): moving time within the drive's length and limit
  -- time within moving time; a slowdown or a speed-up needs a 12 mph swing (15 s of moving or more
  -- each) and a turn 60 degrees at 10 mph or more (10 s or more each); and no count above 40 a mile.
  -- The estimate's densest knot is 3 slowdowns or speed-ups and 2 turns a mile (a 10 mph average),
  -- and stop-and-go with a stop every 100 m is about 16 a mile, so 40 a mile (one every 40 m) is far
  -- above any real drive and only cuts a count claimed to dilute the drive's event rates.
  -- The times are held to the distance too: moving time accrues only at 5 mph or more (720 s a mile
  -- at most) and limit time and phone time only at 10 mph or more (360 s a mile at most), so moving
  -- time is cut to ceil(miles x 720 x 1.25) + 60 s and limit time and phone time to
  -- ceil(miles x 360 x 1.25) + 60 s, a quarter and a minute above anything a real drive can reach,
  -- and both within moving time. The products are taken in double precision, in the phone's order
  -- (boundExposure), so both cut to the same second. A drive with no counters, and a v4 upload,
  -- has no phone time: it was not watched for phone use.
  v_moving := least(v_dur, 43200, ceil(v_miles::float8 * 720::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'movingS')::numeric)::int, v_exp.moving_s));
  v_limit := least(v_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'limitS')::numeric)::int, v_exp.limit_s));
  v_phone := least(v_moving, ceil(v_miles::float8 * 360::float8 * 1.25::float8)::int + 60,
    coalesce(floor((ex ->> 'phoneS')::numeric)::int, 0));
  v_count_cap := least(20000, ceil(v_miles * 40)::int);
  v_slow := least(v_count_cap, greatest(1, ceil(v_moving / 15.0)::int), coalesce(floor((ex ->> 'slowdowns')::numeric)::int, v_exp.slowdowns));
  v_up := least(v_count_cap, greatest(1, ceil(v_moving / 15.0)::int), coalesce(floor((ex ->> 'speedups')::numeric)::int, v_exp.speedups));
  v_turn := least(v_count_cap, greatest(1, ceil(v_moving / 10.0)::int), coalesce(floor((ex ->> 'turns')::numeric)::int, v_exp.turns));

  perform 1 from public.progress where user_id = v_user for update;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  select x.result into v_existing from public.trips x where x.user_id = v_user and x.client_trip_id = v_client;
  if found then
    return v_existing;
  end if;
  v_week := private.league_week(v_started);

  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
      dashcam_device_id, dashcam_moving_s, dashcam_covered_s, dashcam_synced, dashcam_on,
      polyline, scored, reason, origin, not_driving_expired, slowdowns, speedups, turns, limit_s, moving_s, phone_s,
      scoring_version, app_version, weather)
    values (v_user, v_client, v_started, v_ended, v_local_day, v_week, v_tz, v_miles, v_night, v_dur,
      dc ->> 'deviceId', coalesce((dc ->> 'movingS')::int, 0), coalesce((dc ->> 'coveredS')::int, 0),
      coalesce((dc ->> 'synced')::boolean, false), coalesce((dc ->> 'on')::boolean, false),
      v_poly, v_scored, v_reason, v_origin, v_expired, v_slow, v_up, v_turn, v_limit, v_moving, v_phone,
      coalesce((p ->> 'scoringVersion')::int, 8), left(pl ->> 'appVersion', 32), v_weather)
    returning id into v_trip;

  -- events: each new row is active (removal happens in dispute_event alone)
  for e in select x from jsonb_array_elements(ev) x loop
    if (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or e ->> 'type' not in ('speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy')
       or e ->> 'tier' not in ('minor', 'moderate', 'severe') or (e ->> 'startedAt')::numeric is null or (e ->> 'durationS')::numeric is null
       -- a DashPal event is severe only
       or (e ->> 'type' in ('eyes_off', 'drowsy') and e ->> 'tier' <> 'severe') then
      raise exception 'event needs id, type, tier, startedAt and durationS' using errcode = 'invalid_parameter_value';
    end if;
    -- an id the upload already sent once is kept as first stored
    if exists (select 1 from public.trip_events x where x.trip_id = v_trip and x.client_event_id = (e ->> 'id')::uuid) then
      continue;
    end if;
    -- the event, moved with its drive when the clock rule moved it
    v_ev_ms := (e ->> 'startedAt')::numeric - v_shift_ms;
    if v_ev_ms not between extract(epoch from v_started) * 1000 - 60000 and extract(epoch from v_ended) * 1000 + 60000 then
      raise exception 'event starts outside the drive' using errcode = 'invalid_parameter_value';
    end if;
    -- a phone pickup (scoring phonePickupTier: moderate up to 15 s in hand, severe beyond) is in hand
    -- a whole number of seconds, from 1 to the drive's length, and starts inside the drive (no
    -- slack: the phone checked the same before it sent it)
    if e ->> 'type' = 'phone_pickup' and (
         e ->> 'tier' not in ('moderate', 'severe')
         or (e ->> 'durationS')::numeric <> floor((e ->> 'durationS')::numeric)
         or (e ->> 'durationS')::numeric not between 1 and v_dur
         or v_ev_ms not between extract(epoch from v_started) * 1000 and extract(epoch from v_ended) * 1000) then
      raise exception 'a phone pickup needs a moderate or severe tier, whole seconds in hand within the drive and a start inside it'
        using errcode = 'invalid_parameter_value';
    end if;
    if jsonb_typeof(e -> 'measured') = 'object' and pg_column_size(e -> 'measured') > 1024 then
      raise exception 'event measured is too large' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, zone, lat, lng, measured, status)
      values (v_trip, (e ->> 'id')::uuid, v_user, e ->> 'type', e ->> 'tier', to_timestamp(v_ev_ms / 1000.0),
        least(43200, greatest(0, (e ->> 'durationS')::numeric)), case when e ->> 'zone' in ('school', 'construction') then e ->> 'zone' end,
        (e ->> 'lat')::double precision, (e ->> 'lng')::double precision,
        case when jsonb_typeof(e -> 'measured') = 'object' then e -> 'measured' else '{}'::jsonb end,
        'active')
    on conflict (trip_id, client_event_id) do nothing;
  end loop;

  -- counts from the stored rows; DashPal events are counted apart, never in n_events or `clean`
  select count(*) filter (where x.type not in ('eyes_off', 'drowsy')), count(*) filter (where x.type = 'speeding'),
         count(*) filter (where x.type = 'hard_brake'), count(*) filter (where x.type = 'hard_accel'),
         count(*) filter (where x.type = 'hard_corner'), count(*) filter (where x.type in ('eyes_off', 'drowsy'))
    into v_n, v_sp, v_hb, v_ha, v_hc, v_nd
    from public.trip_events x where x.trip_id = v_trip and x.status = 'active';
  update public.trips set n_events = v_n, n_speeding = v_sp, n_hard_brake = v_hb, n_hard_accel = v_ha,
      n_hard_corner = v_hc, n_dashcam = v_nd, clean = v_scored and v_n = 0
    where id = v_trip;

  if v_scored then
    perform private.ensure_challenges(v_user, v_week);
    v_challenges := private.sync_challenges(v_user, v_week, v_trip);
    v_achievements := private.check_achievements(v_user, v_week);
  end if;
  perform private.refresh_rating(v_user);

  v_resp := jsonb_build_object(
    'tripId', v_trip, 'clientTripId', v_client,
    -- always null: every build of the app requires the key
    'mergedInto', null,
    'scored', v_scored, 'reason', v_reason,
    'eventIds', coalesce((select jsonb_agg(x.client_event_id order by x.started_at, x.client_event_id)
                          from public.trip_events x where x.trip_id = v_trip), '[]'::jsonb),
    'rating', (select jsonb_build_object('safetyRating', g.safety_rating, 'ranked', g.ranked) from public.progress g where g.user_id = v_user),
    'challenges', v_challenges, 'achievements', v_achievements);
  update public.trips set result = v_resp where id = v_trip;
  return v_resp;
end $function$;

-- ---------------------------------------------------------------------------
-- badges: Clean 500, Clean 1,000 and Rain or Shine, 13 in all (packages/scoring ACHIEVEMENTS)
-- ---------------------------------------------------------------------------
--   * clean_500 / clean_1000: 500 / 1,000 clean miles (scored, clean, not "Wasn't driving"), the
--     same sum as clean_100, read once per check for all three.
--   * rain_or_shine: one clean drive (scored, clean, not "Wasn't driving") whose weather is 'rain',
--     'snow' or 'ice'. Drives stored before this migration have no weather, so they never count.
--   * check_achievements: 0036's body exactly, plus the three ids (in the app's order) and the clean
--     miles read once into v_clean_miles. Its signature is unchanged, so CREATE OR REPLACE keeps its
--     ACL (closed to anon and authenticated).
--   * Backfill: drivers already past 500 or 1,000 clean miles get those badges now (unlocked_at =
--     now()), instead of waiting for their next scored drive. No backfill for Rain or Shine: no
--     stored drive has a weather yet.

-- the CHECK takes the 13 ids (0036's pattern: found by definition, whatever its name)
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and rel.relname = 'user_achievements' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%first_drive%'
  loop
    execute format('alter table public.user_achievements drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.user_achievements add constraint user_achievements_achievement_id_check
  check (achievement_id in ('first_drive', 'clean_100', 'clean_500', 'clean_1000', 'perfect_week', 'rain_or_shine', 'better_speed',
    'better_braking', 'better_acceleration', 'better_turning', 'better_phone', 'better_attention', 'spot_cleared'));

create or replace function private.check_achievements(p_user uuid, p_week text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_new jsonb := '[]'::jsonb;
  v_id text;
  v_now jsonb;
  v_then jsonb;
  v_key text;
  v_hit boolean;
  -- the scoring version that last moved a detection line
  c_lines_version constant int := 11;
  v_possible boolean;   -- null until the first locked better_* badge
  v_watched boolean;
  v_clean_miles numeric;   -- null until the first locked clean_* badge
begin
  for v_id in
    select a from unnest(array['first_drive', 'clean_100', 'clean_500', 'clean_1000', 'perfect_week', 'rain_or_shine', 'better_speed',
        'better_braking', 'better_acceleration', 'better_turning', 'better_phone', 'better_attention']) with ordinality as x(a, n)
    where not exists (select 1 from public.user_achievements u where u.user_id = p_user and u.achievement_id = a)
    order by n
  loop
    if v_id like 'better\_%' then
      v_key := case v_id
        when 'better_speed' then 'speed'
        when 'better_braking' then 'braking'
        when 'better_acceleration' then 'acceleration'
        when 'better_turning' then 'turning'
        when 'better_phone' then 'phone'
        when 'better_attention' then 'attention' end;
      -- the cheap pre-check, once: the drives of both windows (rating_at's: 2160 hours back from
      -- now and from 30 days ago), every one at today's lines, and the window 30 days ago ranked
      if v_possible is null then
        select coalesce(bool_and(t.scoring_version >= c_lines_version), true)
            and coalesce(sum(greatest(t.miles, 0)) filter (where t.started_at <= now() - interval '30 days'), 0) >= 10,
          coalesce(bool_or(t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0)
            filter (where t.started_at <= now() - interval '30 days'), false)
          into v_possible, v_watched
        from public.trips t
        where t.user_id = p_user and t.scored and not t.not_driving
          and t.started_at > now() - interval '30 days' - interval '2160 hours' and t.started_at <= now();
      end if;
      if not v_possible or (v_key = 'attention' and not v_watched) then
        v_hit := false;
      else
        -- the two windows, read once, only when an improvement badge is possible
        if v_now is null then
          v_now := private.rating_at(p_user, now());
          v_then := private.rating_at(p_user, now() - interval '30 days');
        end if;
        v_hit := coalesce((v_now ->> 'ranked')::boolean, false) and coalesce((v_then ->> 'ranked')::boolean, false)
          and jsonb_typeof(v_now -> 'scores' -> v_key) = 'number' and jsonb_typeof(v_then -> 'scores' -> v_key) = 'number'
          and private.round_half_up((v_now -> 'scores' ->> v_key)::float8, 0)
            - private.round_half_up((v_then -> 'scores' ->> v_key)::float8, 0) >= 10;
      end if;
    else
      -- the clean miles, summed once for Clean 100, 500 and 1,000
      if v_id like 'clean\_%' and v_clean_miles is null then
        v_clean_miles := coalesce((select sum(t.miles) from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving), 0);
      end if;
      v_hit := case v_id
        when 'first_drive' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and not t.not_driving)
        when 'clean_100' then v_clean_miles >= 100
        when 'clean_500' then v_clean_miles >= 500
        when 'clean_1000' then v_clean_miles >= 1000
        when 'perfect_week' then coalesce((select count(*) >= 3 and bool_and(t.clean) from public.trips t
                                  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving), false)
        when 'rain_or_shine' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving
                                  and t.weather in ('rain', 'snow', 'ice'))
        else false end;
    end if;
    if v_hit then
      insert into public.user_achievements (user_id, achievement_id) values (p_user, v_id) on conflict do nothing;
      v_new := v_new || to_jsonb(v_id);
    end if;
  end loop;
  return v_new;
end $function$
;

-- the backfill: Clean 500 and Clean 1,000 for every driver already past them
insert into public.user_achievements (user_id, achievement_id, unlocked_at)
select m.user_id, b.id, now()
from (select t.user_id, sum(t.miles) as miles from public.trips t where t.scored and t.clean and not t.not_driving group by t.user_id) m
join (values ('clean_500', 500), ('clean_1000', 1000)) as b(id, need) on m.miles >= b.need
on conflict do nothing;

notify pgrst, 'reload schema';
