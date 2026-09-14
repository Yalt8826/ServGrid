import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import {
  CashHandoverSchema,
  cashAmendRequestSchema,
  cashConfirmRequestSchema,
  cashDeclareRequestSchema,
  cashDisputeRequestSchema,
  cashHandoverListResponseSchema,
  cashQueueQuerySchema,
  cashQueueResponseSchema,
  cashQueueRowSchema,
  cashReopenRequestSchema,
} from '@servgrid/shared';
import { cashQueueDayQuerySchema, cashQueueDayResponseSchema } from './schemas.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { ownerCashEnabled, salesRepCashEnabled } from '../flags/gates.js';
import { createCashService } from './service.js';

/**
 * Cash handover routes (PLAN-BACKEND.md §10): the employee's half
 * (PHASE-1-TECHNICIAN.md T1.11) — `POST /v1/cash/handovers`,
 * `PATCH /v1/cash/handovers/:id`, `GET /v1/cash/handovers/me` — and the
 * owner's half (PHASE-4-OWNER.md T4.2) — `GET /v1/cash/queue` over
 * `v_cash_reconciliation_queue` plus `POST /v1/cash/handovers/:id/
 * confirm|dispute|reopen`. Until the owner's half lit in Phase 4 these
 * rows were written and read by their declarer alone, because the old
 * process remained the record of truth during parallel run.
 *
 * Gates come from the shared matrix (T0.10): a technician or sales rep
 * declares and amends `own` (`cash.declare`); the owner reads all yet his
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
 * The owner's half rides `owner.cash` (T4.2) the same way, asked of every
 * caller: flipping it off darkens the queue and its three actions for
 * everyone, which is that surface's T0 rollback.
 *
 * Responses are the narrow employee shape (`CashHandoverSchema`) on the
 * employee's endpoints — strict, and with no `expected_cash` key, the
 * "If it fails" clause of T1.11 — and the queue row (`cashQueueRowSchema`)
 * on the owner's, where the derived figure beside the declared one is the
 * entire feature.
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

  // ── the owner's half (Phase 4, T4.2, §10) ─────────────────────────────────
  //
  // The gate order is matrix-first, the `/v1/sales/:id/void` shape: the
  // matrix cell (`cash.confirm` — owner all, everyone else none) says who
  // may ever reconcile, and the `owner.cash` flag says whether the surface
  // is lit at all. Flipping the flag off is T4.2's T0 rollback; it darkens
  // the queue and all three actions for everyone, which is the point.

  /**
   * `flag` may arrive as repeated keys or `flag[]`-style (`flag[]=a`);
   * both normalize to one array before the schema sees it, the same
   * liberal-reading `employeeListQuerySchema` gives `role`.
   */
  function queueQueryOf(request: FastifyRequest): unknown {
    const raw = { ...((request.query as Record<string, unknown> | undefined) ?? {}) };
    const bracketed = raw['flag[]'];
    if (bracketed !== undefined) {
      const asArray = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
      raw.flag = [...asArray(raw.flag), ...asArray(bracketed)];
      delete raw['flag[]'];
    }
    return raw;
  }

  app.get(
    '/v1/cash/queue',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.confirm', 'read'), ownerCashEnabled],
      config: { responseSchema: asResponseSchema(cashQueueResponseSchema) },
    },
    async (request) => {
      const filters = cashQueueQuerySchema.parse(queueQueryOf(request));
      return service.queue(filters);
    },
  );

  // "View the day" (§O2, T4.9) — the completions and payments behind one
  // row's expected figure. Same gate as the queue read (a read, not an
  // action), and module-local schemas: the shape serves the one screen.
  app.get(
    '/v1/cash/queue/day',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.confirm', 'read'), ownerCashEnabled],
      config: { responseSchema: asResponseSchema(cashQueueDayResponseSchema) },
    },
    async (request) => {
      const query = cashQueueDayQuerySchema.parse(request.query ?? {});
      return service.day(query.employeeId, query.businessDate);
    },
  );

  app.post(
    '/v1/cash/handovers/:id/confirm',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.confirm', 'update'), ownerCashEnabled],
      config: { responseSchema: asResponseSchema(cashQueueRowSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = cashConfirmRequestSchema.parse(request.body);
      return service.confirm({ id: auth.sub }, handoverIdParam(request), body);
    },
  );

  app.post(
    '/v1/cash/handovers/:id/dispute',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.confirm', 'update'), ownerCashEnabled],
      config: { responseSchema: asResponseSchema(cashQueueRowSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = cashDisputeRequestSchema.parse(request.body);
      return service.dispute({ id: auth.sub }, handoverIdParam(request), body);
    },
  );

  app.post(
    '/v1/cash/handovers/:id/reopen',
    {
      preHandler: [app.requireAuth, app.requirePermission('cash.confirm', 'update'), ownerCashEnabled],
      config: { responseSchema: asResponseSchema(cashQueueRowSchema) },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = cashReopenRequestSchema.parse(request.body);
      return service.reopen({ id: auth.sub }, handoverIdParam(request), body);
    },
  );
};
