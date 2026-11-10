-- 0041_audit_fixes: the time zone read without a scan of every zone file, the friend RPCs closed to an
-- account that never finished setting up, friend-request pushes only while the request stands, and
-- refusals that count against the caller's budget.
--
--   * private.user_tz: the stored zone (prefs, else the latest drive, else New York) is checked by
--     its shape and one `at time zone` probe through the server's zone cache, falling back to New
--     York when the probe refuses it. Every stored zone was checked by private.is_known_tz when it
--     was written; the per-call pg_timezone_names scan (every zone file read and parsed) is gone
--     from the push claim and the hourly recap and Wrapped loops, which call this once per row.
--     is_known_tz itself is unchanged and still guards the write paths.
--   * send_friend_request, search_users and respond_friend_request refuse a caller whose profile
--     has no onboarded_at (42501 'finish setting up your account first'), before any budget is
--     taken. list_friends leaves out anyone not onboarded. Requests, and their push rows, from or to
--     an account that is not onboarded are deleted once here.
--   * claim_push_batch: a due friend_request push whose request no longer stands (cancelled,
--     answered, or ended by a block, which deletes requests both ways) is marked skipped,
--     'request_gone', instead of being sent. The row stays, so a re-sent request still finds its
--     sender already pushed (0029).
--   * Refusals after the rate-limit take no longer raise, since a raise rolls the take back with
--     everything else: get_profile and send_friend_request answer a refusal as PostgREST's own error
--     body with an error HTTP status (private.refusal: 404 not found, 403 not allowed), so the client
--     reads the same code and message and the take stands; report_target answers an unknown target as a
--     report that went through, storing nothing.
--
-- Same signatures: CREATE OR REPLACE keeps their ACLs. The two new private helpers are closed to
-- the API roles.

-- ---------------------------------------------------------------------------
-- the time zone
-- ---------------------------------------------------------------------------
-- prefs.tz, else the zone of the latest drive, else New York; a zone of the wrong shape, or one the
-- server does not recognise (a tzdata change can drop one), is New York too
create or replace function private.user_tz(p_user uuid) returns text
language plpgsql stable set search_path = public as $$
declare
  v_tz text;
begin
  select p.tz into v_tz from public.notification_prefs p where p.user_id = p_user;
  if v_tz is null then
    select t.tz into v_tz from public.trips t where t.user_id = p_user order by t.started_at desc limit 1;
  end if;
  if v_tz is null
     or char_length(v_tz) not between 1 and 64
     or v_tz !~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$'
     or v_tz ~ '^(posix|right)/' then
    return 'America/New_York';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when invalid_parameter_value then
    return 'America/New_York';
  end;
  return v_tz;
