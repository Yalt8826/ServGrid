import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { ownerAttentionResponseSchema, ownerDashboardResponseSchema, ownerPerformanceResponseSchema, performanceQuerySchema } from './schemas.js';
import { createDashboardService } from './service.js';

/**
 * Owner dashboard routes (PLAN.md §8, UI/plan-2/07-OWNER.md §O1;
 * PHASE-4-OWNER.md T4.6): `GET /v1/dashboard/owner` — the four figures and
 * two charts, pinned by the plan so Phase 4 could not open with a design
 * conversation — and `GET /v1/dashboard/owner/attention`, the feed ordered
 * by consequence, not recency.
 *
 * The door is `cash.confirm` × `read` at scope `all`: the one matrix cell
 * that is `all` for the owner and `none` for every other role, which is
 * the whole point — the dashboard counts cash the owner alone may confirm,
 * and a field role has no owner screen to point at (PLAN.md §5: "owner is
 * `all` on every resource"; the reverse direction — a cell only the owner
 * holds at `all` — is what makes this a one-role door without a bespoke
 * resource). `requireAll` rather than `requirePermission` mirrors the
 * dispatcher summary: the figures are an all-rows read.
 *
 * Responses carry the owner's own figures, so there is one shape and no
 * per-role narrowing — the same `responseSchema` form the other
 * owner-only surfaces (employees, companies) use.
 */

/** Strict zod objects do not fit Fastify's config intersection without
 * the same `as ZodTypeAny` the other routes use — the check itself
 * still runs at runtime (§3.4). */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

const OWNER_DASHBOARD_MESSAGE = 'The owner dashboard is the owner’s screen.';

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = createDashboardService();

  app.get(
    '/v1/dashboard/owner',
    {
      preHandler: [app.requireAuth, app.requireAll('cash.confirm', 'read', OWNER_DASHBOARD_MESSAGE)],
      config: { responseSchema: asResponseSchema(ownerDashboardResponseSchema) },
    },
    async () => service.ownerDashboard(),
  );

  // OW.3: the four performance charts, one read, one range. Same owner
  // door as the rest of the dashboard — every series is money or the work
  // behind it, and `cash.confirm` is the cell only the owner holds.
  app.get(
    '/v1/dashboard/owner/performance',
    {
      preHandler: [app.requireAuth, app.requireAll('cash.confirm', 'read', OWNER_DASHBOARD_MESSAGE)],
      config: { responseSchema: asResponseSchema(ownerPerformanceResponseSchema) },
    },
    async (request) => {
      const { range } = performanceQuerySchema.parse(request.query ?? {});
      return service.ownerPerformance(range);
    },
  );

  app.get(
    '/v1/dashboard/owner/attention',
    {
      preHandler: [app.requireAuth, app.requireAll('cash.confirm', 'read', OWNER_DASHBOARD_MESSAGE)],
      config: { responseSchema: asResponseSchema(ownerAttentionResponseSchema) },
    },
    async () => service.ownerAttention(),
  );
};
