-- 0013_osm_fill: the self-filling road layer's cell claims, the batch upsert into osm.ways, and the
-- single-point get_current_speed_limit, over seed.sql's synthetic fixture (see 0002's test header).
create extension if not exists pgtap with schema extensions;

begin;
select plan(77);

-- ---------------------------------------------------------------------------
-- posture: table, RLS, grants
-- ---------------------------------------------------------------------------
select has_table('osm', 'filled_cells', 'osm.filled_cells exists');
select is((select relrowsecurity from pg_class where oid = 'osm.filled_cells'::regclass), true, 'osm.filled_cells has RLS enabled');
select policies_are('osm', 'filled_cells', '{}'::name[], 'osm.filled_cells has no policies (server only)');
select table_privs_are('osm', 'filled_cells', 'anon', '{}'::name[], 'anon has no privileges on osm.filled_cells');
select table_privs_are('osm', 'filled_cells', 'authenticated', '{}'::name[], 'authenticated has no privileges on osm.filled_cells');
select table_privs_are('osm', 'filled_cells', 'service_role', array['SELECT', 'INSERT', 'UPDATE'], 'service_role reads and writes osm.filled_cells');
select table_privs_are('osm', 'ways', 'service_role', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'service_role may insert, update and (0021: a refill''s stale ways) delete osm.ways (the fill)');
select table_privs_are('osm', 'ways', 'authenticated', '{}'::name[], 'authenticated still has no privileges on osm.ways');

select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'anon', '{}'::name[], 'anon cannot call osm_claim_fill_cell');
select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'authenticated', '{}'::name[], 'authenticated cannot call osm_claim_fill_cell');
select function_privs_are('public', 'osm_finish_fill_cell', array['int', 'int', 'text', 'int', 'int'], 'authenticated', '{}'::name[], 'authenticated cannot call osm_finish_fill_cell');
select function_privs_are('public', 'osm_upsert_ways', array['jsonb'], 'authenticated', '{}'::name[], 'authenticated cannot call osm_upsert_ways');
select function_privs_are('public', 'get_current_speed_limit', array['double precision', 'double precision', 'double precision'], 'authenticated', '{}'::name[], 'authenticated cannot call get_current_speed_limit');
select function_privs_are('public', 'get_current_speed_limit', array['double precision', 'double precision', 'double precision'], 'service_role', array['EXECUTE'], 'service_role calls get_current_speed_limit');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4"}', true);
select throws_ok($$ select public.osm_claim_fill_cell(477, -1224) $$, '42501', null, 'authenticated is refused at the door of osm_claim_fill_cell');
select throws_ok($$ select count(*) from osm.filled_cells $$, '42501', null, 'authenticated cannot read osm.filled_cells');
reset role;

-- the writers refuse any JWT role but service_role in their first statement, even as the owner
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4"}', true);
select throws_ok($$ select public.osm_claim_fill_cell(477, -1224) $$, '42501', 'osm_claim_fill_cell requires the service role', 'osm_claim_fill_cell requires the service role');
select throws_ok($$ select public.osm_finish_fill_cell(477, -1224, 'done', 0) $$, '42501', 'osm_finish_fill_cell requires the service role', 'osm_finish_fill_cell requires the service role');
select throws_ok($$ select public.osm_upsert_ways('[]') $$, '42501', 'osm_upsert_ways requires the service role', 'osm_upsert_ways requires the service role');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- osm_claim_fill_cell / osm_finish_fill_cell
-- ---------------------------------------------------------------------------
select is(public.osm_claim_fill_cell(477, -1224), 'claimed', 'the first claim of a cell is claimed');
select is(public.osm_claim_fill_cell(477, -1224), 'filling', 'a second claim while it is being filled is filling');
select is((select row(status, attempts, way_count)::text from osm.filled_cells where cell_y = 477 and cell_x = -1224), row('filling', 1, 0)::text, 'the row is filling after one attempt');
select is(public.osm_finish_fill_cell(477, -1224, 'done', 1234), true, 'the claimant finishes it');
select is((select row(status, way_count, filled_at is not null)::text from osm.filled_cells where cell_y = 477 and cell_x = -1224), row('done', 1234, true)::text, 'done, with the way count and the fill time');
select is(public.osm_claim_fill_cell(477, -1224), 'done', 'a done cell answers done');
select is(public.osm_finish_fill_cell(477, -1224, 'done', 5), false, 'finishing a cell nobody holds changes nothing');
select is((select way_count from osm.filled_cells where cell_y = 477 and cell_x = -1224), 1234, 'and its count stands');

