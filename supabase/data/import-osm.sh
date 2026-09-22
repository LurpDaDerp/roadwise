#!/usr/bin/env bash
# Loads one OSM extract (download.sh) into osm.ways: the twelve road classes, the limit from
# osm.way_limit_mph (the maxspeed parser, the km/h guard, the directional-tag rule), oneway
# normalised to -1/0/1. See README.md.
#
#   supabase/data/import-osm.sh                                   # Washington, local stack
#   REGION=north-america/us/oregon REPLACE=0 supabase/data/import-osm.sh   # add a neighbour
#   export DB_URL; supabase/data/import-osm.sh                    # another database (user action:
#                                                                 # README, "Loading the hosted project")
#
# REPLACE=1 (the default) empties osm.ways first, so a re-run leaves exactly the extract's ways
# (and on a local stack it also removes seed.sql's synthetic fixture; `supabase db reset` brings it
# back). REPLACE=0 upserts by way id, for loading several extracts side by side. CLUSTER=0 skips
# the table rewrite in postprocess.sql (for a database close to its size limit).
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DB_URL:=postgresql://postgres:postgres@127.0.0.1:54622/postgres}"
: "${REGION:=north-america/us/washington}"
: "${REPLACE:=1}"
: "${CLUSTER:=1}"
# bare-number limits north of this latitude are Canadian km/h (see sql/parse_maxspeed.sql). 49 is
# Washington's whole border with British Columbia; set it for another northern-border extract, or
# KMH_NORTH_OF= (empty) for an extract with no Canadian roads
if [ -z "${KMH_NORTH_OF+x}" ]; then
  case "$REGION" in */washington) KMH_NORTH_OF=49 ;; *) KMH_NORTH_OF= ;; esac
fi

# ---- the database connection (security review M-2, M-3); the same block is in import-osm.sh,
# import-hpms.sh and tests/run.sh -------------------------------------------------------------------
# DB_URL never appears on a command line. On the host it is written to a private temporary file,
# mounted read-only into the container; there, python3 turns it into libpq's PG* variables, so psql
# and ogr2ogr ("PG:") connect with no connection string in their arguments, in `ps`, or in
# `docker inspect`. A database that is not on this machine must be asked for TLS
# (?sslmode=verify-full, verify-ca or require), or the script stops before connecting.
roadwise_db_env() {
  local out
  out="$(python3 - <<'PY'
import os, shlex, sys, urllib.parse as up
src = os.environ.get('ROADWISE_DB_URL_FILE')
url = (open(src, encoding='utf-8').read() if src else os.environ.get('DB_URL', '')).strip()
def fail(msg):
    sys.stderr.write('DB_URL: ' + msg + '\n')
    sys.exit(2)
if not url.startswith(('postgresql://', 'postgres://')):
    fail('must be a postgresql:// URL')
p = up.urlsplit(url)
if ',' in p.netloc:
    fail('name one host')
allowed = ('sslmode', 'sslrootcert', 'connect_timeout', 'application_name')
q = {}
for k, v in up.parse_qsl(p.query, keep_blank_values=True):
    if k not in allowed:
        fail('unsupported parameter ' + k + ' (allowed: ' + ', '.join(allowed) + ')')
    q[k] = v
try:
    host, port = p.hostname or '', p.port or 5432
except ValueError:
    fail('bad port')
local = host in ('', 'localhost', '127.0.0.1', '::1', 'host.docker.internal')
sslmode = q.get('sslmode', '')
if not local and sslmode not in ('require', 'verify-ca', 'verify-full'):
    fail(host + ' is not local: add ?sslmode=verify-full (with sslrootcert=) or ?sslmode=require; '
         'refusing to send the password without TLS')
env = {
    'PGHOST': host, 'PGPORT': str(port),
    'PGUSER': up.unquote(p.username or ''), 'PGPASSWORD': up.unquote(p.password or ''),
    'PGDATABASE': up.unquote(p.path.lstrip('/')) or 'postgres',
    'PGSSLMODE': sslmode or 'prefer', 'PGSSLROOTCERT': q.get('sslrootcert', ''),
    'PGCONNECT_TIMEOUT': q.get('connect_timeout', '10'),
    'PGAPPNAME': q.get('application_name', 'roadwise-data'),
}
print('unset DB_URL ROADWISE_DB_URL_FILE PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS')
for k, v in env.items():
    print('export %s=%s' % (k, shlex.quote(v)) if v else 'unset ' + k)
PY
)" || exit 2
  eval "$out"
}

