-- 0042_report_target_restore: a report about an id that names nobody is refused.
--
--   * public.report_target: the target has to be an existing profile. An id that names nobody raises
--     P0002 'profile not found' after the checks on the caller, the kind, the reason, the note and
--     self. The raise undoes the rate-limit take with everything else, so the refused report stores
--     nothing and costs nothing against the 10 a day.
--
-- Same signature: CREATE OR REPLACE keeps its ACL.

-- report_target(p_kind, p_target_id, p_reason, p_note): 10/day, never self; an id that names nobody
-- is 'profile not found'
create or replace function public.report_target(p_kind text, p_target_id uuid, p_reason text, p_note text default ''::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'report_target requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_kind is null or p_kind <> 'user' or p_target_id is null then
    raise exception 'kind must be user with a target id' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('inappropriate_name', 'harassment', 'cheating', 'impersonation', 'other') then
    raise exception 'unknown report reason' using errcode = 'invalid_parameter_value';
  end if;
  if p_note is null or char_length(p_note) > 500 then
    raise exception 'note must be at most 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_target_id = v_uid then
    raise exception 'kind must be user with a target id' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'report_target', interval '1 day', 10);
  if not exists (select 1 from public.profiles p where p.id = p_target_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  insert into public.reports (reporter_id, target_kind, target_id, reason, note)
    values (v_uid, p_kind, p_target_id, p_reason, regexp_replace(p_note, '[[:cntrl:]]', '', 'g'));
end $function$;

notify pgrst, 'reload schema';