select is(public.osm_claim_fill_cell(0, 0), 'claimed', 'another cell has its own claim');
select is(public.osm_finish_fill_cell(0, 0, 'failed', null), true, 'a fill can fail');
select is((select status from osm.filled_cells where cell_y = 0 and cell_x = 0), 'failed', 'and the row says so');
select is(public.osm_claim_fill_cell(0, 0), 'filling', 'a cell that just failed is not retaken yet (it reads as filling)');
select is(public.osm_claim_fill_cell(3, 3), 'claimed', 'a cell is claimed');
select is(public.osm_finish_fill_cell(3, 3, 'released', null), true, 'and released (a budget was spent before anything was tried)');
select is((select row(status, way_count, filled_at)::text from osm.filled_cells where cell_y = 3 and cell_x = 3), row('released', 0, null::timestamptz)::text, 'released, nothing filled');
select is(public.osm_claim_fill_cell(3, 3), 'claimed', 'a released cell is claimable at once');
select is((select attempts from osm.filled_cells where cell_y = 3 and cell_x = 3), 2, 'as a second attempt');
select is(public.osm_claim_fill_cell(3, 3), 'filling', 'and held again');

select throws_ok($$ select public.osm_claim_fill_cell(900, 0) $$, '22023', 'cell must be a 0.1 degree grid cell: y in -900..899, x in -1800..1799', 'a cell off the grid is refused');
select throws_ok($$ select public.osm_claim_fill_cell(null, 0) $$, '22023', 'cell must be a 0.1 degree grid cell: y in -900..899, x in -1800..1799', 'a missing cell is refused');
select throws_ok($$ select public.osm_finish_fill_cell(0, 0, null, 0) $$, '22023', 'cell and an outcome of done, failed or released are required', 'a missing outcome is refused');
select throws_ok($$ select public.osm_finish_fill_cell(0, 0, 'ok', 0) $$, '22023', 'cell and an outcome of done, failed or released are required', 'an unknown outcome is refused');
select throws_ok($$ select public.osm_finish_fill_cell(0, 0, 'done', -1) $$, '22023', 'way_count must be at least 0', 'a negative count is refused');

-- stale and old claims are retaken (the clock is moved on the rows themselves)
reset role;
update osm.filled_cells set filled_at = now() - interval '31 days' where cell_y = 477 and cell_x = -1224;
-- the failure time is the touch trigger's updated_at: moved back with the trigger off
alter table osm.filled_cells disable trigger filled_cells_touch;
update osm.filled_cells set updated_at = now() - interval '11 minutes' where cell_y = 0 and cell_x = 0;
alter table osm.filled_cells enable trigger filled_cells_touch;
insert into osm.filled_cells (cell_y, cell_x, status, claimed_at) values (1, 1, 'filling', now() - interval '6 minutes');
insert into osm.filled_cells (cell_y, cell_x, status, claimed_at) values (2, 2, 'filling', now() - interval '4 minutes');
set local role service_role;
select is(public.osm_claim_fill_cell(477, -1224), 'claimed', 'a cell done over 30 days ago is refreshed');
select is((select attempts from osm.filled_cells where cell_y = 477 and cell_x = -1224), 2, 'counting the second attempt');
select is(public.osm_claim_fill_cell(0, 0), 'claimed', 'a cell that failed over 10 minutes ago is retaken');
select is(public.osm_claim_fill_cell(1, 1), 'claimed', 'a claim left filling for over 5 minutes is retaken');
select is(public.osm_claim_fill_cell(2, 2), 'filling', 'a claim 4 minutes old is still held');

