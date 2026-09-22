#!/usr/bin/env bash
# Loads one state's HPMS sections (download.sh's hpms-<YEAR>-<ST>.gpkg, already limited to rows
# with a recorded speed limit) into hpms.sections. See README.md.
#
#   supabase/data/import-hpms.sh                          # Washington (WA, FIPS 53), local stack
#   STATE=OR STATE_CODE=41 supabase/data/import-hpms.sh   # another state
#   DB_URL=postgresql://... supabase/data/import-hpms.sh  # another database (user action)
#
# REPLACE=1 (the default) first deletes that state's sections only, so states load independently.
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DB_URL:=postgresql://postgres:postgres@127.0.0.1:54622/postgres}"
: "${STATE:=WA}"
: "${STATE_CODE:=53}"
: "${HPMS_YEAR:=2024}"
: "${REPLACE:=1}"

if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  url="$(printf '%s' "$DB_URL" | sed -E 's#@(127\.0\.0\.1|localhost)([:/])#@host.docker.internal\2#')"
  MSYS_NO_PATHCONV=1 exec docker run --rm --add-host=host.docker.internal:host-gateway \
    -e ROADWISE_IN_DOCKER=1 -e DB_URL="$url" -e STATE="$STATE" -e STATE_CODE="$STATE_CODE" \
    -e HPMS_YEAR="$HPMS_YEAR" -e REPLACE="$REPLACE" \
    -v "$mount:/work" -w /work "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash import-hpms.sh "$@"
fi
cd "$DATA_DIR"
case "$REPLACE" in 0|1) ;; *) echo "REPLACE must be 0 or 1" >&2; exit 2 ;; esac

gpkg="downloads/hpms-${HPMS_YEAR}-${STATE}.gpkg"
[ -s "$gpkg" ] || { echo "missing $gpkg: run download.sh with STATE=$STATE first" >&2; exit 1; }

psql_run() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
t0=$(date +%s); step=$t0
lap() { local now; now=$(date +%s); echo "-- $1: $((now - step)) s"; step=$now; }

psql_run -f sql/stage.sql

ogr2ogr -f PostgreSQL "PG:${DB_URL}" "$gpkg" hpms \
  -nln roadwise_stage.hpms -nlt MULTILINESTRING -lco GEOMETRY_NAME=geom -lco SPATIAL_INDEX=NONE \
  -lco UNLOGGED=ON -lco FID=ogc_fid --config PG_USE_COPY YES -gt 65536
lap "ogr2ogr stage"

psql_run -v source=hpms -v replace="$REPLACE" -v state_code="$STATE_CODE" -f sql/transform.sql
lap "transform"

psql_run -f sql/postprocess.sql
lap "postprocess"
psql_run -f sql/size_report.sql
echo "-- import-hpms total: $(( $(date +%s) - t0 )) s"
