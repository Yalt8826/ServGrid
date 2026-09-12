import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  BulkAssignResponseSchema,
  JobCardDispatcherSchema,
  JobCardOwnerSchema,
  JobCardTechnicianSchema,
  TechnicianLoadSchema,
  jobAssignSchema,
  jobBulkAssignSchema,
  jobCancelSchema,
  jobCompleteSchema,
  jobRescheduleSchema,
  jobStatusChangeSchema,
  jobStatusSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import type { WorkWindow } from '../../lib/time.js';
import { createNotificationsService } from '../notifications/service.js';
import { isFlagOn } from '../flags/service.js';
import {
  ASSIGN_ACTORS_MESSAGE,
  CANCEL_ACTORS_MESSAGE,
  COMPLETION_ACTORS_MESSAGE,
  createJobsService,
} from './service.js';

/**
 * Jobs routes (PLAN-BACKEND.md §6.3): the reads and the status move of
 * T1.5 — `GET /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/status` —
 * T1.6's `POST /v1/jobs/:id/complete`, and T1.7's two date-writing
 * paths: `POST /v1/jobs/:id/cancel` (which may raise a successor) and
 * `PATCH /v1/jobs/:id` of `scheduled_for` (which never does). Creation,
 * assignment and the timeline are later tasks on the same module.
 *
 * Response shape **by role** is three separate schemas (`JobCardTechnician`
 * / `JobCardDispatcher` / `JobCardOwner`, §6.3) — attached per request via
 * `responseSchemaByRole`, so the errors plugin asserts the actor's own
 * shape and a leaked money field is a failed response, not a schema
 * someone forgot to narrow. Since T2.2 the dispatcher's row is also a
 * different QUERY: repo.dispatcher.ts selects `v_job_cards_dispatcher`
 * under the money-table lint rule, and the recursive money-leak suite
 * (test/authz/money-leak.test.ts) walks every dispatcher-reachable
 * endpoint above this module to hold the line.
 *
 * Cancelling and rescheduling are deliberately different doors (§6.3):
 * cancel closes the card, writes `job_cancellations` and may raise a
 * successor in the same transaction; PATCH moves `scheduled_for` under
 * `If-Match` and leaves status and cancellations alone.
 *
 * The completion route is gated on the matrix cell that carries the
 * money (`job.money` × `create`): technician `own` (write-once at
 * completion, PLAN.md §5), owner `all`, and for a dispatcher `none` —
 * 403 before any payload is read, the revenue guarantee holding at the
 * door rather than in the handler.
 */

/** The list envelope — the same shape for every role, one card schema each. */
const jobListEnvelope = (card: ZodTypeAny): ZodTypeAny =>
  z.object({ items: z.array(card), nextCursor: z.string().nullable() }).strict();

/** Query string of GET /v1/jobs (§6.3): `status[]`, `technicianId`, `customerId`, `from`, `to`, `overdue`, `q`; cursor paginated. */
const jobListQuerySchema = z
  .object({
    status: z.union([jobStatusSchema, z.array(jobStatusSchema)]).optional(),
    technicianId: uuid.optional(),
    customerId: uuid.optional(),
    /** Inclusive bounds on `scheduled_date` — the IST business day the job is ON. */
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    overdue: z.enum(['true', 'false']).optional(),
    q: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .transform((q) => ({
    statuses: q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status],
    technicianId: q.technicianId,
    customerId: q.customerId,
    from: q.from,
    to: q.to,
    overdue: q.overdue === undefined ? undefined : q.overdue === 'true',
    q: q.q,
    limit: q.limit,
    cursor: q.cursor,
  }));

/** A path id that is not even a uuid names a row that cannot exist; no need to let pg say so. */
function jobIdParam(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError('NOT_FOUND', "We couldn't find that job.");
  }
  return id;
}

function claimsOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

/**
 * PATCH carries `If-Match: <version>` — the optimistic-concurrency guard
 * (§6.3, same shape as the employees module's): two dispatchers working
 * the same queue must not overwrite each other's edit unnoticed. A stale
 * version comes back 409 VERSION_CONFLICT naming the current one. The
 * refusal for a MISSING header is the caller's choice: the PATCH treats
 * it as a malformed edit (422), while assign treats it as the missing
 * precondition it is (428, below) — the status written for a conditional
 * request that refused to say what it was conditional on.
 */
