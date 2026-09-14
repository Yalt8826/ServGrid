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

/**
 * `sales.cards` — the sales cards surface (PHASE-3-SALES-REP.md T3.3): the
 * rep's sale documents, confirm (the move that changes a company's
 * balance) and the owner's void. Unlike `sales.cash` this surface is
 * sales-only — the rep and the owner, no shared technician half — so the
 * gate asks the flag of EVERY caller: flipping it off darkens the whole
 * surface for everyone on it, which is the T0 rollback of T3.3.
 */
export const SALES_CARDS_DISABLED_MESSAGE =
  'Sales cards are switched off for your account.';

export async function salesCardsEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'sales.cards'))) {
    throw new AppError('FLAG_DISABLED', SALES_CARDS_DISABLED_MESSAGE);
  }
}

/**
 * `sales.payments` — payment capture and the pending/collected tabs
 * (PHASE-3-SALES-REP.md T3.4). The same shape as `sales.cards`: a
 * sales-only surface — the rep captures, the owner reviews and voids, and
 * nobody else holds a cell on payment — so the gate asks the flag of EVERY
 * caller and flipping it off darkens the whole surface for everyone on it,
 * which is the T0 rollback of T3.4.
 */
export const SALES_PAYMENTS_DISABLED_MESSAGE =
  'Payments are switched off for your account.';

export async function salesPaymentsEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'sales.payments'))) {
    throw new AppError('FLAG_DISABLED', SALES_PAYMENTS_DISABLED_MESSAGE);
  }
}

/**
 * `owner.cash` — the reconciliation queue and its three actions (PHASE-4-OWNER.md
 * T4.2): the owner's read of `v_cash_reconciliation_queue`, confirm, dispute,
 * reopen. The same shape as `sales.cards`: an owner-only surface — nobody else
 * holds a `cash.confirm` cell — so the gate asks the flag of EVERY caller and
 * flipping it off darkens the whole surface for everyone on it, which is the
 * T0 rollback of T4.2. The role door itself stays the matrix gate that runs
 * BEFORE this one (matrix-first, the `/v1/sales/:id/void` order): the matrix
 * says who may ever reconcile, the flag says whether the surface is lit at all.
 */
export const OWNER_CASH_DISABLED_MESSAGE =
  'The cash reconciliation queue is switched off for your account.';

export async function ownerCashEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'owner.cash'))) {
    throw new AppError('FLAG_DISABLED', OWNER_CASH_DISABLED_MESSAGE);
  }
}

/**
 * `owner.location` — the location console and its map (PHASE-4-OWNER.md
 * T4.4/T4.10). The console's four reads (`POST`+`GET /v1/location/
 * requests`, `/v1/location/employees`, `.../trail`) are a sales-only
 * surface in the T3 sense: the matrix gives `location.read` to the owner
 * alone, so the gate asks the flag of EVERY caller — flipping it off
 * darkens the whole console for the one person on it, which is the T0
 * rollback of T4.4.
 */
export const OWNER_LOCATION_DISABLED_MESSAGE =
  'The location console is switched off for your account.';

export async function ownerLocationEnabled(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (!(await isFlagOn(auth.sub, 'owner.location'))) {
    throw new AppError('FLAG_DISABLED', OWNER_LOCATION_DISABLED_MESSAGE);
  }
}
