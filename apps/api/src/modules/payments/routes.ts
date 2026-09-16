import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { PaymentSchema, paymentCreateSchema, paymentVoidSchema, uuid } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import type { StorageConfig } from '../../lib/storage.js';
import { salesPaymentsEnabled } from '../flags/gates.js';
import { createAttachmentsService } from '../attachments/service.js';
import { createPaymentsService } from './service.js';

/**
 * Payments (PLAN-BACKEND.md §11, PHASE-3-SALES-REP.md T3.4, flag
 * `sales.payments`). The matrix gives the payment to the sales rep
 * (`own` — the collections he RECEIVED, `received_by`) and the owner
 * (`all`); the dispatcher and the technician hold none of it, so they are
 * 403 before any query is built. `own` on payment is deliberately
 * stricter than `own` on company: a house account is visible to every
 * rep, but the money on it is visible only to whoever collected it — the
 * test suite pins exactly that.
 *
 * TWO doors carry rules the matrix cannot express, and both are checked at
 * the door, not in the matrix:
 * - `POST /:id/void` is OWNER ONLY. A rep holds `update: own` on payment
 *   and the door is exactly the surface his own-scope must NOT reach — a
 *   rep who needs a payment reversed asks (the sale-void precedent).
 * - `sales.payments` gates every route here (flags/gates.ts): the
 *   surface's T0 rollback is the flag, so a stale or tampered client must
 *   not find the endpoints lit behind a matrix cell alone. It is APPENDED
 *   AFTER the matrix gate (the sales module's order, T3.3): the matrix
 *   decides which roles are on the surface, and the flag decides whether
 *   the surface answers.
 *
 * The proof photo is NOT a field here — it rides the attachments endpoint
 * (`POST /v1/attachments`, ownerType `payment`), with the outbox row's
 * `dependsOn` pointing at its parent payment so the binary drain pass
 * uploads it only after the payment itself resolved (§5, §9).
 */
const VOID_OWNER_ONLY_MESSAGE =
  'Only the owner can void a payment — ask, and the owner will reverse it.';

/** The list envelope — one payment schema; §11 has no per-role split on payment rows. */
const paymentListEnvelope = z
  .object({ items: z.array(PaymentSchema), nextCursor: z.string().nullable() })
  .strict();

/** Query string of GET /v1/payments (§11): cursor paginated. */
const paymentListQuerySchema = z
  .object({
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

const OWNER_RESPONSE = { owner: PaymentSchema as ZodTypeAny, sales_rep: PaymentSchema as ZodTypeAny };

type PaymentsRoutesOptions = { s3: StorageConfig };

export const paymentsRoutes: FastifyPluginAsync<PaymentsRoutesOptions> = async (app, opts) => {
  const service = createPaymentsService();
  // The proof photo reads live here, not on the attachments surface:
  // "show me the photo for THIS payment" is a payment question, and the
  // attachment id is an implementation detail the client never holds.
  const attachments = createAttachmentsService(opts.s3);

  // §11: rep (own — received_by), owner (all). The scope predicate is
  // built here, once, and handed to the service so it lands inside the
  // list's WHERE — pagination composes with scoping, never competes
  // with it.
  app.get(
    '/v1/payments',
    {
      preHandler: [app.requireAuth, app.requirePermission('payment', 'read'), salesPaymentsEnabled],
      config: {
        responseSchemaByRole: {
          owner: paymentListEnvelope,
          sales_rep: paymentListEnvelope,
        },
      },
    },
    async (request) => {
      // The predicate is built against the alias the repo's list query
      // spells (`FROM payments p`) — the rbac contract's qualifier.
      const scope = request.scopePredicate('payment', 'read', { qualifier: 'p' });
      const query = paymentListQuerySchema.parse(request.query ?? {});
      return service.listPayments(scope, query);
    },
  );

  // §11: rep (own), owner — capture. `received_by` is stamped from the
  // token (whoever actually took the money); the payload carries no rep
  // field, the server decides. The proof photo follows separately through
  // the attachments endpoint, ordered after this row by the outbox.
  app.post(
    '/v1/payments',
    {
      preHandler: [app.requireAuth, app.requirePermission('payment', 'create'), salesPaymentsEnabled],
      config: { responseSchemaByRole: OWNER_RESPONSE },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = paymentCreateSchema.parse(request.body);
      return service.createPayment({ id: auth.sub, role: auth.role }, body);
    },
  );

  // The ledger's payment row, clicked: the proof photo behind it, as a
  // short-lived presigned URL (§9's five minutes, same as the by-id
  // attachment read — the bytes are never proxied). The read access
  // rule is the attachments module's own: owner all, the receiving rep
  // own. JSON rather than the 302 the by-id read sends, because the
  // browser cannot put an Authorization header on an <img> request.
  app.get(
    '/v1/payments/:id/proof',
    {
      preHandler: [app.requireAuth, app.requirePermission('payment', 'read'), salesPaymentsEnabled],
      config: {
        responseSchemaByRole: {
          owner: z.object({ url: z.string() }).strict() as unknown as ZodTypeAny,
          sales_rep: z.object({ url: z.string() }).strict() as unknown as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const paymentId = uuidParam(request, 'id');
      const { url } = await attachments.readUrlForOwner({ id: auth.sub, role: auth.role }, 'payment', paymentId, 'photo');
      return { url };
    },
  );

  // §11: OWNER ONLY — the one operation that moves a company's balance
  // backwards. The door check is the role, not the matrix cell: a rep
  // holds `update: own` on payment and must not reach this surface even
  // on his own collection.
  app.post(
    '/v1/payments/:id/void',
    {
      preHandler: [
        app.requireAuth,
        async (request) => {
          const auth = request.auth;
          if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
          if (auth.role !== 'owner') throw new AppError('FORBIDDEN', VOID_OWNER_ONLY_MESSAGE);
        },
        // The flag rides AFTER the door (the matrix-first order): the role
        // check says who may ever void, the flag says whether the surface
        // is lit at all.
        salesPaymentsEnabled,
      ],
      config: {
        responseSchemaByRole: {
          owner: PaymentSchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = paymentVoidSchema.parse(request.body);
      return service.voidPayment({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), body.reason);
    },
  );
};
