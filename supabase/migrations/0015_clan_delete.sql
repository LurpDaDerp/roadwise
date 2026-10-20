-- 0015_clan_delete: deleting an account that has a clan_members row works from the auth service.
-- Supabase Auth deletes the auth.users row as supabase_auth_admin, and the cascade's two clan
-- triggers ran as that role, which may not touch public.clans or public.clan_members ("permission
-- denied for table clans"), so every delete of a user who ever joined a clan failed: the in-app
-- Delete account and the dashboard's alike. Both triggers now run as their owner, like 0014's
-- profile_gone; their bodies are unchanged (leadership is handed over, an emptied clan is
-- deleted, a clan always has a leader).
create or replace function public.clan_member_gone() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_next uuid;
begin
  if not exists (select 1 from public.clans c where c.id = old.clan_id) then
    return null;
  end if;
  if not exists (select 1 from public.clan_members m where m.clan_id = old.clan_id) then
    delete from public.clans where id = old.clan_id;
    return null;
  end if;
  if old.role = 'leader' and not exists (select 1 from public.clan_members m where m.clan_id = old.clan_id and m.role = 'leader') then
    select m.user_id into v_next from public.clan_members m
      where m.clan_id = old.clan_id
      order by (m.role = 'coleader') desc, m.joined_at, m.user_id
      limit 1;
    update public.clan_members set role = 'leader' where user_id = v_next;
  end if;
  return null;
end $$;

create or replace function public.clan_leader_required() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.clans c where c.id = coalesce(new.clan_id, old.clan_id))
     and not exists (select 1 from public.clan_members m where m.clan_id = coalesce(new.clan_id, old.clan_id) and m.role = 'leader') then
    raise exception 'a clan needs a leader' using errcode = 'check_violation';
  end if;
  return null;
end $$;

revoke all on function public.clan_member_gone() from public, anon, authenticated;
revoke all on function public.clan_leader_required() from public, anon, authenticated;
