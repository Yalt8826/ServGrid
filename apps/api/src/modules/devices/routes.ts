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
 *
 * `GET /v1/devices/me` reads the session's own device row back — the one the
 * access token was issued for at login (its `deviceId` claim), which the
 * ladder's `POST /v1/devices` updates in place. The permission
 * ladder remembers the two steps Android cannot report — battery exemption
 * and OEM autostart — here, on the server, because nothing is stored on
 * the phone (online-only, decision 2026-09-15).
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

  app.get(
    '/v1/devices/me',
    {
      preHandler: app.requireAuth,
      config: { responseSchema: deviceDiagnosticSchema },
    },
    async (request) => {
      const auth = claimsOf(request);
      // The token's device, set on the request context by the auth plugin.
      const deviceId = request.context.deviceId;
      const device = deviceId === null || deviceId === '' ? null : await service.myDevice(auth.sub, deviceId);
      if (device === null) {
        throw new AppError('NOT_FOUND', 'This phone has not registered yet.');
      }
      return device;
    },
  );
};
