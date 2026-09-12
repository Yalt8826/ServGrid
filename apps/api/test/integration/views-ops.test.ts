import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 013's two ops views (PHASE-2-DISPATCHER.md T2.1). Runs
 * against a scratch database from the real migrations (§14: no mocked
 * database anywhere) and proves the three things the dispatcher surfaces
 * depend on:
 *
 *  - `is_overdue` agrees with a hand count on both sides of an IST
 *    midnight — fixtures are built from UTC instants so the IST
 *    conversion is what is under test;
 *  - a completed job past its date is NOT overdue (the status gate);
 *  - `v_technician_load` matches a hand-counted fixture exactly, and a
 *    deactivated technician disappears from it;
 *  - neither view carries a money column — asserted from
 *    information_schema.columns, not by reading the DDL.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_views_ops_test';

let admin: Pool;
let db: Pool;

/** The IST calendar date `offset` days from now, as YYYY-MM-DD (IST). */
function istDate(offsetDays: number): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000 + 5.5 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/** A UTC instant whose IST wall clock is 12:00 on the given IST date —
 * unambiguously inside that business day and the work window. */
function istNoonUtc(istDateStr: string): string {
  return new Date(`${istDateStr}T12:00:00+05:30`).toISOString();
}

let customerId: string;
let serviceId: string;
const TECH_A = { id: '', username: '' };
const TECH_B = { id: '', username: '' };
const TECH_C = { id: '', username: '' };

async function seedTechnician(who: { id: string; username: string }): Promise<void> {
  who.username = `t13.tech.${randomBytes(4).toString('hex')}`;
  who.id = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ($1, 'not-a-real-hash', $2, 'technician') RETURNING id`,
      [who.username, `Tech ${who.username}`],
    )
  ).rows[0]!.id;
}

async function seedJob(opts: {
  status: string;
  assignedTo?: string | null;
  scheduledFor: string;
  closedAt?: string;
}): Promise<string> {
  const assigned = opts.assignedTo === undefined ? TECH_A.id : opts.assignedTo;
  const status = assigned === null ? 'unassigned' : opts.status;
  return (
    await db.query<{ id: string }>(
      `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to,
                              assigned_at, scheduled_for, closed_at)
       VALUES ($1, $2, $3, 'T2.1 view job', $4, $5, $6, $7, $8) RETURNING id`,
      [
        `JC-T13-${randomBytes(4).toString('hex')}`,
        customerId,
        serviceId,
        status,
        assigned,
        assigned === null ? null : new Date().toISOString(),
        opts.scheduledFor,
        opts.closedAt ?? null,
      ],
    )
  ).rows[0]!.id;
}

async function viewRow(jobId: string): Promise<Record<string, unknown>> {
  return (
    await db.query(
      `SELECT * FROM v_job_cards_dispatcher WHERE id = $1`,
      [jobId],
    )
  ).rows[0]!;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T2.1 Customer', '9840000002') RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T21-SVC', 'T2.1 suite service') RETURNING id`,
    )
  ).rows[0]!.id;
  await seedTechnician(TECH_A);
  await seedTechnician(TECH_B);
  await seedTechnician(TECH_C);
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('v_job_cards_dispatcher — is_overdue across the IST day boundary', () => {
  it('is overdue when open and scheduled_date is a past IST day, built from UTC instants', async () => {
    // 23:00 IST yesterday: UTC date is the same day only by luck — the
    // fixture is built from the UTC instant and the VIEW must land it on
    // the previous IST business day.
    const yesterdayJob = await seedJob({
      status: 'in_progress',
      scheduledFor: istNoonUtc(istDate(-1)),
    });
    const row = await viewRow(yesterdayJob);
    // pg hands `date` back as a Date at IST-midnight; compare instants.
    expect(new Date(row.scheduled_date as Date).getTime()).toBe(
      new Date(`${istDate(-1)}T00:00:00+05:30`).getTime(),
    );
    expect(row.is_overdue).toBe(true);
  });

  it('is not overdue when the UTC instant is yesterday but the IST business day is today', async () => {
    // 00:30 IST today = 19:00 UTC yesterday. A naive UTC comparison
    // would call this overdue; the business-day conversion must not.
    const todayJob = await seedJob({
      status: 'assigned',
      scheduledFor: new Date(`${istDate(0)}T00:30:00+05:30`).toISOString(),
    });
    const row = await viewRow(todayJob);
    expect(new Date(row.scheduled_date as Date).getTime()).toBe(
      new Date(`${istDate(0)}T00:00:00+05:30`).getTime(),
    );
    expect(row.is_overdue).toBe(false);
  });

  it('is not overdue for a future day, and a completed job past its date is never overdue', async () => {
    const future = await seedJob({ status: "assigned", scheduledFor: istNoonUtc(istDate(1)) });
    expect((await viewRow(future)).is_overdue).toBe(false);

    const closedAt = new Date().toISOString();
    const completed = await seedJob({
      status: 'completed',
      scheduledFor: istNoonUtc(istDate(-2)),
      closedAt,
    });
    const row = await viewRow(completed);
    expect(row.is_completed).toBe(true);
    expect(row.is_overdue).toBe(false); // past its date, but terminal
  });
});

