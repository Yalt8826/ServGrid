import fp from 'fastify-plugin';
import { monotonicFactory } from 'ulid';
import type { Role } from '@servgrid/shared';

/**
 * Request context (PLAN-BACKEND.md §3.3): every request carries
 * `requestId` (ULID), `actor`, `source` and `deviceId`. They ride the
 * structured logs now and `job_events.source` once the jobs module lands.
 *
 * The ULID is also Fastify's `request.id` (see `genRequestId` wired in
 * server.ts) so pino stamps it on every line without a second field, and
 * it is echoed as `x-request-id` so a technician's screenshot can be
 * matched to a log line.
 */

export const REQUEST_SOURCES = ['mobile', 'web', 'system'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];

/** Header names are the contract with the app; `apps/mobile` sends both. */
export const SOURCE_HEADER = 'x-client-source';
export const DEVICE_HEADER = 'x-device-id';

export interface Actor {
  id: string;
  role: Role;
}

export interface RequestContext {
  requestId: string;
  /** Set by the auth plugin (T0.7); null until then and for anonymous routes. */
  actor: Actor | null;
  source: RequestSource;
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}

const ulid = monotonicFactory();

/** Fastify `genReqId` — a fresh monotonic ULID per request. */
export function genRequestId(): string {
  return ulid();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A missing or unknown header is `system`, not a guess at `mobile` or
 * `web`: the app builds always send it, so the callers that do not are
 * curl, the uptime checker and scripts — and mislabelling those as a
 * handset would corrupt the audit trail silently.
 */
export function parseSource(value: string | string[] | undefined): RequestSource {
  const raw = firstHeader(value)?.trim().toLowerCase();
  return (REQUEST_SOURCES as readonly string[]).includes(raw ?? '')
    ? (raw as RequestSource)
    : 'system';
}

export function parseDeviceId(value: string | string[] | undefined): string | null {
  const raw = firstHeader(value)?.trim();
  return raw && UUID.test(raw) ? raw.toLowerCase() : null;
}

export const requestContextPlugin = fp(
  async (app) => {
    app.decorateRequest('context', null as unknown as RequestContext);

    app.addHook('onRequest', async (request, reply) => {
      request.context = {
        requestId: request.id,
        actor: null,
        source: parseSource(request.headers[SOURCE_HEADER]),
        deviceId: parseDeviceId(request.headers[DEVICE_HEADER]),
      };
      reply.header('x-request-id', request.id);
    });
  },
  { name: 'request-context', fastify: '5.x' },
);
