import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope, LoginResponse } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';
import { NAME_TSV_SQL, customersPageSqlForExplain } from '../../src/modules/customers/repo.js';

/**
 * Customers and the product stack (PHASE-2-DISPATCHER.md T2.4,
 * PLAN-BACKEND.md §6.4). The assertions the task exists for:
 *
 * - **`company_id` stripping is proven at the ROW, not the response** — a
 *   dispatcher's create payload carrying a real, FK-valid `companyId`
 *   still lands a customer with company_id NULL. The company row exists
 *   precisely so the insert COULD have succeeded: the only reason it did
 *   not attach is the strip (PLAN.md §5: "It is an owner and rep field").
 * - **Search `q` hits name and phone, and the GIN index is used** —
 *   asserted via EXPLAIN over the exact SQL the endpoint runs, with
 *   sequential scans disabled: if the planner still cannot avoid a Seq
 *   Scan, the query was written in a form the index cannot serve.
 * - **A technician's stack scope is `assigned`**: a stack correction at a
 *   site he has a CLOSED job at is allowed; at a site he never had, 403
 *   OUT_OF_SCOPE.
 * - **A standalone stack change stamps no `source_job_id`** — the audit
 *   signal that the change did not come from work done.
 * - **Soft delete releases the serial**: the same serial is refused at a
 *   second site while the first stands, and accepted there after the
 *   first is deactivated — the old row still exists (never DELETE).
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_customers_test';
const PASSWORD = 'cust-plain-copier-47';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const DISPATCHER: Actor = { username: '', id: '', token: '' };
const SALES_REP: Actor = { username: '', id: '', token: '' };
const TECH: Actor = { username: '', id: '', token: '' };
const OTHER_TECH: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

let serviceId = '';
let companyId = '';
/** Site A — TECH has (or has had) a job here. Site B — he never has; OTHER_TECH does. */
let customerA = '';
let customerB = '';
let stackItemA = '';
let stackItemB = '';

let seq = 0;
function uniquePhone(): string {
  seq += 1;
  return `9847${String(seq).padStart(6, '0')}${randomBytes(1).toString('hex')}`.slice(0, 12);
}

async function seedEmployee(role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep', who: Actor): Promise<void> {
  const username = `cust.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username,
      password: PASSWORD,
      device: {
        installId: `install-${username}`,
        platform: 'android',
        appVersion: '0.1.0',
        osVersion: '14',
        manufacturer: 'Xiaomi',
        model: 'Redmi Note 12',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  who.token = res.json<LoginResponse>().accessToken;
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

async function seedJob(input: {
  customerId: string;
  assignedTo: string;
  status: 'completed' | 'assigned';
}): Promise<string> {
  seq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-CUST-${String(seq).padStart(4, '0')}-${randomBytes(2).toString('hex')}`,
      input.customerId,
      serviceId,
      `Customers-suite job ${seq}`,
      input.status,
      input.assignedTo,
      new Date().toISOString(),
      input.status === 'completed' ? new Date().toISOString() : null,
    ],
  );
  return r.rows[0]!.id;
}

