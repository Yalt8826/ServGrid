# Ops — the one-VPS deployment

Staging and production are two copies of one stack on one VPS
(PLAN-BACKEND.md §13: Postgres 16, the API, MinIO, Caddy for TLS —
14 users and ~125k location rows a year do not need managed
Kubernetes, and the operational surface here is meant to be held in
one person's head).

```
ops/
  compose.yaml               the stack: db (WAL archiving), api, minio, caddy
  compose.staging.yml        NODE_ENV, staging bucket pin, staging domain
  compose.production.yml     NODE_ENV, production bucket pin, production domain
  Caddyfile                  {$SERVGRID_DOMAIN} → api:3000, TLS automatic
  env.staging.example        the ops/.env template — secrets checklist included
  env.production.example     same shape, production values
  deploy-staging.sh          CI's ssh entrypoint: pull, migrate, up
  backup/
    lib.sh                   env parsing + compose/mc helpers (sourced)
    backup.sh                nightly pg_dump -Fc → off-site, prune, dead-man ping
    verify-restore.sh        restore into a scratch db AND QUERY IT — the T0.16 test
    wal-sync.sh              ship archived WAL off-site every 5 min
    provision-minio.sh       once per env: buckets, API user, replication
  systemd/                   timers: nightly backup, 5-min WAL sync, monthly restore rehearsal
```

On the VPS: repo at `/srv/servgrid/app`, env files at
`/srv/servgrid/<env>/.env` (copied from the examples; outside the
checkout, so deploys can never touch secrets). Every command goes
through the per-environment compose wrapper — see
`ops/backup/lib.sh` `compose()` for the exact flags.

## The rules this layout enforces

- **Staging and production share nothing.** Separate `-p` project,
  database, MinIO volume, buckets, domain, credentials. Copying
  production data into staging is forbidden (DPDP — consent does not
  extend); staging seeds from `seed/` and, when it exists,
  `fixtures/demo.sql`.
- **A wrong bucket fails at boot.** The overrides pin
  `S3_BUCKET_EXPECTED` as a committed literal; `apps/api/src/config.ts`
  refuses to start when `S3_BUCKET` disagrees. Pasting the production
  env file over staging cannot happen silently.
- **A backup is not a backup until it is restored.** `verify-restore.sh`
  runs in the monthly timer and after any manual backup you intend to
  trust; it fails until the restored scratch database has answered
  queries.

## Day-two operations

| Task | Command |
|---|---|
| Deploy staging | merge to main — CI builds/pushes the image and runs `ops/deploy-staging.sh` |
| Deploy production (manual) | pin the digest in `/srv/servgrid/production/.env`, then the staging compose sequence with `compose.production.yml` |
| Take a backup now | `ENV_FILE=/srv/servgrid/<env>/.env ops/backup/backup.sh` |
| Verify a restore | `ENV_FILE=... ops/backup/verify-restore.sh [dump]` |
| Backup status | `systemctl list-timers 'servgrid-*'` and the dead-man monitor |
| Is it up? | `curl https://<domain>/healthz` — the external uptime checker calls the same URL every 5 minutes and phones the developer and the owner (see the T0.16 runbook) |

Alerting is exactly: the external `/healthz` poll plus the Phase 5
`tracking-health-sweep` push. No metrics stack, no on-call rota —
that is the design, not an omission.