function ifMatchVersion(request: FastifyRequest, missing: () => AppError): number {
  const raw = request.headers['if-match'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  const version = Number(text);
  if (text === undefined || !Number.isInteger(version) || version < 1) {
    throw missing();
  }
  return version;
}

/** PATCH's wording: a malformed edit. */
const RESCHEDULE_MISSING_IF_MATCH = (): AppError =>
  new AppError(
    'VALIDATION_FAILED',
    'This change did not say which version of the record it is editing — reload and try again.',
  );

/** Assign's wording (§6.3): a missing precondition — 428, never a silent success. */
const ASSIGN_MISSING_IF_MATCH = (): AppError =>
  new AppError(
    'PRECONDITION_REQUIRED',
    'This assignment did not say which version of the job it saw — reload the queue and try again.',
  );

/**
 * §6.3: assign and bulk-assign sit behind `dispatch.console` — the flag
 * is the T0 rollback tier for the dispatcher surface, and a surface the
 * flag gates is gated HERE, not only in the app: a stale or tampered
 * client must not find the endpoint lit. `dispatch.bulk` is deliberately
 * a second flag — the risky half must switch off without taking the
 * working half down (PHASE-2-DISPATCHER.md T2.3).
 */
const CONSOLE_DISABLED_MESSAGE = 'The dispatch console is switched off for your account.';
const BULK_DISABLED_MESSAGE =
  'Bulk reassign is switched off for your account — assign the jobs one at a time.';

async function dispatchConsoleEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'dispatch.console'))) {
    throw new AppError('FLAG_DISABLED', CONSOLE_DISABLED_MESSAGE);
  }
}

async function dispatchBulkEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'dispatch.bulk'))) {
    throw new AppError('FLAG_DISABLED', BULK_DISABLED_MESSAGE);
  }
}

/**
 * The work window rides in as a plugin option (the same
 * WORK_WINDOW_START/END the location module gets): the notification send
 * path consults it per mutation, after commit, in its own module — the
 * route layer only wires the pieces together.
 */
