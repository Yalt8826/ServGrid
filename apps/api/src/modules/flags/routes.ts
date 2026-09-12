import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { flagListResponseSchema, flagOverrideRequestSchema, flagOverrideResponseSchema } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import * as service from './service.js';

/**
 * Feature-flag routes (PLAN-EXECUTION.md §3). Owner only, and gated on
 * the SAME permission-matrix cells employee administration uses —
 * `employee:read` for the roster view, `employee:update` to flip —
 * because a flag override is an attribute of an employee account, and
 * the matrix is the one place that decides who may touch an account. No
 * new matrix cell: two answers to "who may change a technician's
 * access?" is a hole waiting for a disagreement.
 *
 * The flip is idempotent and audited by row (updated_by / updated_at on
 * employee_flag_overrides): during the parallel run the owner turns one
 * thing off at a time, and the row records who did.
 */

const OWNER_ONLY_MESSAGE = "Feature flags are the owner's instrument.";

/** Fastify's responseSchema wants JSON Schema; the zod schemas are the
 * contract — this keeps the types honest without a serializer plugin. */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

function claimsOf(request: FastifyRequest): { sub: string } {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

export const flagsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/flags',
    {
      preHandler: [app.requireAuth, app.requireAll('employee', 'read', OWNER_ONLY_MESSAGE)],
      config: { responseSchema: asResponseSchema(flagListResponseSchema) },
    },
    async () => {
      return { employees: await service.listRosterFlags() };
    },
  );

  app.put(
    '/v1/employees/:id/flags',
    {
      preHandler: [app.requireAuth, app.requireAll('employee', 'update', OWNER_ONLY_MESSAGE)],
      config: { responseSchema: asResponseSchema(flagOverrideResponseSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const { id } = request.params as { id: string };
      const body = flagOverrideRequestSchema.parse(request.body);
      const flags = await service.setOverride(id, body.flag, body.enabled, auth.sub);
      return { employeeId: id, flags };
    },
  );
};
