-- 0042_report_target_restore: a report about an id that names nobody is refused as 'profile not
-- found', stores nothing and costs nothing against the 10 a day; a report about a driver goes through
-- and costs one. The function still runs as its definer, pins search_path and is open to signed-in
-- callers and closed to anon.
create extension if not exists pgtap with schema extensions;

begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';

-- ava's reports taken from today's 10
create function pg_temp.taken() returns int language sql stable as $$
  select coalesce((select r.count from public.rate_limits r
    where r.user_id = '00000000-0000-0000-0000-000000000001' and r.key = 'report_target'), 0)
$$;

-- ---------------------------------------------------------------------------
-- a report about nobody
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.report_target('user', '00000000-0000-0000-0000-00000000dead', 'other', '') $$, 'P0002', 'profile not found',
  'a report about an id that names nobody is refused');
reset role;
select is(array[pg_temp.taken(), (select count(*)::int from public.reports r where r.reporter_id = '00000000-0000-0000-0000-000000000001')],
  array[0, 0], 'it stores nothing and costs no report');

-- ---------------------------------------------------------------------------
-- a report about a driver
-- ---------------------------------------------------------------------------
set local role authenticated;
select lives_ok($$ select public.report_target('user', '00000000-0000-0000-0000-000000000002', 'other', '') $$, 'a report about a driver goes through');
reset role;
select is(array[pg_temp.taken(), (select count(*)::int from public.reports r
    where r.reporter_id = '00000000-0000-0000-0000-000000000001' and r.target_kind = 'user' and r.target_id = '00000000-0000-0000-0000-000000000002'
      and r.reason = 'other' and r.note = '')],
  array[1, 1], 'it is stored and costs one report');

-- ---------------------------------------------------------------------------
-- the function itself
-- ---------------------------------------------------------------------------
select is((select row(prosecdef, proconfig)::text from pg_proc where oid = 'public.report_target(text, uuid, text, text)'::regprocedure),
  row(true, array['search_path=public'])::text, 'it runs as its definer and pins search_path');
select is(array[has_function_privilege('anon', 'public.report_target(text, uuid, text, text)', 'execute'),
    has_function_privilege('authenticated', 'public.report_target(text, uuid, text, text)', 'execute')],
  array[false, true], 'closed to anon, open to a signed-in caller');

select * from finish();
rollback;