async function seedStackItem(customerId: string, serialNumber: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customer_products (customer_id, free_text_name, serial_number, quantity)
     VALUES ($1, 'Seeded inverter', $2, 1) RETURNING id`,
    [customerId, serialNumber],
  );
  return r.rows[0]!.id;
}

function errorOf(body: string): ErrorEnvelope['error'] {
  return (JSON.parse(body) as ErrorEnvelope).error;
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

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedEmployee('owner', OWNER);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);
  await seedEmployee('technician', TECH);
  await seedEmployee('technician', OTHER_TECH);

  serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ($1, 'Customers suite service') RETURNING id`,
      [`CUST-SVC-${randomBytes(3).toString('hex')}`],
    )
  ).rows[0]!.id;

  companyId = (
    await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
      [`Customers Suite Pvt Ltd ${randomBytes(3).toString('hex')}`],
    )
  ).rows[0]!.id;

  customerA = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Anand Electricals', $1) RETURNING id`,
      ['9847011234'],
    )
  ).rows[0]!.id;
  customerB = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('Bright Power Solutions', $1) RETURNING id`,
      ['7798005566'],
    )
  ).rows[0]!.id;

  // TECH's site A job is CLOSED — the ordinary case for a next-day stack
  // correction. Site B belongs to another technician's open job.
  await seedJob({ customerId: customerA, assignedTo: TECH.id, status: 'completed' });
  await seedJob({ customerId: customerB, assignedTo: OTHER_TECH.id, status: 'assigned' });

  stackItemA = await seedStackItem(customerA, 'SN-A-0001');
  stackItemB = await seedStackItem(customerB, 'SN-B-0001');
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

// ── the dispatcher cannot set customers.company_id ──────────────────────────

describe('company_id stripping (PLAN.md §5, §6.4)', () => {
  it('a dispatcher create payload carrying a REAL company_id is stripped, not honoured — proven at the stored row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: bearer(DISPATCHER),
      // The company exists and the uuid is valid, so the insert COULD have
      // honoured it — the strip is the only reason it did not.
      payload: {
        name: 'Strip Test Site',
        phone: uniquePhone(),
        companyId,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (
      await db.query<{ company_id: string | null }>(
        'SELECT company_id FROM customers WHERE id = $1',
        [res.json<{ id: string }>().id],
      )
    ).rows[0]!;
    expect(row.company_id).toBeNull();
  });

  it('the dispatcher RESPONSE carries no companyId at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: bearer(DISPATCHER),
      payload: { name: 'Strip Test Site 2', phone: uniquePhone(), companyId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<object>()).not.toHaveProperty('companyId');
  });

  it('an OWNER create with the same payload attaches the company — stripping is role-specific, not a black hole', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: bearer(OWNER),
      payload: { name: 'Owner Attach Site', phone: uniquePhone(), companyId },
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json<{ id: string; companyId: string | null }>();
    expect(created.companyId).toBe(companyId);
    const row = (
      await db.query<{ company_id: string | null }>('SELECT company_id FROM customers WHERE id = $1', [created.id])
    ).rows[0]!;
    expect(row.company_id).toBe(companyId);
  });

  it('a dispatcher PATCH carrying companyId does not move the column', async () => {
    const created = (
      await db.query<{ id: string; version: number }>(
        `INSERT INTO customers (name, phone) VALUES ('Patch Strip Site', $1) RETURNING id, version`,
        [uniquePhone()],
      )
    ).rows[0]!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${created.id}`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(created.version) },
      payload: { city: 'Bengaluru', companyId },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (
      await db.query<{ company_id: string | null; city: string | null }>(
        'SELECT company_id, city FROM customers WHERE id = $1',
        [created.id],
      )
    ).rows[0]!;
    expect(row.company_id).toBeNull();
    expect(row.city).toBe('Bengaluru');
  });

  it('an owner PATCH can attach (and detach) the company', async () => {
    const created = (
      await db.query<{ id: string; version: number }>(
        `INSERT INTO customers (name, phone) VALUES ('Owner Patch Site', $1) RETURNING id, version`,
        [uniquePhone()],
      )
    ).rows[0]!;
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${created.id}`,
      headers: { ...bearer(OWNER), 'if-match': String(created.version) },
      payload: { companyId },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ companyId: string | null }>().companyId).toBe(companyId);

    const version = (
      await db.query<{ version: number }>('SELECT version FROM customers WHERE id = $1', [created.id])
    ).rows[0]!.version;
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${created.id}`,
      headers: { ...bearer(OWNER), 'if-match': String(version) },
      payload: { companyId: null },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ companyId: string | null }>().companyId).toBeNull();
  });
});

// ── search and the GIN index (§6.4) ─────────────────────────────────────────

