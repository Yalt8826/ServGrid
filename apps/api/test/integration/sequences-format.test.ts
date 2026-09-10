import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { prefixForScope, SEQUENCE_SCOPES } from '@servgrid/shared';
import { runMigrations } from '../../src/db/migrate.js';
import {
  allocateNumber,
  fiscalYearFor,
  parseSequence,
  scopeKey,
} from '../../src/lib/sequences.js';

/**
 * Sequence allocation through `allocateNumber` (PHASE-1-TECHNICIAN.md
 * T1.4): the fiscal year comes from the IST business date, the value
 * from the database's atomic `next_in_sequence` (PLAN-DATA-MODEL.md
 * §3.9), and the two meet in `formatBusinessNumber`.
 *
 * Runs against the real Postgres 16 from `docker compose up db` — no
 * mocked database anywhere (PLAN-BACKEND.md §14). Same scratch-database
 * pattern as sequences.test.ts: built from the server's migrations,
 * dropped afterwards.
 *
 * Every boundary instant below is written as an explicit UTC instant so
 * the host timezone cannot influence the result. The trap the task
 * warns about: 1 Apr 2027 00:01 IST is 2027-03-31T18:31Z — the *same
 * UTC date* as the 31 March cases. An implementation that computed the
 * fiscal year in UTC would file it under 2627.
 */

const SCRATCH_DB = 'servgrid_sequences_format_test';

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid'
  );
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/** 31 Mar 2027 23:59 IST — the last minute of FY 2026–27. */
const MAR_31_2359_IST = new Date('2027-03-31T18:29:00Z');
/** 1 Apr 2027 00:01 IST — the first minute of FY 2027–28, same UTC date. */
const APR_1_0001_IST = new Date('2027-03-31T18:31:00Z');
/** 31 Mar 2027 23:30 IST — 18:00Z, still FY 2026–27. */
const MAR_31_UTC_1800 = new Date('2027-03-31T18:00:00Z');
/** 1 Apr 2027 00:30 IST — 19:00Z on the *same UTC date*, next fiscal year. */
const MAR_31_UTC_1900 = new Date('2027-03-31T19:00:00Z');

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
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
});

async function currentValue(scope: string): Promise<number | undefined> {
  const r = await db.query<{ current_value: string }>(
    'SELECT current_value FROM sequences WHERE scope = $1',
    [scope],
  );
  return r.rows[0] === undefined ? undefined : Number(r.rows[0].current_value);
}

describe('fiscal-year boundary — both sides, in IST not UTC', () => {
  it('31 Mar 2027 23:59 IST allocates from job:2627', async () => {
    const number = await allocateNumber('job', { db, at: MAR_31_2359_IST });

    expect(number).toBe('JC-2627-00001');
    await expect(currentValue('job:2627')).resolves.toBe(1);
  });

  it('1 Apr 2027 00:01 IST rolls to job:2728, implicitly created at 1 (§9 open item 5)', async () => {
    // No seed step anywhere for the new fiscal year's scope — the first
    // allocation after rollover must create the row itself and hand
    // back 1.
    const number = await allocateNumber('job', { db, at: APR_1_0001_IST });

    expect(number).toBe('JC-2728-00001');
    await expect(currentValue('job:2728')).resolves.toBe(1);
    // The old year's counter is untouched by the rollover.
    await expect(currentValue('job:2627')).resolves.toBe(1);
  });

  it('two instants on the same UTC date land in different fiscal years', async () => {
    // The task's own worked example: 19:00 UTC on 31 March is already
    // 00:30 IST on 1 April. The 18:00Z call filed under 2627, so this
    // is that scope's second value; the 19:00Z call starts 2728.
    const beforeRollover = await allocateNumber('job', { db, at: MAR_31_UTC_1800 });
    const afterRollover = await allocateNumber('job', { db, at: MAR_31_UTC_1900 });

    expect(beforeRollover).toBe('JC-2627-00002');
    expect(afterRollover).toBe('JC-2728-00002');
  });

  it('fiscalYearFor splits the exact millisecond of IST midnight', async () => {
    // 1 Apr 2027 00:00:00.000 IST == 2027-03-31T18:30:00.000Z.
    expect(fiscalYearFor(new Date('2027-03-31T18:29:59.999Z'))).toBe(26);
    expect(fiscalYearFor(new Date('2027-03-31T18:30:00.000Z'))).toBe(27);
    // Within an FY: opening day and the March end agree.
    expect(fiscalYearFor(new Date('2026-04-01T03:30:00.000Z'))).toBe(26);
    expect(fiscalYearFor(new Date('2027-03-31T12:00:00.000Z'))).toBe(26);
  });
});

describe('five-digit padding and the 100,000th value', () => {
  it('pads the first value of a fresh scope to five digits', async () => {
    const number = await allocateNumber('payment', { db, at: MAR_31_2359_IST });

    // The doc's example is a five-digit field: 1 renders as 00001.
    expect(number).toBe('PM-2627-00001');
  });

  it('the 100,000th allocation does not truncate', async () => {
    // Position sale:2627 at 99,999. The table stores bare integers, so
    // this is one plain upsert — replaying 99,999 real allocations in a
    // statement takes tens of seconds of tuple-waiting for no extra
    // coverage (allocation itself is sequences.test.ts's proving
    // ground). The 100,000th value below still comes from the real
    // allocation path.
    await db.query(
      `INSERT INTO sequences (scope, current_value) VALUES ($1, 99999)
       ON CONFLICT (scope) DO UPDATE SET current_value = 99999, updated_at = now()`,
      [scopeKey('sale', fiscalYearFor(MAR_31_2359_IST))],
    );
    await expect(currentValue('sale:2627')).resolves.toBe(99_999);

    const hundredThousandth = await allocateNumber('sale', { db, at: MAR_31_2359_IST });

    expect(hundredThousandth).toBe('SL-2627-100000');
    const parsed = parseSequence(hundredThousandth);
    expect(parsed?.value).toBe(100_000);
  });
});

describe('parseSequence round-trips every prefix', () => {
  // FY 2028–29: fresh counters, and a second fiscal pair beyond 2627 so
  // the round-trip cannot pass on a hardcoded year.
  const IN_FY_2829 = new Date('2028-06-15T06:00:00Z');

  it.each(SEQUENCE_SCOPES)('%s allocates, formats and parses back', async (scope) => {
    const number = await allocateNumber(scope, { db, at: IN_FY_2829 });

    expect(number).toBe(
      `${prefixForScope(scope)}-2829-00001`,
    );
    expect(parseSequence(number)).toEqual({
      prefix: prefixForScope(scope),
      fiscalYear: 28,
      value: 1,
    });
    // The row behind the formatted number really is the scope we think.
    await expect(currentValue(scopeKey(scope, 28))).resolves.toBe(1);
  });
});
