#!/usr/bin/env bash
# Shared plumbing for the ops scripts. Sourced, not run:
#
#   ENV_FILE=/srv/servgrid/staging/.env backup.sh
#
# The env file is parsed, never `.`-sourced: it may carry inline JSON
# (FCM_SERVICE_ACCOUNT) that shell parsing would mangle. Values the
# scripts need are read by name; everything else stays opaque.

set -euo pipefail

: "${ENV_FILE:?usage: ENV_FILE=/srv/servgrid/<env>/.env $0}"
if [ ! -r "$ENV_FILE" ]; then
  echo "$(basename "$0"): env file not readable: $ENV_FILE" >&2
  exit 1
fi

# envget NAME — last assignment wins, comments and blanks ignored.
envget() {
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

SERVGRID_ENV=${SERVGRID_ENV:-$(envget SERVGRID_ENV)}
SERVGRID_DIR=${SERVGRID_DIR:-$(envget SERVGRID_DIR)}
POSTGRES_USER=${POSTGRES_USER:-$(envget POSTGRES_USER)}
POSTGRES_DB=${POSTGRES_DB:-$(envget POSTGRES_DB)}
SERVGRID_WAL_DIR=${SERVGRID_WAL_DIR:-$(envget SERVGRID_WAL_DIR)}
BACKUP_DIR=${BACKUP_DIR:-$(envget BACKUP_DIR)}
BACKUP_KEEP_LOCAL_DAYS=${BACKUP_KEEP_LOCAL_DAYS:-$(envget BACKUP_KEEP_LOCAL_DAYS)}
BACKUP_PING_URL=${BACKUP_PING_URL:-$(envget BACKUP_PING_URL)}
OFFSITE_REQUIRED=${OFFSITE_REQUIRED:-$(envget OFFSITE_REQUIRED)}
OFFSITE_S3_ENDPOINT=${OFFSITE_S3_ENDPOINT:-$(envget OFFSITE_S3_ENDPOINT)}
OFFSITE_S3_ACCESS_KEY_ID=${OFFSITE_S3_ACCESS_KEY_ID:-$(envget OFFSITE_S3_ACCESS_KEY_ID)}
OFFSITE_S3_SECRET_ACCESS_KEY=${OFFSITE_S3_SECRET_ACCESS_KEY:-$(envget OFFSITE_S3_SECRET_ACCESS_KEY)}
OFFSITE_BUCKET=${OFFSITE_BUCKET:-$(envget OFFSITE_BUCKET)}
OFFSITE_KEEP_DUMP_DAYS=${OFFSITE_KEEP_DUMP_DAYS:-$(envget OFFSITE_KEEP_DUMP_DAYS)}
OFFSITE_KEEP_WAL_DAYS=${OFFSITE_KEEP_WAL_DAYS:-$(envget OFFSITE_KEEP_WAL_DAYS)}
OFFSITE_ATTACHMENTS_BUCKET=${OFFSITE_ATTACHMENTS_BUCKET:-$(envget OFFSITE_ATTACHMENTS_BUCKET)}
S3_BUCKET=${S3_BUCKET:-$(envget S3_BUCKET)}
S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-$(envget S3_ACCESS_KEY_ID)}
S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-$(envget S3_SECRET_ACCESS_KEY)}
MINIO_ROOT_USER=${MINIO_ROOT_USER:-$(envget MINIO_ROOT_USER)}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-$(envget MINIO_ROOT_PASSWORD)}

for var in SERVGRID_ENV SERVGRID_DIR POSTGRES_USER POSTGRES_DB; do
  if [ -z "${!var:-}" ]; then
    echo "$(basename "$0"): $var is not set — fix $ENV_FILE" >&2
    exit 1
  fi
done

# The compose command for this environment. --env-file feeds
# interpolation (ops/compose.yaml's `:?` checks) without touching the
# shell; SERVGRID_ENV_FILE inside the same file points env_file back at
# it for the api container.
compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --project-directory "$SERVGRID_DIR/ops" \
    -f "$SERVGRID_DIR/ops/compose.yaml" \
    -f "$SERVGRID_DIR/ops/compose.$SERVGRID_ENV.yml" \
    -p "servgrid-$SERVGRID_ENV" \
    "$@"
}

# mc alias for the off-site store; no-op when backups are local-only
# (OFFSITE_REQUIRED unset/0 — a deliberate local-machine mode, never
# set on the VPS).
MC_REMOTE=servgrid-offsite
mc_offsite() {
  if [ "${OFFSITE_REQUIRED:-0}" != "1" ]; then
    return 1
  fi
  for var in OFFSITE_S3_ENDPOINT OFFSITE_S3_ACCESS_KEY_ID OFFSITE_S3_SECRET_ACCESS_KEY OFFSITE_BUCKET; do
    if [ -z "${!var:-}" ]; then
      echo "$(basename "$0"): OFFSITE_REQUIRED=1 but $var is not set — fix $ENV_FILE" >&2
      exit 1
    fi
  done
  command -v mc >/dev/null || {
    echo "$(basename "$0"): mc (MinIO client) not found in PATH — install it on the VPS" >&2
    exit 1
  }
  mc alias set "$MC_REMOTE" "$OFFSITE_S3_ENDPOINT" \
    "$OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_SECRET_ACCESS_KEY" --api S3v4 >/dev/null
}
