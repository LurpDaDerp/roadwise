-- 0011_drop_license_stage: RoadWise does not ask for or keep the driver's license stage. The
-- column goes from profiles (and with it the owner's column grant), complete_onboarding takes only
-- the terms version, update_profile loses its license argument, and get_my_summary's profile no
-- longer names it.

drop function public.complete_onboarding(text, text);
drop function public.update_profile(text, text, text, text);

-- complete_onboarding(p_terms_version): needs a username and the consent
create or replace function public.complete_onboarding(p_terms_version text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_username extensions.citext;
begin
  if v_uid is null then
    raise exception 'complete_onboarding requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform public.accept_terms(p_terms_version);
  select username into v_username from public.profiles where id = v_uid for update;
  if v_username is null then
    raise exception 'pick a username first' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set onboarded_at = coalesce(onboarded_at, now()) where id = v_uid;
end $$;

-- update_profile: each argument null = unchanged
create or replace function public.update_profile(p_units text default null, p_state text default null, p_heatmap_visibility text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'update_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_units is not null and p_units not in ('mi', 'km') then
    raise exception 'units must be mi or km' using errcode = 'invalid_parameter_value';
  end if;
  if p_state is not null and p_state <> '' and p_state !~ '^[A-Z]{2}$' then
    raise exception 'state must be a two-letter US state code' using errcode = 'invalid_parameter_value';
  end if;
  if p_heatmap_visibility is not null and p_heatmap_visibility not in ('only_me', 'clan', 'friends') then
    raise exception 'heatmap_visibility must be only_me, clan or friends' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles set
    units = coalesce(p_units, units),
    state = case when p_state is null then state when p_state = '' then null else p_state end,
    heatmap_visibility = coalesce(p_heatmap_visibility, heatmap_visibility)
  where id = v_uid;
  if not found then
    raise exception 'no profile for user' using errcode = 'no_data_found';
  end if;
end $$;

revoke all on function public.complete_onboarding(text) from public, anon, authenticated;
revoke all on function public.update_profile(text, text, text) from public, anon, authenticated;
grant execute on function public.complete_onboarding(text) to authenticated;
grant execute on function public.update_profile(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- get_my_summary: the Home header in one call (also applies the lazy freeze grant and this
-- week's challenge assignment)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_summary() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_week text := private.league_week(now());
  v_group uuid;
  g public.progress%rowtype;
begin
  if v_uid is null then
    raise exception 'get_my_summary requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  -- a read on every Home focus: lock and write only when a freeze grant or this week's challenge
  -- assignment is actually due (both are rare), so a concurrent finalize is never held up
  select * into g from public.progress where user_id = v_uid;
  if not found then
    raise exception 'no progress for user' using errcode = 'no_data_found';
  end if;
  if g.freezes_granted_at <= now() - interval '30 days' then
    perform 1 from public.progress where user_id = v_uid for update;
    perform private.apply_freeze_grant(v_uid);
    select * into g from public.progress where user_id = v_uid;
  end if;
  if not exists (select 1 from public.weekly_challenges w where w.user_id = v_uid and w.league_week = v_week) then
    perform private.ensure_challenges(v_uid, v_week);
  end if;
  select m.group_id into v_group from public.league_members m where m.week = v_week and m.user_id = v_uid;
  return jsonb_build_object(
    'profile', (select jsonb_build_object('user_id', p.id, 'username', p.username, 'units', p.units,
        'state', p.state, 'heatmap_visibility', p.heatmap_visibility, 'league_eligible', p.league_eligible,
        'onboarded_at', p.onboarded_at) from public.profiles p where p.id = v_uid),
    'progress', jsonb_build_object('points', g.points, 'lifetime', g.lifetime, 'level', g.level,
        'level_floor', private.level_floor(g.level), 'level_next', case when g.level >= 50 then null else private.level_floor(g.level + 1) end,
        'streak', g.streak, 'at_risk', g.at_risk, 'next_mult', least(1.30, 1 + 0.02 * g.streak),
        'freezes', g.freezes, 'clean_run', g.clean_run, 'freeze_progress', g.freeze_progress, 'phone_free_run', g.phone_free_run,
        'safety_rating', g.safety_rating, 'ranked', g.ranked, 'miles_30d', g.miles_30d, 'clean_miles_30d', g.clean_miles_30d,
        'rating_trend', case when g.safety_rating is null then null else g.safety_rating - private.rating_as_of(v_uid, now() - interval '7 days') end,
        'league_tier', g.league_tier),
    'league', jsonb_build_object('week', v_week, 'tier', g.league_tier, 'group_id', v_group,
        'rank', case when v_group is null then null else 1 + (select count(*) from public.league_members m where m.group_id = v_group and m.user_id <> v_uid
                  and private.week_points(m.user_id, v_week) > private.week_points(v_uid, v_week)) end,
        'size', coalesce((select l.member_count from public.league_groups l where l.id = v_group), 0),
        'ends_at', private.week_end(now())),
    'not_driving_left', private.not_driving_left(v_uid),
    'challenges', private.challenges_json(v_uid, v_week),
    'achievements', coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_uid), '[]'::jsonb));
end $$;

alter table public.profiles drop column license_stage;