# re-run this script inside the roadwise-data image (Dockerfile) unless its tools are installed;
# the arguments are extra `docker run` options (non-secret -e NAME=value pairs)
roadwise_in_docker() {
  local script="$1"; shift
  local mount secret secret_mount status=0
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  secret="$(mktemp -d)"
  trap 'rm -rf "$secret"' EXIT
  chmod 700 "$secret"
  # inside the container this machine is host.docker.internal; the URL goes through stdin only
  (umask 077 && printf '%s' "$DB_URL" | sed -E 's#@(127\.0\.0\.1|localhost|\[::1\])([:/?]|$)#@host.docker.internal\2#' > "$secret/db_url")
  secret_mount="$(cd "$secret" && (pwd -W 2>/dev/null || pwd))"
  MSYS_NO_PATHCONV=1 docker run --rm --add-host=host.docker.internal:host-gateway \
    -e ROADWISE_IN_DOCKER=1 -e ROADWISE_DB_URL_FILE=/run/roadwise/db_url "$@" \
    -v "$secret_mount:/run/roadwise:ro" -v "$mount:/work" -w /work \
    "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash "$script" || status=$?
  exit "$status"
}
# ------------------------------------------------------------------------------------------------

if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  roadwise_in_docker import-osm.sh -e REGION="$REGION" -e REPLACE="$REPLACE" -e CLUSTER="$CLUSTER" -e KMH_NORTH_OF="$KMH_NORTH_OF"
fi
cd "$DATA_DIR"
case "$REPLACE" in 0|1) ;; *) echo "REPLACE must be 0 or 1" >&2; exit 2 ;; esac
case "$CLUSTER" in 0|1) ;; *) echo "CLUSTER must be 0 or 1" >&2; exit 2 ;; esac
roadwise_db_env

name="$(basename "$REGION")"
pbf="downloads/${name}-latest.osm.pbf"
roads="downloads/${name}-roads.osm.pbf"
[ -s "$pbf" ] || { echo "missing $pbf: run download.sh first" >&2; exit 1; }

psql_run() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
t0=$(date +%s); step=$t0
lap() { local now; now=$(date +%s); echo "-- $1: $((now - step)) s"; step=$now; }

# the extract being loaded, for the run's record (review m2)
echo "-- loading $pbf, OSM data as of $(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" 2>/dev/null || echo unknown)"

# 1. the twelve classes; referenced nodes come along so the ways keep their geometry
osmium tags-filter "$pbf" \
  w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link \
  --overwrite -o "$roads"
lap "osmium tags-filter"

# 2. staging schema and the pipeline's functions
psql_run -f sql/stage.sql
psql_run -f sql/parse_maxspeed.sql

# 3. ways -> roadwise_stage.osm_lines (OSM_CONFIG_FILE, set by the image, makes maxspeed,
#    maxspeed:forward/backward, oneway and junction columns). A way crossing the extract's edge is
#    complete in Geofabrik extracts. "PG:" with no parameters: libpq reads the PG* variables.
ogr2ogr -f PostgreSQL "PG:" "$roads" lines \
  -nln roadwise_stage.osm_lines -nlt LINESTRING -lco GEOMETRY_NAME=geom -lco SPATIAL_INDEX=NONE \
  -lco UNLOGGED=ON -lco FID=ogc_fid --config PG_USE_COPY YES -gt 65536 \
  -where "highway IN ('motorway','trunk','primary','secondary','tertiary','unclassified','residential','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link')"
lap "ogr2ogr stage"

# 4. into osm.ways
psql_run -v source=osm -v replace="$REPLACE" -v kmh_north_of="$KMH_NORTH_OF" -f sql/transform.sql
lap "transform"

# 5. indexes, clustering, statistics; then what it cost
psql_run -v cluster="$CLUSTER" -f sql/postprocess.sql
lap "postprocess"
psql_run -f sql/size_report.sql
echo "-- import-osm total: $(( $(date +%s) - t0 )) s"
