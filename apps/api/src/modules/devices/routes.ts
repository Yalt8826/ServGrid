import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { deviceDiagnosticSchema, deviceUpsertSchema } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createDevicesService } from './service.js';

/**
 * Device routes (PLAN-BACKEND.md §8): `POST /v1/devices` upserts by
 * (employee_id, installId), carrying the FCM token and the four OEM
 * diagnostics. The app calls it on login, on foreground when permissions
 * change, and after each ladder step.
 */

function claimsOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  const service = createDevicesService();

  app.post(
    '/v1/devices',
    {
      preHandler: app.requireAuth,
      config: { responseSchema: deviceDiagnosticSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      const body = deviceUpsertSchema.parse(request.body);
      // employee_id comes from the token, never the body: a device row is
      // the caller's own, always.
      return service.registerDevice(auth.sub, body);
    },
  );
};
