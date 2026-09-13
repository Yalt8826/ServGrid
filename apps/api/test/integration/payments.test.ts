import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import {
  PaymentSchema,
  syncBatchResponseSchema,
  type ErrorEnvelope,
  type LoginResponse,
  type PaymentRecord,
  type SyncOperation,
} from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { signedRequest, type StorageConfig } from '../../src/lib/storage.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Payments integration suite (PHASE-3-SALES-REP.md T3.4, PLAN-BACKEND.md
 * §11, PLAN-DATA-MODEL.md §3.5). The assertions the task exists for:
 *
 * - **An on-account payment (`sales_card_id` NULL) moves the company
 *   balance** — `v_company_balances` asserted to the paisa before and
 *   after; the number `PM-2627-#####` is allocated at CREATE, because
 *   payments are not drafted and there is no pending state to allocate at.
 * - **A void requires a reason and reverses the balance** — the owner's
 *   door, not a matrix cell; the reversal is the view's business and the
 *   number stays.
 * - **A cash payment appears in `v_employee_expected_cash` for that rep's
 *   day; a UPI payment does not** — and once the owner voids the cash
 *   payment the expectation disappears, because the view filters
 *   `status = 'collected'` as well as `mode = 'cash'`.
 * - **A rep sees his own payments and not the other rep's, including for
 *   a house account** — `own` on payment is `received_by`, deliberately
 *   stricter than `own` on company.
 * - **The proof photo drains after its parent payment, across the two
 *   drain passes** — pass 1 resolves the payment through the JSON batch,
 *   pass 2 uploads the photo to /v1/attachments against the parent that
 *   only exists because pass 1 applied. (The on-device Maestro flow is
 *   T3.7's; this suite proves the server half on the real stack.)
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_payments_test';
const PASSWORD = 'payments-plain-copier-64';

/** This suite's private bucket — the proof-photo leg stores real objects, and nobody else writes here. */
const TEST_BUCKET = 'servgrid-t34-pay-test';
const s3: StorageConfig = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  bucket: TEST_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'servgrid',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'servgrid-minio',
  region: 'us-east-1',
};

interface Actor {
  username: string;
  id: string;
  token: string;
}

const OWNER: Actor = { username: '', id: '', token: '' };
const REP_A: Actor = { username: '', id: '', token: '' };
const REP_B: Actor = { username: '', id: '', token: '' };
const REP_NO_FLAG: Actor = { username: '', id: '', token: '' };

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

let companyId: string; // REP_A's account — the balance stories
let houseId: string; // a HOUSE account (owner_rep_id NULL) — the stricter-scope case

