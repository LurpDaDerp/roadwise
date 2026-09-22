-- stage.sql: an empty staging schema for one import run (import-osm.sh, import-hpms.sh).
--
-- ogr2ogr writes the raw source rows here; transform.sql moves the valid ones into osm.ways and
-- hpms.sections; postprocess.sql drops the schema. It never holds anything a client can reach: no
-- API role gets usage on it, and it exists only while an import runs.
\set ON_ERROR_STOP on
create schema if not exists roadwise_stage;
revoke all on schema roadwise_stage from public;
-- a previous run that stopped half-way may have left its tables behind
drop table if exists roadwise_stage.osm_lines;
drop table if exists roadwise_stage.hpms;
