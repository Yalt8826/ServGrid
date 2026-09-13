import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  type CompanyRecord,
  type ErrorEnvelope,
  type LoginResponse,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Companies authorisation suite (PHASE-3-SALES-REP.md T3.2, PLAN-BACKEND.md
 * §5 `own` on company, §11). The assertions the task exists for:
 *
 * - **Rep isolation on EVERY company endpoint, both directions** — the
 *   list, the point read and the PATCH each answer with his accounts plus
 *   the house accounts and never the other rep's. Every assertion is on
 *   the returned ROWS (ids and owners), never on a count — a count passes
 *   while hiding the wrong rows.
 * - **The scope is in the query, so pagination composes with it** — a
 *   capped page of a rep's list is full of in-scope rows and the cursor
 *   walk reconstructs exactly his set, with no short page of nothing
 *   (the task's "If it fails" regression).
 * - **Ownership moves through one door** — PATCH /v1/companies/:id/owner
 *   is owner only; a rep is refused on his own account, so he can neither
 *   claim nor hand off. The owner's move (including to NULL, the leave
 *   cover) lands and leaves an audit_log trail.
 * - **A rep who creates a company becomes its owner** — and the company
   the owner creates lands a house account, visible to both.
 * - **A payment recorded by a non-owning rep is accepted and records him
 *   in `received_by`** — the completed_by precedent (§3.2): the record
 *   says who did the thing, not who owns the account. The payment
 *   ENDPOINT is T3.4's; this pins the schema semantics the model relies
 *   on, against the real migrated database.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_authz_companies_test';
const PASSWORD = 'mv-plain-copier-32';

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

