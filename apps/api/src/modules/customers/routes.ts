import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  CustomerDetailDispatcherSchema,
  CustomerDetailSchema,
  CustomerDispatcherSchema,
  CustomerSchema,
  CustomerStackItemSchema,
  CustomerCreateSchema,
  DispatcherCustomerCreateSchema,
  customerPatchSchema,
  dispatcherCustomerPatchSchema,
  jobStackChangeSchema,
  stackItemPatchSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createCustomersService } from './service.js';

/**
 * Customers and the product stack (PLAN-BACKEND.md §6.4), plus the two
 * standalone correction doors the spec is explicit about: a wrong serial
 * noticed the next day, a unit removed without a job. The completion
 * payload (T1.6) remains the door that stamps `source_job_id`; these
 * stamp none, by omission in the repo's INSERT and by design here.
 *
 * The dispatcher's payloads go through the STRIPPING schemas
 * (DispatcherCustomerCreateSchema / dispatcherCustomerPatchSchema): a zod
 * transform deletes `companyId` before any handler runs (PLAN.md §5 —
 * "It is an owner and rep field"), which is why choosing the schema by
 * role happens here, at the route, once, and never inside the service.
 *
 * Response shape by role follows the jobs module's rule: separate strict
 * schemas per role, attached as `responseSchemaByRole`, so the errors
 * plugin asserts the actor's own shape. The dispatcher's customer shape
 * has no `companyId` at all — company data is a field he cannot read
 * (PLAN.md §5), and the repo's dispatcher projection never selects it
 * either.
 */

/** The list envelope — the same shape for every role, one customer schema each. */
const customerListEnvelope = (customer: ZodTypeAny): ZodTypeAny =>
  z.object({ items: z.array(customer), nextCursor: z.string().nullable() }).strict();

/** Query string of GET /v1/customers (§6.4): `q` over name and phone; cursor paginated. */
const customerListQuerySchema = z
  .object({
    q: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

/** A path id that is not even a uuid names a row that cannot exist; no need to let pg say so. */
function uuidParam(request: FastifyRequest, name: string): string {
  const id = (request.params as Record<string, string | undefined>)[name] ?? '';
  if (!uuid.safeParse(id).success) {
    throw new AppError('NOT_FOUND', "We couldn't find that.");
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
 * (§6.4, same shape as the jobs module's). A stale version comes back 409
 * VERSION_CONFLICT naming the current one.
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

export const customersRoutes: FastifyPluginAsync = async (app) => {
  const service = createCustomersService();

  // §6.4: dispatcher, owner (all); technician (`assigned` — through a job,
  // present tense or closed). A sales rep holds none of the cell and is
  // 403 before any query is built.
  app.get(
    '/v1/customers',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer', 'read')],
      config: {
        responseSchemaByRole: {
          owner: customerListEnvelope(CustomerSchema),
          dispatcher: customerListEnvelope(CustomerDispatcherSchema),
          technician: customerListEnvelope(CustomerSchema),
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const scope = request.scopePredicate('customer', 'read', { qualifier: 'c' });
      const query = customerListQuerySchema.parse(request.query ?? {});
      return service.listCustomers({ id: auth.sub, role: auth.role }, scope, query);
    },
  );

  // §6.4: dispatcher, owner — and the dispatcher's payload is stripped of
  // `companyId` by the schema transform (§5 rule 3), never merely omitted.
  app.post(
    '/v1/customers',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer', 'create')],
      config: {
        responseSchemaByRole: {
          owner: CustomerSchema,
          dispatcher: CustomerDispatcherSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const schema = auth.role === 'dispatcher' ? DispatcherCustomerCreateSchema : CustomerCreateSchema;
      const body = schema.parse(request.body);
      return service.createCustomer({ id: auth.sub, role: auth.role }, body);
    },
  );

  // §6.4: scoped — the stack rides along in the site's own shape.
  app.get(
    '/v1/customers/:id',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer', 'read')],
      config: {
        responseSchemaByRole: {
          owner: CustomerDetailSchema,
          dispatcher: CustomerDetailDispatcherSchema,
          technician: CustomerDetailSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.getCustomerDetail({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'));
    },
  );

  // §6.4: dispatcher, owner; `If-Match`.
  app.patch(
    '/v1/customers/:id',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer', 'update')],
      config: {
        responseSchemaByRole: {
          owner: CustomerSchema,
          dispatcher: CustomerDispatcherSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const schema = auth.role === 'dispatcher' ? dispatcherCustomerPatchSchema : customerPatchSchema;
      const fields = schema.parse(request.body);
      return service.patchCustomer({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), ifMatch, fields);
    },
  );

  // §6.4: scoped — the site's active units.
  app.get(
    '/v1/customers/:id/stack',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer', 'read')],
      config: {
        responseSchemaByRole: {
          owner: z.array(CustomerStackItemSchema),
          dispatcher: z.array(CustomerStackItemSchema),
          technician: z.array(CustomerStackItemSchema),
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.getStack({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'));
    },
  );

  // §6.4: technician (assigned), owner. The matrix cell is `customer.stack`
  // × `update` — "add a unit" is a change to the site's stack, and the
  // matrix's technician cell is exactly that scope; a dispatcher holds
  // none of it and is 403 before a payload exists. The actor's row scope
  // on the SITE is the customer read predicate (assigned), applied in the
  // service's scoped lookup.
  app.post(
    '/v1/customers/:id/stack',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer.stack', 'update')],
      config: {
        responseSchemaByRole: {
          owner: CustomerStackItemSchema,
          technician: CustomerStackItemSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const siteScope = request.scopePredicate('customer', 'read', { qualifier: 'c' });
      const change = jobStackChangeSchema.parse(request.body);
      return service.addStackItem({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), change, siteScope);
    },
  );

  // §6.4: technician (assigned), owner; `If-Match`; serial, warranty,
  // quantity. The technician's row scope (`customer.stack` × `assigned`)
  // is composed into the UPDATE itself — a site he never had a job for is
  // 403 OUT_OF_SCOPE, proven at the row.
  app.patch(
    '/v1/customers/:id/stack/:itemId',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer.stack', 'update')],
      config: {
        responseSchemaByRole: {
          owner: CustomerStackItemSchema,
          technician: CustomerStackItemSchema,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const fields = stackItemPatchSchema.parse(request.body);
      return service.patchStackItem(
        { id: auth.sub, role: auth.role },
        uuidParam(request, 'id'),
        uuidParam(request, 'itemId'),
        ifMatch,
        fields,
      );
    },
  );

  // §6.4: technician (assigned), owner — soft delete: `is_active = false`,
  // which is what releases the serial for another site.
  app.delete(
    '/v1/customers/:id/stack/:itemId',
    {
      preHandler: [app.requireAuth, app.requirePermission('customer.stack', 'delete')],
      config: {
        responseSchemaByRole: {
          owner: z.object({ ok: z.boolean() }).strict(),
          technician: z.object({ ok: z.boolean() }).strict(),
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.deleteStackItem(
        { id: auth.sub, role: auth.role },
        uuidParam(request, 'id'),
        uuidParam(request, 'itemId'),
      );
    },
  );
};
