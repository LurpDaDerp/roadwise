-- `feature_flags` is not seeded here: migration 0005_app_config_flags.sql inserts it on every
-- database, hosted ones included (`db push` never runs this file)
insert into public.app_config (key, value, is_public) values
  ('min_app_version', '"2.0.0"', true)
on conflict (key) do update set value = excluded.value;

-- Synthetic speed-limit fixture (plan R6), laid along the replay traces in Seattle. Nothing here is
-- real OSM or HPMS data: the ids sit far above any real OSM way id and the geometry is drawn by hand.
--   9000000001  the corridor: primary, 35 mph, lat 47.6062 from lng -122.3330 to -122.2990. It spans
--               z15 columns 5248..5252 of row 11443; the speeding-corrected trace (lng -122.3321 to
--               -122.3009) crosses 15/5249/11443, 15/5250/11443 and 15/5251/11443. The row edge is
--               4.1 m south, so the tiles' 30 m buffer puts it in row 11444 too.
--   9000000002  the parallel: residential, 25 mph, about 20 m north (lat 47.60638)
--   9000000003  a one-way primary_link ramp leaving the corridor south-southeast at lng -122.3005,
--               east of the trace's end
--   9000000004  an untagged residential way crossing the corridor north-south at lng -122.3200
--   9000000101  an HPMS section at 30 mph overlapping the untagged way
insert into osm.ways (osm_id, geom, highway, maxspeed_mph, maxspeed_raw, name, oneway) values
  (9000000001, extensions.st_geomfromtext('LINESTRING(-122.3330 47.6062, -122.2990 47.6062)', 4326), 'primary', 35, '35 mph', 'Synthetic Corridor', 0),
  (9000000002, extensions.st_geomfromtext('LINESTRING(-122.3330 47.60638, -122.2990 47.60638)', 4326), 'residential', 25, '25 mph', 'Synthetic Parallel', 0),
  (9000000003, extensions.st_geomfromtext('LINESTRING(-122.3005 47.6062, -122.2995 47.6040)', 4326), 'primary_link', 25, '25 mph', 'Synthetic Ramp', 1),
  (9000000004, extensions.st_geomfromtext('LINESTRING(-122.3200 47.6040, -122.3200 47.6085)', 4326), 'residential', null, null, 'Synthetic Crossing', 0)
on conflict (osm_id) do nothing;

insert into hpms.sections (id, geom, speed_limit_mph, f_system, state_code, route_id) values
  (9000000101, extensions.st_geomfromtext('MULTILINESTRING((-122.3200 47.6045, -122.3200 47.6080))', 4326), 30, 7, 53, 'SYNTHETIC-1')
on conflict (id) do nothing;
