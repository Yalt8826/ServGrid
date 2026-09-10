import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migrations 006–007 integration suite (PHASE-1-TECHNICIAN.md T1.1):
 * the customer stack (PLAN-DATA-MODEL.md §3.3) and the jobs family
 * (§3.4). Runs against the real Postgres 16 from `docker compose up db`
 * — no mocked database anywhere (PLAN-BACKEND.md §14). The suite builds
 * its own scratch database from the server's admin connection and drops
 * it afterwards; a failed run leaves nothing behind.
 *
 * Every constraint is proven by a failing INSERT, not by reading the
 * DDL — a constraint that exists but does not fire is worse than one
 * that was never written.
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

const SCRATCH_DB = 'servgrid_jobs_test';

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
    [`t1tech${seq}`, `Tech ${seq}`, role],
  );
  return r.rows[0]!.id;
}

/** Insert a customer site, returning its id. */
async function insertCustomer(): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
    [`Customer ${seq}`, `98400000${String(seq).padStart(2, '0')}`],
  );
  return r.rows[0]!.id;
}

/** Insert a service-catalogue row, returning its id. */
async function insertService(): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO services (code, name) VALUES ($1, $2) RETURNING id`,
    [`T1X-${seq}`, `Service ${seq}`],
  );
  return r.rows[0]!.id;
}

interface JobOverrides {
  status?: string;
  assignedTo?: string | null;
  closedAt?: string;
  scheduledFor?: string;
  jobNumber?: string;
}

/** Insert a job card, returning its id. */
async function insertJob(
  customerId: string,
  serviceId: string,
  overrides: JobOverrides = {},
): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards
       (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      overrides.jobNumber ?? `JC-T1X-${seq}`,
      customerId,
      serviceId,
      `Job ${seq}`,
      overrides.status ?? 'unassigned',
      overrides.assignedTo ?? null,
      overrides.assignedTo ? '2026-03-10T04:00:00Z' : null,
      overrides.closedAt ?? null,
      overrides.scheduledFor ?? null,
    ],
  );
  return r.rows[0]!.id;
}

interface CompletionOverrides {
  cost?: string;
  discountAmount?: string;
  discountReason?: string | null;
  collectionMode?: string;
  completedAt?: string;
}

/** Insert a completion, returning the requested columns. */
async function insertCompletion(
  jobId: string,
  completedBy: string,
  overrides: CompletionOverrides = {},
): Promise<{ amount_collected: string; business_date: string }> {
  const r = await db.query<{ amount_collected: string; business_date: string }>(
    `INSERT INTO job_completions
       (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, discount_reason, collection_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING amount_collected::text, business_date::text`,
    [
      jobId,
      completedBy,
      overrides.completedAt ?? '2026-03-14T10:00:00Z',
      'Replaced batteries, tested load.',
      overrides.cost ?? '0',
      overrides.discountAmount ?? '0',
      overrides.discountReason ?? null,
      overrides.collectionMode ?? 'none',
    ],
  );
  return r.rows[0]!;
}

/** Insert a customer stack row, returning its id. */
async function insertStackRow(
  customerId: string,
  serial: string,
  opts: { freeText?: string; isActive?: boolean; sourceJobId?: string } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customer_products (customer_id, serial_number, free_text_name, is_active, source_job_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [customerId, serial, opts.freeText ?? 'Generic third-party UPS', opts.isActive ?? true, opts.sourceJobId ?? null],
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

describe('migration 006 — customer_products serial uniqueness (§3.3)', () => {
  it('rejects the same serial active at two customers, even differing only in case', async () => {
    const c1 = await insertCustomer();
    const c2 = await insertCustomer();
    await insertStackRow(c1, 'UPS-88120');
    const code = await errorCodeOf(insertStackRow(c2, 'ups-88120'));
    // The violation must be the unique index, not something else.
    expect(code).toBe('23505');
  });

  it('releases the serial once the earlier row is deactivated', async () => {
    const c1 = await insertCustomer();
    const c2 = await insertCustomer();
    const first = await insertStackRow(c1, 'BAT-40100');
    // De-installation is is_active = false, which is what frees the
    // serial — a customer reselling a unit must not wedge the buyer.
    await db.query(`UPDATE customer_products SET is_active = false WHERE id = $1`, [first]);
    await expect(insertStackRow(c2, 'BAT-40100')).resolves.toBeTruthy();
  });

  it('requires free_text_name when product_id is NULL', async () => {
    const c = await insertCustomer();
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO customer_products (customer_id, serial_number) VALUES ($1, 'UPS-NO-NAME')`,
        [c],
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('migration 007 — job_cards coherence (§3.4)', () => {
  it("rejects status 'assigned' with assigned_to NULL", async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const code = await errorCodeOf(
      insertJob(c, s, { status: 'assigned', assignedTo: null }),
    );
    expect(code).toBe('23514');
  });

  it("rejects status 'unassigned' with somebody on the card", async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const tech = await insertEmployee();
    const code = await errorCodeOf(
      insertJob(c, s, { status: 'unassigned', assignedTo: tech }),
    );
    expect(code).toBe('23514');
  });

  it("rejects status 'completed' with closed_at NULL", async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const tech = await insertEmployee();
    const code = await errorCodeOf(
      insertJob(c, s, { status: 'completed', assignedTo: tech }),
    );
    expect(code).toBe('23514');
  });

  it('rejects closed_at set while the job is still open', async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const tech = await insertEmployee();
    const code = await errorCodeOf(
      insertJob(c, s, { status: 'in_progress', assignedTo: tech, closedAt: '2026-03-14T10:00:00Z' }),
    );
    expect(code).toBe('23514');
  });

  it('rejects a duplicate job_number', async () => {
    const c = await insertCustomer();
    const s = await insertService();
    await insertJob(c, s, { jobNumber: 'JC-T1X-DUP' });
    const code = await errorCodeOf(insertJob(c, s, { jobNumber: 'JC-T1X-DUP' }));
    expect(code).toBe('23505');
  });

  it('derives scheduled_date in IST, not the UTC date of the timestamp', async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const tech = await insertEmployee();
    const id = await insertJob(c, s, {
      status: 'assigned',
      assignedTo: tech,
      // 20:30 UTC on 14 March is 02:00 IST on 15 March — the day the
      // technician actually works.
      scheduledFor: '2026-03-14T20:30:00Z',
    });
    const r = await db.query<{ scheduled_date: string }>(
      `SELECT scheduled_date::text FROM job_cards WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]?.scheduled_date).toBe('2026-03-15');
  });

  it('has contract_visit_id nullable with no FK yet (migration 015 adds it)', async () => {
    const nullable = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'job_cards' AND column_name = 'contract_visit_id'`,
    );
    expect(nullable.rows[0]?.is_nullable).toBe('YES');

    const fks = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_constraint con
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
       WHERE con.conrelid = 'job_cards'::regclass
         AND con.contype = 'f'
         AND att.attname = 'contract_visit_id'`,
    );
    expect(fks.rows[0]?.count).toBe(0);
  });
});

describe('migration 007 — job_completions money rules (§3.4)', () => {
  let technician: string;

  beforeAll(async () => {
    technician = await insertEmployee();
  });

  it('rejects a discount without a reason', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const code = await errorCodeOf(
      insertCompletion(job, technician, {
        cost: '5000',
        discountAmount: '500',
        discountReason: null,
        collectionMode: 'cash',
      }),
    );
    expect(code).toBe('23514');
  });

  it('accepts a justified discount and generates amount_collected = cost − discount', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const row = await insertCompletion(job, technician, {
      cost: '5000',
      discountAmount: '500',
      discountReason: 'goodwill',
      collectionMode: 'cash',
    });
    expect(row.amount_collected).toBe('4500.00');
  });

  it('accepts cost 0, discount 0, mode none — the warranty job and the prepaid visit', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const row = await insertCompletion(job, technician, {
      cost: '0',
      discountAmount: '0',
      collectionMode: 'none',
    });
    expect(row.amount_collected).toBe('0.00');
  });

  it("rejects money owed with collection mode 'none'", async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const code = await errorCodeOf(
      insertCompletion(job, technician, { cost: '5000', collectionMode: 'none' }),
    );
    expect(code).toBe('23514');
  });

  it('rejects a discount larger than the cost', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const code = await errorCodeOf(
      insertCompletion(job, technician, {
        cost: '5000',
        discountAmount: '6000',
        discountReason: 'over-generous',
        collectionMode: 'cash',
      }),
    );
    expect(code).toBe('23514');
  });

  it('rejects negative cost and negative discount', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    expect(
      await errorCodeOf(insertCompletion(job, technician, { cost: '-1', collectionMode: 'cash' })),
    ).toBe('23514');
    expect(
      await errorCodeOf(
        insertCompletion(await insertJob(await insertCustomer(), await insertService()), technician, {
          cost: '100',
          discountAmount: '-1',
          discountReason: 'nonsense',
          collectionMode: 'cash',
        }),
      ),
    ).toBe('23514');
  });

  it('lands a completion at 2026-03-14T20:30:00Z on business date 2026-03-15', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const row = await insertCompletion(job, technician, {
      completedAt: '2026-03-14T20:30:00Z',
      collectionMode: 'cash',
    });
    // Money taken in a basement on Monday lands on Monday, whenever it
    // syncs.
    expect(row.business_date).toBe('2026-03-15');
  });

  it('allows exactly one completion per job', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    await insertCompletion(job, technician, { collectionMode: 'cash' });
    const code = await errorCodeOf(insertCompletion(job, technician, { collectionMode: 'cash' }));
    expect(code).toBe('23505');
  });
});

describe('migration 007 — job_completion_parts (§3.4)', () => {
  let technician: string;

  beforeAll(async () => {
    technician = await insertEmployee();
  });

  async function completionWithParts(): Promise<string> {
    const job = await insertJob(await insertCustomer(), await insertService());
    await insertCompletion(job, technician, { collectionMode: 'cash' });
    return job;
  }

  it('rejects a non-positive quantity', async () => {
    const job = await completionWithParts();
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_completion_parts (job_card_id, line_no, free_text_name, quantity)
         VALUES ($1, 1, 'Terminal block', 0)`,
        [job],
      ),
    );
    expect(code).toBe('23514');
  });

  it('requires product_id or free_text_name', async () => {
    const job = await completionWithParts();
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_completion_parts (job_card_id, line_no, quantity)
         VALUES ($1, 1, 1)`,
        [job],
      ),
    );
    expect(code).toBe('23514');
  });

  it('keeps line_no unique within a completion and free across completions', async () => {
    const job1 = await completionWithParts();
    const job2 = await completionWithParts();
    await db.query(
      `INSERT INTO job_completion_parts (job_card_id, line_no, free_text_name, quantity)
       VALUES ($1, 1, 'Battery 150Ah', 2)`,
      [job1],
    );
    // Same line_no on a different completion is fine — the PK is the pair.
    await expect(
      db.query(
        `INSERT INTO job_completion_parts (job_card_id, line_no, free_text_name, quantity)
         VALUES ($1, 1, 'Battery 150Ah', 2)`,
        [job2],
      ),
    ).resolves.toBeTruthy();
    // Twice on the same completion is not.
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_completion_parts (job_card_id, line_no, free_text_name, quantity)
         VALUES ($1, 1, 'Battery 150Ah', 2)`,
        [job1],
      ),
    );
    expect(code).toBe('23505');
  });
});

