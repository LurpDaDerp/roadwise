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
#
# Integrity (security review M-1): every request is https-only, redirects included
# (--proto =https --proto-redir =https). A poisoned extract would put confident wrong limits in
# front of drivers, so nothing is extracted or loaded unless it verifies:
#   * HPMS is a fixed release: its sha256 is pinned below (taken from the 2026-09-22 download; BTS
#     publishes no checksum of its own) and checked on every run, not only after a download.
#   * the OSM extract changes daily: Geofabrik's published <file>.md5 is fetched over https with
#     it, kept beside it, and checked on every run.
#
# Usage (defaults: Washington):
#   supabase/data/download.sh
#   REGION=north-america/us/oregon STATE=OR supabase/data/download.sh
#   FORCE=1 supabase/data/download.sh          # re-download even if the files are present
#   HPMS_YEAR=2025 HPMS_ITEM=<item id> HPMS_SHA256=<sha256> supabase/data/download.sh   # a new release
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REGION:=north-america/us/washington}"
: "${STATE:=WA}"
: "${HPMS_YEAR:=2024}"
: "${HPMS_ITEM:=5e6a977c2d7c4ec1bdc82e684d3384f2}"
: "${FORCE:=}"
# the pinned release: HPMS2024.zip, 2,623,940,113 bytes
HPMS_2024_ITEM=5e6a977c2d7c4ec1bdc82e684d3384f2
HPMS_2024_SHA256=129b868c0c6d684f63ea137e6a1658495e5a6b520af2bbfc62785c4f31b8c83f
if [ -z "${HPMS_SHA256:-}" ]; then
  if [ "$HPMS_YEAR" = 2024 ] && [ "$HPMS_ITEM" = "$HPMS_2024_ITEM" ]; then
    HPMS_SHA256=$HPMS_2024_SHA256
  else
    echo "HPMS_SHA256 is required for any release but the pinned 2024 one" >&2; exit 2
  fi
fi

if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  MSYS_NO_PATHCONV=1 exec docker run --rm -e ROADWISE_IN_DOCKER=1 \
    -e REGION="$REGION" -e STATE="$STATE" -e HPMS_YEAR="$HPMS_YEAR" -e HPMS_ITEM="$HPMS_ITEM" \
    -e HPMS_SHA256="$HPMS_SHA256" -e FORCE="$FORCE" \
    -v "$mount:/work" -w /work "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash download.sh "$@"
fi
cd "$DATA_DIR"
mkdir -p downloads

