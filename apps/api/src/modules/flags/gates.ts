import type { FastifyRequest } from 'fastify';

import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { isFlagOn } from './service.js';

/**
 * Shared preHandlers for surfaces a feature flag gates (PLAN-EXECUTION.md
 * §3, PHASE-2-DISPATCHER.md T2.3). A flag-gated surface is gated HERE and
 * not only in the app: a stale or tampered client must not find the
 * endpoint lit. Each flag names exactly one surface, so a gate names the
 * flag's rollback tier, not a role list — which roles pass is the flag
 * evaluation's decision alone.
 */

/** `dispatch.console` — the dispatcher's working half: the dashboard
 * figures, the picker's load list, the roster health warning, and (from
 * T2.3) assignment. The T0 rollback tier for the whole console. */
export const CONSOLE_DISABLED_MESSAGE = 'The dispatch console is switched off for your account.';

export async function dispatchConsoleEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'dispatch.console'))) {
    throw new AppError('FLAG_DISABLED', CONSOLE_DISABLED_MESSAGE);
  }
}

/** `dispatch.bulk` — deliberately a second flag: the risky half must
 * switch off without taking the working half down (T2.3). */
export const BULK_DISABLED_MESSAGE =
  'Bulk reassign is switched off for your account — assign the jobs one at a time.';

export async function dispatchBulkEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'dispatch.bulk'))) {
    throw new AppError('FLAG_DISABLED', BULK_DISABLED_MESSAGE);
  }
}

/**
 * `sales.cash` — the sales rep's cash handover (PHASE-3-SALES-REP.md
 * T3.6). The declaration endpoints are shared with the technician, whose
 * handover has been lit since T1.11 on the technician phase's surface —
 * so the gate reads the token's role and asks the flag only of a
 * sales_rep: flipping it off darkens the rep's half (the T0 rollback of
 * T3.6) without touching the technician's declaration. The sync door
 * carries the same two concerns as two handlers (`technicianOnly`, then
 * `offlineEnabled`); here one handler holds both because the surface is
 * one and the refusal is the same 409 whichever condition fails.
 */
export const REP_CASH_DISABLED_MESSAGE =
  'The cash handover is switched off for your account.';

export async function salesRepCashEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (auth.role !== 'sales_rep') return;
  if (!(await isFlagOn(auth.sub, 'sales.cash'))) {
    throw new AppError('FLAG_DISABLED', REP_CASH_DISABLED_MESSAGE);
  }
}