describe('search q over name and phone, and the GIN index', () => {
  it('q hits a name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=anand',
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode, res.body).toBe(200);
    const names = res.json<{ items: Array<{ name: string }> }>().items.map((c) => c.name);
    expect(names).toContain('Anand Electricals');
    expect(names).not.toContain('Bright Power Solutions');
  });

  it('q hits a phone — exactly, because the btree arm is what keeps the OR off the seq scan', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=7798005566',
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode, res.body).toBe(200);
    const names = res.json<{ items: Array<{ name: string }> }>().items.map((c) => c.name);
    expect(names).toContain('Bright Power Solutions');
    expect(names).not.toContain('Anand Electricals');

    // The boundary, pinned on purpose: a phone PARTIAL does not match. The
    // alternative (a LIKE prefix) cannot use customers_phone_idx on an
    // en_US.utf8 database, and one unindexable arm drags the whole search
    // back to a sequential scan — see the EXPLAIN assertion below. Prefix
    // phone search arrives with a text_pattern_ops index, or not at all.
    const partial = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=779800',
      headers: bearer(DISPATCHER),
    });
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json<{ items: Array<{ name: string }> }>().items.map((c) => c.name)).not.toContain(
      'Bright Power Solutions',
    );
  });

  it('q hits a full phone number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=9847011234',
      headers: bearer(DISPATCHER),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: Array<{ name: string }> }>().items.map((c) => c.name)).toEqual([
      'Anand Electricals',
    ]);
  });

  it('the technician\u2019s scope narrows the search, not the other way round', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers?q=power',
      headers: bearer(TECH),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('EXPLAIN: the list query never needs a sequential scan, and the name arm is GIN-served', async () => {
    const sql = customersPageSqlForExplain({ filter: { q: 'anand' }, limit: 50 });
    const client = await db.connect();
    try {
      await client.query('SET enable_seqscan = off');
      try {
        // 1 — the query the endpoint runs (same builder, values inlined):
        // with sequential scans made expensive, a Seq Scan in the plan
        // would mean the query text cannot be served by the indexes.
        const full = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`);
        const fullPlan: unknown = typeof full.rows[0]!['QUERY PLAN'] === 'string'
          ? JSON.parse(full.rows[0]!['QUERY PLAN'] as string)
          : full.rows[0]!['QUERY PLAN'];

        const nodes: Array<{ 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string }> = [];
        const walk = (
          target: Array<{ 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string }>,
          node: unknown,
        ): void => {
          if (node === null || typeof node !== 'object') return;
          const n = node as {
            'Node Type'?: string;
            'Index Name'?: string;
            'Relation Name'?: string;
            Plan?: unknown;
            Plans?: unknown[];
          };
          // EXPLAIN (FORMAT JSON) wraps the root as { Plan: {...} }; children ride in Plans[].
          if (typeof n['Node Type'] === 'string') {
            target.push({
              'Node Type': n['Node Type'],
              'Index Name': n['Index Name'],
              'Relation Name': n['Relation Name'],
            });
          }
          if (n.Plan !== undefined) walk(target, n.Plan);
          for (const child of n.Plans ?? []) walk(target, child);
        };
        for (const root of fullPlan as unknown[]) walk(nodes, root);

        const seqScans = nodes.filter((n) => n['Node Type'] === 'Seq Scan');
        expect(seqScans, `plan was: ${JSON.stringify(fullPlan)}`).toEqual([]);

        // 2 — the name arm exactly as the repo writes it (NAME_TSV_SQL is
        // the same expression the index was built over, migration 005):
        // the GIN must be the index that serves it.
        const arm = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON) SELECT c.id FROM customers c
           WHERE c.is_active AND ${NAME_TSV_SQL} @@ plainto_tsquery('simple', 'anand')`,
        );
        const armPlan: unknown = typeof arm.rows[0]!['QUERY PLAN'] === 'string'
          ? JSON.parse(arm.rows[0]!['QUERY PLAN'] as string)
          : arm.rows[0]!['QUERY PLAN'];
        const armNodes: Array<{ 'Node Type': string; 'Index Name'?: string }> = [];
        for (const root of armPlan as unknown[]) walk(armNodes, root);
        expect(armNodes, `plan was: ${JSON.stringify(armPlan)}`).toContainEqual(
          expect.objectContaining({ 'Index Name': 'customers_name_tsv_idx' }),
        );
        expect(armNodes.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
      } finally {
        await client.query('SET enable_seqscan = on');
      }
    } finally {
      client.release();
    }
  });

  it('the list is cursor-paginated and pages never overlap', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: bearer(OWNER),
        payload: { name: `Pagination Site ${i} ${randomBytes(2).toString('hex')}`, phone: uniquePhone() },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      // Annotated to cut the do-while inference cycle (cursor ← page ← res ← url ← cursor).
      const url: string = cursor === null ? '/v1/customers?limit=2' : `/v1/customers?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: 'GET', url, headers: bearer(DISPATCHER) });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      for (const item of page.items) {
        expect(seen.has(item.id), `customer ${item.id} appeared on two pages`).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // a runaway cursor is a test bug, not pagination
    } while (cursor !== null);

    const total = Number(
      (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM customers WHERE is_active')).rows[0]!.n,
    );
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThanOrEqual(2);
  });
});

// ── the technician's stack scope is `assigned`, not `all` ───────────────────

describe('the technician\u2019s stack scope (§6.4)', () => {
  it('a stack correction at a site he has a CLOSED job at is allowed', async () => {
    const version = (
      await db.query<{ version: number }>('SELECT version FROM customer_products WHERE id = $1', [stackItemA])
    ).rows[0]!.version;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerA}/stack/${stackItemA}`,
      headers: { ...bearer(TECH), 'if-match': String(version) },
      payload: { warrantyExpiresOn: '2027-03-31', quantity: 2 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (
      await db.query<{ warranty_expires_on: string | null; quantity: number }>(
        'SELECT warranty_expires_on::text AS warranty_expires_on, quantity FROM customer_products WHERE id = $1',
        [stackItemA],
      )
    ).rows[0]!;
    expect(row.warranty_expires_on).toBe('2027-03-31');
    expect(row.quantity).toBe(2);
  });

  it('a stack correction at a site he never had a job for is 403 OUT_OF_SCOPE', async () => {
    const version = (
      await db.query<{ version: number }>('SELECT version FROM customer_products WHERE id = $1', [stackItemB])
    ).rows[0]!.version;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerB}/stack/${stackItemB}`,
      headers: { ...bearer(TECH), 'if-match': String(version) },
      payload: { quantity: 7 },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.body).code).toBe('OUT_OF_SCOPE');
    // The refused write moved nothing.
    const row = (
      await db.query<{ quantity: number }>('SELECT quantity FROM customer_products WHERE id = $1', [stackItemB])
    ).rows[0]!;
    expect(row.quantity).toBe(1);
  });

  it('a stale If-Match is 409 VERSION_CONFLICT naming the current version', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerA}/stack/${stackItemA}`,
      headers: { ...bearer(TECH), 'if-match': '1' },
      payload: { quantity: 3 },
    });
    expect(res.statusCode).toBe(409);
    const error = errorOf(res.body);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect((error.details as { currentVersion?: number }).currentVersion).toBeGreaterThan(1);
  });

  it('the point read and the stack read of a foreign site are OUT_OF_SCOPE; the list narrows in SQL', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerB}`,
      headers: bearer(TECH),
    });
    expect(detail.statusCode).toBe(403);
    expect(errorOf(detail.body).code).toBe('OUT_OF_SCOPE');

    const stack = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerB}/stack`,
      headers: bearer(TECH),
    });
    expect(stack.statusCode).toBe(403);
    expect(errorOf(stack.body).code).toBe('OUT_OF_SCOPE');

    const list = await app.inject({ method: 'GET', url: '/v1/customers', headers: bearer(TECH) });
    expect(list.statusCode, list.body).toBe(200);
    const ids = list.json<{ items: Array<{ id: string }> }>().items.map((c) => c.id);
    expect(ids).toContain(customerA);
    expect(ids).not.toContain(customerB);
  });

  it('a sales rep holds none of the customer cell', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/customers', headers: bearer(SALES_REP) });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.body).code).toBe('FORBIDDEN');
  });
});

