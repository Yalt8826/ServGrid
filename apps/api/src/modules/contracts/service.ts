import type { Contract, ContractJob, ContractListQuery, ContractPatch, ContractCreate, ContractCancel } from '@servgrid/shared';
import type { PoolClient } from 'pg';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { allocateNumber } from '../../lib/sequences.js';
import * as repo from './repo.js';

/**
 * Contracts service (PHASE-2B-CONTRACTS.md T2B.2, PLAN-BACKEND.md §11.1,
 * decision 2026-09-15). The rules the task exists for:
 *
 * **Overlap is the database's refusal, phrased once here.** The pre-check
 * (`findOverlapping`) runs BEFORE a number is allocated, so a refused
 * create burns none of the AMC sequence; the customer row lock held from
 * the top of the transaction serialises every write for that site, so two
 * concurrent creates cannot both pass the check — and the exclusion
 * constraint (`service_contracts_no_overlap`, code 23P01) backstops the
 * race that would remain if the lock were ever dropped.
 *
 * **A renewal is a create.** Inclusive ranges ('[]') mean a term starting
 * the day after the old one ends never overlaps; nothing special-cased.
 *
 * **A linked job is an ordinary job.** Cancelling the AMC or moving its
 * dates never touches the jobs linked to it — they were dispatched under
 * the AMC, they may already be under way, and their assignment,
 * completion and cancellation keep their ordinary paths (the decision
 * record's "Not changed").
 *
 * **No scope predicate.** Only dispatcher and owner sit on this surface
 * and both hold `all` (the routes' `requireAll` 403s everyone else before
 * any query is built), so there is no scope to compose — the list and the
 * point read are whole-table by design, like the jobs desk.
 */

const NOT_FOUND_MESSAGE = "We couldn't find that AMC.";
const NO_CUSTOMER_MESSAGE = "That customer doesn't exist — pick them again from the search.";
const INACTIVE_CUSTOMER_MESSAGE = 'That customer has been removed — an AMC needs an active customer.';
const CANCELLED_MESSAGE = 'This AMC was cancelled — record a new one instead.';
const ALREADY_CANCELLED_MESSAGE = 'This AMC is already cancelled.';
const TERM_ORDERED_MESSAGE = 'The end date cannot be before the start date.';
const VALUE_NON_NEGATIVE_MESSAGE = 'The price cannot be negative.';
const OVERLAP_RACE_MESSAGE = 'Another AMC for this customer was recorded at the same moment — reload and check.';
const PAGE_LINK_MESSAGE = 'That page link is no longer valid — reload the list.';

function overlapMessage(existing: { contract_number: string; start_date: string; end_date: string }): string {
  return `${existing.contract_number} already covers this customer from ${dayLabel(existing.start_date)} to ${dayLabel(existing.end_date)}.`;
}

/**
 * `dayLabel('2027-09-14')` → `14 Sep 2027`. The parts are split literally:
 * routing the string through `new Date()` would render it in the server's
 * timezone, and a `2027-09-14T00:00Z` evening in IST is a different day.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function dayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

interface PgViolation {
  code: string;
  constraint?: string;
}

function isPgViolation(error: unknown): error is PgViolation {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * The CHECK constraints of migration 015, phrased per constraint name. An
 * unknown CHECK rethrows — a sentence invented for the wrong constraint is
 * a lie to the dispatcher.
 */
function checkViolationMessage(error: unknown): string | null {
  if (!isPgViolation(error) || error.code !== '23514') return null;
  switch (error.constraint) {
    case 'service_contracts_term_ordered':
      return TERM_ORDERED_MESSAGE;
    case 'service_contracts_value_non_negative':
      return VALUE_NON_NEGATIVE_MESSAGE;
    default:
      return null;
  }
}

