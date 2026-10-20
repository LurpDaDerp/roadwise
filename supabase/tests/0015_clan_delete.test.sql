-- 0015_clan_delete: the auth service deletes users as supabase_auth_admin, which may not touch
-- public.clans or public.clan_members, so the two clan triggers the cascade fires must run as
-- their owner. (The hand-over and the emptied clan's delete are in 0006_social.test.sql.)
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);

select ok(not has_table_privilege('supabase_auth_admin', 'public.clans', 'SELECT'), 'the auth service''s role cannot read clans itself');
select ok(not has_table_privilege('supabase_auth_admin', 'public.clan_members', 'UPDATE'), 'nor change clan members');
select ok((select prosecdef from pg_proc where oid = 'public.clan_member_gone()'::regprocedure), 'clan_member_gone runs as its owner');
select ok((select prosecdef from pg_proc where oid = 'public.clan_leader_required()'::regprocedure), 'clan_leader_required runs as its owner');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.clan_member_gone()'::regprocedure), 'postgres', 'clan_member_gone owned by postgres');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.clan_leader_required()'::regprocedure), 'postgres', 'clan_leader_required owned by postgres');
select ok(not has_function_privilege('authenticated', 'public.clan_member_gone()', 'EXECUTE'), 'nobody calls clan_member_gone directly');
select ok(not has_function_privilege('authenticated', 'public.clan_leader_required()', 'EXECUTE'), 'nobody calls clan_leader_required directly');
select ok((select proconfig @> array['search_path=public'] from pg_proc where oid = 'public.clan_leader_required()'::regprocedure), 'a fixed search_path');

select * from finish();
rollback;
