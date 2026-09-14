import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  locationPingBatchSchema,
  pingBatchResultSchema,
  trackingHealthSchema,
  type Action,
  type Resource,
} from '@servgrid/shared';
import { createSlidingWindowLimiter } from '../../lib/rate-limit.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { dispatchConsoleEnabled, ownerLocationEnabled } from '../flags/gates.js';
import { createLocationConsoleService, createLocationService } from './service.js';
import {
  locationRequestCreateSchema,
  locationRequestParamsSchema,
  locationRequestSchema,
  trailPingSchema,
  trailQuerySchema,
  trackedEmployeeLocationSchema,
} from './schemas.js';

/**
 * Location routes (PLAN-BACKEND.md §8): `POST /v1/location/pings`, the
 * buffered batch the technician's and rep's handsets drain to. The
 * response is per-ping and HTTP 200 even when every ping is rejected —
 * a rejected ping is a normal outcome, not a client error, and the
 * client must clear its buffer on any of these rather than retry forever.
 *
 * The health reads ship in phases (§8's table): `GET
 * /v1/location/health/me` (Phase 1, the chip on his own profile) and,
 * since T2.7, `GET /v1/location/health` — the roster warning on the
 * dispatcher's dashboard. Both select `v_employee_tracking_health`: a
 * health value and a last-ping age, with no coordinate column in the
 * view at all.
 *
 * The console reads (T4.4) are the Phase 4 half of §8's table — `POST
 * /v1/location/requests`, `GET /v1/location/requests/:id`,
 * `GET /v1/location/employees` and `GET
 * /v1/location/employees/:id/trail` — and they are where coordinates
 * finally cross the wire. They are `location.read` reads: the matrix
 * gives that cell to the owner alone (the dispatcher's roster warning
 * above stays a `location.health` read — he may know a device went
 * quiet, never where). Until T4.4 only the health routes existed, and a
 * path that does not exist answers the framework's generic 404 to every
 * role alike; now they exist, and `requireAll` on `location.read` is
 * the door every one of them closes behind the owner.
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

/** The refusal for a role asking the chip endpoint for something that is
 * not his own row — a dispatcher's `location.health` read is `all` (the
 * Phase 2 roster warning), and this is not that surface. */
const HEALTH_ME_FORBIDDEN_MESSAGE = 'Tracking health shows your own handset only.';

/** The roster read's refusal (T2.7): `location.health` × `read` is `all`
 * for the office roles only — a tracked role's `own` cell is served by
 * `/health/me`, never by a collection he could enumerate. */
const HEALTH_ROSTER_FORBIDDEN_MESSAGE = 'Tracking health is read by the office.';

/** The console reads' refusal (T4.4): `location.read` × `read` is `all`
 * for the owner and `none` for every other role — positions are the one
 * surface the matrix gives to a single person (§5). */
const CONSOLE_FORBIDDEN_MESSAGE = 'Positions are read by the owner console only.';

/**
 * preHandler for `/me`-shaped self-service surfaces whose matrix cell is
 * `own`: 403 unless the shared matrix gives this role exactly `own` on
 * the cell. `requirePermission` would let a scope-`all` role through,
 * and `requireAll` would refuse the roles the route exists for — the
 * self-service surface sits precisely on the `own` cell, so that is the
 * cell it asks for. Which roles pass is the matrix's decision alone
 * (technician and sales rep today, §8); no role list lives in this file.
 */
function requireOwnPermission(
  resource: Resource,
  action: Action,
  message: string,
) {
  return async function requireOwn(request: FastifyRequest) {
    if (request.scope(resource, action) !== 'own') {
      throw new AppError('FORBIDDEN', message);
    }
  };
}