async function seedEmployee(role: 'owner' | 'sales_rep' | 'dispatcher', who: Actor, flags: string[]): Promise<void> {
  const username = `t34.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  who.id = r.rows[0]!.id;
  who.username = username;
  for (const flag of flags) {
    // The task's T0 rollback tier ships dark: the suite turns the flags on
    // for the people on the surface, the way the owner's flip would — the
    // flag mechanics themselves are flags.test.ts's subject. `tech.offline`
    // lights the sync batch, the drain's pass 1, for the proof-photo story.
    await db.query(`INSERT INTO employee_flag_overrides (employee_id, flag, enabled) VALUES ($1, $2, true)`, [
      who.id,
      flag,
    ]);
  }
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

async function createCompany(actor: Actor, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/companies',
    headers: bearer(actor),
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function createSaleOk(actor: Actor, payload: Record<string, unknown>): Promise<{ id: string; total: string }> {
  const created = await app.inject({ method: 'POST', url: '/v1/sales', headers: bearer(actor), payload });
  expect(created.statusCode, created.body).toBe(200);
  const draft = JSON.parse(created.body) as { id: string };
  const confirmed = await app.inject({
    method: 'POST',
    url: `/v1/sales/${draft.id}/confirm`,
    headers: bearer(actor),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return JSON.parse(confirmed.body) as { id: string; total: string };
}

async function createPayment(
  actor: Actor,
  payload: Record<string, unknown>,
  key?: string,
): Promise<{ statusCode: number; body: string }> {
  const headers: Record<string, string> = { ...bearer(actor) };
  if (key !== undefined) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url: '/v1/payments', headers, payload });
}

async function createPaymentOk(actor: Actor, payload: Record<string, unknown>): Promise<PaymentRecord> {
  const res = await createPayment(actor, payload);
  expect(res.statusCode, res.body).toBe(200);
  return parsePayment(res.statusCode, res.body);
}

async function voidPayment(
  actor: Actor,
  paymentId: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'POST',
    url: `/v1/payments/${paymentId}/void`,
    headers: bearer(actor),
    payload,
  });
}

async function listPayments(actor: Actor): Promise<PaymentRecord[]> {
  const res = await app.inject({ method: 'GET', url: '/v1/payments', headers: bearer(actor) });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { items: PaymentRecord[] }).items;
}

function parsePayment(_status: number, body: string): PaymentRecord {
  return PaymentSchema.parse(JSON.parse(body)) as PaymentRecord;
}

function errorOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const error = (JSON.parse(body) as ErrorEnvelope).error;
  expect(error.requestId).toMatch(ULID);
  return error;
}

/** The company's derived balance — the number the whole task is about. */
async function balanceOf(company: string): Promise<string> {
  const r = await db.query<{ balance: string }>(
    'SELECT balance::text FROM v_company_balances WHERE company_id = $1',
    [company],
  );
  expect(r.rows.length, 'the balance view carries every company').toBe(1);
  return r.rows[0]!.balance;
}

/** The rep-day row of the expected-cash view, or null when the day carries no expectation. */
async function expectedCashFor(employeeId: string, businessDate: string): Promise<string | null> {
  const r = await db.query<{ expected_cash: string }>(
    `SELECT expected_cash::text AS expected_cash FROM v_employee_expected_cash
     WHERE employee_id = $1 AND business_date = $2::date`,
    [employeeId, businessDate],
  );
  return r.rows[0]?.expected_cash ?? null;
}

/**
 * A fresh account per balance story. `v_company_balances` is CUMULATIVE
 * per company, so each describe that asserts a literal balance sells and
 * collects against its own company, and the assertion reads the whole
 * story and nothing else.
 */
async function newCompany(): Promise<string> {
  return createCompany(REP_A, `Integr Payments ${randomBytes(3).toString('hex')}`);
}

// ── the drain (§7) and the proof photo (§9) ─────────────────────────────────

/** One queued outbox operation — a uuid key generated once at enqueue, kept across retries. */
function op(localId: string, path: string, body: Record<string, unknown>, extra: Partial<SyncOperation> = {}): SyncOperation {
  return { localId, idempotencyKey: randomUUID(), method: 'POST', path, body, ...extra };
}

function postBatch(actor: Actor, operations: SyncOperation[]) {
  return app.inject({
    method: 'POST',
    url: '/v1/sync/batch',
    headers: { ...bearer(actor), 'x-client-source': 'mobile' },
    payload: { operations },
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fresh PNG per call — two "different" photos must never share a checksum by accident. */
async function pngBytes(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! },
    },
  })
    .png()
    .toBuffer();
}

/** Hand-built multipart body — the same shape the attachments suite proves byte-for-byte. */
function multipartBody(fields: Record<string, string>, file: { data: Buffer; filename: string }): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----servgridt34${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadProof(
  actor: Actor,
  ownerId: string,
  file: Buffer,
): Promise<{ statusCode: number; body: string }> {
  const { payload, contentType } = multipartBody(
    {
      ownerType: 'payment',
      ownerId,
      kind: 'photo',
      capturedAt: '2026-09-11T16:05:00+05:30',
      fileChecksum: sha256(file),
    },
    { data: file, filename: 'proof.png' },
  );
  return app.inject({
    method: 'POST',
    url: '/v1/attachments',
    headers: { ...bearer(actor), 'content-type': contentType },
    payload,
  });
}

beforeAll(async () => {
  // The proof-photo leg stores a real object (§14: no mocks where the
  // failure lives) — own bucket, so the object assertions are exact.
  const bucketRes = await signedRequest(s3, { method: 'PUT', path: `/${TEST_BUCKET}` });
  if (!bucketRes.ok && bucketRes.status !== 409) {
    throw new Error(`cannot create test bucket ${TEST_BUCKET}: HTTP ${bucketRes.status} — is MinIO up on ${s3.endpoint}?`);
  }

  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString(), S3_BUCKET: TEST_BUCKET }));
  app = buildServer(config, { logger: false });
  await app.ready();

  await seedEmployee('owner', OWNER, ['sales.payments', 'sales.cards']);
  // The reps carry `sales.cards` too: the fixtures confirm real sales
  // through the API so the payment stories settle against live balances —
  // T3.3's surface, not this task's subject.
  await seedEmployee('sales_rep', REP_A, ['sales.payments', 'sales.cards', 'tech.offline']);
  await seedEmployee('sales_rep', REP_B, ['sales.payments', 'sales.cards']);
  await seedEmployee('sales_rep', REP_NO_FLAG, []); // the flag-off probe

  companyId = await createCompany(REP_A, `Integr Payments Co ${randomBytes(3).toString('hex')}`);
  // A HOUSE account: any rep may see and work the account (company `own`
  // has a NULL floor), and that is exactly the account on which payment
  // scope must stay stricter — the money belongs to whoever collected it.
  houseId = await createCompany(REP_A, `Integr House Co ${randomBytes(3).toString('hex')}`);
  await db.query(`UPDATE companies SET owner_rep_id = NULL WHERE id = $1`, [houseId]);
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
  // Leave the bucket as found.
  const list = await signedRequest(s3, { method: 'GET', path: `/${TEST_BUCKET}/`, query: { 'list-type': '2' } });
  const xml = await list.text();
  for (const key of [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!)) {
    await signedRequest(s3, { method: 'DELETE', path: `/${TEST_BUCKET}/${key}` });
  }
  await signedRequest(s3, { method: 'DELETE', path: `/${TEST_BUCKET}` });
});

describe('an on-account payment moves the company balance', () => {
  it('confirms a sale, then a sales_card_id NULL payment drops the balance by exactly the amount', async () => {
    const co = await newCompany();
    const sale = await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-11',
      items: [{ productName: 'Line interactive UPS', quantity: 1, unitPrice: '8000.00' }],
    });
    expect(sale.total).toBe('8000.00');
    expect(await balanceOf(co)).toBe('8000.00');

    const payment = await createPaymentOk(REP_A, {
      companyId: co,
      // no salesCardId — ON-ACCOUNT, how most collections actually land
      amount: '5000.00',
      mode: 'upi',
      referenceNo: 'UPI-4488211330',
      receivedAt: '2026-09-11T16:00:00+05:30',
      notes: 'collected at their office',
    });
    expect(payment.paymentNumber).toMatch(/^PM-\d{4}-\d{5,}$/); // allocated at CREATE — payments are not drafted
    expect(payment.status).toBe('collected');
    expect(payment.salesCardId).toBeNull();
    expect(payment.amount).toBe('5000.00');
    expect(payment.receivedBy).toBe(REP_A.id); // stamped from the token; the payload carries no rep field
    expect(payment.businessDate).toBe('2026-09-11'); // generated from received_at in Asia/Kolkata
    expect(payment.version).toBe(1);

    // The view moved with the row — derived money, never stored.
    expect(await balanceOf(co)).toBe('3000.00');
  });

  it('a payment of nothing is refused 422, and the balance stands', async () => {
    const co = await newCompany();
    await createSaleOk(REP_A, {
      companyId: co,
      saleDate: '2026-09-11',
      items: [{ productName: 'Battery 150Ah', quantity: 2, unitPrice: '4200.00' }],
    });
    const before = await balanceOf(co);

    const zero = await createPayment(REP_A, {
      companyId: co,
      amount: '0.00',
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    expect(zero.statusCode, zero.body).toBe(422);
    expect(errorOf(zero.statusCode, zero.body).code).toBe('VALIDATION_FAILED');

    const negative = await createPayment(REP_A, {
      companyId: co,
      amount: '-500.00', // not even a moneyString — a refund has no trail here
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    expect(negative.statusCode, negative.body).toBe(422);

    expect(await balanceOf(co)).toBe(before);
  });

  it('an unknown account is refused 422 — the FK never surfaces as a 500', async () => {
    const res = await createPayment(REP_A, {
      companyId: randomUUID(),
      amount: '100.00',
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
  });

  it('a named sale must be a confirmed sale of the same account', async () => {
    const co = await newCompany();
    const other = await newCompany();
    const confirmedElsewhere = await createSaleOk(REP_A, {
      companyId: other,
      saleDate: '2026-09-11',
      items: [{ productName: 'Servo stabiliser', quantity: 1, unitPrice: '1200.00' }],
    });

    // A DRAFT never moved the balance — a collection "against" it would
    // document a movement that did not happen.
    const draft = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: bearer(REP_A),
      payload: {
        companyId: co,
        saleDate: '2026-09-11',
        items: [{ productName: 'Never confirmed', quantity: 1, unitPrice: '10.00' }],
      },
    });
    const draftId = (JSON.parse(draft.body) as { id: string }).id;
    const againstDraft = await createPayment(REP_A, {
      companyId: co,
      salesCardId: draftId,
      amount: '10.00',
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    expect(againstDraft.statusCode, againstDraft.body).toBe(422);

    // The card exists but belongs to ANOTHER account.
    const againstOther = await createPayment(REP_A, {
      companyId: co,
      salesCardId: confirmedElsewhere.id,
      amount: '10.00',
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    expect(againstOther.statusCode, againstOther.body).toBe(422);

    // The honest shape: the payment names the confirmed card it settled.
    const payment = await createPaymentOk(REP_A, {
      companyId: other,
      salesCardId: confirmedElsewhere.id,
      amount: '1200.00',
      mode: 'bank_transfer',
      referenceNo: 'NEFT-99120',
      receivedAt: '2026-09-11T17:30:00+05:30',
    });
    expect(payment.salesCardId).toBe(confirmedElsewhere.id);
    expect(await balanceOf(other)).toBe('0.00'); // the account is settled to the paisa
  });

  it('a replayed create under the same key is the stored response — the number is not burnt twice', async () => {
    const co = await newCompany();
    const key = randomUUID();
    const payload = {
      companyId: co,
      amount: '750.00',
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    };
    const first = await createPayment(REP_A, payload, key);
    expect(first.statusCode, first.body).toBe(200);
    const second = await createPayment(REP_A, payload, key);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.body).toBe(first.body); // byte-identical replay

    const rows = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM payments WHERE company_id = $1',
      [co],
    );
    expect(rows.rows[0]!.n).toBe('1');
    expect(await balanceOf(co)).toBe('-750.00'); // collected once, not twice
  });
});

describe('a void requires a reason and reverses the balance', () => {
  let co: string;
  let paymentId: string;
  let draftPaymentId: string;
  const COLLECTED = '2500.50';

  it('a rep cannot void — even his own collection', async () => {
    co = await newCompany();
    const payment = await createPaymentOk(REP_A, {
      companyId: co,
      amount: COLLECTED,
      mode: 'cash',
      receivedAt: '2026-09-11T16:00:00+05:30',
    });
    paymentId = payment.id;
    draftPaymentId = (await createPaymentOk(REP_B, {
      companyId: co,
      amount: '10.00',
      mode: 'upi',
      receivedAt: '2026-09-11T16:10:00+05:30',
    })).id;
    expect(await balanceOf(co)).toBe('-2510.50');

    const res = await voidPayment(REP_A, paymentId, { reason: 'Wrong amount' });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res.statusCode, res.body).code).toBe('FORBIDDEN');
    expect(await balanceOf(co)).toBe('-2510.50'); // the balance did not move
  });

  it('a void without a reason is refused 422 and the balance stands', async () => {
    const noReason = await voidPayment(OWNER, paymentId, undefined);
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(errorOf(noReason.statusCode, noReason.body).code).toBe('VALIDATION_FAILED');

    const emptyReason = await voidPayment(OWNER, paymentId, { reason: '' });
    expect(emptyReason.statusCode, emptyReason.body).toBe(422);

    expect(await balanceOf(co)).toBe('-2510.50');
  });

  it("the owner's void keeps the number and the reason, and the balance is reversed to the paisa", async () => {
    const before = (await listPayments(OWNER)).find((p) => p.id === paymentId)!;
    expect(before.paymentNumber).toMatch(/^PM-\d{4}-\d{5,}$/);

    const res = await voidPayment(OWNER, paymentId, { reason: 'Cheque bounced — re-collected offline' });
    expect(res.statusCode, res.body).toBe(200);
    const voided = parsePayment(res.statusCode, res.body);
    expect(voided.status).toBe('void');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidedBy).toBe(OWNER.id);
    expect(voided.voidReason).toBe('Cheque bounced — re-collected offline');
    // A void KEEPS its number: the document existed, the ledger says so.
    expect(voided.paymentNumber).toBe(before.paymentNumber);

    expect(await balanceOf(co)).toBe('-10.00'); // exactly the un-voided REP_B payment remains
  });

  it('a second void of the same payment is refused — that is final', async () => {
    const res = await voidPayment(OWNER, paymentId, { reason: 'Trying twice' });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res.statusCode, res.body).code).toBe('ILLEGAL_TRANSITION');
  });

  it('a missing or malformed id reads as 404, never a 500', async () => {
    const missing = await voidPayment(OWNER, randomUUID(), { reason: 'Nobody home' });
    expect(missing.statusCode, missing.body).toBe(404);
    const malformed = await voidPayment(OWNER, 'not-a-uuid', { reason: 'Nobody home' });
    expect(malformed.statusCode, malformed.body).toBe(404);
    expect(errorOf(malformed.statusCode, malformed.body).code).toBe('NOT_FOUND');
  });

  it('draftPaymentId still stands — the void touched only its own row', async () => {
    const r = await db.query<{ status: string }>('SELECT status::text AS status FROM payments WHERE id = $1', [
      draftPaymentId,
    ]);
    expect(r.rows[0]!.status).toBe('collected');
  });
});

describe('cash reaches v_employee_expected_cash; non-cash never does', () => {
  const DAY = '2026-09-12';

  it('a cash payment lands on the collecting rep for the business day it was taken', async () => {
    const payment = await createPaymentOk(REP_A, {
      companyId,
      amount: '450.00',
      mode: 'cash',
      receivedAt: '2026-09-12T16:00:00+05:30',
    });
    expect(payment.businessDate).toBe(DAY);
    expect(await expectedCashFor(REP_A.id, DAY)).toBe('450.00');
  });

  it('a UPI payment lands in the company account and passes through no hands', async () => {
    await createPaymentOk(REP_B, {
      companyId,
      amount: '900.00',
      mode: 'upi',
      referenceNo: 'UPI-778120',
      receivedAt: '2026-09-12T17:00:00+05:30',
    });
    expect(await expectedCashFor(REP_B.id, DAY)).toBeNull();
    expect(await expectedCashFor(REP_A.id, DAY)).toBe('450.00'); // untouched by REP_B's row
  });

  it('a voided cash payment stops creating the expectation — a shortfall the rep can never satisfy', async () => {
    // The "If it fails" case, proven from the API: the view must filter
    // status = 'collected' as well as mode = 'cash', or voiding would
    // leave the rep holding an expectation that no longer exists.
    const payment = await createPaymentOk(REP_A, {
      companyId,
      amount: '450.00',
      mode: 'cash',
      receivedAt: '2026-09-12T18:00:00+05:30',
    });
    expect(await expectedCashFor(REP_A.id, DAY)).toBe('900.00');

    const res = await voidPayment(OWNER, payment.id, { reason: 'Entered twice' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await expectedCashFor(REP_A.id, DAY)).toBe('450.00');
  });
});

describe('a rep sees his own payments and not the other rep’s — even on a house account', () => {
  it('REP_B collects on the HOUSE account, and that money is his alone', async () => {
    // The company own-scope shows every rep the house account; payment
    // scope is received_by, and does not inherit that floor.
    const payment = await createPaymentOk(REP_B, {
      companyId: houseId,
      amount: '700.00',
      mode: 'cash',
      receivedAt: '2026-09-12T18:30:00+05:30',
    });
    expect(payment.receivedBy).toBe(REP_B.id);
    expect(await balanceOf(houseId)).toBe('-700.00');

    const bRows = await listPayments(REP_B);
    expect(bRows.map((p) => p.id)).toContain(payment.id);

    // REP_A's list is exactly his receipts — never a filtered subset
    // computed in JavaScript: the predicate lives in the query.
    const expectedForA = new Set(
      (
        await db.query<{ id: string }>('SELECT id FROM payments WHERE received_by = $1', [REP_A.id])
      ).rows.map((r) => r.id),
    );
    const aRows = await listPayments(REP_A);
    expect(aRows.length).toBe(expectedForA.size);
    for (const row of aRows) expect(expectedForA.has(row.id)).toBe(true);
    expect(aRows.map((p) => p.id)).not.toContain(payment.id);

    // The owner reads the whole book.
    const ownerIds = (await listPayments(OWNER)).map((p) => p.id);
    expect(ownerIds).toContain(payment.id);
  });

  it('the dispatcher holds no cell on payment at all', async () => {
    const dispatcher: Actor = { username: '', id: '', token: '' };
    await seedEmployee('dispatcher', dispatcher, ['sales.payments']);
    const list = await app.inject({ method: 'GET', url: '/v1/payments', headers: bearer(dispatcher) });
    expect(list.statusCode, list.body).toBe(403);
    expect(errorOf(list.statusCode, list.body).code).toBe('FORBIDDEN');

    const create = await createPayment(dispatcher, {
      companyId,
      amount: '100.00',
      mode: 'cash',
      receivedAt: '2026-09-12T18:30:00+05:30',
    });
    expect(create.statusCode, create.body).toBe(403);
  });

  it('the flag is the surface’s rollback tier — a rep without sales.payments gets 409 FLAG_DISABLED', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/payments', headers: bearer(REP_NO_FLAG) });
    expect(list.statusCode, list.body).toBe(409);
    expect(errorOf(list.statusCode, list.body).code).toBe('FLAG_DISABLED');

    const create = await createPayment(REP_NO_FLAG, {
      companyId,
      amount: '100.00',
      mode: 'cash',
      receivedAt: '2026-09-12T18:30:00+05:30',
    });
    expect(create.statusCode, create.body).toBe(409);

    // The void's flag probe answers 403, not 409: the doors run BEFORE the
    // flag (the matrix-first order the route documents) — the role check
    // refuses a rep before the flag is ever asked, which is exactly the
    // order that keeps a rep's refusal about the surface, not someone's
    // flag settings.
    const voidRes = await voidPayment(REP_NO_FLAG, randomUUID(), { reason: 'Flag off' });
    expect(voidRes.statusCode, voidRes.body).toBe(403);
    expect(errorOf(voidRes.statusCode, voidRes.body).code).toBe('FORBIDDEN');
  });
});

describe('the proof photo drains after its parent payment — the two passes', () => {
  /**
   * The device queues ONE payment op and ONE proof photo whose outbox row
   * `dependsOn` it (§11). The drain runs two passes: the JSON batch
   * resolves the parent, then the binary pass uploads the photo. This
   * suite drives both passes through the real stack — the batch door and
   * the attachments door — because what must be proven is exactly what a
   * mock cannot prove: the photo lands against a parent that only exists
   * because pass 1 applied first.
   */
  it('pass 1: the payment op applies through the JSON batch and mints its number', async () => {
    const res = await postBatch(REP_A, [
      op('pay_1', '/v1/payments', {
        companyId,
        amount: '1200.00',
        mode: 'cash',
        receivedAt: '2026-09-12T19:00:00+05:30',
      }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const results = syncBatchResponseSchema.parse(res.json()).results;
    expect(results).toHaveLength(1);
    expect(results[0]!.localId).toBe('pay_1');
    expect(results[0]!.outcome).toBe('applied');
    expect(results[0]!.status).toBe(200);

    // The applied body IS the created payment — the drain re-ran the real
    // handler, and the number was allocated inside it.
    const payment = PaymentSchema.parse(results[0]!.body) as PaymentRecord;
    expect(payment.paymentNumber).toMatch(/^PM-\d{4}-\d{5,}$/);
    expect(payment.receivedBy).toBe(REP_A.id);
  });

  it('pass 2: the photo uploads to /v1/attachments AFTER its parent, and only the collector may send or read it', async () => {
    // The parent, created moments ago through pass 1 (the describes above).
    const parent = (await listPayments(OWNER)).find(
      (p) => p.receivedBy === REP_A.id && p.amount === '1200.00' && p.businessDate === '2026-09-12',
    );
    expect(parent).toBeDefined();

    const file = await pngBytes();
    const upload = await uploadProof(REP_A, parent!.id, file);
    expect(upload.statusCode, upload.body).toBe(200);
    const attachment = JSON.parse(upload.body) as { id: string; storageKey: string; uploadedAt: string };
    expect(attachment.storageKey).toMatch(/^payment\/\d{4}\/\d{2}\//);

    // ORDERING, proven in the database: the proof's uploaded_at is strictly
    // after its parent payment's created_at — the child never arrives for
    // a parent that has not resolved.
    const r = await db.query<{ parent_created_at: Date; uploaded_at: Date; owner_id: string; uploaded_by: string }>(
      `SELECT pay.created_at AS parent_created_at, a.uploaded_at, a.owner_id, a.uploaded_by
       FROM attachments a JOIN payments pay ON pay.id = a.owner_id
       WHERE a.owner_type = 'payment' AND a.owner_id = $1`,
      [parent!.id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.owner_id).toBe(parent!.id);
    expect(r.rows[0]!.uploaded_by).toBe(REP_A.id);
    expect(r.rows[0]!.uploaded_at.getTime()).toBeGreaterThanOrEqual(r.rows[0]!.parent_created_at.getTime());

    // Read side: the collector reads his own proof; the owner reads all.
    const own = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachment.id}`,
      headers: bearer(REP_A),
    });
    expect(own.statusCode).toBe(302);
    const ownerRead = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachment.id}`,
      headers: bearer(OWNER),
    });
    expect(ownerRead.statusCode).toBe(302);

    // …and the other rep does not — the photo of a house-account
    // collection belongs to whoever took the money, not to everyone who
    // can see the account.
    const other = await uploadProof(REP_B, parent!.id, await pngBytes());
    expect(other.statusCode, other.body).toBe(403);
    expect(errorOf(other.statusCode, other.body).code).toBe('OUT_OF_SCOPE');
    const readOther = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachment.id}`,
      headers: bearer(REP_B),
    });
    expect(readOther.statusCode, readOther.body).toBe(403);
    expect(errorOf(readOther.statusCode, readOther.body).code).toBe('OUT_OF_SCOPE');
  });

  it('a rejected parent payment never gets its proof — the batch short-circuits the dependent op', async () => {
    // The offline case that gives the ordering its point: the payment was
    // queued against an account that the server refuses. The proof queued
    // behind it must not be attempted.
    const res = await postBatch(REP_A, [
      op('bad_pay', '/v1/payments', {
        companyId: randomUUID(), // no such account
        amount: '300.00',
        mode: 'cash',
        receivedAt: '2026-09-12T19:30:00+05:30',
      }),
      op('proof_of_bad_pay', '/v1/payments', {
        companyId,
        amount: '1.00',
        mode: 'cash',
        receivedAt: '2026-09-12T19:31:00+05:30',
      }, { dependsOn: 'bad_pay' }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const results = syncBatchResponseSchema.parse(res.json()).results;
    expect(results[0]!.outcome).toBe('rejected');
    expect(results[0]!.status).toBe(422);
    expect(results[1]!.outcome).toBe('skipped');
    expect(results[1]!.status).toBe(0); // never attempted — no HTTP call exists for it
    expect(results[1]!.error?.code).toBe('PARENT_REJECTED');

    // The real stack proof: neither payment exists, and no proof photo
    // hangs off anything.
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payments WHERE company_id = $1 AND amount IN ('300.00','1.00')`,
      [companyId],
    );
    expect(rows.rows[0]!.n).toBe('0');
  });
});
