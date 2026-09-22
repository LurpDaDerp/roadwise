#!/usr/bin/env bash
# Downloads the open road data one state's speed-limit import needs into supabase/data/downloads/
# (gitignored; never commit it):
#
#   * OpenStreetMap: Geofabrik's daily extract, <REGION>-latest.osm.pbf (ODbL 1.0,
#     "© OpenStreetMap contributors").
#   * HPMS: FHWA's Highway Performance Monitoring System, the national release BTS publishes in the
#     National Transportation Atlas Database (public domain, 17 U.S.C. § 105). It ships as one File
#     Geodatabase zip with a feature class per state (HPMS_FULL_<ST>_<YEAR>). That zip is kept, so
#     other states reuse it, and the state's sections with a recorded limit
#     (speed_limit IS NOT NULL AND speed_limit < 999) are extracted to hpms-<YEAR>-<ST>.gpkg.
#
# Endpoints, confirmed 2026-09-22:
#   OSM   https://download.geofabrik.de/<REGION>-latest.osm.pbf
#   HPMS  https://www.arcgis.com/sharing/rest/content/items/5e6a977c2d7c4ec1bdc82e684d3384f2/data
#         (BTS "Highway Performance Monitoring System (HPMS) 2024", HPMS2024.zip, 2.6 GB; landing page
#         https://geodata.bts.gov/datasets/5e6a977c2d7c4ec1bdc82e684d3384f2). FHWA's per-state
#         feature services (geo.dot.gov .../Hosted/HPMS_FULL_WA_2024/FeatureServer) are listed in
#         the server's directory but answer 404, and no SODA dataset carries HPMS geometry, so the
#         national zip is the current public source.
#
# Usage (defaults: Washington):
#   supabase/data/download.sh
#   REGION=north-america/us/oregon STATE=OR supabase/data/download.sh
#   FORCE=1 supabase/data/download.sh          # re-download even if the files are present
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REGION:=north-america/us/washington}"
: "${STATE:=WA}"
: "${HPMS_YEAR:=2024}"
: "${HPMS_ITEM:=5e6a977c2d7c4ec1bdc82e684d3384f2}"
: "${FORCE:=}"

if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  MSYS_NO_PATHCONV=1 exec docker run --rm -e ROADWISE_IN_DOCKER=1 \
    -e REGION="$REGION" -e STATE="$STATE" -e HPMS_YEAR="$HPMS_YEAR" -e HPMS_ITEM="$HPMS_ITEM" -e FORCE="$FORCE" \
    -v "$mount:/work" -w /work "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash download.sh "$@"
fi
cd "$DATA_DIR"
mkdir -p downloads

case "$STATE" in [A-Z][A-Z]) ;; *) echo "STATE must be a two-letter code such as WA" >&2; exit 2 ;; esac
case "$HPMS_YEAR" in [0-9][0-9][0-9][0-9]) ;; *) echo "HPMS_YEAR must be a year" >&2; exit 2 ;; esac

pbf="downloads/$(basename "$REGION")-latest.osm.pbf"
zip="downloads/HPMS${HPMS_YEAR}.zip"
gpkg="downloads/hpms-${HPMS_YEAR}-${STATE}.gpkg"

if [ -n "$FORCE" ] || [ ! -s "$pbf" ]; then
  echo "downloading OSM $REGION"
  curl -fSL --retry 5 -o "$pbf.part" "https://download.geofabrik.de/${REGION}-latest.osm.pbf"
  mv "$pbf.part" "$pbf"
fi

if [ -n "$FORCE" ] || [ ! -s "$zip" ]; then
  echo "downloading HPMS $HPMS_YEAR (national File Geodatabase, about 2.6 GB)"
  # -C - resumes an interrupted download of the same file
  curl -fSL --retry 5 -C - -o "$zip.part" "https://www.arcgis.com/sharing/rest/content/items/${HPMS_ITEM}/data"
  mv "$zip.part" "$zip"
fi

if [ -n "$FORCE" ] || [ ! -s "$gpkg" ]; then
  echo "extracting HPMS_FULL_${STATE}_${HPMS_YEAR} (sections with a recorded speed limit)"
  rm -f "$gpkg"
  # 2D lines in EPSG:4326 (the source is measured multilines); OBJECTID is kept as a column, which
  # import-hpms.sh turns into a stable section id
  ogr2ogr -f GPKG "$gpkg" "/vsizip/${zip}/HPMS${HPMS_YEAR}.gdb" \
    -sql "SELECT OBJECTID, state_id, route_id, f_system, facility_type, speed_limit, Shape FROM HPMS_FULL_${STATE}_${HPMS_YEAR} WHERE speed_limit IS NOT NULL AND speed_limit < 999" \
    -nln hpms -dim XY -t_srs EPSG:4326 -nlt MULTILINESTRING
fi

{
  echo "# downloaded $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sha256sum "$pbf" "$zip" "$gpkg"
} > "downloads/SOURCES-${STATE}.txt"
ls -la "$pbf" "$zip" "$gpkg"
