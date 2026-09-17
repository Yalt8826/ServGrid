import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type ZodTypeAny } from 'zod';
import {
  followUpBodySchema,
  serviceCallsResponseSchema,
  ServiceCallSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createServiceCallsService } from './service.js';

/**
 * Service calls (2026-09-17, Yashas): the UPS/battery six-month cycle.
 *
 * Gated with `requireAll`, NOT `requirePermission`: both routes are about
 * the whole book of customers, and a technician holds `job: read:
 * assigned` — a row-scoped cell must never satisfy an endpoint that lists
 * every row (the contracts precedent). The write rides the same
 * `job.assign` cell the assignment routes use, because pushing a reminder
 * out *is* a dispatch decision: only the owner and the dispatcher are ever
 * asked who visits.
 *
 * No money key appears on this surface at all — the price of a visit is
 * the office's business, and the reminder page is about ringing people.
 */

const CALL_ACTORS_MESSAGE = 'Service calls are the office — dispatchers and the owner.';

function claimsOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

/** A path id that is not even a uuid names a row that cannot exist. */
function uuidParam(request: FastifyRequest, name: string): string {
  const id = (request.params as Record<string, string | undefined>)[name] ?? '';
  if (!uuid.safeParse(id).success) {
    throw new AppError('NOT_FOUND', "We couldn't find that customer.");
  }
  return id;
}

/** Both roles read the same rows: the page carries no per-role field. */
const RESPONSE_BY_ROLE = <T extends ZodTypeAny>(schema: T) => ({ owner: schema, dispatcher: schema });

export const serviceCallsRoutes: FastifyPluginAsync = async (app) => {
  const service = createServiceCallsService();

  // The two lists the page renders — due now, and pushed back.
  app.get(
    '/v1/service-calls',
    {
      preHandler: [app.requireAuth, app.requireAll('job', 'read', CALL_ACTORS_MESSAGE)],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(serviceCallsResponseSchema) },
    },
    async () => service.list(),
  );

  // One call, recorded: the outcome, what was said, and the day to ring again.
  app.post(
    '/v1/customers/:id/follow-ups',
    {
      preHandler: [app.requireAuth, app.requireAll('job.assign', 'update', CALL_ACTORS_MESSAGE)],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(ServiceCallSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = followUpBodySchema.parse(request.body);
      const call = await service.recordCall({ id: auth.sub, customerId: uuidParam(request, 'id'), body });
      if (call === null) throw new AppError('NOT_FOUND', "We couldn't find that customer.");
      return call;
    },
  );
};
