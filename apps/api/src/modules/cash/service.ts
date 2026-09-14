import type {
  CashAmendRequest,
  CashConfirmRequest,
  CashDeclareRequest,
  CashDisputeRequest,
  CashHandover,
  CashQueueQuery,
  CashQueueResponse,
  CashQueueRow,
  CashReopenRequest,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import * as repo from './repo.js';

/**
 * Cash handover service (PLAN-BACKEND.md §10): the employee's declaration,
 * correction and history (PHASE-1-TECHNICIAN.md T1.11), plus the owner's
 * queue, confirm, dispute and reopen (PHASE-4-OWNER.md T4.2).
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
 * **The withheld figure.** Nothing on the employee's side reads
 * `expected_cash` — he declares what he is handing over, and the system's
 * expectation is the check. Showing him the answer first turns a
 * reconciliation into a form-fill. The owner's half (Phase 4, T4.2,
 * below) is where that ends: the queue IS the expectation beside the
 * declaration.
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
/** §10 owner actions: only a `submitted` day can be answered for the first time. */
const ALREADY_ANSWERED_MESSAGE = 'This day has already been confirmed or disputed — reopen it first.';
const STILL_OPEN_MESSAGE = 'This day is still open — reopen applies to a confirmed or disputed day.';

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

  // ── the owner's half (Phase 4, T4.2) ──────────────────────────────────────

  /** row → wire mapper for one queue row; returns exactly `cashQueueRowSchema`'s keys. */
  function toQueueRow(row: repo.QueueRow): CashQueueRow {
    return {
      declarationId: row.declaration_id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      role: row.role,
      businessDate: row.business_date,
      expectedCash: row.expected_cash,
      declaredAmount: row.declared_amount,
      declaredAt: row.declared_at === null ? null : row.declared_at.toISOString(),
      status: row.declaration_status,
      note: row.employee_note,
      variance: row.variance,
      flag: row.flag,
    };
  }

  /**
   * GET /v1/cash/queue — the owner's reconciliation queue (§10). Default:
   * the last 14 days ending YESTERDAY, all flags, `missing_submission`
   * sorted first regardless of date. Ending yesterday because today's
   * figures are not final: a completion that syncs the next morning
   * leaves its day flagged `no_expected_cash` for a few hours, and an
   * owner who learns the flags lie on the current day discounts them
   * everywhere. Today stays reachable — explicitly, via `to` — and the
   * response carries `today` so the client can caption those rows
   * "still syncing" instead of letting the flags lie.
   *
   * A range that hides a `missing_submission` day is the failure the
   * brief names: the WHERE clause runs on the DATE SPAN only, and the
   * view's FULL OUTER JOIN supplies the rows.
   */
  async function queue(filters: CashQueueQuery): Promise<CashQueueResponse> {
    const defaults = await repo.queueDateDefaults(getPool());
    const to = filters.to ?? defaults.to;
    const from = filters.from ?? defaults.from;
    if (from > to) {
      // YYYY-MM-DD compares lexicographically as a date does.
      throw new AppError('VALIDATION_FAILED', 'The start of the range must not be after its end.');
    }
    const rows = await repo.queueRows(getPool(), {
      from,
      to,
      flags: filters.flags,
      role: filters.role,
    });
    return { today: defaults.today, from, to, rows: rows.map(toQueueRow) };
  }

  /**
   * POST /v1/cash/handovers/:id/confirm (§10). The owner's figure may
   * differ from the declaration on purpose — he confirms what was
   * actually handed over after looking at the variance, and both figures
   * stay stored. One locked row; only a `submitted` day can be answered,
   * so a row already confirmed or disputed is refused before anything is
   * written.
   */
  async function confirm(actor: CashActor, handoverId: string, body: CashConfirmRequest): Promise<CashQueueRow> {
    return withTransaction(async (client) => {
      const row = await repo.lockById(client, handoverId);
      if (row === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (row.status !== 'submitted') {
        throw new AppError('ILLEGAL_TRANSITION', ALREADY_ANSWERED_MESSAGE);
      }
      await repo.confirmDeclaration(client, handoverId, body.confirmedAmount, actor.id);
      const refreshed = await repo.queueRowFor(client, row.employee_id, row.business_date);
      if (refreshed === null) {
        // The declaration row exists (it is locked), so its queue row must;
        // this is a broken view, not an owner's bad afternoon.
        throw new AppError('INTERNAL', 'The confirmed day could not be read back.');
      }
      return toQueueRow(refreshed);
    });
  }

  /**
   * POST /v1/cash/handovers/:id/dispute (§10) — the note is required at
   * the schema, and the DB CHECK `cash_disputed_justified` is the
   * backstop: a dispute without the owner's note is not a dispute he can
   * act on tomorrow.
   */
  async function dispute(actor: CashActor, handoverId: string, body: CashDisputeRequest): Promise<CashQueueRow> {
    return withTransaction(async (client) => {
      const row = await repo.lockById(client, handoverId);
      if (row === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (row.status !== 'submitted') {
        throw new AppError('ILLEGAL_TRANSITION', ALREADY_ANSWERED_MESSAGE);
      }
      await repo.disputeDeclaration(client, handoverId, body.ownerNote, actor.id);
      const refreshed = await repo.queueRowFor(client, row.employee_id, row.business_date);
      if (refreshed === null) {
        throw new AppError('INTERNAL', 'The disputed day could not be read back.');
      }
      return toQueueRow(refreshed);
    });
  }

  /**
   * POST /v1/cash/handovers/:id/reopen (§10) — owner only, reason
   * required, audited, and deliberately a second action rather than a
   * flag on the amend call: confirmation is where money stops being
   * provisional, and reversing it should feel like a decision. A
   * `submitted` row has nothing to reverse — it is still open.
   */
  async function reopen(actor: CashActor, handoverId: string, body: CashReopenRequest): Promise<CashQueueRow> {
    return withTransaction(async (client) => {
      const row = await repo.lockForReopen(client, handoverId);
      if (row === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (row.status === 'submitted') {
        throw new AppError('ILLEGAL_TRANSITION', STILL_OPEN_MESSAGE);
      }
      await repo.reopenDeclaration(client, handoverId, actor.id, body.reason);
      // What the reversal unwinds goes to the audit trail with the reason
      // — the whole point of the row is to show, later, what was signed
      // off and why it stopped being signed off.
      await repo.insertReopenAudit(client, {
        handoverId,
        employeeId: row.employee_id,
        actorId: actor.id,
        businessDate: row.business_date,
        previousStatus: row.status,
        confirmedAmount: row.confirmed_amount,
        ownerNote: row.owner_note,
        reason: body.reason,
      });
      const refreshed = await repo.queueRowFor(client, row.employee_id, row.business_date);
      if (refreshed === null) {
        throw new AppError('INTERNAL', 'The reopened day could not be read back.');
      }
      return toQueueRow(refreshed);
    });
  }

  return { declare, amend, history, queue, confirm, dispute, reopen };
}

export type CashService = ReturnType<typeof createCashService>;
