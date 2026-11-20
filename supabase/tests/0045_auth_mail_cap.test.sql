-- 0045_auth_mail_cap: the send-email hook's caps, keyed by SHA-256 so they work before the
-- account's row is committed, closed to every API role, taken for every key or none:
--   with no IP: an inbox 5 mails an hour and 10 a day;
--   with an IP: an inbox from one IP 5 and 10, an inbox from all IPs 20 and 30, an IP 20 and 50;
-- and the password a first confirmation clears.
create extension if not exists pgtap with schema extensions;

begin;
select plan(39);

-- an inbox's, a pair's and an IP's hash, as send-email computes them
create function pg_temp.a(n int) returns bytea language sql immutable as $$ select extensions.digest('driver' || n || '@example.com', 'sha256') $$;
create function pg_temp.ip(n int) returns bytea language sql immutable as $$ select extensions.digest('ip:203.0.113.' || n, 'sha256') $$;
create function pg_temp.pair(a int, i int) returns bytea language sql immutable as $$
  select extensions.digest('pair:driver' || a || '@example.com|ip:203.0.113.' || i, 'sha256') $$;
-- one mail for inbox a from IP i
create function pg_temp.take(a int, i int) returns text language sql volatile as $$
  select private.take_auth_mail(pg_temp.a(a), pg_temp.pair(a, i), pg_temp.ip(i)) $$;
create function pg_temp.counts(k bytea) returns text language sql stable as $$
  select (hour_count, day_count)::text from private.auth_mail_sends where key_hash = k $$;

-- ---------------------------------------------------------------------------
-- closed to the API roles
-- ---------------------------------------------------------------------------
select is((select c.relrowsecurity from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname = 'auth_mail_sends'),
  true, 'auth_mail_sends has RLS on');
select is((select count(*)::int from information_schema.role_table_grants g
    where g.table_schema = 'private' and g.table_name = 'auth_mail_sends' and g.grantee in ('anon', 'authenticated', 'public')), 0,
  'no API role holds a privilege on it');
select is(has_function_privilege('anon', 'private.take_auth_mail(bytea, bytea, bytea)', 'execute')
    or has_function_privilege('authenticated', 'private.take_auth_mail(bytea, bytea, bytea)', 'execute')
    or has_function_privilege('anon', 'private.auth_mail_window(bytea)', 'execute')
    or has_function_privilege('authenticated', 'private.auth_mail_window(bytea)', 'execute'), false,
  'neither function is executable by a client role');
select is((select bool_or(p.prosecdef) from pg_proc p
    where p.oid in ('private.take_auth_mail(bytea, bytea, bytea)'::regprocedure, 'private.auth_mail_window(bytea)'::regprocedure,
                    'private.clear_password_on_first_confirm()'::regprocedure)), false,
  'every function runs as its caller');
select is((select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) from pg_proc p
    where p.oid in ('private.take_auth_mail(bytea, bytea, bytea)'::regprocedure, 'private.auth_mail_window(bytea)'::regprocedure,
                    'private.clear_password_on_first_confirm()'::regprocedure)), true,
  'every function pins its search_path');

-- ---------------------------------------------------------------------------
-- the hashes
-- ---------------------------------------------------------------------------
select throws_ok($$ select private.take_auth_mail(null, null, null) $$, '22023', null, 'a null address hash is refused');
select throws_ok($$ select private.take_auth_mail('\x0102'::bytea, null, null) $$, '22023', null, 'an address hash that is not 32 bytes is refused');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), pg_temp.pair(1, 1), null) $$, '22023', null, 'a pair hash needs an ip hash');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), null, pg_temp.ip(1)) $$, '22023', null, 'an ip hash needs a pair hash');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), pg_temp.pair(1, 1), '\x0102'::bytea) $$, '22023', null, 'an ip hash that is not 32 bytes is refused');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), pg_temp.a(1), pg_temp.ip(1)) $$, '22023', null, 'the pair hash may not be the address hash');
select throws_ok($$ select private.take_auth_mail(pg_temp.a(1), pg_temp.ip(1), pg_temp.ip(1)) $$, '22023', null, 'the pair hash may not be the ip hash');
select is((select count(*)::int from private.auth_mail_sends), 0, 'a refused call keeps nothing');

