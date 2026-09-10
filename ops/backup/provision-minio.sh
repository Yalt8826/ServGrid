#!/usr/bin/env bash
# One-time per environment MinIO provisioning (T0.16 first boot):
#
#   1. the API's attachment bucket,
#   2. a DEDICATED MinIO user for the API (never the root credentials),
#      scoped read-write to that bucket alone,
#   3. the off-site buckets: the backup bucket and the bucket-replication
#      target, plus MinIO bucket replication of attachments to it.
#
#   ENV_FILE=/srv/servgrid/staging/.env ops/backup/provision-minio.sh
#
# Needs `mc` in PATH and the environment's MinIO published on
# 127.0.0.1:9000 (ops/compose.yaml does). Idempotent: existing buckets,
# users and replication rules are left alone.

source "$(dirname "$0")/lib.sh"

command -v mc >/dev/null || {
  echo "provision-minio: mc (MinIO client) not found in PATH" >&2
  exit 1
}
for var in S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "provision-minio: $var is not set — fix $ENV_FILE" >&2
    exit 1
  fi
done
if [ "${OFFSITE_REQUIRED:-0}" = "1" ]; then
  for var in OFFSITE_S3_ENDPOINT OFFSITE_S3_ACCESS_KEY_ID OFFSITE_S3_SECRET_ACCESS_KEY OFFSITE_BUCKET OFFSITE_ATTACHMENTS_BUCKET; do
    if [ -z "${!var:-}" ]; then
      echo "provision-minio: OFFSITE_REQUIRED=1 but $var is not set — fix $ENV_FILE" >&2
      exit 1
    fi
  done
fi

MC_LOCAL=servgrid-local
mc alias set "$MC_LOCAL" http://127.0.0.1:9000 \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --api S3v4 >/dev/null

echo "provision-minio: bucket $S3_BUCKET"
mc mb --ignore-existing "$MC_LOCAL/$S3_BUCKET"

# The API user: exactly this bucket, exactly read-write.
echo "provision-minio: api user"
mc admin user add "$MC_LOCAL" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" 2>/dev/null \
  || echo "provision-minio: api user already exists — leaving credentials as set"

POLICY=$(mktemp /tmp/servgrid-policy.XXXXXX.json)
trap 'rm -f "$POLICY"' EXIT
cat > "$POLICY" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET", "arn:aws:s3:::$S3_BUCKET/*"]
    }
  ]
}
POLICY
mc admin policy create "$MC_LOCAL" "servgrid-$S3_BUCKET" "$POLICY" 2>/dev/null \
  || echo "provision-minio: policy already exists"
mc admin policy attach "$MC_LOCAL" "servgrid-$S3_BUCKET" --user "$S3_ACCESS_KEY_ID" 2>/dev/null \
  || echo "provision-minio: policy already attached"

if mc_offsite; then
  mc mb --ignore-existing "$MC_REMOTE/$OFFSITE_BUCKET"
  echo "provision-minio: backups bucket $MC_REMOTE/$OFFSITE_BUCKET ready"

  echo "provision-minio: bucket replication $S3_BUCKET → $MC_REMOTE/$OFFSITE_ATTACHMENTS_BUCKET"
  mc mb --ignore-existing "$MC_REMOTE/$OFFSITE_ATTACHMENTS_BUCKET"
  if mc replicate status "$MC_LOCAL/$S3_BUCKET" 2>/dev/null | grep -q 'sent'; then
    echo "provision-minio: replication already configured"
  else
    mc replicate add "$MC_LOCAL/$S3_BUCKET" \
      --remote-bucket "$MC_REMOTE/$OFFSITE_ATTACHMENTS_BUCKET" \
      --replication-band "" --priority 1
    echo "provision-minio: resyncing existing objects (safe to re-run):"
    echo "  mc replicate resync start $MC_LOCAL/$S3_BUCKET"
  fi
  mc replicate status "$MC_LOCAL/$S3_BUCKET" || true
else
  if [ "${OFFSITE_REQUIRED:-0}" = "1" ]; then
    echo "provision-minio: FAILED — off-site required but unavailable" >&2
    exit 1
  fi
  echo "provision-minio: local mode — no off-site buckets or replication configured"
fi

echo "provision-minio: OK"
