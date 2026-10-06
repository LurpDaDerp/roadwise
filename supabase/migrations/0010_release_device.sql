-- 0010_release_device: on sign-out the phone drops its push token, so the next account on the
-- device (or nobody) is who gets its pushes. Acts only on the caller's own (user, device) row; a
-- missing row is a no-op (never an existence oracle). The device row, its claim and the account's
-- league eligibility are untouched.

create or replace function public.release_device(p_device_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'release_device requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'device_id must be 8 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  update public.devices set push_token = null where user_id = v_uid and device_id = p_device_id and push_token is not null;
end $$;

revoke all on function public.release_device(text) from public, anon, authenticated;
grant execute on function public.release_device(text) to authenticated;
