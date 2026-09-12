import {
  canTransition,
  type JobCardDispatcher,
  type JobCardOwner,
  type JobCardTechnician,
  type JobStatus,
  type Role,
  type TechnicianLoad,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { allocateNumber } from '../../lib/sequences.js';
import type { PoolClient } from 'pg';
import type { RequestSource } from '../../plugins/request-context.js';
import type { JobCompletionPart, JobStackChange } from '@servgrid/shared';
import * as repo from './repo.js';
import * as dispatcherRepo from './repo.dispatcher.js';

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
 *
 * Cancelling and rescheduling are DIFFERENT operations that happen to
 * both change a date (§6.3, §3.4): the cancel endpoint may raise a
 * successor card when the work can still happen (`rescheduleTo`), while
 * `PATCH /v1/jobs/:id` of `scheduled_for` moves the very same card under
 * `If-Match` and never closes anything. They produce different events
 * (`cancelled` vs `rescheduled`), different rows (`job_cancellations` vs
 * none), and different consequences for a contract visit in Phase 2B —
 * if they ever merge into one code path, separate them before continuing.
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
/** §6.3: completion is "technician (own), owner" — the matrix cell is `job.money` × `create`, which a dispatcher does not hold at all. */
export const COMPLETION_ACTORS_MESSAGE = 'A job is completed by the technician who did the work or the owner.';
/** §6.3: cancellation is "dispatcher, owner, technician (own)" — the matrix cell is `job` × `update`, which a sales rep does not hold at all. */
export const CANCEL_ACTORS_MESSAGE = 'A job is cancelled by the office or the technician it is assigned to.';
/** §6.3: PATCH is "dispatcher, owner" — a technician on site cancels with a new date instead of patching the card. */
export const RESCHEDULE_ACTORS_MESSAGE =
  'Rescheduling a job is done by the office — on site, cancel the job with the new date instead.';
/** §6.3: assign and bulk-assign are "dispatcher, owner" — the matrix cell is `job.assign`, which a technician or rep does not hold. */
export const ASSIGN_ACTORS_MESSAGE = 'A job is assigned by the office — the dispatcher or the owner.';
/** §6.3: the picker names a technician; anything else on that cell is a form error, not a 404. */
const NOT_A_TECHNICIAN_MESSAGE = 'Pick a technician from the roster — that account is not an active technician.';
/** §6.3: a stale version on a job with nobody on it has no name to give — the sentence stays actionable anyway. */
const STALE_VERSION_MESSAGE = 'This job changed after you opened it — reload it and try again.';
/** §6.2: "The warranty rule is a prompt, not a constraint" — nothing here forces cost to zero; the client confirms on site. */

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

/**
 * "Ravi was assigned this 20 seconds ago" — the lost-race sentence is
 * actionable because it carries the moment. This renders it: granular
 * where it is fresh (the racing case), honest where it is old.
 */
export function sinceWhen(at: Date | null, now: number = Date.now()): string {
  if (at === null) return 'just now';
  const seconds = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  }).format(at);
}

/** §6.3: the bound on `rescheduleTo` — a successor cannot be raised for a day already gone. */
const RESCHEDULE_TO_PAST_MESSAGE = 'That date is already past — pick today or a day ahead.';

/** The IST business date of `now` — the same `business_date()` the overdue filter and the day buckets read (migration 001). */
export function istToday(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(now));
}

/**
 * A `YYYY-MM-DD` at IST midnight — the earliest instant OF that business
 * day, so the generated `scheduled_date` column lands exactly on the day
 * the caller asked for, wherever in the world the server clock sits.
 */
export function istMidnight(date: string): string {
  return new Date(`${date}T00:00:00+05:30`).toISOString();
}

/**
 * Which card projection THIS file builds for a role (§6.3) — technician
 * and owner from `repo.ts`; the dispatcher's lives in repo.dispatcher.ts
 * (the view-reading, lint-guarded file) and is branched to at the call
 * sites below, never merged into one row the service trims.
 */
