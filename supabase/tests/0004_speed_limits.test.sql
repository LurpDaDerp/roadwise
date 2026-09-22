-- 0004_speed_limits: PostGIS, the osm/hpms road schemas, limits_cache, and the four service-role
-- SQL functions (candidates, tile batches, the AWS cache writer, the rate limiter).
--
-- Runs against seed.sql's synthetic fixture (R6): the corridor way 9000000001 (primary, 35 mph) on
-- lat 47.6062 from lng -122.3330 to -122.2990, the parallel 9000000002 (residential, 25 mph) 20 m
-- north, the ramp 9000000003 (primary_link, 25 mph, one-way), the untagged residential crossing
-- 9000000004 at lng -122.3200, and HPMS section 9000000101 (30 mph) along the crossing.
-- The speeding-corrected trace crosses z15 columns 5249..5251 of row 11443; the corridor lies 4.1 m
-- north of the row 11443/11444 edge, so the 30 m tile buffer puts it in row 11444 as well.
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating the statement keeps
-- this file runnable on its own.
create extension if not exists pgtap with schema extensions;

begin;
select plan(161);

-- ---------------------------------------------------------------------------
-- helpers (run as the migration owner)
-- ---------------------------------------------------------------------------
-- the z15 tile a point falls in, as the device's tileFor computes it
create function pg_temp.tile_of(p_lat double precision, p_lng double precision) returns text
language sql immutable as $$
  select '15/' || floor((p_lng + 180) / 360 * 32768)::int || '/'
    || floor((1 - ln(tan(radians(p_lat)) + 1 / cos(radians(p_lat))) / pi()) / 2 * 32768)::int
$$;

-- every segment object of one tile in a batch reply
create function pg_temp.segs(p_batch jsonb, p_tile text) returns setof jsonb
language sql immutable as $$
  select s from jsonb_array_elements(p_batch -> 'tiles') t, jsonb_array_elements(t -> 'segments') s
  where t ->> 'tile' = p_tile
$$;

create function pg_temp.tile(p_batch jsonb, p_tile text) returns jsonb
language sql immutable as $$
  select t from jsonb_array_elements(p_batch -> 'tiles') t where t ->> 'tile' = p_tile
$$;

grant execute on function pg_temp.tile_of(double precision, double precision), pg_temp.segs(jsonb, text), pg_temp.tile(jsonb, text)
  to service_role, authenticated, anon;

-- ---------------------------------------------------------------------------
-- posture: extension, schemas, tables, RLS, grants
-- ---------------------------------------------------------------------------
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'postgis'), 'extensions', 'postgis lives in the extensions schema');
select has_schema('osm', 'schema osm exists');
select has_schema('hpms', 'schema hpms exists');
select has_table('osm', 'ways', 'osm.ways exists');
select has_table('hpms', 'sections', 'hpms.sections exists');
select has_table('public', 'limits_cache', 'public.limits_cache exists');
select is((select relrowsecurity from pg_class where oid = 'osm.ways'::regclass), true, 'osm.ways has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'hpms.sections'::regclass), true, 'hpms.sections has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.limits_cache'::regclass), true, 'limits_cache has RLS enabled');
select policies_are('osm', 'ways', '{}'::name[], 'osm.ways has no policies (server only)');
select policies_are('hpms', 'sections', '{}'::name[], 'hpms.sections has no policies (server only)');
select policies_are('public', 'limits_cache', '{}'::name[], 'limits_cache has no policies (server only)');

select table_privs_are('osm', 'ways', 'anon', '{}'::name[], 'anon has no privileges on osm.ways');
select table_privs_are('osm', 'ways', 'authenticated', '{}'::name[], 'authenticated has no privileges on osm.ways');
select table_privs_are('hpms', 'sections', 'anon', '{}'::name[], 'anon has no privileges on hpms.sections');
select table_privs_are('hpms', 'sections', 'authenticated', '{}'::name[], 'authenticated has no privileges on hpms.sections');
select table_privs_are('public', 'limits_cache', 'anon', '{}'::name[], 'anon has no privileges on limits_cache');
select table_privs_are('public', 'limits_cache', 'authenticated', '{}'::name[], 'authenticated has no privileges on limits_cache');
select table_privs_are('osm', 'ways', 'service_role', array['SELECT']::name[], 'service_role may only read osm.ways');
select table_privs_are('hpms', 'sections', 'service_role', array['SELECT']::name[], 'service_role may only read hpms.sections');
select table_privs_are('public', 'limits_cache', 'service_role', array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::name[], 'service_role has exactly select/insert/update/delete on limits_cache');

select is(has_schema_privilege('anon', 'osm', 'usage'), false, 'anon cannot use schema osm');
select is(has_schema_privilege('authenticated', 'osm', 'usage'), false, 'authenticated cannot use schema osm');
select is(has_schema_privilege('anon', 'hpms', 'usage'), false, 'anon cannot use schema hpms');
select is(has_schema_privilege('authenticated', 'hpms', 'usage'), false, 'authenticated cannot use schema hpms');
select is(has_schema_privilege('service_role', 'osm', 'usage') and has_schema_privilege('service_role', 'hpms', 'usage'), true, 'service_role can use both road schemas');
select is(has_schema_privilege('anon', 'osm', 'create') or has_schema_privilege('authenticated', 'hpms', 'create')
  or has_schema_privilege('service_role', 'osm', 'create') or has_schema_privilege('service_role', 'hpms', 'create'), false, 'no API role can create objects in the road schemas');

select has_index('osm', 'ways', 'ways_geom_gist', 'osm.ways has a GiST index on geom');
select has_index('hpms', 'sections', 'sections_geom_gist', 'hpms.sections has a GiST index on geom');
select has_index('public', 'limits_cache', 'limits_cache_geom_gist', 'limits_cache has a GiST index on geom');
select has_index('public', 'limits_cache', 'limits_cache_expires_at_idx', 'limits_cache has an index on expires_at (retention)');
select is((select count(*)::int from pg_index i join pg_class c on c.oid = i.indexrelid join pg_am a on a.oid = c.relam
    where c.relname in ('ways_geom_gist', 'sections_geom_gist', 'limits_cache_geom_gist') and a.amname = 'gist'), 3, 'the three geometry indexes are GiST');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgname in ('ways_touch', 'sections_touch', 'limits_cache_touch')), 3, 'all three tables keep updated_at with touch triggers');