export const locationRoutes: FastifyPluginAsync<{ workWindow: { start: string; end: string } }> = async (
  app,
  opts,
) => {
  const service = createLocationService({ workWindow: opts.workWindow });
  const consoleService = createLocationConsoleService(app.log);
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

  // §8: the health chip's own read — the one health endpoint that ships in
  // Phase 1, and the one that is easy to miss. The actor id comes from the
  // token, never the path, and the repo's WHERE clause carries it, so the
  // response is his row and nothing about anyone else (T1.12).
  app.get(
    '/v1/location/health/me',
    {
      preHandler: [app.requireAuth, requireOwnPermission('location.health', 'read', HEALTH_ME_FORBIDDEN_MESSAGE)],
      config: { responseSchema: trackingHealthSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      return service.myHealth(auth.sub);
    },
  );

  // §8 (T2.7): the roster read — the dispatcher's dashboard warning, and
  // how this file finally carries a second health surface. The gate is
  // `requireAll` on the matrix's `location.health` × `read` cell, not
  // requirePermission: the cell is `all` for the office roles and `own`
  // for the tracked ones, and `own` is served by `/health/me` — a
  // technician asking the roster for a collection to enumerate is
  // refused at the door (403), not handed a narrower answer. The console
  // flag rides along because the warning is part of the dispatcher's
  // console — the same T0 rollback tier as the figures and the picker —
  // and a health payload answers no one else's surface. The response is
  // attached per role so the money-leak suite's discovery walks it, and
  // its walk entry asserts the boundary the hard way: health and age,
  // never a coordinate.
  app.get(
    '/v1/location/health',
    {
      preHandler: [
        app.requireAuth,
        app.requireAll('location.health', 'read', HEALTH_ROSTER_FORBIDDEN_MESSAGE),
        dispatchConsoleEnabled,
      ],
      config: {
        responseSchemaByRole: {
          owner: z.array(trackingHealthSchema),
          dispatcher: z.array(trackingHealthSchema),
        },
      },
    },
    async () => service.rosterHealth(),
  );

  // ── the owner console (T4.4, §8's Phase 4 rows) ──────────────────────────
  //
  // Every route below carries the same two-door preHandler: `requireAll`
  // on `location.read` × `read` (the matrix's owner-only cell — a
  // dispatcher calling any of these is a 403 before any query exists),
  // then the `owner.location` flag (the console's T0 rollback tier — a
  // stale client must not find the surface lit).

  // §8: "inserts a `location_requests` row, THEN sends a data-only FCM
  // push". The persistence is what lets the console be honest — a push
  // that dies still leaves a queryable request, and the poll below can
  // say "requested 40s ago, device has not answered" instead of spinning.
  app.post(
    '/v1/location/requests',
    {
      preHandler: [
        app.requireAuth,
        app.requireAll('location.read', 'read', CONSOLE_FORBIDDEN_MESSAGE),
        ownerLocationEnabled,
      ],
      config: { responseSchema: locationRequestSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = locationRequestCreateSchema.parse(request.body);
      const created = await consoleService.createRequest(auth.sub, body);
      request.log.info(
        { requestId: created.id, status: created.status, mode: created.mode },
        'locate-now: request created',
      );
      return created;
    },
  );

  // §8: "polled by the console". The status is derived from the row per
  // read, so `expired` is reported the instant the window closes.
  app.get(
    '/v1/location/requests/:id',
    {
      preHandler: [
        app.requireAuth,
        app.requireAll('location.read', 'read', CONSOLE_FORBIDDEN_MESSAGE),
        ownerLocationEnabled,
      ],
      config: { responseSchema: locationRequestSchema },
    },
    async (request) => {
      claimsOf(request);
      const params = locationRequestParamsSchema.parse(request.params);
      return consoleService.getRequest(params.id);
    },
  );

  // §8's table, Phase 4 row: latest position + health per tracked
  // employee. The one endpoint where coordinates ride the wire — which
  // is exactly why it is a `location.read` read and not the dispatcher's
  // `location.health` roster above.
  app.get(
    '/v1/location/employees',
    {
      preHandler: [
        app.requireAuth,
        app.requireAll('location.read', 'read', CONSOLE_FORBIDDEN_MESSAGE),
        ownerLocationEnabled,
      ],
      config: { responseSchema: z.array(trackedEmployeeLocationSchema) },
    },
    async () => consoleService.trackedEmployees(),
  );

  // A day's ordered pings — the trail line under the roster's selected
  // employee. Ordered by `recorded_at` in the query; scoped to the
  // requested IST business date by the generated column.
  app.get(
    '/v1/location/employees/:id/trail',
    {
      preHandler: [
        app.requireAuth,
        app.requireAll('location.read', 'read', CONSOLE_FORBIDDEN_MESSAGE),
        ownerLocationEnabled,
      ],
      config: { responseSchema: z.array(trailPingSchema) },
    },
    async (request) => {
      claimsOf(request);
      const params = locationRequestParamsSchema.parse(request.params);
      const query = trailQuerySchema.parse(request.query);
      return consoleService.trail(params.id, query.date);
    },
  );
};
