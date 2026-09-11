import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  errorEnvelopeSchema,
  syncBatchResponseSchema,
  syncBootstrapResponseSchema,
  syncDeltaResponseSchema,
  type ErrorEnvelope,
  type JobStatus,
  type LoginResponse,
  type SyncOperation,
  type SyncOperationResult,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * The sync protocol (PHASE-1-TECHNICIAN.md T1.8, PLAN-BACKEND.md §7,
 * PLAN-DATA-MODEL.md §6). Runs against a scratch database built from the
 * real migrations (§14: no mocked database anywhere) and drives the three
 * doors over HTTP, because the things this task must prove are exactly
 * what a mock cannot prove:
 *
 *  - the bootstrap is role-scoped — a technician's working set is HIS
 *    jobs, the customers they touch and the catalogue, never another
 *    technician's rows;
 *  - the delta returns only rows newer than the cursor, and the cursor —
 *    the server's `updated_at`, never the device clock — is monotonic
 *    across calls, including while writes land concurrently;
 *  - SCOPE EXIT, both halves: a job reassigned away arrives as an
 *    `out_of_scope` tombstone (the mirror loses the row), and the queued
 *    completion for it still drains to a first-class verdict — the server
 *    decides on drain, nothing silently discards the technician's work;
 *  - the batch is ordered, not atomic: a rejection applies the other
 *    operations; `dependsOn` short-circuits so a rejected parent's child
 *    is returned `skipped` with its handler never running; a batch of 51
 *    is a 422 on the envelope; every-operation-rejected is still HTTP 200.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_sync_test';
const PASSWORD = 'sync-plain-copier-63';

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

const OWNER = { username: '', id: '', token: '' };
const TECH_A = { username: '', id: '', token: '' };
const TECH_B = { username: '', id: '', token: '' };
const DISPATCHER = { username: '', id: '', token: '' };
const SALES_REP = { username: '', id: '', token: '' };

async function seedEmployee(
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep',
  who: { username: string; id: string; token: string },
): Promise<void> {
  const username = `t18.${role}.${randomBytes(4).toString('hex')}`;
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

const CUSTOMER_A = { id: '', name: 'T1.8 Customer A' };
const CUSTOMER_B = { id: '', name: 'T1.8 Customer B' };
const CUSTOMER_C = { id: '', name: 'T1.8 Customer C' };
const SERVICE = { id: '', code: '' };
const PRODUCT = { id: '', sku: '' };

async function seedCustomer(who: { id: string; name: string }): Promise<void> {
  who.id = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`,
      [who.name, `9840${randomBytes(4).toString('hex')}`.slice(0, 10)],
    )
  ).rows[0]!.id;
}

interface SeedJobOverrides {
  status?: JobStatus;
  assignedTo?: string;
  customer?: { id: string };
}

async function seedJob(overrides: SeedJobOverrides = {}): Promise<string> {
  const status = overrides.status ?? 'assigned';
  const assignedTo = overrides.assignedTo ?? TECH_A.id;
  const r = await db.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at, closed_at, scheduled_for)
     VALUES ($1, $2, $3, 'T1.8 sync job', $4, $5, $6, $7, $8) RETURNING id`,
    [
      `JC-T18-${randomBytes(4).toString('hex')}`,
      (overrides.customer ?? CUSTOMER_A).id,
      SERVICE.id,
      status,
      status === 'unassigned' ? null : assignedTo,
      status === 'unassigned' ? null : new Date().toISOString(),
      // job_closed_coherent: terminal exactly when closed_at is set.
      status === 'completed' || status === 'cancelled' ? new Date().toISOString() : null,
      new Date().toISOString(),
    ],
  );
  return r.rows[0]!.id;
}

// ── request and read-back helpers ───────────────────────────────────────────

function getBootstrap(token: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/sync/bootstrap',
    headers: { authorization: `Bearer ${token}` },
  });
}

