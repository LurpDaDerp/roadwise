-- 0001_core: posture (RLS everywhere, default deny, definer catch-all, private schema), the
-- account RPCs, username rules and the profanity filter, devices, the rate limiter.
create extension if not exists pgtap with schema extensions;

begin;
select plan(98);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com');

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles), 3, 'signup creates a profile per user');
select is((select count(*)::int from public.progress), 3, 'signup creates a progress row per user');
select is((select safety_rating is null and not ranked and miles_90d = 0 from public.progress where user_id = '00000000-0000-0000-0000-000000000001'),
  true, 'progress starts with no rating, unranked, no miles in the window');

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private', 'osm', 'hpms') and c.relkind in ('r', 'p') and not c.relrowsecurity), 0,
  'every table in public, private, osm and hpms has RLS enabled');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0,
  'every security definer function in public and private is owned by postgres and pins search_path=public');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))), 0,
  'every private function pins search_path');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) and not p.prosecdef), 0,
  'every public function an API role may execute is security definer');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')), 0,
  'anon can execute nothing in public');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no API role can execute anything in private');
select is(has_schema_privilege('authenticated', 'private', 'usage') or has_schema_privilege('anon', 'private', 'usage'), false, 'the private schema is unusable by the API roles');
select is(has_schema_privilege('service_role', 'private', 'usage'), true, 'service_role can use private');
select is(has_schema_privilege('authenticated', 'public', 'create'), false, 'authenticated cannot create objects in public');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'), 0, 'no table streams through realtime');
select is((select count(*)::int from information_schema.role_table_grants g where g.grantee = 'anon' and g.table_schema = 'public' and g.table_name <> 'app_config'), 0,
  'anon has no table grant beyond app_config');
select is((select array_agg(distinct g.table_name::text order by g.table_name::text) from information_schema.role_table_grants g
    where g.grantee = 'authenticated' and g.table_schema = 'public'),
  array['app_config', 'consents', 'notification_prefs', 'user_achievements'],
  'authenticated has table-level grants only on the four owner-read tables (profiles and progress are per column)');
select is((select array_agg(c.column_name::text order by c.column_name::text) from information_schema.column_privileges c
    where c.grantee = 'authenticated' and c.table_schema = 'public' and c.table_name = 'profiles' and c.column_name = 'flagged'), null,
  'profiles.flagged is moderation state: not readable by the owner');
select is((select count(*)::int from information_schema.column_privileges c where c.grantee = 'authenticated' and c.table_schema = 'public' and c.table_name = 'progress' and c.privilege_type = 'SELECT'), 6,
  'progress grants select on its 6 client columns (user_id, safety_rating, ranked, rating_updated_at, created_at, updated_at)');
select is((select array_agg(distinct g.privilege_type::text) from information_schema.role_table_grants g where g.grantee = 'authenticated' and g.table_schema = 'public'),
  array['SELECT'], 'and every one of them is select only');
select is((select count(*)::int from information_schema.role_table_grants g where g.grantee in ('anon', 'authenticated') and g.table_schema = 'public' and g.table_name = 'devices'), 0,
  'devices has no client grant at all');
select policies_are('public', 'profiles', array['profiles_select_own']::name[], 'profiles has exactly its select policy');
select policies_are('public', 'progress', array['progress_select_own']::name[], 'progress has exactly its select policy');
select policies_are('public', 'devices', '{}'::name[], 'devices has no policies');
select policies_are('public', 'app_config', array['app_config_public']::name[], 'app_config has exactly its public policy');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and p.polcmd <> 'r'), 0, 'no policy in public allows a client write');
select hasnt_index('public', 'progress', 'progress_global_board_idx', 'the global board index is gone with the board');
select has_index('public', 'profiles', 'profiles_username_text_idx', 'the username prefix search has its text_pattern_ops index');
select has_index('public', 'trips', 'trips_started_brin', 'trips has a time-leading BRIN index');

-- default privileges: anything postgres creates from now on is default-deny
create table public.zz_probe (id int);
create function public.zz_probe_fn() returns int language sql as 'select 1';
create function private.zz_probe_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p), false, 'a new table grants the API roles nothing');
select is(has_function_privilege('authenticated', 'public.zz_probe_fn()', 'execute') or has_function_privilege('anon', 'public.zz_probe_fn()', 'execute'), false, 'a new public function grants the API roles nothing');
select is(array[has_function_privilege('authenticated', 'private.zz_probe_fn()', 'execute'), has_function_privilege('service_role', 'private.zz_probe_fn()', 'execute')], array[false, true],
  'a new private function is executable by service_role only');
drop function public.zz_probe_fn();
drop function private.zz_probe_fn();
drop table public.zz_probe;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
select is(array[private.is_clean_name('ava_1'), private.is_clean_name('night owls'), private.is_clean_name('classy_bass'), private.is_clean_name('document_analysis')],
  array[true, true, true, true], 'clean names pass, including words that contain short list words');
