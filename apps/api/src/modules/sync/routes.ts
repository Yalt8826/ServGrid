import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDateTime, syncBatchSchema, syncBootstrapResponseSchema, syncDeltaResponseSchema, syncBatchResponseSchema } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { isFlagOn } from '../flags/service.js';
import { createSyncService } from './service.js';

/**
 * Sync routes (PLAN-BACKEND.md §7): `GET /v1/sync/bootstrap`,
 * `GET /v1/sync/delta?cursor=`, `POST /v1/sync/batch` — the offline
 * mirror's three doors, the server half of the handset outbox
 * (`tech.offline` gates the client surface; these endpoints are its API).
 *
 * §7: "Technician and sales rep only; dispatcher and owner use the normal
 * REST surface online." Phase 1 builds the technician's working set; the
 * rep's (companies + house accounts with balances) arrives with the sales
 * module in Phase 2 and is refused until then — so the gate is the
 * technician role itself, not a matrix cell: a whole-table sync answer for
 * an `all`-scoped role would be the whole database, and §7 bounds the
 * response by design to one actor's tens of rows.
 *
 * The batch is a mutation like any other, so the idempotency plugin
 * (§3.2) wraps it: a batch sent with its own `Idempotency-Key` replays its
 * stored response verbatim on reconnect — on top of the per-operation
 * keys, which is what makes a partially-applied drain re-dransable.
 * A batch key equal to one of its operations' keys is refused 422: the
 * inner claim would block on the outer's uncommitted claim row.
 */

/** §7 actors, Phase 1 shape. */
const SYNC_ACTORS_MESSAGE =
  'Offline sync belongs to the technician handset — use the online API instead.';

const syncDeltaQuerySchema = z.object({ cursor: isoDateTime }).strict();

function claimsOf(request: FastifyRequest): { sub: string; role: string } {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

async function technicianOnly(request: FastifyRequest): Promise<void> {
  if (claimsOf(request).role !== 'technician') {
    throw new AppError('FORBIDDEN', SYNC_ACTORS_MESSAGE);
  }
}

/**
 * The T0 rollback for the offline tier (PLAN-EXECUTION.md §3, Phase 1
 * rollback table): `tech.offline` off means the mirror's three doors
 * close server-side — online-only from the server's side, queued items
 * preserved on the handset and drained on re-enable. Defaulted off, so a
 * technician the owner has not enabled sync for is refused here rather
 * than silently mirrored.
 */
const SYNC_DISABLED_MESSAGE =
  'Offline sync is switched off for your account. The app runs online-only; queued work is kept.';

async function offlineEnabled(request: FastifyRequest): Promise<void> {
  if (!(await isFlagOn(claimsOf(request).sub, 'tech.offline'))) {
    throw new AppError('FLAG_DISABLED', SYNC_DISABLED_MESSAGE);
  }
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  const service = createSyncService(app);

  app.get(
    '/v1/sync/bootstrap',
    {
      preHandler: [app.requireAuth, technicianOnly, offlineEnabled],
      config: { responseSchema: syncBootstrapResponseSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.bootstrap(auth.sub);
    },
  );

  app.get(
    '/v1/sync/delta',
    {
      preHandler: [app.requireAuth, technicianOnly, offlineEnabled],
      config: { responseSchema: syncDeltaResponseSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      const query = syncDeltaQuerySchema.parse(request.query ?? {});
      return service.delta(auth.sub, query.cursor);
    },
  );

  app.post(
    '/v1/sync/batch',
    {
      preHandler: [app.requireAuth, technicianOnly, offlineEnabled],
      config: { responseSchema: syncBatchResponseSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = syncBatchSchema.parse(request.body);

      const batchKey = request.headers['idempotency-key'];
      if (typeof batchKey === 'string' && body.operations.some((op) => op.idempotencyKey === batchKey)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A queued operation reuses the batch’s own retry reference — the two must differ.',
        );
      }

      // The operations are the actor's own queued requests, re-executed as
      // him; the raw credentials ride through to the injected calls.
      const rawAuthorization = request.headers.authorization;
      const rawSource = request.headers['x-client-source'];
      return service.drain(
        { id: auth.sub },
        body,
        {
          authorization: typeof rawAuthorization === 'string' ? rawAuthorization : undefined,
          clientSource: typeof rawSource === 'string' ? rawSource : undefined,
        },
      );
    },
  );
};