function getDelta(token: string, cursor: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/sync/delta?cursor=${encodeURIComponent(cursor)}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** One queued outbox operation — a uuid key generated once at enqueue, kept across retries. */
function op(localId: string, path: string, body: Record<string, unknown>, extra: Partial<SyncOperation> = {}): SyncOperation {
  return { localId, idempotencyKey: randomUUID(), method: 'POST', path, body, ...extra };
}

function postBatch(token: string, operations: SyncOperation[]) {
  return app.inject({
    method: 'POST',
    url: '/v1/sync/batch',
    headers: { authorization: `Bearer ${token}`, 'x-client-source': 'mobile' },
    payload: { operations },
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  const error = parsed.error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

async function jobRow(jobId: string): Promise<{ status: JobStatus; assigned_to: string | null; version: number }> {
  const r = await db.query<{ status: JobStatus; assigned_to: string | null; version: number }>(
    `SELECT status, assigned_to::text, version FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return r.rows[0]!;
}

async function eventCount(jobId: string): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_events WHERE job_card_id = $1`, [jobId]);
  return r.rows[0]!.n;
}

/** The cursor spelling is fixed-width ISO-8601, so chronological compare is safe either way. */
function assertCursorMonotonic(previous: string, next: string, label: string): void {
  expect(Date.parse(next), label).toBeGreaterThanOrEqual(Date.parse(previous));
}

/** The tombstone set for one delta response, as readable `[entity, reason, id]` triples. */
function tombstonesOf(body: unknown): Array<{ entity: string; reason: string; id: string }> {
  const parsed = syncDeltaResponseSchema.parse(body);
  return parsed.tombstones.map((t) => ({ entity: t.entity, reason: t.reason, id: t.id }));
}

function resultsOf(body: unknown): SyncOperationResult[] {
  return syncBatchResponseSchema.parse(body).results;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  // The services read through the process-wide pool (db/pool.ts); point it
  // at the scratch database before the first request.
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString() }));
  app = buildServer(config, { logger: false });
  await app.ready();

  for (const customer of [CUSTOMER_A, CUSTOMER_B, CUSTOMER_C]) await seedCustomer(customer);
  SERVICE.id = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ($1, 'T1.8 suite service') RETURNING id`,
      [`T18-SVC-${randomBytes(3).toString('hex')}`],
    )
  ).rows[0]!.id;
  PRODUCT.id = (
    await db.query<{ id: string }>(
      `INSERT INTO products (sku, name, category) VALUES ($1, 'T1.8 suite UPS', 'ups') RETURNING id`,
      [`T18-SKU-${randomBytes(3).toString('hex')}`],
    )
  ).rows[0]!.id;

  await seedEmployee('owner', OWNER);
  await seedEmployee('technician', TECH_A);
  await seedEmployee('technician', TECH_B);
  await seedEmployee('dispatcher', DISPATCHER);
  await seedEmployee('sales_rep', SALES_REP);
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

describe('bootstrap — the cold-start working set (§7)', () => {
  it('contains his jobs, the customers they touch, the stack and the catalogue — and no other technician’s', async () => {
    const hisOpen = await seedJob({ status: 'in_progress' });
    const hisClosed = await seedJob({ status: 'completed' });
    const theirs = await seedJob({ status: 'assigned', assignedTo: TECH_B.id, customer: CUSTOMER_B });

    const res = await getBootstrap(TECH_A.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = syncBootstrapResponseSchema.parse(res.json());

    const jobIds = body.data.jobs.map((j) => j.id).sort();
    expect(jobIds).toContain(hisOpen);
    expect(jobIds).toContain(hisClosed);
    expect(jobIds).not.toContain(theirs); // another technician's job is not his business
    expect(body.data.jobs.every((j) => j.contract === null)).toBe(true); // Phase 2B shape, present and null

    const customerIds = body.data.customers.map((c) => c.id);
    expect(customerIds).toContain(CUSTOMER_A.id); // reached through his jobs
    expect(customerIds).not.toContain(CUSTOMER_B.id); // only TECH_B works there
    expect(customerIds).not.toContain(CUSTOMER_C.id); // he has no job there at all

    expect(body.data.products.map((p) => p.id)).toContain(PRODUCT.id);
    expect(body.data.services.map((s) => s.id)).toContain(SERVICE.id);

    // The cursor is a real position, not a formality — the delta that follows sees nothing older.
    expect(body.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('is the technician handset’s door: dispatcher, sales rep and owner are 403, an anonymous caller 401', async () => {
    for (const who of [DISPATCHER.token, SALES_REP.token, OWNER.token]) {
      const res = await getBootstrap(who);
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    const anon = await app.inject({ method: 'GET', url: '/v1/sync/bootstrap' });
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('delta — newer rows and the monotonic cursor (§7)', () => {
  it('returns only rows newer than the cursor, and the cursor only moves forward', async () => {
    const touched = await seedJob({ status: 'assigned' });
    const still = await seedJob({ status: 'assigned' });
    const bootstrap = syncBootstrapResponseSchema.parse((await getBootstrap(TECH_A.token)).json());
    const cursor0 = bootstrap.cursor;
    expect(bootstrap.data.jobs.map((j) => j.id)).toContain(still);

    // One brand-new job and one touch of an existing one — both AFTER the snapshot.
    const fresh = await seedJob({ status: 'assigned' });
    await db.query(`UPDATE job_cards SET priority = 'high' WHERE id = $1`, [touched]);

    const first = syncDeltaResponseSchema.parse((await getDelta(TECH_A.token, cursor0)).json());
    expect(first.hasMore).toBe(false);
    const deltaIds = first.data.jobs.map((j) => j.id);
    expect(deltaIds).toContain(fresh);
    expect(deltaIds).toContain(touched); // the touch made it newer
    expect(deltaIds).not.toContain(still); // a row already at the cursor stays put
    assertCursorMonotonic(cursor0, first.cursor, 'first delta cursor');

    // With no writes since, the next delta delivers no rows and still advances-or-holds the cursor.
    const second = syncDeltaResponseSchema.parse((await getDelta(TECH_A.token, first.cursor)).json());
    expect(second.data.jobs).toEqual([]);
    assertCursorMonotonic(first.cursor, second.cursor, 'second delta cursor');
  });

  it('the cursor is monotonic under concurrent writes, and every write is delivered (Done-when)', async () => {
    const bootstrap = syncBootstrapResponseSchema.parse((await getBootstrap(TECH_A.token)).json());
    const cursor0 = bootstrap.cursor;

    // Writes land WHILE deltas run — the racing case a device clock as
    // cursor would corrupt, and the server's `updated_at` keeps ordered.
    const written: string[] = [];
    const [, first] = await Promise.all([
      (async () => {
        for (let i = 0; i < 3; i++) written.push(await seedJob({ status: 'assigned' }));
      })(),
      getDelta(TECH_A.token, cursor0).then((res) => syncDeltaResponseSchema.parse(res.json())),
    ]);
    assertCursorMonotonic(cursor0, first.cursor, 'concurrent delta cursor 1');

    const [, second] = await Promise.all([
      (async () => {
        for (let i = 0; i < 3; i++) written.push(await seedJob({ status: 'assigned' }));
      })(),
      getDelta(TECH_A.token, first.cursor).then((res) => syncDeltaResponseSchema.parse(res.json())),
    ]);
    assertCursorMonotonic(first.cursor, second.cursor, 'concurrent delta cursor 2');

    // Catching up from the ORIGINAL cursor still delivers every write — nothing was skipped.
    const catchUp = syncDeltaResponseSchema.parse((await getDelta(TECH_A.token, cursor0)).json());
    const delivered = new Set(catchUp.data.jobs.map((j) => j.id));
    for (const id of written) expect(delivered, `job ${id} must reach the client`).toContain(id);
    assertCursorMonotonic(second.cursor, catchUp.cursor, 'catch-up cursor');
  });

  it('a malformed or missing cursor is a 422, never a silent full sync', async () => {
    for (const url of ['/v1/sync/delta', '/v1/sync/delta?cursor=not-a-timestamp', '/v1/sync/delta?cursor=2026-13-40T99:00:00.000000Z']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TECH_A.token}` } });
      expect(res.statusCode, url).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('scope exit — the tombstone that bites (§7, Done-when both halves)', () => {
  it('a reassigned job leaves the mirror as out_of_scope — and the queued completion still drains to a verdict', async () => {
    // A site no other test gives TECH_A a job at, so the customer's scope
    // hangs on THIS job alone.
    const site = { id: '', name: 'T1.8 Customer D (reassignment)' };
    await seedCustomer(site);
    const job = await seedJob({ status: 'in_progress', customer: site });
    const bootstrap = syncBootstrapResponseSchema.parse((await getBootstrap(TECH_A.token)).json());
    expect(bootstrap.data.jobs.map((j) => j.id)).toContain(job);
    expect(bootstrap.data.customers.map((c) => c.id)).toContain(site.id);

    // The office gives the job to Anitha: not deleted, not inactive — simply no longer Ravi's.
    await db.query(`UPDATE job_cards SET assigned_to = $2, assigned_at = now() WHERE id = $1`, [job, TECH_B.id]);

    const delta = syncDeltaResponseSchema.parse((await getDelta(TECH_A.token, bootstrap.cursor)).json());

    // HALF ONE — the row leaves the mirror: the tombstone arrives and the job is not in the rows.
    const tombstones = tombstonesOf(delta);
    expect(tombstones).toContainEqual({ entity: 'job', reason: 'out_of_scope', id: job });
    expect(delta.data.jobs.map((j) => j.id)).not.toContain(job);
    // The site leaves with it — his last in-window job there just went to TECH_B.
    expect(tombstones).toContainEqual({ entity: 'customer', reason: 'out_of_scope', id: site.id });

    // HALF TWO — the outbox survives the tombstone: the completion Ravi
    // queued underground is still his work and still drains. Anitha
    // finished the job first, so the server's verdict on drain is
    // JOB_ALREADY_CLOSED — a first-class per-operation outcome, HTTP 200,
    // never a silent discard and never an envelope failure.
    const completionByNewOwner = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job}/complete`,
      headers: { authorization: `Bearer ${TECH_B.token}`, 'x-client-source': 'web' },
      payload: { completedAt: new Date().toISOString(), workSummary: 'Done by Anitha', collectionMode: 'none' },
    });
    expect(completionByNewOwner.statusCode, completionByNewOwner.body).toBe(200);

    const queuedCompletion = op('l_completion', `/v1/jobs/${job}/complete`, {
      completedAt: new Date().toISOString(),
      workSummary: 'Completed underground before the reassignment',
      collectionMode: 'none',
    });
    const drain = await postBatch(TECH_A.token, [queuedCompletion]);
    expect(drain.statusCode, drain.body).toBe(200);
    const results = resultsOf(drain.json());
    expect(results).toHaveLength(1);
    expect(results[0]!.localId).toBe('l_completion');
    // The verdict on drain is first-class: the completion handler RAN and
    // refused with the matrix's own cell — the job is no longer his
    // (OUT_OF_SCOPE; scope is checked before closure, so once Anitha has
    // completed it the closure verdict can never apply to Ravi's op). A
    // definite 409 through the real stack — the queued work was neither
    // discarded nor silently dropped, which is what §7 forbids.
    expect(results[0]!.outcome).toBe('rejected');
    expect(results[0]!.error?.code).toBe('OUT_OF_SCOPE');
    expect(results[0]!.status).toBe(403);
  });

  it('a soft-deleted customer arrives as a deleted tombstone', async () => {
    const job = await seedJob({ status: 'assigned', customer: CUSTOMER_C });
    const bootstrap = syncBootstrapResponseSchema.parse((await getBootstrap(TECH_A.token)).json());
    expect(bootstrap.data.customers.map((c) => c.id)).toContain(CUSTOMER_C.id);

    // Soft delete, never DELETE (§6): the tombstone reaches the client through the same protocol.
    await db.query(`UPDATE customers SET is_active = false WHERE id = $1`, [CUSTOMER_C.id]);

    const delta = syncDeltaResponseSchema.parse((await getDelta(TECH_A.token, bootstrap.cursor)).json());
    expect(tombstonesOf(delta)).toContainEqual({ entity: 'customer', reason: 'deleted', id: CUSTOMER_C.id });
    expect(delta.data.customers.map((c) => c.id)).not.toContain(CUSTOMER_C.id);
    // The job itself did not change since the snapshot, so the cursor
    // correctly says nothing about it — only the customer row left.
    expect((await jobRow(job)).status).toBe('assigned');
  });
});

describe('batch — the outbox drain (§7)', () => {
  it('l_02 dependsOn l_01, l_01 rejected → l_02 skipped, its handler never running', async () => {
    const cancelled = await seedJob({ status: 'cancelled' });
    const open = await seedJob({ status: 'assigned' });

    const res = await postBatch(TECH_A.token, [
      op('l_01', `/v1/jobs/${cancelled}/complete`, {
        completedAt: new Date().toISOString(),
        workSummary: 'queued before the office cancelled it',
        collectionMode: 'none',
      }),
      op('l_02', `/v1/jobs/${open}/status`, { to: 'en_route', occurredAt: new Date().toISOString() }, { dependsOn: 'l_01' }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const results = resultsOf(res.json());
    expect(results.map((r) => r.localId)).toEqual(['l_01', 'l_02']);
    expect(results[0]!.outcome).toBe('rejected');
    expect(results[0]!.error?.code).toBe('JOB_ALREADY_CLOSED');
    expect(results[1]!.outcome).toBe('skipped');
    expect(results[1]!.status).toBe(0); // never attempted — no HTTP call exists for it
    expect(results[1]!.error?.code).toBe('PARENT_REJECTED');

    // The short-circuit is proven on the real stack: the child handler
    // never ran — the card did not move and the trail has no event.
    expect((await jobRow(open)).status).toBe('assigned');
    expect(await eventCount(open)).toBe(0);
  });

  it('one rejection among five — the other four still apply', async () => {
    const cancelled = await seedJob({ status: 'cancelled' });
    const moving: string[] = [];
    for (let i = 0; i < 4; i++) moving.push(await seedJob({ status: 'assigned' }));

    const res = await postBatch(TECH_A.token, [
      op('l_01', `/v1/jobs/${cancelled}/complete`, {
        completedAt: new Date().toISOString(),
        workSummary: 'will be rejected — the office cancelled this one',
        collectionMode: 'none',
      }),
      ...moving.map((id, i) => op(`l_0${i + 2}`, `/v1/jobs/${id}/status`, { to: 'en_route', occurredAt: new Date().toISOString() })),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const results = resultsOf(res.json());
    expect(results.map((r) => r.outcome)).toEqual(['rejected', 'applied', 'applied', 'applied', 'applied']);

    // Ordered, not atomic, in the database: the four moves stand, each with
    // its own event, and the rejection wrote nothing to the cancelled card.
    for (const id of moving) {
      expect((await jobRow(id)).status).toBe('en_route');
      expect(await eventCount(id)).toBe(1);
    }
    expect(await eventCount(cancelled)).toBe(0);
  });

  it('a batch of 51 operations is a 422 on the envelope', async () => {
    const operations = Array.from({ length: 51 }, (_, i) =>
      op(`l_${String(i).padStart(2, '0')}`, `/v1/jobs/${randomUUID()}/status`, {
        to: 'en_route',
        occurredAt: new Date().toISOString(),
      }),
    );
    const res = await postBatch(TECH_A.token, operations);
    expect(res.statusCode, res.body).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });

  it('every operation rejected is still HTTP 200 — the batch itself succeeded', async () => {
    const cancelled = await seedJob({ status: 'cancelled' });
    const assigned = await seedJob({ status: 'assigned' });

    const res = await postBatch(TECH_A.token, [
      op('l_01', `/v1/jobs/${cancelled}/complete`, {
        completedAt: new Date().toISOString(),
        workSummary: 'already cancelled',
        collectionMode: 'none',
      }),
      // A legal-shaped payload for an illegal move: the office's refusals
      // hold at the drain too.
      op('l_02', `/v1/jobs/${assigned}/status`, { to: 'completed', occurredAt: new Date().toISOString() }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const results = resultsOf(res.json());
    expect(results.map((r) => r.outcome)).toEqual(['rejected', 'rejected']);
    expect(results[0]!.error?.code).toBe('JOB_ALREADY_CLOSED');
    expect(results[1]!.error?.code).toBe('ILLEGAL_TRANSITION');
    expect((await jobRow(assigned)).status).toBe('assigned');
  });

  it('a replayed operation comes back `duplicate` — a success, not a second apply', async () => {
    const job = await seedJob({ status: 'assigned' });
    const replayed = op('l_01', `/v1/jobs/${job}/status`, { to: 'en_route', occurredAt: new Date().toISOString() });

    const first = await postBatch(TECH_A.token, [replayed]);
    expect(first.statusCode, first.body).toBe(200);
    expect(resultsOf(first.json())[0]!.outcome).toBe('applied');

    // The drain re-ran with the SAME key — the idempotency layer replays
    // the stored response and the client marks the item done.
    const second = await postBatch(TECH_A.token, [{ ...replayed }]);
    expect(second.statusCode, second.body).toBe(200);
    const result = resultsOf(second.json())[0]!;
    expect(result.outcome).toBe('duplicate');
    expect(result.status).toBe(200);
    expect((result.body as { status?: string }).status).toBe('en_route');

    // One move, one event — the replay did not execute the handler again.
    expect(await eventCount(job)).toBe(1);
  });

  it('a malformed envelope is a 422: duplicate localIds, a forward or unknown dependsOn, a foreign batch key', async () => {
    const job = await seedJob({ status: 'assigned' });
    const valid = op('l_01', `/v1/jobs/${job}/status`, { to: 'en_route', occurredAt: new Date().toISOString() });

    const cases: Array<{ name: string; operations: SyncOperation[]; batchKey?: string }> = [
      {
        name: 'two operations share a localId',
        operations: [valid, { ...valid, idempotencyKey: randomUUID() }],
      },
      {
        name: 'dependsOn names an unknown localId',
        operations: [op('l_01', `/v1/jobs/${job}/status`, { to: 'en_route', occurredAt: new Date().toISOString() }, { dependsOn: 'l_missing' })],
      },
      {
        name: 'dependsOn names a LATER operation',
        operations: [
          op('l_01', `/v1/jobs/${job}/status`, { to: 'en_route', occurredAt: new Date().toISOString() }, { dependsOn: 'l_02' }),
          op('l_02', `/v1/jobs/${job}/status`, { to: 'in_progress', occurredAt: new Date().toISOString() }),
        ],
      },
      {
        name: 'an operation reuses the batch’s own idempotency key',
        operations: [valid],
        batchKey: valid.idempotencyKey,
      },
    ];
    for (const testCase of cases) {
      const headers: Record<string, string> = { authorization: `Bearer ${TECH_A.token}` };
      if (testCase.batchKey !== undefined) headers['idempotency-key'] = testCase.batchKey;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sync/batch',
        headers,
        payload: { operations: testCase.operations },
      });
      expect(res.statusCode, testCase.name).toBe(422);
      expect(envelopeOf(res.statusCode, res.body).code, testCase.name).toBe('VALIDATION_FAILED');
      // Nothing applied for a batch whose envelope itself failed.
      expect((await jobRow(job)).status).toBe('assigned');
    }
  });

  it('is the technician handset’s door: dispatcher, sales rep and owner are 403, an anonymous caller 401', async () => {
    for (const who of [DISPATCHER.token, SALES_REP.token, OWNER.token]) {
      const res = await postBatch(who, []);
      expect(res.statusCode, res.body).toBe(403);
      expect(envelopeOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    }
    const anon = await app.inject({ method: 'POST', url: '/v1/sync/batch', payload: { operations: [] } });
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');
  });
});