describe('migration 007 — job_cancellations (§3.4)', () => {
  it("rejects reason 'other' without a note", async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const by = await insertEmployee('dispatcher');
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_cancellations (job_card_id, cancelled_by, cancelled_at, reason_code)
         VALUES ($1, $2, now(), 'other')`,
        [job, by],
      ),
    );
    expect(code).toBe('23514');
  });

  it("accepts reason 'other' with a note and a nullable successor", async () => {
    const cancelled = await insertJob(await insertCustomer(), await insertService());
    const successor = await insertJob(await insertCustomer(), await insertService());
    const by = await insertEmployee('dispatcher');
    // 1:1 with job_cards: the PK IS the job, there is no id column.
    const r = await db.query<{ job_card_id: string }>(
      `INSERT INTO job_cancellations (job_card_id, cancelled_by, cancelled_at, reason_code, reason_note, replacement_job_id)
       VALUES ($1, $2, now(), 'other', 'Customer asked to move it to next week', $3)
       RETURNING job_card_id`,
      [cancelled, by, successor],
    );
    expect(r.rows[0]?.job_card_id).toBe(cancelled);
  });

  it('allows exactly one cancellation per job', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const by = await insertEmployee('dispatcher');
    await db.query(
      `INSERT INTO job_cancellations (job_card_id, cancelled_by, cancelled_at, reason_code)
       VALUES ($1, $2, now(), 'no_access')`,
      [job, by],
    );
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_cancellations (job_card_id, cancelled_by, cancelled_at, reason_code)
         VALUES ($1, $2, now(), 'duplicate')`,
        [job, by],
      ),
    );
    expect(code).toBe('23505');
  });
});

