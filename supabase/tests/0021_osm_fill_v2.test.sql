-- 0021_osm_fill_v2: more road classes, versioned cells, an empty cell checked again after a day,
-- a refill that drops the ways it no longer finds, unless it came back far smaller than the last
-- fill. Cells (100, 100) and (102, 102) are 10.0..10.1° and 10.2..10.3°, away from seed.sql's fixture.
create extension if not exists pgtap with schema extensions;

begin;
select plan(39);

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select has_column('osm', 'ways', 'seen_at', 'osm.ways has seen_at');
select col_not_null('osm', 'ways', 'seen_at', 'seen_at is never null');
select has_column('osm', 'filled_cells', 'fill_version', 'osm.filled_cells has fill_version');
select hasnt_function('public', 'osm_claim_fill_cell', array['int', 'int'], 'the two-argument claim is gone (no overload for PostgREST to choose between)');
select hasnt_function('public', 'osm_finish_fill_cell', array['int', 'int', 'text', 'int'], 'the four-argument finish is gone');
select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'service_role', array['EXECUTE'], 'service_role calls osm_claim_fill_cell');
select function_privs_are('public', 'osm_finish_fill_cell', array['int', 'int', 'text', 'int', 'int'], 'service_role', array['EXECUTE'], 'service_role calls osm_finish_fill_cell');
select function_privs_are('public', 'osm_finish_fill_cell', array['int', 'int', 'text', 'int', 'int'], 'anon', '{}'::name[], 'anon cannot call osm_finish_fill_cell');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- the classes and the stamp
-- ---------------------------------------------------------------------------
select is(public.osm_upsert_ways($$[
  {"id": 9200000001, "highway": "living_street", "maxspeed_mph": null, "maxspeed_raw": null, "name": "Woonerf", "oneway": 0, "line": [[10.01, 10.01], [10.011, 10.01]]},
  {"id": 9200000002, "highway": "road", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[10.01, 10.02], [10.011, 10.02]]},
  {"id": 9200000003, "highway": "service", "maxspeed_mph": 15, "maxspeed_raw": "15 mph", "name": "Park Road", "oneway": 0, "line": [[10.01, 10.03], [10.011, 10.03]]},
  {"id": 1125899916842624, "highway": "secondary", "maxspeed_mph": 45, "maxspeed_raw": "45 mph", "name": null, "oneway": -1, "line": [[10.01, 10.04], [10.011, 10.04]]},
  {"id": 9200000005, "highway": "footway", "maxspeed_mph": null, "maxspeed_raw": null, "name": null, "oneway": 0, "line": [[10.01, 10.05], [10.011, 10.05]]}
]$$::jsonb), 4, 'a living street, a road, a service road and a backward-direction row (2^50 above its way) are stored; a footway is not');
select is((select array_agg(highway order by osm_id) from osm.ways where osm_id between 9200000001 and 9200000005 or osm_id = 1125899916842624),
  array['living_street', 'road', 'service', 'secondary'], 'with their classes');
select is((select count(*) from osm.ways where osm_id between 9200000001 and 9200000003 and seen_at = now()), 3::bigint, 'each stamped seen now');

reset role;
update osm.ways set seen_at = now() - interval '2 days' where osm_id = 9200000001;
set local role service_role;
select is(public.osm_upsert_ways($$[
  {"id": 9200000001, "highway": "living_street", "maxspeed_mph": null, "maxspeed_raw": null, "name": "Woonerf", "oneway": 0, "line": [[10.01, 10.01], [10.011, 10.01]]}
]$$::jsonb), 1, 'an unchanged way given again counts as stored');
select is((select seen_at from osm.ways where osm_id = 9200000001), now(), 'and is stamped seen again');

-- ---------------------------------------------------------------------------
-- versions and empty cells
-- ---------------------------------------------------------------------------
select is(public.osm_claim_fill_cell(100, 100, 2), 'claimed', 'a new cell is claimed');
select is(public.osm_finish_fill_cell(100, 100, 'done', 4, 2), true, 'and finished done by version 2');
select is((select row(status, way_count, fill_version)::text from osm.filled_cells where cell_y = 100 and cell_x = 100), row('done', 4, 2)::text, 'done, 4 ways, version 2');
select is(public.osm_claim_fill_cell(100, 100, 2), 'done', 'the same version finds it done');
select is(public.osm_claim_fill_cell(100, 100), 'done', 'so does the code deployed before 0021 (version 1 by default)');
select is(public.osm_claim_fill_cell(100, 100, 3), 'claimed', 'a newer version fills it again');
select is(public.osm_finish_fill_cell(100, 100, 'failed', null, 3), true, 'a failed refill');
select is((select row(status, fill_version)::text from osm.filled_cells where cell_y = 100 and cell_x = 100), row('failed', 2)::text, 'keeps the version it was filled with');

