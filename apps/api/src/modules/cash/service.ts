import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import * as repo from './repo.js';

/**
 * Cash handover service (PLAN-BACKEND.md §10). The owner's queue, confirm,
 * dispute and reopen are Phase 4; between now and then technicians declare
 * into a table nobody reads — which is correct, because the old process
 * remains the record of truth during parallel run.
 *
 * Three rules this service owns:
 *
 * **The date window.** `businessDate` is bounded — not in the future, not
 * more than 7 days back — against `business_date(now())`, the same IST
 * definition the generated columns use, so the bounds hold no matter what
 * timezone the server boots in.
 *
 * **The correction path.** A technician who types ₹4,500 for ₹45,000 has
 * exactly one route: PATCH his own row while it is `submitted` (§10). He
 * cannot resubmit — the row is unique per (employee, date) — and *reopen*
 * only returns a *confirmed* row to `submitted`, which his already is. Once
 * `confirmed` or `disputed` the PATCH is refused `409
 * RECONCILIATION_CONFIRMED`: correctable until it is signed off, then it
 * takes a deliberate second action (the same rule as completion amendment,
 * §6.2b, at a different door).
 *
 * **The withheld figure.** Nothing here reads `expected_cash` — the
 * employee declares what he is handing over, and the system's expectation
 * is the check. Showing him the answer first turns a reconciliation into a
 * form-fill.
 */

/** Unique-violation SQLSTATE — `cash_reconciliations_employee_date_unique`. */
const UNIQUE_VIOLATION = '23505';
const UNIQUE_CONSTRAINT = 'cash_reconciliations_employee_date_unique';

const DUPLICATE_MESSAGE =
  'You have already declared the cash for this day — amend that declaration instead.';
const NOT_FOUND_MESSAGE = "We couldn't find that declaration.";
const OUT_OF_SCOPE_MESSAGE = 'This declaration belongs to another employee.';
const CONFIRMED_MESSAGE = 'The office has confirmed this day. Ask the owner to reopen it.';
const FUTURE_DATE_MESSAGE = 'The declaration date cannot be in the future.';
const TOO_OLD_DATE_MESSAGE = 'The declaration date cannot be more than 7 days back.';
const VERSION_MESSAGE = 'This record changed after you opened it — reload it and try again.';

/** §10: `businessDate` may reach this many days into the past. */
export const BUSINESS_DATE_MAX_AGE_DAYS = 7;

/** row → wire mapper; returns exactly `CashHandoverSchema`'s keys, nothing else. */
function toHandover(row: repo.HandoverRow): CashHandover {
  return {
    id: row.id,
    businessDate: row.business_date,
    declaredAmount: row.declared_amount,
    note: row.employee_note,
    status: row.status,
    declaredAt: row.declared_at.toISOString(),
    version: row.version,
  };
}

export interface CashActor {
  id: string;
}

export function createCashService() {
  /**
   * POST /v1/cash/handovers — the declaration (§10). The duplicate for a
   * day is caught from the constraint, not pre-checked, so two concurrent
   * declares for the same employee-day cannot both win.
   */
  async function declare(actor: CashActor, input: CashDeclareRequest): Promise<CashHandover> {
    const { today, oldest } = await repo.businessDateBounds(getPool());
    // YYYY-MM-DD compares lexicographically as a date does.
    if (input.businessDate > today) {
      throw new AppError('VALIDATION_FAILED', FUTURE_DATE_MESSAGE);
    }
    if (input.businessDate < oldest) {
      throw new AppError('VALIDATION_FAILED', TOO_OLD_DATE_MESSAGE);
    }

    // The insert joins the request transaction when an Idempotency-Key
    // claimed one (plugins/idempotency.ts), so the declaration and the
    // stored response commit together.
    try {
      const row = await withTransaction((client) =>
        repo.insertDeclaration(client, {
          employeeId: actor.id,
          businessDate: input.businessDate,
          declaredAmount: input.declaredAmount,
          note: input.note ?? null,
        }),
      );
      return toHandover(row);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
        (error as { constraint?: unknown }).constraint === UNIQUE_CONSTRAINT
      ) {
        throw new AppError('DUPLICATE_ENTITY', DUPLICATE_MESSAGE, { businessDate: input.businessDate });
      }
      throw error;
    }
  }

  /**
   * PATCH /v1/cash/handovers/:id — the correction path (§10). One locked
   * row, three refusals in order: not yours (OUT_OF_SCOPE), already signed
   * off (RECONCILIATION_CONFIRMED), stale copy (VERSION_CONFLICT). The
   * prior amount goes to the audit trail inside the same transaction.
   */
  async function amend(
    actor: CashActor,
    handoverId: string,
    ifMatch: number,
    patch: CashAmendRequest,
  ): Promise<CashHandover> {
    return withTransaction(async (client) => {
      const row = await repo.lockById(client, handoverId);
      if (row === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      // The declaring employee, not the role: a technician's matrix cell is
      // `own`, and `own` is decided on the row, here, never on the gate.
      if (row.employee_id !== actor.id) {
        throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      }
      if (row.status !== 'submitted') {
        // Before the version check on purpose: once the owner has acted, the
        // honest answer is "ask him to reopen", not "reload and retry" — a
        // reload will not help, and the copy on the handset is not stale so
        // much as dead.
        throw new AppError('RECONCILIATION_CONFIRMED', CONFIRMED_MESSAGE);
      }
      if (row.version !== ifMatch) {
        throw new AppError('VERSION_CONFLICT', VERSION_MESSAGE, { currentVersion: row.version });
      }

      const updated = await repo.amend(client, handoverId, patch);
      await repo.insertAmendmentAudit(client, {
        handoverId,
        employeeId: row.employee_id,
        actorId: actor.id,
        businessDate: row.business_date,
        previousAmount: row.declared_amount,
        declaredAmount: patch.declaredAmount,
      });
      return toHandover(updated);
    });
  }

  /**
   * GET /v1/cash/handovers/me — own history (§10). Keyed off the token; the
   * request never names an employee, so nobody else's rows are reachable
   * from this endpoint at all.
   */
  async function history(employeeId: string): Promise<CashHandover[]> {
    const rows = await repo.listForEmployee(getPool(), employeeId);
    return rows.map(toHandover);
  }

  return { declare, amend, history };
}

export type CashService = ReturnType<typeof createCashService>;