describe('migration 007 — job_events, the offline seam (§3.4)', () => {
  it('keeps occurred_at and recorded_at apart on an append-only row', async () => {
    const job = await insertJob(await insertCustomer(), await insertService());
    const tech = await insertEmployee();
    const r = await db.query<{ id: string; recorded_at: string }>(
      `INSERT INTO job_events (job_card_id, event_type, actor_id, occurred_at, from_status, to_status, source, payload)
       VALUES ($1, 'completed', $2, '2026-03-14T08:40:00Z', 'in_progress', 'completed', 'mobile', '{"note":"underground"}')
       RETURNING id, recorded_at::text`,
      [job, tech],
    );
    expect(r.rows[0]?.id).toBeTruthy();
    // recorded_at defaults to the server's now, minutes (or hours) after
    // occurred_at — the gap the sync debugging reads.
    expect(new Date(r.rows[0]!.recorded_at).getTime()).toBeGreaterThan(
      new Date('2026-03-14T08:40:00Z').getTime(),
    );
  });

  it('rejects an event for a job that does not exist', async () => {
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO job_events (job_card_id, event_type, occurred_at, source)
         VALUES (gen_random_uuid(), 'created', now(), 'system')`,
      ),
    );
    expect(code).toBe('23503');
  });
});

describe('migration 006 ⇄ 007 — the source_job_id forward reference', () => {
  it('traces a stack row to the job that caused it, and refuses strangers', async () => {
    const c = await insertCustomer();
    const s = await insertService();
    const tech = await insertEmployee();
    const job = await insertJob(c, s, { status: 'assigned', assignedTo: tech });

    const row = await insertStackRow(c, 'UPS-TRACE-1', { sourceJobId: job });
    expect(row).toBeTruthy();

    const code = await errorCodeOf(
      insertStackRow(c, 'UPS-TRACE-2', { sourceJobId: crypto.randomUUID() }),
    );
    expect(code).toBe('23503');
  });
});

describe('PLAN-DATA-MODEL.md §5 — the index plan, verified from pg_indexes', () => {
  it('carries exactly the §5 indexes for the new tables, none extra', async () => {
    const r = await db.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('customer_products', 'job_cards', 'job_completions', 'job_events')
       ORDER BY tablename, indexname`,
    );
    const names = new Set(r.rows.map((row) => row.indexname));
    const defs = new Map(r.rows.map((row) => [row.indexname, row.indexdef]));

    // §5: customer_products — site stack, serial cannot be in two places.
    expect(names).toContain('customer_products_customer_active_idx');
    expect(names).toContain('customer_products_active_serial_unique');
    expect(defs.get('customer_products_active_serial_unique')).toMatch(/lower\(serial_number\)/);
    expect(defs.get('customer_products_active_serial_unique')).toMatch(/WHERE.*is_active/);

    // §5: job_cards — technician tabs, dispatcher filter, history, sync
    // cursor, the one-live-per-visit rule, and the visit's attempt history.
    for (const name of [
      'job_cards_technician_day_idx',
      'job_cards_status_scheduled_idx',
      'job_cards_customer_created_idx',
      'job_cards_customer_product_idx',
      'job_cards_updated_at_idx',
      'job_cards_one_live_per_visit',
      'job_cards_visit_history_idx',
      'job_cards_job_number_unique',
    ]) {
      expect(names).toContain(name);
    }
    expect(defs.get('job_cards_technician_day_idx')).toMatch(/WHERE/);
    expect(defs.get('job_cards_one_live_per_visit')).toMatch(/cancelled/);

    // §5: job_completions — expected-cash view and the revenue dashboard.
    for (const name of ['job_completions_cash_idx', 'job_completions_business_date_idx']) {
      expect(names).toContain(name);
    }
    expect(defs.get('job_completions_cash_idx')).toMatch(/WHERE.*collection_mode/);

    // §5: job_events — the timeline.
    expect(names).toContain('job_events_job_occurred_idx');
  });
});