-- functions: service-role only, invoker, search_path pinned
select is(array[has_function_privilege('anon', 'public.speed_limit_candidates(double precision, double precision, integer)', 'execute'),
                has_function_privilege('authenticated', 'public.speed_limit_candidates(double precision, double precision, integer)', 'execute'),
                has_function_privilege('service_role', 'public.speed_limit_candidates(double precision, double precision, integer)', 'execute')],
  array[false, false, true], 'speed_limit_candidates executes for service_role only');
select is(array[has_function_privilege('anon', 'public.speed_limit_tiles(text[])', 'execute'),
                has_function_privilege('authenticated', 'public.speed_limit_tiles(text[])', 'execute'),
                has_function_privilege('service_role', 'public.speed_limit_tiles(text[])', 'execute')],
  array[false, false, true], 'speed_limit_tiles executes for service_role only');
select is(array[has_function_privilege('anon', 'public.put_limits_cache(text, jsonb, integer, numeric, integer)', 'execute'),
                has_function_privilege('authenticated', 'public.put_limits_cache(text, jsonb, integer, numeric, integer)', 'execute'),
                has_function_privilege('service_role', 'public.put_limits_cache(text, jsonb, integer, numeric, integer)', 'execute')],
  array[false, false, true], 'put_limits_cache executes for service_role only');
select is(array[has_function_privilege('anon', 'public.take_rate_limit(uuid, text, interval, integer)', 'execute'),
                has_function_privilege('authenticated', 'public.take_rate_limit(uuid, text, interval, integer)', 'execute'),
                has_function_privilege('service_role', 'public.take_rate_limit(uuid, text, interval, integer)', 'execute')],
  array[false, false, true], 'take_rate_limit executes for service_role only');
select is((select count(*)::int from pg_proc where oid in (
    'public.speed_limit_candidates(double precision, double precision, integer)'::regprocedure,
    'public.put_limits_cache(text, jsonb, integer, numeric, integer)'::regprocedure,
    'public.take_rate_limit(uuid, text, interval, integer)'::regprocedure)
    and not prosecdef and proconfig = array['search_path=public, extensions']), 3,
  'candidates, put_limits_cache and take_rate_limit are security invoker and pin exactly search_path = public, extensions');
select is((select row(prosecdef, proconfig)::text from pg_proc where oid = 'public.speed_limit_tiles(text[])'::regprocedure),
  row(false, array['search_path=public, extensions', 'statement_timeout=5s'])::text,
  'speed_limit_tiles is security invoker with exactly search_path and a 5 s statement_timeout');