case "$STATE" in [A-Z][A-Z]) ;; *) echo "STATE must be a two-letter code such as WA" >&2; exit 2 ;; esac
case "$HPMS_YEAR" in [0-9][0-9][0-9][0-9]) ;; *) echo "HPMS_YEAR must be a year" >&2; exit 2 ;; esac
[[ "$REGION" =~ ^[a-z0-9-]+(/[a-z0-9-]+)*$ ]] || { echo "REGION must be a Geofabrik path such as north-america/us/washington" >&2; exit 2; }
[[ "$HPMS_ITEM" =~ ^[0-9a-f]{32}$ ]] || { echo "HPMS_ITEM must be an ArcGIS item id" >&2; exit 2; }
[[ "$HPMS_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "HPMS_SHA256 must be a sha256 hex digest" >&2; exit 2; }

fetch() { curl --proto '=https' --proto-redir '=https' -fSL --retry 5 "$@"; }

pbf="downloads/$(basename "$REGION")-latest.osm.pbf"
zip="downloads/HPMS${HPMS_YEAR}.zip"
gpkg="downloads/hpms-${HPMS_YEAR}-${STATE}.gpkg"
osm_url="https://download.geofabrik.de/${REGION}-latest.osm.pbf"

# true when $1's md5 is the one Geofabrik published in the .md5 file $2
md5_ok() { [ "$(md5sum "$1" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$2")" ]; }

# --- OSM ---------------------------------------------------------------------------------------
if [ -n "$FORCE" ] || [ ! -s "$pbf" ]; then
  # the extract is republished daily; if it changes between the checksum and the file, fetch both
  # once more
  for attempt in 1 2; do
    echo "downloading OSM $REGION (attempt $attempt)"
    fetch -o "$pbf.md5.part" "$osm_url.md5"
    fetch -o "$pbf.part" "$osm_url"
    if md5_ok "$pbf.part" "$pbf.md5.part"; then
      mv "$pbf.md5.part" "$pbf.md5"; mv "$pbf.part" "$pbf"; break
    fi
    rm -f "$pbf.part" "$pbf.md5.part"
    [ "$attempt" = 2 ] && { echo "the OSM extract does not match Geofabrik's md5: not used" >&2; exit 1; }
  done
elif [ ! -s "$pbf.md5" ]; then
  # a file downloaded before checksums were kept: check it against today's published md5
  fetch -o "$pbf.md5.part" "$osm_url.md5"
  if ! md5_ok "$pbf" "$pbf.md5.part"; then
    rm -f "$pbf.md5.part"
    echo "$pbf does not match Geofabrik's current md5 (it may be an older extract): re-run with FORCE=1" >&2
    exit 1
  fi
  mv "$pbf.md5.part" "$pbf.md5"
fi
md5_ok "$pbf" "$pbf.md5" || { echo "$pbf does not match its recorded md5: re-run with FORCE=1" >&2; exit 1; }
echo "OSM extract verified against Geofabrik's md5"

# --- HPMS --------------------------------------------------------------------------------------
if [ -n "$FORCE" ] || [ ! -s "$zip" ]; then
  echo "downloading HPMS $HPMS_YEAR (national File Geodatabase, about 2.6 GB)"
  # -C - resumes an interrupted download of the same file
  fetch -C - -o "$zip.part" "https://www.arcgis.com/sharing/rest/content/items/${HPMS_ITEM}/data"
  if ! printf '%s  %s\n' "$HPMS_SHA256" "$zip.part" | sha256sum -c --quiet -; then
    rm -f "$zip.part"
    echo "the HPMS download does not match the pinned sha256: not used" >&2; exit 1
  fi
  mv "$zip.part" "$zip"
  rm -f "$gpkg"
fi
printf '%s  %s\n' "$HPMS_SHA256" "$zip" | sha256sum -c --quiet - \
  || { echo "$zip does not match the pinned sha256: delete it and re-run" >&2; exit 1; }
echo "HPMS release verified against the pinned sha256"

if [ -n "$FORCE" ] || [ ! -s "$gpkg" ]; then
  echo "extracting HPMS_FULL_${STATE}_${HPMS_YEAR} (sections with a recorded speed limit)"
  rm -f "$gpkg"
  # 2D lines in EPSG:4326 (the source is measured multilines); OBJECTID is kept as a column, which
  # import-hpms.sh turns into a stable section id
  ogr2ogr -f GPKG "$gpkg" "/vsizip/${zip}/HPMS${HPMS_YEAR}.gdb" \
    -sql "SELECT OBJECTID, state_id, route_id, f_system, facility_type, speed_limit, Shape FROM HPMS_FULL_${STATE}_${HPMS_YEAR} WHERE speed_limit IS NOT NULL AND speed_limit < 999" \
    -nln hpms -dim XY -t_srs EPSG:4326 -nlt MULTILINESTRING
fi

# --- the record of what this state's import will load (review m2) -----------------------------
# Each file's time is its modification time, which is when it was downloaded or extracted, not
# when this script last ran. A past load can be reproduced only from its kept downloads/ plus this
# file: Geofabrik's -latest extract changes daily.
{
  echo "# the inputs of a ${STATE} import; times are each file's download or extraction time (UTC)"
  echo "# osm_data_as_of $(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" 2>/dev/null || echo unknown)"
  echo "# osm_source ${osm_url} (verified: Geofabrik md5 $(cut -d' ' -f1 "$pbf.md5"))"
  echo "# hpms_source https://www.arcgis.com/sharing/rest/content/items/${HPMS_ITEM}/data (verified: pinned sha256)"
  for f in "$pbf" "$zip" "$gpkg"; do
    printf '%s  %s  %s bytes  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f" "$(stat -c %s "$f")" \
      "$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)"
  done
} > "downloads/SOURCES-${STATE}.txt"
cat "downloads/SOURCES-${STATE}.txt"
