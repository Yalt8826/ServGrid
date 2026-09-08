#!/usr/bin/env node
/**
 * Migration gate (PHASE-0-FOUNDATION.md T0.2, PLAN-BACKEND.md §13 CI 5):
 * against a clean Postgres 16 from docker compose, run the node-pg-migrate
 * set up → down → up via apps/api/src/db/rehearse.ts, and fail on any
 * error — down-migrations are never run in production
 * (PLAN-EXECUTION.md Part I) but are how a developer resets locally, and
 * an untested one fails at the worst moment.
 *
 * Starts the compose `db` service only when one is not already reachable
 * and tears it down afterwards (volumes preserved — never -v here). The
 * red path of this job was proven in T0.1 by tools/devnull.mjs + the
 * tools/fail-check fixture.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', 'db'];

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
}

function die(message, detail) {
  if (detail) console.error(detail.trimEnd());
  console.error(`migration-check: FAILED — ${message}`);
  process.exit(1);
}

// 1. Is a Postgres already serving on the compose coordinates?
const envUrl = process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
let reused = false;
{
  const parsed = new URL(envUrl);
  const probe = sh('bash', [
    '-c',
    `exec 3<>/dev/tcp/${parsed.hostname}/${parsed.port || 5432} && exec 3>&- 3<&-`,
  ]);
  reused = probe.status === 0;
}

let started = false;
if (!reused) {
  const up = sh('docker', [...compose, 'up', '-d', '--wait']);
  if (up.status !== 0) {
    die('could not start the compose db service', up.stderr || up.stdout);
  }
  started = true;
}

// 2. Rehearse against whatever is now listening. `docker compose port`
// resolves the mapped host port even when .env overrides SERVGRID_DB_PORT.
const env = { ...process.env };
if (!reused || !process.env.DATABASE_URL) {
  const portOut = sh('docker', [...compose, 'port', '5432']);
  const hostPort = portOut.status === 0 ? portOut.stdout.trim().split(':')[1] : null;
  const parsed = new URL(envUrl);
  if (hostPort) parsed.port = hostPort;
  env.DATABASE_URL = parsed.toString();
}

const tsx = join(root, 'apps', 'api', 'node_modules', '.bin', 'tsx');
const run = existsSync(tsx)
  ? sh(tsx, ['src/db/rehearse.ts'], { env, cwd: join(root, 'apps/api') })
  : sh('node', ['--experimental-strip-types', 'src/db/rehearse.ts'], { env, cwd: join(root, 'apps/api') });

// 3. Tear down only what this run started.
if (started) {
  sh('docker', [...compose, 'down']);
}

if (run.status !== 0) {
  die('up → down → up rehearsal did not complete', run.stdout || run.stderr);
}
if (run.stdout) console.log(run.stdout.trimEnd());
console.log('migration-check: OK.');