select is(
  (select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');

-- default privileges: what postgres creates in osm/hpms later (B3's pipeline) reaches service_role only
create table osm.zz_probe (id int);
create sequence osm.zz_probe_seq;
create function osm.zz_probe_fn() returns int language sql as 'select 1';
create table hpms.zz_probe (id int);
create sequence hpms.zz_probe_seq;
create function hpms.zz_probe_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'osm.zz_probe', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
  or (select bool_or(has_sequence_privilege(r, 'osm.zz_probe_seq', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['usage', 'select', 'update']) p)
  or has_function_privilege('anon', 'osm.zz_probe_fn()', 'execute') or has_function_privilege('authenticated', 'osm.zz_probe_fn()', 'execute'),
  false, 'a new table, sequence or function in osm grants anon and authenticated nothing');
select is(array[has_table_privilege('service_role', 'osm.zz_probe', 'select'), has_table_privilege('service_role', 'osm.zz_probe', 'insert'),
                has_sequence_privilege('service_role', 'osm.zz_probe_seq', 'usage'), has_function_privilege('service_role', 'osm.zz_probe_fn()', 'execute')],
  array[true, false, true, true], 'a new object in osm is readable (not writable) and callable by service_role');
select is((select bool_or(has_table_privilege(r, 'hpms.zz_probe', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
  or (select bool_or(has_sequence_privilege(r, 'hpms.zz_probe_seq', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['usage', 'select', 'update']) p)
  or has_function_privilege('anon', 'hpms.zz_probe_fn()', 'execute') or has_function_privilege('authenticated', 'hpms.zz_probe_fn()', 'execute'),
  false, 'a new table, sequence or function in hpms grants anon and authenticated nothing');
select is(array[has_table_privilege('service_role', 'hpms.zz_probe', 'select'), has_table_privilege('service_role', 'hpms.zz_probe', 'insert'),
                has_sequence_privilege('service_role', 'hpms.zz_probe_seq', 'usage'), has_function_privilege('service_role', 'hpms.zz_probe_fn()', 'execute')],
  array[true, false, true, true], 'a new object in hpms is readable (not writable) and callable by service_role');
drop function osm.zz_probe_fn();
drop sequence osm.zz_probe_seq;
drop table osm.zz_probe;
drop function hpms.zz_probe_fn();
drop sequence hpms.zz_probe_seq;
drop table hpms.zz_probe;

-- clients are refused at the door
set local role anon;
select throws_ok($$ select public.speed_limit_tiles(array['15/5249/11443']) $$, '42501', null, 'anon cannot call speed_limit_tiles');
select throws_ok($$ select count(*) from osm.ways $$, '42501', null, 'anon cannot read osm.ways');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.speed_limit_candidates(47.6062, -122.3160, 25) $$, '42501', null, 'authenticated cannot call speed_limit_candidates');
select throws_ok($$ select public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 100) $$, '42501', null, 'authenticated cannot call take_rate_limit');
select throws_ok($$ select count(*) from public.limits_cache $$, '42501', null, 'authenticated cannot read limits_cache');
select throws_ok($$ select count(*) from hpms.sections $$, '42501', null, 'authenticated cannot read hpms.sections');
reset role;

-- ---------------------------------------------------------------------------
-- table constraints
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.limits_cache (segment_key, geom, limit_mph, expires_at)
    values ('00000000000000aa', extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 45, now() + interval '31 days') $$,
  '23514', null, 'a cache row may not live longer than 30 days (the 31-day CHECK)');
select lives_ok($$ insert into public.limits_cache (segment_key, geom, limit_mph, expires_at)
    values ('00000000000000ab', extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 45, date_trunc('day', now(), 'UTC') + interval '30 days') $$,
  'a cache row of exactly 30 days from its (day-floored) creation is accepted');
select throws_ok($$ insert into public.limits_cache (segment_key, geom, limit_mph, expires_at)
    values ('00000000000000ac', extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), null, now() + interval '1 day') $$,
  '23502', null, 'a cache row without a limit is refused (the device refuses an AWS segment with no limit)');
select throws_ok($$ insert into public.limits_cache (segment_key, geom, limit_mph, expires_at)
    values ('aws:route-leg-with-a-very-long-identifier', extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 45, now() + interval '1 day') $$,
  '23514', null, 'a cache key must be the 16-hex hash (so a tile id never exceeds 24 characters)');
select throws_ok($$ insert into public.limits_cache (segment_key, geom, limit_mph, provider, expires_at)
    values ('00000000000000ad', extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 45, 'osm', now() + interval '1 day') $$,
  '23514', null, 'the cache only holds AWS answers');
select throws_ok($$ insert into osm.ways (osm_id, geom, highway) values (1, extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 'footway') $$,
  '23514', null, 'osm.ways only holds the twelve road classes');
select throws_ok($$ insert into osm.ways (osm_id, geom, highway, maxspeed_mph) values (1, extensions.st_geomfromtext('LINESTRING(-122.31 47.61, -122.309 47.61)', 4326), 'residential', 90) $$,
  '23514', null, 'osm.ways refuses a limit above 85 mph');
select throws_ok($$ insert into hpms.sections (id, geom, speed_limit_mph, state_code) values (1, extensions.st_geomfromtext('MULTILINESTRING((-122.31 47.61, -122.309 47.61))', 4326), null, 53) $$,
  '23502', null, 'an HPMS section always carries a limit');
select throws_ok($$ insert into hpms.sections (id, geom, speed_limit_mph, f_system, state_code) values (1, extensions.st_geomfromtext('MULTILINESTRING((-122.31 47.61, -122.309 47.61))', 4326), 30, 8, 53) $$,
  '23514', null, 'f_system is 1..7');
delete from public.limits_cache;

-- ---------------------------------------------------------------------------
-- the fixture
-- ---------------------------------------------------------------------------
select is((select array_agg(osm_id order by osm_id) from osm.ways), array[9000000001, 9000000002, 9000000003, 9000000004]::bigint[], 'the seed holds the four synthetic ways');
select is((select maxspeed_mph from osm.ways where osm_id = 9000000004), null, 'the crossing way is untagged');
select is((select speed_limit_mph from hpms.sections where id = 9000000101), 30::smallint, 'the HPMS section along the crossing posts 30 mph');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- speed_limit_candidates
-- ---------------------------------------------------------------------------
select is((select row(provider, segment_key, limit_mph, highway, oneway)::text from public.speed_limit_candidates(47.6062, -122.3160, 25) order by distance_m, segment_key limit 1),
  row('osm', '9000000001', 35, 'primary', 0)::text, 'on the corridor the nearest candidate is the 35 mph way');
select ok((select distance_m < 0.5 from public.speed_limit_candidates(47.6062, -122.3160, 25) where segment_key = '9000000001'), 'and it is under half a metre away');
select ok((select abs(bearing_deg - 90) < 0.01 from public.speed_limit_candidates(47.6062, -122.3160, 25) where segment_key = '9000000001'), 'with the bearing it is digitised in (east, 90 degrees)');
select is((select array_agg(segment_key order by segment_key) from public.speed_limit_candidates(47.60629, -122.3160, 25)), array['9000000001', '9000000002'], 'from the midpoint both parallels are candidates');
select ok((select bool_and(distance_m between 9.5 and 10.5) from public.speed_limit_candidates(47.60629, -122.3160, 25)), 'each about 10 m away');
select is((select limit_mph from public.speed_limit_candidates(47.60629, -122.3160, 25) where segment_key = '9000000002'), 25, 'the northern parallel is the 25 mph way');
select is((select array_agg(provider || ':' || segment_key || ':' || coalesce(limit_mph::text, 'null') order by provider, segment_key) from public.speed_limit_candidates(47.6062, -122.3200, 10)),
  array['hpms:9000000101:30', 'osm:9000000001:35', 'osm:9000000004:null'], 'at the crossing: the corridor, the untagged way (no limit) and the HPMS section, one row each');
select ok((select abs(bearing_deg - 0) < 0.01 from public.speed_limit_candidates(47.6062, -122.3200, 10) where segment_key = '9000000004'), 'the crossing way is digitised north (0 degrees)');
select is((select highway || '/' || oneway from public.speed_limit_candidates(47.6062, -122.3200, 10) where provider = 'hpms'), 'road/0', 'an HPMS candidate is a two-way road of no OSM class');
select is((select count(*)::int from public.speed_limit_candidates(47.6170, -122.3500, 50)), 0, 'far from the fixture there are no candidates');
select ok((select limit_mph = 25 and oneway = 1 and highway = 'primary_link' from public.speed_limit_candidates(47.6051, -122.3000, 25) where segment_key = '9000000003'), 'the ramp is a one-way primary_link at 25 mph');

select throws_ok($$ select * from public.speed_limit_candidates(47.6062, -122.3160, 4) $$, '22023', 'radius_m must be between 5 and 50', 'a radius under 5 m is refused');
select throws_ok($$ select * from public.speed_limit_candidates(47.6062, -122.3160, 51) $$, '22023', 'radius_m must be between 5 and 50', 'a radius over 50 m is refused');
select throws_ok($$ select * from public.speed_limit_candidates(47.6062, -122.3160, null) $$, '22023', 'radius_m must be between 5 and 50', 'a missing radius is refused');
select throws_ok($$ select * from public.speed_limit_candidates(91, -122.3160, 25) $$, '22023', 'lat must be between -90 and 90 and lng between -180 and 180', 'a latitude off the globe is refused');
select throws_ok($$ select * from public.speed_limit_candidates(47.6062, 'NaN', 25) $$, '22023', 'lat must be between -90 and 90 and lng between -180 and 180', 'a NaN longitude is refused');
select throws_ok($$ select * from public.speed_limit_candidates(null, -122.3160, 25) $$, '22023', 'lat must be between -90 and 90 and lng between -180 and 180', 'a missing latitude is refused');

-- ---------------------------------------------------------------------------
-- speed_limit_tiles: the corridor's three tiles in one call
-- ---------------------------------------------------------------------------
create temporary table b1_batch as
  select public.speed_limit_tiles(array['15/5249/11443', '15/5250/11443', '15/5251/11443']) as j;

select is((select array_agg(t ->> 'tile' order by n) from b1_batch, jsonb_array_elements(j -> 'tiles') with ordinality as x(t, n)),
  array['15/5249/11443', '15/5250/11443', '15/5251/11443'], 'one call returns the three tiles in the order asked');
select is((select array_agg(k order by k) from b1_batch, jsonb_object_keys(j) k), array['tiles'], 'the reply is { tiles } (B2 adds fallback)');
select is((select array_agg(distinct k order by k) from b1_batch, jsonb_array_elements(j -> 'tiles') t, jsonb_object_keys(t) k),
  array['expiresAt', 'segments', 'tile', 'truncated'], 'each tile has exactly tile, expiresAt, truncated and segments');
select is((select array_agg(distinct k order by k) from b1_batch, jsonb_array_elements(j -> 'tiles') t, jsonb_array_elements(t -> 'segments') s, jsonb_object_keys(s) k),
  array['highway', 'id', 'limitMph', 'line', 'oneway', 'provider'], 'each segment has exactly id, provider, limitMph, highway, oneway and line');
select is((select array_agg(distinct s ->> 'id' order by s ->> 'id') from b1_batch, pg_temp.segs(j, '15/5249/11443') s), array['9000000001', '9000000002'], 'tile 5249 holds the corridor and its parallel');
select is((select array_agg(distinct (s ->> 'provider') || ':' || (s ->> 'id') order by (s ->> 'provider') || ':' || (s ->> 'id')) from b1_batch, pg_temp.segs(j, '15/5250/11443') s),
  array['hpms:9000000101', 'osm:9000000001', 'osm:9000000002', 'osm:9000000004'], 'tile 5250 holds the corridor, the parallel, the untagged crossing and the HPMS section');
select is((select array_agg(distinct s ->> 'id' order by s ->> 'id') from b1_batch, pg_temp.segs(j, '15/5251/11443') s), array['9000000001', '9000000002', '9000000003'], 'tile 5251 holds the corridor, the parallel and the ramp');
select is((select count(*)::int from b1_batch, pg_temp.segs(j, '15/5250/11443') s where s ->> 'id' = '9000000004' and s -> 'limitMph' = 'null'::jsonb), 1, 'the untagged way is sent with limitMph null');
select is((select (s -> 'limitMph')::int from b1_batch, pg_temp.segs(j, '15/5250/11443') s where s ->> 'id' = '9000000101'), 30, 'the HPMS section carries its 30 mph');
select is((select (s -> 'limitMph')::int || '/' || (s ->> 'highway') || '/' || (s -> 'oneway')::int from b1_batch, pg_temp.segs(j, '15/5249/11443') s where s ->> 'id' = '9000000001'),
  '35/primary/0', 'the corridor carries 35 mph, its class and its oneway');
select is((select (s -> 'oneway')::int from b1_batch, pg_temp.segs(j, '15/5251/11443') s where s ->> 'id' = '9000000003'), 1, 'the ramp is sent one-way');
select is((select count(*)::int from b1_batch, jsonb_array_elements(j -> 'tiles') t, jsonb_array_elements(t -> 'segments') s
    where extensions.st_geometrytype(extensions.st_linefromencodedpolyline(s ->> 'line', 5)) <> 'ST_LineString'
       or extensions.st_npoints(extensions.st_linefromencodedpolyline(s ->> 'line', 5)) < 2
       or extensions.st_length(extensions.st_linefromencodedpolyline(s ->> 'line', 5)) = 0), 0,
  'every line decodes to a single LineString of two or more distinct points');
select ok((select count(*) > 0 from b1_batch, jsonb_array_elements(j -> 'tiles') t, jsonb_array_elements(t -> 'segments') s), 'and there are lines to check');
select is((select array_agg((t -> 'truncated')::boolean) from b1_batch, jsonb_array_elements(j -> 'tiles') t), array[false, false, false], 'no tile is truncated');
select is((select count(*)::int from b1_batch, jsonb_array_elements(j -> 'tiles') t, jsonb_array_elements(t -> 'segments') s
    where char_length(s ->> 'id') not between 1 and 24 or char_length(s ->> 'line') not between 1 and 4096 or char_length(s ->> 'highway') not between 1 and 24
       or (s ->> 'provider') not in ('osm', 'hpms', 'aws') or ((s ->> 'provider') <> 'osm' and s -> 'limitMph' = 'null'::jsonb)), 0,
  'every segment meets the device schema: id <= 24, line <= 4096, a known provider, and only OSM may lack a limit');
select ok((select bool_and((t -> 'expiresAt')::bigint = floor(extract(epoch from now() + interval '30 days') * 1000)::bigint) from b1_batch, jsonb_array_elements(j -> 'tiles') t),
  'with no cache row inside, a tile expires in 30 days (epoch ms)');

-- clipping: the corridor in 5250 is cut at the tile edge plus 30 m, keeps its direction, and is one part
select ok((select extensions.st_xmin(g) between -122.3223 and -122.3218 and extensions.st_xmax(g) between -122.3108 and -122.3103
    from b1_batch, pg_temp.segs(j, '15/5250/11443') s, lateral (select extensions.st_linefromencodedpolyline(s ->> 'line', 5) g) x where s ->> 'id' = '9000000001'),
  'the corridor is clipped to tile 5250 buffered by about 30 m on each side');
select ok((select extensions.st_x(extensions.st_startpoint(g)) < extensions.st_x(extensions.st_endpoint(g))
    from b1_batch, pg_temp.segs(j, '15/5250/11443') s, lateral (select extensions.st_linefromencodedpolyline(s ->> 'line', 5) g) x where s ->> 'id' = '9000000001'),
  'clipping keeps the direction the way is digitised in (west to east)');
select ok((select extensions.st_y(extensions.st_startpoint(g)) > extensions.st_y(extensions.st_endpoint(g))
    from b1_batch, pg_temp.segs(j, '15/5251/11443') s, lateral (select extensions.st_linefromencodedpolyline(s ->> 'line', 5) g) x where s ->> 'id' = '9000000003'),
  'and the one-way ramp still runs the way it is digitised (north to south)');

-- the buffer reaches across the row edge: the corridor (4.1 m north of it) is in row 11444 too
select is((select count(*)::int from pg_temp.segs(public.speed_limit_tiles(array['15/5249/11444']), '15/5249/11444') s where s ->> 'id' = '9000000001'), 1,
  'the corridor also appears in the row-11444 tile through the 30 m buffer');
select is((select jsonb_array_length(pg_temp.tile(public.speed_limit_tiles(array['15/5249/11430']), '15/5249/11430') -> 'segments')), 0, 'a tile with no roads is sent empty');
-- the id the device sees is the key the server's candidates return
select is((select array_agg(distinct s ->> 'id' order by s ->> 'id') from b1_batch, pg_temp.segs(j, '15/5250/11443') s),
  (select array_agg(segment_key order by segment_key) from public.speed_limit_candidates(47.6062, -122.3200, 25)),
  'the tile ids and the candidate keys are the same strings');

select throws_ok($$ select public.speed_limit_tiles(array['15/1/1', '15/1/2', '15/1/3', '15/1/4', '15/1/5']) $$, '22023', 'tiles must name 1 to 4 tile keys', 'five keys are refused');
select throws_ok($$ select public.speed_limit_tiles(array[]::text[]) $$, '22023', 'tiles must name 1 to 4 tile keys', 'no keys are refused');
select throws_ok($$ select public.speed_limit_tiles(null) $$, '22023', 'tiles must name 1 to 4 tile keys', 'a null key list is refused');
select throws_ok($$ select public.speed_limit_tiles(array['14/5249/11443']) $$, '22023', 'tile keys must be z15 keys 15/x/y', 'a key at another zoom is refused');
select throws_ok($$ select public.speed_limit_tiles(array['15/32768/1']) $$, '22023', 'tile keys must be z15 keys 15/x/y', 'a key off the grid is refused');
select throws_ok($$ select public.speed_limit_tiles(array['15/05249/11443']) $$, '22023', 'tile keys must be z15 keys 15/x/y', 'a non-canonical key is refused');
select throws_ok($$ select public.speed_limit_tiles(array['15/5249/11443', null]) $$, '22023', 'tile keys must be z15 keys 15/x/y', 'a null key is refused');
select throws_ok($$ select public.speed_limit_tiles(array['15/5249/11443', '15/5249/11443']) $$, '22023', 'tile keys must be distinct', 'a repeated key is refused');
select throws_ok($$ select public.speed_limit_tiles(array[['15/5249/11443'], ['15/5250/11443']]) $$, '22023', 'tiles must name 1 to 4 tile keys', 'a two-dimensional key array is refused');

-- ---------------------------------------------------------------------------
-- put_limits_cache: the AWS fallback's cache, keyed by a short hash
-- ---------------------------------------------------------------------------
select matches(public.put_limits_cache('aws-leg-47.6170,-122.3100', '{"type":"LineString","coordinates":[[-122.3100,47.6170],[-122.3080,47.6170]]}', 45, 90, 7),
  '^[0-9a-f]{16}$', 'put_limits_cache stores the answer under a 16-hex key and returns it');
select is((select count(*)::int from public.limits_cache), 1, 'one cache row');
select is((select segment_key from public.limits_cache), left(encode(sha256(convert_to('aws-leg-47.6170,-122.3100', 'UTF8')), 'hex'), 16), 'the key is the first 16 hex digits of sha256 of the caller key');
select is((select expires_at from public.limits_cache), date_trunc('day', now() + interval '7 days', 'UTC'), 'it expires after the ttl, at the start of that UTC day');
select is((select expires_at = date_trunc('day', expires_at, 'UTC') and expires_at <= now() + interval '7 days' from public.limits_cache), true,
  'the stored expires_at is midnight UTC and never later than the expiry asked for (it keeps no time of the lookup)');
select is((select array[created_at, updated_at] from public.limits_cache), array[date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC')],
  'its created_at and updated_at keep only the UTC day, not the time of the lookup');
select is((select row(provider, limit_mph, oneway)::text from public.speed_limit_candidates(47.6170, -122.3090, 25)), row('aws', 45, 1)::text,
  'an unexpired cache row is a candidate, one-way along the heading it was asked for');
select is((select segment_key from public.speed_limit_candidates(47.6170, -122.3090, 25)), (select segment_key from public.limits_cache), 'under the stored key');
select is((select array_agg((s ->> 'provider') || ':' || (s ->> 'id') || ':' || (s -> 'limitMph')::text)
    from pg_temp.segs(public.speed_limit_tiles(array[pg_temp.tile_of(47.6170, -122.3090)]), pg_temp.tile_of(47.6170, -122.3090)) s),
  array['aws:' || (select segment_key from public.limits_cache) || ':45'], 'the cache row is in its tile with the same id and its limit');
select is((select (pg_temp.tile(public.speed_limit_tiles(array[pg_temp.tile_of(47.6170, -122.3090)]), pg_temp.tile_of(47.6170, -122.3090)) -> 'expiresAt')::bigint),
  floor(extract(epoch from date_trunc('day', now() + interval '7 days', 'UTC')) * 1000)::bigint, 'a tile with a cache row expires at the start of the UTC day that row expires on');
select is((select (pg_temp.tile(public.speed_limit_tiles(array[pg_temp.tile_of(47.6170, -122.3090)]), pg_temp.tile_of(47.6170, -122.3090)) -> 'expiresAt')::bigint % 86400000),
  0::bigint, 'so expiresAt is day-aligned and carries no time of the lookup');
select ok((select (pg_temp.tile(public.speed_limit_tiles(array[pg_temp.tile_of(47.6170, -122.3090)]), pg_temp.tile_of(47.6170, -122.3090)) -> 'expiresAt')::bigint
    <= (select floor(extract(epoch from expires_at) * 1000)::bigint from public.limits_cache)),
  'and it is never later than the row''s true expiry');
select lives_ok($$ select public.put_limits_cache('aws-leg-47.6170,-122.3100', '{"type":"LineString","coordinates":[[-122.3100,47.6170],[-122.3080,47.6171]]}', 40, null, 30) $$,
  'writing the same key again refreshes the row');
select is((select row(count(*), max(limit_mph), max(expires_at) = date_trunc('day', now(), 'UTC') + interval '30 days', bool_and(heading_deg is null))::text from public.limits_cache), row(1, 40, true, true)::text,
  'one row, with the new limit and heading; a 30-day ttl ends at the start of the UTC day 30 days on');
select is((select array[created_at, updated_at] from public.limits_cache), array[date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC')],
  'a refresh stores day-floored stamps too');
select is((select oneway from public.speed_limit_candidates(47.6170, -122.3090, 25)), 0, 'a cache row with no heading is two-way');

reset role;
update public.limits_cache set expires_at = now() - interval '1 second';
set local role service_role;
select is((select count(*)::int from public.speed_limit_candidates(47.6170, -122.3090, 25)), 0, 'an expired cache row is not a candidate');
select is((select jsonb_array_length(pg_temp.tile(public.speed_limit_tiles(array[pg_temp.tile_of(47.6170, -122.3090)]), pg_temp.tile_of(47.6170, -122.3090)) -> 'segments')), 0,
  'nor sent in a tile');

select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 45, 90, 31) $$, '22023', 'ttl_days must be between 1 and 30', 'a ttl over 30 days is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 45, 90, 0) $$, '22023', 'ttl_days must be between 1 and 30', 'a ttl of 0 days is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', null, 90, 30) $$, '22023', 'limit_mph must be between 5 and 85', 'a cache answer without a limit is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 86, 90, 30) $$, '22023', 'limit_mph must be between 5 and 85', 'a limit over 85 is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 45, 360, 30) $$, '22023', 'heading must be at least 0 and below 360', 'a heading of 360 is refused');
select throws_ok($$ select public.put_limits_cache('', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 45, 90, 30) $$, '22023', 'key must be 1 to 128 characters', 'an empty key is refused');
select throws_ok($$ select public.put_limits_cache(repeat('k', 129), '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.309,47.61]]}', 45, 90, 30) $$, '22023', 'key must be 1 to 128 characters', 'a 129-character key is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61]]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a one-point line is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"Point","coordinates":[-122.31,47.61]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a point is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],["x",47.61]]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a malformed position is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.31,97.61]]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a position off the globe is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.21,47.61]]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a 7.5 km line is refused');
select throws_ok($$ select public.put_limits_cache('k', '{"type":"LineString","coordinates":[[-122.31,47.61],[-122.31,47.61]]}', 45, 90, 30) $$, '22023', 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km', 'a zero-length line is refused');

-- the bounded purge: each put_limits_cache call deletes at most 100 expired rows (review M-1)
reset role;
delete from public.limits_cache;
insert into public.limits_cache (segment_key, geom, limit_mph, expires_at, created_at)
  select lpad(to_hex(i), 16, '0'), extensions.st_geomfromtext('LINESTRING(-122.40 47.70, -122.399 47.70)', 4326), 30,
    now() - interval '1 day', now() - interval '10 days'
  from generate_series(1, 150) i;
insert into public.limits_cache (segment_key, geom, limit_mph, expires_at)
  values ('ffffffffffffffff', extensions.st_geomfromtext('LINESTRING(-122.40 47.71, -122.399 47.71)', 4326), 30, now() + interval '1 day');
set local role service_role;
select lives_ok($$ select public.put_limits_cache('purge-1', '{"type":"LineString","coordinates":[[-122.41,47.72],[-122.409,47.72]]}', 35, null, 7) $$, 'a cache write with 150 expired rows waiting');
select is((select count(*)::int from public.limits_cache where expires_at <= now()), 50, 'purges exactly 100 of them');
select is((select count(*)::int from public.limits_cache where segment_key = 'ffffffffffffffff'), 1, 'and leaves a live row alone');
select lives_ok($$ select public.put_limits_cache('purge-2', '{"type":"LineString","coordinates":[[-122.41,47.73],[-122.409,47.73]]}', 35, null, 7) $$, 'the next cache write');
select is((select count(*)::int from public.limits_cache where expires_at <= now()), 0, 'purges the remaining 50');
select is((select count(*)::int from public.limits_cache), 3, 'leaving the live row and the two new answers');

-- ---------------------------------------------------------------------------
-- take_rate_limit: upsert-and-count under a row lock
-- ---------------------------------------------------------------------------
reset role;
insert into auth.users (id, email) values ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'b1a@example.com');
set local role service_role;
select is(array[public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 2),
                public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 2),
                public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 2)],
  array[true, true, false], 'two takes pass and the third in the window is refused');