// ── the standalone doors stamp no source job ────────────────────────────────

describe('standalone stack changes carry no source_job_id (§6.4)', () => {
  it('adding a unit through the correction door stamps no source job, and records who installed it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(TECH),
      payload: { freeTextName: 'Battery bank 150Ah', serialNumber: `SN-STAND-${randomBytes(3).toString('hex')}`, quantity: 2 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json<{ id: string; customerId: string; quantity: number; version: number }>();
    expect(created.customerId).toBe(customerA);
    expect(created.quantity).toBe(2);

    const row = (
      await db.query<{ source_job_id: string | null; installed_by: string | null; is_active: boolean }>(
        'SELECT source_job_id, installed_by, is_active FROM customer_products WHERE id = $1',
        [created.id],
      )
    ).rows[0]!;
    expect(row.source_job_id).toBeNull();
    expect(row.installed_by).toBe(TECH.id);
    expect(row.is_active).toBe(true);
  });

  it('the add is idempotent: the same serial at the same site refreshes one row', async () => {
    const serial = `SN-IDEM-${randomBytes(3).toString('hex')}`;
    const first = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(TECH),
      payload: { freeTextName: 'UPS 850VA', serialNumber: serial, quantity: 1 },
    });
    expect(first.statusCode, first.body).toBe(200);
    const created = first.json<{ id: string; version: number }>();

    const second = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(TECH),
      payload: { freeTextName: 'UPS 850VA', serialNumber: serial, quantity: 3 },
    });
    expect(second.statusCode, second.body).toBe(200);
    const refreshed = second.json<{ id: string; quantity: number }>();
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.quantity).toBe(3);

    const count = Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM customer_products WHERE lower(serial_number) = lower($1)',
          [serial],
        )
      ).rows[0]!.n,
    );
    expect(count).toBe(1);
  });

  it('a dispatcher holds none of the stack cell', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(DISPATCHER),
      payload: { freeTextName: 'Dispatcher unit', serialNumber: `SN-DISP-${randomBytes(3).toString('hex')}` },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.body).code).toBe('FORBIDDEN');
  });
});

