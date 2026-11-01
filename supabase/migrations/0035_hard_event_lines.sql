-- 0035_hard_event_lines: the hard-event lines are looser (scoring version 11).
--
--   * private.hard_event_weight: (peakG / the type's threshold)^2 between 1 and 4, with the
--     thresholds packages/scoring holds (HARD_EVENT_MIN_G): 0.36 g brake, 0.45 g start, 0.55 g
--     turn. Without a measured peak, the tier's 1 (minor) or 2 (severe), as before. Every stored
--     event is weighed by it as the rating is read, so the rating and the scores move with it.
--   * New drives are scored on the phone and by finalize-trip at version 11 (SCORING_VERSION); the
--     column default stays.
--
-- Same signature: CREATE OR REPLACE keeps its ACL (closed to anon and authenticated).
-- Deploy: this migration, and finalize-trip redeployed (its shared scoring carries the new lines).
create or replace function private.hard_event_weight(p_type text, p_tier text, p_measured jsonb) returns double precision
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_measured -> 'peakG') = 'number' then
      (select least(4::float8, greatest(1::float8, r.r * r.r))
         from (select (p_measured ->> 'peakG')::float8
                 / (case p_type when 'hard_brake' then 0.36::float8 when 'hard_accel' then 0.45::float8 else 0.55::float8 end) as r) r)
    else (case when p_tier = 'severe' then 2 else 1 end)::float8 end
$$;
