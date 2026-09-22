#!/usr/bin/env bash
# Loads one OSM extract (download.sh) into osm.ways: the twelve road classes, maxspeed parsed to mph
# by osm.parse_maxspeed_mph, oneway normalised to -1/0/1. See README.md.
#
#   supabase/data/import-osm.sh                                   # Washington, local stack
#   REGION=north-america/us/oregon REPLACE=0 supabase/data/import-osm.sh   # add a neighbour
#   DB_URL=postgresql://... supabase/data/import-osm.sh           # another database (user action)
#
# REPLACE=1 (the default) empties osm.ways first, so a re-run leaves exactly the extract's ways
# (and on a local stack it also removes seed.sql's synthetic fixture; `supabase db reset` brings it
# back). REPLACE=0 upserts by way id, for loading several extracts side by side.
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DB_URL:=postgresql://postgres:postgres@127.0.0.1:54622/postgres}"
: "${REGION:=north-america/us/washington}"
: "${REPLACE:=1}"
# bare-number limits north of this latitude are Canadian km/h (see sql/transform.sql). 49 is
# Washington's whole border with British Columbia; set it for another northern-border extract, or
# KMH_NORTH_OF= (empty) for an extract with no Canadian roads
if [ -z "${KMH_NORTH_OF+x}" ]; then
  case "$REGION" in */washington) KMH_NORTH_OF=49 ;; *) KMH_NORTH_OF= ;; esac
fi

if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  url="$(printf '%s' "$DB_URL" | sed -E 's#@(127\.0\.0\.1|localhost)([:/])#@host.docker.internal\2#')"
  MSYS_NO_PATHCONV=1 exec docker run --rm --add-host=host.docker.internal:host-gateway \
    -e ROADWISE_IN_DOCKER=1 -e DB_URL="$url" -e REGION="$REGION" -e REPLACE="$REPLACE" -e KMH_NORTH_OF="$KMH_NORTH_OF" \
    -v "$mount:/work" -w /work "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash import-osm.sh "$@"
fi
cd "$DATA_DIR"
case "$REPLACE" in 0|1) ;; *) echo "REPLACE must be 0 or 1" >&2; exit 2 ;; esac

name="$(basename "$REGION")"
pbf="downloads/${name}-latest.osm.pbf"
roads="downloads/${name}-roads.osm.pbf"
[ -s "$pbf" ] || { echo "missing $pbf: run download.sh first" >&2; exit 1; }

psql_run() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
t0=$(date +%s); step=$t0
lap() { local now; now=$(date +%s); echo "-- $1: $((now - step)) s"; step=$now; }

# 1. the twelve classes; referenced nodes come along so the ways keep their geometry
osmium tags-filter "$pbf" \
  w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link \
  --overwrite -o "$roads"
lap "osmium tags-filter"

# 2. staging schema and the parser
psql_run -f sql/stage.sql
psql_run -f sql/parse_maxspeed.sql

# 3. ways -> roadwise_stage.osm_lines (OSM_CONFIG_FILE, set by the image, makes maxspeed, oneway and
#    junction columns). A way crossing the extract's edge is complete in Geofabrik extracts.
ogr2ogr -f PostgreSQL "PG:${DB_URL}" "$roads" lines \
  -nln roadwise_stage.osm_lines -nlt LINESTRING -lco GEOMETRY_NAME=geom -lco SPATIAL_INDEX=NONE \
  -lco UNLOGGED=ON -lco FID=ogc_fid --config PG_USE_COPY YES -gt 65536 \
  -where "highway IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link')"
lap "ogr2ogr stage"

# 4. into osm.ways
psql_run -v source=osm -v replace="$REPLACE" -v kmh_north_of="$KMH_NORTH_OF" -f sql/transform.sql
lap "transform"

# 5. indexes, clustering, statistics; then what it cost
psql_run -f sql/postprocess.sql
lap "postprocess"
psql_run -f sql/size_report.sql
echo "-- import-osm total: $(( $(date +%s) - t0 )) s"