// ── soft delete releases the serial ─────────────────────────────────────────

describe('soft delete releases the serial for another site (§6.4)', () => {
  it('the serial is refused at a second site while the first stands, accepted after deactivation, and the first row is never deleted', async () => {
    const serial = `SN-REL-${randomBytes(3).toString('hex')}`;

    // A technician fits the unit at site A (his site) through the
    // correction door.
    const add = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(TECH),
      payload: { freeTextName: 'UPS 1kVA', serialNumber: serial, quantity: 1 },
    });
    expect(add.statusCode, add.body).toBe(200);
    const itemId = add.json<{ id: string }>().id;

    // Case matters to the rule, not to the answer: 'ups-88120' and
    // 'UPS-88120' are the same unit (lower() in the index).
    const clashAsOwner = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerB}/stack`,
      headers: bearer(OWNER),
      payload: { freeTextName: 'UPS 1kVA elsewhere', serialNumber: serial.toUpperCase() },
    });
    expect(clashAsOwner.statusCode).toBe(422);
    expect(errorOf(clashAsOwner.body).code).toBe('VALIDATION_FAILED');

    // The technician removes it — soft only.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/customers/${customerA}/stack/${itemId}`,
      headers: bearer(TECH),
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json<{ ok: boolean }>().ok).toBe(true);

    const old = (
      await db.query<{ is_active: boolean }>('SELECT is_active FROM customer_products WHERE id = $1', [itemId])
    ).rows[0]!;
    expect(old.is_active).toBe(false); // the row survives, deactivated

    // The same serial now installs at the second site.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerB}/stack`,
      headers: bearer(OWNER),
      payload: { freeTextName: 'UPS 1kVA relocated', serialNumber: serial },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ customerId: string }>().customerId).toBe(customerB);
  });

  it('the soft-deleted item leaves the site\u2019s stack reads and refuses a second DELETE', async () => {
    const serial = `SN-GONE-${randomBytes(3).toString('hex')}`;
    const add = await app.inject({
      method: 'POST',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(OWNER),
      payload: { freeTextName: 'To be removed', serialNumber: serial },
    });
    expect(add.statusCode, add.body).toBe(200);
    const itemId = add.json<{ id: string }>().id;

    const stackBefore = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(OWNER),
    });
    expect(stackBefore.json<Array<{ id: string }>>().map((i) => i.id)).toContain(itemId);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/customers/${customerA}/stack/${itemId}`,
      headers: bearer(OWNER),
    });
    expect(del.statusCode, del.body).toBe(200);

    const stackAfter = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerA}/stack`,
      headers: bearer(OWNER),
    });
    expect(stackAfter.json<Array<{ id: string }>>().map((i) => i.id)).not.toContain(itemId);

    // Already inactive: a second DELETE is 404, not a silent success.
    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/customers/${customerA}/stack/${itemId}`,
      headers: bearer(OWNER),
    });
    expect(again.statusCode).toBe(404);
  });
});

// ── the customer detail carries the stack; the shapes split by role ─────────

describe('customer detail (§6.4)', () => {
  it('the detail includes the ACTIVE stack, and the dispatcher\u2019s shape has no companyId', async () => {
    const ownerView = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerA}`,
      headers: bearer(OWNER),
    });
    expect(ownerView.statusCode, ownerView.body).toBe(200);
    const ownerBody = ownerView.json<{ companyId: string | null; stack: Array<{ serialNumber: string }> }>();
    expect(ownerBody.stack.length).toBeGreaterThan(0);

    const dispatcherView = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerA}`,
      headers: bearer(DISPATCHER),
    });
    expect(dispatcherView.statusCode, dispatcherView.body).toBe(200);
    const dispatcherBody = dispatcherView.json<{ companyId?: string; stack: unknown[] }>();
    expect(dispatcherBody).not.toHaveProperty('companyId');
    expect(dispatcherBody.stack.length).toBe(ownerBody.stack.length);
  });

  it('PATCH /v1/customers/:id requires If-Match and bumps version on success', async () => {
    const noMatch = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerA}`,
      headers: bearer(OWNER),
      payload: { notes: 'no if-match' },
    });
    expect(noMatch.statusCode).toBe(422);

    const version = (
      await db.query<{ version: number }>('SELECT version FROM customers WHERE id = $1', [customerA])
    ).rows[0]!.version;
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerA}`,
      headers: { ...bearer(OWNER), 'if-match': String(version) },
      payload: { notes: 'gate is locked on Sundays' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ version: number }>().version).toBe(version + 1);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerA}`,
      headers: { ...bearer(DISPATCHER), 'if-match': String(version) },
      payload: { notes: 'stale' },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale.body).code).toBe('VERSION_CONFLICT');
  });
});