/** The overlap refusal's details carry the existing AMC, so the dispatcher can see WHICH one beat him there. */
function overlapError(existing: repo.OverlappingRow): AppError {
  return new AppError('DUPLICATE_ENTITY', overlapMessage(existing), {
    existing: {
      id: existing.id,
      contractNumber: existing.contract_number,
      startDate: existing.start_date,
      endDate: existing.end_date,
    },
  });
}

function toContract(row: repo.ContractRow): Contract {
  return {
    id: row.id,
    contractNumber: row.contract_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    startDate: row.start_date,
    endDate: row.end_date,
    contractValue: row.contract_value,
    notes: row.notes,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    state: row.state,
    lastServiceDate: row.last_service_date,
    nextVisitDue: row.next_visit_due,
    openJob:
      row.open_job_id === null
        ? null
        : {
            id: row.open_job_id,
            jobNumber: row.open_job_number ?? '',
            scheduledFor: row.open_job_scheduled_for?.toISOString() ?? null,
          },
    daysToEnd: row.days_to_end,
    isVisitDue: row.is_visit_due,
    isEndingSoon: row.is_ending_soon,
    version: row.version,
  };
}

function toContractJob(row: repo.ContractJobRow): ContractJob {
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    status: row.status as ContractJob['status'],
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    assignedToName: row.assigned_to_name,
  };
}

