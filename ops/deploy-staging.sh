#!/usr/bin/env bash
# Staging deploy — runs ON THE VPS, piped over ssh by CI:
#
#   ssh "$STAGING_SSH_USER@$STAGING_SSH_HOST" \
#     "API_IMAGE=$IMAGE bash -s" < ops/deploy-staging.sh
#
# Paths are the ones the T0.16 runbook establishes: repo at
# /srv/servgrid/app, env files at /srv/servgrid/<env>/.env.
# Production deploys are manual (an owner decision, digest-pinned in
# ops/env.production.example), never a side effect of a merge.

set -euo pipefail
: "${API_IMAGE:?API_IMAGE is not provided by the caller}"
ENV_FILE=${ENV_FILE:-/srv/servgrid/staging/.env}
APP_DIR=${APP_DIR:-/srv/servgrid/app}

cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --project-directory "$APP_DIR/ops" \
    -f "$APP_DIR/ops/compose.yaml" \
    -f "$APP_DIR/ops/compose.staging.yml" \
    -p servgrid-staging "$@"
}

echo "deploy: pulling $API_IMAGE"
compose pull api

echo "deploy: migrating"
compose run --rm api ./node_modules/.bin/tsx src/db/migrate-cli.ts

echo "deploy: restarting the stack"
compose up -d --remove-orphans --wait api

docker image prune -f >/dev/null
compose ps
echo "deploy: OK — $API_IMAGE"