// ── the catalogue: read by everyone, written by the owner ───────────────────

describe('products and services (§6.4)', () => {
  let productSku = '';
  let serviceCode = '';

  it('everyone reads the catalogue — technician, dispatcher, sales rep', async () => {
    for (const actor of [TECH, DISPATCHER, SALES_REP]) {
      const products = await app.inject({ method: 'GET', url: '/v1/products', headers: bearer(actor) });
      expect(products.statusCode, products.body).toBe(200);
      const services = await app.inject({ method: 'GET', url: '/v1/services', headers: bearer(actor) });
      expect(services.statusCode, services.body).toBe(200);
    }
  });

  it('only the owner writes: dispatcher and sales rep are 403 at the door', async () => {
    productSku = `CUST-SKU-${randomBytes(3).toString('hex')}`;
    const dispatcherPost = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: bearer(DISPATCHER),
      payload: { sku: productSku, name: 'UPS 850VA', category: 'ups' },
    });
    expect(dispatcherPost.statusCode).toBe(403);
    const repPost = await app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: bearer(SALES_REP),
      payload: { code: 'NOPE', name: 'Not yours' },
    });
    expect(repPost.statusCode).toBe(403);
  });

  it('the owner creates a product and a service; the list answers with the wire shape', async () => {
    productSku = `CUST-SKU-${randomBytes(3).toString('hex')}`;
    const product = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: bearer(OWNER),
      payload: { sku: productSku, name: 'Battery 150Ah', category: 'battery', defaultPrice: '12500.00', warrantyMonths: 24 },
    });
    expect(product.statusCode, product.body).toBe(200);
    expect(product.json<{ defaultPrice: string | null }>().defaultPrice).toBe('12500.00');

    serviceCode = `CUST-SVC-${randomBytes(3).toString('hex')}`;
    const service = await app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: bearer(OWNER),
      payload: { code: serviceCode, name: 'AMC visit', defaultCharge: '500.00' },
    });
    expect(service.statusCode, service.body).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/products', headers: bearer(TECH) });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json<Array<{ sku: string }>>();
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.map((p) => p.sku)).toContain(productSku);
  });

  it('a duplicate SKU is refused, and deactivation removes the row from the list without deleting it', async () => {
    const sku = `CUST-SKU-DUP-${randomBytes(3).toString('hex')}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: bearer(OWNER),
      payload: { sku, name: 'Doomed product', category: 'accessory' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const productId = created.json<{ id: string; version: number }>().id;

    // While ACTIVE: the same SKU is refused outright.
    const dupActive = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: bearer(OWNER),
      payload: { sku, name: 'Reissued', category: 'accessory' },
    });
    expect(dupActive.statusCode).toBe(422);

    // Deactivate through the API — the correction path (§6.4).
    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${productId}`,
      headers: { ...bearer(OWNER), 'if-match': '1' },
      payload: { isActive: false },
    });
    expect(deactivate.statusCode, deactivate.body).toBe(200);

    // Deactivated: the row leaves the list but survives, and its SKU is
    // STILL not reissuable — uniqueness is outright, not among active rows
    // (§3.2: a retired code is never reissued onto records that cite it).
    const list = await app.inject({ method: 'GET', url: '/v1/products', headers: bearer(DISPATCHER) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<Array<{ sku: string }>>().map((p) => p.sku)).not.toContain(sku);

    const dupInactive = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: bearer(OWNER),
      payload: { sku, name: 'Reissued again', category: 'accessory' },
    });
    expect(dupInactive.statusCode).toBe(422);

    const row = (
      await db.query<{ is_active: boolean }>('SELECT is_active FROM products WHERE id = $1', [productId])
    ).rows[0]!;
    expect(row.is_active).toBe(false); // deactivated, never deleted
  });

  it('a stale If-Match on the catalogue is 409 VERSION_CONFLICT', async () => {
    const product = (
      await db.query<{ id: string; version: number }>(
        `INSERT INTO products (sku, name, category) VALUES ($1, 'Concurrency product', 'spare') RETURNING id, version`,
        [`CUST-SKU-CC-${randomBytes(3).toString('hex')}`],
      )
    ).rows[0]!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${product.id}`,
      headers: { ...bearer(OWNER), 'if-match': String(product.version + 5) },
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('VERSION_CONFLICT');
  });
});
