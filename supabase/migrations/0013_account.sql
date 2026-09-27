-- hosted safety (T5 review): fail fast on a lock rather than queue in front of apply_trip
set lock_timeout = '5s';

-- 0013_account: the server side of H13 (delete account) and H14 (export my data), lean M8.
--
-- Deleting an account is `auth.admin.deleteUser` from the account-delete edge function: every
-- public table that holds a person's rows references auth.users with ON DELETE CASCADE (or SET NULL
-- where the row is someone else's, `private_profiles.guardian_user_id`), so one delete of the auth
-- user removes them all, inside GoTrue's own transaction. 0012's family_members AFTER DELETE trigger
-- fires on that cascade too: the leaver's location row goes, a family left with no admin gets its
-- longest-standing member as admin, and a family left with no one is deleted with its places.
-- Pending M5 work (reward_due, weekly_goals, user_challenges, the ledger) cascades the same way, so
-- no settlement can run for an account that is gone. 0013's test proves all of it from the catalog:
-- after the delete no table in any schema still contains the id.
--
-- What SQL cannot delete is object bytes (storage.protect_delete; 0002's header). The function lists
-- them with account_object_keys and removes them through the Storage API BEFORE the auth delete. A
-- removal that fails leaves an orphan, which 0008's purge-trace-objects sweep collects: every traces
-- object is deleted 14 days after its upload whether or not a trips row names it.
--
-- Objects (every one follows .agent/backend-conventions.md; numbers are its sections):
--   * public.account_object_keys(p_user uuid, p_limit int, p_after_bucket text, p_after_name text)
--     returns jsonb (service-role guard first; invoker, stable): [{ bucket, name }] of the objects in
--     ANY bucket whose first path segment is p_user, ordered (bucket, name) in byte order, strictly
--     after the cursor when one is given (both parts or neither), 1..1000 rows. The same range
--     predicate as 0008's underage listing, so storage's name_prefix_search index serves it.
--   * public.export_account(p_user uuid) returns jsonb (#5: definer, owner postgres, search_path
--     public; service-role guard first; it reads auth.users for the account's own email): the
--     person's own rows as one JSON document, read in one statement snapshot. NOTHING about another
--     person is in it (convention 12): no other user's id, name or location. Where a row points at
--     someone else it is replaced by a fact about this account (`guardian_linked`, a referral's
--     `as`), and the family section is this account's own membership and the family's name only.
--     Credentials and plumbing are left out and named in `about.excluded`: device push tokens,
--     push registrations and delivery receipts, rate-limit counters, the settlement queue and its
--     diagnostics, sha256s of seen tokens. Raw GPS traces (object bytes, kept 14 days) are not in
--     it either; `about.traces` says so.
--   * public.private_profiles_guardian_gone() (non-definer trigger, BEFORE UPDATE OF
--     guardian_user_id on private_profiles): a minor whose guardian's account is deleted is left at
--     'none', never 'linked' with nobody (below).
--   * No table is created, so no RLS, grants or u13 minimisation change.

-- ---------------------------------------------------------------------------
-- a guardian's deletion ends the minor's link
--
-- private_profiles.guardian_user_id is ON DELETE SET NULL (0001), which left the minor's status at
-- 'linked' with nobody behind it; under minor_consent_mode = guardian_consent_required that would
-- keep a 13-17 driver's drives accepted on a consent nobody now holds. The SET NULL runs as an
-- UPDATE on private_profiles, so this BEFORE UPDATE row trigger sees it: a 'linked' row losing its
-- guardian becomes 'none', exactly what 0006's minimisation writes. Non-definer (convention 7): it
-- only rewrites the row being updated, whoever updates it.
-- ---------------------------------------------------------------------------
create or replace function public.private_profiles_guardian_gone() returns trigger
language plpgsql set search_path = public as $$
begin
  new.guardian_link_status := 'none';
  return new;
end $$;
create trigger private_profiles_guardian_gone before update of guardian_user_id on public.private_profiles
  for each row when (old.guardian_user_id is not null and new.guardian_user_id is null and new.guardian_link_status = 'linked')
  execute function public.private_profiles_guardian_gone();

-- ---------------------------------------------------------------------------
-- listing: one account's objects, every bucket
-- ---------------------------------------------------------------------------
create or replace function public.account_object_keys(p_user uuid, p_limit int, p_after_bucket text, p_after_name text) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_keys jsonb;
begin
  perform public.require_service_role('account_object_keys');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  if (p_after_bucket is null) <> (p_after_name is null) then
    raise exception 'a cursor needs both its bucket and its name' using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', k.bucket_id, 'name', k.name) order by k.bucket_id collate "C", k.name collate "C"), '[]'::jsonb)
    into v_keys
  from (
    select o.bucket_id, o.name
    from storage.objects o
    where split_part(o.name, '/', 1) = p_user::text
      and o.name ~>=~ (p_user::text || '/') and o.name ~<~ (p_user::text || '0')
      and (p_after_bucket is null
           or (o.bucket_id collate "C", o.name collate "C") > (p_after_bucket collate "C", p_after_name collate "C"))
    order by o.bucket_id collate "C", o.name collate "C"
    limit p_limit
  ) k;
  return v_keys;
end $$;

-- ---------------------------------------------------------------------------
-- export: the account's own rows, one document
-- ---------------------------------------------------------------------------
create or replace function public.export_account(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_account jsonb;
begin
  perform public.require_service_role('export_account');
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  select jsonb_build_object('user_id', u.id, 'email', u.email, 'created_at', u.created_at)
    into v_account
  from auth.users u where u.id = p_user;
  if v_account is null then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'format', 'roadwise-export',
    'format_version', 1,
    'exported_at', now(),
    'about', jsonb_build_object(
      'traces', 'Raw second-by-second GPS traces are kept for at most 14 days to check disputed moments, and are not part of this export. Each drive''s route summary is in trips.polyline.',
      'excluded', jsonb_build_array(
        'device push tokens, push registrations and delivery receipts',
        'rate-limit counters',
        'the rewards settlement queue and its diagnostics',
        'hashes of push tokens seen for referral checks')),
    'account', v_account,
    'profile', (select to_jsonb(p) from public.profiles p where p.id = p_user),
    'private_profile', (
      select jsonb_build_object(
        'birth_date', pp.birth_date,
        'guardian_link_status', pp.guardian_link_status,
        'guardian_linked', pp.guardian_user_id is not null,
        'created_at', pp.created_at,
        'updated_at', pp.updated_at)
      from public.private_profiles pp where pp.user_id = p_user),
    'consents', coalesce((select jsonb_agg(to_jsonb(c) order by c.granted_at, c.id) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d) - 'push_token' order by d.created_at, d.id) from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(n) from public.notification_prefs n where n.user_id = p_user),
    'inbox', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'type', i.type, 'payload', i.payload, 'read_at', i.read_at,
          'dismissed_at', i.dismissed_at, 'created_at', i.created_at) order by i.created_at, i.id)
      from public.inbox i where i.user_id = p_user), '[]'::jsonb),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.started_at, t.id) from public.trips t where t.user_id = p_user), '[]'::jsonb),
    'trip_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.started_at, e.id) from public.trip_events e where e.user_id = p_user), '[]'::jsonb),
    'event_disputes', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id) from public.event_disputes d where d.user_id = p_user), '[]'::jsonb),
    'score_daily', coalesce((select jsonb_agg(to_jsonb(s) order by s.day) from public.score_daily s where s.user_id = p_user), '[]'::jsonb),
    'baselines', (select to_jsonb(b) from public.baselines b where b.user_id = p_user),
    'progress', (select to_jsonb(g) from public.progress g where g.user_id = p_user),
    'points_ledger', coalesce((select jsonb_agg(to_jsonb(l) - 'idempotency_key' order by l.created_at, l.id) from public.points_ledger l where l.user_id = p_user), '[]'::jsonb),
    'reward_days', coalesce((select jsonb_agg(to_jsonb(r) order by r.day) from public.reward_days r where r.user_id = p_user), '[]'::jsonb),
    'weekly_goals', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start) from public.weekly_goals w where w.user_id = p_user), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(to_jsonb(b) order by b.earned_at, b.badge_id) from public.user_badges b where b.user_id = p_user), '[]'::jsonb),
    'challenges', coalesce((select jsonb_agg(to_jsonb(c) order by c.start_day, c.id) from public.user_challenges c where c.user_id = p_user), '[]'::jsonb),
    'referral_code', (select jsonb_build_object('code', rc.code, 'created_at', rc.created_at) from public.referral_codes rc where rc.user_id = p_user),
    -- the other side of a referral is another person: only this account's side of it
    'referrals', coalesce((
      select jsonb_agg(jsonb_build_object(
          'as', case when r.referrer_id = p_user then 'referrer' else 'invitee' end,
          'status', r.status,
          'redeemed_at', r.redeemed_at,
          'qualified_at', r.qualified_at,
          'rewarded', case when r.referrer_id = p_user then r.referrer_rewarded else r.invitee_rewarded end)
        order by r.redeemed_at, r.id)
      from public.referrals r where r.referrer_id = p_user or r.invitee_id = p_user), '[]'::jsonb),
    -- this account's own membership and the family's name; never the other members, the code or places
    'family', (
      select jsonb_build_object(
          'family_name', f.name,
          'role', m.role,
          'sharing_location', m.sharing_location,
          'joined_at', m.created_at)
      from public.family_members m join public.families f on f.id = m.family_id
      where m.user_id = p_user),
    'location', (
      select jsonb_build_object('lat', ml.lat, 'lng', ml.lng, 'accuracy_m', ml.accuracy_m, 'driving', ml.driving, 'updated_at', ml.updated_at)
      from public.member_locations ml where ml.user_id = p_user)
  );
end $$;

-- ---------------------------------------------------------------------------
-- grants: the two edge functions' service-role client only
-- ---------------------------------------------------------------------------
alter function public.export_account(uuid) owner to postgres;
revoke all on function public.private_profiles_guardian_gone() from public, anon, authenticated;
revoke all on function public.account_object_keys(uuid, int, text, text) from public, anon, authenticated;
revoke all on function public.export_account(uuid) from public, anon, authenticated;
grant execute on function public.account_object_keys(uuid, int, text, text) to service_role;
grant execute on function public.export_account(uuid) to service_role;
