import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 015 integration suite (PHASE-2B-CONTRACTS.md T2B.1): the
 * service_contracts table, job_cards.contract_id and the v_contracts
 * view (PLAN-DATA-MODEL.md §3.10, §4). Runs against the real Postgres
 * 16 from `docker compose up db` — no mocked database anywhere
 * (PLAN-BACKEND.md §14). The suite builds its own scratch database from
 * the server's admin connection and drops it afterwards; a failed run
 * leaves nothing behind.
 *
 * Every rule the brief names is proven by a FAILING statement or a real
 * row in v_contracts, not by reading the DDL:
 *
 *  - one AMC per site at a time is the exclusion constraint — an
 *    overlap is unrepresentable, a renewal on the next day and an
 *    overlap with a CANCELLED AMC are both accepted;
 *  - state and every reminder rule are the view's own output, built
 *    from dates relative to the IST business day of `now()`, so the
 *    suite passes on any calendar day.
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

const SCRATCH_DB = 'servgrid_contracts_schema_test';

let admin: Pool;
let db: Pool;

let dispatcherId = '';
let technicianId = '';
let serviceId = '';
let today = '';

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${SCRATCH_DB}`;
  db = new Pool({ connectionString: url.toString(), max: 5 });
  await runMigrations({ pool: db });

  dispatcherId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ('t2b1.dispatch', 'test-argon2id-hash', 'T2B1 Dispatcher', 'dispatcher')
       RETURNING id`,
    )
  ).rows[0]!.id;
  technicianId = (
    await db.query<{ id: string }>(
      `INSERT INTO employees (username, password_hash, full_name, role)
       VALUES ('t2b1.tech', 'test-argon2id-hash', 'T2B1 Technician', 'technician')
       RETURNING id`,
    )
  ).rows[0]!.id;
  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T2B1-AMC', 'AMC Service') RETURNING id`,
    )
  ).rows[0]!.id;

  // The IST business day the suite is running on. EVERY date below is
  // built relative to this, so no fixture ages.
  today = (
    await db.query<{ d: string }>(`SELECT business_date(now())::text AS d`)
  ).rows[0]!.d;
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

/** Run a statement expected to fail; return the Postgres error's code
 * and constraint name (when the failure is a constraint). */
async function errorOf(
  query: Promise<unknown>,
): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await query;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    return { code: e.code ?? '', constraint: e.constraint, message: e.message ?? '' };
  }
  throw new Error('expected the query to fail, but it succeeded');
}

/** Insert a customer site, returning its id. */
async function newCustomer(name: string): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
    [name, `9841${String(seq).padStart(8, '0')}`],
  );
  return r.rows[0]!.id;
}

/** Insert a service contract, returning its id. Dates are IST business
 * days as text; a cancelled contract carries all three cancellation
 * columns, as the coherence constraint demands. */
