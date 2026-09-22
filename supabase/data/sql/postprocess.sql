-- postprocess.sql: after an import, drop the staging schema, make sure both GiST indexes exist,
-- order the tables along them and refresh the planner statistics.
--
-- 0004 already creates ways_geom_gist and sections_geom_gist; the `if not exists` forms keep this
-- file correct on a database where an operator dropped them for a faster bulk load. CLUSTER
-- rewrites each table in index order, so the rows one z15 tile needs sit on few pages instead of
-- being scattered in file order. It holds an exclusive lock for the rewrite (seconds for one
-- state), so run it, like the rest of the import, when no drive depends on the tables.
--
-- psql variable `cluster` (import scripts' CLUSTER, default 1): 0 skips the rewrite. CLUSTER writes
-- a new copy of each table before dropping the old one, so on a database close to its plan's size
-- limit skip it; the GiST index alone answers every query correctly (README, "Loading the hosted
-- project").
\set ON_ERROR_STOP on
select :'cluster' = '1' as do_cluster, :'cluster' in ('0', '1') as cluster_ok \gset
\if :cluster_ok
\else
do $$ begin raise exception 'cluster must be 0 or 1'; end $$;
\endif

drop schema if exists roadwise_stage cascade;

create index if not exists ways_geom_gist on osm.ways using gist (geom);
create index if not exists sections_geom_gist on hpms.sections using gist (geom);

\if :do_cluster
cluster osm.ways using ways_geom_gist;
cluster hpms.sections using sections_geom_gist;
\endif

analyze osm.ways;
analyze hpms.sections;
