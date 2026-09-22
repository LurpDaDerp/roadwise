-- 0003_wire_v3: upload contract v3 on the server side.
--
--   * `role_unknown` joins the unscored reasons. An auto-detected drive whose evidence cannot say
--     who was driving uploads as role 'unknown' (the role CHECK has allowed it since 0002) and the
--     scorer leaves it unscored with this reason until the driver answers (spec §9.7). The CHECK is
--     exactly the scorer's five reasons (`ScoredTrip['reason']`, packages/scoring/src/types.ts).
--   * apply_recompute pins the scoring version (M2 final review M-5; the scoring explainer promises
--     "already-scored trips stay exactly as they were"). A re-score never writes
--     `trips.scoring_version`: the version a trip was first scored under is the version it keeps.
--     trip-actions dispatches the re-score on the stored version and refuses (409) when it has no
--     scorer for it; this writer is the backstop, refusing a result produced under any other
--     version with 22023 `scoring_version_mismatch` before anything is written. The check runs
--     after the service-role guard and the ownership lookup, so it tells a caller nothing about a
--     trip that is not theirs. A result that names no version is applied under the stored one
--     (nothing is overwritten either way); the day-refresh call (p_scored null) re-scores nothing
--     and is not asked for one.
--
-- 0002 is not edited: server migrations are append-only from M3 on. The function below is 0002's
-- apply_recompute with exactly two changes (the version check, and `scoring_version` dropped from
-- the trip update); `create or replace` keeps its owner, its grants and its definer flag, which the
-- test file re-asserts.

-- ---------------------------------------------------------------------------
-- trips.unscored_reason: the scorer's five reasons
-- ---------------------------------------------------------------------------
alter table public.trips drop constraint trips_unscored_reason_check;
alter table public.trips add constraint trips_unscored_reason_check
  check (unscored_reason in ('passenger', 'role_unknown', 'too_short', 'grade_c', 'implausible_speed'));

-- ---------------------------------------------------------------------------
-- apply_recompute: 0002's writer, version-pinned
-- ---------------------------------------------------------------------------
create or replace function public.apply_recompute(p_user uuid, p_trip_id uuid, p_scored jsonb, p_events jsonb, p_day jsonb, p_baselines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trip public.trips%rowtype;
  v_rescore boolean;
  v_status text;
  v_score int;
  v_scored_now boolean;
  e jsonb;
  v_ev_id uuid;
  v_ev_status text;
begin
  perform public.require_service_role('apply_recompute');
  if p_user is null then
    raise exception 'apply_recompute requires a user' using errcode = 'invalid_parameter_value';
  end if;
  if p_trip_id is null then
    raise exception 'apply_recompute requires a trip' using errcode = 'invalid_parameter_value';
  end if;

  v_rescore := p_scored is not null and jsonb_typeof(p_scored) <> 'null';
  if not v_rescore then
    if p_events is not null and jsonb_typeof(p_events) <> 'null' then
      raise exception 'apply_recompute events require scored' using errcode = 'invalid_parameter_value';
    end if;
  else
    select status, score into v_status, v_score from public.require_scored_trip('apply_recompute', p_scored);
    v_scored_now := v_status in ('provisional', 'final');
    if p_events is not null and jsonb_typeof(p_events) not in ('null', 'array') then
      raise exception 'apply_recompute events must be a JSON array' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  perform public.require_score_days('apply_recompute', p_day);
  perform public.require_baselines('apply_recompute', p_baselines);

  -- ownership: a trip that is not the user's reads exactly like one that does not exist
  select * into v_trip from public.trips where id = p_trip_id and user_id = p_user for update;
  if not found then
    raise exception 'trip not owned by user' using errcode = 'insufficient_privilege';
  end if;
  if v_rescore and v_trip.deleted_at is not null then
    raise exception 'trip already deleted' using errcode = 'insufficient_privilege';
  end if;
  -- the version pin: a result scored under any version but the stored one is refused, before a
  -- single row is written. Compared as JSON, so a string "1" or a null is a mismatch, not a cast
  -- error; an absent key is the one case let through, and it cannot change the version either.
  if v_rescore and p_scored ? 'scoringVersion'
     and (p_scored->'scoringVersion') is distinct from to_jsonb(v_trip.scoring_version) then
    raise exception 'scoring_version_mismatch' using errcode = 'invalid_parameter_value';
  end if;

  if v_rescore then
    for e in select * from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) loop
      perform public.require_keys('apply_recompute', e, 'events[].', array['id', 'status', 'deduction']);
      v_ev_status := e->>'status';
      if v_ev_status is null or v_ev_status not in ('scored', 'possible', 'disputed', 'removed') then
        raise exception 'apply_recompute event status is not an event status' using errcode = 'invalid_parameter_value';
      end if;
      begin
        v_ev_id := (e->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'apply_recompute event id is not a uuid' using errcode = 'invalid_parameter_value';
      end;
      update public.trip_events
        set status = v_ev_status,
            deduction = case when v_scored_now then coalesce((e->>'deduction')::numeric, 0) end
        where id = v_ev_id and trip_id = p_trip_id;
      if not found then
        raise exception 'apply_recompute event does not belong to the trip' using errcode = 'invalid_parameter_value';
      end if;
    end loop;

    -- scoring_version is deliberately absent: a re-score keeps the version the trip was scored under
    update public.trips
      set score = v_score,
          status = v_status,
          category_deductions = p_scored->'categoryDeductions',
          exposure = coalesce((p_scored->>'exposure')::numeric, exposure),
          data_quality = coalesce(p_scored->>'dataQuality', data_quality),
          unscored_reason = p_scored->>'reason',
          had_severe_event = coalesce((p_scored->>'hadSevereEvent')::boolean, had_severe_event)
      where id = p_trip_id;
    if not v_scored_now then
      update public.trip_events set deduction = null where trip_id = p_trip_id and deduction is not null;
    end if;
  else
    v_score := v_trip.score;
    v_status := v_trip.status;
  end if;

  perform public.upsert_score_day(p_user, p_day);
  perform public.upsert_baselines(p_user, p_baselines);

  return jsonb_build_object('trip_id', p_trip_id, 'score', v_score, 'status', v_status);
end $$;

-- `create or replace` keeps these; restated so this migration alone says who may call the writer
alter function public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb) owner to postgres;
revoke all on function public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_recompute(uuid, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
