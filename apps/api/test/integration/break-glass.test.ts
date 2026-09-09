import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * Break-glass CLI integration suite (PHASE-0-FOUNDATION.md T0.8,
 * PLAN-BACKEND.md §4, PLAN-GAPS.md G16). The recovery path must be
 * *exercised*, not merely written — an untested recovery path is the
 * same class of belief as an untested backup. The CLI is spawned exactly
 * as the runbook runs it (`pnpm -F api admin:reset-password -- …`) so
 * the exit codes, stdout contract and DATABASE_URL handling are all
 * under test, against a scratch database built from the real migrations.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_breakglass_test';
const PASSWORD = 'mv-breakglass-before-52';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;
let scratchUrl: URL;

interface SeedResult {
  username: string;
  employeeId: string;
  refreshToken: string;
}

async function seedEmployeeWithSession(role: 'owner' | 'technician', installId: string): Promise<SeedResult> {
  const username = `bg.t8.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Break-glass ${username}`, role],
  );
  const employeeId = r.rows[0]!.id;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username,
      password: PASSWORD,
      device: {
        installId,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode).toBe(200);
  return { username, employeeId, refreshToken: res.json<LoginResponse>().refreshToken };
}

/** Run the CLI the way the runbook does: through pnpm, from the repo root. */
function runCli(username: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    'pnpm',
    ['-F', 'api', 'admin:reset-password', '--', '--username', username],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    },
  );
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function auditRowsFor(employeeId: string): Promise<Array<{ action: string; actor: string; details: unknown }>> {
  const r = await db.query<{ action: string; actor: string; details: unknown }>(
    'SELECT action, actor, details FROM audit_log WHERE employee_id = $1 ORDER BY id',
    [employeeId],
  );
  return r.rows;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('admin:reset-password — the break-glass path, exercised', () => {
  it('resets the password, revokes every token, and writes exactly one audit row', async () => {
    const { username, employeeId, refreshToken } = await seedEmployeeWithSession('owner', 'install-bg');

    const before = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM employees WHERE id = $1',
      [employeeId],
    );

    const run = runCli(username);
    expect(run.status, `CLI should exit 0 — stderr: ${run.stderr}`).toBe(0);

    // The printed temp password is the contract — extract and *use* it.
    const tempPassword = /temp-password: (\S+)/.exec(run.stdout)?.[1];
    expect(tempPassword, `stdout should carry the temp password — got: ${run.stdout}`).toBeDefined();
    expect(run.stdout).toContain("reset complete for '");

    // The hash changed, argon2id again, and must_change_password is back on.
    const after = await db.query<{ password_hash: string; must_change_password: boolean }>(
      'SELECT password_hash, must_change_password FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(after.rows[0]!.password_hash).not.toBe(before.rows[0]!.password_hash);
    expect(after.rows[0]!.must_change_password).toBe(true);

    // Every refresh token for the account is dead — the holder's session too.
    const live = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE employee_id = $1 AND revoked_at IS NULL',
      [employeeId],
    );
    expect(live.rows[0]!.n).toBe(0);
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // The old password no longer opens the door; the printed one does,
    // and it presents as temporary.
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username,
        password: PASSWORD,
        device: {
          installId: 'install-bg',
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
        },
      },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        username,
        password: tempPassword!,
        device: {
          installId: 'install-bg',
          platform: 'android',
          appVersion: '0.1.0',
          osVersion: '14',
          manufacturer: 'Xiaomi',
          model: 'Redmi Note 12',
        },
      },
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json<LoginResponse>().mustChangePassword).toBe(true);

    // Exactly one audit row — a writer outside the transaction, or a
    // double insert, shows up here.
    const rows = await auditRowsFor(employeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('password.reset.break_glass');
    expect(rows[0]!.actor).toBe('break-glass');
    expect(rows[0]!.details).toMatchObject({ tokensRevoked: 1, via: 'admin:reset-password' });
  });

  it('exits non-zero for an unknown username and writes nothing', async () => {
    const ghost = `bg.t8.${randomBytes(4).toString('hex')}`;
    const auditBefore = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');

    const run = runCli(ghost);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`no employee named '${ghost}'`);
    expect(run.stderr).toContain('nothing was changed');
    // Not even the shape of success may appear on stdout.
    expect(run.stdout).not.toMatch(/temp-password|reset complete/);

    // No audit row anywhere, no employee row — the whole database untouched.
    const auditAfter = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
    expect(auditAfter.rows[0]!.n).toBe(auditBefore.rows[0]!.n);
    const employee = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM employees WHERE username = $1',
      [ghost],
    );
    expect(employee.rows[0]!.n).toBe(0);
  });

  it('refuses to run without --username', async () => {
    const res = spawnSync('pnpm', ['-F', 'api', 'admin:reset-password'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('usage: admin:reset-password');
  });
});
