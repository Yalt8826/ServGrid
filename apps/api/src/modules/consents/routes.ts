import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeAny } from 'zod';
import {
  consentCreateRequestSchema,
  consentCreateResponseSchema,
  requiredConsentsResponseSchema,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createConsentService } from './service.js';

/**
 * Consent routes (PLAN-BACKEND.md §4). Authenticated but role-blind: the
 * consent is owed by people, not by roles, and neither endpoint blocks
 * anything else — acceptance gates the location task, not the app.
 */

/** Strict zod objects do not fit Fastify's config intersection without
 * the same `as ZodTypeAny` the other routes use — the check itself
 * still runs at runtime (§3.4). */
const asResponseSchema = (schema: ZodTypeAny): ZodTypeAny => schema;

export const consentRoutes: FastifyPluginAsync = async (app) => {
  const service = createConsentService();

  app.get(
    '/v1/consents/required',
    { preHandler: app.requireAuth, config: { responseSchema: asResponseSchema(requiredConsentsResponseSchema) } },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      return service.required(auth.sub);
    },
  );

  app.post(
    '/v1/consents',
    { preHandler: app.requireAuth, config: { responseSchema: asResponseSchema(consentCreateResponseSchema) } },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      const body = consentCreateRequestSchema.parse(request.body);
      // The request's own address is the recorded one; the body's
      // `ipAddress` parsed above and is read by nobody (§4, DPDP evidence).
      return service.record(auth.sub, auth.deviceId, body, request.ip);
    },
  );
};
