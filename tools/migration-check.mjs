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
const SERVICE = 'db';

/**
 * `docker compose <subcommand> [service]` — the service name follows the
 * subcommand, it does not sit between `compose` and it. An earlier form
 * built `docker compose db port 5432`, which docker answers with its
 * usage text and **exit code 0**, so the port lookup silently "succeeded"
 * with nothing parseable and fell back to 5432. On any machine where the
 * compose db is not on 5432 — this project publishes SERVGRID_DB_PORT,
 * commonly 5435 — that fallback reaches whatever else is listening there.
 * On the dev box it found an unrelated system Postgres and tried to
 * migrate it. Hence the explicit forms below and the hard failure in §2.
 */

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
}

function die(message, detail) {
  if (detail) console.error(detail.trimEnd());
  console.error(`migration-check: FAILED — ${message}`);
  process.exit(1);
}

// 1. Is a Postgres already serving on the compose coordinates?
// The same .env the API and compose read (apps/api/src/config.ts
// loadDotEnv). Without this the tool invents coordinates the rest of the
// stack does not use.
if (!process.env.DATABASE_URL && existsSync(join(root, '.env'))) {
  process.loadEnvFile(join(root, '.env'));
}
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
  const up = sh('docker', ['compose', 'up', '-d', SERVICE, '--wait']);
  if (up.status !== 0) {
    die('could not start the compose db service', up.stderr || up.stdout);
  }
  started = true;
}

// 2. Rehearse against whatever is now listening. `docker compose port`
// resolves the mapped host port even when .env overrides SERVGRID_DB_PORT.
const env = { ...process.env };
if (!reused || !process.env.DATABASE_URL) {
  const portOut = sh('docker', ['compose', 'port', SERVICE, '5432']);
  const hostPort = /^\S*:(\d+)\s*$/.exec(portOut.stdout ?? '')?.[1] ?? null;
  if (!hostPort) {
    // Never fall back to a guessed port. A rehearsal runs `down` on every
    // migration; pointing that at a database this project does not own is
    // the one failure here that is not recoverable by re-running.
    die(
      'could not resolve the compose db host port',
      `${portOut.stdout ?? ''}${portOut.stderr ?? ''}`,
    );
  }
  const parsed = new URL(envUrl);
  parsed.port = hostPort;
  env.DATABASE_URL = parsed.toString();
}

// 2b. Rehearse in a scratch database, never in the one the URL names.
//
// The first thing the rehearsal does is roll the whole set *down*
// (apps/api/src/db/rehearse.ts), so aiming it at the development database
// destroys it — the accounts, the seeds, everything. "A clean database"
// in PLAN-BACKEND.md §13 gate 5 is not a hope about which database is
// configured; it has to be a database this tool made and owns.
const target = new URL(env.DATABASE_URL);
const scratchName = `servgrid_rehearsal_${process.pid}`;
const admin = new URL(target.toString());
admin.pathname = '/postgres';

function psql(url, sql) {
  return sh('docker', [
    'compose', 'exec', '-T', SERVICE,
    'psql', '-v', 'ON_ERROR_STOP=1', '-d', urlForContainer(url), '-c', sql,
  ]);
}

/** The container reaches its own Postgres on 5432, not the mapped port. */
function urlForContainer(url) {
  const inside = new URL(url.toString());
  inside.hostname = 'localhost';
  inside.port = '5432';
  return inside.toString();
}

const created = psql(admin, `CREATE DATABASE ${scratchName}`);
if (created.status !== 0) {
  die('could not create the scratch database', created.stderr || created.stdout);
}
target.pathname = `/${scratchName}`;
env.DATABASE_URL = target.toString();

function dropScratch() {
  psql(admin, `DROP DATABASE IF EXISTS ${scratchName}`);
}

const tsx = join(root, 'apps', 'api', 'node_modules', '.bin', 'tsx');
const run = existsSync(tsx)
  ? sh(tsx, ['src/db/rehearse.ts'], { env, cwd: join(root, 'apps/api') })
  : sh('node', ['--experimental-strip-types', 'src/db/rehearse.ts'], { env, cwd: join(root, 'apps/api') });

// 3. Drop the scratch database, then tear down only what this run started.
dropScratch();
if (started) {
  sh('docker', ['compose', 'stop', SERVICE]);
}

if (run.status !== 0) {
  die('up → down → up rehearsal did not complete', run.stdout || run.stderr);
}
if (run.stdout) console.log(run.stdout.trimEnd());
console.log('migration-check: OK.');