select is(public.osm_claim_fill_cell(101, 101, 2), 'claimed', 'another cell');
select is(public.osm_finish_fill_cell(101, 101, 'done', 0, 2), true, 'done with no ways');
select is(public.osm_claim_fill_cell(101, 101, 2), 'done', 'an empty cell under a day old is done');
reset role;
update osm.filled_cells set filled_at = now() - interval '25 hours' where cell_y = 101 and cell_x = 101;
set local role service_role;
select is(public.osm_claim_fill_cell(101, 101, 2), 'claimed', 'over a day old it is checked again');

select throws_ok($$ select public.osm_claim_fill_cell(1, 1, 0) $$, '22023', 'version must be at least 1', 'a version under 1 is refused');

-- ---------------------------------------------------------------------------
-- a refill drops the ways it no longer finds
-- ---------------------------------------------------------------------------
reset role;
-- cell 100/100 is claimed afresh; its ways: 9200000001 seen now (this fill), 9200000002 seen 2 days
-- ago (gone from OSM), a stale way crossing into the next cell, and a stale way in another cell.
update osm.filled_cells set status = 'filling', claimed_at = now() where cell_y = 100 and cell_x = 100;
update osm.ways set seen_at = now() - interval '2 days' where osm_id in (9200000002, 9200000003);
insert into osm.ways (osm_id, geom, highway, oneway, seen_at) values
  (9200000010, extensions.st_setsrid(extensions.st_makeline(extensions.st_makepoint(10.09, 10.05), extensions.st_makepoint(10.12, 10.05)), 4326), 'residential', 0, now() - interval '2 days'),
  (9200000011, extensions.st_setsrid(extensions.st_makeline(extensions.st_makepoint(10.15, 10.05), extensions.st_makepoint(10.16, 10.05)), 4326), 'residential', 0, now() - interval '2 days');
set local role service_role;
select is(public.osm_finish_fill_cell(100, 100, 'done', 2, 3), true, 'the refill finishes done');
select is((select array_agg(osm_id order by osm_id) from osm.ways where osm_id between 9200000001 and 9200000011 or osm_id = 1125899916842624),
  array[9200000001, 9200000010, 9200000011, 1125899916842624]::bigint[],
  'the ways it did not see inside the cell are gone; the one it saw, the one crossing the edge and the one outside stay');

-- ---------------------------------------------------------------------------
-- a fill far smaller than the last one deletes nothing and is fetched again
-- ---------------------------------------------------------------------------
select has_column('osm', 'filled_cells', 'suspect_fills', 'osm.filled_cells counts the suspect fills');
select is(public.osm_claim_fill_cell(102, 102, 2), 'claimed', 'a cell');
select is(public.osm_finish_fill_cell(102, 102, 'done', 100, 2), true, 'filled with 100 ways');
reset role;
insert into osm.ways (osm_id, geom, highway, oneway, seen_at) values
  (9200000020, extensions.st_setsrid(extensions.st_makeline(extensions.st_makepoint(10.25, 10.25), extensions.st_makepoint(10.26, 10.25)), 4326), 'primary', 0, now() - interval '2 days');
update osm.filled_cells set status = 'filling', claimed_at = now() where cell_y = 102 and cell_x = 102;
set local role service_role;
select is(public.osm_finish_fill_cell(102, 102, 'done', 0, 2), true, 'a whole reply with no ways');
select is((select row(status, way_count, fill_version, suspect_fills)::text from osm.filled_cells where cell_y = 102 and cell_x = 102),
  row('failed', 100, 2, 1)::text, 'is not trusted: failed (fetched again in 10 minutes), the count and version kept');
select is((select count(*) from osm.ways where osm_id = 9200000020), 1::bigint, 'and the ways it did not return are kept');
reset role;
update osm.filled_cells set status = 'filling', claimed_at = now() where cell_y = 102 and cell_x = 102;
set local role service_role;
select is(public.osm_finish_fill_cell(102, 102, 'done', 49, 2), true, 'under half the last count');
select is((select row(status, way_count, suspect_fills)::text from osm.filled_cells where cell_y = 102 and cell_x = 102), row('failed', 100, 2)::text, 'is not trusted either');
reset role;
update osm.filled_cells set status = 'filling', claimed_at = now() where cell_y = 102 and cell_x = 102;
set local role service_role;
select is(public.osm_finish_fill_cell(102, 102, 'done', 40, 2), true, 'the third such fill in a row');
select is((select row(status, way_count, suspect_fills)::text from osm.filled_cells where cell_y = 102 and cell_x = 102), row('done', 40, 0)::text, 'stands');
select is((select count(*) from osm.ways where osm_id = 9200000020), 1::bigint, 'and still deletes nothing');

select * from finish();
rollback;