end $$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
-- a refusal that must not undo the caller's rate-limit take: the body is PostgREST's own error
-- shape and response.status an error status (404 for P0002, which a raise would have sent as 500;
-- 403 for 42501, as a raise from a signed-in caller), so supabase-js reads it as the same error
-- (it keys on a non-2xx status and the body's code) while the transaction commits
create or replace function private.refusal(p_code text, p_message text, p_status int) returns jsonb
language plpgsql volatile set search_path = public as $$
begin
  perform set_config('response.status', p_status::text, true);
  return jsonb_build_object('code', p_code, 'details', null, 'hint', null, 'message', p_message);
end $$;

-- the social RPCs are for an account that finished setting up: a username and the 13+ terms
create or replace function private.require_onboarded(p_user uuid) returns void
language plpgsql stable set search_path = public as $$
begin
  if not exists (select 1 from public.profiles p where p.id = p_user and p.onboarded_at is not null) then
    raise exception 'finish setting up your account first' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- friends
-- ---------------------------------------------------------------------------
-- search_users(p_query >= 3 chars) -> up to 20 cards, prefix match, onboarded users only, never self
-- or anyone blocked either way; 30/min; the caller must be onboarded. A result that is not a friend
-- shows no rating.
create or replace function public.search_users(p_query text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_q text := lower(btrim(coalesce(p_query, '')));
begin
  if v_uid is null then
    raise exception 'search_users requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_onboarded(v_uid);
  if char_length(v_q) < 3 or char_length(v_q) > 20 or v_q !~ '^[a-z0-9_]+$' then
    raise exception 'query must be 3 to 20 letters, digits or underscores' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'search_users', interval '1 minute', 30);
  return coalesce((
    select jsonb_agg(private.public_card(p.id, v_uid) order by p.username)
    from (
      select p.id, p.username from public.profiles p
      where p.username::text like replace(v_q, '_', '\_') || '%' and p.id <> v_uid and p.onboarded_at is not null
        and not private.blocked_either(v_uid, p.id)
      order by p.username
      limit 20
    ) p), '[]'::jsonb);
end $$;

-- send_friend_request(p_user_id): auto-accepts when the reverse request exists; refused when
-- blocked either way (as "not found"), when already friends, or over the 200-friend cap; 20/h,
-- refusals included; the caller must be onboarded. The request is always recorded; its push (the
-- inbox row) goes only for a sender not yet pushed to the recipient, and at most 5 times in the
-- recipient's 24-hour window.
create or replace function public.send_friend_request(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'send_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_onboarded(v_uid);
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'user_id must be another user' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'send_friend_request', interval '1 hour', 20);
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.onboarded_at is not null)
     or private.blocked_either(v_uid, p_user_id) then
    return private.refusal('P0002', 'profile not found', 404);
  end if;
  if private.are_friends(v_uid, p_user_id) then
    return jsonb_build_object('status', 'friends');
  end if;
  if private.friend_count(v_uid) >= 200 then
    return private.refusal('42501', 'you have reached the friend limit', 403);
  end if;
  if exists (select 1 from public.friend_requests r where r.from_id = p_user_id and r.to_id = v_uid) then
    if private.friend_count(p_user_id) >= 200 then
      return private.refusal('42501', 'that user has reached the friend limit', 403);
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

-- respond_friend_request(p_user_id, p_accept): the caller must be onboarded
create or replace function public.respond_friend_request(p_user_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'respond_friend_request requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_onboarded(v_uid);
  if p_user_id is null or p_accept is null then
    raise exception 'user_id and accept are required' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.friend_requests where from_id = p_user_id and to_id = v_uid;
  if not found then
    raise exception 'no such request' using errcode = 'no_data_found';
  end if;
  if p_accept then
    if private.blocked_either(v_uid, p_user_id) then
      raise exception 'profile not found' using errcode = 'no_data_found';
    end if;
    if private.friend_count(v_uid) >= 200 or private.friend_count(p_user_id) >= 200 then
      raise exception 'you have reached the friend limit' using errcode = 'insufficient_privilege';
    end if;
    insert into public.friendships (user_a, user_b) values (least(v_uid, p_user_id), greatest(v_uid, p_user_id)) on conflict do nothing;
    delete from public.friend_requests where from_id = v_uid and to_id = p_user_id;
  end if;
end $$;

-- list_friends() -> { friends[], incoming[], outgoing[] } of public cards as the caller sees them
-- (blocked and not-onboarded omitted; a request either way is not a friend, so it shows no rating)
create or replace function public.list_friends() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'list_friends requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'friends', coalesce((select jsonb_agg(private.public_card(x.other, v_uid) order by x.created_at desc)
      from (select case when f.user_a = v_uid then f.user_b else f.user_a end as other, f.created_at from public.friendships f
            where f.user_a = v_uid or f.user_b = v_uid) x
      where not private.blocked_either(v_uid, x.other)
        and exists (select 1 from public.profiles p where p.id = x.other and p.onboarded_at is not null)), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(private.public_card(r.from_id, v_uid) order by r.created_at desc) from (
      select q.from_id, q.created_at from public.friend_requests q where q.to_id = v_uid and not private.blocked_either(v_uid, q.from_id)
        and exists (select 1 from public.profiles p where p.id = q.from_id and p.onboarded_at is not null)
      order by q.created_at desc limit 200) r), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(private.public_card(r.to_id, v_uid) order by r.created_at desc) from (
      select q.to_id, q.created_at from public.friend_requests q where q.from_id = v_uid and not private.blocked_either(v_uid, q.to_id)
        and exists (select 1 from public.profiles p where p.id = q.to_id and p.onboarded_at is not null)
      order by q.created_at desc limit 200) r), '[]'::jsonb));
