import {
  canTransition,
  type JobCardDispatcher,
  type JobCardOwner,
  type JobCardTechnician,
  type JobStatus,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import type { RequestSource } from '../../plugins/request-context.js';
import * as repo from './repo.js';

/**
 * Jobs service (PLAN-BACKEND.md §6). The status machine's transition
 * graph is imported from `packages/shared` — never re-implemented here;
 * what the service adds is the §6.1 "who" column and the §6.3 split of
 * *which endpoint carries which row*:
 *
 * | §6.1 row                                    | served by (§6.3)      |
 * |---------------------------------------------|-----------------------|
 * | unassigned → assigned, reassigns            | POST /assign          |
 * | assigned → en_route / in_progress           | POST /:id/status      |
 * | en_route → in_progress                      | POST /:id/status      |
 * | in_progress → completed                     | POST /:id/complete    |
 * | any non-terminal → cancelled                | POST /:id/cancel      |
 *
 * `POST /v1/jobs/:id/status` takes only `{ to, occurredAt }`, so the rows
 * it can carry are exactly the stepper's moves. The graph-legal rows that
 * belong to other endpoints are refused with `409 ILLEGAL_TRANSITION` and
 * a message naming the right door — completion must file the money
 * (§6.2), cancellation must carry a reason (§6.3), assignment must name a
 * technician. A status-only shortcut around any of the three would
 * silently skip the rule that lives in the payload.
 *
 * `en_route` is skippable: `assigned → in_progress` is accepted, because
 * a technician already on site should not have to lie to the app (§6.1).
 */

/** §6.2/§6.3: `occurredAt` may not be in the future nor older than this. */
export const OCCURRED_AT_MAX_AGE_DAYS = 14;

/** Rows the status endpoint carries: (from, to) pairs, §6.1. */
const STATUS_MOVES: ReadonlyArray<{ from: JobStatus; to: JobStatus }> = [
  { from: 'assigned', to: 'en_route' },
  { from: 'assigned', to: 'in_progress' },
  { from: 'en_route', to: 'in_progress' },
];

const FORBIDDEN_MESSAGE = 'You do not have permission to do that.';
const OUT_OF_SCOPE_MESSAGE = 'This job belongs to another technician.';
const NOT_FOUND_MESSAGE = "We couldn't find that job.";
/** §6.3: the status endpoint is "technician (own), owner" — dispatchers assign and cancel, they do not step cards. */
const STATUS_ACTORS_MESSAGE = 'Job status is moved by the technician on site or the owner.';

/** §3.1: the message is shown verbatim — it says what to do, not what failed. */
function refusalMessage(from: JobStatus, to: JobStatus): string {
  if (to === 'completed') {
    return 'Use completion to close a job — it records the work and the amount; moving the card there would not.';
  }
  if (to === 'cancelled') {
    return 'Cancelling needs a reason — cancel the job instead of moving it.';
  }
  if (from === 'unassigned' || to === 'assigned') {
    return 'Assignment and reassignment are done by the office through assign, not by moving the card.';
  }
  if (from === 'completed' || from === 'cancelled') {
    return `This job is already ${from} — that is final.`;
  }
  return `A job cannot move from ${from} to ${to}.`;
}

export interface ClampedOccurredAt {
  /** The value to record — the sent value, or the bound it was clamped to. */
  occurredAt: string;
  /** True when a bound bit: the payload then carries sent vs recorded. */
  clamped: boolean;
}

/**
 * The server clamps the client's clock (§6.3, same rule §6.2 gives
 * `completedAt`): never in the future, never more than 14 days old. A
 * handset underground for three weeks still syncs, and an event dated
 * further back than the business can audit is clamped to the floor rather
 * than rejected — the record survives, honestly labelled.
 */
export function clampOccurredAt(occurredAt: string, now: number = Date.now()): ClampedOccurredAt {
  const sent = Date.parse(occurredAt);
  const maxAgeMs = OCCURRED_AT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const floor = now - maxAgeMs;
  if (sent > now || sent < floor) {
    return { occurredAt: new Date(sent > now ? now : floor).toISOString(), clamped: true };
  }
  return { occurredAt: new Date(sent).toISOString(), clamped: false };
}

/** Which card projection an actor's role reads (§6.3) — three variants, never a merged one. */
function variantForRole(role: Role): repo.CardVariant {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'dispatcher':
      return 'dispatcher';
    case 'technician':
      return 'technician';
    case 'sales_rep':
      throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }
}

// ── row → wire mappers, one per schema; each returns exactly its schema's keys ──

function isoOrNull(t: Date | null): string | null {
  return t === null ? null : t.toISOString();
}

function toTechnicianCard(row: repo.TechnicianCardRow): JobCardTechnician {
  // `contract` needs migration 015 (Phase 2B); the column is nullable and
  // nothing points at a contract yet, so the field is null, not absent.
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    status: row.status,
    priority: row.priority,
    scheduledFor: isoOrNull(row.scheduled_for),
    customerId: row.customer_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    description: row.description,
    contract: null,
    version: row.version,
  };
}

function toDispatcherCard(row: repo.DispatcherCardRow): JobCardDispatcher {
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    status: row.status,
    priority: row.priority,
    scheduledFor: isoOrNull(row.scheduled_for),
    customerId: row.customer_id,
    customerName: row.customer_name,
    assignedTo: row.assigned_to,
    isOverdue: row.is_overdue,
    isContractVisit: row.is_contract_visit,
    version: row.version,
  };
}

