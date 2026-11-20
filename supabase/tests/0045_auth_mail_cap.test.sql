-- 0045_auth_mail_cap: the send-email hook's caps (an inbox 5 mails an hour and 10 a day, an IP 20
-- an hour and 50 a day, taken together or not at all), keyed by SHA-256 so they work before the
-- account's row is committed, closed to every API role; and the password a first confirmation
-- clears.
create extension if not exists pgtap with schema extensions;

begin;
select plan(32);

-- an inbox's hash and an IP's hash, as send-email computes them
create function pg_temp.a(n int) returns bytea language sql immutable as $$ select extensions.digest('driver' || n || '@example.com', 'sha256') $$;
create function pg_temp.ip(n int) returns bytea language sql immutable as $$ select extensions.digest('ip:203.0.113.' || n, 'sha256') $$;

-- ---------------------------------------------------------------------------
-- closed to the API roles
-- ---------------------------------------------------------------------------
select is((select c.relrowsecurity from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname = 'auth_mail_sends'),
  true, 'auth_mail_sends has RLS on');
select is((select count(*)::int from information_schema.role_table_grants g
    where g.table_schema = 'private' and g.table_name = 'auth_mail_sends' and g.grantee in ('anon', 'authenticated', 'public')), 0,
  'no API role holds a privilege on it');
select is(has_function_privilege('anon', 'private.take_auth_mail(bytea, bytea)', 'execute')
    or has_function_privilege('authenticated', 'private.take_auth_mail(bytea, bytea)', 'execute')
    or has_function_privilege('anon', 'private.auth_mail_window(bytea)', 'execute')
    or has_function_privilege('authenticated', 'private.auth_mail_window(bytea)', 'execute'), false,
  'neither function is executable by a client role');
select is((select bool_or(p.prosecdef) from pg_proc p
    where p.oid in ('private.take_auth_mail(bytea, bytea)'::regprocedure, 'private.auth_mail_window(bytea)'::regprocedure,
                    'private.clear_password_on_first_confirm()'::regprocedure)), false,
  'every function runs as its caller');
select is((select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) from pg_proc p
    where p.oid in ('private.take_auth_mail(bytea, bytea)'::regprocedure, 'private.auth_mail_window(bytea)'::regprocedure,
                    'private.clear_password_on_first_confirm()'::regprocedure)), true,
  'every function pins its search_path');

-- ---------------------------------------------------------------------------
-- the hashes
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.take_auth_mail(null, null) $$, '22023', null, 'a null address hash is refused');
select throws_ok($$ select private.take_auth_mail('\x0102'::bytea, null) $$, '22023', null, 'an address hash that is not 32 bytes is refused');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), '\x0102'::bytea) $$, '22023', null, 'an ip hash that is not 32 bytes is refused');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), pg_temp.a(1)) $$, '22023', null, 'the ip hash may not be the address hash');

-- ---------------------------------------------------------------------------
-- an inbox: 5 an hour, 10 a day
-- ---------------------------------------------------------------------------
select is((select array_agg(private.take_auth_mail(pg_temp.a(1), null)) from generate_series(1, 5)),
  array['ok', 'ok', 'ok', 'ok', 'ok'], 'an inbox gets 5 mails in an hour');
select is(private.take_auth_mail(pg_temp.a(1), null), 'address', 'the 6th in that hour is refused');
select is((select hour_count from private.auth_mail_sends where key_hash = pg_temp.a(1)), 5,
  'a refused mail does not count');
select is(private.take_auth_mail(pg_temp.a(2), null), 'ok', 'another inbox has its own count');
select is((select count(*)::int from private.auth_mail_sends), 2, 'one row per key');

update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(1);
select is((select array_agg(private.take_auth_mail(pg_temp.a(1), null)) from generate_series(1, 5)),
  array['ok', 'ok', 'ok', 'ok', 'ok'], 'the next hour gives 5 more');
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1), null), 'address', 'but 10 in a day is the most, whatever the hour');
update private.auth_mail_sends set hour_start = now() - interval '25 hours', day_start = now() - interval '25 hours'
  where key_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1), null), 'ok', 'a new day starts the count again');
