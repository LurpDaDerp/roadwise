-- 0014_account_delete: deleting an account works from the auth service. Supabase Auth deletes the
-- auth.users row as supabase_auth_admin, and the cascade's trigger on public.profiles ran as that
-- role, which may not touch public.inbox ("permission denied for table inbox"), so every delete of
-- a user with a profile failed: the in-app Delete account and the dashboard's alike. The trigger
-- now runs as its owner, like the other server functions; it still only clears the deleted
-- account's own friend-request notices.
create or replace function public.profile_gone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.inbox where kind = 'friend_request' and payload ->> 'from_user_id' = old.id::text;
  return null;
end $$;
revoke all on function public.profile_gone() from public, anon, authenticated;
