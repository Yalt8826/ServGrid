import type { QueryResult, QueryResultRow } from 'pg';
import {
  formatBusinessNumber,
  formatFiscalYear,
  type SequenceScope,
} from '@servgrid/shared';
import { getPool } from '../db/pool.js';

/**
 * Business-number allocation (PLAN-BACKEND.md §2 lib/sequences.ts,
 * PLAN-DATA-MODEL.md §3.9). `allocateNumber('job')` asks the database's
 * atomic `next_in_sequence('job:2627')` for the next bare integer and
 * dresses it as `JC-2627-00042`. The per-fiscal-year reset and the
 * prefix live in the scope key; the padding and prefix live in
 * `@servgrid/shared`'s formatter, so the API cannot drift from what the
 * clients display.
 *
 * The fiscal year comes from the **IST business date**, not the UTC
 * clock: FY starts 1 April, so `2627` is 1 Apr 2026 – 31 Mar 2027. A job
 * created at 19:00 UTC on 31 March belongs to the *next* fiscal year,
 * because it is already 00:30 IST on 1 April.
 *
 * Not gap-free by design (§3.9): a rolled-back transaction still
 * consumed its value, and a gap in job numbers harms nothing.
 */

/** Anything with `.query` — the Pool, or the PoolClient of a caller's transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** IST is UTC+05:30 all year — India has no DST, so a fixed shift is exact. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The fiscal year (short start-year: FY 2026–27 → 26) containing the IST
 * business date of `at`. April onward belongs to the calendar year's FY;
 * January–March belong to the FY started the previous year.
 */
export function fiscalYearFor(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  // Months are 0-based — April is 3.
  const fyStartYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  return fyStartYear % 100;
}

/** The sequences row key: FY 2026–27 jobs allocate from `job:2627` (§3.9). */
export function scopeKey(scope: SequenceScope, fiscalYear: number): string {
  return `${scope}:${formatFiscalYear(fiscalYear)}`;
}

export interface AllocateNumberOptions {
  /**
   * The caller's transaction client, so the consumed value commits or
   * rolls back with the business row it numbers. Defaults to the process
   * pool — correct for a standalone allocation, since `next_in_sequence`
   * is one atomic statement and needs no transaction of its own.
   */
  db?: Db;
  /** The instant the business date is taken from; defaults to now. */
  at?: Date;
}

/**
 * Allocate the next business number for a scope in the fiscal year of
 * the current IST business date: `allocateNumber('job')` → `JC-2627-00042`.
 * The first call for a scope implicitly creates its `sequences` row at 1 —
 * that is the fiscal-year rollover path (PLAN-DATA-MODEL.md §9 open item 5),
 * so a new year needs no migration or seed step.
 */
export async function allocateNumber(
  scope: SequenceScope,
  options: AllocateNumberOptions = {},
): Promise<string> {
  const at = options.at ?? new Date();
  const fiscalYear = fiscalYearFor(at);
  const executor = options.db ?? getPool();
  const result = await executor.query<{ current_value: string }>(
    'SELECT next_in_sequence($1) AS current_value',
    [scopeKey(scope, fiscalYear)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`next_in_sequence('${scopeKey(scope, fiscalYear)}') returned no row`);
  }
  // pg hands bigint back as text; Number() is exact far past any value a
  // five-digit-plus business number reaches.
  return formatBusinessNumber(scope, fiscalYear, Number(row.current_value));
}

/**
 * The API-side name for the shared parser (PHASE-1-TECHNICIAN.md T1.4):
 * `parseSequence('JC-2627-00042')` → `{ prefix: 'JC', fiscalYear: 26, value: 42 }`.
 * The parsing logic and its unit tests live in `@servgrid/shared` next to
 * the formatter, so the two can never disagree.
 */
export { parseBusinessNumber as parseSequence } from '@servgrid/shared';