select is((select (hour_count, day_count)::text from private.auth_mail_sends where key_hash = pg_temp.a(1)), '(1,1)',
  'both windows start again from that mail');

-- ---------------------------------------------------------------------------
-- an IP: 20 an hour, 50 a day, across inboxes; both taken together or not at all
-- ---------------------------------------------------------------------------
select is((select array_agg(private.take_auth_mail(pg_temp.a(100 + n), pg_temp.ip(1))) from generate_series(1, 20) n),
  array_fill('ok'::text, array[20]), 'one IP gets 20 mails in an hour, to different inboxes');
select is(private.take_auth_mail(pg_temp.a(200), pg_temp.ip(1)), 'ip', 'the 21st from that IP in the hour is refused');
select is((select hour_count from private.auth_mail_sends where key_hash = pg_temp.a(200)), 0,
  'and its inbox is not charged for it');
select is(private.take_auth_mail(pg_temp.a(200), pg_temp.ip(2)), 'ok', 'another IP has its own count');
select is((select (hour_count, day_count)::text from private.auth_mail_sends where key_hash = pg_temp.ip(1)), '(20,20)',
  'a refused mail does not count against the IP');
select is((select (hour_count, day_count)::text from private.auth_mail_sends where key_hash = pg_temp.a(200)), '(1,1)',
  'a taken mail counts against its inbox once');

update private.auth_mail_sends set hour_start = now() - interval '61 minutes', day_count = 50 where key_hash = pg_temp.ip(1);
select is(private.take_auth_mail(pg_temp.a(300), pg_temp.ip(1)), 'ip', 'and 50 in a day is the most for an IP');
select is(private.take_auth_mail(pg_temp.a(1), pg_temp.ip(3)), 'ok', 'an inbox with room and a fresh IP');
select is((select day_count from private.auth_mail_sends where key_hash = pg_temp.ip(3)), 1, 'counts the IP too');

-- ---------------------------------------------------------------------------
-- old rows go
-- ---------------------------------------------------------------------------
update private.auth_mail_sends set hour_start = now() - interval '3 days', day_start = now() - interval '3 days'
  where key_hash = pg_temp.a(2);
select is(private.take_auth_mail(pg_temp.a(3), null), 'ok', 'a third inbox is mailed');
select is((select count(*)::int from private.auth_mail_sends where key_hash = pg_temp.a(2)), 0,
  'a key whose day ended more than a day ago is dropped by the next mail');

-- ---------------------------------------------------------------------------
-- a first confirmation clears the password the address had
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, encrypted_password, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000004501', 'unconfirmed@example.com', 'hash-chosen-before', null),
  ('00000000-0000-4000-8000-000000004502', 'confirmed@example.com', 'hash-kept', now()),
  ('00000000-0000-4000-8000-000000004503', 'admin-set@example.com', 'hash-old', null);

update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-000000004501';
select is((select encrypted_password from auth.users where id = '00000000-0000-4000-8000-000000004501'), '',
  'the password chosen before the address was confirmed is cleared when it is');

update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-000000004502';
update auth.users set encrypted_password = 'hash-new' where id = '00000000-0000-4000-8000-000000004502';
select is((select encrypted_password from auth.users where id = '00000000-0000-4000-8000-000000004502'), 'hash-new',
  'an address confirmed already keeps its password, and a password set later stays');

update auth.users set email_confirmed_at = now(), encrypted_password = 'hash-set-with-it'
  where id = '00000000-0000-4000-8000-000000004503';
select is((select encrypted_password from auth.users where id = '00000000-0000-4000-8000-000000004503'), 'hash-set-with-it',
  'a password set in the same update as the confirmation is kept');

select * from finish();
rollback;
