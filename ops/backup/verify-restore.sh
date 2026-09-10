#!/usr/bin/env bash
# The test that makes a backup a backup (T0.16): restore a dump into a
# scratch database ON THE SAME INSTANCE and query it. A pg_dump that
# merely completed proves nothing; this script fails until a database
# has answered questions from the restored rows.
#
#   ENV_FILE=/srv/servgrid/staging/.env ops/backup/verify-restore.sh [dump-file]
#
# With no dump argument the newest in BACKUP_DIR is used (the monthly
# timer pairs it after backup.sh — ops/systemd/servgrid-verify-restore@).
# The scratch database is dropped on success and KEPT on failure so a
# human can look inside it; its name is printed either way.

source "$(dirname "$0")/lib.sh"

: "${BACKUP_DIR:?BACKUP_DIR is not set — fix $ENV_FILE}"

SCRATCH="${POSTGRES_DB}_restore_check"
if [ "$SCRATCH" = "$POSTGRES_DB" ]; then
  echo "verify-restore: refusing — scratch name equals the live database name" >&2
  exit 1
fi

DUMP=${1:-}
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1t "$BACKUP_DIR"/servgrid-*.dump 2>/dev/null | head -n 1 || true)
  if [ -z "$DUMP" ]; then
    echo "verify-restore: no dump found in $BACKUP_DIR — run backup.sh first or pass a path" >&2
    exit 1
  fi
fi
if [ ! -r "$DUMP" ]; then
  echo "verify-restore: dump not readable: $DUMP" >&2
  exit 1
fi

psql_scratch() {
  compose exec -T db psql -U "$POSTGRES_USER" -d "$SCRATCH" -v ON_ERROR_STOP=1 "$@"
}

echo "verify-restore: restoring $(basename "$DUMP") into scratch database $SCRATCH"
compose exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $SCRATCH" \
  -c "CREATE DATABASE $SCRATCH" >/dev/null

restore_failed=0
# The dump lives on the host; pg_restore runs in the db container, so
# the archive is streamed on stdin (custom format reads stdin fine).
# Passing a host path instead is the bug this script's first run caught:
# the restore "ran" and restored nothing.
cat "$DUMP" | compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$SCRATCH" \
  --no-owner --no-privileges \
  || restore_failed=1

# pg_restore reports non-fatal warnings with exit 1; the queries below
# are the real verdict. A database that cannot answer has failed even
# if pg_restore thinks it succeeded.

if [ "$restore_failed" = "1" ]; then
  echo "verify-restore: pg_restore exited non-zero — checking what actually landed" >&2
fi

# Every assertion prints the number it saw: the box is ticked on a
# database that was queried, not a restore that merely completed.
FAILED=0
check() {
  local label=$1 expect=$2 sql=$3 got
  got=$(psql_scratch -tA -c "$sql" 2>&1) || {
    echo "verify-restore: FAILED — $label query errored: $got" >&2
    FAILED=1
    return
  }
  if [ "$got" -ge "$expect" ] 2>/dev/null; then
    echo "verify-restore: ok — $label = $got (>= $expect)"
  else
    echo "verify-restore: FAILED — $label = $got, expected >= $expect" >&2
    FAILED=1
  fi
}

check "applied migrations" 5 "SELECT count(*) FROM pgmigrations"
check "employees (the owner exists)" 1 "SELECT count(*) FROM employees"
check "service catalogue rows" 5 "SELECT count(*) FROM services"

products=$(psql_scratch -tA -c 'SELECT count(*) FROM products') \
  && echo "verify-restore: products = $products (informational — production carries none from seeds)" \
  || { echo "verify-restore: FAILED — products query errored: $products" >&2; FAILED=1; }

if [ "$FAILED" = "0" ] && [ "$restore_failed" = "0" ]; then
  compose exec -T db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE $SCRATCH" >/dev/null
  echo "verify-restore: PASS — $DUMP restored into $SCRATCH, queried, dropped"
else
  echo "verify-restore: FAILED — scratch database $SCRATCH kept for inspection:" >&2
  echo "  docker compose ... exec db psql -U $POSTGRES_USER -d $SCRATCH" >&2
  echo "  then drop it: psql -d postgres -c 'DROP DATABASE $SCRATCH'" >&2
  exit 1
fi