end $$;

-- requests, and their push rows, from or to an account that never finished setting up
delete from public.inbox i
  where i.kind = 'friend_request'
    and not exists (select 1 from public.profiles p where p.id::text = i.payload ->> 'from_user_id' and p.onboarded_at is not null);
delete from public.friend_requests r
  where not exists (select 1 from public.profiles p where p.id = r.from_id and p.onboarded_at is not null)
     or not exists (select 1 from public.profiles p where p.id = r.to_id and p.onboarded_at is not null);

-- ---------------------------------------------------------------------------
-- profiles and reports: refusals after the take stand
-- ---------------------------------------------------------------------------
-- get_profile(p_username): the public profile, or "not found" (also when blocked either way), which
-- still counts against the 60/min. What a friend sees follows the driver's sharing settings; anyone
-- else sees the name and nothing more.
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_other uuid;
  v_rel text;
  v_friend boolean;
  v_self boolean;
  pr public.profiles%rowtype;
  s jsonb;
  v_scores jsonb := null;
begin
  if v_uid is null then
    raise exception 'get_profile requires an authenticated user' using errcode = 'insufficient_privilege';
  end if;
  if p_username is null or char_length(p_username) > 20 then
    raise exception 'username must be 3 to 20 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_rate_limit(v_uid, 'get_profile', interval '1 minute', 60);
  select * into pr from public.profiles p
    where p.username operator(extensions.=) p_username::extensions.citext and p.onboarded_at is not null;
  v_other := pr.id;
  if v_other is null or private.blocked_either(v_uid, v_other) then
    return private.refusal('P0002', 'profile not found', 404);
  end if;
  v_self := v_other = v_uid;
  v_friend := not v_self and private.are_friends(v_uid, v_other);
  v_rel := case
    when v_self then 'self'
    when v_friend then 'friend'
    when exists (select 1 from public.friend_requests r where r.from_id = v_other and r.to_id = v_uid) then 'incoming'
    when exists (select 1 from public.friend_requests r where r.from_id = v_uid and r.to_id = v_other) then 'outgoing'
    else 'none' end;
  -- the category scores, whole numbers (half up), each null where it has no score (Attention without
  -- DashPal, Phone use before any drive was watched for it): to a friend only with the Safety Rating
  -- shared too, since the rating is their weighted mean and would show through them. The rating is
  -- computed once, into a variable: an inline subquery would be copied into each of the twelve reads.
  if v_self or (v_friend and pr.share_rating and pr.share_categories) then
    s := private.rating_at(v_other, now()) -> 'scores';
    v_scores := jsonb_build_object(
      'acceleration', case when s ->> 'acceleration' is null then null else private.round_half_up((s ->> 'acceleration')::float8, 0)::int end,
      'braking', case when s ->> 'braking' is null then null else private.round_half_up((s ->> 'braking')::float8, 0)::int end,
      'turning', case when s ->> 'turning' is null then null else private.round_half_up((s ->> 'turning')::float8, 0)::int end,
      'attention', case when s ->> 'attention' is null then null else private.round_half_up((s ->> 'attention')::float8, 0)::int end,
      'phone', case when s ->> 'phone' is null then null else private.round_half_up((s ->> 'phone')::float8, 0)::int end,
      'speed', case when s ->> 'speed' is null then null else private.round_half_up((s ->> 'speed')::float8, 0)::int end);
  end if;
  return private.public_card(v_other, v_uid) || jsonb_build_object(
    'achievements', case when v_self or (v_friend and pr.share_achievements)
      then coalesce((select jsonb_agg(a.achievement_id order by a.unlocked_at) from public.user_achievements a where a.user_id = v_other), '[]'::jsonb)
      else '[]'::jsonb end,
    'scores', v_scores,
    -- LEGACY (Phase B removes): clans are server-only; an older build reads the key
    'clan', null,
    'relationship', v_rel,
    'can_view_stats', v_self or (v_friend and pr.share_stats),
    'can_view_heatmap', v_self or (v_friend and pr.heatmap_visibility = 'friends'));
