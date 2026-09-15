import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type ZodTypeAny } from 'zod';
import {
  ContractDetailSchema,
  ContractSchema,
  contractCancelSchema,
  contractCreateSchema,
  contractListEnvelopeSchema,
  contractListQuerySchema,
  contractPatchSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { contractsManageEnabled } from '../flags/gates.js';
import { createContractsService } from './service.js';

/**
 * Contracts (PHASE-2B-CONTRACTS.md T2B.2, PLAN-BACKEND.md §11.1, decision
 * 2026-09-15). The AMC surface is the dispatcher's and the owner's alone —
 * the technician's AMC context rides inline on his own job (T2B.3), and a
 * sales rep holds no cell on contract at all — so every route carries
 * `requireAll`, NOT `requirePermission`: the technician holds
 * `contract: read: assigned` (the AMC behind his job), and a row-scoped
 * cell must not satisfy an endpoint that lists every row. `requireAll`
 * 403s him before any query exists.
 *
 * `contracts.manage` rides AFTER the matrix gate (the sales surface's
 * order): the matrix decides which roles are ever on the surface, the flag
 * decides whether the surface answers — the phase's T0 rollback.
 *
 * The dispatcher's response shape carries `contractValue` (decision 8: the
 * price is his), and it is the ONLY money key on this surface — the money
 * leak suite walks these routes with job revenue keys still forbidden.
 */

const CONTRACT_ACTORS_MESSAGE = 'AMCs are recorded by the office — dispatchers and the owner.';

/** The list envelope — one contract schema; §11.1 has no per-role split on contract rows. */
const RESPONSE_BY_ROLE = <T extends ZodTypeAny>(schema: T) => ({ owner: schema, dispatcher: schema });

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
 * (the companies precedent). A missing or malformed header is
 * VALIDATION_FAILED, never a silent force-write.
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

export const contractsRoutes: FastifyPluginAsync = async (app) => {
  const service = createContractsService();

  // §11.1 GET /v1/contracts — the AMC tab's list; `?filter=all|due|ending`.
  app.get(
    '/v1/contracts',
    {
      preHandler: [app.requireAuth, app.requireAll('contract', 'read', CONTRACT_ACTORS_MESSAGE), contractsManageEnabled],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(contractListEnvelopeSchema) },
    },
    async (request) => {
      const query = contractListQuerySchema.parse(request.query ?? {});
      return service.listContracts(query);
    },
  );

  // §11.1 GET /v1/contracts/:id — the AMC plus every job linked to it.
  app.get(
    '/v1/contracts/:id',
    {
      preHandler: [app.requireAuth, app.requireAll('contract', 'read', CONTRACT_ACTORS_MESSAGE), contractsManageEnabled],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(ContractDetailSchema) },
    },
    async (request) => service.getContract(uuidParam(request, 'id')),
  );

  // §11.1 POST /v1/contracts — idempotent (the plugin wraps any POST
  // carrying `Idempotency-Key`); allocates the AMC number inside the
  // request transaction, so a replay re-serves the stored response.
  app.post(
    '/v1/contracts',
    {
      preHandler: [app.requireAuth, app.requireAll('contract', 'create', CONTRACT_ACTORS_MESSAGE), contractsManageEnabled],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(ContractSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = contractCreateSchema.parse(request.body);
      return service.createContract({ id: auth.sub }, body);
    },
  );

  // §11.1 PATCH /v1/contracts/:id — `If-Match`; start, end, price, notes.
  app.patch(
    '/v1/contracts/:id',
    {
      preHandler: [app.requireAuth, app.requireAll('contract', 'update', CONTRACT_ACTORS_MESSAGE), contractsManageEnabled],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(ContractSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const fields = contractPatchSchema.parse(request.body);
      return service.patchContract({ id: auth.sub }, uuidParam(request, 'id'), ifMatch, fields);
    },
  );

  // §11.1 POST /v1/contracts/:id/cancel — idempotent; the reason is required.
  app.post(
    '/v1/contracts/:id/cancel',
    {
      preHandler: [app.requireAuth, app.requireAll('contract', 'delete', CONTRACT_ACTORS_MESSAGE), contractsManageEnabled],
      config: { responseSchemaByRole: RESPONSE_BY_ROLE(ContractSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = contractCancelSchema.parse(request.body);
      return service.cancelContract({ id: auth.sub }, uuidParam(request, 'id'), body);
    },
  );
};
