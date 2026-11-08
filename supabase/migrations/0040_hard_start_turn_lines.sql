-- 0040_hard_start_turn_lines: hard starts and sharp turns count from the lines insurers, fleet
-- telematics and driving research use for passenger cars (scoring version 12).
--
--   * private.hard_event_weight: (peakG / the type's threshold)^2 between 1 and 4, with the
--     thresholds packages/scoring holds (HARD_EVENT_MIN_G): 0.36 g brake, 0.40 g start, 0.48 g
--     turn. Without a measured peak, the tier's 1 (minor) or 2 (severe), as before. Every stored
--     event is weighed by it as the rating is read, so the rating and the scores move with it.
--   * New drives are scored on the phone and by finalize-trip at version 12 (SCORING_VERSION); the
--     column default stays.
--   * private.check_achievements: version 12 is now the one that last moved a detection line, so an
--     improvement badge needs every drive in both windows detected at version 12 or later (0037's
--     body otherwise unchanged).
--
-- Same signatures: CREATE OR REPLACE keeps their ACLs (closed to anon and authenticated).
-- Deploy: this migration, and finalize-trip redeployed (its shared scoring carries the new lines).
create or replace function private.hard_event_weight(p_type text, p_tier text, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_measured -> 'peakG') = 'number' then
      (select least(4::float8, greatest(1::float8, r.r * r.r))
         from (select (p_measured ->> 'peakG')::float8
                 / (case p_type when 'hard_brake' then 0.36::float8 when 'hard_accel' then 0.40::float8 else 0.48::float8 end) as r) r)
    else (case when p_tier = 'severe' then 2 else 1 end)::float8 end
$$;

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
  c_lines_version constant int := 12;
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
end $function$;
