# The API image (PLAN-BACKEND.md §13: one VPS, Docker Compose). Built
# from the repo root as context — `pnpm-workspace.yaml` and
# `packages/shared` live outside apps/api:
#
#   docker build -f apps/api/Dockerfile -t servgrid-api .
#
# No compile step: the API and @servgrid/shared are TS source consumed
# through tsx, so the image is install + source. tsx is a devDependency
# and is deliberately installed anyway — it is the production loader.

FROM node:22-alpine

# node:22-alpine ships corepack; the version comes from the root
# package.json `packageManager` field, the same one CI pins.
RUN corepack enable

WORKDIR /app

# Manifests first so dependency layers survive source-only edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/

# api + its workspace dependencies (@servgrid/shared). Mobile's deps —
# the Expo tree — are never installed here.
RUN pnpm install --frozen-lockfile --filter api...

COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

WORKDIR /app/apps/api
EXPOSE 3000
USER node

# tsx resolves through apps/api/node_modules/.bin (hoisted layout puts
# the real tree at the workspace root; the .bin link is per-package).
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
