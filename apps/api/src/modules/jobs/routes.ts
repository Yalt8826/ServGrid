import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  JobCardDispatcherSchema,
  JobCardOwnerSchema,
  JobCardTechnicianSchema,
  jobCancelSchema,
  jobCompleteSchema,
  jobRescheduleSchema,
  jobStatusChangeSchema,
  jobStatusSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import {
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
 * someone forgot to narrow.
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
 * version comes back 409 VERSION_CONFLICT naming the current one.
 */
function ifMatchVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  const version = Number(text);
  if (text === undefined || !Number.isInteger(version) || version < 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This change did not say which version of the record it is editing — reload and try again.',
    );
  }
  return version;
}

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  const service = createJobsService();

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
      // the list's WHERE clause — never filtered after the fact.
      const scope = request.scopePredicate('job', 'read', { qualifier: 'jc' });
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
      const ifMatch = ifMatchVersion(request);
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
};
