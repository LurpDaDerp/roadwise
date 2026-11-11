-- 0043_weather_lines: a hard event judged at a weather-tightened line weighs against that line
-- (scoring version 13).
--
--   * private.hard_event_weight: (peakG / the line the event was judged at)^2 between 1 and 4. The
--     line is the event's measured lineG held between its type's snow line (packages/scoring
--     HARD_LINE_FLOOR_G: 0.29 g brake, 0.32 g start, 0.38 g turn) and its dry line
--     (HARD_EVENT_MIN_G: 0.36 g, 0.40 g, 0.48 g); without a numeric lineG it is the dry line, so an
--     event a phone judged on a dry road, and every event stored before, weighs exactly what 0040
--     gave it. Without a measured peak, the tier's 1 (minor) or 2 (severe), as before. finalize-trip
--     stores lineG already held to that band.
--   * New drives are scored on the phone and by finalize-trip at version 13 (SCORING_VERSION); the
--     column default stays. private.check_achievements keeps version 12 as the one that last moved a
--     detection line: a weather line only lowers a score in bad weather, so it cannot fake an
--     improvement.
--
-- Same signature: CREATE OR REPLACE keeps its ACL (closed to anon and authenticated), and
-- private.rating_at, private.event_weight_of and Wrapped read it unchanged.
-- Deploy: this migration, then finalize-trip redeployed (its shared scoring and upload contract carry
-- lineG and lineMph).
create or replace function private.hard_event_weight(p_type text, p_tier text, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_measured -> 'peakG') = 'number' then
      (select least(4::float8, greatest(1::float8, r.r * r.r))
         from (select (p_measured ->> 'peakG')::float8
                 / (case when jsonb_typeof(p_measured -> 'lineG') = 'number'
                      then least(l.dry_g, greatest(l.floor_g, (p_measured ->> 'lineG')::float8))
                      else l.dry_g end) as r
                 from (select (case p_type when 'hard_brake' then 0.36::float8 when 'hard_accel' then 0.40::float8 else 0.48::float8 end) as dry_g,
                              (case p_type when 'hard_brake' then 0.29::float8 when 'hard_accel' then 0.32::float8 else 0.38::float8 end) as floor_g) l) r)
    else (case when p_tier = 'severe' then 2 else 1 end)::float8 end
$$;
