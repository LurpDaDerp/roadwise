-- 0009_account: export my data and the account-delete backstops.
--
-- Deleting an account is `auth.admin.deleteUser` from the account-delete edge function: every
-- table that holds a person's rows references auth.users ON DELETE CASCADE, so one delete removes
-- them all (clan leadership is handed over by 0006's trigger; an emptied clan is deleted; an
-- emptied league group simply closes with fewer members). GoTrue's audit log has no FK, so
-- purge_auth_audit removes a deleted account's rows afterwards and a daily job keeps 30 days.

-- a deleted account's friend-request notices leave the other users' inboxes with it (the payload
-- names the sender; the foreign keys cannot reach into jsonb). Fires on the profiles row, which the
-- auth.users cascade removes.
create or replace function public.profile_gone() returns trigger
language plpgsql set search_path = public as $$
begin
  delete from public.inbox where kind = 'friend_request' and payload ->> 'from_user_id' = old.id::text;
  return null;
end $$;
create trigger profiles_gone after delete on public.profiles for each row execute function public.profile_gone();
revoke all on function public.profile_gone() from public, anon, authenticated;

-- export_account(p_user) -> one JSON document of the account's own rows. Nothing about another
-- person is in it: no other user's id, name or location; friendships and requests are counts,
-- the clan is this account's own membership and the clan's name.
create or replace function public.export_account(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_account jsonb;
begin
  perform public.require_service_role('export_account');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  select jsonb_build_object('user_id', u.id, 'email', u.email, 'created_at', u.created_at) into v_account from auth.users u where u.id = p_user;
  if v_account is null then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;
  return jsonb_build_object(
    'format', 'roadwise-export',
    'format_version', 3,
    'exported_at', now(),
    'about', jsonb_build_object('excluded', jsonb_build_array(
      'device push tokens and push delivery receipts', 'rate-limit counters', 'the merge-check end point of your latest drive')),
    'account', v_account,
    'profile', (select to_jsonb(p) - 'flagged' from public.profiles p where p.id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'platform', d.platform, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) order by d.created_at)
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'progress', (select to_jsonb(g) - 'last_end_lat' - 'last_end_lng' - 'last_end_at' from public.progress g where g.user_id = p_user),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) - 'progress_before' order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.client_event_id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    'points_ledger', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id) from public.points_ledger l where l.user_id = p_user), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at) from public.user_achievements a where a.user_id = p_user), '[]'::jsonb),
    'weekly_challenges', coalesce((select jsonb_agg(to_jsonb(w) order by w.league_week, w.slot) from public.weekly_challenges w where w.user_id = p_user), '[]'::jsonb),
    'league_results', coalesce((select jsonb_agg(jsonb_build_object('week', m.week, 'tier', m.tier, 'joined_at', m.joined_at, 'result', m.result, 'final_rank', m.final_rank) order by m.week)
      from public.league_members m where m.user_id = p_user), '[]'::jsonb),
    'clan', (select jsonb_build_object('name', c.name, 'role', m.role, 'joined_at', m.joined_at)
      from public.clan_members m join public.clans c on c.id = m.clan_id where m.user_id = p_user),
    'friends', jsonb_build_object(
      'count', private.friend_count(p_user),
      'outgoing_requests', (select count(*) from public.friend_requests r where r.from_id = p_user),
      'incoming_requests', (select count(*) from public.friend_requests r where r.to_id = p_user),
      'blocked_count', (select count(*) from public.blocks b where b.blocker_id = p_user)),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('target_kind', r.target_kind, 'reason', r.reason, 'note', r.note, 'created_at', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(n) from public.notification_prefs n where n.user_id = p_user),
    'inbox', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'payload', i.payload - 'from_user_id', 'created_at', i.created_at) order by i.created_at)
      from public.inbox i where i.user_id = p_user), '[]'::jsonb));
end $$;

-- purge_auth_audit(p_user, p_email) -> int: after the auth delete, every audit row naming the id or
-- the email; refused while the account still exists
create or replace function public.purge_auth_audit(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_count int;
begin
  perform public.require_service_role('purge_auth_audit');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  if v_email is not null and char_length(v_email) > 320 then
    raise exception 'email is too long' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'account still exists' using errcode = 'insufficient_privilege';
  end if;
  delete from auth.audit_log_entries a
  where position(p_user::text in a.payload::text) > 0
     or (v_email is not null and (lower(a.payload ->> 'actor_username') = v_email or lower(a.payload -> 'traits' ->> 'user_email') = v_email));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

select cron.schedule('purge-auth-audit', '50 4 * * *', $$delete from auth.audit_log_entries where created_at < now() - interval '30 days'$$);

revoke all on function public.export_account(uuid) from public, anon, authenticated;
revoke all on function public.purge_auth_audit(uuid, text) from public, anon, authenticated;
grant execute on function public.export_account(uuid) to service_role;
grant execute on function public.purge_auth_audit(uuid, text) to service_role;
