import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import {
  employeeAdminSchema,
  employeeCreateRequestSchema,
  employeeDetailResponseSchema,
  employeeListQuerySchema,
  employeeListResponseSchema,
  employeePatchRequestSchema,
  employeePasswordResetRequestSchema,
  employeePublicSchema,
  passwordChangeResponseSchema,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createEmployeesService } from './service.js';

/**
 * Employee-admin routes (PLAN-BACKEND.md §4.1). Owner only, except
 * `GET /v1/employees/me`. The owner gate is inline for now — the rbac
 * plugin and its SQL-predicate scopes are T0.10; the matrix test that
 * pins this table is test/authz/employees.test.ts.
 */

export const OWNER_ONLY_MESSAGE = 'Only the owner can manage employee accounts.';

/** Strict zod objects do not fit Fastify's config intersection without
 * the same `as ZodTypeAny` the auth routes use — the check itself
 * still runs at runtime (§3.4). */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

/**
 * Runs after `requireAuth`: a missing token is 401, a token without the
 * owner's role is 403. §4.1 has no exception list — every non-owner role
 * is refused identically, including on a path carrying their own id.
 *
 * Async on purpose: Fastify's hook runner advances a preHandler list only
 * when the hook returns a thenable or calls its `next` callback — a sync
 * hook that merely returns hangs the request.
 */
async function assertOwner(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (auth.role !== 'owner') throw new AppError('FORBIDDEN', OWNER_ONLY_MESSAGE);
}

/** PATCH carries `If-Match: <version>` — the optimistic-concurrency guard (§4.1). */
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

/** A path id that is not even a uuid names a row that cannot exist; no need to let pg say so. */
function employeeIdParam(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError('NOT_FOUND', "We couldn't find that employee.");
  }
  return id;
}

export const employeesRoutes: FastifyPluginAsync = async (app) => {
  const service = createEmployeesService();

  // Static before parametric for readability; find-my-way prefers /me regardless.
  app.get(
    '/v1/employees/me',
    { preHandler: app.requireAuth, config: { responseSchema: asResponseSchema(employeePublicSchema) } },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      return service.me(auth.sub);
    },
  );

  app.get(
    '/v1/employees',
    {
      preHandler: [app.requireAuth, assertOwner],
      config: { responseSchema: asResponseSchema(employeeListResponseSchema) },
    },
    async (request) => {
      const filter = employeeListQuerySchema.parse(request.query ?? {});
      return service.list(filter);
    },
  );

  app.post(
    '/v1/employees',
    {
      preHandler: [app.requireAuth, assertOwner],
      config: { responseSchema: asResponseSchema(employeeAdminSchema) },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      const body = employeeCreateRequestSchema.parse(request.body);
      return service.create(auth.sub, body);
    },
  );

  app.get(
    '/v1/employees/:id',
    {
      preHandler: [app.requireAuth, assertOwner],
      config: { responseSchema: asResponseSchema(employeeDetailResponseSchema) },
    },
    async (request) => service.detail(employeeIdParam(request)),
  );

  app.patch(
    '/v1/employees/:id',
    {
      preHandler: [app.requireAuth, assertOwner],
      config: { responseSchema: asResponseSchema(employeeAdminSchema) },
    },
    async (request) => {
      const ifMatch = ifMatchVersion(request);
      const body = employeePatchRequestSchema.parse(request.body);
      return service.update(employeeIdParam(request), ifMatch, body);
    },
  );

  app.post(
    '/v1/employees/:id/password',
    {
      preHandler: [app.requireAuth, assertOwner],
      config: { responseSchema: asResponseSchema(passwordChangeResponseSchema) },
    },
    async (request, reply: FastifyReply) => {
      const body = employeePasswordResetRequestSchema.parse(request.body);
      await service.resetPassword(employeeIdParam(request), body.tempPassword);
      return reply.status(200).send({ ok: true });
    },
  );
};