function variantForRole(role: Role): repo.CardVariant {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'technician':
      return 'technician';
    case 'dispatcher':
      // Unreachable: every dispatcher read branches to dispatcherRepo
      // before a variant is chosen (PLAN-BACKEND.md §5 rule 2).
      throw new AppError('INTERNAL', 'The dispatcher card is read from the dispatcher view.');
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

function toDispatcherCard(row: dispatcherRepo.DispatcherCardRow): JobCardDispatcher {
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

function toCard(variant: repo.CardVariant, row: repo.CardRowBase): JobCardTechnician | JobCardOwner {
  switch (variant) {
    case 'technician':
      return toTechnicianCard(row as repo.TechnicianCardRow);
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

/** The per-job refusals a bulk assign records (§6.3). The whole-request refusals — 403, 428, FLAG_DISABLED — never appear here. */
export type BulkAssignRefusalCode = 'NOT_FOUND' | 'VERSION_CONFLICT' | 'ILLEGAL_TRANSITION';

/** One entry of the bulk-assign partial result: the reassigned card, or the refusal the dispatcher reads. */
export type BulkAssignOutcome =
  | { jobId: string; jobNumber: string; ok: true; job: JobCardDispatcher | JobCardOwner }
  | { jobId: string; jobNumber: string; ok: false; code: BulkAssignRefusalCode; message: string };

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

/** The filters both list repositories carry, decoded from the query string. */
function listFilterOf(query: JobListQuery): repo.JobListFilter {
  return {
    statuses: query.statuses,
    technicianId: query.technicianId,
    customerId: query.customerId,
    from: query.from,
    to: query.to,
    overdue: query.overdue,
    q: query.q,
  };
}

export function createJobsService() {
  /**
   * The actor's own card, read back after a write inside the caller's
   * transaction (§6.3). The dispatcher's comes from the view — the write
   * paths touch `job_cards` because only the database may change a card,
   * but the read he is answered with obeys §5 rule 2 like every other
   * dispatcher read. Unreachable-null is refused loudly: never guess
   * about a locked row.
   */
  async function readBackCard(
    actor: Actor,
    client: PoolClient,
    jobId: string,
  ): Promise<JobCardTechnician | JobCardDispatcher | JobCardOwner> {
    if (actor.role === 'dispatcher') {
      const row = await dispatcherRepo.findDispatcherCard(client, jobId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The job could not be read back — nothing was lost, try again.');
      }
      return toDispatcherCard(row);
    }
    const variant = variantForRole(actor.role);
    const card = await repo.findCard(client, variant, jobId);
    if (card === null) {
      throw new AppError('INTERNAL', 'The job could not be read back — nothing was lost, try again.');
    }
    return toCard(variant, card);
  }

  /**
   * GET /v1/jobs — one role-shaped page. `scope` is the rbac predicate
   * (null = unrestricted). The dispatcher's page comes from
   * repo.dispatcher.ts and `v_job_cards_dispatcher` — the same endpoint,
   * a different query surface, held to the no-money-tables rule (§5
   * rule 2); `?overdue=true` reads `is_overdue` from the view rather
   * than recomputing it here, so list, dashboard and report cannot
   * disagree about what overdue means.
   */
  async function listJobs(
    actor: Actor,
    scope: { sql: string; params: readonly unknown[] } | null,
    query: JobListQuery,
  ): Promise<JobListPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const filter = listFilterOf(query);

    if (actor.role === 'dispatcher') {
      const page = await dispatcherRepo.listDispatcherCards(getPool(), scope, filter, cursor, limit);
      const rows = page.hasMore ? page.rows.slice(0, limit) : page.rows;
      return {
        items: rows.map(toDispatcherCard),
        nextCursor: page.hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
      };
    }

    const variant = variantForRole(actor.role);
    const page = await repo.listCards(getPool(), variant, scope, filter, cursor, limit);
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
   * plugins/rbac.ts). The dispatcher's row comes from the view (§5 rule
   * 2); the money columns are in nobody's query here but the owner's, so
   * the check and the projection cannot disagree.
   */
  async function getJobCard(actor: Actor, jobId: string): Promise<JobCardTechnician | JobCardDispatcher | JobCardOwner> {
    if (actor.role === 'dispatcher') {
      const row = await dispatcherRepo.findDispatcherCard(getPool(), jobId);
      if (row === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      return toDispatcherCard(row);
    }

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

  /**
   * POST /v1/jobs/:id/cancel (§6.3) — the technician's or office's
   * terminal close. With a `rescheduleTo` and an ordinary job, the
   * successor card is raised INSIDE this same transaction and linked by
   * `job_cancellations.replacement_job_id`, so the wasted trip and the
   * fresh commitment commit together or not at all. A contract visit is
   * Phase 2B: the branch is left, the visit flip is the hook below, and
   * no successor is created here — the generator raises the fresh card
   * when the visit comes due, and creating one now would double-raise.
   */
  async function cancelJob(
    actor: Actor,
    jobId: string,
    input: { reasonCode: string; reasonNote?: string; rescheduleTo?: string },
    source: RequestSource,
  ): Promise<JobCardTechnician | JobCardDispatcher | JobCardOwner> {
    // The row's cancellation moment is the server's clock — unlike
    // completion there is no client `occurredAt` in the payload to clamp.
    const cancelledAt = new Date().toISOString();

    return withTransaction(async (client) => {
      try {
        const job = await repo.lockJobForCancellation(client, jobId);
        if (job === null) {
          throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
        }
        if (actor.role === 'technician' && job.assigned_to !== actor.id) {
          throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
        }
        if (job.status === 'cancelled' || job.status === 'completed') {
          const closure = await repo.findClosureActor(client, jobId);
          throw new AppError(
            'JOB_ALREADY_CLOSED',
            closure === null ? `This job is already ${job.status}.` : closedMessage(closure),
          );
        }

        let successorId: string | null = null;
        if (input.rescheduleTo !== undefined && job.contract_visit_id === null) {
          if (input.rescheduleTo < istToday()) {
            throw new AppError('VALIDATION_FAILED', RESCHEDULE_TO_PAST_MESSAGE);
          }
          // A fresh number from the same fiscal-year sequence any created
          // job draws from — allocated on this transaction's client, so a
          // rolled-back cancellation does not even leave a gap's claim.
          const jobNumber = await allocateNumber('job', { db: client, at: new Date(cancelledAt) });
          successorId = await repo.insertSuccessorJob(client, {
            jobNumber,
            customerId: job.customer_id,
            serviceId: job.service_id,
            customerProductId: job.customer_product_id,
            title: job.title,
            description: job.description,
            priority: job.priority,
            scheduledFor: istMidnight(input.rescheduleTo),
            contactName: job.contact_name,
            contactPhone: job.contact_phone,
            createdBy: actor.id,
          });
          await repo.insertJobEvent(client, {
            jobCardId: successorId,
            eventType: 'created',
            actorId: actor.id,
            occurredAt: cancelledAt,
            fromStatus: null, // a new card, not a move — the trail never implies one
            toStatus: 'unassigned',
            source,
            payload: { cancelledJobId: jobId },
          });
        }

        // Phase 2B: the visit returns to `scheduled` with
        // `due_date = rescheduleTo`, or becomes `skipped` without one.
        if (job.contract_visit_id !== null) {
          await onContractVisitCancelled(client, job.contract_visit_id, input.rescheduleTo ?? null, actor.id);
        }

        await repo.insertCancellation(client, {
          jobCardId: jobId,
          cancelledBy: actor.id,
          cancelledAt,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote ?? null,
          replacementJobId: successorId,
        });
        await repo.cancelJobCard(client, jobId, cancelledAt);
        await repo.insertJobEvent(client, {
          jobCardId: jobId,
          eventType: 'cancelled',
          actorId: actor.id,
          occurredAt: cancelledAt,
          fromStatus: job.status,
          toStatus: 'cancelled',
          source,
          payload: {
            reasonCode: input.reasonCode,
            ...(input.reasonNote !== undefined ? { reasonNote: input.reasonNote } : {}),
            ...(successorId !== null ? { replacementJobId: successorId } : {}),
          },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }

      return readBackCard(actor, client, jobId);
    });
  }

  /**
   * PATCH /v1/jobs/:id of `scheduled_for` (§6.3) — rescheduling, the
   * office's path. Under `If-Match` (a lost race is 409 naming the
   * current version), emitting `rescheduled`, and deliberately touching
   * neither status nor `job_cancellations`: a moved appointment is not a
   * wasted trip. No past-date bound here — an open job whose day has
   * passed is exactly what Overdue exists to surface, and the office may
   * have honest reasons to set a date in the past the filter must still
   * see.
   */
  async function rescheduleJob(
    actor: Actor,
    jobId: string,
    ifMatch: number,
    input: { scheduledFor: string },
    source: RequestSource,
  ): Promise<JobCardDispatcher | JobCardOwner> {
    if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', RESCHEDULE_ACTORS_MESSAGE);
    }

    return withTransaction(async (client) => {
      const job = await repo.lockJobForReschedule(client, jobId);
      if (job === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      if (job.version !== ifMatch) {
        throw new AppError(
          'VERSION_CONFLICT',
          'This job changed after you opened it — reload it and try again.',
          { currentVersion: job.version },
        );
      }

      const scheduledFor = new Date(input.scheduledFor).toISOString();
      await repo.rescheduleJobCard(client, jobId, scheduledFor);
      await repo.insertJobEvent(client, {
        jobCardId: jobId,
        eventType: 'rescheduled',
        actorId: actor.id,
        occurredAt: new Date().toISOString(),
        fromStatus: job.status,
        toStatus: job.status, // the point: the card did not move
        source,
        payload: {
          scheduledFor: {
            from: job.scheduled_for === null ? null : new Date(job.scheduled_for).toISOString(),
            to: scheduledFor,
          },
        },
      });

      return (await readBackCard(actor, client, jobId)) as JobCardDispatcher | JobCardOwner;
    });
  }

  /**
   * The §6.3 assignment checks, shared by the single and the bulk door:
   * the version precondition FIRST (it decides whether the caller is
   * acting on the job he thinks he saw), then the status rule. Returns
   * the refusal to raise — thrown by the single assign, recorded as a
   * partial result by the bulk — or null when the assign may proceed.
   *
   * Both refusals NAME A PERSON (§6.3): a lost race names who won it —
   * "Ravi was assigned this 20 seconds ago" is actionable — and an
   * in_progress refusal names who is on site, because the dispatcher's
   * real options are to ring him or cancel with a reason.
   */
  async function assignmentRefusal(
    client: PoolClient,
    job: repo.JobAssignLockRow,
    ifMatch: number,
  ): Promise<AppError | null> {
    if (job.version !== ifMatch) {
      const assigneeName = job.assigned_to === null ? null : await repo.findEmployeeName(client, job.assigned_to);
      return new AppError(
        'VERSION_CONFLICT',
        assigneeName === null
          ? STALE_VERSION_MESSAGE
          : `${assigneeName} was assigned this ${sinceWhen(job.assigned_at)} — reload the job and try again.`,
        {
          currentVersion: job.version,
          currentAssignee: assigneeName === null || job.assigned_to === null
            ? null
            : { id: job.assigned_to, name: assigneeName },
        },
      );
    }
    if (job.status === 'in_progress') {
      const onSiteName = job.assigned_to === null ? null : await repo.findEmployeeName(client, job.assigned_to);
      return new AppError(
        'ILLEGAL_TRANSITION',
        `${onSiteName ?? 'A technician'} is on site working this job — ring him, or cancel the job with a reason.`,
        {
          onSite: job.assigned_to === null ? null : { id: job.assigned_to, name: onSiteName },
        },
      );
    }
    if (job.status === 'completed' || job.status === 'cancelled') {
      return new AppError('ILLEGAL_TRANSITION', `This job is already ${job.status} — that is final.`);
    }
    return null;
  }

  /**
   * POST /v1/jobs/:id/assign (§6.3) — one locked row, one `If-Match`
   * precondition, one event. `unassigned → assigned` emits `assigned`;
   * a reassign emits `reassigned`, and from `en_route` the status RESETS
   * to `assigned` — the new technician has not set off.
   */
  async function assignJob(
    actor: Actor,
    jobId: string,
    technicianId: string,
    ifMatch: number,
    source: RequestSource,
  ): Promise<JobCardDispatcher | JobCardOwner> {
    if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', ASSIGN_ACTORS_MESSAGE);
    }

    return withTransaction(async (client) => {
      const technician = await repo.findActiveTechnician(client, technicianId);
      if (technician === null) {
        throw new AppError('VALIDATION_FAILED', NOT_A_TECHNICIAN_MESSAGE);
      }
      // The lock the whole decision rides (see "If it fails"): taken
      // before the version comparison, so two simultaneous assigns
      // serialise here and the loser loses honestly instead of racing.
      const job = await repo.lockJobForAssign(client, jobId);
      if (job === null) {
        throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      }
      const refusal = await assignmentRefusal(client, job, ifMatch);
      if (refusal !== null) throw refusal;

      const from = job.status;
      const assignedAt = new Date().toISOString();
      await repo.assignJobCard(client, jobId, technicianId, actor.id, assignedAt);
      await repo.insertJobEvent(client, {
        jobCardId: jobId,
        eventType: from === 'unassigned' ? 'assigned' : 'reassigned',
        actorId: actor.id,
        occurredAt: assignedAt,
        fromStatus: from,
        toStatus: 'assigned',
        source,
        payload: {
          technicianId,
          ...(from !== 'unassigned' && job.assigned_to !== null ? { previousTechnicianId: job.assigned_to } : {}),
        },
      });

      return (await readBackCard(actor, client, jobId)) as JobCardDispatcher | JobCardOwner;
    });
  }

  /**
   * POST /v1/jobs/bulk-assign (§6.3) — one transaction, per-job
   * `If-Match`, partial results: the same rule per job, so a multi-select
   * spanning a started job answers with the valid ones applied and the
   * invalid one NAMED (the honest outcome the dispatcher screen renders).
   * Rows lock in id order, so two bulk operations sharing a job cannot
   * deadlock; results come back in the order the picker sent.
   */
  async function bulkAssign(
    actor: Actor,
    entries: ReadonlyArray<{ id: string; ifMatch: number }>,
    technicianId: string,
    source: RequestSource,
  ): Promise<{ results: BulkAssignOutcome[] }> {
    if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', ASSIGN_ACTORS_MESSAGE);
    }

    return withTransaction(async (client) => {
      const technician = await repo.findActiveTechnician(client, technicianId);
      if (technician === null) {
        throw new AppError('VALIDATION_FAILED', NOT_A_TECHNICIAN_MESSAGE);
      }

      const assignedAt = new Date().toISOString();
      const outcomes = new Map<string, BulkAssignOutcome>();
      const lockOrder = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const entry of lockOrder) {
        const job = await repo.lockJobForAssign(client, entry.id);
        if (job === null) {
          outcomes.set(entry.id, {
            jobId: entry.id,
            jobNumber: '',
            ok: false,
            code: 'NOT_FOUND',
            message: NOT_FOUND_MESSAGE,
          });
          continue;
        }
        const refusal = await assignmentRefusal(client, job, entry.ifMatch);
        if (refusal !== null) {
          outcomes.set(entry.id, {
            jobId: entry.id,
            jobNumber: job.job_number,
            ok: false,
            // assignmentRefusal refuses with exactly these two codes.
            code: refusal.code === 'ILLEGAL_TRANSITION' ? 'ILLEGAL_TRANSITION' : 'VERSION_CONFLICT',
            message: refusal.message,
          });
          continue;
        }
        const from = job.status;
        await repo.assignJobCard(client, entry.id, technicianId, actor.id, assignedAt);
        await repo.insertJobEvent(client, {
          jobCardId: entry.id,
          eventType: from === 'unassigned' ? 'assigned' : 'reassigned',
          actorId: actor.id,
          occurredAt: assignedAt,
          fromStatus: from,
          toStatus: 'assigned',
          source,
          payload: {
            technicianId,
            ...(from !== 'unassigned' && job.assigned_to !== null ? { previousTechnicianId: job.assigned_to } : {}),
          },
        });
        // Read back inside the same transaction — the card the picker
        // re-renders, in the caller's own projection (§5 rule 2).
        const card = await readBackCard(actor, client, entry.id);
        outcomes.set(entry.id, {
          jobId: entry.id,
          jobNumber: job.job_number,
          ok: true,
          job: card as JobCardDispatcher | JobCardOwner,
        });
      }

      return { results: entries.map((entry) => outcomes.get(entry.id)!) };
    });
  }

  /**
   * GET /v1/technicians/load (§6.3) — `v_technician_load` for the picker,
   * and the dispatcher's source of technician NAMES (`GET /v1/employees`
   * is owner-only). Busiest last is the view's call — busier first — so
   * the picker renders the free hands at the top; the row is exactly
   * TechnicianLoadSchema and nothing else.
   */
  async function technicianLoad(): Promise<TechnicianLoad[]> {
    const rows = await dispatcherRepo.listTechnicianLoad(getPool());
    return rows.map((row) => ({
      employeeId: row.employee_id,
      technicianName: row.technician_name,
      openToday: Number(row.open_today),
      doneToday: Number(row.done_today),
      openTotal: Number(row.open_total),
      activeSince: row.active_since === null ? null : new Date(row.active_since).toISOString(),
    }));
  }

  return { listJobs, getJobCard, changeStatus, completeJob, cancelJob, rescheduleJob, assignJob, bulkAssign, technicianLoad };
}

// ── completion (§6.2) ───────────────────────────────────────────────────────

/**
 * The mapping layer (§6.2 step 2 and "If it fails"): the discount rule —
 * and every other rule of that shape — lives in the database's
 * constraints; the service only translates a refused insert into a
 * sentence the technician can act on. A violation this table does not
 * know still comes out as a readable 422 — never a 500, never the
 * constraint's name. Moving a rule from the constraints into this
 * service would be the wrong fix in the other direction.
 */
const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  completion_cost_non_negative: 'The amount cannot be negative.',
  completion_discount_non_negative: 'The discount cannot be negative.',
  completion_discount_bounded:
    'The discount is larger than the amount — a discount reduces what is owed, it cannot exceed it.',
  completion_discount_justified: 'A discount needs a reason — say why the amount was reduced.',
  completion_mode_coherent:
    'Select how the customer paid — with nothing owed no payment mode is needed; otherwise the money moved by some mode.',
  job_completions_latlng_paired: 'Send the location fix as both coordinates, or leave it out.',
  customer_products_product_or_name: 'Name the equipment — pick a product or type what it is.',
  customer_products_quantity_positive: 'The equipment quantity must be at least 1.',
  customer_products_active_serial_unique:
    'That serial is already recorded at another site — remove it there before installing it here.',
  job_completion_parts_product_or_name: 'Name the part — pick a product or type what it is.',
  job_completion_parts_quantity_positive: 'A part quantity must be more than zero.',
  job_cancellations_other_justified: 'A cancellation with reason “other” requires a note.',
};

/** Said when a rule this table has no sentence for refuses the row — the rule stays in the database either way. */
const CONSTRAINT_FALLBACK_MESSAGE =
  'One of the details conflicts with a business rule — check the form and try again.';

/** The service pre-checks the serial before the upsert (§6.2 step 5); the sentence and the constraint's mapping stay one string. */
const SERIAL_AT_ANOTHER_SITE_MESSAGE =
  'That serial is already recorded at another site — remove it there before installing it here.';

interface PgViolation {
  code: string;
  constraint?: string;
}

function isPgViolation(error: unknown): error is PgViolation {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

function mapDbRefusal(error: unknown): Error {
  if (!isPgViolation(error)) return error instanceof Error ? error : new Error(String(error));
  const known = error.constraint === undefined ? undefined : CONSTRAINT_MESSAGES[error.constraint];
  // 23514 check · 22003/22001 value too large · 23505 unique · 23503 foreign key
  if (error.code === '23514' || error.code === '22003' || error.code === '22001') {
    return new AppError('VALIDATION_FAILED', known ?? CONSTRAINT_FALLBACK_MESSAGE);
  }
  if (error.code === '23505') {
    return known !== undefined
      ? new AppError('VALIDATION_FAILED', known)
      : new AppError('DUPLICATE_ENTITY', 'That record already exists — it may have synced while you were offline.');
  }
  if (error.code === '23503') {
    return new AppError(
      'VALIDATION_FAILED',
      known ?? 'Something this refers to is no longer in the system — refresh and try again.',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The JOB_ALREADY_CLOSED message names who closed the job and when
 * (§6.1) — it is shown verbatim in the offline-conflict banner, and its
 * whole job is to answer "then what happens to what I just typed?"
 * before the technician wonders: the phone keeps the record, the office
 * reconciles. Timestamps are the site's business clock (IST).
 */
function closedMessage(closure: repo.ClosureActor): string {
  const when = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(closure.at);
  if (closure.kind === 'cancelled') {
    return (
      `This job was cancelled by ${closure.fullName} on ${when} IST. ` +
      'Your completion is kept on this phone — the office will reconcile it.'
    );
  }
  return (
    `This job was already completed by ${closure.fullName} on ${when} IST. ` +
    'One completion per job — if the amount is wrong, the office can amend it.'
  );
}

export interface CompletionInput {
  completedAt: string;
  workSummary: string;
  /** Absent means 0 — the warranty/prepaid shape is cost 0, discount 0, mode none (§3.4). */
  cost?: string;
  discountAmount?: string;
  discountReason?: string;
  /** Absent means 'none'; a nonzero amount owed with 'none' is the database's refusal, mapped to a readable 422. */
  collectionMode?: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none';
  paymentReference?: string;
  customerSigned?: boolean;
  /** §6.2 step 5 — equipment that now stands at the site, stamped with this job. */
  stackChanges?: JobStackChange[];
  /** §6.2 step 6 — what was fitted or consumed. A record, not a bill: nothing here touches cost. */
  parts?: JobCompletionPart[];
}

/**
 * §6.2 step 7 — the contract-visit flip. `contract_visits` is a Phase 2B
 * table (migration 015 adds its FK); until then the column on job_cards
 * is populated by nothing, and the hook is honestly a no-op. The skipped
 * test in test/integration/completion.test.ts marks where the flip gets
 * asserted.
 */
async function onContractVisitCompleted(
  _client: PoolClient,
  _contractVisitId: string,
  _actorId: string,
): Promise<void> {
  /* Phase 2B: UPDATE contract_visits SET status = 'completed' … */
}

/**
 * §6.3 — the contract-visit branch of cancellation. Phase 2B: with a
 * `rescheduleTo` the visit returns to `scheduled` with
 * `due_date = rescheduleTo` (the generator then raises a fresh card when
 * it comes due — no successor is created here, or the work would
 * double-raise); without one the visit becomes `skipped`, carrying the
 * cancellation reason, and the customer has spent it. `contract_visits`
 * is created by migration 015, which also adds job_cards.contract_visit_id's
 * FOREIGN KEY; until then nothing reaches this hook. The skipped test in
 * test/integration/cancellation.test.ts marks where the branch is asserted.
 */
async function onContractVisitCancelled(
  _client: PoolClient,
  _contractVisitId: string,
  _rescheduleTo: string | null,
  _actorId: string,
): Promise<void> {
  /* Phase 2B: UPDATE contract_visits SET status = $rescheduleTo ? 'scheduled' : 'skipped', due_date = … */
}

/** POST /v1/jobs/:id/complete (§6.2) — one transaction, eight steps. */
export async function completeJob(
  actor: Actor,
  jobId: string,
  input: CompletionInput,
  source: RequestSource,
): Promise<JobCardTechnician | JobCardOwner> {
  if (actor.role !== 'technician' && actor.role !== 'owner') {
    throw new AppError('FORBIDDEN', COMPLETION_ACTORS_MESSAGE);
  }

  // Absent money fields are the honest zeros: a warranty job and a
  // prepaid visit arrive as cost 0, discount 0, mode none and pass the
  // constraints unchanged (§3.4). `amountCollected` is not an input at
  // all — the column is generated (cost − discount); accepting it would
  // store derived money.
  const cost = input.cost ?? '0';
  const discountAmount = input.discountAmount ?? '0';
  const discountReason = input.discountReason ?? null;
  const collectionMode = input.collectionMode ?? 'none';
  const paymentReference = input.paymentReference ?? null;
  const customerSigned = input.customerSigned ?? false;

  return withTransaction(async (client) => {
    // Step 1 — the row lock every later step holds; the status and the
    // actor asserts ride it.
    const job = await repo.lockJobForCompletion(client, jobId);
    if (job === null) {
      throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    if (actor.role === 'technician' && job.assigned_to !== actor.id) {
      throw new AppError('OUT_OF_SCOPE', OUT_OF_SCOPE_MESSAGE);
    }
    if (job.status === 'cancelled' || job.status === 'completed') {
      const closure = await repo.findClosureActor(client, jobId);
      throw new AppError(
        'JOB_ALREADY_CLOSED',
        closure === null ? `This job is already ${job.status}.` : closedMessage(closure),
      );
    }
    if (job.status === 'unassigned') {
      throw new AppError(
        'ILLEGAL_TRANSITION',
        'An unassigned job has nobody on site to complete it — assign it first.',
      );
    }

    // The client's clock, clamped once for the completion row, the card's
    // closed_at and the event (§6.2: accepted, not trusted).
    const clamp = clampOccurredAt(input.completedAt);
    const completedAt = clamp.occurredAt;

    // Steps 2–6: every database refusal inside this block maps to a
    // readable 422, and the transaction rolls the whole attempt back —
    // both rows or neither.
    try {
      // Step 2 — the money row. The constraints decide; see mapDbRefusal.
      await repo.insertCompletion(client, {
        jobCardId: jobId,
        completedBy: actor.id,
        completedAt,
        workSummary: input.workSummary,
        cost,
        discountAmount,
        discountReason,
        collectionMode,
        paymentReference,
        customerSigned,
      });

      // Step 3 — close the card at the moment the work happened.
      await repo.completeJobCard(client, jobId, completedAt);

      // Step 4 — the trail: occurred_at is the site moment, recorded_at
      // is now() (the column's default); a clamp is recorded in the payload.
      await repo.insertJobEvent(client, {
        jobCardId: jobId,
        eventType: 'completed',
        actorId: actor.id,
        occurredAt: completedAt,
        fromStatus: job.status,
        toStatus: 'completed',
        source,
        payload: clamp.clamped
          ? { completedAtClamped: { sent: input.completedAt, recordedAs: clamp.occurredAt } }
          : undefined,
      });

      // Step 5 — the stack, upserted by serial inside the same transaction.
      for (const change of input.stackChanges ?? []) {
        const upsert: repo.StackChangeUpsert = {
          customerId: job.customer_id,
          sourceJobId: jobId,
          installedBy: actor.id,
          productId: change.productId ?? null,
          freeTextName: change.freeTextName ?? null,
          serialNumber: change.serialNumber,
          quantity: change.quantity ?? 1,
          installedOn: change.installedOn ?? null,
          completedAt,
          warrantyExpiresOn: change.warrantyExpiresOn ?? null,
          notes: change.notes ?? null,
        };
        const existing = await repo.lockActiveUnitBySerial(client, change.serialNumber);
        if (existing === null) {
          await repo.insertStackUnit(client, upsert);
        } else if (existing.customer_id !== job.customer_id) {
          // The active-serial unique index is the rule; this is its sentence.
          throw new AppError('VALIDATION_FAILED', SERIAL_AT_ANOTHER_SITE_MESSAGE);
        } else {
          await repo.updateStackUnitFromJob(client, existing.id, upsert);
        }
      }

      // Step 6 — the parts, a record of what was fitted; no money column
      // is read or written (§3.4).
      await repo.insertCompletionParts(
        client,
        jobId,
        (input.parts ?? []).map((part, index) => ({
          lineNo: index + 1,
          productId: part.productId ?? null,
          freeTextName: part.freeTextName ?? null,
          quantity: part.quantity,
          unitCost: part.unitCost ?? null,
          serialNumber: part.serialNumber ?? null,
          fromCustomerStock: part.fromCustomerStock ?? false,
        })),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapDbRefusal(error);
    }

    // Step 7 — contract visits: Phase 2B flips the visit's status (hook above).
    if (job.contract_visit_id !== null) {
      await onContractVisitCompleted(client, job.contract_visit_id, actor.id);
    }

    // Step 8 — attachments arrive as separate requests; a completion is
    // valid without them. Nothing to do here by design.

    const variant = variantForRole(actor.role);
    const card = await repo.findCard(client, variant, jobId);
    if (card === null) {
      // Unreachable: the row is locked in this transaction and step 3
      // succeeded. Never guess about a locked row.
      throw new AppError('INTERNAL', 'The job could not be read back — nothing was lost, try again.');
    }
    return toCard(variant, card) as JobCardTechnician | JobCardOwner;
  });
}

export type JobsService = ReturnType<typeof createJobsService>;
