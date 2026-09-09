import {
  CONSENT_KINDS,
  type ConsentCreateRequest,
  type ConsentCreateResponse,
  type ConsentObligation,
  type RequiredConsentsResponse,
} from '@servgrid/shared';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../plugins/errors.js';
import { CURRENT_CONSENT_VERSION } from '../auth/service.js';
import * as repo from './repo.js';

/**
 * Consent endpoints (PLAN-BACKEND.md §4). The consents row is DPDP Act
 * evidence, and two rules keep it honest:
 *
 * **The server writes the IP.** `ipAddress` in the body parses and is read
 * by nobody — the recorded value is the request's own address. Evidence a
 * client can author is not evidence.
 *
 * **Only the current copy can be accepted.** A stale client labelling its
 * acceptance with an old version would write evidence of an acceptance that
 * never happened, so the version must be the one this build presents; the
 * client recovers by re-fetching /required.
 *
 * Consent gates the location task, not the app: nothing here blocks login
 * or any other endpoint. A technician who has not accepted still sees his
 * jobs; the client simply does not start tracking and the health chip reads
 * `permission_missing` (PLAN.md §7) — visible degradation rather than an
 * ultimatum or a silent one.
 */

export interface ConsentServiceDeps {
  /** The date-string version of the consent copy this build ships (§4). */
  currentVersion: string;
}

export function createConsentService(
  deps: ConsentServiceDeps = { currentVersion: CURRENT_CONSENT_VERSION },
) {
  /**
   * The copy currently presented, per kind. One screen today, so one
   * version for every kind; a second kind with its own copy becomes a
   * per-kind map and nothing else.
   */
  const currentObligations: ConsentObligation[] = CONSENT_KINDS.map((kind) => ({
    kind,
    version: deps.currentVersion,
  }));

  /** GET /v1/consents/required — the kinds and versions this actor still owes. */
  async function required(employeeId: string): Promise<RequiredConsentsResponse> {
    const owed = await repo.findRequiredConsents(getPool(), employeeId, currentObligations);
    return { required: owed };
  }

  /**
   * POST /v1/consents. The UNIQUE (employee_id, kind, version) makes the
   * double-tap free: a losing insert selects the row the first tap wrote,
   * so both requests return the same acceptance — which is why this
   * endpoint takes no idempotency key (§4).
   */
  async function record(
    employeeId: string,
    tokenDeviceId: string | null,
    input: ConsentCreateRequest,
    requestIp: string,
  ): Promise<ConsentCreateResponse> {
    if (input.version !== deps.currentVersion) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That consent version is out of date — reload the consent screen and try again.',
      );
    }

    // A device named as the witness must be the acceptor's: an acceptance
    // bound to somebody else's handset corrupts the trail. The token's
    // device claim fills in when the body omits one (the app always has it;
    // the refresh path can mint a token with an empty claim, hence the '').
    const deviceId = input.deviceId ?? (tokenDeviceId && tokenDeviceId !== '' ? tokenDeviceId : null);
    if (deviceId !== null && !(await repo.deviceBelongsTo(getPool(), deviceId, employeeId))) {
      throw new AppError('VALIDATION_FAILED', 'That device is not registered to you.');
    }

    const row =
      (await repo.insertConsent(getPool(), {
        employeeId,
        kind: input.kind,
        version: input.version,
        deviceId,
        ipAddress: requestIp,
      })) ?? (await repo.findConsent(getPool(), employeeId, input.kind, input.version));

    if (!row) {
      // Unreachable: a DO NOTHING insert means the constraint's row exists,
      // and READ COMMITTED has the winner committed before the loser's
      // conflict resolves. Never say "probably fine" about evidence — say so.
      throw new AppError('INTERNAL', 'The acceptance could not be recorded. Nothing was lost — try again.');
    }

    return {
      kind: row.kind,
      version: row.version,
      acceptedAt: row.accepted_at.toISOString(),
      deviceId: row.device_id,
      ipAddress: row.ip_address,
    };
  }

  return { required, record };
}

export type ConsentService = ReturnType<typeof createConsentService>;
