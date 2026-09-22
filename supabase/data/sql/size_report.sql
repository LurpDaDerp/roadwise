-- size_report.sql: what an import loaded and what it costs on disk. Read-only.
--
-- The remote load is gated on these numbers (plan R6): the Supabase free plan's database is 500 MB
-- in all, and a single state's road data over 400 MB is too large to load there.
\set ON_ERROR_STOP on
\pset footer off

\echo '== on-disk size (table + TOAST + indexes)'
select c.oid::regclass as relation,
       pg_size_pretty(pg_relation_size(c.oid)) as heap,
       pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       round(pg_total_relation_size(c.oid) / 1048576.0, 1) as total_mb
from pg_class c
where c.oid in ('osm.ways'::regclass, 'hpms.sections'::regclass)
order by c.oid::regclass::text;

select pg_size_pretty(pg_total_relation_size('osm.ways') + pg_total_relation_size('hpms.sections')) as road_data_total,
       round((pg_total_relation_size('osm.ways') + pg_total_relation_size('hpms.sections')) / 1048576.0, 1) as road_data_mb,
       pg_size_pretty(pg_database_size(current_database())) as whole_database;

\echo '== rows'
select (select count(*) from osm.ways) as osm_ways,
       (select count(*) from osm.ways where maxspeed_mph is not null) as osm_with_limit,
       round(100.0 * (select count(*) from osm.ways where maxspeed_mph is not null) / nullif((select count(*) from osm.ways), 0), 1) as osm_limit_pct,
       (select count(*) from hpms.sections) as hpms_sections;

\echo '== OSM limit share by class (ways and length)'
select highway,
       count(*) as ways,
       count(maxspeed_mph) as with_limit,
       round(100.0 * count(maxspeed_mph) / count(*), 1) as pct_ways,
       round((sum(extensions.st_length(geom::extensions.geography)) / 1000)::numeric) as km,
       round((100.0 * sum(case when maxspeed_mph is not null then extensions.st_length(geom::extensions.geography) else 0 end)
             / nullif(sum(extensions.st_length(geom::extensions.geography)), 0))::numeric, 1) as pct_km
from osm.ways
group by highway
order by min(case highway
  when 'motorway' then 1 when 'motorway_link' then 2 when 'trunk' then 3 when 'trunk_link' then 4
  when 'primary' then 5 when 'primary_link' then 6 when 'secondary' then 7 when 'secondary_link' then 8
  when 'tertiary' then 9 when 'tertiary_link' then 10 when 'unclassified' then 11 else 12 end);

\echo '== OSM limits and one-way values'
select maxspeed_mph, count(*) as ways from osm.ways group by maxspeed_mph order by maxspeed_mph nulls first;
select oneway, count(*) as ways from osm.ways group by oneway order by oneway;

\echo '== HPMS by state and functional system'
select state_code, f_system, count(*) as sections,
       round((sum(extensions.st_length(geom::extensions.geography)) / 1000)::numeric) as km,
       round(max(extensions.st_length(geom::extensions.geography))::numeric) as longest_m
from hpms.sections group by state_code, f_system order by state_code, f_system nulls last;

\echo '== extent of the loaded data (lng/lat)'
select 'osm.ways' as source,
       round(extensions.st_xmin(e)::numeric, 4) as min_lng, round(extensions.st_ymin(e)::numeric, 4) as min_lat,
       round(extensions.st_xmax(e)::numeric, 4) as max_lng, round(extensions.st_ymax(e)::numeric, 4) as max_lat
from (select extensions.st_extent(geom) as e from osm.ways) x
union all
select 'hpms.sections',
       round(extensions.st_xmin(e)::numeric, 4), round(extensions.st_ymin(e)::numeric, 4),
       round(extensions.st_xmax(e)::numeric, 4), round(extensions.st_ymax(e)::numeric, 4)
from (select extensions.st_extent(geom) as e from hpms.sections) x;
