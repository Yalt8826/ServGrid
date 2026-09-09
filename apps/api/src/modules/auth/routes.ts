import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeAny } from 'zod';
import {
  authMeResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  passwordChangeRequestSchema,
  passwordChangeResponseSchema,
  refreshRequestSchema,
  refreshResponseSchema,
} from '@servgrid/shared';
import { createSlidingWindowLimiter } from '../../lib/rate-limit.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createAuthService, type RequestContextInfo } from './service.js';

/**
 * Auth routes (PLAN-BACKEND.md §4 endpoint table). Bodies and responses
 * are validated with the shared zod schemas; a failed body parse bubbles
 * the ZodError to the error envelope as 422 (§3.4).
 */

export interface AuthRoutesOptions {
  jwtSecret: string;
}

/** 5/min per username + IP (§4) — counted per attempt, before any hashing. */
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 60_000;

function userAgentOf(headers: Record<string, unknown>): string | null {
  const raw = headers['user-agent'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Strict zod objects do not fit Fastify's config intersection without
 * the same `as ZodTypeAny` the health route uses — the check itself
 * still runs at runtime (§3.4). */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const service = createAuthService({ jwtSecret: opts.jwtSecret });
  const loginLimiter = createSlidingWindowLimiter({ limit: LOGIN_RATE_LIMIT, windowMs: LOGIN_RATE_WINDOW_MS });

  app.post('/v1/auth/login', { config: { responseSchema: asResponseSchema(loginResponseSchema) } }, async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    if (!loginLimiter.take(`${body.username.toLowerCase()}|${request.ip}`)) {
      reply.header('retry-after', String(Math.ceil(LOGIN_RATE_WINDOW_MS / 1000)));
      throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Wait a minute and try again.');
    }
    const ctx: RequestContextInfo = { ip: request.ip, userAgent: userAgentOf(request.headers) };
    return service.login(body, ctx);
  });

  app.post('/v1/auth/refresh', { config: { responseSchema: asResponseSchema(refreshResponseSchema) } }, async (request) => {
    const body = refreshRequestSchema.parse(request.body);
    return service.refresh(body.refreshToken, {
      ip: request.ip,
      userAgent: userAgentOf(request.headers),
    });
  });

  app.post('/v1/auth/logout', { config: { responseSchema: asResponseSchema(logoutResponseSchema) } }, async (request) => {
    const body = refreshRequestSchema.parse(request.body);
    return service.logout(body.refreshToken);
  });

  app.post(
    '/v1/auth/password',
    { preHandler: app.requireAuth, config: { responseSchema: asResponseSchema(passwordChangeResponseSchema) } },
    async (request) => {
      // Unreachable in practice — requireAuth has set `auth` by now —
      // but the narrowing keeps the type honest and the wording keeps
      // every 401 recoverable-sounding.
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      const body = passwordChangeRequestSchema.parse(request.body);
      await service.changePassword(auth.sub, body);
      return { ok: true };
    },
  );

  app.get('/v1/auth/me', { preHandler: app.requireAuth, config: { responseSchema: asResponseSchema(authMeResponseSchema) } }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    return service.me(auth.sub);
  });
};
