import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { AppError } from '../../src/plugins/errors.js';
import { scopePredicate } from '../../src/plugins/rbac.js';

/**
 * Scope-resolution suite (PHASE-0-FOUNDATION.md T0.10, PLAN-BACKEND.md
 * §5): the rbac plugin's scopes are SQL predicates, asserted two ways —
 *
 * 1. by inspecting the generated query text (the Done-when: a scope
 *    applied in JavaScript is the wrong shape, and only the text proves
 *    where the filter runs), and
 * 2. by executing the composed query and asserting on the rows returned,
 *    never on a count — a count passes while hiding the wrong rows.
 *
 * The `assigned`-on-customer predicate reads `job_cards`, which landed
 * with migration 007 (PHASE-1-TECHNICIAN.md T1.1); the seeding runs
 * against that real table, so the predicate is exercised on the same
 * shape it will meet in production. (Until T1.1 the suite stood up a
 * stub with the documented §3.4 columns — deleted when the real table
 * arrived, as its TODO always said it would be.)
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_scope_test';

let admin: Pool;
let db: Pool;

const repA = { username: 'scope.rep.a', id: '' };
const repB = { username: 'scope.rep.b', id: '' };
const tech = { username: 'scope.tech.a', id: '' };
const techB = { username: 'scope.tech.b', id: '' };
const owner = { username: 'scope.owner', id: '' };

const repACompany = { name: 'Scope Rep A Account', id: '' };
const repBCompany = { name: 'Scope Rep B Account', id: '' };
const houseOne = { name: 'Scope House One', id: '' };
const houseTwo = { name: 'Scope House Two', id: '' };

/** A site the technician's *closed* job touched — the include-case. */
const closedSite = { name: 'Scope Closed Site', id: '' };
/** A site only the other technician has worked. */
const otherTechSite = { name: 'Scope Other Tech Site', id: '' };
/** A site no job has ever touched. */
const neverSite = { name: 'Scope Never Site', id: '' };

async function seedEmployee(role: 'owner' | 'technician' | 'sales_rep', username: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword('mv-scope-t10-81'), `Scope ${username}`, role],
  );
  return r.rows[0]!.id;
}

async function seedCompany(name: string, ownerRepId: string | null): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO companies (name, owner_rep_id) VALUES ($1, $2) RETURNING id`,
    [name, ownerRepId],
  );
  return r.rows[0]!.id;
}

async function seedCustomer(name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone) VALUES ($1, '98000000') RETURNING id`,
    [name],
  );
  return r.rows[0]!.id;
}

/** The catalogue row every seeded job points at (job_cards.service_id is NOT NULL). */
const serviceId = { id: '' };

let jobSeq = 0;

async function seedJob(customerId: string, assignedTo: string, status: string, closedAt: Date | null): Promise<string> {
  jobSeq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, assigned_to, status, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [`JC-SCOPE-${jobSeq}`, customerId, serviceId.id, `Scope job ${jobSeq}`, assignedTo, status, closedAt],
  );
  return r.rows[0]!.id;
}

function idsOf(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => row.id as string).sort();
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  serviceId.id = await db
    .query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T0-SCOPE', 'Scope suite service') RETURNING id`,
    )
    .then((r) => r.rows[0]!.id);

  repA.id = await seedEmployee('sales_rep', repA.username);
  repB.id = await seedEmployee('sales_rep', repB.username);
  tech.id = await seedEmployee('technician', tech.username);
  techB.id = await seedEmployee('technician', techB.username);
  owner.id = await seedEmployee('owner', owner.username);

  repACompany.id = await seedCompany(repACompany.name, repA.id);
  repBCompany.id = await seedCompany(repBCompany.name, repB.id);
  houseOne.id = await seedCompany(houseOne.name, null);
  houseTwo.id = await seedCompany(houseTwo.name, null);

  closedSite.id = await seedCustomer(closedSite.name);
  otherTechSite.id = await seedCustomer(otherTechSite.name);
  neverSite.id = await seedCustomer(neverSite.name);

  await seedJob(closedSite.id, tech.id, 'completed', new Date());
  await seedJob(otherTechSite.id, techB.id, 'in_progress', null);
});

