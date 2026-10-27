-- 0029_privacy_and_bounds: where a drive ended is no longer kept, a drive that overlaps another is
-- not scored, a driver gets at most 5 friend-request pushes a day, and the last clan RPC is closed.
--
--   * progress.last_end_lat / last_end_lng held the end point of each driver's latest drive (to 4
--     decimal places, ~11 m: often their door) for the merge check, which nothing reads since every
--     upload is stored as its own drive. finalize-trip no longer passes a start or an end point on
--     (apply_drive then writes nulls), and the points already held are cleared here. last_end_at
--     (a time, not a place) stays.
--   * private.drive_overlaps(user, drive, start, end): whether another stored drive of the user
--     starts more than a minute before this one ends and ends more than a minute after it starts,
--     on the times apply_drive will store (its clock rule: a drive dated to end more than 10 minutes
--     from now ends now). A drive's own clientTripId (a replay) never overlaps itself; a merged-away
--     row is part of its target. finalize-trip stores such an upload unscored as implausible: one
--     person drives one car at a time, so a second drive in the same minutes was not driven. The
--     minute is slack for a start traced back to a row a few seconds before the last drive's end.
--   * send_friend_request still records every request, but adds the inbox row (the push) only for a
--     sender not yet pushed to that recipient and while the recipient has had fewer than 5 such pushes
--     in their 24-hour window, so throwaway accounts cannot flood one driver with pushes. The count is
--     the recipient's own rate-limit row (private.take_rate_limit, 'friend_request_push'): it takes one
--     request at a time, and deleting a sender's account (whose inbox rows go with it) gives no push
--     back. The requests still show in Friends.
--   * leave_clan, the last clan RPC a client could call (clans left the app in 0012), is server-only.
--
-- Deploy order: this migration, then finalize-trip. The finalize-trip before this one keeps working
-- on this schema (it never calls drive_overlaps); the new one answers a database without this
-- migration with a 500, which phones retry.

-- ---------------------------------------------------------------------------
-- where drives ended: no longer kept
-- ---------------------------------------------------------------------------
update public.progress set last_end_lat = null, last_end_lng = null
  where last_end_lat is not null or last_end_lng is not null;

-- ---------------------------------------------------------------------------
-- overlapping drives
-- ---------------------------------------------------------------------------
create or replace function private.drive_overlaps(p_user uuid, p_client_trip_id uuid, p_started_at timestamptz, p_ended_at timestamptz) returns boolean
language plpgsql stable set search_path = public as $$
begin
  if p_user is null or p_client_trip_id is null or p_started_at is null or p_ended_at is null then
    raise exception 'user, clientTripId, startedAt and endedAt are required' using errcode = 'invalid_parameter_value';
  end if;
  -- apply_drive's clock rule: a drive dated to end more than 10 minutes from now is stored ending now
  if p_ended_at > now() + interval '10 minutes' then
    p_started_at := p_started_at - (p_ended_at - now());
    p_ended_at := now();
  end if;
  return exists (
    select 1 from public.trips x
    where x.user_id = p_user and x.merged_into is null and x.client_trip_id <> p_client_trip_id
      -- a stored drive lasts at most 12 hours (trips_time_order): the user's index range stays short
      and x.started_at > p_started_at - interval '12 hours'
      and x.started_at < p_ended_at - interval '1 minute'
      and x.ended_at > p_started_at + interval '1 minute');
end $$;

-- ---------------------------------------------------------------------------
-- friend requests: at most 5 pushes a day for one recipient
-- ---------------------------------------------------------------------------
-- send_friend_request(p_user_id): auto-accepts when the reverse request exists; refused when
-- blocked either way (as "not found"), when already friends, or over the 200-friend cap; 20/h. The
-- request is always recorded; its push (the inbox row) goes only for a sender not yet pushed to the
-- recipient, and at most 5 times in the recipient's 24-hour window.
create or replace function public.send_friend_request(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'send_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another user' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'send_friend_request', interval '1 hour', 20);
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.onboarded_at is not null)
     or private.blocked_either(v_uid, p_user_id) then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if private.are_friends(v_uid, p_user_id) then
    return jsonb_build_object('status', 'friends');
  end if;
  if private.friend_count(v_uid) >= 200 then
    raise exception 'you have reached the friend limit' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.friend_requests r where r.from_id = p_user_id and r.to_id = v_uid) then
    if private.friend_count(p_user_id) >= 200 then
      raise exception 'that user has reached the friend limit' using errcode = 'insufficient_privilege';
    end if;
    delete from public.friend_requests where (from_id = p_user_id and to_id = v_uid) or (from_id = v_uid and to_id = p_user_id);
    insert into public.friendships (user_a, user_b) values (least(v_uid, p_user_id), greatest(v_uid, p_user_id)) on conflict do nothing;
    return jsonb_build_object('status', 'friends');
  end if;
  insert into public.friend_requests (from_id, to_id) values (v_uid, p_user_id) on conflict do nothing;
  -- a re-sent request (its push row already there) spends nothing; the count lives in the
  -- recipient's own rate-limit row, locked per recipient, which a sender's account deletion leaves
  -- alone (two ifs: SQL does not promise to skip the take when the first test fails)
  if not exists (select 1 from public.inbox i where i.user_id = p_user_id and i.dedupe_key = 'friend_request:' || v_uid) then
    if private.take_rate_limit(p_user_id, 'friend_request_push', interval '24 hours', 5) then
      insert into public.inbox (user_id, kind, payload, dedupe_key)
        values (p_user_id, 'friend_request', jsonb_build_object('from_user_id', v_uid), 'friend_request:' || v_uid)
        on conflict (user_id, dedupe_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('status', 'requested');
end $$;

-- ---------------------------------------------------------------------------
-- grants (a replaced function keeps its grants)
-- ---------------------------------------------------------------------------
revoke all on function private.drive_overlaps(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.leave_clan() from public, anon, authenticated;
notify pgrst, 'reload schema';
