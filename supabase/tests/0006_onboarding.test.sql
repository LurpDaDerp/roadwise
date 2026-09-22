-- 0006_onboarding: driving stages, guardian invites (dark behind feature_flags.guardian_invites),
-- the age policy on trips, the hourly age-band re-derivation on the user's local date, and the
-- under-13 minimisation (profile cleared, devices and consents deleted, OAuth name metadata
-- stripped and kept stripped, every later write refused).
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. dblink is test-only too: the one section that must run as supabase_auth_admin
-- (GoTrue's own role, which postgres cannot SET ROLE to) opens a second and third session over
-- the container's network address with the local passwords. That section commits its three
-- fixture users in those sessions and deletes them again before the main transaction goes on; a
-- run that dies midway leaves them behind, and the next run deletes them first.
--
-- Local stack only (security M-3): the file refuses to run anywhere whose JWT secret is not the
-- local stack's well-known default, before it installs anything, and drops dblink at the end, so a
-- `test db --linked` can neither log in with local passwords nor leave dblink behind.
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0006_onboarding.test.sql runs only against the local Supabase stack';
  end if;
  create extension if not exists dblink with schema extensions;
end $$;

begin;
select plan(166);

-- ---------------------------------------------------------------------------
-- 1. supabase_auth_admin: an OAuth sign-in (GoTrue's UPDATE of raw_user_meta_data and
--    identity_data, run as GoTrue's role with no JWT) succeeds for everyone and leaves an adult
--    untouched; a blocked child's name is stripped again. Runs first, before this transaction
--    takes any lock the other sessions could wait on.
-- ---------------------------------------------------------------------------
select extensions.dblink_connect('rw_pg', 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
  || ' dbname=' || current_database() || ' user=postgres password=postgres');
select extensions.dblink_connect('rw_auth', 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
  || ' dbname=' || current_database() || ' user=supabase_auth_admin password=postgres');

select extensions.dblink_exec('rw_pg', $q$delete from auth.users where id in
  ('a1a1a1a1-0000-4000-8000-0000000000f1', 'a1a1a1a1-0000-4000-8000-0000000000f2', 'a1a1a1a1-0000-4000-8000-0000000000f3')$q$);
select extensions.dblink_exec('rw_pg', $q$insert into auth.users (id, email, raw_user_meta_data) values
  ('a1a1a1a1-0000-4000-8000-0000000000f1', 'xa@example.com', '{"full_name":"Xavier Adult","name":"Xavier","avatar_url":"https://example.com/x.png","email":"xa@example.com","sub":"g-xa"}'),
  ('a1a1a1a1-0000-4000-8000-0000000000f2', 'yc@example.com', '{"full_name":"Yara Child","name":"Yara","avatar_url":"https://example.com/y.png","email":"yc@example.com","sub":"g-yc"}')$q$);
select extensions.dblink_exec('rw_pg', $q$insert into auth.identities (provider_id, user_id, identity_data, provider) values
  ('g-xa', 'a1a1a1a1-0000-4000-8000-0000000000f1', '{"sub":"g-xa","email":"xa@example.com","full_name":"Xavier Adult","name":"Xavier","picture":"https://example.com/x.png"}', 'google'),
  ('g-yc', 'a1a1a1a1-0000-4000-8000-0000000000f2', '{"sub":"g-yc","email":"yc@example.com","full_name":"Yara Child","name":"Yara","picture":"https://example.com/y.png"}', 'google')$q$);
select extensions.dblink_exec('rw_pg', $q$update public.private_profiles set birth_date = (now() at time zone 'UTC')::date - interval '30 years'
  where user_id = 'a1a1a1a1-0000-4000-8000-0000000000f1'$q$);
select extensions.dblink_exec('rw_pg', $q$update public.private_profiles set birth_date = (now() at time zone 'UTC')::date - interval '10 years'
  where user_id = 'a1a1a1a1-0000-4000-8000-0000000000f2'$q$);

select is((select cu from extensions.dblink('rw_auth', 'select current_user::text, coalesce(current_setting(''request.jwt.claims'', true), '''')') as t(cu text, claims text)
    where claims = ''), 'supabase_auth_admin', 'the sign-in session is supabase_auth_admin with no JWT');

-- the adult signs in again: GoTrue rewrites the metadata and the identity
select is(extensions.dblink_exec('rw_auth', $q$update auth.users set raw_user_meta_data = '{"full_name":"Xavier Q. Adult","name":"Xavier","avatar_url":"https://example.com/x2.png","picture":"https://example.com/x2.png","preferred_username":"xq","email":"xa@example.com","sub":"g-xa","iss":"https://accounts.google.com"}', last_sign_in_at = now()
  where id = 'a1a1a1a1-0000-4000-8000-0000000000f1'$q$), 'UPDATE 1', 'an adult OAuth sign-in (user metadata) succeeds as supabase_auth_admin');
select is(extensions.dblink_exec('rw_auth', $q$update auth.identities set identity_data = '{"sub":"g-xa","email":"xa@example.com","full_name":"Xavier Q. Adult","name":"Xavier","given_name":"Xavier","family_name":"Adult","picture":"https://example.com/x2.png"}', last_sign_in_at = now()
  where provider_id = 'g-xa' and provider = 'google'$q$), 'UPDATE 1', 'and its identity update succeeds too');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select raw_user_meta_data::text from auth.users where id = 'a1a1a1a1-0000-4000-8000-0000000000f1'$q$) as t(v text)),
  '{"full_name":"Xavier Q. Adult","name":"Xavier","avatar_url":"https://example.com/x2.png","picture":"https://example.com/x2.png","preferred_username":"xq","email":"xa@example.com","sub":"g-xa","iss":"https://accounts.google.com"}'::jsonb,
  'the adult''s metadata is exactly what GoTrue wrote');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select identity_data::text from auth.identities where provider_id = 'g-xa'$q$) as t(v text)),
  '{"sub":"g-xa","email":"xa@example.com","full_name":"Xavier Q. Adult","name":"Xavier","given_name":"Xavier","family_name":"Adult","picture":"https://example.com/x2.png"}'::jsonb,
  'the adult''s identity is exactly what GoTrue wrote');

-- the blocked child signs in: the sign-in succeeds and the name is gone again
select is(extensions.dblink_exec('rw_auth', $q$update auth.users set raw_user_meta_data = '{"full_name":"Yara Child","name":"Yara","avatar_url":"https://example.com/y.png","picture":"https://example.com/y.png","preferred_username":"yara_c","nickname":"Yaya","custom_claims":{"hd":"school.example.edu"},"email":"yc@example.com","email_verified":true,"sub":"g-yc","iss":"https://accounts.google.com"}', last_sign_in_at = now()
  where id = 'a1a1a1a1-0000-4000-8000-0000000000f2'$q$), 'UPDATE 1', 'a blocked child''s OAuth sign-in succeeds as supabase_auth_admin');
select is(extensions.dblink_exec('rw_auth', $q$update auth.identities set identity_data = '{"sub":"g-yc","email":"yc@example.com","full_name":"Yara Child","name":"Yara","user_name":"yarac","picture":"https://example.com/y.png"}'
  where provider_id = 'g-yc' and provider = 'google'$q$), 'UPDATE 1', 'and its identity update succeeds');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select raw_user_meta_data::text from auth.users where id = 'a1a1a1a1-0000-4000-8000-0000000000f2'$q$) as t(v text)),
  '{"email":"yc@example.com","email_verified":true,"sub":"g-yc","iss":"https://accounts.google.com"}'::jsonb,
  'the child''s refreshed metadata keeps only the allowlisted keys (no username, nickname or custom claims)');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select identity_data::text from auth.identities where provider_id = 'g-yc'$q$) as t(v text)),
  '{"sub":"g-yc","email":"yc@example.com"}'::jsonb, 'and so is the refreshed identity');
-- linking a second provider inserts an identity carrying the name
select is(extensions.dblink_exec('rw_auth', $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
  values ('a-yc', 'a1a1a1a1-0000-4000-8000-0000000000f2', '{"sub":"a-yc","email":"yc@example.com","name":"Yara Child"}', 'apple')$q$), 'INSERT 0 1',
  'a child linking another provider succeeds');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select identity_data::text from auth.identities where provider_id = 'a-yc'$q$) as t(v text)),
  '{"sub":"a-yc","email":"yc@example.com"}'::jsonb, 'and the new identity is stripped');

-- a brand-new OAuth sign-up, as GoTrue performs it
select is(extensions.dblink_exec('rw_auth', $q$insert into auth.users (id, email, raw_user_meta_data)
  values ('a1a1a1a1-0000-4000-8000-0000000000f3', 'zn@example.com', '{"full_name":"Zed New","name":"Zed","email":"zn@example.com","sub":"g-zn"}')$q$), 'INSERT 0 1',
  'a new OAuth sign-up succeeds as supabase_auth_admin');
select is(extensions.dblink_exec('rw_auth', $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
  values ('g-zn', 'a1a1a1a1-0000-4000-8000-0000000000f3', '{"sub":"g-zn","email":"zn@example.com","full_name":"Zed New","name":"Zed"}', 'google')$q$), 'INSERT 0 1',
  'and its identity insert succeeds');
select is((select v::jsonb from extensions.dblink('rw_pg', $q$select identity_data::text from auth.identities where provider_id = 'g-zn'$q$) as t(v text)),
  '{"sub":"g-zn","email":"zn@example.com","full_name":"Zed New","name":"Zed"}'::jsonb, 'a user of unknown age keeps the name');

select extensions.dblink_exec('rw_pg', $q$delete from auth.users where id in
  ('a1a1a1a1-0000-4000-8000-0000000000f1', 'a1a1a1a1-0000-4000-8000-0000000000f2', 'a1a1a1a1-0000-4000-8000-0000000000f3')$q$);
select is((select n from extensions.dblink('rw_pg', $q$select count(*)::int from auth.users where id::text like 'a1a1a1a1-0000-4000-8000-0000000000f_'$q$) as t(n int)), 0,
  'the committed sign-in fixtures are gone again');
select extensions.dblink_disconnect('rw_auth');
select extensions.dblink_disconnect('rw_pg');

-- ---------------------------------------------------------------------------
-- fixtures (as the migration owner, with no JWT)
--   A adult, T teen (16), B adult, U becomes u13, K 12 y 364 d, S 17 y 364 d, N never gives a
--   birth date; L1/M1 drive in Pacific/Kiritimati (UTC+14), L2/M2 in Pacific/Pago_Pago (UTC-11):
--   25 hours apart, so their local dates always differ.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'a6@example.com', '{"display_name":"Ada"}'),
  ('a1a1a1a1-0000-4000-8000-000000000002', 't6@example.com', '{"display_name":"Tia"}'),
  ('a1a1a1a1-0000-4000-8000-000000000003', 'b6@example.com', '{"display_name":"Bo"}'),
  ('a1a1a1a1-0000-4000-8000-000000000004', 'u6@example.com',
    '{"display_name":"Uma","full_name":"Uma Child","name":"Uma","nickname":"Umi","avatar_url":"https://example.com/u.png","picture":"https://example.com/u.png","given_name":"Uma","family_name":"Child","email":"u6@example.com","sub":"g-u6"}'),
  ('a1a1a1a1-0000-4000-8000-000000000005', 'k6@example.com', '{"display_name":"Kai"}'),
  ('a1a1a1a1-0000-4000-8000-000000000006', 's6@example.com', '{"display_name":"Sam"}'),
  ('a1a1a1a1-0000-4000-8000-000000000007', 'n6@example.com', '{"display_name":"Nia"}'),
  ('a1a1a1a1-0000-4000-8000-000000000008', 'l16@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-000000000009', 'l26@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-00000000000a', 'm16@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-00000000000b', 'm26@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-00000000000c', 'r6@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-00000000000d', 'w6@example.com', '{}'),
  ('a1a1a1a1-0000-4000-8000-00000000000e', 'x6@example.com', '{}');
insert into auth.identities (provider_id, user_id, identity_data, provider) values
  ('g-u6', 'a1a1a1a1-0000-4000-8000-000000000004',
    '{"sub":"g-u6","email":"u6@example.com","full_name":"Uma Child","name":"Uma","avatar_url":"https://example.com/u.png","picture":"https://example.com/u.png"}', 'google');

create temp table d as select (now() at time zone 'UTC')::date as utc, (now() at time zone 'Pacific/Kiritimati')::date as kir;
update public.private_profiles set birth_date = (select utc from d) - interval '30 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000001';
update public.private_profiles set birth_date = (select utc from d) - interval '16 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
update public.private_profiles set birth_date = (select utc from d) - interval '40 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000003';
update public.private_profiles set birth_date = ((select utc from d) - interval '13 years')::date + 1 where user_id = 'a1a1a1a1-0000-4000-8000-000000000005';
update public.private_profiles set birth_date = ((select utc from d) - interval '18 years')::date + 1 where user_id = 'a1a1a1a1-0000-4000-8000-000000000006';
-- a drive is accepted only once the age question is answered, so section 8's drivers start as
-- adults; their real birth dates are written after their drives exist
update public.private_profiles set birth_date = date '1990-01-01' where user_id in ('a1a1a1a1-0000-4000-8000-000000000008', 'a1a1a1a1-0000-4000-8000-000000000009',
  'a1a1a1a1-0000-4000-8000-00000000000a', 'a1a1a1a1-0000-4000-8000-00000000000b', 'a1a1a1a1-0000-4000-8000-00000000000c');

-- U's footprint before the block: a phone, a consent and a stored object under U's prefix; A's object for contrast
insert into public.devices (id, user_id, platform) values ('u-phone', 'a1a1a1a1-0000-4000-8000-000000000004', 'android');
insert into public.consents (user_id, type, version) values ('a1a1a1a1-0000-4000-8000-000000000004', 'tos', '2026-09-21');
insert into storage.objects (bucket_id, name, owner_id) values
  ('traces', 'a1a1a1a1-0000-4000-8000-000000000004/u-trip.bin.gz', 'a1a1a1a1-0000-4000-8000-000000000004'),
  ('traces', 'a1a1a1a1-0000-4000-8000-000000000001/a-trip.bin.gz', 'a1a1a1a1-0000-4000-8000-000000000001');

-- apply_trip envelopes, shaped like 0002's test fixtures (FinalizeTripPayload at HEAD)
create function pg_temp.at_la(p_days_ago int, p_hour int) returns timestamptz
language sql as $$ select (((now() at time zone 'America/Los_Angeles')::date - p_days_ago)::timestamp + make_interval(hours => p_hour)) at time zone 'America/Los_Angeles' $$;
create function pg_temp.envelope(p_user uuid, p_client text, p_hour int, p_events int default 0) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from pg_temp.at_la(2, p_hour)) * 1000)::bigint,
      'endedAt', floor(extract(epoch from pg_temp.at_la(2, p_hour) + interval '15 minutes') * 1000)::bigint,
      'tz', 'America/Los_Angeles', 'distanceM', 12500.5, 'durationS', 900,
      'role', 'driver', 'roleConfidence', null, 'roleSource', 'manual', 'mode', 'mounted', 'cameraSession', false,
      'events', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', 'ev-' || i, 'category', 'speeding', 'startedAt', floor(extract(epoch from pg_temp.at_la(2, p_hour)) * 1000)::bigint + i * 10000,
          'durationS', 8.5, 'durationMs', 8500, 'q', 0.9, 'corrected', false, 'status', 'scored',
          'measured', jsonb_build_object('speedMps', 21.0, 'limitMps', 15.6, 'overMps', 5.4),
          'context', jsonb_build_object('night', false, 'precipitation', false),
          'contextMultiplier', 1, 'severity', 1, 'deduction', 2,
          'lat', 47.606, 'lng', -122.332, 'alertShown', true, 'source', 'gnss') order by i), '[]'::jsonb)
        from generate_series(1, p_events) i),
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true, 'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb', 'polyline', '_p~iF~ps|U', 'tracePath', null,
      'hadSevereEvent', false, 'incomplete', false),
    'scored', jsonb_build_object('score', 80, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":20,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', (select coalesce(jsonb_object_agg('ev-' || i, 2), '{}'::jsonb) from generate_series(1, p_events) i), 'scoringVersion', 1),
    'day', jsonb_build_object('day', (pg_temp.at_la(2, p_hour) at time zone 'America/Los_Angeles')::date,
      'longTermScore', 80, 'band', 'good', 'provisional', false, 'safeDay', false, 'goodDay', true, 'phoneFreeDay', true,
      'cameraDay', false, 'exposure', 1.25, 'drivingS', 900, 'tripsScored', 1, 'severeEvents', 0),
    'baselines', jsonb_build_object('medians', '{"speeding": 1.2}'::jsonb))
$$;
create temp table fx (name text primary key, p jsonb not null);
insert into fx values
  ('u', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000004', 'u-trip-1', 9)),
  ('t-pending', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000002', 't-trip-1', 9)),
  ('t-linked', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000002', 't-trip-2', 10, 1)),
  ('t-after', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000002', 't-trip-4', 12)),
  ('t-optional', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000002', 't-trip-3', 11)),
  ('n', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000007', 'n-trip-1', 9)),
  ('a', pg_temp.envelope('a1a1a1a1-0000-4000-8000-000000000001', 'a-trip-1', 9));
grant select on fx to service_role;

-- results an authenticated caller hands back to the assertions
create temp table res (k text primary key, v jsonb);
grant select, insert on res to authenticated;

-- ---------------------------------------------------------------------------
-- 2. structure: driving stages, invites, functions, triggers, grants, catch-alls
-- ---------------------------------------------------------------------------
select lives_ok($$ update public.profiles set driving_stage = 'unknown' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts unknown');
select lives_ok($$ update public.profiles set driving_stage = 'permit' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts permit');
select lives_ok($$ update public.profiles set driving_stage = 'new' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts new');
select lives_ok($$ update public.profiles set driving_stage = 'developing' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts developing');
select lives_ok($$ update public.profiles set driving_stage = 'experienced' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts experienced');
select lives_ok($$ update public.profiles set driving_stage = 'non_driver' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, 'driving_stage accepts non_driver');
select throws_ok($$ update public.profiles set driving_stage = 'bogus' where id = 'a1a1a1a1-0000-4000-8000-000000000001' $$, '23514', null, 'driving_stage refuses anything else');
select is((select count(*)::int from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%driving_stage%'), 1,
  'exactly one CHECK governs driving_stage');

select has_table('public', 'invites', 'invites exists');
select columns_are('public', 'invites', array['id', 'code_hash', 'type', 'issuer_id', 'family_id', 'role', 'expires_at', 'max_uses', 'uses', 'revoked', 'created_at', 'updated_at']::name[],
  'invites has exactly its columns');
select is((select relrowsecurity from pg_class where oid = 'public.invites'::regclass), true, 'RLS is enabled on invites');
select policies_are('public', 'invites', '{}'::name[], 'invites has no policies (server only)');
select table_privs_are('public', 'invites', 'anon', '{}'::name[], 'anon has no privileges on invites');
select table_privs_are('public', 'invites', 'authenticated', '{}'::name[], 'authenticated has no privileges on invites');
select col_is_pk('public', 'invites', 'id', 'invites is keyed by id');
select col_default_is('public', 'invites', 'id', 'gen_random_uuid()', 'the id is a random uuid');
select col_is_unique('public', 'invites', 'code_hash', 'code_hash is unique');
select has_index('public', 'invites', 'invites_issuer_type_created_idx', 'invites is indexed by (issuer_id, type, created_at desc)');
select has_trigger('public', 'invites', 'invites_touch', 'invites.updated_at is maintained');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, expires_at) values (extensions.digest('x', 'md5'), 'guardian', 'a1a1a1a1-0000-4000-8000-000000000002', now()) $$,
  '23514', null, 'a code hash that is not 32 bytes is refused');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, expires_at) values (extensions.digest('x', 'sha256'), 'bogus', 'a1a1a1a1-0000-4000-8000-000000000002', now()) $$,
  '23514', null, 'an unknown invite type is refused');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, role, expires_at) values (extensions.digest('x', 'sha256'), 'guardian', 'a1a1a1a1-0000-4000-8000-000000000002', 'boss', now()) $$,
  '23514', null, 'an unknown role is refused');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, expires_at, max_uses) values (extensions.digest('x', 'sha256'), 'guardian', 'a1a1a1a1-0000-4000-8000-000000000002', now(), 101) $$,
  '23514', null, 'max_uses above 100 is refused');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, expires_at, max_uses, uses) values (extensions.digest('x', 'sha256'), 'guardian', 'a1a1a1a1-0000-4000-8000-000000000002', now(), 1, 2) $$,
  '23514', null, 'uses above max_uses is refused');

-- definer hygiene: the two RPCs and the three definer triggers
select is((select count(*)::int from pg_proc p where p.oid in (
    'public.create_guardian_invite()'::regprocedure, 'public.guardian_link_state()'::regprocedure,
    'public.minimise_underage_account()'::regprocedure, 'public.rescrub_underage_metadata()'::regprocedure,
    'public.rescrub_underage_identity()'::regprocedure)
  and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public']), 5,
  'the two RPCs and three definer triggers are security definer, owned by postgres, pinning exactly search_path=public');
select is((select count(*)::int from pg_proc p where p.oid in (
    'public.is_underage(uuid)'::regprocedure, 'public.refuse_underage_writes()'::regprocedure,
    'public.enforce_trip_age_policy()'::regprocedure, 'public.rederive_age_bands()'::regprocedure,
    'public.underage_object_keys(integer)'::regprocedure, 'public.user_local_date(uuid, timestamptz)'::regprocedure,
    'public.derive_age_band_on(date, date)'::regprocedure, 'public.sync_age_band()'::regprocedure,
    'public.age_band_rank(text)'::regprocedure, 'public.underage_identity_keys(jsonb)'::regprocedure)
  and not p.prosecdef and p.proconfig = array['search_path=public']), 10,
  'every other function this migration creates or replaces is security invoker pinning exactly search_path=public');
select is(array[has_function_privilege('authenticated', 'public.create_guardian_invite()', 'execute'),
                has_function_privilege('authenticated', 'public.guardian_link_state()', 'execute'),
                has_function_privilege('authenticated', 'public.is_underage(uuid)', 'execute'),
                has_function_privilege('service_role', 'public.underage_object_keys(integer)', 'execute')],
  array[true, true, true, true], 'the client RPCs and the helper are executable by authenticated; underage_object_keys by service_role');
select is((select bool_or(has_function_privilege('anon', f, 'execute')) from unnest(array[
    'public.create_guardian_invite()', 'public.guardian_link_state()', 'public.is_underage(uuid)', 'public.underage_object_keys(integer)',
    'public.rederive_age_bands()', 'public.refuse_underage_writes()', 'public.enforce_trip_age_policy()', 'public.minimise_underage_account()',
    'public.rescrub_underage_metadata()', 'public.rescrub_underage_identity()', 'public.user_local_date(uuid, timestamptz)', 'public.derive_age_band_on(date, date)',
    'public.age_band_rank(text)', 'public.underage_identity_keys(jsonb)']) f),
  false, 'anon executes nothing this migration creates');
select is((select bool_or(has_function_privilege('authenticated', f, 'execute')) from unnest(array[
    'public.underage_object_keys(integer)', 'public.rederive_age_bands()', 'public.refuse_underage_writes()', 'public.enforce_trip_age_policy()',
    'public.minimise_underage_account()', 'public.rescrub_underage_metadata()', 'public.rescrub_underage_identity()',
    'public.user_local_date(uuid, timestamptz)', 'public.derive_age_band_on(date, date)', 'public.age_band_rank(text)', 'public.underage_identity_keys(jsonb)']) f),
  false, 'authenticated executes no writer, trigger or date helper');
select is(has_function_privilege('authenticated', 'public.derive_age_band(date)', 'execute'), false,
  '0001''s UTC derive_age_band is no longer client-callable (m2)');
select is(array[has_function_privilege('service_role', 'public.rederive_age_bands()', 'execute'),
                has_function_privilege('service_role', 'public.create_guardian_invite()', 'execute')],
  array[false, false], 'service_role cannot run the re-derivation or issue invites');

select has_trigger('public', 'devices', 'devices_refuse_underage', 'devices refuse an under-13 account');
select has_trigger('public', 'consents', 'consents_refuse_underage', 'consents refuse an under-13 account');
select has_trigger('public', 'profiles', 'profiles_refuse_underage', 'a blocked profile is read-only for the client');
select has_trigger('public', 'profiles', 'profiles_minimise_underage', 'a new u13 band minimises the account');
select has_trigger('public', 'trips', 'trips_age_policy', 'trips enforce the age policy');
select is((select count(*)::int from pg_trigger t where not t.tgisinternal and t.tgfoid = 'public.refuse_underage_writes()'::regprocedure
    and (t.tgrelid::regclass::text, t.tgname::text) in (('trips', 'trips_refuse_underage'), ('trip_events', 'trip_events_refuse_underage'),
      ('event_disputes', 'event_disputes_refuse_underage'), ('score_daily', 'score_daily_refuse_underage'), ('baselines', 'baselines_refuse_underage'))), 5,
  'every drive table refuses an under-13 account''s writes');
select has_index('public', 'private_profiles', 'private_profiles_birth_date_idx', 'the hourly pass reads birth dates through an index');
select throws_ok($$ insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason)
    values ('a1a1a1a1-0000-4000-8000-000000000001', 'offset-tz', now(), now(), '+23:59', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short') $$,
  '23514', null, 'a fixed-offset tz such as +23:59 is refused on every write path (M-4)');
select has_trigger('auth', 'users', 'rescrub_underage_metadata', 'auth.users re-strips a blocked child''s name');
select has_trigger('auth', 'identities', 'rescrub_underage_identity', 'auth.identities re-strips it too');
select policies_are('storage', 'objects', array['traces_insert_own', 'traces_select_own', 'traces_delete_own', 'storage_refuse_underage']::name[],
  'storage.objects has the three traces policies and the under-13 refusal');
select is((select row(polpermissive, polcmd, polroles = array['authenticated'::regrole::oid])::text from pg_policy
    where polrelid = 'storage.objects'::regclass and polname = 'storage_refuse_underage'), row(false, 'a', true)::text,
  'storage_refuse_underage is a restrictive insert policy for authenticated');

select is((select row(schedule, command, username)::text from cron.job where jobname = 'age-band-rederive'),
  row('15 * * * *', 'select public.rederive_age_bands()', 'postgres')::text, 'pg_cron runs the re-derivation hourly at minute 15 as postgres');

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe6 (id int);
create function public.zz_probe6_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe6', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe6_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe6_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe6_fn();
drop table public.zz_probe6;

-- ---------------------------------------------------------------------------
-- 3. config rows
-- ---------------------------------------------------------------------------
select is((select count(*)::int from supabase_migrations.schema_migrations
    where version = '0006' and array_to_string(statements, ' ') like '%minor_consent_mode%oem_battery_guides%on conflict (key) do nothing%'), 1,
  'migration 0006 inserts its config rows with on conflict do nothing');
select is((select row(value, is_public)::text from public.app_config where key = 'minor_consent_mode'), row('"guardian_link_optional"'::jsonb, true)::text,
  'minor_consent_mode is the public string guardian_link_optional');
select is((select row(value, is_public)::text from public.app_config where key = 'onboarding'),
  row('{"tos_version":"2026-09-21","privacy_version":"2026-09-21"}'::jsonb, true)::text, 'onboarding carries both document versions');
select is((select row(value, is_public)::text from public.app_config where key = 'legal_urls'), row('{}'::jsonb, true)::text, 'legal_urls is an empty public object');
select is((select row(value, is_public)::text from public.app_config where key = 'store_urls'), row('{}'::jsonb, true)::text, 'store_urls is an empty public object');
select is((select array_agg(k order by k) from public.app_config, jsonb_object_keys(value) k where key = 'oem_battery_guides'),
  array['default', 'google', 'oneplus', 'samsung', 'xiaomi'], 'oem_battery_guides has the five guides');
select is((select bool_and(jsonb_typeof(g->'title') = 'string' and jsonb_typeof(g->'steps') = 'array'
      and jsonb_array_length(g->'steps') between 1 and 8
      and (select bool_and(jsonb_typeof(s) = 'string') from jsonb_array_elements(g->'steps') s))
    from public.app_config, jsonb_each(value) e(k, g) where key = 'oem_battery_guides' and is_public), true,
  'each guide is a public { title, steps } with one to eight string steps');
select is((select row(value, is_public)::text from public.app_config where key = 'min_app_version'), row('"2.0.0"'::jsonb, true)::text, 'min_app_version is still "2.0.0"');
select is((select value -> 'guardian_invites' from public.app_config where key = 'feature_flags'), 'false'::jsonb, 'feature_flags.guardian_invites is false');
-- the row as it is stored once 0005 and 0006 have both applied: exactly the app's CONFIG_DEFAULTS.flags
-- (src/data/config/appConfig.ts), so a fresh database and a first launch with no config agree
select is((select value from public.app_config where key = 'feature_flags'),
  '{"auto_detect": true, "camera_beta": false, "referral": false, "guardian_invites": false}'::jsonb,
  'the effective feature_flags row is exactly CONFIG_DEFAULTS.flags: only auto_detect on');
-- an operator's value survives the migration's merge
update public.app_config set value = value || '{"guardian_invites": true}' where key = 'feature_flags';
update public.app_config set value = value || '{"guardian_invites": false}' where key = 'feature_flags' and not value ? 'guardian_invites';
select is((select value -> 'guardian_invites' from public.app_config where key = 'feature_flags'), 'true'::jsonb, 'the merge never overwrites an operator''s guardian_invites');
update public.app_config set value = value || '{"guardian_invites": false}' where key = 'feature_flags';

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.app_config where key in ('minor_consent_mode', 'onboarding', 'legal_urls', 'store_urls', 'oem_battery_guides')), 5,
  'anon reads the five new rows');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 4. guardian invites
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.create_guardian_invite() $$, '42501', 'create_guardian_invite requires an authenticated user', 'no JWT, no invite');
select throws_ok($$ select public.guardian_link_state() $$, '42501', 'guardian_link_state requires an authenticated user', 'no JWT, no link state');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.create_guardian_invite() $$, '42501', null, 'anon cannot issue an invite');
select throws_ok($$ select * from public.invites $$, '42501', null, 'anon cannot read invites');
reset role;

-- dark while the flag is off
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000002"}', true);
select throws_ok($$ select public.create_guardian_invite() $$, '42501', 'guardian invites are not available yet', 'with the flag off a teen gets no invite');
select is(public.guardian_link_state(), '{"status":"none","expires_at":null}'::jsonb, 'and the link state is none');
reset role;
select set_config('request.jwt.claims', '', true);
update public.app_config set value = value || '{"guardian_invites": true}' where key = 'feature_flags';

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.create_guardian_invite() $$, '42501', 'guardian invites are for drivers under 18', 'an adult gets no guardian invite');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000007"}', true);
select throws_ok($$ select public.create_guardian_invite() $$, '42501', 'guardian invites are for drivers under 18', 'nor does a user of unknown age');

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000002"}', true);
insert into res values ('first', public.create_guardian_invite());
insert into res values ('state1', public.guardian_link_state());
insert into res values ('second', public.create_guardian_invite());
select throws_ok($$ select * from public.invites $$, '42501', null, 'the teen cannot read invites');
select throws_ok($$ insert into public.invites (code_hash, type, issuer_id, expires_at) values (extensions.digest('mine', 'sha256'), 'guardian', 'a1a1a1a1-0000-4000-8000-000000000002', now() + interval '1 year') $$,
  '42501', null, 'the teen cannot insert an invite');
select throws_ok($$ update public.invites set uses = 0 $$, '42501', null, 'the teen cannot update invites');
select throws_ok($$ delete from public.invites $$, '42501', null, 'the teen cannot delete invites');
reset role;
select set_config('request.jwt.claims', '', true);

select matches((select v->>'code' from res where k = 'first'), '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'the code is six characters from the unambiguous alphabet');
select is((select (v->>'expires_at')::timestamptz from res where k = 'first'), now() + interval '7 days', 'it expires in seven days');
select is((select row(i.type, i.role, i.max_uses, i.uses, octet_length(i.code_hash), i.expires_at = now() + interval '7 days', i.family_id is null)::text
    from public.invites i, res r where r.k = 'first' and i.code_hash = extensions.digest(r.v->>'code', 'sha256')),
  row('guardian', 'guardian', 1, 0, 32, true, true)::text, 'the stored row holds only sha256(code): a single-use guardian invite');
select is((select count(*)::int from public.invites where encode(code_hash, 'escape') like '%' || (select v->>'code' from res where k = 'first') || '%'), 0,
  'the plain code is stored nowhere');
select is((select guardian_link_status from public.private_profiles where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), 'pending', 'the teen''s link is pending');
select is((select v from res where k = 'state1'), jsonb_build_object('status', 'pending', 'expires_at', now() + interval '7 days'), 'guardian_link_state reports pending with its expiry');
select is((select array_agg(i.revoked order by r.k) from public.invites i join res r on i.code_hash = extensions.digest(r.v->>'code', 'sha256') where r.k in ('first', 'second')),
  array[true, false], 'a second invite revokes the first');
select is((select count(*)::int from public.invites where issuer_id = 'a1a1a1a1-0000-4000-8000-000000000002' and not revoked), 1, 'the teen has exactly one live invite');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000002"}', true);
select lives_ok($$ select public.create_guardian_invite() from generate_series(3, 10) $$, 'invites three to ten inside 24 hours are issued');
select throws_ok($$ select public.create_guardian_invite() $$, '42501', 'invite limit reached', 'the eleventh inside 24 hours is refused');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.invites where issuer_id = 'a1a1a1a1-0000-4000-8000-000000000002'), 10, 'ten invites exist, nine of them revoked');
select is((select row(count, window_start)::text from public.rate_limits where user_id = 'a1a1a1a1-0000-4000-8000-000000000002' and key = 'invite_day'),
  row(10, now())::text, 'the invite_day row holds the true rolling count and the oldest issue time in the window (m3)');

-- expiry
update public.invites set expires_at = now() - interval '1 minute' where issuer_id = 'a1a1a1a1-0000-4000-8000-000000000002' and not revoked;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000002"}', true);
select is(public.guardian_link_state() ->> 'status', 'expired', 'a pending link whose live invite has passed its expiry reads expired');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000003"}', true);
select is(public.guardian_link_state(), '{"status":"none","expires_at":null}'::jsonb, 'B sees only B''s own state');
reset role;
select set_config('request.jwt.claims', '', true);

-- linked
update public.private_profiles set guardian_link_status = 'linked' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000002"}', true);
select throws_ok($$ select public.create_guardian_invite() $$, '22023', 'guardian already linked', 'a linked teen gets no new invite');
select is(public.guardian_link_state(), '{"status":"linked","expires_at":null}'::jsonb, 'and reads linked');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 5. minor consent mode on the trip writer (apply_trip, as the service role)
-- ---------------------------------------------------------------------------
update public.private_profiles set guardian_link_status = 'pending' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
update public.app_config set value = '"guardian_consent_required"' where key = 'minor_consent_mode';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.apply_trip((select p from fx where name = 't-pending')) $$, '42501', 'guardian consent required',
  'consent required: a teen whose link is pending cannot upload');
select throws_ok($$ select public.apply_trip((select p from fx where name = 'n')) $$, '55000', 'age not confirmed yet',
  'a user of unknown age is refused as retryable (55000), not as a permanent 403');
select lives_ok($$ select public.apply_trip((select p from fx where name = 'a')) $$, 'an adult can');
reset role;
update public.private_profiles set guardian_link_status = 'linked' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
set local role service_role;
select lives_ok($$ select public.apply_trip((select p from fx where name = 't-linked')) $$, 'and so can a linked teen');
reset role;
update public.private_profiles set guardian_link_status = 'pending' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
update public.app_config set value = '"guardian_link_optional"' where key = 'minor_consent_mode';
set local role service_role;
select lives_ok($$ select public.apply_trip((select p from fx where name = 't-optional')) $$, 'consent optional: a pending teen uploads');
select throws_ok($$ select public.apply_trip((select p from fx where name = 'n')) $$, '55000', 'age not confirmed yet',
  'consent optional: a user of unknown age still waits, retryably, for the age answer');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.trips where user_id in ('a1a1a1a1-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000002')), 3,
  'exactly the three allowed drives were stored');

-- ---------------------------------------------------------------------------
-- 6. under 13: U gives a birth date ten years ago
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000004"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'U records a birth date ten years ago');
reset role;
select set_config('request.jwt.claims', '', true);

select is((select row(age_band, display_name, avatar_path, flags, driving_stage)::text from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000004'),
  row('u13', '', null::text, '{}'::jsonb, 'unknown')::text, 'the profile is cleared to the band alone');
select is((select count(*)::int from public.devices where user_id = 'a1a1a1a1-0000-4000-8000-000000000004'), 0, 'U''s devices are deleted');
select is((select count(*)::int from public.consents where user_id = 'a1a1a1a1-0000-4000-8000-000000000004'), 0, 'U''s consents are deleted');
select is((select raw_user_meta_data from auth.users where id = 'a1a1a1a1-0000-4000-8000-000000000004'),
  '{"email":"u6@example.com","sub":"g-u6"}'::jsonb, 'the auth metadata keeps only allowlisted keys: no name, nickname, display name or picture');
select is((select identity_data from auth.identities where user_id = 'a1a1a1a1-0000-4000-8000-000000000004'),
  '{"sub":"g-u6","email":"u6@example.com"}'::jsonb, 'nor does the identity');
select is((select row(u.email, pp.birth_date is not null)::text from auth.users u join public.private_profiles pp on pp.user_id = u.id
    where u.id = 'a1a1a1a1-0000-4000-8000-000000000004'), row('u6@example.com', true)::text, 'the login and the birth date remain');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000004"}', true);
select throws_ok($$ update public.profiles set display_name = 'Uma' where id = 'a1a1a1a1-0000-4000-8000-000000000004' $$, '42501', 'account not eligible',
  'U cannot write the profile');
select throws_ok($$ insert into public.devices (id, user_id, platform) values ('u-phone-2', 'a1a1a1a1-0000-4000-8000-000000000004', 'ios') $$, '42501', 'account not eligible',
  'U cannot register a device');
select throws_ok($$ insert into public.consents (user_id, type, version) values ('a1a1a1a1-0000-4000-8000-000000000004', 'tos', '2026-09-21') $$, '42501', 'account not eligible',
  'U cannot record a consent');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'a1a1a1a1-0000-4000-8000-000000000004/u-trip-2.bin.gz', 'a1a1a1a1-0000-4000-8000-000000000004') $$,
  '42501', null, 'U cannot upload under U''s own prefix');
select is(public.is_underage('a1a1a1a1-0000-4000-8000-000000000004'), true, 'is_underage is true for U, asked by U');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
select lives_ok($$ insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'a1a1a1a1-0000-4000-8000-000000000001/a-trip-2.bin.gz', 'a1a1a1a1-0000-4000-8000-000000000001') $$,
  'an adult still uploads under their own prefix');
select is(public.is_underage('a1a1a1a1-0000-4000-8000-000000000004'), false, 'and learns nothing about U from is_underage');
reset role;
select set_config('request.jwt.claims', '', true);

-- a later sign-in refreshes the name; it is stripped again, and an adult's is not
update auth.users set raw_user_meta_data = raw_user_meta_data || '{"full_name":"Uma Child","picture":"https://example.com/u.png"}' where id = 'a1a1a1a1-0000-4000-8000-000000000004';
select is((select raw_user_meta_data from auth.users where id = 'a1a1a1a1-0000-4000-8000-000000000004'), '{"email":"u6@example.com","sub":"g-u6"}'::jsonb,
  'a refreshed full_name on U is stripped again');
update auth.identities set identity_data = identity_data || '{"name":"Uma"}' where user_id = 'a1a1a1a1-0000-4000-8000-000000000004';
select is((select identity_data from auth.identities where user_id = 'a1a1a1a1-0000-4000-8000-000000000004'), '{"sub":"g-u6","email":"u6@example.com"}'::jsonb,
  'and a refreshed identity name too');
update auth.users set raw_user_meta_data = raw_user_meta_data || '{"full_name":"Ada Lovelace"}' where id = 'a1a1a1a1-0000-4000-8000-000000000001';
select is((select raw_user_meta_data from auth.users where id = 'a1a1a1a1-0000-4000-8000-000000000001'), '{"display_name":"Ada","full_name":"Ada Lovelace"}'::jsonb,
  'an adult''s metadata update is untouched');

-- the trip writer, the leftover-object listing
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.apply_trip((select p from fx where name = 'u')) $$, '42501', 'account not eligible', 'apply_trip refuses an under-13 account');
select is(public.underage_object_keys(100), '[{"bucket":"traces","name":"a1a1a1a1-0000-4000-8000-000000000004/u-trip.bin.gz"}]'::jsonb,
  'underage_object_keys lists exactly U''s leftover object');
select throws_ok($$ select public.underage_object_keys(0) $$, '22023', 'limit must be between 1 and 1000', 'its limit is bounded');
select lives_ok($$ update public.profiles set locale = 'en-GB' where id = 'a1a1a1a1-0000-4000-8000-000000000004' $$, 'the service role can still correct a blocked profile');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000004"}', true);
select throws_ok($$ select public.underage_object_keys(100) $$, '42501', null, 'authenticated cannot list leftover objects');
reset role;

-- ---------------------------------------------------------------------------
-- 6b. a blocked account keeps no drive (security I-1): T, with drives, an event, a dispute, day
--     rows, baselines, invites, a rate-limit row, a guardian link and a trace object, is
--     corrected by support to a child's birth date
-- ---------------------------------------------------------------------------
insert into public.event_disputes (event_id, user_id, reason, note)
  select e.id, e.user_id, 'other', 'we were parked at the school' from public.trip_events e where e.user_id = 'a1a1a1a1-0000-4000-8000-000000000002' limit 1;
update public.private_profiles set guardian_link_status = 'linked', guardian_user_id = 'a1a1a1a1-0000-4000-8000-000000000001' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
insert into storage.objects (bucket_id, name, owner_id) values ('traces', 'a1a1a1a1-0000-4000-8000-000000000002/t-trip-2.bin.gz', 'a1a1a1a1-0000-4000-8000-000000000002');
select is((select array[(select count(*) from public.trips where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.trip_events where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.event_disputes where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.score_daily where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.baselines where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.invites where issuer_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.rate_limits where user_id = 'a1a1a1a1-0000-4000-8000-000000000002')]::int[]),
  array[2, 1, 1, 1, 1, 10, 1], 'T starts with drives, an event, a dispute, a day row, baselines, ten invites and a rate-limit row');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.private_profiles set birth_date = current_date - interval '10 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000002';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array[(select count(*) from public.trips where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.trip_events where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.event_disputes where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.score_daily where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.baselines where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), (select count(*) from public.invites where issuer_id = 'a1a1a1a1-0000-4000-8000-000000000002'),
                        (select count(*) from public.rate_limits where user_id = 'a1a1a1a1-0000-4000-8000-000000000002')]::int[]),
  array[0, 0, 0, 0, 0, 0, 0], 'the block deletes every drive, event, dispute, day row, baseline, invite and rate-limit row');
select is((select row(guardian_link_status, guardian_user_id)::text from public.private_profiles where user_id = 'a1a1a1a1-0000-4000-8000-000000000002'), row('none', null::uuid)::text,
  'and resets the guardian link');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.underage_object_keys(100), '[{"bucket":"traces","name":"a1a1a1a1-0000-4000-8000-000000000002/t-trip-2.bin.gz"},{"bucket":"traces","name":"a1a1a1a1-0000-4000-8000-000000000004/u-trip.bin.gz"}]'::jsonb,
  'the trace bytes SQL cannot delete are listed for the Storage-API removal');
select throws_ok($$ select public.apply_trip((select p from fx where name = 't-after')) $$, '42501', 'account not eligible', 'a blocked account uploads no new drive');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ insert into public.trip_events (trip_id, user_id) values (gen_random_uuid(), 'a1a1a1a1-0000-4000-8000-000000000002') $$, '42501', 'account not eligible',
  'no event row may be written for a blocked account, by any writer');
select throws_ok($$ insert into public.event_disputes (event_id, user_id, reason) values (gen_random_uuid(), 'a1a1a1a1-0000-4000-8000-000000000002', 'other') $$, '42501', 'account not eligible',
  'nor a dispute');
select throws_ok($$ insert into public.score_daily (user_id, day) values ('a1a1a1a1-0000-4000-8000-000000000002', current_date) $$, '42501', 'account not eligible', 'nor a day row');
select throws_ok($$ insert into public.baselines (user_id) values ('a1a1a1a1-0000-4000-8000-000000000002') $$, '42501', 'account not eligible', 'nor baselines');

-- the minimisation refuses a band change made under someone else's JWT (a future definer bug)
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000003"}', true);
select throws_ok($$ update public.private_profiles set birth_date = current_date - interval '10 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000007' $$,
  '42501', 'minimise_underage_account requires the account owner or the service role', 'the minimisation refuses another user''s JWT');
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 7. hourly re-derivation: K turns 13, S turns 18
-- ---------------------------------------------------------------------------
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-000000000005', 'a1a1a1a1-0000-4000-8000-000000000006')),
  array['u13', '13_17'], 'K starts under 13 and S at 17');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.private_profiles set birth_date = birth_date - 2 where user_id in ('a1a1a1a1-0000-4000-8000-000000000005', 'a1a1a1a1-0000-4000-8000-000000000006');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-000000000005', 'a1a1a1a1-0000-4000-8000-000000000006')),
  array['13_17', '18_plus'], 'a service-role birth-date write re-derives the band at once');
-- simulate the calendar moving under unchanged birth dates: put the bands back as they were yesterday
update public.profiles set age_band = 'u13' where id = 'a1a1a1a1-0000-4000-8000-000000000005';
update public.profiles set age_band = '13_17' where id = 'a1a1a1a1-0000-4000-8000-000000000006';
select is(public.rederive_age_bands(), 2, 'the hourly pass moves both');
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-000000000005', 'a1a1a1a1-0000-4000-8000-000000000006')),
  array['13_17', '18_plus'], 'K is 13_17 and S is 18_plus');
select is(public.rederive_age_bands(), 0, 'a second pass changes nothing');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000005"}', true);
select lives_ok($$ update public.profiles set display_name = 'Kai' where id = 'a1a1a1a1-0000-4000-8000-000000000005' $$, 'K, now 13, can write the profile again');
select throws_ok($$ select public.rederive_age_bands() $$, '42501', null, 'authenticated cannot run the re-derivation');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.rederive_age_bands() $$, '42501', null, 'nor can the service role');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 8. the local date (N-m5): the latest live drive's zone, UTC when none is known
-- ---------------------------------------------------------------------------
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  ('a1a1a1a1-0000-4000-8000-000000000008', 'l1-trip', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'Pacific/Kiritimati', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  ('a1a1a1a1-0000-4000-8000-000000000009', 'l2-trip', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'Pacific/Pago_Pago', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  ('a1a1a1a1-0000-4000-8000-00000000000a', 'm1-trip', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'Pacific/Kiritimati', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short'),
  ('a1a1a1a1-0000-4000-8000-00000000000b', 'm2-trip', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'Pacific/Pago_Pago', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short');
-- a newer drive L2 deleted does not move L2's zone
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason, deleted_at) values
  ('a1a1a1a1-0000-4000-8000-000000000009', 'l2-deleted', now() - interval '1 day', now() - interval '1 day' + interval '10 minutes', 'Pacific/Kiritimati', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short', now());

select is(public.user_local_date('a1a1a1a1-0000-4000-8000-000000000007', '2026-03-10 03:00+00'), '2026-03-10'::date, 'with no drive the local date is the UTC date');
select is(public.user_local_date('a1a1a1a1-0000-4000-8000-000000000009', '2026-03-10 03:00+00'), '2026-03-09'::date, 'Pago Pago is still on the 9th at 03:00 UTC (the deleted drive is ignored)');
select is(public.user_local_date('a1a1a1a1-0000-4000-8000-000000000008', '2026-03-10 12:00+00'), '2026-03-11'::date, 'Kiritimati is already on the 11th at 12:00 UTC');
select is(array[public.derive_age_band_on('2008-03-10', '2026-03-09'), public.derive_age_band_on('2008-03-10', '2026-03-10'),
                public.derive_age_band_on('2013-03-10', '2026-03-09'), public.derive_age_band_on('2013-03-10', '2026-03-10'), public.derive_age_band_on(null, '2026-03-10')],
  array['13_17', '18_plus', 'u13', '13_17', 'unknown'], 'derive_age_band_on turns over on the birthday of the given date');
select is((select count(*)::int from generate_series(date '1990-01-01', date '2030-12-31', interval '97 days') g(day)
    where public.derive_age_band_on(date '2008-06-15', g.day::date) is distinct from
          case when date '2008-06-15' > g.day::date - interval '13 years' then 'u13' when date '2008-06-15' > g.day::date - interval '18 years' then '13_17' else '18_plus' end), 0,
  'derive_age_band_on agrees with 0001''s derive_age_band rule on any date');

-- the birth-date trigger uses the local date: same birth date, 18 in Kiritimati, 17 in Pago Pago
update public.private_profiles set birth_date = (select kir from d) - interval '18 years'
  where user_id in ('a1a1a1a1-0000-4000-8000-00000000000a', 'a1a1a1a1-0000-4000-8000-00000000000b');
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-00000000000a', 'a1a1a1a1-0000-4000-8000-00000000000b')),
  array['18_plus', '13_17'], 'setting a birth date derives the band on the driver''s local date');
-- and so does the hourly pass
update public.private_profiles set birth_date = (select kir from d) - interval '18 years'
  where user_id in ('a1a1a1a1-0000-4000-8000-000000000008', 'a1a1a1a1-0000-4000-8000-000000000009');
update public.profiles set age_band = 'unknown' where id in ('a1a1a1a1-0000-4000-8000-000000000008', 'a1a1a1a1-0000-4000-8000-000000000009');
select is(public.rederive_age_bands(), 2, 'the hourly pass finds both stale bands');
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-000000000008', 'a1a1a1a1-0000-4000-8000-000000000009')),
  array['18_plus', '13_17'], 'and turns each over on the driver''s local date, not the UTC date');

-- monotonic (ruling T1 I1): R turns 13 on the Kiritimati date and is released; a later drive in
-- Pago Pago (still the day before there) must not re-block R or re-run the minimisation
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  ('a1a1a1a1-0000-4000-8000-00000000000c', 'r-trip-1', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 'Pacific/Kiritimati', 100, 600, 'driver', 'mounted', 1, 'A', 'unscored', 'too_short');
update public.private_profiles set birth_date = (select kir from d) - interval '13 years' where user_id = 'a1a1a1a1-0000-4000-8000-00000000000c';
insert into public.devices (id, user_id, platform) values ('r-phone', 'a1a1a1a1-0000-4000-8000-00000000000c', 'android');
insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure, data_quality, status, unscored_reason) values
  ('a1a1a1a1-0000-4000-8000-00000000000c', 'r-trip-2', now() - interval '1 hour', now() - interval '50 minutes', 'Pacific/Pago_Pago', 100, 600, 'passenger', 'mounted', 1, 'A', 'unscored', 'too_short');
select is(public.derive_age_band_on((select birth_date from public.private_profiles where user_id = 'a1a1a1a1-0000-4000-8000-00000000000c'),
    public.user_local_date('a1a1a1a1-0000-4000-8000-00000000000c')), 'u13', 'R''s newest drive puts R''s local date back on the day before the birthday');
select is(public.rederive_age_bands(), 0, 'the pass never moves a band younger');
select is((select row(p.age_band, (select count(*) from public.devices v where v.user_id = p.id))::text from public.profiles p where p.id = 'a1a1a1a1-0000-4000-8000-00000000000c'),
  row('13_17', 1)::text, 'R stays 13_17 and keeps the device: no re-block, no re-minimisation');

-- narrowed (m1): an adult far from any 13th or 18th birthday is not read, even with a stale band
update public.profiles set age_band = '13_17' where id = 'a1a1a1a1-0000-4000-8000-000000000003';
select is(public.rederive_age_bands(), 0, 'the pass reads only birth dates near a 13th or 18th birthday');
update public.profiles set age_band = '18_plus' where id = 'a1a1a1a1-0000-4000-8000-000000000003';

-- the catch-up edge (n2): after a week-long pg_cron outage the pass still finds an 18th birthday
-- exactly 7 days back (W), and nothing 8 days back (X). Neither has a drive, so both are on UTC.
update public.private_profiles set birth_date = ((select utc from d) - interval '18 years')::date - 7 where user_id = 'a1a1a1a1-0000-4000-8000-00000000000d';
update public.private_profiles set birth_date = ((select utc from d) - interval '18 years')::date - 8 where user_id = 'a1a1a1a1-0000-4000-8000-00000000000e';
update public.profiles set age_band = '13_17' where id in ('a1a1a1a1-0000-4000-8000-00000000000d', 'a1a1a1a1-0000-4000-8000-00000000000e');
select is(public.rederive_age_bands(), 1, 'the pass catches up an 18th birthday exactly 7 days back, and reads nothing older');
select is((select array_agg(age_band order by id) from public.profiles where id in ('a1a1a1a1-0000-4000-8000-00000000000d', 'a1a1a1a1-0000-4000-8000-00000000000e')),
  array['18_plus', '13_17'], 'W (7 days back) is released to 18_plus; X (8 days back) is outside the window');

-- ---------------------------------------------------------------------------
-- 9. support correction: a mistyped adult (U) is released by a service-role birth-date update
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.private_profiles set birth_date = current_date - interval '20 years' where user_id = 'a1a1a1a1-0000-4000-8000-000000000004';
reset role;
select set_config('request.jwt.claims', '', true);
select is((select age_band from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000004'), '18_plus', 'a support correction re-derives U as 18_plus');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a1a1a1a1-0000-4000-8000-000000000004"}', true);
select lives_ok($$ update public.profiles set display_name = 'Uma' where id = 'a1a1a1a1-0000-4000-8000-000000000004' $$, 'U can write the profile again');
select lives_ok($$ insert into public.devices (id, user_id, platform) values ('u-phone-3', 'a1a1a1a1-0000-4000-8000-000000000004', 'ios') $$, 'and register a device again');
reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
drop extension if exists dblink;
