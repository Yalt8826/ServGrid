#!/usr/bin/env bash
# Ship archived WAL segments off-site (PLAN-BACKEND.md §13). The
# database archives segments into SERVGRID_WAL_DIR (ops/compose.yaml
# archive_command); this runs every five minutes — ops/systemd/
# servgrid-wal-sync@.timer — mirroring them to the off-site bucket and
# pruning what has aged out. Recovery loss is bounded by the archive
# timeout (300s), not by this cadence.
#
#   ENV_FILE=/srv/servgrid/staging/.env ops/backup/wal-sync.sh

source "$(dirname "$0")/lib.sh"

: "${SERVGRID_WAL_DIR:?SERVGRID_WAL_DIR is not set — fix $ENV_FILE}"

if ! mc_offsite; then
  if [ "${OFFSITE_REQUIRED:-0}" = "1" ]; then
    echo "wal-sync: FAILED — off-site shipping required but unavailable" >&2
    exit 1
  fi
  echo "wal-sync: local mode — nothing to do"
  exit 0
fi

if [ ! -d "$SERVGRID_WAL_DIR" ]; then
  echo "wal-sync: FAILED — $SERVGRID_WAL_DIR missing (first boot: see ops/compose.yaml db service)" >&2
  exit 1
fi

mc mirror --overwrite "$SERVGRID_WAL_DIR" "$MC_REMOTE/$OFFSITE_BUCKET/wal/" >/dev/null
mc rm --older-than "${OFFSITE_KEEP_WAL_DAYS:-14}d" --recursive --force \
  "$MC_REMOTE/$OFFSITE_BUCKET/wal/" >/dev/null

echo "wal-sync: OK — $(ls -1 "$SERVGRID_WAL_DIR" | wc -l) segments on disk, mirrored to $MC_REMOTE/$OFFSITE_BUCKET/wal/"