end $$;

-- report_target(p_kind, p_target_id, p_reason, p_note): 10/day, never self; a report about an id
-- that names nobody is answered like any other and stores nothing, so it costs a report and says
-- nothing about which ids exist
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
    return;
  end if;
  insert into public.reports (reporter_id, target_kind, target_id, reason, note)
    values (v_uid, p_kind, p_target_id, p_reason, regexp_replace(p_note, '[[:cntrl:]]', '', 'g'));
end $function$;

-- ---------------------------------------------------------------------------
-- push: a friend request's push only while the request stands
-- ---------------------------------------------------------------------------
-- claim_push_batch as 0038, with due friend_request rows whose request is gone skipped first
create or replace function public.claim_push_batch(p_limit integer, p_lease_seconds integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  perform public.require_service_role('claim_push_batch');
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'limit must be between 1 and 500' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease must be between 30 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  update public.inbox set push_state = 'failed', push_reason = 'lease_expired'
    where push_state = 'sending' and push_claimed_at < now() - make_interval(secs => p_lease_seconds);
  -- a request cancelled, answered or ended by a block (block_user deletes requests both ways, and a
  -- blocked sender cannot ask again) has no friend_requests row left; its push row is kept, skipped,
  -- so a re-sent request still finds its sender already pushed
  update public.inbox i set push_state = 'skipped', push_reason = 'request_gone'
    where i.kind = 'friend_request' and i.push_state in ('pending', 'deferred') and i.push_after <= now()
      and not exists (select 1 from public.friend_requests r
                      where r.to_id = i.user_id and r.from_id::text = i.payload ->> 'from_user_id');
  with due as (
    select i.id from public.inbox i
    where i.push_state in ('pending', 'deferred') and i.push_after <= now()
    order by i.push_after, i.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.inbox i set push_state = 'sending', push_claimed_at = now(), push_attempts = i.push_attempts + 1
      from due where i.id = due.id
      returning i.id, i.user_id, i.kind, i.payload, i.created_at, i.push_after
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'inbox_id', c.id, 'user_id', c.user_id, 'kind', c.kind, 'payload', c.payload, 'created_at', c.created_at,
      'ctx', jsonb_build_object(
        'tz', private.user_tz(c.user_id),
        'quiet', jsonb_build_object('enabled', coalesce(p.quiet_enabled, true),
          'start', left(coalesce(p.quiet_start, '22:00'::time)::text, 5), 'end', left(coalesce(p.quiet_end, '07:00'::time)::text, 5)),
        'enabled', case when c.kind in ('weekly_recap', 'monthly_wrapped') then coalesce(p.weekly_recap, true)
                        else coalesce(p.social, true) end,
        'tokens', coalesce((select jsonb_agg(d.push_token order by d.last_seen_at desc) from (
                    select d.push_token, d.last_seen_at from public.devices d
                    where d.user_id = c.user_id and d.push_token is not null order by d.last_seen_at desc limit 10) d), '[]'::jsonb)))
      order by c.push_after, c.id), '[]'::jsonb)
    into v_out
  from claimed c left join public.notification_prefs p on p.user_id = c.user_id;
  return v_out;
end $function$;

-- ---------------------------------------------------------------------------
-- grants (a replaced function keeps its grants; the two helpers are new)
-- ---------------------------------------------------------------------------
revoke all on function private.refusal(text, text, int) from public, anon, authenticated;
revoke all on function private.require_onboarded(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