-- ---------------------------------------------------------------------------
-- osm_upsert_ways
-- ---------------------------------------------------------------------------
select is(public.osm_upsert_ways($$[
  {"id": 9100000001, "highway": "residential", "maxspeed_mph": 25, "maxspeed_raw": "25 mph", "name": "Fill Street", "oneway": 0, "line": [[-122.31, 47.61], [-122.309, 47.61]]},
  {"id": 9100000002, "highway": "motorway_link", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 1, "line": [[-122.31, 47.612], [-122.309, 47.612], [-122.308, 47.6125]]},
  {"id": 9100000003, "highway": "footway", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[-122.31, 47.613], [-122.309, 47.613]]},
  {"id": 9100000004, "highway": "residential", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[-122.31, 47.614]]},
  {"id": 9100000005, "highway": "residential", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[-122.31, 47.615], [-122.31, 47.615]]},
  {"id": 9100000006, "highway": "residential", "maxspeed_mph": 120, "maxspeed_raw": "120 mph", "name": null, "oneway": 0, "line": [[-122.31, 47.616], [-122.309, 47.616]]},
  {"id": 9100000007, "highway": "residential", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[-200, 47.617], [-122.309, 47.617]]},
  {"id": -5, "highway": "residential", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[-122.31, 47.618], [-122.309, 47.618]]},
  "junk",
  {"id": 9100000001, "highway": "residential", "maxspeed_mph": 25, "maxspeed_raw": "25 mph", "name": "Fill Street", "oneway": 0, "line": [[-122.31, 47.61], [-122.309, 47.61]]}
]$$::jsonb), 3, 'three ways written: the tagged street, the ramp and the out-of-range limit (as untagged); the footway, the one-point line, the zero-length line, the off-globe point, the bad id, the junk and the duplicate are skipped');
select is((select row(highway, maxspeed_mph, maxspeed_raw, name, oneway, extensions.st_astext(geom))::text from osm.ways where osm_id = 9100000001),
  row('residential', 25::smallint, '25 mph', 'Fill Street', 0::smallint, 'LINESTRING(-122.31 47.61,-122.309 47.61)')::text, 'the street is stored as sent');
select is((select row(highway, maxspeed_mph, oneway, extensions.st_npoints(geom))::text from osm.ways where osm_id = 9100000002), row('motorway_link', null::smallint, 1::smallint, 3)::text, 'the ramp is one-way, untagged, three points');
select is((select row(maxspeed_mph, maxspeed_raw)::text from osm.ways where osm_id = 9100000006), row(null::smallint, '120 mph')::text, 'a limit outside 5..85 is stored as untagged, its raw text kept');
select is((select count(*) from osm.ways where osm_id in (9100000003, 9100000004, 9100000005, 9100000007)), 0::bigint, 'nothing unusable reached the table');

select is(public.osm_upsert_ways($$[
  {"id": 9100000001, "highway": "residential", "maxspeed_mph": 25, "maxspeed_raw": "25 mph", "name": "Fill Street", "oneway": 0, "line": [[-122.31, 47.61], [-122.309, 47.61]]}
]$$::jsonb), 1, 'an identical way again is stored again (0021: every way given is stamped seen)');
select is(public.osm_upsert_ways($$[
  {"id": 9100000001, "highway": "residential", "maxspeed_mph": 20, "maxspeed_raw": "20 mph", "name": "Fill Street", "oneway": 0, "line": [[-122.31, 47.61], [-122.309, 47.61]]},
  {"id": 9100000002, "highway": "motorway_link", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 1, "line": [[-122.309, 47.612], [-122.31, 47.612], [-122.308, 47.6125]]}
]$$::jsonb), 2, 'a changed limit and a changed vertex order both rewrite the row');
select is((select maxspeed_mph from osm.ways where osm_id = 9100000001), 20::smallint, 'the new limit is stored');
select is((select extensions.st_x(extensions.st_startpoint(geom)) from osm.ways where osm_id = 9100000002), -122.309::double precision, 'the new geometry is stored');

