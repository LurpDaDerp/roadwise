-- 0027_live_activity_release: a push-to-start that Apple refused, or that never reached Apple, hands
-- its claim back, so the phone's retry for the same drive and leg can send.
--
--   * release_live_activity_start(device, drive, leg) is what the live-activity-start edge function
--     calls after a failed send, as the caller (the publishable key with the caller's token). On the
--     caller's own device row, and only while that row still records this drive and this leg as
--     claimed, it clears the claim's time: claim_live_activity_start then sees no send in the last 15
--     minutes and hands the token out again. A row that records another drive or another leg (a newer
--     claim) is left alone. It answers whether a claim was handed back. 30 an hour per account, like
--     the claim; the claim's own hourly budget is not refunded.

create or replace function public.release_live_activity_start(p_device_id text, p_client_trip_id uuid, p_leg int default 0) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'release_live_activity_start requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_client_trip_id is null then
    raise exception 'client_trip_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_leg is null or p_leg not between 0 and 50 then
    raise exception 'leg must be 0 to 50' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'live_activity_release', interval '1 hour', 30);
  update public.devices set live_activity_sent_at = null
    where user_id = v_uid and device_id = p_device_id
      and live_activity_drive = p_client_trip_id and coalesce(live_activity_leg, 0) = p_leg
      and live_activity_sent_at is not null;
  return found;
end $$;

revoke all on function public.release_live_activity_start(text, uuid, int) from public, anon, authenticated;
grant execute on function public.release_live_activity_start(text, uuid, int) to authenticated;
notify pgrst, 'reload schema';
