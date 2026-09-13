import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  CompanyCreateSchema,
  CompanySchema,
  companyOwnerPatchSchema,
  companyPatchSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createCompaniesService } from './service.js';

/**
 * Companies (PLAN-BACKEND.md §11, §5 `own` on company). The matrix gives
 * the cell to the sales rep (`own` — his accounts plus the house accounts)
 * and the owner (`all`); the dispatcher holds none of it
 * (PLAN.md §5), so he is 403 before any query is built. There is no
 * per-role row split on company data — money never rides the company row
 * itself (dues are the views, migration 018) — so every allowed role reads
 * the same CompanySchema, and the endpoint's scoping lives entirely in the
 * predicate the repo composes into the WHERE.
 *
 * The ONE door that moves `owner_rep_id` is PATCH /v1/companies/:id/owner,
 * and it is OWNER ONLY — checked at the door (the catalogue module's
 * requireOwner shape), because the matrix cannot express "this row-scoped
 * cell may not touch this one column": a rep holds `update: own` on
 * company, and the owner endpoint is exactly the surface his own-scope
 * must NOT reach. A rep cannot reassign an account — his own included.
 */

const OWNER_ONLY_MESSAGE = 'Only the owner can reassign an account.';

/** The list envelope — one company schema; §11 has no per-role split on company rows. */
const companyListEnvelope = z
  .object({ items: z.array(CompanySchema), nextCursor: z.string().nullable() })
  .strict();

/** Query string of GET /v1/companies (§11): cursor paginated. */
const companyListQuerySchema = z
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
 * (the reference-data precedent, §6.4). A stale version comes back 409
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

export const companiesRoutes: FastifyPluginAsync = async (app) => {
  const service = createCompaniesService();

  // §11: rep (own + house), owner (all). The scope predicate is built here,
  // once, and handed to the service so it lands inside the list's WHERE —
  // pagination composes with scoping, never competes with it.
  app.get(
    '/v1/companies',
    {
      preHandler: [app.requireAuth, app.requirePermission('company', 'read')],
      config: {
        responseSchemaByRole: {
          owner: companyListEnvelope,
          sales_rep: companyListEnvelope,
        },
      },
    },
    async (request) => {
      // The predicate is built against the alias the repo's list query
      // spells (`FROM companies c`) — the rbac contract's qualifier.
      const scope = request.scopePredicate('company', 'read', { qualifier: 'c' });
      const query = companyListQuerySchema.parse(request.query ?? {});
      return service.listCompanies(scope, query);
    },
  );

  // §11: rep, owner — create stamps `owner_rep_id` to the creator (a rep);
  // the owner's create lands a house account. The payload carries no
  // `ownerRepId`: the server decides, never the caller.
  app.post(
    '/v1/companies',
    {
      preHandler: [app.requireAuth, app.requirePermission('company', 'create')],
      config: {
        responseSchemaByRole: {
          owner: CompanySchema as ZodTypeAny,
          sales_rep: CompanySchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = CompanyCreateSchema.parse(request.body);
      return service.createCompany({ id: auth.sub, role: auth.role }, body);
    },
  );

  // §11: scoped — another rep's account is OUT_OF_SCOPE at the row.
  app.get(
    '/v1/companies/:id',
    {
      preHandler: [app.requireAuth, app.requirePermission('company', 'read')],
      config: {
        responseSchemaByRole: {
          owner: CompanySchema as ZodTypeAny,
          sales_rep: CompanySchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.getCompany({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'));
    },
  );

  // §11: rep (own + house), owner; `If-Match`. The patch payload has no
  // `ownerRepId` field — ownership cannot move through an edit.
  app.patch(
    '/v1/companies/:id',
    {
      preHandler: [app.requireAuth, app.requirePermission('company', 'update')],
      config: {
        responseSchemaByRole: {
          owner: CompanySchema as ZodTypeAny,
          sales_rep: CompanySchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const fields = companyPatchSchema.parse(request.body);
      return service.patchCompany({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), ifMatch, fields);
    },
  );

  // §11: OWNER ONLY — reassignment and the leave cover. The door check is
  // the role, not the matrix cell: a rep holds `update: own` on company
  // and must not reach this surface even on his own account.
  app.patch(
    '/v1/companies/:id/owner',
    {
      preHandler: [
        app.requireAuth,
        async (request) => {
          const auth = request.auth;
          if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
          if (auth.role !== 'owner') throw new AppError('FORBIDDEN', OWNER_ONLY_MESSAGE);
        },
      ],
      config: {
        responseSchemaByRole: {
          owner: CompanySchema as ZodTypeAny,
        },
      },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = companyOwnerPatchSchema.parse(request.body);
      return service.patchOwner({ id: auth.sub, role: auth.role }, uuidParam(request, 'id'), body);
    },
  );
};
