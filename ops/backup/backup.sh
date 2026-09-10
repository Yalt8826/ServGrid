#!/usr/bin/env bash
# Nightly logical backup (PLAN-BACKEND.md §13): pg_dump -Fc of this
# environment's database, integrity-checked, shipped to off-site object
# storage, both copies pruned, dead-man ping on success. Systemd timer:
# ops/systemd/servgrid-backup@.timer.
#
#   ENV_FILE=/srv/servgrid/staging/.env ops/backup/backup.sh
#
# Failure is loud: any step fails the script and the timer's unit goes
# failed (systemctl list-timers / list-units shows it); the dead-man
# monitor goes quiet when the ping never arrives. Either surfaces.

source "$(dirname "$0")/lib.sh"

: "${BACKUP_DIR:?BACKUP_DIR is not set — fix $ENV_FILE}"
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/servgrid-$SERVGRID_ENV-$STAMP.dump"

echo "backup: dumping $POSTGRES_DB → $DUMP"
compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DUMP"

# An empty or truncated file must not be what ships off-site. pg_restore
# reads the archive's table of contents — a cheap structural check.
if [ ! -s "$DUMP" ] || ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "backup: FAILED — $DUMP is not a readable pg_dump archive" >&2
  exit 1
fi
echo "backup: archive verified — $(pg_restore --list "$DUMP" | grep -c '^[0-9;]') entries, $(du -h "$DUMP" | cut -f1)"

if mc_offsite; then
  echo "backup: shipping to $MC_REMOTE/$OFFSITE_BUCKET/dumps/"
  mc cp "$DUMP" "$MC_REMOTE/$OFFSITE_BUCKET/dumps/"
  mc rm --older-than "${OFFSITE_KEEP_DUMP_DAYS:-60}d" --recursive --force \
    "$MC_REMOTE/$OFFSITE_BUCKET/dumps/" >/dev/null
else
  if [ "${OFFSITE_REQUIRED:-0}" = "1" ]; then
    echo "backup: FAILED — off-site shipping required but unavailable" >&2
    exit 1
  fi
  echo "backup: local mode — OFFSITE_REQUIRED not set, dump kept on this machine only"
fi

find "$BACKUP_DIR" -maxdepth 1 -name "servgrid-*.dump" \
  -mtime "+${BACKUP_KEEP_LOCAL_DAYS:-7}" -delete

if [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS --max-time 10 "$BACKUP_PING_URL" >/dev/null
  echo "backup: dead-man ping sent"
fi

echo "backup: OK — $DUMP"