async function seedEmployee(role: 'owner' | 'sales_rep', who: Actor): Promise<void> {
  const username = `t32az.${role.toLowerCase()}.${randomBytes(4).toString('hex')}`;
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

async function seedCompany(name: string, ownerRepId: string | null): Promise<CompanyRecord> {
  const r = await db.query<{ id: string; version: number }>(
    `INSERT INTO companies (name, owner_rep_id) VALUES ($1, $2) RETURNING id, version`,
    [name, ownerRepId],
  );
  return {
    id: r.rows[0]!.id,
    name,
    contactPerson: null,
    phone: null,
    email: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    gstin: null,
    notes: null,
    ownerRepId,
    version: r.rows[0]!.version,
  };
}

function bearer(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

async function listCompanies(actor: Actor, query = ''): Promise<{ statusCode: number; body: string }> {
  return app.inject({ method: 'GET', url: `/v1/companies${query}`, headers: bearer(actor) });
}

/** The ids a list response carried, sorted — the row-set assertion, never a count. */
function idsOf(body: string): string[] {
  return (JSON.parse(body) as { items: CompanyRecord[] }).items.map((c) => c.id).sort();
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
  await seedEmployee('sales_rep', REP_A);
  await seedEmployee('sales_rep', REP_B);
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  // Detach the process pool from the database this suite is about to drop,
  // so a later suite in the same worker cannot inherit a dead connection.
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

describe('rep isolation — own accounts plus house accounts, both directions', () => {
  const repAco = { name: 'Az Rep A Account', id: '' };
  const repBco = { name: 'Az Rep B Account', id: '' };
  const houseOne = { name: 'Az House One', id: '' };
  const houseTwo = { name: 'Az House Two', id: '' };
  /** Untouched by every test in this file until the reassignment block. */
  const reassignCo = { name: 'Az Reassign Co', id: '' };

  beforeAll(async () => {
    repAco.id = (await seedCompany(repAco.name, REP_A.id)).id;
    repBco.id = (await seedCompany(repBco.name, REP_B.id)).id;
    houseOne.id = (await seedCompany(houseOne.name, null)).id;
    houseTwo.id = (await seedCompany(houseTwo.name, null)).id;
    reassignCo.id = (await seedCompany(reassignCo.name, REP_A.id)).id;
  });

  it('GET /v1/companies — rep A sees his account and the house accounts, never rep B’s (and the mirror image for rep B)', async () => {
    const resA = await listCompanies(REP_A);
    expect(resA.statusCode, resA.body).toBe(200);
    expect(idsOf(resA.body)).toEqual([repAco.id, houseOne.id, houseTwo.id, reassignCo.id].sort());
    const itemsA = (JSON.parse(resA.body) as { items: CompanyRecord[] }).items;
    expect(itemsA.map((c) => c.name)).not.toContain(repBco.name);
    // The rows carry their ownership, so the shape itself shows the house-account floor.
    expect(itemsA.find((c) => c.id === repAco.id)!.ownerRepId).toBe(REP_A.id);
    expect(itemsA.find((c) => c.id === houseOne.id)!.ownerRepId).toBeNull();

    const resB = await listCompanies(REP_B);
    expect(resB.statusCode, resB.body).toBe(200);
    expect(idsOf(resB.body)).toEqual([repBco.id, houseOne.id, houseTwo.id].sort());
    expect((JSON.parse(resB.body) as { items: CompanyRecord[] }).items.map((c) => c.name)).not.toContain(repAco.name);
  });

  it('GET /v1/companies — the scope sits inside the WHERE, so a capped page stays full of in-scope rows and the cursor walk reconstructs exactly the set', async () => {
    // Four in-scope rows, page size two: a scope applied after a LIMIT
    // would shorten the page or return rows the walk then loses.
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const res = await listCompanies(REP_A, cursor === '' ? '?limit=2' : `?limit=2&cursor=${cursor}`);
      expect(res.statusCode, res.body).toBe(200);
      const parsed = JSON.parse(res.body) as { items: CompanyRecord[]; nextCursor: string | null };
      seen.push(...parsed.items.map((c) => c.id));
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
    }
    expect(seen.sort()).toEqual([repAco.id, houseOne.id, houseTwo.id, reassignCo.id].sort());
  });

  it('GET /v1/companies/:id — his own and house accounts read; the other rep’s account is OUT_OF_SCOPE, not 404', async () => {
    const own = await app.inject({ method: 'GET', url: `/v1/companies/${repAco.id}`, headers: bearer(REP_A) });
    expect(own.statusCode, own.body).toBe(200);
    const house = await app.inject({ method: 'GET', url: `/v1/companies/${houseOne.id}`, headers: bearer(REP_A) });
    expect(house.statusCode, house.body).toBe(200);

    const foreign = await app.inject({ method: 'GET', url: `/v1/companies/${repBco.id}`, headers: bearer(REP_A) });
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(errorOf(foreign.statusCode, foreign.body).code).toBe('OUT_OF_SCOPE');

    // Direction two: rep B against rep A's account.
    const mirror = await app.inject({ method: 'GET', url: `/v1/companies/${repAco.id}`, headers: bearer(REP_B) });
    expect(mirror.statusCode, mirror.body).toBe(403);
    expect(errorOf(mirror.statusCode, mirror.body).code).toBe('OUT_OF_SCOPE');
  });

  it('PATCH /v1/companies/:id — a rep edits his own and a house account; the other rep’s account refuses AND does not change', async () => {
    const editHouse = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${houseOne.id}`,
      headers: { ...bearer(REP_A), 'if-match': '1' },
      payload: { notes: 'Rep A called on the house account.' },
    });
    expect(editHouse.statusCode, editHouse.body).toBe(200);
    expect((JSON.parse(editHouse.body) as CompanyRecord).version).toBe(2);

    const refused = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${repBco.id}`,
      headers: { ...bearer(REP_A), 'if-match': '1' },
      payload: { notes: 'This must never land.' },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused.statusCode, refused.body).code).toBe('OUT_OF_SCOPE');

    // Direction two, and proof the refusal was the WRITE and not the wording.
    const mirror = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${repAco.id}`,
      headers: { ...bearer(REP_B), 'if-match': '1' },
      payload: { notes: 'This must never land either.' },
    });
    expect(mirror.statusCode, mirror.body).toBe(403);

    const rows = await db.query<{ notes: string | null; version: number }>(
      'SELECT notes, version FROM companies WHERE id = ANY($1)',
      [[repAco.id, repBco.id]],
    );
    for (const row of rows.rows) {
      expect(row.notes).toBeNull();
      expect(row.version).toBe(1);
    }
  });
});

describe('ownership moves through one door — PATCH /v1/companies/:id/owner, owner only', () => {
  const repAco = { name: 'Az Door Rep A', id: '' };
  const repBco = { name: 'Az Door Rep B', id: '' };
  const house = { name: 'Az Door House', id: '' };

  beforeAll(async () => {
    repAco.id = (await seedCompany(repAco.name, REP_A.id)).id;
    repBco.id = (await seedCompany(repBco.name, REP_B.id)).id;
    house.id = (await seedCompany(house.name, null)).id;
  });

  it('a rep cannot reassign an account — his own included, a house account, or the other rep’s', async () => {
    for (const companyId of [repAco.id, house.id, repBco.id]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/companies/${companyId}/owner`,
        headers: bearer(REP_A),
        payload: { ownerRepId: REP_B.id },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    // The refusal was the write: nothing moved while the door said no.
    const rows = await db.query<{ owner_rep_id: string | null }>(
      'SELECT owner_rep_id FROM companies WHERE id = ANY($1)',
      [[repAco.id, repBco.id, house.id]],
    );
    expect(rows.rows.map((r) => r.owner_rep_id).sort()).toEqual([REP_A.id, REP_B.id, null].sort());
  });

  it('the owner reassigns an account to the other rep — and the account follows the column', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${repAco.id}/owner`,
      headers: bearer(OWNER),
      payload: { ownerRepId: REP_B.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as CompanyRecord).ownerRepId).toBe(REP_B.id);

    const row = await db.query<{ owner_rep_id: string | null }>(
      'SELECT owner_rep_id FROM companies WHERE id = $1',
      [repAco.id],
    );
    expect(row.rows[0]!.owner_rep_id).toBe(REP_B.id);

    // Isolation follows the column: the list each rep gets has moved with it.
    const listA = await listCompanies(REP_A);
    expect(idsOf(listA.body)).not.toContain(repAco.id);
    const listB = await listCompanies(REP_B);
    expect(idsOf(listB.body)).toContain(repAco.id);
  });

  it('the owner nulls an account — the leave cover, and it becomes a house account both reps see', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${repBco.id}/owner`,
      headers: bearer(OWNER),
      payload: { ownerRepId: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as CompanyRecord).ownerRepId).toBeNull();

    for (const who of [REP_A, REP_B]) {
      const list = await listCompanies(who);
      expect(list.statusCode, list.body).toBe(200);
      expect(idsOf(list.body)).toContain(repBco.id);
    }
  });

  it('the change leaves a trail — an append-only audit row naming both owners', async () => {
    const trail = await db.query<{ action: string; actor: string; details: Record<string, unknown> }>(
      `SELECT action, actor, details FROM audit_log WHERE action = 'company.owner.reassigned' ORDER BY id`,
    );
    expect(trail.rows.length).toBe(2);
    expect(trail.rows[0]!.actor).toBe(OWNER.id);
    expect(trail.rows[0]!.details).toMatchObject({
      companyId: repAco.id,
      previousOwnerRepId: REP_A.id,
      newOwnerRepId: REP_B.id,
    });
    expect(trail.rows[1]!.details).toMatchObject({
      companyId: repBco.id,
      previousOwnerRepId: REP_B.id,
      newOwnerRepId: null,
    });
  });

  it('a reassignment to an employee who does not exist is a readable refusal, not a 500', async () => {
    const ghost = randomBytes(16).toString('hex');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/companies/${house.id}/owner`,
      headers: bearer(OWNER),
      payload: { ownerRepId: `${ghost.slice(0, 8)}-${ghost.slice(8, 12)}-${ghost.slice(12, 16)}-${ghost.slice(16, 20)}-${ghost.slice(20, 32)}` },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });
});

describe('create — the server stamps ownership, never the caller', () => {
  it('a rep who creates a company becomes its owner_rep_id — and the other rep does not see it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/companies',
      headers: bearer(REP_A),
      payload: { name: 'Az Created By Rep A' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = JSON.parse(res.body) as CompanyRecord;
    expect(created.ownerRepId).toBe(REP_A.id);

    // The response IS the row (the service reads it back), and the database agrees.
    const row = await db.query<{ owner_rep_id: string | null }>(
      'SELECT owner_rep_id FROM companies WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]!.owner_rep_id).toBe(REP_A.id);

    const resB = await listCompanies(REP_B);
    expect(idsOf(resB.body)).not.toContain(created.id);
  });

  it('a company the OWNER creates lands a house account — visible to both reps', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/companies',
      headers: bearer(OWNER),
      payload: { name: 'Az Created By Owner' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = JSON.parse(res.body) as CompanyRecord;
    expect(created.ownerRepId).toBeNull();

    for (const who of [REP_A, REP_B]) {
      const list = await listCompanies(who);
      expect(idsOf(list.body)).toContain(created.id);
    }
  });
});

describe('payments.received_by — whoever actually took the money (§3.2, the completed_by precedent)', () => {
  it('a payment recorded by a NON-owning rep against rep A’s account is accepted and records rep B', async () => {
    const account = await seedCompany('Az Received By Co', REP_A.id);
    // The payment ENDPOINT is T3.4's; this pins the schema semantics the
    // model leans on — no constraint ties received_by to the account's
    // owner, because the record says who did the thing.
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO payments (payment_number, company_id, amount, mode, received_by, received_at)
       VALUES ($1, $2, '1500.00', 'cash', $3, now()) RETURNING id`,
      [`PM-AZ-${randomBytes(4).toString('hex')}`, account.id, REP_B.id],
    );
    expect(inserted.rows.length).toBe(1);

    const row = await db.query<{ received_by: string; company_id: string }>(
      'SELECT received_by, company_id FROM payments WHERE id = $1',
      [inserted.rows[0]!.id],
    );
    expect(row.rows[0]!.received_by).toBe(REP_B.id);
    expect(row.rows[0]!.company_id).toBe(account.id);
  });
});
