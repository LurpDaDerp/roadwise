#!/usr/bin/env bash
# Loads one state's HPMS sections (download.sh's hpms-<YEAR>-<ST>.gpkg, already limited to rows
# with a recorded speed limit) into hpms.sections. See README.md.
#
#   supabase/data/import-hpms.sh                          # Washington (WA, FIPS 53), local stack
#   STATE=OR STATE_CODE=41 supabase/data/import-hpms.sh   # another state
#   export DB_URL; supabase/data/import-hpms.sh           # another database (user action:
#                                                         # README, "Loading the hosted project")
#
# REPLACE=1 (the default) first deletes that state's sections only, so states load independently.
# CLUSTER=0 skips the table rewrite in postprocess.sql (for a database close to its size limit).
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DB_URL:=postgresql://postgres:postgres@127.0.0.1:54622/postgres}"
: "${STATE:=WA}"
: "${STATE_CODE:=53}"
: "${HPMS_YEAR:=2024}"
: "${REPLACE:=1}"
: "${CLUSTER:=1}"

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
  roadwise_in_docker import-hpms.sh -e STATE="$STATE" -e STATE_CODE="$STATE_CODE" \
    -e HPMS_YEAR="$HPMS_YEAR" -e REPLACE="$REPLACE" -e CLUSTER="$CLUSTER"
fi
cd "$DATA_DIR"
case "$REPLACE" in 0|1) ;; *) echo "REPLACE must be 0 or 1" >&2; exit 2 ;; esac
case "$CLUSTER" in 0|1) ;; *) echo "CLUSTER must be 0 or 1" >&2; exit 2 ;; esac
case "$STATE" in [A-Z][A-Z]) ;; *) echo "STATE must be a two-letter code such as WA" >&2; exit 2 ;; esac
case "$HPMS_YEAR" in [0-9][0-9][0-9][0-9]) ;; *) echo "HPMS_YEAR must be a year" >&2; exit 2 ;; esac
roadwise_db_env

gpkg="downloads/hpms-${HPMS_YEAR}-${STATE}.gpkg"
[ -s "$gpkg" ] || { echo "missing $gpkg: run download.sh with STATE=$STATE first" >&2; exit 1; }

psql_run() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
t0=$(date +%s); step=$t0
lap() { local now; now=$(date +%s); echo "-- $1: $((now - step)) s"; step=$now; }

psql_run -f sql/stage.sql

# "PG:" with no parameters: libpq reads the PG* variables roadwise_db_env set
ogr2ogr -f PostgreSQL "PG:" "$gpkg" hpms \
  -nln roadwise_stage.hpms -nlt MULTILINESTRING -lco GEOMETRY_NAME=geom -lco SPATIAL_INDEX=NONE \
  -lco UNLOGGED=ON -lco FID=ogc_fid --config PG_USE_COPY YES -gt 65536
lap "ogr2ogr stage"

psql_run -v source=hpms -v replace="$REPLACE" -v state_code="$STATE_CODE" -f sql/transform.sql
lap "transform"

psql_run -v cluster="$CLUSTER" -f sql/postprocess.sql
lap "postprocess"
psql_run -f sql/size_report.sql
echo "-- import-hpms total: $(( $(date +%s) - t0 )) s"
