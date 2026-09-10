import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 010 integration suite (PHASE-1-TECHNICIAN.md T1.2): the
 * cash handover table (PLAN-DATA-MODEL.md §3.7). Runs against the real
 * Postgres 16 from `docker compose up db` — no mocked database anywhere
 * (PLAN-BACKEND.md §14). The suite builds its own scratch database from
 * the server's admin connection and drops it afterwards; a failed run
 * leaves nothing behind.
 *
 * Every constraint is proven by a failing INSERT, not by reading the
 * DDL — a constraint that exists but does not fire is worse than one
 * that was never written. The absence of expense columns is likewise
 * proven from information_schema, not asserted: it is a recorded
 * owner decision, and this test is what notices if it ever regresses.
 */

function databaseUrl(): string {
  // CI exports DATABASE_URL explicitly; locally the compose defaults are
  // the documented shape, so an unset variable falls back to them.
  return (
    process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid'
  );
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_cash_test';

let admin: Pool;
let db: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });
});

afterAll(async () => {
  await db?.end();
  if (admin) {
    // WITH (FORCE): the scratch pools are closed above, but a failed
    // test may have abandoned a client — never wedge the suite.
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

let seq = 0;

/** Insert an employee, returning its id. */
async function insertEmployee(role = 'technician'): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, 'test-argon2id-hash', $2, $3)
     RETURNING id`,
    [`t12cash${seq}`, `Cash ${seq}`, role],
  );
  return r.rows[0]!.id;
}

interface HandoverOverrides {
  businessDate?: string;
  declaredAmount?: string;
  status?: string;
  confirmedAt?: string | null;
  ownerNote?: string | null;
}

/** Insert a cash handover declaration, returning its id. */
async function insertHandover(
  employeeId: string,
  overrides: HandoverOverrides = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO cash_reconciliations
       (employee_id, business_date, declared_amount, declared_at, status, confirmed_at, owner_note)
     VALUES ($1, $2, $3, now(), $4, $5, $6)
     RETURNING id`,
    [
      employeeId,
      overrides.businessDate ?? '2026-03-14',
      overrides.declaredAmount ?? '4500.00',
      overrides.status ?? 'submitted',
      overrides.confirmedAt ?? null,
      overrides.ownerNote ?? null,
    ],
  );
  return r.rows[0]!.id;
}

/** Run a query expected to fail; return the Postgres error code. */
async function errorCodeOf(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (err) {
    return (err as { code?: string }).code ?? '';
  }
  throw new Error('expected the query to fail, but it succeeded');
}

describe('migration 010 — one declaration per employee per day (§3.7)', () => {
  it('rejects a second row for the same (employee, business_date)', async () => {
    const emp = await insertEmployee();
    await insertHandover(emp, { businessDate: '2026-03-14' });
    // The retry-after-offline path leans on this constraint rather
    // than trusting its own check-then-insert.
    const code = await errorCodeOf(
      insertHandover(emp, { businessDate: '2026-03-14', declaredAmount: '5000.00' }),
    );
    expect(code).toBe('23505');
  });

  it('keeps the constraint on the pair: same employee other day, other employee same day', async () => {
    const emp1 = await insertEmployee();
    const emp2 = await insertEmployee();
    await insertHandover(emp1, { businessDate: '2026-03-14' });
    // The same employee on the next day declares again.
    await expect(
      insertHandover(emp1, { businessDate: '2026-03-15' }),
    ).resolves.toBeTruthy();
    // Two employees handing over on the same day are two rows.
    await expect(insertHandover(emp2, { businessDate: '2026-03-14' })).resolves.toBeTruthy();
  });
});

describe('migration 010 — status coherence (§3.7)', () => {
  it("rejects status 'disputed' with no owner_note", async () => {
    const emp = await insertEmployee();
    const code = await errorCodeOf(
      insertHandover(emp, { status: 'disputed', ownerNote: null }),
    );
    expect(code).toBe('23514');
  });

  it("accepts status 'disputed' once the owner's note is present", async () => {
    const emp = await insertEmployee();
    // A dispute is an answer, so it carries confirmed_at like a
    // confirmation does — the CHECK only forbids the timestamp on the
    // unanswered 'submitted' state.
    const id = await insertHandover(emp, {
      status: 'disputed',
      confirmedAt: '2026-03-14T18:30:00Z',
      ownerNote: '₹500 short, employee says customer paid by UPI — checking.',
    });
    expect(id).toBeTruthy();
  });

  it("rejects status 'submitted' with confirmed_at set", async () => {
    const emp = await insertEmployee();
    const code = await errorCodeOf(
      insertHandover(emp, {
        status: 'submitted',
        confirmedAt: '2026-03-14T18:30:00Z',
      }),
    );
    expect(code).toBe('23514');
  });

  it("accepts a confirmed row with confirmed_at set — the answered state", async () => {
    const emp = await insertEmployee();
    const id = await insertHandover(emp, {
      status: 'confirmed',
      confirmedAt: '2026-03-14T18:30:00Z',
      ownerNote: null,
    });
    expect(id).toBeTruthy();
  });
});

describe('PLAN-DATA-MODEL.md §3.7 — no expense columns, the recorded decision', () => {
  it('has none of the removed expense columns', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cash_reconciliations'
         AND column_name LIKE '%expense%'`,
    );
    // The owner confirmed technicians do not spend from collections, so
    // every variance in the queue is a real one. If this test ever
    // fails, the symptom to re-check first is a small, recurring
    // shortfall for one particular employee.
    expect(r.rows).toHaveLength(0);
  });

  it('carries exactly the §3.7 columns, declaration side only', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cash_reconciliations'
       ORDER BY column_name`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual([
      'business_date',
      'confirmed_amount',
      'confirmed_at',
      'confirmed_by',
      'created_at',
      'declared_amount',
      'declared_at',
      'employee_id',
      'employee_note',
      'id',
      'owner_note',
      'reopen_reason',
      'reopened_at',
      'reopened_by',
      'status',
      'updated_at',
      'version',
    ]);
  });
});
