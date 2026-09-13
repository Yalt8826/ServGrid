import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { SaleSchema, saleCreateSchema, salePatchSchema, saleVoidSchema, uuid } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { salesCardsEnabled } from '../flags/gates.js';
import { createSalesService } from './service.js';

/**
 * Sales cards (PLAN-BACKEND.md §11, PHASE-3-SALES-REP.md T3.3, flag
 * `sales.cards`). The matrix gives the sale to the sales rep (`own` — the
 * cards he made) and the owner (`all`); the dispatcher holds none of it,
 * so he is 403 before any query is built. The rep and the owner read the
 * same SaleSchema — §11 has no per-role split on sale rows.
 *
 * TWO doors carry rules the matrix cannot express, and both are checked at
 * the door, not in the matrix:
 * - `POST /:id/void` is OWNER ONLY. A rep holds `update: own` on sale and
 *   the door is exactly the surface his own-scope must NOT reach — a rep
 *   who needs a sale reversed asks (the companies /owner precedent).
 * - `sales.cards` gates every route here (flags/gates.ts): the surface's
 *   T0 rollback is the flag, so a stale or tampered client must not find
 *   the endpoints lit behind a matrix cell alone. It is APPENDED AFTER the
 *   matrix gate (the cash module's order, T3.6): the matrix decides which
 *   roles are on the surface, and the flag decides whether the surface
 *   answers — a dispatcher is 403 FORBIDDEN, not 409 about a flag that was
 *   never his to flip.
 */
const VOID_OWNER_ONLY_MESSAGE =
  'Only the owner can void a sale — ask, and the owner will reverse it.';

/** The list envelope — one sale schema; §11 has no per-role split on sale rows. */
const saleListEnvelope = z
  .object({ items: z.array(SaleSchema), nextCursor: z.string().nullable() })
  .strict();

/** Query string of GET /v1/sales (§11): cursor paginated. */
const saleListQuerySchema = z
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

/**
 * PATCH carries `If-Match: <version>` — the optimistic-concurrency guard
 * (the companies precedent). A stale version comes back 409
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

const OWNER_RESPONSE = { owner: SaleSchema as ZodTypeAny, sales_rep: SaleSchema as ZodTypeAny };

export const salesRoutes: FastifyPluginAsync = async (app) => {
  const service = createSalesService();

  // §11: rep (own), owner (all). The scope predicate is built here, once,
  // and handed to the service so it lands inside the list's WHERE —
  // pagination composes with scoping, never competes with it.
  app.get(
    '/v1/sales',
    {
      preHandler: [app.requireAuth, app.requirePermission('sale', 'read'), salesCardsEnabled],
      config: {
        responseSchemaByRole: {
          owner: saleListEnvelope,
          sales_rep: saleListEnvelope,
        },
      },
    },
    async (request) => {
      // The predicate is built against the alias the repo's list query
      // spells (`FROM sales_cards sc`) — the rbac contract's qualifier.
      const scope = request.scopePredicate('sale', 'read', { qualifier: 'sc' });
      const query = saleListQuerySchema.parse(request.query ?? {});
      return service.listSales(scope, query);
    },
  );

  // §11: rep, owner — create stamps `sales_rep_id` to the creator and
  // mints a DRAFT: no number, no stamp, no balance. The number is the
  // confirm's to allocate.
  app.post(
    '/v1/sales',
    {
      preHandler: [app.requireAuth, app.requirePermission('sale', 'create'), salesCardsEnabled],
      config: { responseSchemaByRole: OWNER_RESPONSE },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = saleCreateSchema.parse(request.body);
      return service.createSale({ id: auth.sub, role: auth.role }, body);
    },
  );

  // §11: rep (own, DRAFT only), owner. The draft-only rule holds for the
  // owner too — a confirmed card is corrected by void, never edited.
  app.patch(
    '/v1/sales/:id',
    {
      preHandler: [app.requireAuth, app.requirePermission('sale', 'update'), salesCardsEnabled],
      config: { responseSchemaByRole: OWNER_RESPONSE },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const fields = salePatchSchema.parse(request.body);
      return service.patchSale({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), ifMatch, fields);
    },
  );

  // §11: rep (own), owner — the move that mints the number and lifts the
  // balance. Reps confirm; the scoping of WHOSE card is the service's
  // locked-row check.
  app.post(
    '/v1/sales/:id/confirm',
    {
      preHandler: [app.requireAuth, app.requirePermission('sale', 'update'), salesCardsEnabled],
      config: { responseSchemaByRole: OWNER_RESPONSE },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.confirmSale({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'));
    },
  );

  // §11: OWNER ONLY — the one operation that moves a company's balance
  // backwards. The door check is the role, not the matrix cell: a rep
  // holds `update: own` on sale and must not reach this surface even on
  // his own card.
  app.post(
    '/v1/sales/:id/void',
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
        salesCardsEnabled,
      ],
      config: {
        responseSchemaByRole: {
          owner: SaleSchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = saleVoidSchema.parse(request.body);
      return service.voidSale({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), body.reason);
    },
  );
};