select is((select count from public.rate_limits where user_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4' and key = 'aws_limits'), 2, 'a refused take is not counted');
select is(public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'other_budget', '1 day', 2), true, 'another key has its own budget');
reset role;
update public.rate_limits set window_start = now() - interval '1 day' where user_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4' and key = 'aws_limits';
set local role service_role;
select is(public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 2), true, 'once the window has passed the budget is fresh');
select is((select row(count, window_start = now())::text from public.rate_limits where user_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4' and key = 'aws_limits'), row(1, true)::text,
  'the new window starts now with one take');
select throws_ok($$ select public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '1 day', 0) $$, '22023', 'max must be between 1 and 100000', 'a zero budget is refused');
select throws_ok($$ select public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'aws_limits', '0 seconds', 2) $$, '22023', 'window must be between 1 second and 31 days', 'an empty window is refused');
select throws_ok($$ select public.take_rate_limit('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'dispute_7d', '1 day', 2) $$, '22023', 'key must be a rate-limit key', 'the dispute mutex row is not a rate-limit key');
select throws_ok($$ select public.take_rate_limit(null, 'aws_limits', '1 day', 2) $$, '22023', 'user is required', 'a missing user is refused');

-- ---------------------------------------------------------------------------
-- truncation: past 2000 segments minor roads are cut first, and the tile says so
-- ---------------------------------------------------------------------------
reset role;
insert into osm.ways (osm_id, geom, highway, maxspeed_mph)
  select 8000000000 + i,
    extensions.st_setsrid(extensions.st_makeline(extensions.st_makepoint(-122.3280, 47.6300 + i * 0.000002), extensions.st_makepoint(-122.3270, 47.6300 + i * 0.000002)), 4326),
    'residential', 25
  from generate_series(1, 2001) i;
insert into osm.ways (osm_id, geom, highway, maxspeed_mph)
  values (9999999999, extensions.st_geomfromtext('LINESTRING(-122.3285 47.6320, -122.3265 47.6320)', 4326), 'motorway', 60);
set local role service_role;
create temporary table b1_dense as select pg_temp.tile(public.speed_limit_tiles(array[pg_temp.tile_of(47.6320, -122.3275)]), pg_temp.tile_of(47.6320, -122.3275)) as t;
select is((select (t -> 'truncated')::boolean from b1_dense), true, 'a tile past 2000 segments says it is truncated');
select is((select jsonb_array_length(t -> 'segments') from b1_dense), 2000, 'and carries exactly 2000');
select is((select count(*)::int from b1_dense, jsonb_array_elements(t -> 'segments') s where s ->> 'id' = '9999999999'), 1,
  'the motorway survives the cut although its key sorts last');
select is((select count(*)::int from public.speed_limit_candidates(47.6320, -122.3275, 5)), 20, 'candidates are capped at 20 rows');

reset role;

-- ---------------------------------------------------------------------------
-- catch-all
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'osm', 'hpms') and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'no table in public, osm or hpms is missing RLS');

select * from finish();
rollback;
