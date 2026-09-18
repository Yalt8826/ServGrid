import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  JobCardDispatcherSchema,
  type JobCardDispatcher,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * The dispatcher's reads (PHASE-2-DISPATCHER.md T2.2, PLAN-BACKEND.md §6.3).
 * Runs against a scratch database from the real migrations (§14: no mocked
 * database anywhere) and proves the three things the brief names:
 *
 *  - `?overdue=true` returns EXACTLY the fixture's overdue jobs — the open
 *    ones whose scheduled_date has passed; a completed or cancelled job
 *    past its date is not overdue, and nothing advanced a date to make it
 *    so (`is_overdue` is read from `v_job_cards_dispatcher` — overdue is a
 *    filter, not a state);
 *  - a dispatcher query joining `job_completions` FAILS the lint rule —
 *    proven by a fixture file expected to fail (fixtures/lint-firing/),
 *    run through the repo's real eslint config; the shipped
 *    repo.dispatcher.ts must lint clean under the same command;
 *  - `q` searches job number, customer name and phone.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_jobs_dispatcher_test';
const PASSWORD = 'qd-plain-copier-58';

/** The repo root, derived from this file: apps/api/test/integration → up 4. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The IST calendar date `offset` days from now, as YYYY-MM-DD (IST). */
function istDate(offsetDays: number): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000 + 5.5 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/** A UTC instant whose IST wall clock is 12:00 on the given IST date. */
function istNoonUtc(offsetDays: number): string {
  return new Date(`${istDate(offsetDays)}T12:00:00+05:30`).toISOString();
}

const DISPATCHER = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const CUSTOMER_MAIN = { id: '', name: 'Queue-Dispatch Customer', phone: '9847000001' };
const CUSTOMER_SEARCH = { id: '', name: 'Kormangala Search Site', phone: '9847000002' };

/** Fixed job numbers so `q` has stable needles. */
const JOB = {
  overdue1: 'JC-QD-0901', // assigned, scheduled yesterday — OVERDUE
  overdue2: 'JC-QD-0902', // in_progress, scheduled 10 days ago — OVERDUE
  today: 'JC-QD-0903', // assigned, scheduled today — not overdue
  donePast: 'JC-QD-0904', // completed, scheduled 5 days ago — terminal, NOT overdue
  cancelledPast: 'JC-QD-0905', // cancelled, 2 days ago — terminal, NOT overdue
  byNumber: 'JC-QD-0134', // open at the search customer — `q` by job number
  undated: 'JC-QD-0906', // open, NO date yet — isOverdue false, never null
};

async function loginDispatcher(): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username: DISPATCHER.username,
      password: PASSWORD,
      device: {
        installId: `install-${DISPATCHER.username}`,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  DISPATCHER.token = res.json<LoginResponse>().accessToken;
}

