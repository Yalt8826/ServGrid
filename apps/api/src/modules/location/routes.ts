import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { locationPingBatchSchema, pingBatchResultSchema } from '@servgrid/shared';
import { createSlidingWindowLimiter } from '../../lib/rate-limit.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createLocationService } from './service.js';

/**
 * Location routes (PLAN-BACKEND.md §8): `POST /v1/location/pings`, the
 * buffered batch the technician's and rep's handsets drain to. The
 * response is per-ping and HTTP 200 even when every ping is rejected —
 * a rejected ping is a normal outcome, not a client error, and the
 * client must clear its buffer on any of these rather than retry forever.
 *
 * On-demand requests and the health reads are later tasks on the same
 * module (§8: /requests is Phase 4's console; /health/me is T1.x's chip).
 */

/** §13 rate limits: ping ingest 60/min per device. Keyed on the signed
 * deviceId claim, not the header — the token is the device's identity. */
const PING_RATE_LIMIT = 60;
const PING_RATE_WINDOW_MS = 60_000;

/** The matrix gives `location.send` to the tracked roles; a dispatcher's
 * cell is `none` (§5 — he may know a device went quiet, never where). */
const PING_FORBIDDEN_MESSAGE = 'Location tracking runs on field handsets, not this role.';

const RATE_LIMITED_MESSAGE =
  'Too many location updates arrived from this device. Wait a minute — the buffer will drain.';

function claimsOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

export const locationRoutes: FastifyPluginAsync<{ workWindow: { start: string; end: string } }> = async (
  app,
  opts,
) => {
  const service = createLocationService({ workWindow: opts.workWindow });
  const limiter = createSlidingWindowLimiter({ limit: PING_RATE_LIMIT, windowMs: PING_RATE_WINDOW_MS });

  app.post(
    '/v1/location/pings',
    {
      preHandler: [app.requireAuth, app.requirePermission('location.send', 'create', PING_FORBIDDEN_MESSAGE)],
      config: { responseSchema: pingBatchResultSchema },
    },
    async (request, reply) => {
      const auth = claimsOf(request);
      const body = locationPingBatchSchema.parse(request.body);
      if (!limiter.take(`pings:${auth.deviceId}`)) {
        // Structured on purpose (§13): ping acceptance rate per device is
        // one of the metrics this deployment actually looks at.
        request.log.warn({ deviceId: auth.deviceId }, 'ping ingest rate limited');
        reply.header('retry-after', String(Math.ceil(PING_RATE_WINDOW_MS / 1000)));
        throw new AppError('RATE_LIMITED', RATE_LIMITED_MESSAGE);
      }
      // The actor and the device come from the signed token, never the
      // body — a ping cannot be filed against a colleague.
      const result = await service.ingestPings(auth.sub, auth.deviceId, body.pings);
      if (result.flagged.length > 0) {
        // §8: fixes coarser than 2000 m are recorded but flagged — and the
        // flag is observable here as well as in the row's accuracy_m, which
        // is the OEM investigation's query surface (§13).
        request.log.info(
          { deviceId: auth.deviceId, flagged: result.flagged },
          'ping ingest: coarse fixes flagged',
        );
      }
      return result;
    },
  );
};