async function insertContract(overrides: {
  customerId: string;
  start: string;
  end: string;
  value?: string;
  cancelled?: boolean;
  contractNumber?: string;
}): Promise<string> {
  seq += 1;
  const cancelled = overrides.cancelled ?? false;
  const r = await db.query<{ id: string }>(
    `INSERT INTO service_contracts
       (contract_number, customer_id, start_date, end_date, contract_value,
        notes, created_by, cancelled_at, cancelled_by, cancel_reason)
     VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      overrides.contractNumber ?? `AMC-TEST-${seq}`,
      overrides.customerId,
      overrides.start,
      overrides.end,
      overrides.value ?? '12000.00',
      'T2B.1 fixture',
      dispatcherId,
      cancelled ? new Date() : null,
      cancelled ? dispatcherId : null,
      cancelled ? 'cancelled by test fixture' : null,
    ],
  );
  return r.rows[0]!.id;
}

/** Insert a job card, returning its id. `closedAt` / `scheduledFor` are
 * IST business-day strings; they are stamped at noon IST so
 * business_date(closed_at) is exactly the day the test means, whatever
 * the server's timezone. A closed or assigned status needs somebody on
 * the card (job_assignment_coherent), so non-unassigned statuses carry
 * the technician. */
async function insertJob(overrides: {
  customerId: string;
  status?: string;
  closedAt?: string;
  scheduledFor?: string;
  contractId?: string;
  jobNumber?: string;
}): Promise<string> {
  seq += 1;
  const status = overrides.status ?? 'unassigned';
  const assigned = status !== 'unassigned';
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards
       (job_number, customer_id, service_id, title, status, assigned_to,
        assigned_at, closed_at, scheduled_for, contract_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             ($8::date + time '12:00') AT TIME ZONE 'Asia/Kolkata',
             ($9::date + time '12:00') AT TIME ZONE 'Asia/Kolkata',
             $10)
     RETURNING id`,
    [
      overrides.jobNumber ?? `JC-T2B1-${seq}`,
      overrides.customerId,
      serviceId,
      `T2B.1 job ${seq}`,
      status,
      assigned ? technicianId : null,
      assigned ? new Date() : null,
      overrides.closedAt ?? null,
      overrides.scheduledFor ?? null,
      overrides.contractId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Month arithmetic through the SAME SQL the view uses, so assertions
 * about next_visit_due cannot disagree with it about month ends. */
async function shiftMonths(iso: string, months: number): Promise<string> {
  const r = await db.query<{ d: string }>(
    `SELECT ($1::date + ($2 || ' months')::interval)::date::text AS d`,
    [iso, months],
  );
  return r.rows[0]!.d;
}

/** One v_contracts row, with every date as text for exact comparison. */
async function contractRow(id: string) {
  const r = await db.query(
    `SELECT id, contract_number, customer_id, customer_name,
            start_date::text AS start_date, end_date::text AS end_date,
            contract_value::text AS contract_value, state,
            last_service_date::text AS last_service_date,
            next_visit_due::text AS next_visit_due,
            open_job_id, open_job_number, days_to_end,
            is_visit_due, is_ending_soon
       FROM v_contracts WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

describe('service_contracts constraints', () => {
  it('refuses an overlapping AMC at the same site', async () => {
    const customer = await newCustomer('Overlap Site');
    await insertContract({ customerId: customer, start: today, end: shift(today, 364) });
    const err = await errorOf(
      insertContract({
        customerId: customer,
        start: shift(today, 100),
        end: shift(today, 400),
      }),
    );
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('service_contracts_no_overlap');
  });

  it('accepts a renewal starting the day after the term ends', async () => {
    const customer = await newCustomer('Renewal Site');
    await insertContract({
      customerId: customer,
      start: shift(today, -365),
      end: today,
    });
    const renewal = await insertContract({
      customerId: customer,
      start: shift(today, 1),
      end: shift(today, 365),
    });
    const n = await db.query(
      `SELECT count(*)::int AS n FROM service_contracts WHERE customer_id = $1`,
      [customer],
    );
    expect(n.rows[0]!.n).toBe(2);
    expect(renewal).toBeTruthy();
  });

  it('treats the same-day boundary as an overlap (ranges are inclusive)', async () => {
    const customer = await newCustomer('Same-day Site');
    await insertContract({
      customerId: customer,
      start: shift(today, -365),
      end: today,
    });
    const err = await errorOf(
      insertContract({ customerId: customer, start: today, end: shift(today, 365) }),
    );
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('service_contracts_no_overlap');
  });

  it('never collides across different customers', async () => {
    const x = await newCustomer('Range X');
    const y = await newCustomer('Range Y');
    const a = await insertContract({ customerId: x, start: today, end: shift(today, 364) });
    const b = await insertContract({ customerId: y, start: today, end: shift(today, 364) });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it('lets a cancelled AMC be recorded again over the same dates', async () => {
    const customer = await newCustomer('Re-recorded Site');
    await insertContract({
      customerId: customer,
      start: today,
      end: shift(today, 364),
      cancelled: true,
    });
    const replacement = await insertContract({
      customerId: customer,
      start: today,
      end: shift(today, 364),
    });
    expect(replacement).toBeTruthy();
  });

  it('refuses a term that ends before it starts; a one-day term is fine', async () => {
    const customer = await newCustomer('Backwards Site');
    const err = await errorOf(
      insertContract({ customerId: customer, start: today, end: shift(today, -1) }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('service_contracts_term_ordered');

    const oneDay = await insertContract({
      customerId: await newCustomer('One-day Site'),
      start: today,
      end: today,
    });
    expect(oneDay).toBeTruthy();
  });

  it('refuses a negative contract value', async () => {
    const customer = await newCustomer('Negative Site');
    const err = await errorOf(
      insertContract({ customerId: customer, start: today, end: shift(today, 364), value: '-1.00' }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('service_contracts_value_non_negative');
  });

  it('refuses a half-filled cancellation — including a blank reason', async () => {
    const customer = await newCustomer('Half Cancel Site');
    const atOnly = errorOf(
      db.query(
        `INSERT INTO service_contracts
           (contract_number, customer_id, start_date, end_date, contract_value,
            created_by, cancelled_at)
         VALUES ('AMC-TEST-HALF1', $1, $2, $3, '12000.00', $4, now())`,
        [customer, today, shift(today, 364), dispatcherId],
      ),
    );
    const blankReason = errorOf(
      db.query(
        `INSERT INTO service_contracts
           (contract_number, customer_id, start_date, end_date, contract_value,
            created_by, cancelled_at, cancelled_by, cancel_reason)
         VALUES ('AMC-TEST-HALF2', $1, $2, $3, '12000.00', $4, now(), $4, '  ')`,
        [customer, shift(today, -400), shift(today, -36), dispatcherId],
      ),
    );
    for (const err of await Promise.all([atOnly, blankReason])) {
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('service_contracts_cancellation_coherent');
    }
  });

  it('refuses a duplicate contract number', async () => {
    const customer = await newCustomer('Duplicate Site');
    await insertContract({
      customerId: customer,
      start: today,
      end: shift(today, 364),
      contractNumber: 'AMC-TEST-DUP',
    });
    const err = await errorOf(
      insertContract({
        customerId: await newCustomer('Duplicate Site 2'),
        start: today,
        end: shift(today, 364),
        contractNumber: 'AMC-TEST-DUP',
      }),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('service_contracts_number_unique');
  });

  it('bumps version and updated_at on an untouched update (touch trigger)', async () => {
    const customer = await newCustomer('Touch Site');
    const id = await insertContract({ customerId: customer, start: today, end: shift(today, 364) });
    const before = (
      await db.query<{ version: number; updated_at: Date }>(
        `SELECT version, updated_at FROM service_contracts WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    await db.query(`UPDATE service_contracts SET notes = 'x' WHERE id = $1`, [id]);
    const after = (
      await db.query<{ version: number; updated_at: Date }>(
        `SELECT version, updated_at FROM service_contracts WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(after.version).toBe(before.version + 1);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe('job_cards.contract_id', () => {
  it('refuses a contract_id that points nowhere', async () => {
    const customer = await newCustomer('Dangling Link Site');
    const err = await errorOf(
      insertJob({ customerId: customer, contractId: '00000000-0000-0000-0000-00000000dead' }),
    );
    expect(err.code).toBe('23503');
  });

  it('drives is_contract_visit in v_job_cards_dispatcher, appended as the last column', async () => {
    const customer = await newCustomer('Linked Site');
    const contract = await insertContract({
      customerId: customer,
      start: today,
      end: shift(today, 364),
    });
    const linked = await insertJob({ customerId: customer, contractId: contract });
    const plain = await insertJob({ customerId: customer });

    const rows = (
      await db.query<{ id: string; is_contract_visit: boolean }>(
        `SELECT id, is_contract_visit FROM v_job_cards_dispatcher WHERE id = ANY($1::uuid[])`,
        [[linked, plain]],
      )
    ).rows;
    expect(rows).toMatchObject([
      { id: linked, is_contract_visit: true },
      { id: plain, is_contract_visit: false },
    ]);

    const cols = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'v_job_cards_dispatcher'
          ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.column_name);
    // CREATE OR REPLACE can only append, so contract_id must be LAST —
    // and the retired contract_visit_id keeps its 013 position for the
    // previous API image's rollback.
    expect(cols[cols.length - 1]).toBe('contract_id');
    expect(cols).toContain('contract_visit_id');
  });
});

describe('v_contracts state', () => {
  it('derives upcoming, active, expired and cancelled from the dates alone', async () => {
    const upcomingC = await newCustomer('State Upcoming');
    const activeC = await newCustomer('State Active');
    const expiredC = await newCustomer('State Expired');
    const cancelledC = await newCustomer('State Cancelled');

    const upcoming = await insertContract({
      customerId: upcomingC,
      start: shift(today, 1),
      end: shift(today, 365),
    });
    const active = await insertContract({
      customerId: activeC,
      start: today,
      end: shift(today, 364),
    });
    const expired = await insertContract({
      customerId: expiredC,
      start: shift(today, -365),
      end: shift(today, -1),
    });
    const cancelled = await insertContract({
      customerId: cancelledC,
      start: shift(today, -10),
      end: shift(today, 354),
      cancelled: true,
    });

    expect(await contractRow(upcoming)).toMatchObject({ state: 'upcoming' });
    expect(await contractRow(active)).toMatchObject({ state: 'active' });
    expect(await contractRow(expired)).toMatchObject({ state: 'expired' });
    expect(await contractRow(cancelled)).toMatchObject({ state: 'cancelled' });
  });

  it('counts the days to the end', async () => {
    const customer = await newCustomer('Countdown Site');
    const id = await insertContract({
      customerId: customer,
      start: today,
      end: shift(today, 10),
    });
    expect(await contractRow(id)).toMatchObject({ days_to_end: 10 });
  });
});

describe('v_contracts reminders', () => {
  it('is due four months after the start when the customer has never had a job', async () => {
    const customer = await newCustomer('Never Serviced');
    const start = await shiftMonths(today, -4);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 8) });

    expect(await contractRow(id)).toMatchObject({
      last_service_date: null,
      next_visit_due: await shiftMonths(start, 4),
      is_visit_due: true,
    });
  });

  it('is not due before four months have passed since the start', async () => {
    const customer = await newCustomer('Three Months In');
    const start = await shiftMonths(today, -3);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 9) });

    expect(await contractRow(id)).toMatchObject({
      next_visit_due: await shiftMonths(start, 4),
      is_visit_due: false,
    });
  });

  it('counts the last completed job of ANY kind, AMC-linked or not', async () => {
    const customer = await newCustomer('Any Job Counts');
    const start = await shiftMonths(today, -8);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 4) });
    // Five months ago, NOT linked to the AMC — the owner's rule is
    // about the site, not the paperwork.
    const closedAt = await shiftMonths(today, -5);
    await insertJob({ customerId: customer, status: 'completed', closedAt });

    expect(await contractRow(id)).toMatchObject({
      last_service_date: closedAt,
      next_visit_due: await shiftMonths(closedAt, 4),
      is_visit_due: true,
    });
  });

  it('is not due while the last completed job is under four months old', async () => {
    const customer = await newCustomer('Serviced Last Month');
    const start = await shiftMonths(today, -6);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 6) });
    const closedAt = await shiftMonths(today, -1);
    await insertJob({ customerId: customer, status: 'completed', closedAt });

    expect(await contractRow(id)).toMatchObject({
      last_service_date: closedAt,
      next_visit_due: await shiftMonths(closedAt, 4),
      is_visit_due: false,
    });
  });

  it('does not count a cancelled job as service', async () => {
    const customer = await newCustomer('Cancelled Job Only');
    const start = await shiftMonths(today, -6);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 6) });
    await insertJob({
      customerId: customer,
      status: 'cancelled',
      closedAt: await shiftMonths(today, -1),
    });

    expect(await contractRow(id)).toMatchObject({
      last_service_date: null,
      is_visit_due: true,
    });
  });

  it('is silenced while the customer has an open job, naming that job', async () => {
    const customer = await newCustomer('Already Booked');
    const start = await shiftMonths(today, -4);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 8) });
    const openJob = await insertJob({
      customerId: customer,
      scheduledFor: shift(today, 2),
    });

    expect(await contractRow(id)).toMatchObject({ is_visit_due: false });
    const row = await contractRow(id);
    expect(row.open_job_id).toBe(openJob);
    expect(row.open_job_number).toMatch(/^JC-T2B1-/);
  });

  it('counts from the AMC start when the last job predates the term', async () => {
    const customer = await newCustomer('Old Job New AMC');
    const start = await shiftMonths(today, -2);
    const id = await insertContract({ customerId: customer, start, end: await shiftMonths(today, 10) });
    await insertJob({
      customerId: customer,
      status: 'completed',
      closedAt: await shiftMonths(today, -10),
    });

    expect(await contractRow(id)).toMatchObject({
      next_visit_due: await shiftMonths(start, 4),
      is_visit_due: false,
    });
  });

  it('never reminds for an expired or a cancelled AMC', async () => {
    const expiredC = await newCustomer('Expired Never Due');
    const cancelledC = await newCustomer('Cancelled Never Due');

    const expired = await insertContract({
      customerId: expiredC,
      start: shift(today, -395),
      end: shift(today, -30),
    });
    const cancelled = await insertContract({
      customerId: cancelledC,
      start: shift(today, -395),
      end: shift(today, -30),
      cancelled: true,
    });

    expect(await contractRow(expired)).toMatchObject({ state: 'expired', is_visit_due: false });
    expect(await contractRow(cancelled)).toMatchObject({ state: 'cancelled', is_visit_due: false });
  });

  it('warns ending at seven days, on the last day, not at eight, not when cancelled', async () => {
    const atSeven = await insertContract({
      customerId: await newCustomer('Ending Seven'),
      start: today,
      end: shift(today, 7),
    });
    const atZero = await insertContract({
      customerId: await newCustomer('Ending Today'),
      start: today,
      end: today,
    });
    const atEight = await insertContract({
      customerId: await newCustomer('Ending Eight'),
      start: today,
      end: shift(today, 8),
    });
    const cancelledAtSeven = await insertContract({
      customerId: await newCustomer('Ending Seven Cancelled'),
      start: today,
      end: shift(today, 7),
      cancelled: true,
    });

    expect(await contractRow(atSeven)).toMatchObject({ is_ending_soon: true });
    expect(await contractRow(atZero)).toMatchObject({ is_ending_soon: true });
    expect(await contractRow(atEight)).toMatchObject({ is_ending_soon: false });
    expect(await contractRow(cancelledAtSeven)).toMatchObject({ is_ending_soon: false });
  });
});
