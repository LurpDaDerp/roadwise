-- 0036_improvement_achievements: seven more achievements, ten in all (packages/scoring ACHIEVEMENTS).
--
--   * Six improvement badges, one per category: better_speed, better_braking, better_acceleration,
--     better_turning, better_phone, better_attention. One unlocks when that category's 90-day score
--     now, rounded to a whole number, is at least 10 points above the same score 30 days ago, with
--     both windows ranked (10 mi or more) and both scores known. private.rating_at reads both
--     instants under today's weights and today's accepted reports, so a scoring change never fakes
--     an improvement. Checked in private.check_achievements, which runs after every scored upload
--     and accepted report (never from "Wasn't driving"); the two rating_at reads happen only once a
--     locked better_* badge is reached.
--   * spot_cleared: spots are computed only on the phone and never uploaded, so the phone claims it
--     through public.claim_spot_cleared(), which writes that one id for the caller and nothing else
--     (no place, no spot).
--
-- check_achievements keeps its signature: CREATE OR REPLACE keeps its ACL (closed to anon and
-- authenticated). Deploy: this migration only (finalize-trip reads no achievement list).

-- the CHECK takes the ten ids (the pattern of 0023: found by definition, whatever its name)
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
  check (achievement_id in ('first_drive', 'clean_100', 'perfect_week', 'better_speed', 'better_braking', 'better_acceleration',
    'better_turning', 'better_phone', 'better_attention', 'spot_cleared'));

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
begin
  for v_id in
    select a from unnest(array['first_drive', 'clean_100', 'perfect_week', 'better_speed', 'better_braking', 'better_acceleration',
        'better_turning', 'better_phone', 'better_attention']) with ordinality as x(a, n)
    where not exists (select 1 from public.user_achievements u where u.user_id = p_user and u.achievement_id = a)
    order by n
  loop
    if v_id like 'better\_%' then
      -- the two windows, read once, only when a locked improvement badge is reached
      if v_now is null then
        v_now := private.rating_at(p_user, now());
        v_then := private.rating_at(p_user, now() - interval '30 days');
      end if;
      v_key := case v_id
        when 'better_speed' then 'speed'
        when 'better_braking' then 'braking'
        when 'better_acceleration' then 'acceleration'
        when 'better_turning' then 'turning'
        when 'better_phone' then 'phone'
        when 'better_attention' then 'attention' end;
      v_hit := coalesce((v_now ->> 'ranked')::boolean, false) and coalesce((v_then ->> 'ranked')::boolean, false)
        and jsonb_typeof(v_now -> 'scores' -> v_key) = 'number' and jsonb_typeof(v_then -> 'scores' -> v_key) = 'number'
        and private.round_half_up((v_now -> 'scores' ->> v_key)::float8, 0)
          - private.round_half_up((v_then -> 'scores' ->> v_key)::float8, 0) >= 10;
    else
      v_hit := case v_id
        when 'first_drive' then exists (select 1 from public.trips t where t.user_id = p_user and t.scored and not t.not_driving)
        when 'clean_100' then coalesce((select sum(t.miles) from public.trips t where t.user_id = p_user and t.scored and t.clean and not t.not_driving), 0) >= 100
        when 'perfect_week' then coalesce((select count(*) >= 3 and bool_and(t.clean) from public.trips t
                                  where t.user_id = p_user and t.league_week = p_week and t.scored and not t.not_driving), false)
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

-- ---------------------------------------------------------------------------
-- client RPC: the phone claims Spot Cleared (idempotent; the answer is what it newly unlocked)
-- ---------------------------------------------------------------------------
create or replace function public.claim_spot_cleared() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_new jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'claim_spot_cleared requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  insert into public.user_achievements (user_id, achievement_id) values (v_uid, 'spot_cleared') on conflict do nothing;
  if found then
    v_new := '["spot_cleared"]'::jsonb;
  end if;
  return v_new;
end $$;

revoke all on function public.claim_spot_cleared() from public, anon, authenticated;
grant execute on function public.claim_spot_cleared() to authenticated;
notify pgrst, 'reload schema';
