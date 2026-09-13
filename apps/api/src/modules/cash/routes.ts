import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import {
  CashHandoverSchema,
  cashAmendRequestSchema,
  cashDeclareRequestSchema,
  cashHandoverListResponseSchema,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { salesRepCashEnabled } from '../flags/gates.js';
import { createCashService } from './service.js';

/**
 * Cash handover routes (PLAN-BACKEND.md §10, PHASE-1-TECHNICIAN.md T1.11):
 * `POST /v1/cash/handovers`, `PATCH /v1/cash/handovers/:id`,
 * `GET /v1/cash/handovers/me`. The owner's half of the module — the queue,
 * confirm, dispute, reopen — is Phase 4; until then these rows are written
 * and read by their declarer alone, because the old process remains the
 * record of truth during parallel run.
 *
 * Gates come from the shared matrix (`cash.declare`, T0.10): a technician
 * or sales rep declares and amends `own`; the owner reads all yet his
 * create/update cells are `none` — he confirms and reopens, he does not
 * declare (§5); a dispatcher has no cash cell at all. `own` itself is
 * enforced on the row and off the token: POST stamps the actor's id, /me
 * reads the actor's id, and PATCH checks the row's `employee_id` in the
 * service — no request here ever names an employee.
 *
 * The rep's half rides `sales.cash` (PHASE-3-SALES-REP.md T3.6), appended
 * after the matrix gate: the flag is the rep surface's T0 rollback and is
 * asked only of a sales_rep, so the technician's T1.11 declaration stays
 * exactly as lit. No new endpoint and no new screen — the rep declares on
 * the technician's routes, and the flag decides whether his half answers.
 *
 * Responses are the narrow employee shape (`CashHandoverSchema`), asserted
 * per response by the errors plugin (§3.4): strict, and with no
 * `expected_cash` key — the "If it fails" clause of T1.11.
 */

/** Strict zod objects do not fit Fastify's config intersection without
 * the same `as ZodTypeAny` the other routes use — the check itself
 * still runs at runtime (§3.4). */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

/** §10 POST role column: "technician or sales rep". The owner confirms; he does not declare. */
const DECLARERS_MESSAGE = 'Cash is declared by the employee who collected it.';
/** §10 PATCH role column: "the declaring employee". */
const AMENDERS_MESSAGE = 'Only the employee who declared can amend it.';

/** PATCH carries `If-Match: <version>` — the optimistic-concurrency guard (§10). */
function ifMatchVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  const version = Number(text);
  if (text === undefined || !Number.isInteger(version) || version < 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This change did not say which version of the declaration it is editing — reload and try again.',
    );
  }
  return version;
}

/** A path id that is not even a uuid names a row that cannot exist; no need to let pg say so. */
function handoverIdParam(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError('NOT_FOUND', "We couldn't find that declaration.");
  }
  return id;
}

function claimsOf(request: FastifyRequest): { sub: string } {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

export const cashRoutes: FastifyPluginAsync = async (app) => {
  const service = createCashService();

  app.post(
    '/v1/cash/handovers',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('cash.declare', 'create', DECLARERS_MESSAGE),
        salesRepCashEnabled,
      ],
      config: { responseSchema: asResponseSchema(CashHandoverSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = cashDeclareRequestSchema.parse(request.body);
      // Idempotent by constraint (§10): the unique (employee, date) pair,
      // plus the Idempotency-Key replay the plugin serves for the
      // retry-after-offline path — a second POST for a declared day is a
      // 409, never a second row.
      return service.declare({ id: auth.sub }, body);
    },
  );

  app.get(
    '/v1/cash/handovers/me',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.declare', 'read'), salesRepCashEnabled],
      config: { responseSchema: asResponseSchema(cashHandoverListResponseSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.history(auth.sub);
    },
  );

  app.patch(
    '/v1/cash/handovers/:id',
    {
      preHandler: [
        app.requireAuth,
        app.requirePermission('cash.declare', 'update', AMENDERS_MESSAGE),
        salesRepCashEnabled,
      ],
      config: { responseSchema: asResponseSchema(CashHandoverSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const ifMatch = ifMatchVersion(request);
      const body = cashAmendRequestSchema.parse(request.body);
      return service.amend({ id: auth.sub }, handoverIdParam(request), ifMatch, body);
    },
  );
};
