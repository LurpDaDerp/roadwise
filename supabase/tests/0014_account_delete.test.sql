-- 0014_account_delete: the auth service deletes users as supabase_auth_admin, which may not touch
-- public.inbox, so the profiles trigger that clears a deleted account's friend-request notices must
-- run as its owner. (The cascade itself, and that the notices go, are in 0009_account.test.sql.)
create extension if not exists pgtap with schema extensions;

begin;
select plan(4);

select ok(not has_table_privilege('supabase_auth_admin', 'public.inbox', 'DELETE'), 'the auth service''s role cannot delete from the inbox itself');
select ok((select prosecdef from pg_proc where oid = 'public.profile_gone()'::regprocedure), 'profile_gone runs as its owner');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.profile_gone()'::regprocedure), 'postgres', 'owned by postgres');
select ok(not has_function_privilege('authenticated', 'public.profile_gone()', 'EXECUTE'), 'nobody calls it directly');

select * from finish();
rollback;