async function seedJob(opts: {
  jobNumber: string;
  status: string;
  customerId: string;
  scheduledFor?: string;
  closedAt?: string;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to,
                            assigned_at, scheduled_for, closed_at)
     VALUES ($1, $2, $3, 'Queue-Dispatch fixture job', $4, $5, $6, $7, $8) RETURNING id`,
    [
      opts.jobNumber,
      opts.customerId,
      serviceId,
      opts.status,
      opts.status === 'unassigned' ? null : techId,
      opts.status === 'unassigned' ? null : new Date().toISOString(),
      opts.scheduledFor ?? null,
      opts.closedAt ?? null,
    ],
  );
  return r.rows[0]!.id;
}

/** The completion row §6.2's transaction would leave on donePast. */
async function seedCompletion(jobId: string, completedBy: string): Promise<void> {
  await db.query(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount,
        discount_reason, collection_mode)
     VALUES ($1, $2, $3, 'Replaced batteries, tested load.', '14500.00', '1500.00', 'goodwill', 'cash')`,
    [jobId, completedBy, new Date().toISOString()],
  );
}

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${DISPATCHER.token}` };
}

async function listJobs(query: string): Promise<JobCardDispatcher[]> {
  const res = await app.inject({ method: 'GET', url: `/v1/jobs?${query}`, headers: bearer() });
  expect(res.statusCode, res.body).toBe(200);
  return JobCardDispatcherSchema.array().parse(JSON.parse(res.body).items);
}

let serviceId = '';
let techId = '';

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  const dispatcherUsername = `qd.dispatcher.${randomBytes(4).toString('hex')}`;
  const dispatcherId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, $2, 'Queue-Dispatch dispatcher', 'dispatcher') RETURNING id`,
      [dispatcherUsername, await hashPassword(PASSWORD)],
    )
  ).rows[0]!.id;
  DISPATCHER.id = dispatcherId;
  DISPATCHER.username = dispatcherUsername;

  techId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', 'Queue-Dispatch technician', 'technician') RETURNING id`,
      [`qd.tech.${randomBytes(4).toString('hex')}`],
    )
  ).rows[0]!.id;

  for (const c of [CUSTOMER_MAIN, CUSTOMER_SEARCH]) {
    c.id = (
      await db.query<{ id: string }>(
        `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
        [c.name, c.phone],
      )
    ).rows[0]!.id;
  }
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('QD-SVC', 'Queue-Dispatch suite service') RETURNING id`,
    )
  ).rows[0]!.id;

  await loginDispatcher();

  await seedJob({ jobNumber: JOB.overdue1, status: 'assigned', customerId: CUSTOMER_MAIN.id, scheduledFor: istNoonUtc(-1) });
  await seedJob({ jobNumber: JOB.overdue2, status: 'in_progress', customerId: CUSTOMER_MAIN.id, scheduledFor: istNoonUtc(-10) });
  await seedJob({ jobNumber: JOB.today, status: 'assigned', customerId: CUSTOMER_MAIN.id, scheduledFor: istNoonUtc(0) });
  const doneJob = await seedJob({
    jobNumber: JOB.donePast,
    status: 'completed',
    customerId: CUSTOMER_MAIN.id,
    scheduledFor: istNoonUtc(-5),
    closedAt: new Date().toISOString(),
  });
  await seedCompletion(doneJob, techId);
  await seedJob({
    jobNumber: JOB.cancelledPast,
    status: 'cancelled',
    customerId: CUSTOMER_MAIN.id,
    scheduledFor: istNoonUtc(-2),
    closedAt: new Date().toISOString(),
  });
  await seedJob({ jobNumber: JOB.byNumber, status: 'assigned', customerId: CUSTOMER_SEARCH.id, scheduledFor: istNoonUtc(1) });
  await seedJob({ jobNumber: JOB.undated, status: 'assigned', customerId: CUSTOMER_MAIN.id });
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  // The lint fixture's temp copy lives under node_modules; never leave it.
  rmSync(join(REPO_ROOT, 'node_modules/.cache/servgrid-t2.2-lint-fixture'), { recursive: true, force: true });
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('GET /v1/jobs?overdue=true — overdue is a filter, not a state', () => {
  it('returns exactly the fixture’s overdue jobs — open, past their scheduled date', async () => {
    const items = await listJobs('overdue=true');
    expect(items.map((j) => j.jobNumber).sort()).toEqual([JOB.overdue1, JOB.overdue2].sort());
    for (const job of items) {
      expect(job.isOverdue, `${job.jobNumber} must be overdue`).toBe(true);
    }
  });

  it('an open job with no date yet is not overdue — false, never null', async () => {
    // The view ANDs a NULL scheduled_date into a NULL is_overdue; the
    // read normalises it: no promise made, no promise broken, and the
    // wire's boolean stays a boolean.
    const items = await listJobs(`q=${JOB.undated}`);
    expect(items.map((j) => j.jobNumber)).toEqual([JOB.undated]);
    expect(items[0]!.isOverdue).toBe(false);
    expect(items[0]!.scheduledFor).toBeNull();
  });

  it('nothing advanced a date: the same rows, unfiltered, keep their states and flags', async () => {
    const items = await listJobs('limit=200');
    const byNumber = new Map(items.map((j) => [j.jobNumber, j]));
    expect(byNumber.size).toBe(7);

    expect(byNumber.get(JOB.overdue1)?.status).toBe('assigned');
    expect(byNumber.get(JOB.overdue1)?.isOverdue).toBe(true);
    expect(byNumber.get(JOB.overdue2)?.status).toBe('in_progress');
    expect(byNumber.get(JOB.overdue2)?.isOverdue).toBe(true);

    // The open job promised for today is not overdue, and the closed ones
    // are terminal — a completed job past its date is not overdue.
    expect(byNumber.get(JOB.today)?.isOverdue).toBe(false);
    expect(byNumber.get(JOB.donePast)?.status).toBe('completed');
    expect(byNumber.get(JOB.donePast)?.isOverdue).toBe(false);
    expect(byNumber.get(JOB.cancelledPast)?.status).toBe('cancelled');
    expect(byNumber.get(JOB.cancelledPast)?.isOverdue).toBe(false);
  });

  it('an open job with no date counts as today’s work, and is never overdue (2026-09-19)', async () => {
    // The figures ride `dispatch.console` — the dispatcher dashboard's own
    // T0 rollback — so the suite switches it on for this probe, the way the
    // matrix suite rides its flag-gated ones.
    await db.query(
      `INSERT INTO employee_flag_overrides (employee_id, flag, enabled)
       VALUES ($1, 'dispatch.console', true)
       ON CONFLICT (employee_id, flag) DO UPDATE SET enabled = true`,
      [DISPATCHER.id],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/jobs/summary',
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ overdue: number; unassigned: number; today: number; doneToday: number }>();

    // The undated open job (`JOB.undated`) is actionable now — the same rule
    // the technician's own Today tab uses — so it is today's work; the job
    // promised for today is the other. Two, not one.
    expect(body.today).toBe(2);
    // …and it is NOT overdue: a job that was never promised is never late.
    // The two overdue jobs are the ones whose promised day has passed.
    expect(body.overdue).toBe(2);
    // Every fixture job is assigned, so nothing waits for a dispatcher.
    expect(body.unassigned).toBe(0);
  });

  it('overdue=false reads the same list as no filter at all', async () => {
    const filtered = await listJobs('overdue=false&limit=200');
    expect(filtered.map((j) => j.jobNumber).sort()).toEqual(
      Object.values(JOB).sort(),
    );
  });
});

describe('q — job number, customer name and phone', () => {
  it('finds a job by its number fragment', async () => {
    const items = await listJobs('q=0134');
    expect(items.map((j) => j.jobNumber)).toEqual([JOB.byNumber]);
  });

  it('finds a job by its customer’s name', async () => {
    const items = await listJobs('q=Kormangala');
    expect(items.map((j) => j.jobNumber)).toEqual([JOB.byNumber]);
    expect(items[0]?.customerName).toBe(CUSTOMER_SEARCH.name);
  });

  it('finds a job by a fragment of the customer’s phone', async () => {
    const items = await listJobs('q=847000002');
    expect(items.map((j) => j.jobNumber)).toEqual([JOB.byNumber]);
  });

  it('does not search the title — the dispatcher searches what the phone call gives him', async () => {
    const items = await listJobs('q=fixture');
    expect(items).toEqual([]);
  });

  it('combines with the other filters — q inside a technician’s board', async () => {
    const items = await listJobs(`q=Kormangala&technicianId=${techId}`);
    expect(items.map((j) => j.jobNumber)).toEqual([JOB.byNumber]);
  });
});

describe('the revenue-leak lint rule fires on this path (PLAN-BACKEND.md §5 rule 2)', () => {
  const FIXTURE_SRC = join(
    REPO_ROOT,
    'apps/api/test/integration/fixtures/lint-firing/repo.dispatcher.ts.fixture',
  );
  const LINT_TMP = join(REPO_ROOT, 'node_modules/.cache/servgrid-t2.2-lint-fixture');
  const LINT_TMP_FILE = join(LINT_TMP, 'repo.dispatcher.ts');

  it('a dispatcher query joining job_completions produces exactly one no-sql-money-tables error', () => {
    // The fixture must be present and must be named repo.dispatcher.ts for
    // the rule's path filter to apply — hence the copy (the .fixture
    // extension keeps every standing lint gate blind to it).
    expect(existsSync(FIXTURE_SRC), `${FIXTURE_SRC} exists`).toBe(true);
    mkdirSync(LINT_TMP, { recursive: true });
    copyFileSync(FIXTURE_SRC, LINT_TMP_FILE);

    const eslintJs = join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
    const result = spawnSync(
      process.execPath,
      [eslintJs, '--no-ignore', '--config', join(REPO_ROOT, '.eslintrc.cjs'), '--format', 'json', LINT_TMP_FILE],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();

    const reports = JSON.parse(result.stdout) as Array<{
      filePath: string;
      errorCount: number;
      messages: Array<{ ruleId: string | null; message: string }>;
    }>;
    const report = reports.find((r) => r.filePath === LINT_TMP_FILE);
    expect(report, 'eslint reported on the fixture').toBeDefined();
    expect(report!.errorCount).toBe(1);
    expect(report!.messages[0]!.ruleId).toBe('servgrid-rules/no-sql-money-tables');
    expect(report!.messages[0]!.message).toContain('job_completions');
  });

  it('the shipped repo.dispatcher.ts lints clean under the same command', () => {
    const shipped = join(REPO_ROOT, 'apps/api/src/modules/jobs/repo.dispatcher.ts');
    expect(existsSync(shipped)).toBe(true);
    // Read as a sanity check first: a fixture that silently degraded into
    // an empty file would prove nothing about the rule.
    expect(readFileSync(FIXTURE_SRC, 'utf8')).toContain('job_completions');

    const eslintJs = join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
    const result = spawnSync(
      process.execPath,
      [eslintJs, '--no-ignore', '--config', join(REPO_ROOT, '.eslintrc.cjs'), '--format', 'json', shipped],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();

    const reports = JSON.parse(result.stdout) as Array<{ filePath: string; errorCount: number; messages: unknown[] }>;
    const report = reports.find((r) => r.filePath === shipped);
    expect(report, 'eslint reported on the shipped file').toBeDefined();
    expect(report!.errorCount, JSON.stringify(report!.messages)).toBe(0);
    rmSync(LINT_TMP, { recursive: true, force: true });
  });
});
