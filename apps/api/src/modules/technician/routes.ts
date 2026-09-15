import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { technicianWorkResponseSchema } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { isFlagOn } from '../flags/service.js';
import { technicianWork } from './service.js';

/**
 * `GET /v1/technician/work` (PLAN-BACKEND.md §7) — the technician's jobs,
 * their sites, the units there and the catalogue, in one online read. It
 * replaces the offline mirror's `/v1/sync/bootstrap`; `/delta` and `/batch`
 * went with the mirror (decision 2026-09-15). Writes are the ordinary job
 * routes, called directly.
 */

const TECHNICIAN_ONLY_MESSAGE = 'This is a technician’s own work list — the office reads jobs from the job list.';

/** The T0 rollback for the technician's job screens (PLAN-EXECUTION.md §3). */
const TECH_JOBS_DISABLED_MESSAGE = 'Your job screens are switched off for this account. Ask the office to turn them on.';

function claimsOf(request: FastifyRequest): { sub: string; role: string } {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

async function technicianOnly(request: FastifyRequest): Promise<void> {
  if (claimsOf(request).role !== 'technician') {
    throw new AppError('FORBIDDEN', TECHNICIAN_ONLY_MESSAGE);
  }
}

async function techJobsEnabled(request: FastifyRequest): Promise<void> {
  if (!(await isFlagOn(claimsOf(request).sub, 'tech.jobs'))) {
    throw new AppError('FLAG_DISABLED', TECH_JOBS_DISABLED_MESSAGE);
  }
}

export const technicianRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/technician/work',
    {
      preHandler: [app.requireAuth, technicianOnly, techJobsEnabled],
      config: { responseSchema: technicianWorkResponseSchema },
    },
    async (request) => technicianWork(claimsOf(request).sub),
  );
};
