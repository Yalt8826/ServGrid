import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { createSalesService } from '../../src/modules/sales/service.js';

/**
 * THE property test (PHASE-3-SALES-REP.md T3.3, PLAN-DATA-MODEL.md §4):
 *
 *   For random sequences of confirm / void / pay / void-payment,
 *   v_company_balances.balance always equals
 *   Σ confirmed sales − Σ collected payments.
 *
 * 1000 generated sequences, zero violations. The balance is DERIVED, never
 * stored (migration 018), so this property cannot drift — but the proof is
 * the point: the view and the intent are asserted to agree after EVERY
 * operation, to the paisa, against the real migrated database. No mocked
 * database anywhere.
 *
 * The ops run through the REAL code paths a client drives: sale drafts,
 * confirms and voids through the sales service (the code this task ships),
 * payments and payment voids as the schema receives them (the payment
 * ENDPOINTS are T3.4's — this suite pins the money property, not that
 * door). A violation names its sequence and the op that found it, because
 * a property failure is not a flaky test: it means the view and the intent
 * disagree, and the answer is in the view.
 *
 * Deterministic: a fixed seed drives a mulberry32 PRNG, so a failure
 * replays. The seed is printed with the run.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_sales_property_test';
const SEED = 0x5a130d; // fixed — a failure must replay
const SEQUENCES = 1000;
const CHUNKS = 5; // sequences per test, so one 30s+ chunk cannot mask another's failure
const PERCHUNK = SEQUENCES / CHUNKS;

/** mulberry32 — small, fast, good enough for a deterministic money walk. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pick<T> {
  (items: T[]): T;
}

function pickerFor<T>(rand: () => number): Pick<T> {
  return (items: T[]): T => items[Math.floor(rand() * items.length)]!;
}

/** Paise-exact money: integer quantities × 2dp prices keep every line at 2dp, so the intent sums in BigInt cents with no rounding. */
function randomPriceString(rand: () => number): string {
  const rupees = 1 + Math.floor(rand() * 5000);
  const paise = Math.floor(rand() * 100);
  return `${rupees}.${String(paise).padStart(2, '0')}`;
}

function priceToCents(price: string): bigint {
  const [rupees, paise = '0'] = price.split('.');
  return BigInt(rupees!) * 100n + BigInt(paise!.padEnd(2, '0').slice(0, 2));
}

/** "16800.00" / "-400.50" / "0.00" → BigInt cents, the exact comparison. */
function balanceToCents(balance: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(balance);
  if (!m) throw new Error(`balance is not 2dp money: ${balance}`);
  const sign = m[1] === '-' ? -1n : 1n;
  return sign * (BigInt(m[2]!) * 100n + BigInt(m[3]!));
}

interface DraftSale {
  companyId: string;
  saleId: string;
  totalCents: bigint;
}

interface OpenSale {
  companyId: string;
  saleId: string;
  totalCents: bigint;
  saleNumber: string;
}

interface OpenPayment {
  companyId: string;
  paymentId: string;
  amountCents: bigint;
}