-- ---------------------------------------------------------------------------
-- no IP reported: an inbox gets 5 an hour, 10 a day
-- ---------------------------------------------------------------------------
select is((select array_agg(private.take_auth_mail(pg_temp.a(1), null, null)) from generate_series(1, 5)),
  array['ok', 'ok', 'ok', 'ok', 'ok'], 'an inbox gets 5 mails in an hour');
select is(private.take_auth_mail(pg_temp.a(1), null, null), 'address', 'the 6th in that hour is refused');
select is(pg_temp.counts(pg_temp.a(1)), '(5,5)', 'a refused mail does not count');
select is(private.take_auth_mail(pg_temp.a(2), null, null), 'ok', 'another inbox has its own count');

update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(1);
select is((select array_agg(private.take_auth_mail(pg_temp.a(1), null, null)) from generate_series(1, 5)),
  array['ok', 'ok', 'ok', 'ok', 'ok'], 'the next hour gives 5 more');
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1), null, null), 'address', 'but 10 in a day is the most, whatever the hour');
update private.auth_mail_sends set hour_start = now() - interval '25 hours', day_start = now() - interval '25 hours'
  where key_hash = pg_temp.a(1);
select is(private.take_auth_mail(pg_temp.a(1), null, null), 'ok', 'a new day starts the count again');
select is(pg_temp.counts(pg_temp.a(1)), '(1,1)', 'both windows start again from that mail');

-- ---------------------------------------------------------------------------
-- with an IP: one requester can't use up an inbox
-- ---------------------------------------------------------------------------
select is((select array_agg(pg_temp.take(10, 1)) from generate_series(1, 5)),
  array['ok', 'ok', 'ok', 'ok', 'ok'], 'an inbox gets 5 mails an hour from one IP');
select is(pg_temp.take(10, 1), 'pair', 'the 6th from that IP is refused');
select is(pg_temp.take(10, 2), 'ok', 'while the owner, on another IP, still gets one');
select is((pg_temp.counts(pg_temp.a(10)), pg_temp.counts(pg_temp.ip(1)), pg_temp.counts(pg_temp.pair(10, 1)))::text,
  '("(6,6)","(5,5)","(5,5)")', 'each mail counts once against the inbox, its pair and its IP; a refused one against none');

-- the inbox's own ceiling, 20 an hour from all IPs together
select is((select array_agg(pg_temp.take(10, i)) from generate_series(3, 5) i
           cross join generate_series(1, 5) n where i < 5 or n <= 4), array_fill('ok'::text, array[14]),
  'more IPs bring the inbox to 20 in the hour');
select is(pg_temp.take(10, 6), 'address', 'then the inbox is full for the hour, whatever the IP');
select is(pg_temp.counts(pg_temp.pair(10, 6)), '(0,0)', 'and that refused mail charges its pair nothing');

-- and 30 a day
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(10);
select is((select array_agg(pg_temp.take(10, i)) from generate_series(7, 8) i cross join generate_series(1, 5) n),
  array_fill('ok'::text, array[10]), 'the next hour, the inbox gets 10 more (30 in the day)');
update private.auth_mail_sends set hour_start = now() - interval '61 minutes' where key_hash = pg_temp.a(10);
select is(pg_temp.take(10, 9), 'address', 'but 30 a day is the most for an inbox, whatever the IPs');

-- an IP: 20 an hour and 50 a day across inboxes
select is((select array_agg(pg_temp.take(100 + n, 20)) from generate_series(1, 20) n),
  array_fill('ok'::text, array[20]), 'one IP gets 20 mails in an hour, to different inboxes');
select is(pg_temp.take(200, 20), 'ip', 'the 21st from that IP in the hour is refused');
select is((pg_temp.counts(pg_temp.a(200)), pg_temp.counts(pg_temp.pair(200, 20)))::text, '("(0,0)","(0,0)")',
  'and its inbox and pair are not charged for it');
update private.auth_mail_sends set hour_start = now() - interval '61 minutes', day_count = 50 where key_hash = pg_temp.ip(20);
select is(pg_temp.take(300, 20), 'ip', 'and 50 in a day is the most for an IP');

-- ---------------------------------------------------------------------------
-- old rows go
-- ---------------------------------------------------------------------------
update private.auth_mail_sends set hour_start = now() - interval '3 days', day_start = now() - interval '3 days'
  where key_hash = pg_temp.a(2);
select is(private.take_auth_mail(pg_temp.a(3), null, null), 'ok', 'a third inbox is mailed');
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