function toOwnerCard(row: repo.OwnerCardRow): JobCardOwner {
  return {
    ...toDispatcherCard(row),
    cost: row.cost,
    discountAmount: row.discount_amount,
    discountReason: row.discount_reason,
    amountCollected: row.amount_collected,
    collectionMode: row.collection_mode,
  };
}

function toCard(variant: repo.CardVariant, row: repo.CardRowBase): JobCardTechnician | JobCardDispatcher | JobCardOwner {
  switch (variant) {
    case 'technician':
      return toTechnicianCard(row as repo.TechnicianCardRow);
    case 'dispatcher':
      return toDispatcherCard(row as repo.DispatcherCardRow);
    case 'owner':
      return toOwnerCard(row as repo.OwnerCardRow);
  }
}

export interface Actor {
  id: string;
  role: Role;
}

export interface JobListQuery {
  statuses?: JobStatus[];
  technicianId?: string;
  customerId?: string;
  from?: string;
  to?: string;
  overdue?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface JobListPage {
  items: Array<JobCardTechnician | JobCardDispatcher | JobCardOwner>;
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/** base64url is URL-safe and opaque; the payload is the keyset key, not a secret. */
function encodeCursor(row: { created_at_text: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at_text, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): repo.ListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through: a cursor this app did not mint is a stale list, not a crash
  }
  throw new AppError('VALIDATION_FAILED', 'That page reference is stale — reload the list.');
}

export function createJobsService() {
  /** GET /v1/jobs — one role-shaped page. `scope` is the rbac predicate (null = unrestricted). */
  async function listJobs(
    actor: Actor,
    scope: { sql: string; params: readonly unknown[] } | null,
    query: JobListQuery,
  ): Promise<JobListPage> {
    const variant = variantForRole(actor.role);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const page = await repo.listCards(
      getPool(),
      variant,
      scope,
      {
        statuses: query.statuses,
        technicianId: query.technicianId,
        customerId: query.customerId,
        from: query.from,
        to: query.to,
        overdue: query.overdue,
        q: query.q,
      },
      query.cursor === undefined ? null : decodeCursor(query.cursor),
      limit,
    );
    const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
    return {
      items: rows.map((row) => toCard(variant, row)),
      nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  /**
   * GET /v1/jobs/:id — the row read in the actor's projection. A
   * technician's scope is `assigned_to = actor`, checked on the fetched
   * row so a stranger's job is 403 OUT_OF_SCOPE and a missing one 404,
   * never a merged answer (the list endpoint scopes in SQL instead —
   * plugins/rbac.ts). The money columns are not in the technician's
   * query at all, so the check and the projection cannot disagree.
   */
  async function getJobCard(actor: Actor, jobId: string): Promise<JobCardTechnician | JobCardDispatcher | JobCardOwner> {
    const variant = variantForRole(actor.role);
    const row = await repo.findCard(getPool(), variant, jobId);
    if (row === null) {
      throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    if (variant === 'technician' && (row as repo.TechnicianCardRow).assigned_to !== actor.id) {
      throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    }
    return toCard(variant, row);
  }

  /**
   * POST /v1/jobs/:id/status — one locked row, one legal move, one event
   * (§6.1/§6.3). Returns the updated card in the actor's shape so the
   * handset's mirror can overwrite the row it has.
   */
  async function changeStatus(
    actor: Actor,
    jobId: string,
    input: { to: JobStatus; occurredAt: string },
    source: RequestSource,
  ): Promise<JobCardTechnician | JobCardOwner> {
    if (actor.role !== 'technician' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', STATUS_ACTORS_MESSAGE);
    }

    return withTransaction(async (client) => {
      const job = await repo.lockJobById(client, jobId);
      if (job === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (actor.role === 'technician' && job.assigned_to !== actor.id) {
        throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
      }

      const from = job.status;
      const isEndpointMove = STATUS_MOVES.some((move) => move.from === from && move.to === input.to);
      if (!isEndpointMove || !canTransition(from, input.to)) {
        // The shared graph answers first — this service never re-implements
        // it. A pair the graph licenses but this endpoint does not carry
        // (complete / cancel / assign rows) is still a refusal here, with
        // the door named; see the module header's table.
        throw new AppError('ILLEGAL_TRANSITION', refusalMessage(from, input.to));
      }

      const clamp = clampOccurredAt(input.occurredAt);
      await repo.updateJobStatus(client, jobId, input.to);
      await repo.insertJobEvent(client, {
        jobCardId: jobId,
        eventType: 'status_changed',
        actorId: actor.id,
        occurredAt: clamp.occurredAt,
        fromStatus: from,
        toStatus: input.to,
        source,
        payload: clamp.clamped
          ? { occurredAtClamped: { sent: input.occurredAt, recordedAs: clamp.occurredAt } }
          : undefined,
      });

      const variant = variantForRole(actor.role);
      const card = await repo.findCard(client, variant, jobId);
      if (card === null) {
        // Unreachable: the row is locked in this transaction and the
        // update above succeeded. Never guess about a locked row.
        throw new AppError('INTERNAL', 'The job could not be read back — nothing was lost, try again.');
      }
      return toCard(variant, card) as JobCardTechnician | JobCardOwner;
    });
  }

  return { listJobs, getJobCard, changeStatus };
}

export type JobsService = ReturnType<typeof createJobsService>;