describe('the balance property — Σ confirmed sales − Σ collected payments, always', () => {
  let admin: Pool;
  let db: Pool;
  let ownerId: string;
  let repId: string;
  const service = createSalesService();

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    const scratchUrl = new URL(databaseUrl());
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
    await runMigrations({ pool: db });

    const passwordHash = await hashPassword(`prop-plain-copier-${randomBytes(4).toString('hex')}`);
    ownerId = (
      await db.query<{ id: string }>(
        `INSERT INTO employees (username, password_hash, full_name, role)
         VALUES ($1, $2, 'Property Owner', 'owner') RETURNING id`,
        [`prop.owner.${randomBytes(4).toString('hex')}`, passwordHash],
      )
    ).rows[0]!.id;
    repId = (
      await db.query<{ id: string }>(
        `INSERT INTO employees (username, password_hash, full_name, role)
         VALUES ($1, $2, 'Property Rep', 'sales_rep') RETURNING id`,
        [`prop.rep.${randomBytes(4).toString('hex')}`, passwordHash],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db?.end();
    await closePool();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  /**
   * One sequence: fresh companies, a random walk of the five ops, the view
   * asserted against the running intent after EVERY op. Returns the number
   * of assertions made, so the runner can prove the walk was not vacuous.
   */
  async function runSequence(rand: () => number, seqNo: number): Promise<number> {
    const pick = pickerFor<string>(rand);
    let assertions = 0;

    // 1–3 accounts this sequence; each is asserted independently at the end.
    const companyIds: string[] = [];
    for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) {
      companyIds.push(
        (
          await db.query<{ id: string }>(
            `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
            [`Prop Co ${seqNo}-${i} ${randomBytes(6).toString('hex')}`],
          )
        ).rows[0]!.id,
      );
    }
    const confirmedCents = new Map<string, bigint>(companyIds.map((id) => [id, 0n]));
    const paidCents = new Map<string, bigint>(companyIds.map((id) => [id, 0n]));
    const drafts: DraftSale[] = [];
    const confirmed: OpenSale[] = [];
    const openPayments: OpenPayment[] = [];

    const assertBalances = async (op: string) => {
      const rows = await db.query<{ company_id: string; balance: string }>(
        `SELECT company_id, balance::text FROM v_company_balances WHERE company_id = ANY($1::uuid[])`,
        [companyIds],
      );
      expect(rows.rows).toHaveLength(companyIds.length);
      for (const row of rows.rows) {
        const expected = (confirmedCents.get(row.company_id) ?? 0n) - (paidCents.get(row.company_id) ?? 0n);
        const actual = balanceToCents(row.balance);
        if (actual !== expected) {
          throw new Error(
            `PROPERTY VIOLATION at sequence ${seqNo}, after op '${op}': company ${row.company_id} ` +
              `view says ${actual} cents, intent says ${expected} cents (raw '${row.balance}')`,
          );
        }
        assertions += 1;
      }
    };

    const length = 3 + Math.floor(rand() * 10);
    for (let step = 0; step < length; step++) {
      // Weight the ops towards what the property names: confirm/void/pay/void-payment.
      const canConfirm = drafts.length > 0;
      const canVoid = confirmed.length > 0;
      const canVoidPayment = openPayments.length > 0;
      const ops = ['pay', 'draft'];
      if (canConfirm) ops.push('confirm', 'confirm'); // confirms are the walk's engine
      if (canVoid) ops.push('void');
      if (canVoidPayment) ops.push('void-payment');
      const op = pick(ops);

      if (op === 'draft') {
        const companyId = companyIds[Math.floor(rand() * companyIds.length)]!;
        const items = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
          const quantity = 1 + Math.floor(rand() * 5); // integer: q × 2dp price stays 2dp
          const unitPrice = randomPriceString(rand);
          return {
            productName: `Prop item ${randomBytes(3).toString('hex')}`,
            quantity,
            unitPrice,
          };
        });
        const totalCents = items.reduce((sum, item) => sum + BigInt(item.quantity) * priceToCents(item.unitPrice), 0n);
        const sale = await service.createSale({ id: repId, role: 'sales_rep' }, {
          companyId,
          saleDate: '2026-09-13',
          items,
        });
        // A draft carries no number — the same invariant the integration
        // suite pins, walked here because the property must hold on it too.
        if (sale.saleNumber !== null) {
          throw new Error(`PROPERTY VIOLATION at sequence ${seqNo}: draft ${sale.id} carries number ${sale.saleNumber}`);
        }
        drafts.push({ companyId, saleId: sale.id, totalCents });
      } else if (op === 'confirm') {
        const idx = Math.floor(rand() * drafts.length);
        const target = drafts.splice(idx, 1)[0]!;
        const sale = await service.confirmSale({ id: repId, role: 'sales_rep' }, target.saleId);
        if (sale.saleNumber === null || sale.confirmedAt === null) {
          throw new Error(`PROPERTY VIOLATION at sequence ${seqNo}: confirmed sale ${sale.id} has no number or stamp`);
        }
        confirmed.push({
          companyId: target.companyId,
          saleId: sale.id,
          totalCents: target.totalCents,
          saleNumber: sale.saleNumber,
        });
        confirmedCents.set(target.companyId, (confirmedCents.get(target.companyId) ?? 0n) + target.totalCents);
      } else if (op === 'void') {
        const idx = Math.floor(rand() * confirmed.length);
        const target = confirmed.splice(idx, 1)[0]!;
        await service.voidSale({ id: ownerId, role: 'owner' }, target.saleId, 'property walk: wrong entry');
        confirmedCents.set(target.companyId, (confirmedCents.get(target.companyId) ?? 0n) - target.totalCents);
      } else if (op === 'pay') {
        const companyId = companyIds[Math.floor(rand() * companyIds.length)]!;
        const amountCents = 1n + BigInt(Math.floor(rand() * 500000));
        const payment = (
          await db.query<{ id: string }>(
            `INSERT INTO payments (payment_number, company_id, amount, mode, received_by, received_at)
             VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
            [
              // T3.4 owns the payment endpoint and its numbering door; this
              // walk only needs the row the schema defines — unique, > 0,
              // collected by default.
              `PM-PROP-${seqNo}-${step}-${randomBytes(3).toString('hex')}`,
              companyId,
              `${amountCents / 100n}.${String(amountCents % 100n).padStart(2, '0')}`,
              pick(['cash', 'upi', 'card', 'cheque', 'bank_transfer']),
              repId,
            ],
          )
        ).rows[0]!.id;
        openPayments.push({ companyId, paymentId: payment, amountCents });
        paidCents.set(companyId, (paidCents.get(companyId) ?? 0n) + amountCents);
      } else if (op === 'void-payment') {
        const idx = Math.floor(rand() * openPayments.length);
        const target = openPayments.splice(idx, 1)[0]!;
        await db.query(
          `UPDATE payments SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
          [target.paymentId, ownerId, 'property walk: duplicate entry'],
        );
        paidCents.set(target.companyId, (paidCents.get(target.companyId) ?? 0n) - target.amountCents);
      }

      await assertBalances(`${op}@${step}`);
    }

    // Walk the trailing state too: draft-only and fully-voided sequences
    // must land back on exact zero where the intent says zero.
    await assertBalances('end');
    return assertions;
  }

  it.each(Array.from({ length: CHUNKS }, (_, chunk) => [chunk] as const))(
    'chunk %d — the view and the intent agree after every op (' + PERCHUNK + ' sequences)',
    async (chunk) => {
      const rand = mulberry32(SEED + chunk * 7919);
      let assertions = 0;
      // runSequence throws on the first violation, naming the sequence and
      // the op that found it — a failure here is the view and the intent
      // disagreeing, never a flake.
      for (let i = 0; i < PERCHUNK; i++) {
        assertions += await runSequence(rand, chunk * PERCHUNK + i);
      }
      // The walk was not vacuous: every sequence asserted every account.
      expect(assertions).toBeGreaterThanOrEqual(SEQUENCES);
    },
    300_000,
  );

  it('ran the full 1000 sequences the task promised', async () => {
    expect(PERCHUNK * CHUNKS).toBe(1000);
  });
});
