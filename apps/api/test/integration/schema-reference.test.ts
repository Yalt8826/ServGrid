import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Migration 005 integration suite (PHASE-0-FOUNDATION.md T0.4):
 * the reference-data tables (PLAN-DATA-MODEL.md §3.2) — companies,
 * customers, products, services. Runs against the real Postgres 16 from
 * `docker compose up db` — no mocked database anywhere (PLAN-BACKEND.md
 * §14). The suite builds its own scratch database from the server's
 * admin connection and drops it afterwards; a failed run leaves nothing
 * behind.
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

const SCRATCH_DB = 'servgrid_reference_test';

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

/** Insert an employee, returning its id. */
async function insertEmployee(username: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, 'test-argon2id-hash', $2, 'sales_rep')
     RETURNING id`,
    [username, `Test ${username}`],
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

describe('migration 005 — companies (PLAN-DATA-MODEL.md §3.2)', () => {
  it('rejects two active companies whose names differ only in case', async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('sharma enterprises')`);
    // name is citext, so the partial unique index folds case; the
    // violation must be the unique index, not something else.
    const code = await errorCodeOf(
      db.query(`INSERT INTO companies (name) VALUES ('Sharma Enterprises')`),
    );
    expect(code).toBe('23505');
  });

  it('allows the same name once the earlier row is inactive', async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('nova traders')`);
    await db.query(`UPDATE companies SET is_active = false WHERE name = 'nova traders'`);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ('NOVA TRADERS') RETURNING id`,
    );
    expect(r.rows[0]?.id).toBeTruthy();
  });

  it('accepts owner_rep_id NULL as a house account, and a rep-owned row as owned', async () => {
    // NULL is load-bearing (§3.2): a house account is visible to every
    // rep, and a company the owner creates lands here.
    const repId = await insertEmployee('rep.house');
    const house = await db.query<{ owner_rep_id: string | null }>(
      `INSERT INTO companies (name) VALUES ('house account probe')
       RETURNING owner_rep_id`,
    );
    expect(house.rows[0]?.owner_rep_id).toBeNull();

    const owned = await db.query<{ owner_rep_id: string }>(
      `INSERT INTO companies (name, owner_rep_id) VALUES ('owned probe', $1)
       RETURNING owner_rep_id`,
      [repId],
    );
    expect(owned.rows[0]?.owner_rep_id).toBe(repId);
  });
});

describe('migration 005 — customers (PLAN-DATA-MODEL.md §3.2)', () => {
  it('rejects a customer with a latitude and no longitude', async () => {
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO customers (name, phone, latitude)
         VALUES ('Half Pin', '9800000001', 12.9716)`,
      ),
    );
    // The paired CHECK, not something else, must be what fires.
    expect(code).toBe('23514');
  });

  it('rejects the mirror case — a longitude with no latitude', async () => {
    const code = await errorCodeOf(
      db.query(
        `INSERT INTO customers (name, phone, longitude)
         VALUES ('Mirror Pin', '9800000002', 77.5946)`,
      ),
    );
    expect(code).toBe('23514');
  });

  it('accepts a fully pinned site and an unpinned one', async () => {
    const pinned = await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone, latitude, longitude)
       VALUES ('Pinned Site', '9800000003', 12.9716, 77.5946) RETURNING id`,
    );
    expect(pinned.rows[0]?.id).toBeTruthy();

    const unpinned = await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone)
       VALUES ('Unpinned Site', '9800000004') RETURNING id`,
    );
    expect(unpinned.rows[0]?.id).toBeTruthy();
  });

  it('takes company_id as a context link only — a nullable FK, no more', async () => {
    const companyId = await db.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ('context corp') RETURNING id`,
    );
    const r = await db.query<{ company_id: string }>(
      `INSERT INTO customers (name, phone, company_id)
       VALUES ('Corporate Site', '9800000005', $1) RETURNING company_id`,
      [companyId.rows[0]!.id],
    );
    expect(r.rows[0]?.company_id).toBe(companyId.rows[0]!.id);
  });
});

describe('migration 005 — products and services (PLAN-DATA-MODEL.md §3.2)', () => {
  it('enforces sku and code uniqueness outright', async () => {
    await db.query(
      `INSERT INTO products (sku, name, category)
       VALUES ('SG-UPS-001', 'Probe UPS 850VA', 'ups')`,
    );
    const sku = await errorCodeOf(
      db.query(
        `INSERT INTO products (sku, name, category)
         VALUES ('SG-UPS-001', 'Second Probe UPS', 'ups')`,
      ),
    );
    expect(sku).toBe('23505');

    await db.query(
      `INSERT INTO services (code, name) VALUES ('INSTALL', 'Installation probe')`,
    );
    const code = await errorCodeOf(
      db.query(`INSERT INTO services (code, name) VALUES ('INSTALL', 'Duplicate probe')`),
    );
    expect(code).toBe('23505');
  });

  it('bumps version on reference-data UPDATEs via touch_updated_at', async () => {
    // Reference data syncs to the mobile mirror (§6), so the trigger
    // contract must hold here the same as on identity tables.
    const r = await db.query<{ version: number }>(
      `INSERT INTO products (sku, name, category, default_price)
       VALUES ('SG-BAT-001', 'Probe Battery 150Ah', 'battery', 12500.00)
       RETURNING version`,
    );
    const bumped = await db.query<{ version: number }>(
      `UPDATE products SET default_price = 13000.00 WHERE sku = 'SG-BAT-001'
       RETURNING version`,
    );
    expect(r.rows[0]?.version).toBe(1);
    expect(bumped.rows[0]?.version).toBe(2);
  });
});