export const jobsRoutes: FastifyPluginAsync<{ workWindow: WorkWindow }> = async (app, opts) => {
  const notifications = createNotificationsService({ workWindow: opts.workWindow, log: app.log });
  const service = createJobsService(notifications.assignmentChanged);

  app.get(
    '/v1/jobs',
    {
      preHandler: app.requireAuth,
      config: {
        responseSchemaByRole: {
          owner: jobListEnvelope(JobCardOwnerSchema),
          dispatcher: jobListEnvelope(JobCardDispatcherSchema),
          technician: jobListEnvelope(JobCardTechnicianSchema),
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      // null for owner/dispatcher (scope `all`); FORBIDDEN for sales_rep
      // (scope `none`); the technician's `own` predicate is composed into
      // the list's WHERE clause — never filtered after the fact. The
      // qualifier names the row alias each role's query runs against:
      // `job_cards jc` for the field, `v_job_cards_dispatcher v` for the
      // desk (repo.dispatcher.ts, PLAN-BACKEND.md §5 rule 2).
      const scope = request.scopePredicate('job', 'read', {
        qualifier: auth.role === 'dispatcher' ? 'v' : 'jc',
      });
      const query = jobListQuerySchema.parse(request.query ?? {});
      return service.listJobs({ id: auth.sub, role: auth.role }, scope, query);
    },
  );

  app.get(
    '/v1/jobs/:id',
    {
      preHandler: app.requireAuth,
      config: {
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          dispatcher: JobCardDispatcherSchema,
          technician: JobCardTechnicianSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.getJobCard({ id: auth.sub, role: auth.role }, jobIdParam(request));
    },
  );

  app.post(
    '/v1/jobs/:id/status',
    {
      preHandler: app.requireAuth,
      config: {
        // §6.3: technician (own), owner. The dispatcher card is not an
        // outcome of this endpoint, so there is no entry to validate.
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          technician: JobCardTechnicianSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = jobStatusChangeSchema.parse(request.body);
      return service.changeStatus({ id: auth.sub, role: auth.role }, jobIdParam(request), body, request.context.source);
    },
  );

  // §6.2: one transaction, eight steps; idempotent via the Idempotency-Key
  // header the plugin claims before this handler runs. The response is
  // the completed card in the actor's own shape — the owner's carries the
  // money, the technician's never does.
  app.post(
    '/v1/jobs/:id/complete',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('job.money', 'create', COMPLETION_ACTORS_MESSAGE),
      ],
      config: {
        // §6.3: technician (own), owner. A dispatcher's `job.money` scope
        // is `none`, so 403 answers before a payload exists and there is
        // deliberately no dispatcher entry to validate.
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          technician: JobCardTechnicianSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = jobCompleteSchema.parse(request.body);
      return service.completeJob({ id: auth.sub, role: auth.role }, jobIdParam(request), body, request.context.source);
    },
  );

  // §6.3: the wasted trip, recorded by whoever is there — dispatcher,
  // owner, or the technician whose job it is. The matrix cell is
  // `job` × `update`: a sales rep holds none of it and is 403 at the
  // door; a technician passes the gate and is scoped to his own row in
  // the service. With a `rescheduleTo` the successor card is raised in
  // the SAME transaction and linked by `job_cancellations.replacement_job_id`.
  app.post(
    '/v1/jobs/:id/cancel',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('job', 'update', CANCEL_ACTORS_MESSAGE),
      ],
      config: {
        // §6.3: dispatcher, owner, technician (own) — the cancelled card
        // is answered in the actor's own shape.
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          dispatcher: JobCardDispatcherSchema,
          technician: JobCardTechnicianSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = jobCancelSchema.parse(request.body);
      return service.cancelJob({ id: auth.sub, role: auth.role }, jobIdParam(request), body, request.context.source);
    },
  );

  // §6.3: rescheduling — a PATCH of `scheduled_for` under `If-Match`,
  // emitting a `rescheduled` event and leaving status alone. It is NOT a
  // cancellation; the office's door, not the technician's.
  app.patch(
    '/v1/jobs/:id',
    {
      preHandler: app.requireAuth,
      config: {
        // §6.3: dispatcher, owner — no technician or sales-rep card to
        // validate, the service refuses those roles before any write.
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          dispatcher: JobCardDispatcherSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request, RESCHEDULE_MISSING_IF_MATCH);
      const body = jobRescheduleSchema.parse(request.body);
      return service.rescheduleJob(
        { id: auth.sub, role: auth.role },
        jobIdParam(request),
        ifMatch,
        body,
        request.context.source,
      );
    },
  );

  // §6.3: assignment — `{ technicianId }` under a REQUIRED `If-Match:
  // version`. Three dispatchers work the same unassigned queue every
  // morning; two of them opening the same job and picking a technician is
  // a routine Tuesday. The row lock is taken before the version is
  // compared (service.ts "If it fails"), so a lost race comes back as 409
  // VERSION_CONFLICT naming the current assignee instead of an overwrite.
  // A call that carries no `If-Match` at all is 428 PRECONDITION_REQUIRED.
  app.post(
    '/v1/jobs/:id/assign',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('job.assign', 'update', ASSIGN_ACTORS_MESSAGE),
        dispatchConsoleEnabled,
      ],
      config: {
        // §6.3: dispatcher, owner — the reassigned card in the actor's own
        // shape, the dispatcher's read from the view (§5 rule 2).
        responseSchemaByRole: {
          owner: JobCardOwnerSchema,
          dispatcher: JobCardDispatcherSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request, ASSIGN_MISSING_IF_MATCH);
      const body = jobAssignSchema.parse(request.body);
      return service.assignJob(
        { id: auth.sub, role: auth.role },
        jobIdParam(request),
        body.technicianId,
        ifMatch,
        request.context.source,
      );
    },
  );

  // §6.3: bulk assign — one transaction, partial results, per-job
  // `If-Match` (the picker sends the version it showed for every selected
  // card). Behind `dispatch.bulk`, the second flag: the risky half
  // switches off without taking the working half down.
  app.post(
    '/v1/jobs/bulk-assign',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('job.assign', 'update', ASSIGN_ACTORS_MESSAGE),
        dispatchBulkEnabled,
      ],
      config: {
        responseSchemaByRole: {
          owner: BulkAssignResponseSchema(JobCardOwnerSchema),
          dispatcher: BulkAssignResponseSchema(JobCardDispatcherSchema),
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = jobBulkAssignSchema.parse(request.body);
      return service.bulkAssign(
        { id: auth.sub, role: auth.role },
        body.jobIds,
        body.technicianId,
        request.context.source,
      );
    },
  );

  // §6.3: `v_technician_load` for the picker — and how a dispatcher gets
  // technician NAMES, since `GET /v1/employees` is owner-only. Same flag
  // as the console: the picker is part of the working half. The payload
  // is identical for both allowed roles, but it is attached per role like
  // every dispatcher-reachable endpoint, so the money-leak suite's
  // discovery sees it and walks it.
  app.get(
    '/v1/technicians/load',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('job.assign', 'read', ASSIGN_ACTORS_MESSAGE),
        dispatchConsoleEnabled,
      ],
      config: {
        responseSchemaByRole: {
          owner: z.array(TechnicianLoadSchema),
          dispatcher: z.array(TechnicianLoadSchema),
        },
      },
    },
    async () => service.technicianLoad(),
  );
};