select is(array[private.is_clean_name('fuck_you'), private.is_clean_name('F.u.c.k'), private.is_clean_name('5h1t_happens'), private.is_clean_name('ass'), private.is_clean_name('big_ass'), private.is_clean_name('n1gg4')],
  array[false, false, false, false, false, false], 'profanity is caught with separators, digits-for-letters and as a whole word');
select is(private.league_week(timestamptz '2026-10-05 03:30:00+00'), '2026-W40', 'Sunday 23:30 New York is still ISO week 40');
select is(private.league_week(timestamptz '2026-10-05 04:00:00+00'), '2026-W41', 'Monday 00:00 New York starts week 41');
select is(private.week_end(timestamptz '2026-10-07 12:00:00+00'), timestamptz '2026-10-12 04:00:00+00', 'the week ends next Monday 00:00 New York');
-- the per-opportunity rating (0023): null with no drives
select is(private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'rating', 'null'::jsonb, 'no drives: no Safety Rating');

-- ---------------------------------------------------------------------------
-- act as A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from public.profiles), 1, 'A sees only own profile');
select is((select count(*)::int from public.progress), 1, 'A sees only own progress');
select throws_ok($$ update public.profiles set units = 'km' where id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot write profiles directly');
select throws_ok($$ select flagged from public.profiles $$, '42501', null, 'A cannot read own flagged');
select throws_ok($$ update public.progress set safety_rating = 99 where user_id = '00000000-0000-0000-0000-000000000001' $$, '42501', null, 'A cannot write progress directly');
select throws_ok($$ select count(*) from public.devices $$, '42501', null, 'A cannot read devices');
select throws_ok($$ select count(*) from public.rate_limits $$, '42501', null, 'A cannot read rate_limits');
select throws_ok($$ select private.is_clean_name('x') $$, '42501', null, 'A cannot call into private');
select throws_ok($$ select public.take_rate_limit('00000000-0000-0000-0000-000000000001', 'k', '1 minute', 1) $$, '42501', null, 'A cannot call the service-role rate limiter');
select is((select count(*)::int from public.app_config where key = 'min_app_version'), 1, 'the public config row is readable');

-- username
select is(public.check_username('Ava_1'), '{"available": true, "reason": null}'::jsonb, 'a clean free username is available');
select is(public.check_username('av'), '{"available": false, "reason": "length"}'::jsonb, 'too short');
select is(public.check_username('ava-1'), '{"available": false, "reason": "characters"}'::jsonb, 'a hyphen is refused');
select is(public.check_username('admin'), '{"available": false, "reason": "reserved"}'::jsonb, 'reserved names are refused');
select is(public.check_username('sh1t_head'), '{"available": false, "reason": "not_allowed"}'::jsonb, 'profanity is refused');
select throws_ok($$ select public.complete_onboarding('2026-10') $$, '22023', 'pick a username first', 'onboarding needs a username');
select lives_ok($$ select public.claim_username('Ava_1') $$, 'A claims a username');
select is((select username::text from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 'ava_1', 'stored lower-cased');
select throws_ok($$ select public.claim_username('f_u_c_k') $$, '22023', 'username must be 3 to 20 letters, digits or underscores', 'a profane username is refused on claim');
select lives_ok($$ select public.claim_username('AVA_1') $$, 'claiming your own username again is a no-op');
select throws_ok($$ select public.complete_onboarding('v 1') $$, '22023', 'version must be 1 to 32 characters', 'bad terms version');
select lives_ok($$ select public.complete_onboarding('2026-10') $$, 'A completes onboarding');
select is((select onboarded_at is not null from public.profiles where id = '00000000-0000-0000-0000-000000000001'), true, 'onboarded_at set');
select hasnt_column('public', 'profiles', 'license_stage', 'profiles keeps no license stage');
select is((select count(*)::int from public.consents where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'terms_13_plus' and version = '2026-10'), 1, 'the consent row is recorded once');
select lives_ok($$ select public.accept_terms('2026-10') $$, 'accepting the same version again');
select is((select count(*)::int from public.consents), 1, 'does not duplicate it');
select throws_ok($$ select public.update_profile(p_state := 'wa') $$, '22023', 'state must be a two-letter US state code', 'state must be upper-case');
select lives_ok($$ select public.update_profile(p_units := 'km', p_state := 'WA', p_heatmap_visibility := 'friends') $$, 'A updates profile fields');
select is((select row(units, state, heatmap_visibility)::text from public.profiles where id = '00000000-0000-0000-0000-000000000001'), row('km', 'WA', 'friends')::text, 'fields updated');
select lives_ok($$ select public.update_profile(p_state := '') $$, 'an empty state clears it');
select is((select state from public.profiles where id = '00000000-0000-0000-0000-000000000001'), null, 'state cleared');

-- devices (0032: no install claims; the answer carries league_eligible as stored, never written)
select throws_ok($$ select public.register_device('short', 'ios') $$, '22023', 'device_id must be 8 to 128 characters', 'a short device id is refused');
select throws_ok($$ select public.register_device('device-aaaaaaaa', 'web') $$, '22023', 'platform must be ios or android', 'an unknown platform is refused');
select throws_ok($$ select public.register_device('device-aaaaaaaa', 'ios', 'not-a-token') $$, '22023', 'invalid push token', 'a malformed push token is refused');
select is(public.register_device('device-aaaaaaaa', 'ios', 'ExponentPushToken[abcdefgh12345]'), '{"league_eligible": false}'::jsonb, 'a device registers; the answer carries the stored league_eligible');
select is((select league_eligible from public.profiles where id = '00000000-0000-0000-0000-000000000001'), false, 'and register_device never writes it');

-- B on the same device
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(public.register_device('device-aaaaaaaa', 'ios', 'ExponentPushToken[abcdefgh12345]'), '{"league_eligible": false}'::jsonb, 'a second account registers the same device');
select is(public.register_device('device-bbbbbbbb', 'android'), '{"league_eligible": false}'::jsonb, 'and its own device');
select is((select count(*)::int from public.profiles where username = 'ava_1'), 0, 'B cannot see A profile');
select is(public.check_username('ava_1'), '{"available": false, "reason": "taken"}'::jsonb, 'A username is taken for B');
select is(public.check_username('AVA_1'), '{"available": false, "reason": "taken"}'::jsonb, 'in any case');
select throws_ok($$ select public.claim_username('ava_1') $$, '23505', 'username is taken', 'B cannot claim it');

-- device hardening: 10 new ids a day, 10 rows kept
select is((select bool_and(public.register_device('device-new-' || lpad(i::text, 6, '0'), 'ios') is not null) from generate_series(1, 8) i), true,
  'B registers eight more new device ids');
select throws_ok($$ select public.register_device('device-new-000009', 'ios') $$, '42501', 'too many requests', 'the 11th new id in a day is refused');
select lives_ok($$ select public.register_device('device-bbbbbbbb', 'android', 'ExponentPushToken[bbbbtoken0001]') $$, 'a known id is not a new id (and takes a token)');
reset role;
select is((select count(*)::int from public.devices where user_id = '00000000-0000-0000-0000-000000000002'), 10, 'at most 10 device rows per account (the oldest seen went)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is(public.register_device('device-cccccccc', 'android', 'ExponentPushToken[bbbbtoken0001]'), '{"league_eligible": false}'::jsonb,
  'C arrives with B''s push token on a new id');
select is(public.register_device('device-dddddddd', 'android'), '{"league_eligible": false}'::jsonb, 'and another install');
reset role;
update public.devices set last_seen_at = now() - interval '91 days' where user_id = '00000000-0000-0000-0000-000000000001' and device_id = 'device-aaaaaaaa';
set local role authenticated;
select is(public.register_device('device-aaaaaaaa', 'ios'), '{"league_eligible": false}'::jsonb, 'C registers a device A has not been seen on for 91 days');
reset role;
select is((select league_eligible from public.profiles where id = '00000000-0000-0000-0000-000000000001'), false, 'and A''s league_eligible is left as stored');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);

-- rate limit: check_username 30/min
select is((select bool_and(public.check_username('free_name_' || i) is not null) from generate_series(1, 28) i), true, 'B spends the username budget (30 checks with the two above)');
select throws_ok($$ select public.check_username('one_more') $$, '42501', 'too many requests', 'the 31st check in a minute is refused');

-- a JWT without sub, then anon
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.claim_username('ghost') $$, '42501', 'claim_username requires an authenticated user', 'an RPC refuses a JWT without sub');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select count(*) from public.profiles $$, '42501', null, 'anon cannot read profiles');
select throws_ok($$ select public.check_username('x') $$, '42501', null, 'anon cannot call check_username');
select is((select count(*)::int from public.app_config), 1, 'anon reads the public config row');
reset role;

-- ---------------------------------------------------------------------------
-- server side: push token moves with the device; the rate limiter
-- ---------------------------------------------------------------------------
select is((select push_token from public.devices where user_id = '00000000-0000-0000-0000-000000000001' and device_id = 'device-aaaaaaaa'), null,
  'a token registered by B is taken from A');
select is((select push_token from public.devices where user_id = '00000000-0000-0000-0000-000000000002' and device_id = 'device-aaaaaaaa'), 'ExponentPushToken[abcdefgh12345]', 'and held by B');

select is(private.take_rate_limit('00000000-0000-0000-0000-000000000001', 'probe', interval '1 minute', 1), true, 'a budget take passes');
select is(private.take_rate_limit('00000000-0000-0000-0000-000000000001', 'probe', interval '1 minute', 1), false, 'and the next in the window is refused');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.take_rate_limit('00000000-0000-0000-0000-000000000001', 'probe2', interval '1 minute', 1), true, 'the service role uses the public wrapper');
reset role;

select * from finish();
rollback;
