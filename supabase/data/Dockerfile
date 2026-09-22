# The toolbox the Washington (or any state's) speed-limit import runs in: GDAL for ogr2ogr (OSM PBF
# and File Geodatabase readers, PostgreSQL writer), osmium for the road-class filter, psql for the
# SQL steps. Build once from the repository root:
#
#   docker build -t roadwise-data supabase/data
#
# The scripts in this directory re-run themselves inside this image when osmium is not installed
# on the host, so nothing else has to be installed locally.
#
# The base is pinned by digest as well as tag (security review M-1), so a re-pushed tag cannot change
# the tools that write the road data. osmium-tool is pinned to the Ubuntu 24.04 release build; the
# PostgreSQL client and curl follow the distribution's security updates. python3 (in the base)
# turns DB_URL into libpq's environment variables.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.4@sha256:4b94b5e76e8b5616a4d5dc38e6e20def10ab70c3487eeb923d90547372e70a03

RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool=1.16.0-1build1 postgresql-client curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

# ogr2ogr's OSM reader: report exactly the tags the transform needs (name, highway, maxspeed,
# maxspeed:forward, maxspeed:backward, oneway, junction) as columns on the `lines` layer, and
# nothing else. The stock file's z_order formula casts `layer` to an integer and is not needed. The grep fails the build if the stock file
# ever changes shape and the edit stops applying.
RUN sed -e '/^\[lines\]/,/^\[multipolygons\]/{s/^attributes=.*/attributes=name,highway,maxspeed,maxspeed:forward,maxspeed:backward,oneway,junction/;s/^#other_tags=no/other_tags=no/;s/^computed_attributes=z_order/#&/;s/^z_order_/#z_order_/}' \
      /usr/share/gdal/osmconf.ini > /usr/local/share/roadwise-osmconf.ini \
 && sed -n '/^\[lines\]/,/^\[multipolygons\]/p' /usr/local/share/roadwise-osmconf.ini \
      | grep -q '^attributes=name,highway,maxspeed,maxspeed:forward,maxspeed:backward,oneway,junction$' \
 && sed -n '/^\[lines\]/,/^\[multipolygons\]/p' /usr/local/share/roadwise-osmconf.ini | grep -q '^other_tags=no$'

ENV OSM_CONFIG_FILE=/usr/local/share/roadwise-osmconf.ini
WORKDIR /work
