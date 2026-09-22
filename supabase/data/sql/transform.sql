-- transform.sql: staged source rows -> osm.ways or hpms.sections, in one transaction per run.
--
-- psql variables (set by import-osm.sh / import-hpms.sh):
--   source      'osm' or 'hpms'
--   replace     1: replace what this source holds (osm: every way; hpms: this state's sections)
--               0: upsert, for adding a neighbouring extract to what is already loaded
--   state_code  hpms only: the state's FIPS code (53 for Washington); every staged row must match
--   kmh_north_of  osm only: a latitude north of which the roads are Canadian ('' for none). An
--               extract keeps every way that crosses its edge whole, so Washington's carries some
--               700 British Columbia roads, where a bare `maxspeed=50` means 50 km/h, not 50 mph.
--               A bare-integer limit on any way reaching north of this line is dropped (the road
--               stays, unknown); an explicit '... mph' is kept. Washington's border with British
--               Columbia is the 49th parallel along its whole length, so the import passes 49.
--
-- Nothing reaches the tables that the device's all-or-nothing tile schema would reject: 0004's
-- CHECKs hold the classes, the 5..85 range and the text bounds, and the filters below drop what
-- would fail them instead of aborting the load. An HPMS section is loaded only with a limit.
\set ON_ERROR_STOP on
select :'source' = 'osm' as is_osm, :'source' = 'hpms' as is_hpms, :'replace' = '1' as is_replace \gset
\if :is_osm
\elif :is_hpms
\else
do $$ begin raise exception 'source must be osm or hpms'; end $$;
\endif

begin;

\if :is_osm
-- -----------------------------------------------------------------------------------------------
-- OSM: ogr2ogr's `lines` layer, with name/highway/maxspeed/oneway/junction as columns
-- -----------------------------------------------------------------------------------------------
select :'kmh_north_of' = '' as no_kmh_line, :'kmh_north_of' ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' as kmh_line_ok \gset
\if :no_kmh_line
select 91 as kmh_lat \gset
\elif :kmh_line_ok
select :'kmh_north_of'::double precision as kmh_lat \gset
\else
do $$ begin raise exception 'kmh_north_of must be a latitude or empty'; end $$;
\endif
\if :is_replace
truncate osm.ways;
\endif

create temporary table osm_in on commit drop as
select distinct on (l.osm_id::bigint)
  l.osm_id::bigint as osm_id,
  extensions.st_setsrid(extensions.st_force2d(l.geom), 4326) as geom,
  l.highway,
  case
    -- a bare number on a road reaching into Canada is km/h: never read it as mph
    when btrim(l.maxspeed) ~ '^[0-9]+$' and extensions.st_ymax(l.geom) > :kmh_lat then null
    else osm.parse_maxspeed_mph(l.maxspeed)
  end as maxspeed_mph,
  -- the raw tag is kept for audit; a value past the column's 64 characters is never a limit anyway
  case when char_length(l.maxspeed) <= 64 then l.maxspeed end as maxspeed_raw,
  left(l.name, 128) as name,
  -- `oneway` normalised to the table's -1/0/1. OSM implies one-way on motorways and roundabouts
  -- when the tag is absent; an explicit tag always wins. reversible/alternating ways run both ways
  -- over a day, so they are 0 and the matcher accepts either direction
  case
    when lower(btrim(l.oneway)) in ('yes', 'true', '1') then 1
    when lower(btrim(l.oneway)) in ('-1', 'reverse') then -1
    when l.oneway is not null then 0
    when l.highway = 'motorway' or lower(l.junction) in ('roundabout', 'circular') then 1
    else 0
  end::smallint as oneway
from roadwise_stage.osm_lines l
where l.osm_id ~ '^[1-9][0-9]{0,17}$'
  and l.highway in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link')
  and l.geom is not null
  and extensions.st_geometrytype(l.geom) = 'ST_LineString'
  and extensions.st_npoints(l.geom) >= 2
  and extensions.st_length(l.geom) > 0
order by l.osm_id::bigint;

insert into osm.ways (osm_id, geom, highway, maxspeed_mph, maxspeed_raw, name, oneway)
select osm_id, geom, highway, maxspeed_mph, maxspeed_raw, name, oneway from osm_in
on conflict (osm_id) do update
  set geom = excluded.geom, highway = excluded.highway, maxspeed_mph = excluded.maxspeed_mph,
      maxspeed_raw = excluded.maxspeed_raw, name = excluded.name, oneway = excluded.oneway
  where (osm.ways.geom, osm.ways.highway, osm.ways.maxspeed_mph, osm.ways.maxspeed_raw, osm.ways.name, osm.ways.oneway)
    is distinct from (excluded.geom, excluded.highway, excluded.maxspeed_mph, excluded.maxspeed_raw, excluded.name, excluded.oneway);

\echo 'osm: staged / accepted / with a limit / tagged but not a limit / bare number dropped as km/h'
select (select count(*) from roadwise_stage.osm_lines) as staged,
       (select count(*) from osm_in) as accepted,
       (select count(*) from osm_in where maxspeed_mph is not null) as with_limit,
       (select count(*) from osm_in where maxspeed_mph is null and maxspeed_raw is not null) as tag_not_a_limit,
       (select count(*) from osm_in where maxspeed_mph is null and osm.parse_maxspeed_mph(maxspeed_raw) is not null) as kmh_dropped;

\echo 'osm: maxspeed values the parser refused, most common first'
select maxspeed_raw, count(*) as ways from osm_in
where maxspeed_mph is null and maxspeed_raw is not null
group by maxspeed_raw order by count(*) desc, maxspeed_raw limit 25;

\else
-- -----------------------------------------------------------------------------------------------
-- HPMS: download.sh's extract, already filtered to speed_limit IS NOT NULL AND < 999
-- -----------------------------------------------------------------------------------------------
select :'state_code' ~ '^[1-9][0-9]?$' as state_ok \gset
\if :state_ok
\else
do $$ begin raise exception 'state_code must be a FIPS state code such as 53'; end $$;
\endif

-- a staged row from another state means the wrong extract was loaded: stop before deleting anything
select count(*) = 0 as states_match from roadwise_stage.hpms where state_id is distinct from :state_code \gset
\if :states_match
\else
do $$ begin raise exception 'the staged HPMS rows are not all from the requested state'; end $$;
\endif

\if :is_replace
delete from hpms.sections where state_code = :state_code;
\endif

-- the section id is stable within one HPMS release: the state's FIPS code, then the feature's
-- OBJECTID (530000004273 for Washington's 4273). At most 12 digits, so the tile id and candidate
-- key stay far inside the device's 24 characters, and unique across states
create temporary table hpms_in on commit drop as
select
  h.state_id::bigint * 10000000000 + h.objectid::bigint as id,
  extensions.st_multi(extensions.st_setsrid(extensions.st_force2d(h.geom), 4326)) as geom,
  h.speed_limit::smallint as speed_limit_mph,
  case when h.f_system between 1 and 7 then h.f_system::smallint end as f_system,
  h.state_id::smallint as state_code,
  left(h.route_id, 64) as route_id
from roadwise_stage.hpms h
where h.speed_limit between 5 and 85
  and h.objectid between 1 and 9999999999
  and h.geom is not null
  and extensions.st_geometrytype(h.geom) in ('ST_MultiLineString', 'ST_LineString')
  and not extensions.st_isempty(h.geom)
  and extensions.st_length(h.geom) > 0;

insert into hpms.sections (id, geom, speed_limit_mph, f_system, state_code, route_id)
select id, geom, speed_limit_mph, f_system, state_code, route_id from hpms_in
on conflict (id) do update
  set geom = excluded.geom, speed_limit_mph = excluded.speed_limit_mph, f_system = excluded.f_system,
      state_code = excluded.state_code, route_id = excluded.route_id
  where (hpms.sections.geom, hpms.sections.speed_limit_mph, hpms.sections.f_system, hpms.sections.route_id)
    is distinct from (excluded.geom, excluded.speed_limit_mph, excluded.f_system, excluded.route_id);

\echo 'hpms: staged / accepted / limit outside 5..85 (dropped)'
select (select count(*) from roadwise_stage.hpms) as staged,
       (select count(*) from hpms_in) as accepted,
       (select count(*) from roadwise_stage.hpms where speed_limit not between 5 and 85) as limit_out_of_range;
\endif

commit;