afterAll(async () => {
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('own on company — owner_rep_id = :actor OR owner_rep_id IS NULL', () => {
  it('generates that exact predicate, actor bound as a parameter, never interpolated', () => {
    const pred = scopePredicate({ role: 'sales_rep', actorId: repA.id, resource: 'company', action: 'read' });
    expect(pred).toEqual({
      sql: '(companies.owner_rep_id = $1 OR companies.owner_rep_id IS NULL)',
      params: [repA.id],
    });
  });

  it('includes the rep’s own accounts and the house accounts, and excludes the other rep’s — rows, not counts', async () => {
    const predA = scopePredicate({ role: 'sales_rep', actorId: repA.id, resource: 'company', action: 'read' })!;
    const rowsA = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE ${predA.sql}`,
      predA.params,
    );
    expect(idsOf(rowsA.rows)).toEqual([repACompany.id, houseOne.id, houseTwo.id].sort());
    expect(rowsA.rows.map((row) => row.name).sort()).not.toContain(repBCompany.name);

    // Symmetry: the house accounts are every rep's business, the other
    // rep's accounts are no one else's.
    const predB = scopePredicate({ role: 'sales_rep', actorId: repB.id, resource: 'company', action: 'read' })!;
    const rowsB = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE ${predB.sql}`,
      predB.params,
    );
    expect(idsOf(rowsB.rows)).toEqual([repBCompany.id, houseOne.id, houseTwo.id].sort());
    expect(rowsB.rows.map((row) => row.name).sort()).not.toContain(repACompany.name);
  });

  it('composes into a query that already binds values (paramStart) and aliases the table (qualifier)', async () => {
    const pred = scopePredicate({
      role: 'sales_rep',
      actorId: repA.id,
      resource: 'company',
      action: 'read',
      paramStart: 2,
      qualifier: 'c',
    });
    expect(pred!.sql).toBe('(c.owner_rep_id = $2 OR c.owner_rep_id IS NULL)');

    const rows = await db.query<{ id: string }>(
      `SELECT id FROM companies c WHERE c.is_active = $1 AND ${pred!.sql}`,
      [true, repA.id],
    );
    expect(idsOf(rows.rows)).toEqual([repACompany.id, houseOne.id, houseTwo.id].sort());
  });

  it('the owner’s cell is all — no predicate at all, the repo writes no WHERE fragment', () => {
    expect(
      scopePredicate({ role: 'owner', actorId: owner.id, resource: 'company', action: 'read' }),
    ).toBeNull();
    expect(
      scopePredicate({ role: 'owner', actorId: owner.id, resource: 'customer', action: 'read' }),
    ).toBeNull();
  });
});

describe('none — the refusal happens before any query exists', () => {
  it('the dispatcher has no company permission — FORBIDDEN, not an empty result', () => {
    let err: unknown;
    try {
      scopePredicate({ role: 'dispatcher', actorId: tech.id, resource: 'company', action: 'read' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('FORBIDDEN');
  });

  it('a scope the matrix grants but whose predicate is not registered yet fails loudly, never runs unscoped', () => {
    // `sale` for a sales_rep is `own` in the matrix, but no sales table
    // exists until migration 011 — building the predicate is a query-time
    // programmer error until the sales module registers it.
    expect(() =>
      scopePredicate({ role: 'sales_rep', actorId: repA.id, resource: 'sale', action: 'read' }),
    ).toThrowError(/no own predicate registered for sale/);
  });
});

describe('assigned on customer — reachable through a job, present tense or closed', () => {
  it('generates the exact EXISTS predicate over job_cards', () => {
    const pred = scopePredicate({ role: 'technician', actorId: tech.id, resource: 'customer', action: 'read' });
    expect(pred).toEqual({
      sql: 'EXISTS (SELECT 1 FROM job_cards jc WHERE jc.customer_id = customers.id AND jc.assigned_to = $1)',
      params: [tech.id],
    });
  });

  it('includes the site of a *closed* job, and excludes sites he never had and sites of others’ jobs — rows, not counts', async () => {
    const pred = scopePredicate({ role: 'technician', actorId: tech.id, resource: 'customer', action: 'read' })!;
    const rows = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM customers WHERE ${pred.sql}`,
      pred.params,
    );
    expect(idsOf(rows.rows)).toEqual([closedSite.id]);
    expect(rows.rows.map((row) => row.name)).not.toContain(neverSite.name);
    expect(rows.rows.map((row) => row.name)).not.toContain(otherTechSite.name);
  });

  it('the scope is per actor — the other technician sees only his own site', async () => {
    const pred = scopePredicate({ role: 'technician', actorId: techB.id, resource: 'customer', action: 'read' })!;
    const rows = await db.query<{ id: string }>(`SELECT id FROM customers WHERE ${pred.sql}`, pred.params);
    expect(idsOf(rows.rows)).toEqual([otherTechSite.id]);
  });

  it('the include-case is genuinely a closed job, so this suite cannot rot into an open-jobs-only scope', async () => {
    const row = await db.query<{ status: string; closed_at: Date | null }>(
      'SELECT status::text AS status, closed_at FROM job_cards WHERE customer_id = $1',
      [closedSite.id],
    );
    expect(row.rows[0]!.status).toBe('completed');
    expect(row.rows[0]!.closed_at).not.toBeNull();
  });
});
