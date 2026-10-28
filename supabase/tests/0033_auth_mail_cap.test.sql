-- 0033_auth_mail_cap: the send-email hook's per-address cap (5 mails an hour, 10 a day), keyed by
-- the address's SHA256 so it works before the account's row is committed, closed to every API role.
create extension if not exists pgtap with schema extensions;

begin;
select plan(18);

-- an address's hash, as send-email computes it: SHA256 of the lower-cased address
create function pg_temp.a(n int) returns bytea language sql immutable as $$ select extensions.digest('driver' || n || '@example.com', 'sha256') $$;

-- ---------------------------------------------------------------------------
-- closed to the API roles
-- ---------------------------------------------------------------------------
select is((select c.relrowsecurity from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname = 'auth_mail_sends'),
  true, 'auth_mail_sends has RLS on');
select is((select count(*)::int from information_schema.role_table_grants g
    where g.table_schema = 'private' and g.table_name = 'auth_mail_sends' and g.grantee in ('anon', 'authenticated', 'public')), 0,
  'no API role holds a privilege on it');
select is(has_function_privilege('anon', 'private.take_auth_mail(bytea)', 'execute')
    or has_function_privilege('authenticated', 'private.take_auth_mail(bytea)', 'execute'), false,
  'take_auth_mail is not executable by a client role');
select is((select p.prosecdef from pg_proc p where p.oid = 'private.take_auth_mail(bytea)'::regprocedure), false,
  'take_auth_mail runs as its caller');
select is((select exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
    from pg_proc p where p.oid = 'private.take_auth_mail(bytea)'::regprocedure), true,
  'take_auth_mail pins its search_path');

-- ---------------------------------------------------------------------------
-- the hash
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.take_auth_mail(null) $$, '22023', null, 'a null hash is refused');
select throws_ok($$ select private.take_auth_mail('\x0102'::bytea) $$, '22023', null, 'a hash that is not 32 bytes is refused');

-- ---------------------------------------------------------------------------
-- 5 an hour
-- ---------------------------------------------------------------------------
select is((select array_agg(private.take_auth_mail(pg_temp.a(1))) from generate_series(1, 5)),
  array[true, true, true, true, true], 'an address gets 5 mails in an hour');
select is(private.take_auth_mail(pg_temp.a(1)), false, 'the 6th in that hour is refused');
select is((select hour_count from private.auth_mail_sends where address_hash = pg_temp.a(1)), 5,
  'a refused mail does not count');
select is(private.take_auth_mail(pg_temp.a(2)), true, 'another address has its own count');
select is((select count(*)::int from private.auth_mail_sends), 2, 'one row per address');

-- ---------------------------------------------------------------------------
-- 10 a day
-- ---------------------------------------------------------------------------
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where address_hash = pg_temp.a(1);
select is((select array_agg(private.take_auth_mail(pg_temp.a(1))) from generate_series(1, 5)),
  array[true, true, true, true, true], 'the next hour gives 5 more');
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where address_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1)), false, 'but 10 in a day is the most, whatever the hour');
update private.auth_mail_sends set hour_start = now() - interval '25 hours', day_start = now() - interval '25 hours'
  where address_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1)), true, 'a new day starts the count again');
select is((select (hour_count, day_count)::text from private.auth_mail_sends where address_hash = pg_temp.a(1)), '(1,1)',
  'both windows start again from that mail');

-- ---------------------------------------------------------------------------
-- old rows go
-- ---------------------------------------------------------------------------
update private.auth_mail_sends set hour_start = now() - interval '3 days', day_start = now() - interval '3 days'
  where address_hash = pg_temp.a(2);
select is(private.take_auth_mail(pg_temp.a(3)), true, 'a third address is mailed');
select is((select count(*)::int from private.auth_mail_sends where address_hash = pg_temp.a(2)), 0,
  'an address whose day ended more than a day ago is dropped by the next mail');

select * from finish();
rollback;