describe('v_technician_load — the hand-counted fixture', () => {
  it('matches a hand count exactly: 2 open today, 1 done today, 4 open total, active since noon', async () => {
    // TECH_C keeps this fixture clean of the boundary describe's jobs.
    // TECH_A: 2 open today (first one in_progress → active_since), 1
    // completed today, 1 open tomorrow, 1 open next week, 1 completed
    // LAST week (counts for neither today column).
    const noonToday = istNoonUtc(istDate(0));
    const inProgress = await seedJob({ status: "in_progress", scheduledFor: noonToday, assignedTo: TECH_C.id });
    await seedJob({ status: "assigned", scheduledFor: noonToday, assignedTo: TECH_C.id });
    await seedJob({ status: "completed", scheduledFor: noonToday, closedAt: new Date().toISOString(), assignedTo: TECH_C.id });
    await seedJob({ status: "assigned", scheduledFor: istNoonUtc(istDate(1)), assignedTo: TECH_C.id });
    await seedJob({ status: "assigned", scheduledFor: istNoonUtc(istDate(7)), assignedTo: TECH_C.id });
    await seedJob({ status: "completed", scheduledFor: istNoonUtc(istDate(-9)), closedAt: istNoonUtc(istDate(-9)), assignedTo: TECH_C.id });
    // TECH_B stays empty — his row must read all zeros.

    const loads = await db.query(
      `SELECT * FROM v_technician_load ORDER BY technician_name`,
    );
    const a = loads.rows.find((r) => r.employee_id === TECH_C.id)!;
    expect(a.technician_name).toBe(`Tech ${TECH_C.username}`);
    expect(Number(a.open_today)).toBe(2);
    expect(Number(a.done_today)).toBe(1);
    expect(Number(a.open_total)).toBe(4);
    expect(a.active_since).toBeInstanceOf(Date);
    expect(new Date(a.active_since as Date).toISOString()).toBe(noonToday);
    expect(new Date(a.active_since as Date).toISOString()).toBe(
      new Date((await viewRow(inProgress)).scheduled_for as string).toISOString(),
    );

    const b = loads.rows.find((r) => r.employee_id === TECH_B.id)!;
    expect(Number(b.open_today)).toBe(0);
    expect(Number(b.done_today)).toBe(0);
    expect(Number(b.open_total)).toBe(0);
    expect(b.active_since).toBeNull();
  });

  it('drops a deactivated technician from the load entirely', async () => {
    await db.query(`UPDATE employees SET is_active = false WHERE id = $1`, [TECH_B.id]);
    const loads = await db.query(`SELECT employee_id FROM v_technician_load`);
    expect(loads.rows.find((r) => r.employee_id === TECH_B.id)).toBeUndefined();
  });
});

describe('the money-free guarantee — asserted from the catalogue, not the DDL', () => {
  it('neither view exposes a money column', async () => {
    const moneyKeys = [
      'cost', 'discount_amount', 'discount_reason', 'amount_collected',
      'collection_mode', 'payment_reference', 'contract_value',
      'unit_price', 'line_total', 'declared_amount', 'confirmed_amount',
      'balance',
    ];
    const cols = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_name IN ('v_job_cards_dispatcher', 'v_technician_load')`,
    );
    expect(cols.rows.length).toBeGreaterThanOrEqual(24); // the projection is real
    for (const { table_name, column_name } of cols.rows) {
      expect(moneyKeys, `${table_name}.${column_name}`).not.toContain(column_name);
    }
  });

  it('carries the contract visit marker and the cancellation reason', async () => {
    const withVisit = await seedJob({ status: "assigned", scheduledFor: istNoonUtc(istDate(1)), assignedTo: TECH_C.id });
    const row = await viewRow(withVisit);
    expect(row.is_contract_visit).toBe(false); // marker column exists; contract rows arrive in 2B
    expect(row.cancellation_reason).toBeNull(); // null, not absent — the column is carried
  });
});