select throws_ok($$ select public.osm_upsert_ways('[]') $$, '22023', 'ways must be a JSON array of 1 to 1000 ways under 8 MB', 'an empty batch is refused');
select throws_ok($$ select public.osm_upsert_ways('{"id": 1}') $$, '22023', 'ways must be a JSON array of 1 to 1000 ways under 8 MB', 'a non-array is refused');
select throws_ok($$ select public.osm_upsert_ways(null) $$, '22023', 'ways must be a JSON array of 1 to 1000 ways under 8 MB', 'a missing batch is refused');
select throws_ok($$ select public.osm_upsert_ways((select jsonb_agg('{"id": 1}'::jsonb) from generate_series(1, 1001))) $$, '22023', 'ways must be a JSON array of 1 to 1000 ways under 8 MB', 'over 1000 ways is refused');

-- ---------------------------------------------------------------------------
-- get_current_speed_limit over the fixture (0002's seed) and the fill above
-- ---------------------------------------------------------------------------
select is((select row(osm_id, name, highway, limit_mph, is_default)::text from public.get_current_speed_limit(47.6062, -122.3160, 90)),
  row(9000000001, 'Synthetic Corridor', 'primary', 35, false)::text, 'eastbound on the corridor: its posted 35, not a default');
select ok((select distance_m < 0.5 from public.get_current_speed_limit(47.6062, -122.3160, 90)), 'and it is under half a metre away');
select is((select limit_mph from public.get_current_speed_limit(47.6062, -122.3160, 270)), 35, 'westbound too: the corridor is two-way');
select is((select row(osm_id, limit_mph, is_default)::text from public.get_current_speed_limit(47.606, -122.3200, 0)),
  row(9000000004, 25, true)::text, 'northbound on the untagged residential crossing: the 25 mph class default, flagged');
select is((select limit_mph from public.get_current_speed_limit(47.606, -122.3200, 180)), 25, 'and southbound, its reverse');
select is((select count(*) from public.get_current_speed_limit(47.606, -122.3200, 90)), 0::bigint, 'eastbound at the crossing (away from the corridor) no road runs along the heading: no row');
select is((select count(*) from public.get_current_speed_limit(47.606, -122.3200, 30)), 0::bigint, '30 degrees off the crossing is past the 25 degree tolerance: no row');
select is((select osm_id from public.get_current_speed_limit(47.606, -122.3200, 20)), 9000000004::bigint, '20 degrees off is within it');
select is((select count(*) from public.get_current_speed_limit(47.6062, -122.3005, 335)), 0::bigint, 'against the one-way ramp (heading 335 on a line digitised to 158): no row');
select is((select row(osm_id, limit_mph)::text from public.get_current_speed_limit(47.6050, -122.3000, 158)), row(9000000003, 25)::text, 'along the one-way ramp: its 25');
select is((select count(*) from public.get_current_speed_limit(47.6068, -122.3160, 90)), 0::bigint, '67 m north of the corridor, 47 m north of the parallel: both outside 20 m, no row');
select is((select osm_id from public.get_current_speed_limit(47.60635, -122.3160, 90)), 9000000002::bigint, 'nearer the parallel than the corridor: the parallel');
select is((select row(limit_mph, is_default)::text from public.get_current_speed_limit(47.612, -122.3095, 270)), row(45, true)::text, 'westbound on the filled one-way motorway ramp, untagged: the motorway_link default 45');
select is((select count(*) from public.get_current_speed_limit(47.612, -122.3095, 90)), 0::bigint, 'eastbound against that one-way ramp: no row');
select throws_ok($$ select * from public.get_current_speed_limit(91, -122.3160, 90) $$, '22023', 'lat must be between -90 and 90 and lon between -180 and 180', 'a latitude off the globe is refused');
select throws_ok($$ select * from public.get_current_speed_limit(47.6062, -122.3160, 360) $$, '22023', 'heading must be at least 0 and below 360', 'a heading of 360 is refused');
select throws_ok($$ select * from public.get_current_speed_limit(47.6062, -122.3160, null) $$, '22023', 'heading must be at least 0 and below 360', 'a missing heading is refused');

select * from finish();
rollback;
