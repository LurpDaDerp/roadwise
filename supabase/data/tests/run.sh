#!/usr/bin/env bash
# Runs the pipeline's SQL tests (pgTAP) against a database, inside one transaction that is rolled
# back, so it leaves nothing behind: the function under test is created, tested and discarded.
#
#   supabase/data/tests/run.sh            # the local Supabase stack (npx supabase start)
#   DB_URL=postgresql://... tests/run.sh  # any other database with PostGIS and pgTAP available
#
# Exits non-zero on any failed assertion or a plan mismatch.
set -euo pipefail
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DB_URL:=postgresql://postgres:postgres@127.0.0.1:54622/postgres}"

# re-run inside the roadwise-data image (supabase/data/Dockerfile) unless its tools are installed
if [ -z "${ROADWISE_IN_DOCKER:-}" ] && ! command -v osmium >/dev/null 2>&1; then
  mount="$(cd "$DATA_DIR" && (pwd -W 2>/dev/null || pwd))"
  url="$(printf '%s' "$DB_URL" | sed -E 's#@(127\.0\.0\.1|localhost)([:/])#@host.docker.internal\2#')"
  MSYS_NO_PATHCONV=1 exec docker run --rm --add-host=host.docker.internal:host-gateway \
    -e ROADWISE_IN_DOCKER=1 -e DB_URL="$url" -v "$mount:/work" -w /work \
    "${ROADWISE_DATA_IMAGE:-roadwise-data}" bash tests/run.sh "$@"
fi
cd "$DATA_DIR"

status=0
for t in tests/*.test.sql; do
  out="$({
    echo 'create extension if not exists pgtap with schema extensions;'
    echo 'begin;'
    echo 'set local search_path = public, extensions;'
    cat sql/parse_maxspeed.sql
    cat "$t"
    echo 'rollback;'
  } | psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -t -A 2>&1)" || { echo "$out"; echo "FAIL $t (psql error)"; status=1; continue; }
  echo "$out"
  if printf '%s\n' "$out" | grep -Eq '^not ok|^# Looks like'; then
    echo "FAIL $t"; status=1
  else
    echo "PASS $t ($(printf '%s\n' "$out" | grep -c '^ok') assertions)"
  fi
done
exit $status
