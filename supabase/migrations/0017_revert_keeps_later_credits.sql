-- 0017_revert_keeps_later_credits: undoing a drive takes back only that drive's own points.
--
-- revert_trip (a merge into the latest drive, and "Wasn't driving") used to restore the whole
-- progress row from the drive's snapshot, so any points credited after the drive was applied were
-- lost with it: an accepted report on an older drive, made in the minutes before a restart that
-- merged into the latest one, vanished from points and lifetime while its drive_adjust row stayed
-- in the ledger. Now:
--
--   * points go down by exactly what the drive put in: its ledger rows (the drive, its report
--     adjustments, earlier reverts of it) and the challenge rewards it completed; the revert row
--     and the deleted challenge rows move the ledger by the same amount, so the two always agree;
--   * lifetime goes down by the drive's positive net as now stored (what the apply and any
--     accepted report on it added) plus those challenge rewards; the level follows lifetime;
--   * the rest of the row (streak, at risk, freezes and their grant date, clean run, freeze
--     progress, phone-free run, the last drive's end) is restored from the snapshot as before:
--     only the latest drive is ever reverted, and nothing but a drive changes those after it (a
--     freeze grant restored away is granted again lazily, as before).
create or replace function private.revert_trip(p_user uuid, p_trip uuid) returns void
language plpgsql volatile set search_path = public as $$
declare
  v_snap jsonb;
  v_rev int;
  v_net int;
  v_sum int;
  v_challenges int;
  v_points int;
  v_lifetime int;
begin
  select t.progress_before, t.rev, t.points_net into v_snap, v_rev, v_net from public.trips t where t.id = p_trip and t.user_id = p_user for update;
  if not found then
    raise exception 'trip not found' using errcode = 'no_data_found';
  end if;
  -- what this drive put into points: its own ledger rows, and the challenge rewards it completed
  select coalesce(sum(l.amount) filter (where l.kind <> 'challenge'), 0), coalesce(sum(l.amount) filter (where l.kind = 'challenge'), 0)
    into v_sum, v_challenges
    from public.points_ledger l where l.user_id = p_user and l.trip_id = p_trip;
  select g.points, g.lifetime into v_points, v_lifetime from public.progress g where g.user_id = p_user for update;
  perform private.restore_progress(p_user, v_snap);
  update public.progress set
    points = v_points - v_sum - v_challenges,
    lifetime = greatest(0, v_lifetime - greatest(0, v_net) - v_challenges),
    level = private.level_for(greatest(0, v_lifetime - greatest(0, v_net) - v_challenges))
  where user_id = p_user;
  perform private.revert_challenges_of_trip(p_user, p_trip);
  if v_sum <> 0 then
    insert into public.points_ledger (user_id, key, amount, kind, trip_id)
      values (p_user, 'revert:' || p_trip || ':' || v_rev, -v_sum, 'revert', p_trip)
      on conflict (user_id, key) do nothing;
  end if;
end $$;