/** base64url is URL-safe and opaque; the payload is the page offset, not a secret (§6.3's cursor). */
function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && 'offset' in parsed) {
      const offset = (parsed as { offset: unknown }).offset;
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
    }
  } catch {
    // fall through: a cursor this app did not mint is a stale list, not a crash
  }
  throw new AppError('VALIDATION_FAILED', PAGE_LINK_MESSAGE);
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * One REPEATABLE READ READ ONLY transaction: the detail's contract and its
 * job list read the same snapshot, so the header never names a job the
 * list below it lacks (the technician work read's shape).
 */
async function withReadSnapshot<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface Actor {
  id: string;
}

export function createContractsService() {
  /** GET /v1/contracts (§11.1) — the envelope { items, nextCursor }. */
  async function listContracts(query: ContractListQuery): Promise<{ items: Contract[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const offset = query.cursor === undefined ? 0 : decodeOffsetCursor(query.cursor);
    const page = await repo.listContracts(getPool(), {
      filter: query.filter,
      customerId: query.customerId,
      state: query.state,
      q: query.q,
      limit,
      offset,
    });
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map(toContract),
      nextCursor: page.hasMore ? encodeOffsetCursor(offset + limit) : null,
    };
  }

  /** GET /v1/contracts/:id (§11.1) — the AMC plus every job linked to it. */
  async function getContract(id: string): Promise<{ contract: Contract; jobs: ContractJob[] }> {
    return withReadSnapshot(async (client) => {
      const row = await repo.findContract(client, id);
      if (row === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      const jobs = await repo.listContractJobs(client, id);
      return { contract: toContract(row), jobs: jobs.map(toContractJob) };
    });
  }

  /**
   * POST /v1/contracts (§11.1) — one transaction: lock the customer, check
   * the overlap, allocate the number, insert. The lock order is always
   * customer first, so concurrent writers for one site queue instead of
   * racing; the overlap verdict is final under it.
   */
  async function createContract(actor: Actor, input: ContractCreate): Promise<Contract> {
    return withTransaction(async (client) => {
      const customer = await repo.lockCustomer(client, input.customerId);
      if (customer === null) throw new AppError('VALIDATION_FAILED', NO_CUSTOMER_MESSAGE);
      if (!customer.is_active) throw new AppError('VALIDATION_FAILED', INACTIVE_CUSTOMER_MESSAGE);

      const existing = await repo.findOverlapping(client, {
        customerId: input.customerId,
        startDate: input.startDate,
        endDate: input.endDate,
        excludeId: null,
      });
      if (existing !== null) throw overlapError(existing);

      // After the overlap check: a refused create burns no number.
      const contractNumber = await allocateNumber('contract', { db: client });

      let id: string;
      try {
        id = await repo.insertContract(client, {
          contractNumber,
          customerId: input.customerId,
          startDate: input.startDate,
          endDate: input.endDate,
          contractValue: input.contractValue,
          notes: input.notes ?? null,
          createdBy: actor.id,
        });
      } catch (error) {
        // 23P01 is the exclusion constraint winning the race the customer
        // lock exists to prevent — same verdict, phrased as the moment it is.
        if (isPgViolation(error) && error.code === '23P01') {
          throw new AppError('DUPLICATE_ENTITY', OVERLAP_RACE_MESSAGE);
        }
        const message = checkViolationMessage(error);
        if (message !== null) throw new AppError('VALIDATION_FAILED', message);
        throw error;
      }

      const row = await repo.findContract(client, id);
      if (row === null) {
        throw new AppError('INTERNAL', 'The AMC could not be read back — nothing was lost, try again.');
      }
      return toContract(row);
    });
  }

  /**
   * PATCH /v1/contracts/:id (§11.1) — under `If-Match`. Changing the dates
   * re-runs the overlap check under the customer lock. A job that falls
   * outside the amended term STAYS LINKED: it was dispatched under the AMC,
   * and unlinking it would rewrite history the job's own record depends on.
   */
  async function patchContract(_actor: Actor, id: string, ifMatch: number, fields: ContractPatch): Promise<Contract> {
    return withTransaction(async (client) => {
      const locked = await repo.lockContract(client, id);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This AMC changed after you opened it — reload it and try again.',
          { currentVersion: locked.version },
        );
      }
      if (locked.cancelled_at !== null) throw new AppError('ILLEGAL_TRANSITION', CANCELLED_MESSAGE);

      const start = fields.startDate ?? locked.start_date;
      const end = fields.endDate ?? locked.end_date;
      if (end < start) throw new AppError('VALIDATION_FAILED', TERM_ORDERED_MESSAGE);

      if (fields.startDate !== undefined || fields.endDate !== undefined) {
        await repo.lockCustomer(client, locked.customer_id);
        const existing = await repo.findOverlapping(client, {
          customerId: locked.customer_id,
          startDate: start,
          endDate: end,
          excludeId: id,
        });
        if (existing !== null) throw overlapError(existing);
      }

      try {
        await repo.updateContract(client, id, fields);
      } catch (error) {
        if (isPgViolation(error) && error.code === '23P01') {
          throw new AppError('DUPLICATE_ENTITY', OVERLAP_RACE_MESSAGE);
        }
        const message = checkViolationMessage(error);
        if (message !== null) throw new AppError('VALIDATION_FAILED', message);
        throw error;
      }

      const row = await repo.findContract(client, id);
      if (row === null) {
        throw new AppError('INTERNAL', 'The AMC could not be read back — nothing was lost, try again.');
      }
      return toContract(row);
    });
  }

  /**
   * POST /v1/contracts/:id/cancel (§11.1) — who and why, never a delete.
   * Open jobs linked to it are not touched: they are ordinary jobs and may
   * already be under way; a new AMC can be recorded over the freed dates.
   */
  async function cancelContract(actor: Actor, id: string, input: ContractCancel): Promise<Contract> {
    return withTransaction(async (client) => {
      const locked = await repo.lockContract(client, id);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.cancelled_at !== null) {
        throw new AppError('ILLEGAL_TRANSITION', ALREADY_CANCELLED_MESSAGE);
      }
      await repo.cancelContract(client, id, { cancelledBy: actor.id, reason: input.reason });
      const row = await repo.findContract(client, id);
      if (row === null) {
        throw new AppError('INTERNAL', 'The AMC could not be read back — nothing was lost, try again.');
      }
      return toContract(row);
    });
  }

  return {
    listContracts,
    getContract,
    createContract,
    patchContract,
    cancelContract,
  };
}

export type ContractsService = ReturnType<typeof createContractsService>;
