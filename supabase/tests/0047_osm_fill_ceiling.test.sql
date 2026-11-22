-- 0047_osm_fill_ceiling: once osm.ways is at the ceiling, a cell that has never loaded is not
-- claimed ('full', no row written); a cell that has loaded is claimed exactly as before. Cells
-- (104..109, 104) are 10.4..11.0°, away from seed.sql's fixture and the other fill tests.
create extension if not exists pgtap with schema extensions;

begin;
select plan(26);

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select has_table('osm', 'fill_ceiling', 'osm.fill_ceiling exists');
select is((select array_agg(max_bytes) from osm.fill_ceiling), array[262144000::bigint], 'one row: the ceiling starts at 250 MB');
select throws_ok($$insert into osm.fill_ceiling (max_bytes) values (1)$$, '23505', null, 'a second row is refused');
select throws_ok($$insert into osm.fill_ceiling (id, max_bytes) values (false, 1)$$, '23514', null, 'the one row is the only row it can be');
select throws_ok($$update osm.fill_ceiling set max_bytes = 0$$, '23514', null, 'the ceiling is a positive size');
select is((select relrowsecurity from pg_class where oid = 'osm.fill_ceiling'::regclass), true, 'osm.fill_ceiling has RLS enabled');
select table_privs_are('osm', 'fill_ceiling', 'service_role', array['SELECT']::name[], 'service_role only reads the ceiling');
select table_privs_are('osm', 'fill_ceiling', 'authenticated', '{}'::name[], 'authenticated has no privileges on the ceiling');
select table_privs_are('osm', 'fill_ceiling', 'anon', '{}'::name[], 'anon has no privileges on the ceiling');
select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'service_role', array['EXECUTE'], 'service_role still calls osm_claim_fill_cell');
select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'authenticated', '{}'::name[], 'authenticated still cannot');
select function_privs_are('public', 'osm_claim_fill_cell', array['int', 'int', 'int'], 'anon', '{}'::name[], 'anon still cannot');

-- cells as the fill leaves them: loaded 31 days ago (its refresh due), loaded today, loaded an hour
-- ago by road-layer version 2, and one released before it ever loaded
insert into osm.filled_cells (cell_y, cell_x, status, claimed_at, filled_at, way_count, fill_version) values
  (104, 104, 'done', now() - interval '31 days', now() - interval '31 days', 5, 3),
  (105, 104, 'done', now(), now(), 5, 3),
  (106, 104, 'done', now() - interval '1 hour', now() - interval '1 hour', 5, 2),
  (107, 104, 'released', now() - interval '1 hour', null, 0, 1);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- below the ceiling: nothing changes
-- ---------------------------------------------------------------------------
select is(public.osm_claim_fill_cell(108, 104, 3), 'claimed', 'below the ceiling, an area never loaded is claimed');
select is(public.osm_claim_fill_cell(105, 104, 3), 'done', 'and a loaded one is done');

-- ---------------------------------------------------------------------------
-- at the ceiling
-- ---------------------------------------------------------------------------
reset role;
update osm.fill_ceiling set max_bytes = 1;
set local role service_role;

select is(public.osm_claim_fill_cell(109, 104, 3), 'full', 'at the ceiling, an area never loaded is not claimed');
select is((select count(*)::int from osm.filled_cells where cell_y = 109 and cell_x = 104), 0, 'and no row is written for it');
select is(public.osm_claim_fill_cell(107, 104, 3), 'full', 'a cell released before it ever loaded is not claimed either');
select is((select status from osm.filled_cells where cell_y = 107 and cell_x = 104), 'released', 'its row is left as it was');
select is(public.osm_claim_fill_cell(108, 104, 3), 'full', 'a cell still filling that never loaded reads full (the function reads it as filling)');
select is(public.osm_claim_fill_cell(104, 104, 3), 'claimed', 'a loaded cell due its 30-day refresh is still claimed');
select is(public.osm_claim_fill_cell(106, 104, 3), 'claimed', 'a cell loaded by an older road-layer version is still claimed');
select is(public.osm_claim_fill_cell(105, 104, 3), 'done', 'a fresh loaded cell is still done');
select is(public.osm_finish_fill_cell(104, 104, 'done', 6, 3), true, 'and a refill finishes as before');

-- ---------------------------------------------------------------------------
-- the owner raises it, or removes it
-- ---------------------------------------------------------------------------
reset role;
update osm.fill_ceiling set max_bytes = 4294967296;
set local role service_role;
select is(public.osm_claim_fill_cell(109, 104, 3), 'claimed', 'a raised ceiling lets new areas load again');

reset role;
update osm.fill_ceiling set max_bytes = 1;
delete from osm.fill_ceiling;
set local role service_role;
select is(public.osm_claim_fill_cell(107, 104, 3), 'claimed', 'with no row there is no ceiling');

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.osm_claim_fill_cell(110, 104, 3)$$, '42501', null, 'the claim still requires the service role');

select * from finish();
rollback;
